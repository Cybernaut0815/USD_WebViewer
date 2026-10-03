// Asset resolver for the browser. Plain paths behave as in ArDefaultResolver
// (embedded resources, dropped files mounted under /drop). URLs are read over
// HTTP with a synchronous fetch, which is allowed because the core runs in a
// worker. Schemes other than http(s) are routed through a registered gateway:
// that table is where a Nucleus gateway plugs in.
#pragma once

#include "pxr/usd/ar/defaultResolver.h"

#include <string>

PXR_NAMESPACE_USING_DIRECTIVE

class WebResolver final : public ArDefaultResolver {
public:
    /// Reads `<scheme>://...` assets as GET `<httpBase>/read?url=<encoded asset url>`,
    /// sending `authHeader` as the Authorization header when it is not empty.
    static void RegisterScheme(const std::string& scheme, const std::string& httpBase, const std::string& authHeader);
    /// Drops cached bytes of a URL so the next open fetches it again (used before a reload).
    static void Forget(const std::string& url);

protected:
    std::string _CreateIdentifier(const std::string& assetPath, const ArResolvedPath& anchorAssetPath) const override;
    std::string _CreateIdentifierForNewAsset(const std::string& assetPath, const ArResolvedPath& anchorAssetPath) const override;
    ArResolvedPath _Resolve(const std::string& assetPath) const override;
    std::shared_ptr<ArAsset> _OpenAsset(const ArResolvedPath& resolvedPath) const override;
};
