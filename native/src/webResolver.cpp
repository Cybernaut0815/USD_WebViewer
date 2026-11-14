#include "webResolver.h"

#include "pxr/base/tf/diagnostic.h"
#include "pxr/base/tf/stringUtils.h"
#include "pxr/usd/ar/defineResolver.h"
#include "pxr/usd/ar/inMemoryAsset.h"

#include <emscripten/fetch.h>

#include <sys/stat.h>

#include <algorithm>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <mutex>
#include <vector>

AR_DEFINE_RESOLVER(WebResolver, ArDefaultResolver);

namespace {

struct Gateway {
    std::string httpBase, authHeader;
};
std::mutex gMutex;
std::map<std::string, Gateway> gGateways;
/// Bytes of URLs and dropped files still in use, so a file open twice (the edit snapshot reopens the stage's
/// layers) is read once and held once.
std::map<std::string, std::pair<std::weak_ptr<const char>, size_t>> gCache;

/// The bytes of a path still in use, or null.
std::shared_ptr<ArAsset> Cached(const std::string& path)
{
    const std::lock_guard<std::mutex> lock(gMutex);
    const auto cached = gCache.find(path);
    if (cached == gCache.end()) return nullptr;
    if (const std::shared_ptr<const char> bytes = cached->second.first.lock()) return ArInMemoryAsset::FromBuffer(bytes, cached->second.second);
    gCache.erase(cached);
    return nullptr;
}

void Cache(const std::string& path, const std::shared_ptr<const char>& bytes, size_t size)
{
    const std::lock_guard<std::mutex> lock(gMutex);
    gCache[path] = { bytes, size };
}
/// Dropped files read ahead by the worker (Provide), each taken by its first open.
std::map<std::string, std::pair<std::shared_ptr<const char>, size_t>> gProvided;

/// The bytes provided for a path, taken out of the map, or null.
std::shared_ptr<ArAsset> TakeProvided(const std::string& path, std::shared_ptr<const char>* bytes, size_t* size)
{
    const std::lock_guard<std::mutex> lock(gMutex);
    const auto found = gProvided.find(path);
    if (found == gProvided.end()) return nullptr;
    *bytes = found->second.first;
    *size = found->second.second;
    gProvided.erase(found);
    return ArInMemoryAsset::FromBuffer(*bytes, *size);
}
/// Packages (URLs and dropped files), held until ReleasePackages: a usdz is reopened for every file read from it,
/// textures included, long after the stage let go of it, and would be downloaded or read whole each time.
std::map<std::string, std::pair<std::shared_ptr<const char>, size_t>> gPackages;

bool IsPackage(const std::string& path) { return TfStringEndsWith(TfStringToLower(path), ".usdz"); }

/// A held package's bytes, or null.
std::shared_ptr<ArAsset> HeldPackage(const std::string& path)
{
    const std::lock_guard<std::mutex> lock(gMutex);
    const auto held = gPackages.find(path);
    return held == gPackages.end() ? nullptr : ArInMemoryAsset::FromBuffer(held->second.first, held->second.second);
}

void Hold(const std::string& path, const std::shared_ptr<const char>& bytes, size_t size)
{
    if (!IsPackage(path)) return;
    const std::lock_guard<std::mutex> lock(gMutex);
    gPackages[path] = { bytes, size };
}

/// Length of the "scheme://" prefix, or 0 when `path` is not a URL.
size_t SchemeLength(const std::string& path)
{
    const size_t colon = path.find("://");
    if (colon == std::string::npos || colon == 0) return 0;
    for (size_t i = 0; i < colon; i++) {
        if (!std::isalnum(static_cast<unsigned char>(path[i])) && path[i] != '+' && path[i] != '-' && path[i] != '.') return 0;
    }
    return colon + 3;
}

/// RFC 3986 style: `relative` against the directory of `base`, with . and .. removed.
std::string AnchorUrl(const std::string& base, const std::string& relative)
{
    const size_t scheme = SchemeLength(base);
    const size_t pathStart = std::min(base.find('/', scheme), base.size()); // after the authority
    const std::string origin = base.substr(0, pathStart);
    std::string path = relative;
    if (relative.empty() || relative[0] != '/') {
        const std::string basePath = base.substr(pathStart, base.find_first_of("?#", pathStart) - pathStart);
        path = basePath.substr(0, basePath.rfind('/') + 1) + relative;
    }
    std::vector<std::string> segments;
    for (const std::string& segment : TfStringSplit(path, "/")) {
        if (segment == "..") {
            if (!segments.empty()) segments.pop_back();
        } else if (segment != "." && !segment.empty()) segments.push_back(segment);
    }
    return origin + "/" + TfStringJoin(segments, "/");
}

std::string UrlEncode(const std::string& text)
{
    static const char hex[] = "0123456789ABCDEF";
    std::string out;
    for (const unsigned char c : text) {
        if (std::isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') out += char(c);
        else {
            out += '%';
            out += hex[c >> 4];
            out += hex[c & 15];
        }
    }
    return out;
}

} // namespace

void WebResolver::RegisterScheme(const std::string& scheme, const std::string& httpBase, const std::string& authHeader)
{
    const std::lock_guard<std::mutex> lock(gMutex);
    gGateways[scheme] = { httpBase, authHeader };
}

void WebResolver::Forget(const std::string& url)
{
    const std::lock_guard<std::mutex> lock(gMutex);
    gCache.erase(url);
    gPackages.erase(url);
    gProvided.erase(url);
}

void WebResolver::Provide(const std::string& path, const std::shared_ptr<const char>& bytes, size_t size)
{
    const std::lock_guard<std::mutex> lock(gMutex);
    gProvided[path] = { bytes, size };
}

void WebResolver::DropProvided()
{
    const std::lock_guard<std::mutex> lock(gMutex);
    gProvided.clear();
}

void WebResolver::ReleasePackages()
{
    const std::lock_guard<std::mutex> lock(gMutex);
    gPackages.clear();
}

std::string WebResolver::_CreateIdentifier(const std::string& assetPath, const ArResolvedPath& anchorAssetPath) const
{
    if (SchemeLength(assetPath)) return assetPath;
    const std::string& anchor = anchorAssetPath.GetPathString();
    if (!assetPath.empty() && SchemeLength(anchor)) return AnchorUrl(anchor, assetPath);
    return ArDefaultResolver::_CreateIdentifier(assetPath, anchorAssetPath);
}

std::string WebResolver::_CreateIdentifierForNewAsset(const std::string& assetPath, const ArResolvedPath& anchorAssetPath) const
{
    return _CreateIdentifier(assetPath, anchorAssetPath);
}

ArResolvedPath WebResolver::_Resolve(const std::string& assetPath) const
{
    // URLs resolve to themselves: probing each one would cost a round trip, and
    // a missing file is reported when it is opened.
    if (SchemeLength(assetPath)) return ArResolvedPath(assetPath);
    return ArDefaultResolver::_Resolve(assetPath);
}

std::shared_ptr<ArAsset> WebResolver::_OpenAsset(const ArResolvedPath& resolvedPath) const
{
    const std::string& url = resolvedPath.GetPathString();
    const size_t scheme = SchemeLength(url);
    if (!scheme) {
        // Dropped files are Blobs mounted with WORKERFS, which cannot be memory
        // mapped the way ArFilesystemAsset wants; read them into memory instead.
        if (TfStringStartsWith(url, "/drop/")) {
            if (std::shared_ptr<ArAsset> held = HeldPackage(url)) return held;
            std::shared_ptr<const char> provided;
            size_t providedSize = 0;
            if (std::shared_ptr<ArAsset> asset = TakeProvided(url, &provided, &providedSize)) {
                Hold(url, provided, providedSize);
                Cache(url, provided, providedSize);
                return asset;
            }
            if (std::shared_ptr<ArAsset> cached = Cached(url)) return cached;
            std::FILE* file = std::fopen(url.c_str(), "rb");
            if (!file) return nullptr;
            // 64-bit size (ftell's long is 32-bit here); the core is wasm32, so 4 GB can never fit.
            struct stat info;
            const bool sized = fstat(fileno(file), &info) == 0;
            const uint64_t size = sized ? uint64_t(info.st_size) : 0;
            char* data = sized && size > 0 && size < (uint64_t(4) << 30) ? static_cast<char*>(std::malloc(size_t(size))) : nullptr;
            bool ok = data != nullptr;
            // In slices: each is one read of the Blob behind WORKERFS (FileReaderSync), which then stays moderate.
            for (uint64_t done = 0; ok && done < size;) {
                const size_t slice = size_t(std::min<uint64_t>(size - done, uint64_t(256) << 20));
                ok = std::fread(data + done, 1, slice, file) == slice;
                done += slice;
            }
            std::fclose(file);
            if (!ok) {
                std::free(data);
                if (sized && size > 0) TF_RUNTIME_ERROR("%s: could not read its %.2f GB into the core's memory (4 GB at most, with what is decoded from it)", url.c_str(), double(size) / 1e9);
                return nullptr;
            }
            const std::shared_ptr<const char> bytes(data, [](const char* p) { std::free(const_cast<char*>(p)); });
            Hold(url, bytes, size_t(size));
            Cache(url, bytes, size_t(size));
            return ArInMemoryAsset::FromBuffer(bytes, size_t(size));
        }
        return ArDefaultResolver::_OpenAsset(resolvedPath);
    }

    if (std::shared_ptr<ArAsset> held = HeldPackage(url)) return held;
    if (std::shared_ptr<ArAsset> cached = Cached(url)) return cached;
    std::string request = url, auth;
    {
        const std::lock_guard<std::mutex> lock(gMutex);
        const std::string name = url.substr(0, scheme - 3);
        if (name != "http" && name != "https") {
            const auto gateway = gGateways.find(name);
            if (gateway == gGateways.end()) {
                TF_WARN("No gateway registered for '%s' URLs: %s", name.c_str(), url.c_str());
                return nullptr;
            }
            request = gateway->second.httpBase + "/read?url=" + UrlEncode(url);
            auth = gateway->second.authHeader;
        }
    }

    emscripten_fetch_attr_t attributes;
    emscripten_fetch_attr_init(&attributes);
    std::strcpy(attributes.requestMethod, "GET");
    attributes.attributes = EMSCRIPTEN_FETCH_LOAD_TO_MEMORY | EMSCRIPTEN_FETCH_SYNCHRONOUS | EMSCRIPTEN_FETCH_REPLACE;
    const char* headers[] = { "Authorization", auth.c_str(), nullptr };
    if (!auth.empty()) attributes.requestHeaders = headers;
    emscripten_fetch_t* fetch = emscripten_fetch(&attributes, request.c_str());
    if (!fetch || fetch->status != 200) {
        TF_WARN("Could not read %s (HTTP %d)", url.c_str(), fetch ? int(fetch->status) : 0);
        if (fetch) emscripten_fetch_close(fetch);
        return nullptr;
    }
    // The asset shares the fetch's buffer; closing the fetch frees it.
    const size_t size = size_t(fetch->numBytes);
    const std::shared_ptr<const char> bytes(fetch->data, [fetch](const char*) { emscripten_fetch_close(fetch); });
    Cache(url, bytes, size);
    Hold(url, bytes, size);
    return ArInMemoryAsset::FromBuffer(bytes, size);
}
