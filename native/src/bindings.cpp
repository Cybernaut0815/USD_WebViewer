// The JavaScript API of the core: plain functions over one stage and one
// bridge, called by the worker glue (web/public/core/worker.js).
// Convention: every std::string returned here is JSON.
#include "sceneBridge.h"
#include "stage.h"
#include "webResolver.h"

#include "pxr/base/js/json.h"
#include "pxr/base/tf/diagnosticMgr.h"
#include "pxr/base/work/threadLimits.h"
#include "pxr/pxr.h"
#include "pxr/usd/ar/asset.h"
#include "pxr/usd/ar/resolver.h"
#include "pxr/usd/ar/resolverScopedCache.h"

#include <emscripten/bind.h>

#include <cmath>
#include <mutex>
#include <sstream>

using emscripten::val;

namespace {

Stage gStage;
SceneBridge gBridge;

/// Collects USD's warnings and errors for the page instead of printing them.
class Diagnostics final : public TfDiagnosticMgr::Delegate {
public:
    void IssueError(const TfError& error) override { Add("error", error.GetCommentary()); }
    void IssueFatalError(const TfCallContext&, const std::string& message) override { Add("error", message); }
    void IssueStatus(const TfStatus& status) override { Add("info", status.GetCommentary()); }
    void IssueWarning(const TfWarning& warning) override { Add("warn", warning.GetCommentary()); }

    std::string Take()
    {
        const std::lock_guard<std::mutex> lock(_mutex);
        std::ostringstream stream;
        JsWriter w(stream);
        w.BeginArray();
        for (const auto& [level, message] : _entries) {
            w.BeginObject();
            w.WriteKey("level");
            w.WriteValue(level);
            w.WriteKey("message");
            w.WriteValue(message);
            w.EndObject();
        }
        w.EndArray();
        _entries.clear();
        return stream.str();
    }

private:
    void Add(const char* level, const std::string& message)
    {
        const std::lock_guard<std::mutex> lock(_mutex);
        if (_entries.size() < 200) _entries.emplace_back(level, message); // a broken stage can warn per prim
    }
    std::mutex _mutex;
    std::vector<std::pair<std::string, std::string>> _entries;
};
Diagnostics gDiagnostics;

UsdTimeCode Time(double time) { return std::isnan(time) ? UsdTimeCode::Default() : UsdTimeCode(time); }

void init(int threads)
{
    WorkSetConcurrencyLimit(threads);
    ArSetPreferredResolver("WebResolver");
    TfDiagnosticMgr::GetInstance().AddDelegate(&gDiagnostics);
}

std::string usdVersion() { return TfStringPrintf("%d.%02d", PXR_MINOR_VERSION, PXR_PATCH_VERSION); }
std::string takeDiagnostics() { return gDiagnostics.Take(); }

void registerScheme(const std::string& scheme, const std::string& httpBase, const std::string& authHeader)
{
    WebResolver::RegisterScheme(scheme, httpBase, authHeader);
}

std::string openStage(const std::string& url, bool loadPayloads)
{
    const ArResolverScopedCache cache;
    gBridge.SetStage(nullptr);
    const std::string info = gStage.Open(url, loadPayloads);
    gBridge.SetStage(gStage.Get());
    return info;
}

void closeStage()
{
    gBridge.SetStage(nullptr);
    gStage.Close();
}

std::string reloadStage() { return gStage.Reload(); }
std::string primChildren(const std::string& path) { return gStage.Children(path); }
std::string primSubtree(const std::string& path, int limit) { return gStage.Subtree(path, limit); }
std::string primVisibility(const std::string& pathsJson) { return gStage.Visibility(pathsJson); }
std::string primDetails(const std::string& path, double time) { return gStage.Details(path, time); }
std::string primBounds(const std::string& path, double time) { return gStage.Bounds(path, time); }
std::string attributeValue(const std::string& path, const std::string& name, double time)
{
    return gStage.AttributeValue(path, name, time, size_t(-1));
}
/// The first 16 values of an array, for the details panel: no full array as JSON.
std::string attributeHead(const std::string& path, const std::string& name, double time)
{
    return gStage.AttributeValue(path, name, time, 16);
}
std::string findPrims(const std::string& text, const std::string& typeName, int limit)
{
    return gStage.Find(text, typeName, limit);
}
std::string exportPrim(const std::string& path, const std::string& mode) { return gStage.ExportPrim(path, mode); }

std::string setRefinement(const std::string& path, bool enabled, int level)
{
    const std::string result = gStage.SetRefinement(path, enabled, level);
    gBridge.MarkMesh(SdfPath(path));
    return result;
}
std::string clearRefinement(const std::string& path)
{
    const std::string result = gStage.ClearRefinement(path);
    gBridge.MarkMesh(SdfPath(path));
    return result;
}
std::string clearRefinementOverrides()
{
    const std::string result = gStage.ClearRefinementOverrides();
    gBridge.MarkRefinable();
    return result;
}

/// Bytes of any resolvable asset, including members of usdz packages.
val readAsset(const std::string& resolvedPath)
{
    const ArResolverScopedCache cache;
    const std::shared_ptr<ArAsset> asset = ArGetResolver().OpenAsset(ArResolvedPath(resolvedPath));
    const std::shared_ptr<const char> bytes = asset ? asset->GetBuffer() : nullptr;
    if (!bytes) return val::null();
    return val::global("Uint8Array").new_(emscripten::typed_memory_view(asset->GetSize(), reinterpret_cast<const unsigned char*>(bytes.get())));
}

void setTime(double time) { gBridge.SetTime(Time(time)); }
void setRefineLevel(int level) { gBridge.SetRefineLevel(level); }
void setRefineBudget(double triangles) { gBridge.SetRefineBudget(triangles); }

val flush(int maxItems)
{
    const ArResolverScopedCache cache;
    return gBridge.Flush(maxItems);
}

void setSelection(const val& paths)
{
    std::vector<SdfPath> list;
    for (const std::string& path : emscripten::vecFromJSArray<std::string>(paths)) {
        if (SdfPath::IsValidPathString(path)) list.emplace_back(path);
    }
    gBridge.SetSelection(list);
}

std::string resolvePick(unsigned rid, int instanceIndex) { return gBridge.ResolvePick(rid, instanceIndex); }

std::string setVariant(const std::string& path, const std::string& variantSet, const std::string& variant)
{
    return gStage.SetVariant(path, variantSet, variant);
}
std::string setVisible(const std::string& path, bool visible) { return gStage.SetVisible(path, visible); }
std::string sessionVisibility(const std::string& mode, const std::string& json) { return gStage.SessionVisibility(mode, json); }
std::string revertPrim(const std::string& path) { return gStage.RevertPrim(path); }
std::string restorePrim(int stash) { return gStage.RestorePrim(stash); }
void resetChanges() { gStage.ResetChanges(); }
std::string setLoaded(const std::string& path, bool loaded) { return gStage.SetLoaded(path, loaded); }
std::string setAttribute(const std::string& path, const std::string& name, const std::string& json, double time)
{
    const std::string result = gStage.SetAttribute(path, name, json, time);
    // Refinement attributes are not Hydra data; tell the bridge by hand.
    if (name == "refinementEnableOverride" || name == "refinementLevel") gBridge.MarkMesh(SdfPath(path));
    return result;
}
std::string clearSessionEdits() { return gStage.ClearSessionEdits(); }

std::string xformInfo(const std::string& path, double time) { return gStage.XformInfo(path, time); }
std::string xformInfos(const std::string& pathsJson, double time) { return gStage.XformInfos(pathsJson, time); }
std::string setXform(const std::string& path, const val& matrix, double time)
{
    return gStage.SetXform(path, emscripten::vecFromJSArray<double>(matrix), time);
}
std::string setXforms(const std::string& entriesJson, double time) { return gStage.SetXforms(entriesJson, time); }
std::string clearAttribute(const std::string& path, const std::string& name, double time)
{
    const std::string result = gStage.ClearAttribute(path, name, time);
    if (name == "refinementEnableOverride" || name == "refinementLevel") gBridge.MarkMesh(SdfPath(path));
    return result;
}
std::string listLayers() { return gStage.ListLayers(); }
std::string setEditTarget(const std::string& identifier) { return gStage.SetEditTarget(identifier); }
val exportLayer(const std::string& identifier, const std::string& format)
{
    std::string bytes;
    if (!gStage.ExportLayer(identifier, format, &bytes)) return val::null();
    return val::global("Uint8Array").new_(emscripten::typed_memory_view(bytes.size(), reinterpret_cast<const unsigned char*>(bytes.data())));
}
std::string reloadLayers(const val& identifiers)
{
    const ArResolverScopedCache cache;
    return gStage.ReloadLayers(emscripten::vecFromJSArray<std::string>(identifiers));
}

/// Live link: replaces a layer's content (or adds an overlay) from bytes the page fetched.
std::string importLayer(const std::string& name, const val& bytes, const std::string& format, bool create)
{
    const ArResolverScopedCache cache;
    // One typed-array copy into the heap; vecFromJSArray would cross into JS per byte.
    const std::vector<uint8_t> data = emscripten::convertJSArrayToNumberVector<uint8_t>(bytes);
    // ponytail: refinementEnableOverride / refinementLevel changed by a push are not MarkMesh'ed (not Hydra
    // data, see setAttribute); MarkRefinable per push would re-convert every mesh.
    return gStage.ImportLayer(name, std::string(data.begin(), data.end()), format, create);
}

} // namespace

EMSCRIPTEN_BINDINGS(usdcore)
{
    using emscripten::function;
    function("init", &init);
    function("usdVersion", &usdVersion);
    function("takeDiagnostics", &takeDiagnostics);
    function("registerScheme", &registerScheme);
    function("openStage", &openStage);
    function("closeStage", &closeStage);
    function("reloadStage", &reloadStage);
    function("primChildren", &primChildren);
    function("primSubtree", &primSubtree);
    function("primVisibility", &primVisibility);
    function("primDetails", &primDetails);
    function("primBounds", &primBounds);
    function("attributeValue", &attributeValue);
    function("attributeHead", &attributeHead);
    function("findPrims", &findPrims);
    function("exportPrim", &exportPrim);
    function("setRefinement", &setRefinement);
    function("clearRefinement", &clearRefinement);
    function("clearRefinementOverrides", &clearRefinementOverrides);
    function("readAsset", &readAsset);
    function("setTime", &setTime);
    function("setRefineLevel", &setRefineLevel);
    function("setRefineBudget", &setRefineBudget);
    function("flush", &flush);
    function("setSelection", &setSelection);
    function("resolvePick", &resolvePick);
    function("setVariant", &setVariant);
    function("setVisible", &setVisible);
    function("sessionVisibility", &sessionVisibility);
    function("setLoaded", &setLoaded);
    function("revertPrim", &revertPrim);
    function("restorePrim", &restorePrim);
    function("resetChanges", &resetChanges);
    function("setAttribute", &setAttribute);
    function("clearSessionEdits", &clearSessionEdits);
    function("xformInfo", &xformInfo);
    function("xformInfos", &xformInfos);
    function("setXform", &setXform);
    function("setXforms", &setXforms);
    function("clearAttribute", &clearAttribute);
    function("listLayers", &listLayers);
    function("setEditTarget", &setEditTarget);
    function("exportLayer", &exportLayer);
    function("reloadLayers", &reloadLayers);
    function("importLayer", &importLayer);
}
