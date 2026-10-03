// The open UsdStage and everything the panels ask about it: hierarchy, prim
// details, values, and session-layer edits. All results are JSON strings in
// the shapes of web/src/protocol.ts.
#pragma once

#include "pxr/base/js/json.h"
#include "pxr/base/vt/value.h"
#include "pxr/usd/usd/stage.h"

#include <string>
#include <vector>

PXR_NAMESPACE_USING_DIRECTIVE

/// Writes a USD value as JSON. Arrays longer than `maxElements` become
/// {"length": n, "head": [first elements]}; asset paths become {"asset", "resolved"}.
void WriteJsonValue(JsWriter& writer, const VtValue& value, size_t maxElements);

class Stage {
public:
    std::string Open(const std::string& url, bool loadPayloads); // StageInfo
    void Close();
    const UsdStageRefPtr& Get() const { return _stage; }

    std::string Children(const std::string& path) const;                   // PrimSummary[]
    /// Computed visibility of each path in a JSON array (true for non-imageable or missing prims).
    std::string Visibility(const std::string& pathsJson) const;          // bool[]
    std::string Details(const std::string& path, double time) const;       // PrimInfo
    /// World-space aligned bounds of an imageable prim's subtree (min xyz, max xyz), or null.
    std::string Bounds(const std::string& path, double time) const; // number[6] | null
    std::string AttributeValue(const std::string& path, const std::string& name, double time) const;
    std::string Find(const std::string& text, const std::string& typeName, int limit) const; // Path[]
    /// The prim and everything below it, in traversal order, at most `limit` paths.
    std::string Subtree(const std::string& path, int limit) const; // Path[]
    /// usda text of a prim subtree: "composed" (flattened) or "authored" (the edit layer's opinions).
    std::string ExportPrim(const std::string& path, const std::string& mode) const;

    /// Local, parent-to-world and world matrices of an xformable prim (instance proxies: their instance).
    std::string XformInfo(const std::string& path, double time) const; // XformInfo | null
    /// The same for a JSON array of paths, sharing one transform cache. // (XformInfo | null)[]
    std::string XformInfos(const std::string& pathsJson, double time) const;
    std::string ListLayers() const;                                      // LayerInfo[]
    /// Bytes of a layer as "usda" or "usdc" text/binary, or the whole stage flattened ("flat").
    bool ExportLayer(const std::string& identifier, const std::string& format, std::string* bytes) const;

    // Each returns an Edit: {ok, error?, resynced, previous?, dirty}.
    std::string Reload();
    std::string ReloadLayers(const std::vector<std::string>& identifiers);
    /// Live link: replaces a used layer's content from usda text or usdc bytes. `name`: exact identifier,
    /// else a unique "/<name>" suffix, else a live overlay's display name; '' = root layer. Unknown names
    /// become an in-memory overlay above the stage (a sublayer of the session layer) when `create` is set.
    std::string ImportLayer(const std::string& name, const std::string& bytes, const std::string& format, bool create);
    std::string SetEditTarget(const std::string& identifier);
    /// Authors a local transform: a lone matrix op, a translate/rotate/scale stack (pivot kept),
    /// or a leading xformOp:transform:edit for anything else.
    std::string SetXform(const std::string& path, const std::vector<double>& matrix, double time);
    /// Several prims in one edit: a JSON array of {path, matrix}; `previous` lists the old local matrices.
    std::string SetXforms(const std::string& entriesJson, double time);
    std::string ClearAttribute(const std::string& path, const std::string& name, double time);
    std::string SetVariant(const std::string& path, const std::string& variantSet, const std::string& variant);
    std::string SetVisible(const std::string& path, bool visible);
    /// Viewer hiding, authored as `visibility` opinions in the session layer (never saved).
    /// mode: "hide" / "isolate" (JSON array of paths), "showAll" (clears every such opinion),
    /// "set" (JSON object path -> "invisible" | null, for undo). `previous` maps each touched
    /// path to its earlier session-layer opinion, in the shape "set" takes.
    std::string SessionVisibility(const std::string& mode, const std::string& json);
    /// "Clear edits": the prim and its subtree as they were when the stage was opened (local layer
    /// stack, session layer untouched); `previous` is a stash id for RestorePrim.
    std::string RevertPrim(const std::string& path);
    std::string RestorePrim(int stash);
    /// Takes the current layers as the state change markers compare against (after a reload).
    void ResetChanges();
    std::string SetLoaded(const std::string& path, bool loaded);
    std::string SetAttribute(const std::string& path, const std::string& name, const std::string& json, double time);
    std::string ClearSessionEdits();
    // Omniverse-style per-prim refinement: refinementEnableOverride + refinementLevel attributes.
    std::string SetRefinement(const std::string& path, bool enabled, int level);
    std::string ClearRefinement(const std::string& path);
    std::string ClearRefinementOverrides();

private:
    UsdStageRefPtr _stage;
    std::string _url;
    std::vector<SdfLayerRefPtr> _overlays; // live-link layers without a file: sublayers of the session layer
};
