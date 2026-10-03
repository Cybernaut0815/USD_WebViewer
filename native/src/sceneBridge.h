// Turns a UsdStage into render deltas for the page: owns the Hydra 2 scene
// index chain, tracks which prims changed, and converts them on flush.
// Delta shape: web/src/protocol.ts (RenderDelta).
#pragma once

#include "pxr/imaging/hd/dataSourceLocator.h"
#include "pxr/imaging/hd/sceneIndex.h"
#include "pxr/imaging/hdsi/primManagingSceneIndexObserver.h"
#include "pxr/usd/sdf/path.h"
#include "pxr/usd/usd/stage.h"
#include "pxr/usd/usd/timeCode.h"
#include "pxr/usdImaging/usdImaging/sceneIndex.h"

#include <emscripten/val.h>

#include <map>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

PXR_NAMESPACE_USING_DIRECTIVE

class SceneBridge {
public:
    SceneBridge();
    ~SceneBridge();

    void SetStage(const UsdStageRefPtr& stage); // null closes
    void SetTime(UsdTimeCode time);
    /// Global refinement level; -1 picks one from a triangle budget (the default).
    void SetRefineLevel(int level);
    /// Re-converts every subdividable mesh and curve (after refinement changes).
    void MarkRefinable();
    /// Re-converts one mesh (after its refinement attributes changed).
    void MarkMesh(const SdfPath& path);
    void SetSelection(const std::vector<SdfPath>& paths);

    /// Everything dirtied since the previous flush, converting at most
    /// `maxItems` geometry prims; `more` is set when some are left.
    emscripten::val Flush(int maxItems);

    /// JSON PickResult for a render item and flattened instance index (-1: none).
    std::string ResolvePick(uint32_t rid, int instanceIndex) const;

private:
    struct Rec;
    class Factory;
    friend struct Rec;

    void Dirty(Rec* rec);
    void Removed(Rec* rec);
    Rec* Find(const SdfPath& path) const;
    uint32_t RidOf(const SdfPath& path) const;
    void MarkInstancerUsers(const SdfPath& instancer);

    void ConvertMaterial(Rec& rec, emscripten::val& delta);
    void ConvertLight(Rec& rec, emscripten::val& delta);
    void ConvertCamera(Rec& rec, emscripten::val& delta);
    void ConvertMesh(Rec& rec, bool created, emscripten::val& delta);
    void ConvertCurves(Rec& rec, bool created, emscripten::val& delta);
    void ConvertPoints(Rec& rec, bool created, emscripten::val& delta);
    bool UpdateInstancing(Rec& rec, const HdContainerDataSourceHandle& source, emscripten::val& entry);
    void UpdateSelection(Rec& rec, const HdContainerDataSourceHandle& source);

    int RefineLevel() const { return _refineLevel < 0 ? _autoLevel : _refineLevel; }
    void UpdateAutoLevel();
    int MeshRefineLevel(const SdfPath& path, const HdContainerDataSourceHandle& source) const;

    UsdStageRefPtr _stage;
    UsdImagingSceneIndexRefPtr _usd;
    HdSceneIndexBaseRefPtr _scene; // end of the filtering chain
    HdsiPrimManagingSceneIndexObserverRefPtr _observer;
    int _refineLevel = 0;  // like usdview and Omniverse; -1: automatic from a triangle budget
    int _autoLevel = 0;     // what automatic resolved to for this stage
    bool _autoDirty = true; // mesh records came or went since _autoLevel was computed
    uint32_t _nextRid = 1;

    std::unordered_map<SdfPath, Rec*, SdfPath::Hash> _recs; // owned by the observer
    std::unordered_map<uint32_t, SdfPath> _paths;           // rid -> scene index path
    std::map<SdfPath, Rec*> _dirty;                         // path order keeps parents first
    std::vector<uint32_t> _removed;
    /// Instancer path -> prims (geometry or nested instancers) it instances.
    std::unordered_map<SdfPath, std::unordered_set<SdfPath, SdfPath::Hash>, SdfPath::Hash> _instancerUsers;
    std::unordered_set<Rec*> _selected;
    bool _selectionDirty = false;

    // Packed per-flush channels.
    std::vector<uint32_t> _xformRids, _visRids;
    std::vector<double> _xforms;
    std::vector<uint8_t> _vis;
};
