#include "sceneBridge.h"

#include "geometry.h"
#include "stage.h"

#include "pxr/base/gf/matrix4d.h"
#include "pxr/base/gf/quatd.h"
#include "pxr/base/gf/quatf.h"
#include "pxr/base/gf/quath.h"
#include "pxr/base/js/json.h"
#include "pxr/imaging/hd/basisCurvesSchema.h"
#include "pxr/imaging/hd/basisCurvesTopologySchema.h"
#include "pxr/imaging/hd/cameraSchema.h"
#include "pxr/imaging/hd/dataSourceMaterialNetworkInterface.h"
#include "pxr/imaging/hd/dependencyForwardingSceneIndex.h"
#include "pxr/imaging/hd/geomSubsetSchema.h"
#include "pxr/imaging/hd/instanceIndicesSchema.h"
#include "pxr/imaging/hd/instancedBySchema.h"
#include "pxr/imaging/hd/instancerTopologySchema.h"
#include "pxr/imaging/hd/light.h"
#include "pxr/imaging/hd/lightSchema.h"
#include "pxr/imaging/hd/material.h"
#include "pxr/imaging/hd/materialBindingsSchema.h"
#include "pxr/imaging/hd/materialSchema.h"
#include "pxr/imaging/hd/meshSchema.h"
#include "pxr/imaging/hd/meshTopologySchema.h"
#include "pxr/imaging/hd/primOriginSchema.h"
#include "pxr/imaging/hd/primvarsSchema.h"
#include "pxr/imaging/hd/purposeSchema.h"
#include "pxr/imaging/hd/retainedDataSource.h"
#include "pxr/imaging/hd/selectionSchema.h"
#include "pxr/imaging/hd/selectionsSchema.h"
#include "pxr/imaging/hd/subdivisionTagsSchema.h"
#include "pxr/imaging/hd/tokens.h"
#include "pxr/imaging/hd/visibilitySchema.h"
#include "pxr/imaging/hd/xformSchema.h"
#include "pxr/imaging/hdMtlx/hdMtlx.h"
#include "pxr/imaging/hdsi/extComputationPrimvarPruningSceneIndex.h"
#include "pxr/imaging/hdsi/implicitSurfaceSceneIndex.h"
#include "pxr/imaging/hdsi/materialBindingResolvingSceneIndex.h"
#include "pxr/imaging/hdsi/materialPrimvarTransferSceneIndex.h"
#include "pxr/imaging/hdsi/nurbsApproximatingSceneIndex.h"
#include "pxr/imaging/hdsi/pinnedCurveExpandingSceneIndex.h"
#include "pxr/imaging/hdsi/tetMeshConversionSceneIndex.h"
#include "pxr/imaging/pxOsd/tokens.h"
#include "pxr/usd/sdf/assetPath.h"
#include "pxr/usd/usd/attribute.h"
#include "pxr/usd/usd/prim.h"
#include "pxr/usd/usdLux/blackbody.h"

#include "pxr/base/work/loops.h"
#include "pxr/usd/usdGeom/tokens.h"

#include <MaterialXFormat/XmlIo.h>

#include <emscripten/bind.h>

#include <algorithm>
#include <cmath>
#include <set>
#include <sstream>

using emscripten::val;

namespace {

// Omniverse's per-prim refinement attributes, authored on the Mesh prim.
const TfToken kRefineEnable("refinementEnableOverride"), kRefineLevel("refinementLevel");
// ponytail: one automatic level for all authored subdivision surfaces from an output-triangle
// budget; per-mesh levels inside the budget if one huge cage ever starves many small ones.
constexpr int kAutoMaxLevel = 2; // level 3 (64x) stays manual
constexpr int kMaxRefineLevel = 5;
// A single mesh never refines past this share of the budget (2M at the default 3M).
constexpr double kMeshCapShare = 2.0 / 3.0;

bool Refinable(const TfToken& scheme)
{
    return scheme == PxOsdOpenSubdivTokens->catmullClark || scheme == PxOsdOpenSubdivTokens->loop;
}

double CageTriangles(const VtIntArray& faceVertexCounts)
{
    double triangles = 0;
    for (int n : faceVertexCounts) triangles += std::max(n - 2, 0);
    return triangles;
}

/* ---------- JS helpers ---------- */

/// A new JS typed array holding a copy of the data (so it never aliases the wasm heap).
template <class T>
val Typed(const char* constructor, const T* data, size_t count)
{
    return val::global(constructor).new_(emscripten::typed_memory_view(count, data));
}
val Floats(const std::vector<float>& v) { return Typed("Float32Array", v.data(), v.size()); }

void Push(val& delta, const char* list, const val& entry)
{
    val array = delta[list];
    if (array.isUndefined()) {
        array = val::array();
        delta.set(list, array);
    }
    array.call<void>("push", entry);
}

val ParseJson(const std::string& text) { return val::global("JSON").call<val>("parse", text); }

/* ---------- data source helpers ---------- */

template <class Handle>
auto Value(const Handle& source, decltype(source->GetTypedValue(0.0f)) fallback = {})
{
    return source ? source->GetTypedValue(0.0f) : fallback;
}

bool IsGeometry(const TfToken& type)
{
    return type == HdPrimTypeTokens->mesh || type == HdPrimTypeTokens->basisCurves || type == HdPrimTypeTokens->points;
}

/* Flattening of primvar values into floats; `size` is the number of floats per element. */

template <class Vec>
void CopyVec(const Vec* data, size_t count, int n, std::vector<float>* out)
{
    out->resize(count * n);
    for (size_t i = 0; i < count; i++) {
        for (int k = 0; k < n; k++) (*out)[i * n + k] = float(data[i][k]);
    }
}
template <class Scalar>
void CopyScalar(const Scalar* data, size_t count, std::vector<float>* out)
{
    out->resize(count);
    for (size_t i = 0; i < count; i++) (*out)[i] = float(data[i]);
}

bool ToFloats(const VtValue& value, std::vector<float>* out, int* size)
{
#define VEC_CASE(Type, n)                                                         \
    if (value.IsHolding<VtArray<Type>>()) {                                       \
        const auto& a = value.UncheckedGet<VtArray<Type>>();                      \
        CopyVec(a.cdata(), a.size(), n, out);                                     \
        *size = n;                                                                \
        return true;                                                              \
    }                                                                             \
    if (value.IsHolding<Type>()) {                                                \
        CopyVec(&value.UncheckedGet<Type>(), 1, n, out);                          \
        *size = n;                                                                \
        return true;                                                              \
    }
#define SCALAR_CASE(Type)                                                         \
    if (value.IsHolding<VtArray<Type>>()) {                                       \
        const auto& a = value.UncheckedGet<VtArray<Type>>();                      \
        CopyScalar(a.cdata(), a.size(), out);                                     \
        *size = 1;                                                                \
        return true;                                                              \
    }                                                                             \
    if (value.IsHolding<Type>()) {                                                \
        CopyScalar(&value.UncheckedGet<Type>(), 1, out);                          \
        *size = 1;                                                                \
        return true;                                                              \
    }
    VEC_CASE(GfVec3f, 3)
    VEC_CASE(GfVec2f, 2)
    SCALAR_CASE(float)
    VEC_CASE(GfVec3d, 3)
    VEC_CASE(GfVec2d, 2)
    SCALAR_CASE(double)
    VEC_CASE(GfVec4f, 4)
#undef VEC_CASE
#undef SCALAR_CASE
    return false;
}

/// Reads one primvar. faceVarying primvars keep their authored indices when
/// they have them, so UV seams stay welded through subdivision.
bool ReadPrimvar(const HdPrimvarsSchema& primvars, const TfToken& name, PrimvarIn* out)
{
    const HdPrimvarSchema primvar = primvars.GetPrimvar(name);
    if (!primvar) return false;
    out->name = name.GetString();
    out->interpolation = Value(primvar.GetInterpolation(), HdPrimvarSchemaTokens->constant);
    VtValue value;
    const bool faceVarying = out->interpolation == HdPrimvarSchemaTokens->faceVarying;
    if (faceVarying && primvar.IsIndexed()) {
        if (const HdSampledDataSourceHandle source = primvar.GetIndexedPrimvarValue()) value = source->GetValue(0.0f);
        out->indices = Value(primvar.GetIndices());
    } else if (const HdSampledDataSourceHandle source = primvar.GetPrimvarValue()) {
        value = source->GetValue(0.0f);
    }
    if (!ToFloats(value, &out->values, &out->size) || out->values.empty()) return false;
    if (faceVarying && out->indices.empty()) {
        const size_t count = out->values.size() / out->size;
        out->indices.resize(count);
        for (size_t i = 0; i < count; i++) out->indices[i] = int(i);
    }
    return true;
}

VtVec3fArray ReadPoints(const HdPrimvarsSchema& primvars)
{
    const HdPrimvarSchema primvar = primvars.GetPrimvar(HdPrimvarsSchemaTokens->points);
    if (!primvar) return {};
    const HdSampledDataSourceHandle source = primvar.GetPrimvarValue();
    if (!source) return {};
    const VtValue value = source->GetValue(0.0f);
    if (value.IsHolding<VtVec3fArray>()) return value.UncheckedGet<VtVec3fArray>();
    if (value.IsHolding<VtVec3dArray>()) {
        const VtVec3dArray& doubles = value.UncheckedGet<VtVec3dArray>();
        VtVec3fArray floats(doubles.size());
        for (size_t i = 0; i < doubles.size(); i++) floats[i] = GfVec3f(doubles[i]);
        return floats;
    }
    return {};
}

/// True when only point positions (and normals) changed: the per-frame case of animation.
bool OnlyPointsDirty(const HdDataSourceLocatorSet& dirty)
{
    static const HdDataSourceLocator primvars = HdPrimvarsSchema::GetDefaultLocator();
    for (const HdDataSourceLocator& locator : dirty) {
        if (locator.IsEmpty() || !locator.HasPrefix(primvars)) continue;
        if (locator.GetElementCount() < 2) return false;
        const TfToken& name = locator.GetElement(1);
        if (name != HdPrimvarsSchemaTokens->points && name != HdPrimvarsSchemaTokens->normals) return false;
    }
    return true;
}

SdfPath BoundMaterial(const HdContainerDataSourceHandle& source)
{
    const HdMaterialBindingsSchema bindings = HdMaterialBindingsSchema::GetFromParent(source);
    if (!bindings) return {};
    const HdMaterialBindingSchema binding = bindings.GetMaterialBinding(HdMaterialBindingsSchemaTokens->allPurpose);
    return binding ? Value(binding.GetPath()) : SdfPath();
}

SdfPath InstancedBy(const HdContainerDataSourceHandle& source)
{
    const HdInstancedBySchema schema = HdInstancedBySchema::GetFromParent(source);
    const VtArray<SdfPath> paths = schema ? Value(schema.GetPaths()) : VtArray<SdfPath>();
    return paths.empty() ? SdfPath() : paths[0];
}

GfMatrix4d Xform(const HdContainerDataSourceHandle& source)
{
    const HdXformSchema schema = HdXformSchema::GetFromParent(source);
    return schema ? Value(schema.GetMatrix(), GfMatrix4d(1.0)) : GfMatrix4d(1.0);
}

bool Visible(const HdContainerDataSourceHandle& source)
{
    const HdVisibilitySchema schema = HdVisibilitySchema::GetFromParent(source);
    return schema ? Value(schema.GetVisibility(), true) : true;
}

/// Instance matrices of `prototype` under `instancer`, nested instancers
/// flattened outermost-first. Port of HdEmbreeInstancer::ComputeInstanceTransforms.
VtMatrix4dArray InstanceTransforms(const HdSceneIndexBaseRefPtr& scene, const SdfPath& instancer, const SdfPath& prototype)
{
    const HdContainerDataSourceHandle source = scene->GetPrim(instancer).dataSource;
    const HdInstancerTopologySchema topology = HdInstancerTopologySchema::GetFromParent(source);
    if (!source || !topology || !Visible(source)) return {};
    const VtIntArray indices = topology.ComputeInstanceIndicesForProto(prototype);
    VtMatrix4dArray transforms(indices.size(), Xform(source));

    const HdPrimvarsSchema primvars = HdPrimvarsSchema::GetFromParent(source);
    const auto primvar = [&](const TfToken& name) {
        const HdPrimvarSchema schema = primvars ? primvars.GetPrimvar(name) : HdPrimvarSchema(nullptr);
        const HdSampledDataSourceHandle value = schema ? schema.GetPrimvarValue() : nullptr;
        return value ? value->GetValue(0.0f) : VtValue();
    };
    const auto apply = [&](const auto& array, const auto& toMatrix) {
        for (size_t i = 0; i < indices.size(); i++) {
            const int index = indices[i];
            if (index >= 0 && size_t(index) < array.size()) transforms[i] = toMatrix(array[index]) * transforms[i];
        }
    };
    const auto translation = [](const auto& t) { return GfMatrix4d(1.0).SetTranslate(GfVec3d(t)); };
    const auto scaling = [](const auto& s) { return GfMatrix4d(1.0).SetScale(GfVec3d(s)); };

    VtValue value = primvar(HdInstancerTokens->instanceTranslations);
    if (value.IsHolding<VtVec3fArray>()) apply(value.UncheckedGet<VtVec3fArray>(), translation);
    else if (value.IsHolding<VtVec3dArray>()) apply(value.UncheckedGet<VtVec3dArray>(), translation);

    value = primvar(HdInstancerTokens->instanceRotations);
    if (value.IsHolding<VtQuathArray>()) {
        apply(value.UncheckedGet<VtQuathArray>(), [](const GfQuath& q) { return GfMatrix4d(1.0).SetRotate(GfQuatd(q)); });
    } else if (value.IsHolding<VtQuatfArray>()) {
        apply(value.UncheckedGet<VtQuatfArray>(), [](const GfQuatf& q) { return GfMatrix4d(1.0).SetRotate(GfQuatd(q)); });
    } else if (value.IsHolding<VtVec4fArray>()) { // <real, i, j, k>
        apply(value.UncheckedGet<VtVec4fArray>(), [](const GfVec4f& q) { return GfMatrix4d(1.0).SetRotate(GfQuatd(q[0], q[1], q[2], q[3])); });
    }

    value = primvar(HdInstancerTokens->instanceScales);
    if (value.IsHolding<VtVec3fArray>()) apply(value.UncheckedGet<VtVec3fArray>(), scaling);
    else if (value.IsHolding<VtVec3dArray>()) apply(value.UncheckedGet<VtVec3dArray>(), scaling);

    value = primvar(HdInstancerTokens->instanceTransforms);
    if (value.IsHolding<VtMatrix4dArray>()) apply(value.UncheckedGet<VtMatrix4dArray>(), [](const GfMatrix4d& m) { return m; });

    const SdfPath parent = InstancedBy(source);
    if (parent.IsEmpty()) return transforms;
    const VtMatrix4dArray outer = InstanceTransforms(scene, parent, instancer);
    VtMatrix4dArray all(outer.size() * transforms.size());
    for (size_t i = 0; i < outer.size(); i++) {
        for (size_t j = 0; j < transforms.size(); j++) all[i * transforms.size() + j] = transforms[j] * outer[i];
    }
    return all;
}

/// Flattened ids of the instances a selection entry picks out. Port of
/// _GetSelectedNestedInstanceIds in hdx/selectionSceneIndexObserver.cpp.
std::vector<uint32_t> SelectedInstanceIds(const HdSceneIndexBaseRefPtr& scene, const HdInstanceIndicesVectorSchema& nested)
{
    std::vector<uint32_t> ids { 0 };
    for (size_t depth = 0; depth < nested.GetNumElements(); depth++) { // outermost first
        const HdInstanceIndicesSchema level = nested.GetElement(depth);
        const SdfPath instancer = Value(level.GetInstancer());
        const int prototypeIndex = Value(level.GetPrototypeIndex(), -1);
        VtIntArray selected = Value(level.GetInstanceIndices());
        std::sort(selected.begin(), selected.end());
        const HdInstancerTopologySchema topology =
            HdInstancerTopologySchema::GetFromParent(scene->GetPrim(instancer).dataSource);
        const VtArray<SdfPath> prototypes = topology ? Value(topology.GetPrototypes()) : VtArray<SdfPath>();
        if (prototypeIndex < 0 || size_t(prototypeIndex) >= prototypes.size()) return {};
        const VtIntArray forPrototype = topology.ComputeInstanceIndicesForProto(prototypes[prototypeIndex]);
        std::vector<uint32_t> next;
        for (uint32_t id : ids) {
            for (size_t i = 0; i < forPrototype.size(); i++) {
                if (std::binary_search(selected.cbegin(), selected.cend(), forPrototype[i])) {
                    next.push_back(id * uint32_t(forPrototype.size()) + uint32_t(i));
                }
            }
        }
        ids.swap(next);
    }
    return ids;
}

/// The material network reachable from the surface terminal, as JSON
/// (MaterialNetwork in protocol.ts). Empty when there is no surface.
std::string NetworkJson(HdMaterialNetworkInterface& network)
{
    const auto terminal = network.GetTerminalConnection(HdMaterialTerminalTokens->surface);
    if (!terminal.first) return {};
    std::ostringstream stream;
    JsWriter writer(stream);
    writer.BeginObject();
    writer.WriteKey("surface");
    writer.WriteValue(terminal.second.upstreamNodeName.GetString());
    writer.WriteKey("nodes");
    writer.BeginObject();
    std::vector<TfToken> pending { terminal.second.upstreamNodeName };
    std::unordered_set<TfToken, TfToken::HashFunctor> seen { pending.front() };
    while (!pending.empty()) {
        const TfToken node = pending.back();
        pending.pop_back();
        writer.WriteKey(node.GetString());
        writer.BeginObject();
        writer.WriteKey("type");
        writer.WriteValue(network.GetNodeType(node).GetString());
        writer.WriteKey("params");
        writer.BeginObject();
        for (const TfToken& name : network.GetAuthoredNodeParameterNames(node)) {
            writer.WriteKey(name.GetString());
            WriteJsonValue(writer, network.GetNodeParameterValue(node, name), 64);
        }
        writer.EndObject();
        writer.WriteKey("inputs");
        writer.BeginObject();
        for (const TfToken& name : network.GetNodeInputConnectionNames(node)) {
            const auto connections = network.GetNodeInputConnection(node, name);
            if (connections.empty()) continue;
            writer.WriteKey(name.GetString());
            writer.BeginObject();
            writer.WriteKey("node");
            writer.WriteValue(connections[0].upstreamNodeName.GetString());
            writer.WriteKey("output");
            writer.WriteValue(connections[0].upstreamOutputName.GetString());
            writer.EndObject();
            if (seen.insert(connections[0].upstreamNodeName).second) pending.push_back(connections[0].upstreamNodeName);
        }
        writer.EndObject();
        writer.EndObject();
    }
    writer.EndObject();
    writer.EndObject();
    return stream.str();
}

/// Resolved paths of the asset parameters in a material network (its textures).
void CollectTextures(HdMaterialNetworkInterface& network, std::set<std::string>* textures)
{
    for (const TfToken& name : network.GetNodeNames()) {
        for (const TfToken& parameter : network.GetAuthoredNodeParameterNames(name)) {
            const VtValue value = network.GetNodeParameterValue(name, parameter);
            if (!value.IsHolding<SdfAssetPath>()) continue;
            const SdfAssetPath& asset = value.UncheckedGet<SdfAssetPath>();
            const std::string& path = asset.GetResolvedPath().empty() ? asset.GetAssetPath() : asset.GetResolvedPath();
            if (!path.empty()) textures->insert(path);
        }
    }
}

/// MaterialX document for a network whose surface terminal is a MaterialX node, else empty.
std::string MaterialXDocument(HdMaterialNetworkInterface& network)
{
    const auto terminal = network.GetTerminalConnection(HdMaterialTerminalTokens->surface);
    if (!terminal.first) return {};
    const TfToken node = terminal.second.upstreamNodeName;
    if (!TfStringStartsWith(network.GetNodeType(node).GetString(), "ND_")) return {};
    const MaterialX::DocumentPtr document = HdMtlxCreateMtlxDocumentFromHdMaterialNetworkInterface(
        &network, node, network.GetNodeInputConnectionNames(node), HdMtlxStdLibraries());
    if (!document) return {};
    // hdMtlx writes asset paths as authored; the page needs the resolved ones.
    std::unordered_map<std::string, std::string> resolved;
    for (const TfToken& name : network.GetNodeNames()) {
        for (const TfToken& parameter : network.GetAuthoredNodeParameterNames(name)) {
            const VtValue value = network.GetNodeParameterValue(name, parameter);
            if (!value.IsHolding<SdfAssetPath>()) continue;
            const SdfAssetPath& asset = value.UncheckedGet<SdfAssetPath>();
            if (!asset.GetResolvedPath().empty()) resolved[asset.GetAssetPath()] = asset.GetResolvedPath();
        }
    }
    for (MaterialX::ElementPtr element : document->traverseTree()) {
        const MaterialX::ValueElementPtr input = element->asA<MaterialX::ValueElement>();
        if (!input || input->getType() != MaterialX::FILENAME_TYPE_STRING) continue;
        const auto found = resolved.find(input->getValueString());
        if (found != resolved.end()) input->setValueString(found->second);
    }
    MaterialX::XmlWriteOptions options;
    // The standard library definitions are known to the page's loader already.
    options.elementPredicate = [](MaterialX::ConstElementPtr element) { return !element->hasSourceUri(); };
    return MaterialX::writeToXmlString(document, &options);
}

} // namespace

/* ---------- records ---------- */

/// One observed scene index prim. Created and destroyed by the observer.
struct SceneBridge::Rec final : HdsiPrimManagingSceneIndexObserver::PrimBase {
    SceneBridge* bridge = nullptr;
    SdfPath path;
    TfToken type;
    uint32_t rid = 0; // 0: tracked for dependencies only (instancers, geom subsets)
    HdDataSourceLocatorSet dirty;
    bool created = false;        // the page knows this item
    bool instancesDirty = false; // an instancer above changed
    SdfPath instancer;           // direct instancer, empty if not instanced
    size_t vertexCount = 0, indexCount = 0;
    bool expanded = false; // mesh layout of the last full build
    int level = -1;        // refinement level of the last conversion (-1: not converted yet)
    bool selected = false, selectedAll = false;
    std::vector<uint32_t> selectedInstances;

    ~Rec() override { bridge->Removed(this); }

    void _Dirty(const HdSceneIndexObserver::DirtiedPrimEntry& entry, const HdsiPrimManagingSceneIndexObserver*) override
    {
        dirty.insert(entry.dirtyLocators);
        bridge->Dirty(this);
    }
};

class SceneBridge::Factory final : public HdsiPrimManagingSceneIndexObserver::PrimFactoryBase {
public:
    explicit Factory(SceneBridge* bridge) : _bridge(bridge) {}

    HdsiPrimManagingSceneIndexObserver::PrimBaseHandle CreatePrim(
        const HdSceneIndexObserver::AddedPrimEntry& entry, const HdsiPrimManagingSceneIndexObserver*) override
    {
        const TfToken& type = entry.primType;
        const bool rendered = IsGeometry(type) || type == HdPrimTypeTokens->material || type == HdPrimTypeTokens->camera || HdPrimTypeIsLight(type);
        if (!rendered && type != HdPrimTypeTokens->instancer && type != HdPrimTypeTokens->geomSubset) return nullptr;
        const auto rec = std::make_shared<Rec>();
        rec->bridge = _bridge;
        rec->path = entry.primPath;
        rec->type = type;
        rec->dirty = HdDataSourceLocatorSet::UniversalSet();
        if (rendered) {
            rec->rid = _bridge->_nextRid++;
            _bridge->_paths[rec->rid] = rec->path;
        }
        if (type == HdPrimTypeTokens->mesh) _bridge->_autoDirty = true;
        _bridge->_recs[rec->path] = rec.get();
        _bridge->Dirty(rec.get());
        return rec;
    }

private:
    SceneBridge* const _bridge;
};

SceneBridge::SceneBridge() = default;
SceneBridge::~SceneBridge() { SetStage(nullptr); }

void SceneBridge::SetStage(const UsdStageRefPtr& stage)
{
    // Dropping the observer destroys every record, which reports back through Removed().
    _observer.Reset();
    _scene.Reset();
    _usd.Reset();
    _recs.clear();
    _paths.clear();
    _dirty.clear();
    _removed.clear();
    _instancerUsers.clear();
    _selected.clear();
    _selectionDirty = false;
    _nextRid = 1;
    _autoLevel = 0;
    _autoDirty = true;
    _stage = stage;
    if (!stage) return;

    _usd = UsdImagingSceneIndex::New(HdRetainedContainerDataSource::New(), nullptr);
    HdSceneIndexBaseRefPtr scene = _usd;

    // Hydra hands implicit shapes, NURBS and tet meshes to renderers as-is; turn them into meshes and curves.
    const HdDataSourceBaseHandle toMesh = HdRetainedTypedSampledDataSource<TfToken>::New(HdsiImplicitSurfaceSceneIndexTokens->toMesh);
    const TfToken shapes[] = { HdPrimTypeTokens->cube, HdPrimTypeTokens->cone, HdPrimTypeTokens->cylinder,
        HdPrimTypeTokens->capsule, HdPrimTypeTokens->plane, HdPrimTypeTokens->sphere };
    const HdDataSourceBaseHandle values[] = { toMesh, toMesh, toMesh, toMesh, toMesh, toMesh };
    scene = HdsiImplicitSurfaceSceneIndex::New(scene, HdRetainedContainerDataSource::New(std::size(shapes), shapes, values));
    scene = HdsiNurbsApproximatingSceneIndex::New(scene);
    scene = HdsiTetMeshConversionSceneIndex::New(scene);
    // Skinning and other computed primvars are evaluated on the CPU and show up as ordinary primvars.
    scene = HdSiExtComputationPrimvarPruningSceneIndex::New(scene);
    scene = HdsiPinnedCurveExpandingSceneIndex::New(scene);
    scene = HdsiMaterialBindingResolvingSceneIndex::New(
        scene, { HdTokens->preview, HdMaterialBindingsSchemaTokens->allPurpose }, HdMaterialBindingsSchemaTokens->allPurpose);
    scene = HdsiMaterialPrimvarTransferSceneIndex::New(scene);
    // Several of the filters above only declare dependencies; this one turns them into dirty notices.
    scene = HdDependencyForwardingSceneIndex::New(scene);
    _scene = scene;

    using FactoryHandle = HdsiPrimManagingSceneIndexObserver::PrimFactoryBaseHandle;
    _observer = HdsiPrimManagingSceneIndexObserver::New(
        scene,
        HdRetainedContainerDataSource::New(
            HdsiPrimManagingSceneIndexObserverTokens->primFactory,
            HdRetainedTypedSampledDataSource<FactoryHandle>::New(std::make_shared<Factory>(this))));
    _usd->SetStage(stage);
}

void SceneBridge::SetTime(UsdTimeCode time)
{
    if (_usd) _usd->SetTime(time);
}

void SceneBridge::SetRefineLevel(int level)
{
    _refineLevel = std::clamp(level, -1, kMaxRefineLevel);
    _autoDirty = true;
    UpdateAutoLevel();
    MarkRefinable();
}

void SceneBridge::SetRefineBudget(double triangles)
{
    // Above ~8M output triangles a large stage risks the 4 GB wasm32 heap.
    _autoBudget = std::clamp(triangles, 5e5, 8e6);
    _autoDirty = true;
    UpdateAutoLevel();
    MarkRefinable(); // the per-mesh cap moved too
}

void SceneBridge::MarkRefinable()
{
    if (!_scene) return;
    for (const auto& [path, rec] : _recs) {
        if (rec->level < 0) continue; // not converted yet: it picks its level when it is
        const HdContainerDataSourceHandle source = _scene->GetPrim(path).dataSource;
        if (rec->type == HdPrimTypeTokens->mesh) {
            if (EffectiveMeshLevel(path, source) == rec->level) continue;
            rec->dirty.insert(HdMeshSchema::GetDefaultLocator());
        } else if (rec->type == HdPrimTypeTokens->basisCurves) {
            const HdBasisCurvesTopologySchema topology = HdBasisCurvesSchema::GetFromParent(source).GetTopology();
            if (!topology || Value(topology.GetType(), HdTokens->linear) != HdTokens->cubic || std::min(RefineLevel(), 3) == rec->level) continue;
            rec->dirty.insert(HdBasisCurvesSchema::GetDefaultLocator());
        } else continue;
        _dirty[path] = rec;
    }
}

UsdPrim SceneBridge::UsdPrimOf(const SdfPath& path, const HdContainerDataSourceHandle& source) const
{
    if (!_stage) return UsdPrim();
    if (const UsdPrim prim = _stage->GetPrimAtPath(path)) return prim;
    const HdPrimOriginSchema origin = HdPrimOriginSchema::GetFromParent(source);
    const SdfPath scenePath = origin ? origin.GetOriginPath(HdPrimOriginSchemaTokens->scenePath) : SdfPath();
    return scenePath.IsAbsolutePath() ? _stage->GetPrimAtPath(scenePath) : UsdPrim();
}

int SceneBridge::EffectiveMeshLevel(const SdfPath& path, const HdContainerDataSourceHandle& source) const
{
    const HdMeshSchema mesh = HdMeshSchema::GetFromParent(source);
    if (!mesh || !Refinable(Value(mesh.GetSubdivisionScheme(), PxOsdOpenSubdivTokens->none))) return 0;
    return MeshRefineLevel(path, source);
}

void SceneBridge::MarkMesh(const SdfPath& path)
{
    Rec* rec = Find(path);
    if (!rec || rec->type != HdPrimTypeTokens->mesh) return;
    rec->dirty.insert(HdMeshSchema::GetDefaultLocator());
    _dirty[path] = rec;
    _autoDirty = true;
}

namespace {

bool OverrideEnabled(const UsdPrim& prim)
{
    bool enabled = false;
    return prim && prim.GetAttribute(kRefineEnable).Get(&enabled) && enabled;
}

/// The file states the mesh is a subdivision surface (USD's fallback scheme, catmullClark, is
/// how polygon cages that never say anything look too).
bool AuthoredSubdivision(const UsdPrim& prim)
{
    const UsdAttribute scheme = prim ? prim.GetAttribute(UsdGeomTokens->subdivisionScheme) : UsdAttribute();
    TfToken value;
    return scheme && scheme.HasAuthoredValue() && scheme.Get(&value) && Refinable(value);
}

} // namespace

/// The level a mesh is refined at: its own override when enabled; else the global level, or in
/// automatic mode the automatic level for authored subdivision surfaces and 0 for the rest;
/// lowered until the output stays under the per-mesh cap.
int SceneBridge::MeshRefineLevel(const SdfPath& path, const HdContainerDataSourceHandle& source) const
{
    int level = RefineLevel();
    const UsdPrim prim = UsdPrimOf(path, source);
    if (OverrideEnabled(prim)) {
        int own = 0;
        prim.GetAttribute(kRefineLevel).Get(&own);
        level = std::clamp(own, 0, kMaxRefineLevel);
    } else if (_refineLevel < 0 && !AuthoredSubdivision(prim)) {
        level = 0;
    }
    const HdMeshTopologySchema topology = HdMeshSchema::GetFromParent(source).GetTopology();
    const double cage = topology ? CageTriangles(Value(topology.GetFaceVertexCounts())) : 0;
    while (level > 0 && cage * std::pow(4.0, level) > _autoBudget * kMeshCapShare) level--;
    return level;
}

bool SceneBridge::UpdateAutoLevel()
{
    if (!_autoDirty || !_scene) return false;
    _autoDirty = false;
    if (_refineLevel >= 0) return false;
    double cage = 0; // triangles of the authored subdivision cages that follow the automatic level
    for (const auto& [path, rec] : _recs) {
        if (rec->type != HdPrimTypeTokens->mesh) continue;
        const HdContainerDataSourceHandle source = _scene->GetPrim(path).dataSource;
        const HdMeshSchema mesh = HdMeshSchema::GetFromParent(source);
        const HdMeshTopologySchema topology = mesh ? mesh.GetTopology() : HdMeshTopologySchema(nullptr);
        if (!topology || !Refinable(Value(mesh.GetSubdivisionScheme(), PxOsdOpenSubdivTokens->none))) continue;
        const UsdPrim prim = UsdPrimOf(path, source);
        if (!OverrideEnabled(prim) && AuthoredSubdivision(prim)) cage += CageTriangles(Value(topology.GetFaceVertexCounts()));
    }
    int level = 0;
    while (cage > 0 && level < kAutoMaxLevel && cage * std::pow(4.0, level + 1) <= _autoBudget) level++;
    if (level == _autoLevel) return false;
    _autoLevel = level;
    return true;
}

void SceneBridge::SetSelection(const std::vector<SdfPath>& paths)
{
    if (!_usd) return;
    _usd->ClearSelection();
    for (const SdfPath& path : paths) _usd->AddSelection(path);
}

SceneBridge::Rec* SceneBridge::Find(const SdfPath& path) const
{
    const auto it = _recs.find(path);
    return it == _recs.end() ? nullptr : it->second;
}

uint32_t SceneBridge::RidOf(const SdfPath& path) const
{
    const Rec* rec = path.IsEmpty() ? nullptr : Find(path);
    return rec ? rec->rid : 0;
}

void SceneBridge::MarkInstancerUsers(const SdfPath& instancer)
{
    const auto users = _instancerUsers.find(instancer);
    if (users == _instancerUsers.end()) return;
    for (const SdfPath& user : users->second) {
        Rec* rec = Find(user);
        if (!rec || rec->instancesDirty) continue;
        rec->instancesDirty = true;
        _dirty[user] = rec;
        if (rec->type == HdPrimTypeTokens->instancer) MarkInstancerUsers(user);
    }
}

void SceneBridge::Dirty(Rec* rec)
{
    _dirty[rec->path] = rec;
    if (rec->type == HdPrimTypeTokens->geomSubset) {
        // Subsets are part of their mesh's topology.
        if (Rec* mesh = Find(rec->path.GetParentPath())) {
            mesh->dirty.insert(HdMeshSchema::GetDefaultLocator());
            _dirty[mesh->path] = mesh;
        }
    } else if (rec->type == HdPrimTypeTokens->instancer) {
        MarkInstancerUsers(rec->path);
    }
}

void SceneBridge::Removed(Rec* rec)
{
    if (rec->rid) {
        _removed.push_back(rec->rid);
        _paths.erase(rec->rid);
    }
    if (rec->type == HdPrimTypeTokens->mesh) _autoDirty = true;
    if (_selected.erase(rec)) _selectionDirty = true;
    if (!rec->instancer.IsEmpty()) {
        const auto users = _instancerUsers.find(rec->instancer);
        if (users != _instancerUsers.end()) users->second.erase(rec->path);
    }
    // On a resync the replacement record is registered before this one dies.
    const auto it = _recs.find(rec->path);
    if (it == _recs.end() || it->second != rec) return;
    _recs.erase(it);
    _dirty.erase(rec->path);
    if (rec->type == HdPrimTypeTokens->geomSubset) {
        if (Rec* mesh = Find(rec->path.GetParentPath())) {
            mesh->dirty.insert(HdMeshSchema::GetDefaultLocator());
            _dirty[mesh->path] = mesh;
        }
    } else if (rec->type == HdPrimTypeTokens->instancer) {
        MarkInstancerUsers(rec->path);
    }
}

/// One mesh conversion: what GatherMesh read, and what BuildMeshJob made of it.
struct SceneBridge::MeshJob {
    Rec* rec = nullptr;
    bool created = false;
    bool ok = false; // GatherMesh found something to convert
    MeshIn in;
    bool topologyDirty = false, pointsOnly = false, doubleSided = false;
    std::vector<float> constantColor;
    float constantOpacity = -1;
    MeshOut out;
    MeshCounts counts;
};

/* ---------- flush ---------- */

val SceneBridge::Flush(int maxItems)
{
    val delta = val::object();
    if (!_usd) return delta;
    _usd->ApplyPendingUpdates();
    if (UpdateAutoLevel()) MarkRefinable();
    delta.set("refineLevel", RefineLevel());
    _xformRids.clear();
    _visRids.clear();
    _xforms.clear();
    _vis.clear();

    // Channels every rendered item has: transform, visibility, creation info.
    const auto common = [&](Rec& rec, const HdContainerDataSourceHandle& source, val& entry) {
        if (rec.dirty.Intersects(HdXformSchema::GetDefaultLocator())) {
            _xformRids.push_back(rec.rid);
            const GfMatrix4d matrix = Xform(source);
            _xforms.insert(_xforms.end(), matrix.data(), matrix.data() + 16);
        }
        if (rec.dirty.Intersects(HdVisibilitySchema::GetDefaultLocator())) {
            _visRids.push_back(rec.rid);
            _vis.push_back(Visible(source) ? 1 : 0);
        }
        if (!rec.created) {
            entry.set("path", rec.path.GetString());
            const HdPurposeSchema purpose = HdPurposeSchema::GetFromParent(source);
            const TfToken token = purpose ? Value(purpose.GetPurpose()) : TfToken();
            entry.set("purpose", token.IsEmpty() || token == HdRenderTagTokens->geometry ? std::string("default") : token.GetString());
        }
    };

    // Materials, lights, cameras and bookkeeping prims first: geometry refers to them.
    for (auto it = _dirty.begin(); it != _dirty.end();) {
        Rec& rec = *it->second;
        if (IsGeometry(rec.type)) {
            ++it;
            continue;
        }
        const HdContainerDataSourceHandle source = _scene->GetPrim(rec.path).dataSource;
        if (source && rec.type == HdPrimTypeTokens->instancer) {
            const SdfPath parent = InstancedBy(source);
            if (parent != rec.instancer) {
                if (!rec.instancer.IsEmpty()) _instancerUsers[rec.instancer].erase(rec.path);
                if (!parent.IsEmpty()) _instancerUsers[parent].insert(rec.path);
                rec.instancer = parent;
            }
        } else if (source && rec.rid) {
            val entry = val::object();
            entry.set("rid", rec.rid);
            if (rec.type == HdPrimTypeTokens->material) {
                if (rec.dirty.Intersects(HdMaterialSchema::GetDefaultLocator())) ConvertMaterial(rec, delta);
            } else if (rec.type == HdPrimTypeTokens->camera) {
                common(rec, source, entry);
                if (rec.dirty.Intersects(HdCameraSchema::GetDefaultLocator())) {
                    const HdCameraSchema camera = HdCameraSchema::GetFromParent(source);
                    std::ostringstream stream;
                    JsWriter writer(stream);
                    writer.BeginObject();
                    writer.WriteKey("projection");
                    writer.WriteValue(Value(camera.GetProjection(), HdCameraSchemaTokens->perspective).GetString());
                    writer.WriteKey("focalLength");
                    writer.WriteValue(double(Value(camera.GetFocalLength(), 50.0f)));
                    writer.WriteKey("horizontalAperture");
                    writer.WriteValue(double(Value(camera.GetHorizontalAperture(), 20.955f)));
                    writer.WriteKey("verticalAperture");
                    writer.WriteValue(double(Value(camera.GetVerticalAperture(), 15.2908f)));
                    const GfVec2f range = Value(camera.GetClippingRange(), GfVec2f(1, 1000000));
                    writer.WriteKey("clippingRange");
                    writer.BeginArray();
                    writer.WriteValue(double(range[0]));
                    writer.WriteValue(double(range[1]));
                    writer.EndArray();
                    writer.EndObject();
                    entry.set("params", ParseJson(stream.str()));
                    Push(delta, "cameras", entry);
                }
            } else { // light
                common(rec, source, entry);
                if (rec.dirty.Intersects(HdLightSchema::GetDefaultLocator())) {
                    const HdContainerDataSourceHandle light = HdContainerDataSource::Cast(source->Get(HdLightSchemaTokens->light));
                    const auto get = [&](const TfToken& name) {
                        const HdSampledDataSourceHandle value = light ? HdSampledDataSource::Cast(light->Get(name)) : nullptr;
                        return value ? value->GetValue(0.0f) : VtValue();
                    };
                    const auto number = [&](const TfToken& name, double fallback) {
                        const VtValue value = get(name);
                        if (value.IsHolding<float>()) return double(value.UncheckedGet<float>());
                        if (value.IsHolding<double>()) return value.UncheckedGet<double>();
                        if (value.IsHolding<bool>()) return value.UncheckedGet<bool>() ? 1.0 : 0.0;
                        return fallback;
                    };
                    GfVec3f color = get(HdLightTokens->color).GetWithDefault(GfVec3f(1));
                    if (number(HdLightTokens->enableColorTemperature, 0) != 0) {
                        color = GfCompMult(color, UsdLuxBlackbodyTemperatureAsRgb(float(number(HdLightTokens->colorTemperature, 6500))));
                    }
                    std::ostringstream stream;
                    JsWriter writer(stream);
                    writer.BeginObject();
                    writer.WriteKey("color");
                    writer.BeginArray();
                    for (int i = 0; i < 3; i++) writer.WriteValue(double(color[i]));
                    writer.EndArray();
                    const std::pair<const char*, std::pair<TfToken, double>> numbers[] = {
                        { "intensity", { HdLightTokens->intensity, 1 } },
                        { "exposure", { HdLightTokens->exposure, 0 } },
                        { "diffuse", { HdLightTokens->diffuse, 1 } },
                        { "specular", { HdLightTokens->specular, 1 } },
                        { "angle", { HdLightTokens->angle, 0.53 } },
                        { "radius", { HdLightTokens->radius, 0.5 } },
                        { "width", { HdLightTokens->width, 1 } },
                        { "height", { HdLightTokens->height, 1 } },
                        { "length", { HdLightTokens->length, 1 } },
                        { "coneAngle", { HdLightTokens->shapingConeAngle, 90 } },
                        { "coneSoftness", { HdLightTokens->shapingConeSoftness, 0 } },
                    };
                    for (const auto& [key, source] : numbers) {
                        writer.WriteKey(key);
                        writer.WriteValue(number(source.first, source.second));
                    }
                    writer.WriteKey("normalize");
                    writer.WriteValue(number(HdLightTokens->normalize, 0) != 0);
                    writer.WriteKey("shadow");
                    writer.WriteValue(number(HdLightTokens->shadowEnable, 1) != 0);
                    const VtValue texture = get(HdLightTokens->textureFile);
                    if (texture.IsHolding<SdfAssetPath>()) {
                        const SdfAssetPath& asset = texture.UncheckedGet<SdfAssetPath>();
                        const std::string& resolved = asset.GetResolvedPath().empty() ? asset.GetAssetPath() : asset.GetResolvedPath();
                        if (!resolved.empty()) {
                            writer.WriteKey("texture");
                            writer.WriteValue(resolved);
                        }
                    }
                    const VtValue format = get(HdLightTokens->textureFormat);
                    if (format.IsHolding<TfToken>()) {
                        writer.WriteKey("textureFormat");
                        writer.WriteValue(format.UncheckedGet<TfToken>().GetString());
                    }
                    writer.EndObject();
                    entry.set("type", rec.type.GetString());
                    entry.set("params", ParseJson(stream.str()));
                    Push(delta, "lights", entry);
                }
            }
            rec.created = true;
        }
        rec.dirty = HdDataSourceLocatorSet();
        rec.instancesDirty = false;
        it = _dirty.erase(it);
    }

    // Geometry in three passes: the shared channels on this thread; then every mesh read and
    // built on all threads (scene index reads, refinement, triangulation, edges, counts);
    // then the JS entries written in order on this thread (emscripten::val is single-threaded).
    struct Item {
        Rec* rec;
        HdContainerDataSourceHandle source;
        val entry;
        bool created;
        std::unique_ptr<MeshJob> job;
    };
    std::vector<Item> items;
    for (auto it = _dirty.begin(); it != _dirty.end() && int(items.size()) < maxItems; ++it) {
        Rec& rec = *it->second;
        Item item { &rec, _scene->GetPrim(rec.path).dataSource, val::undefined(), rec.created, nullptr };
        if (item.source) {
            item.entry = val::object();
            item.entry.set("rid", rec.rid);
            common(rec, item.source, item.entry);
            if (rec.type == HdPrimTypeTokens->mesh) {
                item.job = std::make_unique<MeshJob>();
                item.job->rec = &rec;
                item.job->created = item.created;
            } else if (rec.type == HdPrimTypeTokens->basisCurves) ConvertCurves(rec, item.created, item.entry);
            else ConvertPoints(rec, item.created, item.entry);
        }
        items.push_back(std::move(item));
    }
    std::vector<MeshJob*> jobs;
    for (Item& item : items) {
        if (item.job) jobs.push_back(item.job.get());
    }
    // Scene index reads are thread-safe (HdSceneIndexBase::GetPrim), and so are UsdPrim reads.
    WorkParallelForN(jobs.size(), [&](size_t begin, size_t end) {
        for (size_t i = begin; i < end; i++) {
            MeshJob& job = *jobs[i];
            job.ok = GatherMesh(*job.rec, job.created, &job);
            if (job.ok) BuildMeshJob(job);
        }
    });
    for (Item& item : items) {
        Rec& rec = *item.rec;
        if (item.source) {
            if (item.job && item.job->ok) EmitMesh(*item.job, item.entry);
            if (rec.dirty.Intersects(HdMaterialBindingsSchema::GetDefaultLocator())) item.entry.set("material", RidOf(BoundMaterial(item.source)));
            const bool instancing = UpdateInstancing(rec, item.source, item.entry);
            if (rec.dirty.Intersects(HdSelectionsSchema::GetDefaultLocator())) UpdateSelection(rec, item.source);
            // Items whose only change is a transform, visibility or selection travel in the packed channels.
            const bool content = rec.dirty.Intersects(HdPrimvarsSchema::GetDefaultLocator())
                || rec.dirty.Intersects(HdMeshSchema::GetDefaultLocator())
                || rec.dirty.Intersects(HdBasisCurvesSchema::GetDefaultLocator())
                || rec.dirty.Intersects(HdMaterialBindingsSchema::GetDefaultLocator());
            if (!item.created || content || instancing) {
                Push(delta, rec.type == HdPrimTypeTokens->mesh ? "meshes" : rec.type == HdPrimTypeTokens->basisCurves ? "curves" : "points", item.entry);
            }
            rec.created = true;
        }
        rec.dirty = HdDataSourceLocatorSet();
        rec.instancesDirty = false;
        _dirty.erase(rec.path);
    }
    if (!_dirty.empty()) delta.set("more", true);

    if (!_removed.empty()) {
        delta.set("removed", Typed("Uint32Array", _removed.data(), _removed.size()));
        _removed.clear();
    }
    if (!_xformRids.empty()) {
        val xforms = val::object();
        xforms.set("rids", Typed("Uint32Array", _xformRids.data(), _xformRids.size()));
        xforms.set("matrices", Typed("Float64Array", _xforms.data(), _xforms.size()));
        delta.set("xforms", xforms);
    }
    if (!_visRids.empty()) {
        val visibility = val::object();
        visibility.set("rids", Typed("Uint32Array", _visRids.data(), _visRids.size()));
        visibility.set("visible", Typed("Uint8Array", _vis.data(), _vis.size()));
        delta.set("visibility", visibility);
    }
    if (_selectionDirty) {
        val selected = val::array();
        for (const Rec* rec : _selected) {
            val entry = val::object();
            entry.set("rid", rec->rid);
            if (!rec->selectedAll) entry.set("instances", Typed("Uint32Array", rec->selectedInstances.data(), rec->selectedInstances.size()));
            selected.call<void>("push", entry);
        }
        delta.set("selected", selected);
        _selectionDirty = false;
    }
    return delta;
}

void SceneBridge::ConvertMaterial(Rec& rec, val& delta)
{
    const HdSceneIndexPrim prim = _scene->GetPrim(rec.path);
    const HdMaterialSchema material = HdMaterialSchema::GetFromParent(prim.dataSource);
    val entry = val::object();
    entry.set("rid", rec.rid);
    entry.set("path", rec.path.GetString());
    std::set<std::string> textures;
    if (material) {
        if (const HdMaterialNetworkSchema universal = material.GetMaterialNetwork()) {
            HdDataSourceMaterialNetworkInterface network(rec.path, universal.GetContainer(), prim.dataSource);
            const std::string json = NetworkJson(network);
            if (!json.empty()) entry.set("network", ParseJson(json));
            CollectTextures(network, &textures);
        }
        static const TfToken mtlx("mtlx");
        if (const HdContainerDataSourceHandle container = HdContainerDataSource::Cast(material.GetContainer()->Get(mtlx))) {
            HdDataSourceMaterialNetworkInterface network(rec.path, container, prim.dataSource);
            const std::string xml = MaterialXDocument(network);
            if (!xml.empty()) entry.set("mtlx", xml);
            CollectTextures(network, &textures);
        }
    }
    val list = val::array();
    for (const std::string& texture : textures) list.call<void>("push", texture);
    entry.set("textures", list);
    Push(delta, "materials", entry);
}


bool SceneBridge::GatherMesh(Rec& rec, bool created, MeshJob* job)
{
    const HdDataSourceLocatorSet& dirty = rec.dirty;
    const bool topologyDirty = dirty.Intersects(HdMeshSchema::GetDefaultLocator());
    if (!topologyDirty && !dirty.Intersects(HdPrimvarsSchema::GetDefaultLocator())) return false;

    const HdContainerDataSourceHandle source = _scene->GetPrim(rec.path).dataSource;
    const HdMeshSchema mesh = HdMeshSchema::GetFromParent(source);
    const HdMeshTopologySchema topology = mesh.GetTopology();
    const HdPrimvarsSchema primvars = HdPrimvarsSchema::GetFromParent(source);
    if (!mesh || !topology || !primvars) return false;

    job->rec = &rec;
    job->topologyDirty = topologyDirty;
    job->doubleSided = Value(mesh.GetDoubleSided(), false);
    MeshIn& in = job->in;
    in.scheme = Value(mesh.GetSubdivisionScheme(), PxOsdOpenSubdivTokens->none);
    in.orientation = Value(topology.GetOrientation(), PxOsdOpenSubdivTokens->rightHanded);
    in.faceVertexCounts = Value(topology.GetFaceVertexCounts());
    in.faceVertexIndices = Value(topology.GetFaceVertexIndices());
    in.holeIndices = Value(topology.GetHoleIndices());
    in.refineLevel = Refinable(in.scheme) ? MeshRefineLevel(rec.path, source) : 0;
    rec.level = in.refineLevel;
    in.points = ReadPoints(primvars);
    if (const HdSubdivisionTagsSchema tags = mesh.GetSubdivisionTags()) {
        if (const auto ds = tags.GetFaceVaryingLinearInterpolation()) in.tags.SetFaceVaryingInterpolationRule(ds->GetTypedValue(0.0f));
        if (const auto ds = tags.GetInterpolateBoundary()) in.tags.SetVertexInterpolationRule(ds->GetTypedValue(0.0f));
        if (const auto ds = tags.GetTriangleSubdivisionRule()) in.tags.SetTriangleSubdivision(ds->GetTypedValue(0.0f));
        if (const auto ds = tags.GetCornerIndices()) in.tags.SetCornerIndices(ds->GetTypedValue(0.0f));
        if (const auto ds = tags.GetCornerSharpnesses()) in.tags.SetCornerWeights(ds->GetTypedValue(0.0f));
        if (const auto ds = tags.GetCreaseIndices()) in.tags.SetCreaseIndices(ds->GetTypedValue(0.0f));
        if (const auto ds = tags.GetCreaseLengths()) in.tags.SetCreaseLengths(ds->GetTypedValue(0.0f));
        if (const auto ds = tags.GetCreaseSharpnesses()) in.tags.SetCreaseWeights(ds->GetTypedValue(0.0f));
    }

    // Streams sent to the page: normals, displayColor and every 2D primvar (texture coordinates).
    // ponytail: other primvar types are not sent; add them when a material reads one.
    const bool pointsOnly = created && !topologyDirty && OnlyPointsDirty(dirty);
    job->pointsOnly = pointsOnly;
    std::vector<float>& constantColor = job->constantColor;
    float& constantOpacity = job->constantOpacity;
    for (const TfToken& name : primvars.GetPrimvarNames()) {
        if (name == HdPrimvarsSchemaTokens->points) continue;
        const bool isNormals = name == HdPrimvarsSchemaTokens->normals;
        if (pointsOnly && !isNormals) continue;
        PrimvarIn primvar;
        if (!ReadPrimvar(primvars, name, &primvar)) continue;
        const bool constant = primvar.interpolation == HdPrimvarSchemaTokens->constant;
        if (name == HdTokens->displayColor && primvar.size == 3) {
            if (constant) constantColor = primvar.values;
            else in.primvars.push_back(std::move(primvar));
        } else if (name == HdTokens->displayOpacity && primvar.size == 1) {
            if (constant) constantOpacity = primvar.values[0];
        } else if ((isNormals && primvar.size == 3) || (primvar.size == 2 && !constant)) {
            in.primvars.push_back(std::move(primvar));
        }
    }

    // A point-only update skips the primvars that decided the vertex layout; keep that layout.
    in.expand = pointsOnly && rec.expanded;
    return true;
}

void SceneBridge::BuildMeshJob(MeshJob& job)
{
    job.out = BuildMesh(job.in);
    if (job.topologyDirty) job.counts = CountMesh(job.in);
}

void SceneBridge::EmitMesh(MeshJob& job, val& entry)
{
    Rec& rec = *job.rec;
    const MeshIn& in = job.in;
    MeshOut& out = job.out;
    const bool topologyDirty = job.topologyDirty, pointsOnly = job.pointsOnly;
    const std::vector<float>& constantColor = job.constantColor;
    const float constantOpacity = job.constantOpacity;
    const HdContainerDataSourceHandle source = _scene->GetPrim(rec.path).dataSource;
    rec.expanded = out.expanded;
    const bool full = topologyDirty || out.positions.size() / 3 != rec.vertexCount || out.indices.size() != rec.indexCount;
    rec.vertexCount = out.positions.size() / 3;
    rec.indexCount = out.indices.size();

    if (full) {
        // Geom subsets: group the triangles of each subset into one contiguous index range.
        struct SubsetIn { VtIntArray faces; uint32_t material; };
        std::vector<SubsetIn> subsets;
        for (const SdfPath& child : _scene->GetChildPrimPaths(rec.path)) {
            const HdSceneIndexPrim prim = _scene->GetPrim(child);
            if (prim.primType != HdPrimTypeTokens->geomSubset || !prim.dataSource) continue;
            const HdGeomSubsetSchema schema = HdGeomSubsetSchema::GetFromParent(prim.dataSource);
            if (!schema || Value(schema.GetType()) != HdGeomSubsetSchemaTokens->typeFaceSet) continue;
            const SdfPath material = BoundMaterial(prim.dataSource);
            if (material.IsEmpty()) continue;
            subsets.push_back({ Value(schema.GetIndices()), RidOf(material) });
        }
        if (subsets.empty()) entry.set("subsets", val::null());
        else {
            const int remainder = int(subsets.size());
            std::vector<int> group(in.faceVertexCounts.size(), remainder);
            for (int s = remainder - 1; s >= 0; s--) { // the first subset claiming a face wins
                for (int face : subsets[s].faces) {
                    if (face >= 0 && size_t(face) < group.size()) group[face] = s;
                }
            }
            std::vector<size_t> start(subsets.size() + 2, 0);
            for (int face : out.triangleFace) start[group[face] + 1]++;
            for (size_t g = 1; g < start.size(); g++) start[g] += start[g - 1];
            std::vector<uint32_t> ordered(out.indices.size());
            std::vector<size_t> cursor(start.begin(), start.end() - 1);
            for (size_t t = 0; t < out.triangleFace.size(); t++) {
                const size_t slot = cursor[group[out.triangleFace[t]]]++;
                std::copy_n(&out.indices[t * 3], 3, &ordered[slot * 3]);
            }
            out.indices.swap(ordered);
            val list = val::array();
            const uint32_t meshMaterial = RidOf(BoundMaterial(source));
            for (int g = 0; g <= remainder; g++) {
                if (start[g + 1] == start[g]) continue;
                val subset = val::object();
                subset.set("start", double(start[g] * 3));
                subset.set("count", double((start[g + 1] - start[g]) * 3));
                subset.set("material", g < remainder ? subsets[g].material : meshMaterial);
                list.call<void>("push", subset);
            }
            entry.set("subsets", list);
        }
        entry.set("indices", Typed("Uint32Array", out.indices.data(), out.indices.size()));
        entry.set("edges", Typed("Uint32Array", out.edges.data(), out.edges.size()));
        entry.set("doubleSided", job.doubleSided);
        const MeshCounts counts = topologyDirty ? job.counts : CountMesh(in);
        val usd = val::object();
        usd.set("points", double(counts.points));
        usd.set("faces", double(counts.faces));
        usd.set("edges", double(counts.edges));
        entry.set("counts", usd);
    }
    entry.set("positions", Floats(out.positions));
    entry.set("normals", out.normals.empty() ? val::null() : Floats(out.normals));
    if (!pointsOnly) {
        val list = val::array();
        for (const PrimvarOut& primvar : out.primvars) {
            val item = val::object();
            item.set("name", primvar.name);
            item.set("size", primvar.size);
            item.set("data", Floats(primvar.data));
            list.call<void>("push", item);
        }
        entry.set("primvars", list);
        if (constantColor.size() == 3) entry.set("displayColor", ParseJson(TfStringPrintf("[%g,%g,%g]", constantColor[0], constantColor[1], constantColor[2])));
        if (constantOpacity >= 0) entry.set("displayOpacity", constantOpacity);
    }
}

void SceneBridge::ConvertCurves(Rec& rec, bool created, val& entry)
{
    if (!rec.dirty.Intersects(HdBasisCurvesSchema::GetDefaultLocator()) && !rec.dirty.Intersects(HdPrimvarsSchema::GetDefaultLocator())) return;
    const HdContainerDataSourceHandle source = _scene->GetPrim(rec.path).dataSource;
    const HdBasisCurvesTopologySchema topology = HdBasisCurvesSchema::GetFromParent(source).GetTopology();
    const HdPrimvarsSchema primvars = HdPrimvarsSchema::GetFromParent(source);
    if (!topology || !primvars) return;

    CurvesIn in;
    in.type = Value(topology.GetType(), HdTokens->linear);
    in.basis = Value(topology.GetBasis(), HdTokens->bezier);
    in.wrap = Value(topology.GetWrap(), HdTokens->nonperiodic);
    in.counts = Value(topology.GetCurveVertexCounts());
    in.indices = Value(topology.GetCurveIndices());
    in.points = ReadPoints(primvars);
    in.refineLevel = std::min(RefineLevel(), 3);
    rec.level = in.type == HdTokens->cubic ? in.refineLevel : 0;
    PrimvarIn widths, color;
    if (ReadPrimvar(primvars, HdTokens->widths, &widths) && widths.size == 1) in.primvars.push_back(widths);
    if (ReadPrimvar(primvars, HdTokens->displayColor, &color) && color.size == 3) {
        if (color.interpolation == HdPrimvarSchemaTokens->constant) {
            entry.set("displayColor", ParseJson(TfStringPrintf("[%g,%g,%g]", color.values[0], color.values[1], color.values[2])));
        } else in.primvars.push_back(color);
    }
    const CurvesOut out = BuildCurves(in);
    entry.set("points", Floats(out.points));
    entry.set("counts", Typed("Uint32Array", out.counts.data(), out.counts.size()));
    entry.set("widths", out.widths.empty() ? val::null() : Floats(out.widths));
    entry.set("colors", out.colors.empty() ? val::null() : Floats(out.colors));
}

void SceneBridge::ConvertPoints(Rec& rec, bool created, val& entry)
{
    if (!rec.dirty.Intersects(HdPrimvarsSchema::GetDefaultLocator())) return;
    const HdContainerDataSourceHandle source = _scene->GetPrim(rec.path).dataSource;
    const HdPrimvarsSchema primvars = HdPrimvarsSchema::GetFromParent(source);
    if (!primvars) return;
    const VtVec3fArray points = ReadPoints(primvars);
    const size_t count = points.size();
    entry.set("points", Typed("Float32Array", count ? points.cdata()->data() : nullptr, count * 3));
    // Constant values are spread over the points so the page has one code path.
    const auto perPoint = [&](PrimvarIn& primvar) {
        if (primvar.values.size() == count * primvar.size) return;
        std::vector<float> spread(count * primvar.size);
        for (size_t i = 0; i < spread.size(); i++) spread[i] = primvar.values[i % primvar.size];
        primvar.values.swap(spread);
    };
    PrimvarIn widths, color;
    if (ReadPrimvar(primvars, HdTokens->widths, &widths) && widths.size == 1) {
        perPoint(widths);
        entry.set("widths", Floats(widths.values));
    } else entry.set("widths", val::null());
    if (ReadPrimvar(primvars, HdTokens->displayColor, &color) && color.size == 3) {
        if (color.interpolation == HdPrimvarSchemaTokens->constant) {
            entry.set("displayColor", ParseJson(TfStringPrintf("[%g,%g,%g]", color.values[0], color.values[1], color.values[2])));
            entry.set("colors", val::null());
        } else {
            perPoint(color);
            entry.set("colors", Floats(color.values));
        }
    }
}

/// Keeps the item's instance matrices current. Returns true when the entry was changed.
bool SceneBridge::UpdateInstancing(Rec& rec, const HdContainerDataSourceHandle& source, val& entry)
{
    const bool relevant = rec.instancesDirty || !rec.created
        || rec.dirty.Intersects(HdInstancedBySchema::GetDefaultLocator())
        || (!rec.instancer.IsEmpty() && rec.dirty.Intersects(HdXformSchema::GetDefaultLocator()));
    if (!relevant) return false;
    const SdfPath instancer = InstancedBy(source);
    if (instancer != rec.instancer) {
        if (!rec.instancer.IsEmpty()) _instancerUsers[rec.instancer].erase(rec.path);
        if (!instancer.IsEmpty()) _instancerUsers[instancer].insert(rec.path);
        rec.instancer = instancer;
    }
    if (instancer.IsEmpty()) {
        entry.set("instances", val::null());
        return true;
    }
    // Fully composed world matrices: the prototype's own transform, then each instance's.
    const GfMatrix4d local = Xform(source);
    const VtMatrix4dArray transforms = InstanceTransforms(_scene, instancer, rec.path);
    std::vector<float> matrices(transforms.size() * 16);
    for (size_t i = 0; i < transforms.size(); i++) {
        const GfMatrix4d world = local * transforms[i];
        for (int k = 0; k < 16; k++) matrices[i * 16 + k] = float(world.data()[k]);
    }
    entry.set("instances", Floats(matrices));
    return true;
}

void SceneBridge::UpdateSelection(Rec& rec, const HdContainerDataSourceHandle& source)
{
    const HdSelectionsSchema selections = HdSelectionsSchema::GetFromParent(source);
    const size_t count = selections ? selections.GetNumElements() : 0;
    const bool was = rec.selected;
    rec.selected = count > 0;
    rec.selectedAll = false;
    rec.selectedInstances.clear();
    for (size_t i = 0; i < count; i++) {
        const HdInstanceIndicesVectorSchema nested = selections.GetElement(i).GetNestedInstanceIndices();
        if (!nested || nested.GetNumElements() == 0) rec.selectedAll = true;
        else {
            const std::vector<uint32_t> ids = SelectedInstanceIds(_scene, nested);
            rec.selectedInstances.insert(rec.selectedInstances.end(), ids.begin(), ids.end());
        }
    }
    if (rec.selected) _selected.insert(&rec);
    else _selected.erase(&rec);
    if (rec.selected || was) _selectionDirty = true;
}

std::string SceneBridge::ResolvePick(uint32_t rid, int instanceIndex) const
{
    const auto found = _paths.find(rid);
    if (found == _paths.end() || !_scene) return "null";
    // Port of HdxPrimOriginInfo::FromPickHit / GetFullPath (hdx/pickTask.cpp).
    const auto origin = [](const HdContainerDataSourceHandle& source, SdfPath* path) {
        const HdPrimOriginSchema schema = HdPrimOriginSchema::GetFromParent(source);
        const SdfPath scenePath = schema ? schema.GetOriginPath(HdPrimOriginSchemaTokens->scenePath) : SdfPath();
        if (scenePath.IsEmpty()) return false;
        *path = scenePath.IsAbsolutePath() ? scenePath : path->AppendPath(scenePath);
        return true;
    };
    struct Level { HdContainerDataSourceHandle instancer, instance; int id; };
    std::vector<Level> levels; // innermost first
    SdfPath path = found->second;
    HdContainerDataSourceHandle source = _scene->GetPrim(path).dataSource;
    const HdContainerDataSourceHandle primSource = source;
    int remaining = std::max(instanceIndex, 0);
    for (;;) {
        const SdfPath instancer = InstancedBy(source);
        if (instancer.IsEmpty()) break;
        const HdContainerDataSourceHandle instancerSource = _scene->GetPrim(instancer).dataSource;
        const HdInstancerTopologySchema topology = HdInstancerTopologySchema::GetFromParent(instancerSource);
        if (!topology) break;
        const VtIntArray indices = topology.ComputeInstanceIndicesForProto(path);
        if (indices.empty()) break;
        const int id = indices[remaining % indices.size()];
        remaining /= int(indices.size());
        const VtArray<SdfPath> locations = Value(topology.GetInstanceLocations());
        HdContainerDataSourceHandle instance;
        if (id >= 0 && size_t(id) < locations.size()) instance = _scene->GetPrim(locations[id]).dataSource;
        levels.push_back({ instancerSource, instance, id });
        path = instancer;
        source = instancerSource;
    }
    // Native instances contribute the instance's path; point instancers are reported as the instancer.
    SdfPath full, prefix, pointInstancer;
    int pointInstance = -1;
    for (auto level = levels.rbegin(); level != levels.rend(); ++level) {
        SdfPath instancerPath = prefix;
        if (pointInstancer.IsEmpty() && origin(level->instancer, &instancerPath)) {
            pointInstancer = instancerPath;
            pointInstance = level->id;
        }
        origin(level->instance, &prefix);
        origin(level->instance, &full);
    }
    origin(primSource, &full);

    std::ostringstream stream;
    JsWriter writer(stream);
    writer.BeginObject();
    writer.WriteKey("path");
    writer.WriteValue((pointInstancer.IsEmpty() ? full : pointInstancer).GetString());
    if (!pointInstancer.IsEmpty()) {
        writer.WriteKey("instancer");
        writer.WriteValue(pointInstancer.GetString());
        writer.WriteKey("instanceIndex");
        writer.WriteValue(pointInstance);
    }
    writer.EndObject();
    return stream.str();
}
