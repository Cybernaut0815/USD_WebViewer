#include "stage.h"
#include "webResolver.h"

#include "pxr/base/gf/half.h"
#include "pxr/base/gf/matrix2d.h"
#include "pxr/base/gf/matrix3d.h"
#include "pxr/base/gf/matrix4d.h"
#include "pxr/base/gf/quatd.h"
#include "pxr/base/gf/quatf.h"
#include "pxr/base/gf/quath.h"
#include "pxr/base/gf/vec2d.h"
#include "pxr/base/gf/vec2f.h"
#include "pxr/base/gf/vec2h.h"
#include "pxr/base/gf/vec2i.h"
#include "pxr/base/gf/vec3d.h"
#include "pxr/base/gf/vec3f.h"
#include "pxr/base/gf/vec3h.h"
#include "pxr/base/gf/vec3i.h"
#include "pxr/base/gf/vec4d.h"
#include "pxr/base/gf/vec4f.h"
#include "pxr/base/gf/vec4h.h"
#include "pxr/base/gf/vec4i.h"
#include "pxr/base/tf/notice.h"
#include "pxr/base/tf/stringUtils.h"
#include "pxr/base/vt/array.h"
#include "pxr/base/vt/dictionary.h"
#include "pxr/usd/kind/registry.h"
#include "pxr/usd/pcp/layerStack.h"
#include "pxr/usd/pcp/node.h"
#include "pxr/usd/sdf/attributeSpec.h"
#include "pxr/usd/sdf/changeBlock.h"
#include "pxr/usd/sdf/copyUtils.h"
#include "pxr/usd/sdf/listOp.h"
#include "pxr/usd/sdf/primSpec.h"
#include "pxr/usd/sdf/schema.h"
#include "pxr/usd/usd/primCompositionQuery.h"
#include "pxr/usd/usd/references.h"
#include "pxr/usd/usdGeom/mesh.h"
#include "pxr/usd/usdGeom/primvar.h"
#include "pxr/usd/usdGeom/primvarsAPI.h"
#include "pxr/usd/sdf/assetPath.h"
#include "pxr/usd/sdf/timeCode.h"
#include "pxr/usd/usd/attribute.h"
#include "pxr/usd/usd/editContext.h"
#include "pxr/usd/usd/modelAPI.h"
#include "pxr/usd/usd/notice.h"
#include "pxr/usd/usd/primRange.h"
#include "pxr/usd/usd/relationship.h"
#include "pxr/usd/usd/variantSets.h"
#include "pxr/usd/usdGeom/bboxCache.h"
#include "pxr/usd/usdGeom/imageable.h"
#include "pxr/usd/usdGeom/metrics.h"
#include "pxr/usd/usdGeom/tokens.h"
#include "pxr/usd/usdGeom/xformable.h"
#include "pxr/base/gf/rotation.h"
#include "pxr/usd/sdf/fileFormat.h"
#include "pxr/usd/usd/editTarget.h"
#include "pxr/usd/sdf/usdFileFormat.h"
#include "pxr/usd/usdGeom/xformCache.h"
#include "pxr/usd/usdGeom/xformCommonAPI.h"
#include "pxr/usd/usdGeom/xformOp.h"
#include "pxr/usd/usdShade/materialBindingAPI.h"

#include <algorithm>
#include <cmath>
#include <fstream>
#include <limits>
#include <map>
#include <unordered_map>
#include <unordered_set>
#include <set>
#include <sstream>

namespace {

/* ---------- VtValue -> JSON ---------- */

void Write(JsWriter& w, bool v) { w.WriteValue(v); }
void Write(JsWriter& w, int v) { w.WriteValue(v); }
void Write(JsWriter& w, unsigned v) { w.WriteValue(v); }
void Write(JsWriter& w, int64_t v) { w.WriteValue(v); }
void Write(JsWriter& w, uint64_t v) { w.WriteValue(v); }
void Write(JsWriter& w, double v)
{
    if (std::isfinite(v)) w.WriteValue(v);
    else w.WriteValue(nullptr); // JSON has no NaN or infinity
}
void Write(JsWriter& w, float v) { Write(w, double(v)); }
void Write(JsWriter& w, GfHalf v) { Write(w, double(v)); }
void Write(JsWriter& w, const std::string& v) { w.WriteValue(v); }
void Write(JsWriter& w, const TfToken& v) { w.WriteValue(v.GetString()); }
void Write(JsWriter& w, const SdfPath& v) { w.WriteValue(v.GetString()); }
void Write(JsWriter& w, const SdfTimeCode& v) { Write(w, v.GetValue()); }
void Write(JsWriter& w, const SdfAssetPath& v)
{
    w.BeginObject();
    w.WriteKey("asset");
    w.WriteValue(v.GetAssetPath());
    w.WriteKey("resolved");
    w.WriteValue(v.GetResolvedPath());
    w.EndObject();
}
template <class T>
void WriteNumbers(JsWriter& w, const T* data, size_t count)
{
    w.BeginArray();
    for (size_t i = 0; i < count; i++) Write(w, double(data[i]));
    w.EndArray();
}
#define VEC_WRITER(Type) \
    void Write(JsWriter& w, const Type& v) { WriteNumbers(w, v.data(), Type::dimension); }
VEC_WRITER(GfVec2f) VEC_WRITER(GfVec2d) VEC_WRITER(GfVec2i) VEC_WRITER(GfVec2h)
VEC_WRITER(GfVec3f) VEC_WRITER(GfVec3d) VEC_WRITER(GfVec3i) VEC_WRITER(GfVec3h)
VEC_WRITER(GfVec4f) VEC_WRITER(GfVec4d) VEC_WRITER(GfVec4i) VEC_WRITER(GfVec4h)
#undef VEC_WRITER
template <class Quat>
void WriteQuat(JsWriter& w, const Quat& q) // real first, like USD text
{
    const double values[4] = { double(q.GetReal()), double(q.GetImaginary()[0]), double(q.GetImaginary()[1]), double(q.GetImaginary()[2]) };
    WriteNumbers(w, values, 4);
}
void Write(JsWriter& w, const GfQuatf& q) { WriteQuat(w, q); }
void Write(JsWriter& w, const GfQuatd& q) { WriteQuat(w, q); }
void Write(JsWriter& w, const GfQuath& q) { WriteQuat(w, q); }
void Write(JsWriter& w, const GfMatrix2d& m) { WriteNumbers(w, m.data(), 4); }
void Write(JsWriter& w, const GfMatrix3d& m) { WriteNumbers(w, m.data(), 9); }
void Write(JsWriter& w, const GfMatrix4d& m) { WriteNumbers(w, m.data(), 16); }

template <class T>
bool TryWrite(JsWriter& w, const VtValue& value, size_t maxElements)
{
    if (value.IsHolding<T>()) {
        Write(w, value.UncheckedGet<T>());
        return true;
    }
    if (!value.IsHolding<VtArray<T>>()) return false;
    const VtArray<T>& array = value.UncheckedGet<VtArray<T>>();
    const bool truncate = array.size() > maxElements;
    if (truncate) {
        w.BeginObject();
        w.WriteKey("length");
        w.WriteValue(uint64_t(array.size()));
        w.WriteKey("head");
    }
    w.BeginArray();
    for (size_t i = 0; i < std::min(array.size(), maxElements); i++) Write(w, array[i]);
    w.EndArray();
    if (truncate) w.EndObject();
    return true;
}

template <class... Types>
bool TryWriteAny(JsWriter& w, const VtValue& value, size_t maxElements)
{
    return (TryWrite<Types>(w, value, maxElements) || ...);
}

/// List-op metadata (apiSchemas, ...) as the list it applies to.
template <class T>
bool TryWriteListOp(JsWriter& w, const VtValue& value)
{
    if (!value.IsHolding<SdfListOp<T>>()) return false;
    typename SdfListOp<T>::ItemVector items;
    value.UncheckedGet<SdfListOp<T>>().ApplyOperations(&items);
    w.BeginArray();
    for (const T& item : items) Write(w, item);
    w.EndArray();
    return true;
}

/* ---------- JSON -> VtValue, guided by the attribute's type ---------- */

bool Numbers(const JsValue& js, std::vector<double>* out)
{
    if (!js.IsArray()) return false;
    for (const JsValue& item : js.GetJsArray()) {
        if (item.IsArray()) { // nested arrays (e.g. a list of vectors) are flattened
            if (!Numbers(item, out)) return false;
        } else if (item.IsReal() || item.IsInt()) out->push_back(item.GetReal());
        else return false;
    }
    return true;
}

template <class Vec>
VtValue MakeVec(const std::vector<double>& n)
{
    if (n.size() != Vec::dimension) return {};
    Vec v;
    for (size_t i = 0; i < n.size(); i++) v[i] = typename Vec::ScalarType(n[i]);
    return VtValue(v);
}
template <class Vec>
VtValue MakeVecArray(const std::vector<double>& n)
{
    if (n.size() % Vec::dimension) return {};
    VtArray<Vec> array(n.size() / Vec::dimension);
    for (size_t i = 0; i < n.size(); i++) array[i / Vec::dimension][i % Vec::dimension] = typename Vec::ScalarType(n[i]);
    return VtValue(array);
}
template <class Scalar>
VtValue MakeScalarArray(const std::vector<double>& n)
{
    return VtValue(VtArray<Scalar>(n.begin(), n.end()));
}

/// ponytail: covers scalars, strings, vectors, matrix4d and flat arrays of them;
/// quaternions and exotic types report "unsupported" until someone needs them.
VtValue FromJson(const JsValue& js, const SdfValueTypeName& typeName)
{
    const TfType type = typeName.GetType();
    if (js.IsBool()) return VtValue::CastToTypeid(VtValue(js.GetBool()), type.GetTypeid());
    if (js.IsString()) {
        const std::string& text = js.GetString();
        if (type.IsA<TfToken>()) return VtValue(TfToken(text));
        if (type.IsA<SdfAssetPath>()) return VtValue(SdfAssetPath(text));
        if (type.IsA<std::string>()) return VtValue(text);
        return {};
    }
    if (js.IsReal() || js.IsInt()) return VtValue::CastToTypeid(VtValue(js.GetReal()), type.GetTypeid());
    std::vector<double> n;
    if (!Numbers(js, &n)) return {};
#define CASE(T, make) \
    if (type.IsA<T>()) return make(n);
    CASE(GfVec2f, MakeVec<GfVec2f>) CASE(GfVec2d, MakeVec<GfVec2d>)
    CASE(GfVec3f, MakeVec<GfVec3f>) CASE(GfVec3d, MakeVec<GfVec3d>)
    CASE(GfVec4f, MakeVec<GfVec4f>) CASE(GfVec4d, MakeVec<GfVec4d>)
    CASE(VtArray<GfVec2f>, MakeVecArray<GfVec2f>) CASE(VtArray<GfVec3f>, MakeVecArray<GfVec3f>)
    CASE(VtArray<GfVec3d>, MakeVecArray<GfVec3d>)
    CASE(VtArray<float>, MakeScalarArray<float>) CASE(VtArray<double>, MakeScalarArray<double>)
    CASE(VtArray<int>, MakeScalarArray<int>)
#undef CASE
    if (type.IsA<GfMatrix4d>() && n.size() == 16) {
        GfMatrix4d m;
        std::copy(n.begin(), n.end(), m.data());
        return VtValue(m);
    }
    return {};
}

/* ---------- prim helpers ---------- */

UsdTimeCode Time(double time) { return std::isnan(time) ? UsdTimeCode::Default() : UsdTimeCode(time); }

Usd_PrimFlagsPredicate AllPrims() { return UsdTraverseInstanceProxies(UsdPrimAllPrimsPredicate); }

/// Computed visibility of a prim's ancestors and itself; true for the pseudo-root. Walks every
/// ancestor, so callers with many siblings pass the parent's answer to WriteSummary instead.
bool ComputedVisible(const UsdPrim& prim, UsdTimeCode time)
{
    if (!prim || prim.IsPseudoRoot()) return true;
    return UsdGeomImageable(prim).ComputeVisibility(time) != UsdGeomTokens->invisible;
}

/// The prim's own visibility opinion is "invisible" (the only value that propagates down).
bool AuthoredInvisible(const UsdGeomImageable& imageable, UsdTimeCode time)
{
    TfToken value;
    return imageable && imageable.GetVisibilityAttr().Get(&value, time) && value == UsdGeomTokens->invisible;
}

/// `parentVisible`: the parent's computed visibility, when the caller knows it (one attribute read
/// per child instead of a walk to the root for each).
void WriteSummary(JsWriter& w, const UsdPrim& prim, UsdTimeCode time, const bool* parentVisible = nullptr)
{
    TfToken kind;
    UsdModelAPI(prim).GetKind(&kind);
    const UsdGeomImageable imageable(prim);
    const bool visible = !imageable ? true
        : parentVisible ? *parentVisible && !AuthoredInvisible(imageable, time)
                        : imageable.ComputeVisibility(time) != UsdGeomTokens->invisible;
    w.BeginObject();
    w.WriteKey("name");
    w.WriteValue(prim.GetName().GetString());
    w.WriteKey("path");
    w.WriteValue(prim.GetPath().GetString());
    w.WriteKey("typeName");
    w.WriteValue(prim.GetTypeName().GetString());
    w.WriteKey("kind");
    w.WriteValue(kind.GetString());
    w.WriteKey("hasChildren");
    w.WriteValue(!prim.GetFilteredChildren(AllPrims()).empty());
    w.WriteKey("active");
    w.WriteValue(prim.IsActive());
    w.WriteKey("visible");
    w.WriteValue(visible);
    w.WriteKey("isInstance");
    w.WriteValue(prim.IsInstance());
    w.WriteKey("hasPayload");
    w.WriteValue(prim.HasAuthoredPayloads());
    w.WriteKey("loaded");
    w.WriteValue(prim.IsLoaded());
    w.WriteKey("hasVariantSets");
    w.WriteValue(prim.HasVariantSets());
    w.EndObject();
}

void WritePaths(JsWriter& w, const SdfPathVector& paths)
{
    w.BeginArray();
    for (const SdfPath& path : paths) w.WriteValue(path.GetString());
    w.EndArray();
}

/// Every authored metadata field of a prim or property, nested dictionaries included.
void WriteMetadata(JsWriter& w, const UsdObject& object, const std::vector<TfToken>& skip)
{
    w.BeginObject();
    for (const auto& [key, value] : object.GetAllAuthoredMetadata()) {
        if (std::find(skip.begin(), skip.end(), key) != skip.end()) continue;
        w.WriteKey(key.GetString());
        WriteJsonValue(w, value, 16);
    }
    w.EndObject();
}

/// Numeric arrays (points, indices, uv sets, ...) are not decoded for the inspector, which loads
/// them on request through AttributeValue; token, string, asset and path arrays stay inline.
bool LazyArray(const SdfValueTypeName& typeName)
{
    if (!typeName.IsArray()) return false;
    const TfType scalar = typeName.GetScalarType().GetType();
    return scalar != TfType::Find<TfToken>() && scalar != TfType::Find<std::string>()
        && scalar != TfType::Find<SdfAssetPath>() && scalar != TfType::Find<SdfPath>();
}

void WritePrimvar(JsWriter& w, const UsdGeomPrimvar& primvar, const UsdPrim& owner, UsdTimeCode at)
{
    TfToken name, interpolation;
    SdfValueTypeName typeName;
    int elementSize = 1;
    primvar.GetDeclarationInfo(&name, &typeName, &interpolation, &elementSize);
    const bool authored = primvar.HasAuthoredValue();
    const bool lazy = LazyArray(typeName) && authored; // unauthored ones show their fallback as before
    VtValue value;
    if (!lazy) primvar.Get(&value, at);
    w.BeginObject();
    w.WriteKey("name");
    w.WriteValue(name.GetString());
    w.WriteKey("typeName");
    w.WriteValue(typeName.GetAsToken().GetString());
    w.WriteKey("interpolation");
    w.WriteValue(interpolation.GetString());
    w.WriteKey("elementSize");
    w.WriteValue(elementSize);
    w.WriteKey("indexed");
    w.WriteValue(primvar.IsIndexed());
    w.WriteKey("value");
    WriteJsonValue(w, value, 16); // null when lazy
    if (primvar.IsIndexed()) {
        w.WriteKey("indices");
        if (lazy) w.WriteValue(nullptr);
        else {
            VtIntArray indices;
            primvar.GetIndices(&indices, at);
            WriteJsonValue(w, VtValue(indices), 16);
        }
    }
    w.WriteKey("authored");
    w.WriteValue(authored);
    if (primvar.GetAttr().GetPrim() != owner) {
        w.WriteKey("inheritedFrom");
        w.WriteValue(primvar.GetAttr().GetPrim().GetPath().GetString());
    }
    w.EndObject();
}

const char* ArcTypeName(PcpArcType type)
{
    switch (type) {
    case PcpArcTypeInherit: return "inherit";
    case PcpArcTypeVariant: return "variant";
    case PcpArcTypeRelocate: return "relocate";
    case PcpArcTypeReference: return "reference";
    case PcpArcTypePayload: return "payload";
    case PcpArcTypeSpecialize: return "specialize";
    default: return "root";
    }
}

const TfToken kRefineEnable("refinementEnableOverride"), kRefineLevel("refinementLevel");

/// Collects the paths a stage edit resynced, so the page can refresh those subtrees, and every
/// prim it touched at all (resynced or not), which the page marks as changed.
struct ChangeListener : TfWeakBase {
    SdfPathVector resynced; // prim resyncs only: property adds and removes are not subtree changes
    std::set<SdfPath> changed;
    void Changed(const UsdNotice::ObjectsChanged& notice)
    {
        for (const SdfPath& path : notice.GetResyncedPaths()) {
            if (path.IsAbsoluteRootOrPrimPath()) resynced.push_back(path);
            changed.insert(path.GetPrimPath());
        }
        for (const SdfPath& path : notice.GetChangedInfoOnlyPaths()) changed.insert(path.GetPrimPath());
    }
};

/// What the running edit replaced; reported as Edit.previous so the page can undo it.
VtValue gPrevious;

/// The edit target's own opinion on an attribute (default or the sample at `at`), empty when none.
VtValue LayerOpinion(const UsdStageRefPtr& stage, const UsdAttribute& attribute, UsdTimeCode at)
{
    VtValue value;
    if (!attribute) return value;
    const UsdEditTarget& target = stage->GetEditTarget();
    const SdfPath spec = target.MapToSpecPath(attribute.GetPath());
    if (spec.IsEmpty()) return value;
    if (at.IsDefault()) target.GetLayer()->HasField(spec, SdfFieldKeys->Default, &value);
    else target.GetLayer()->QueryTimeSample(spec, at.GetValue(), &value);
    return value;
}

/// The prim edits land on: instance proxies redirect to their instance.
UsdPrim EditablePrim(const UsdStageRefPtr& stage, const std::string& path)
{
    UsdPrim prim = stage && SdfPath::IsValidPathString(path) ? stage->GetPrimAtPath(SdfPath(path)) : UsdPrim();
    while (prim && prim.IsInstanceProxy()) prim = prim.GetParent();
    return prim;
}

/* ---------- change tracking: prims that differ from the stage as opened ---------- */

using Fields = std::map<TfToken, VtValue>;

/// A spec's fields without the child lists (children are compared as specs of their own).
Fields FieldsOf(const SdfLayerHandle& layer, const SdfPath& path)
{
    static const std::set<TfToken> children = { SdfChildrenKeys->PrimChildren, SdfChildrenKeys->PropertyChildren,
        SdfChildrenKeys->VariantSetChildren, SdfChildrenKeys->VariantChildren, SdfChildrenKeys->ConnectionChildren,
        SdfChildrenKeys->RelationshipTargetChildren, SdfChildrenKeys->MapperChildren, SdfChildrenKeys->MapperArgChildren,
        SdfChildrenKeys->ExpressionChildren };
    Fields fields;
    if (!layer || !layer->HasSpec(path)) return fields;
    for (const TfToken& key : layer->ListFields(path)) {
        if (!children.count(key)) fields[key] = layer->GetField(path, key);
    }
    return fields;
}

/// The local layer stack as opened (session layer excluded), the prims edits have touched since,
/// and what "Clear edits" replaced (for its undo).
struct ChangeTracker {
    std::vector<std::pair<SdfLayerHandle, SdfLayerRefPtr>> snapshot;
    std::set<SdfPath> touched;
    /// Differs() per touched prim, recomputed only for the prims an edit changes.
    std::unordered_map<SdfPath, bool, SdfPath::Hash> state;
    struct Stash {
        SdfPath path;
        std::vector<std::pair<SdfLayerHandle, SdfLayerRefPtr>> layers; // null: the layer had no spec there
    };
    std::map<int, Stash> stashes;
    int nextStash = 1;
    /// The stage whose layers are copied by the first tracked edit (a copy of a large stage takes
    /// seconds and doubles its memory, so opening does not pay for it).
    UsdStageRefPtr pending;

    void Reset(const UsdStageRefPtr& stage)
    {
        snapshot.clear();
        touched.clear();
        state.clear();
        stashes.clear();
        pending = stage;
    }

    void Ensure()
    {
        if (!pending) return;
        const UsdStageRefPtr stage = pending;
        pending = nullptr;
        for (const SdfLayerHandle& layer : stage->GetLayerStack(/*includeSessionLayers=*/false)) {
            SdfLayerRefPtr copy = SdfLayer::CreateAnonymous("snapshot");
            copy->TransferContent(layer);
            snapshot.emplace_back(layer, copy);
        }
    }

    /// True while the prim's own specs (not its children) differ from the snapshot in some layer.
    /// ponytail: specs left behind by undo (an over with no fields, an attribute with only
    /// typeName / custom / variability) count as absent; extend if other leftovers show up.
    bool Differs(const SdfPath& path) const
    {
        static const std::set<TfToken> bookkeeping = { SdfFieldKeys->TypeName, SdfFieldKeys->Custom, SdfFieldKeys->Variability };
        const auto prim = [&](const SdfLayerHandle& layer) {
            Fields fields = FieldsOf(layer, path);
            if (fields.empty()) fields[SdfFieldKeys->Specifier] = VtValue(SdfSpecifierOver);
            return fields;
        };
        const auto properties = [&](const SdfLayerHandle& layer, std::set<TfToken>* names) {
            if (const SdfPrimSpecHandle spec = layer->GetPrimAtPath(path)) {
                for (const SdfPropertySpecHandle& property : spec->GetProperties()) names->insert(property->GetNameToken());
            }
        };
        for (const auto& [layer, copy] : snapshot) {
            if (!layer) continue;
            if (prim(layer) != prim(copy)) return true;
            std::set<TfToken> names;
            properties(layer, &names);
            properties(copy, &names);
            for (const TfToken& name : names) {
                Fields now = FieldsOf(layer, path.AppendProperty(name)), then = FieldsOf(copy, path.AppendProperty(name));
                const auto strip = [&](Fields& fields) {
                    for (const TfToken& key : bookkeeping) fields.erase(key);
                };
                if (then.empty()) strip(now);
                if (now.empty()) strip(then);
                if (now != then) return true;
            }
        }
        return false;
    }
} gTracker;

/// Makes `path` in `layer` what it is in `from` (subtree included), or removes it when `from` has none.
void ReplacePrimSpec(const SdfLayerHandle& from, const SdfLayerHandle& layer, const SdfPath& path)
{
    if (from && from->GetPrimAtPath(path)) {
        SdfCreatePrimInLayer(layer, path);
        SdfCopySpec(from, path, layer, path);
    } else if (const SdfPrimSpecHandle spec = layer->GetPrimAtPath(path)) {
        const SdfPrimSpecHandle parent = path.GetParentPath().IsAbsoluteRootPath() ? layer->GetPseudoRoot() : layer->GetPrimAtPath(path.GetParentPath());
        if (parent) parent->RemoveNameChild(spec);
    }
}

/// Runs `edit` against the stage's edit target (the root layer unless changed) and reports it as an
/// Edit. `track`: the prims it touches become candidates for the change markers (not for viewer hiding).
template <class Fn>
std::string Edit(const UsdStageRefPtr& stage, Fn&& edit, bool track = true)
{
    std::string error = "no stage is open";
    ChangeListener listener;
    gPrevious = VtValue();
    if (stage) {
        if (track) gTracker.Ensure();
        TfNotice::Key key = TfNotice::Register(TfCreateWeakPtr(&listener), &ChangeListener::Changed, UsdStageWeakPtr(stage));
        error = edit();
        TfNotice::Revoke(key);
        if (track) gTracker.touched.insert(listener.changed.begin(), listener.changed.end());
    }
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginObject();
    w.WriteKey("ok");
    w.WriteValue(error.empty());
    if (!error.empty()) {
        w.WriteKey("error");
        w.WriteValue(error);
    }
    w.WriteKey("resynced");
    WritePaths(w, listener.resynced);
    // The full current list: prims touched so far that still differ from the stage as opened. Only
    // the prims this edit changed (or resynced below) are compared again; the rest keep their state.
    w.WriteKey("changed");
    SdfPathVector changed;
    for (const SdfPath& path : gTracker.touched) {
        const bool recheck = listener.changed.count(path)
            || std::any_of(listener.resynced.begin(), listener.resynced.end(), [&](const SdfPath& r) { return path.HasPrefix(r); });
        auto known = gTracker.state.find(path);
        if (recheck || known == gTracker.state.end()) known = gTracker.state.insert_or_assign(path, gTracker.Differs(path)).first;
        if (known->second) changed.push_back(path);
    }
    WritePaths(w, changed);
    w.WriteKey("touched");
    WritePaths(w, SdfPathVector(listener.changed.begin(), listener.changed.end()));
    if (!gPrevious.IsEmpty()) {
        w.WriteKey("previous");
        WriteJsonValue(w, gPrevious, std::numeric_limits<size_t>::max());
    }
    w.WriteKey("dirty");
    w.BeginArray();
    if (stage) {
        for (const SdfLayerHandle& layer : stage->GetUsedLayers()) {
            if (layer->IsDirty() && !layer->IsAnonymous()) w.WriteValue(layer->GetIdentifier());
        }
    }
    w.EndArray();
    w.EndObject();
    return stream.str();
}

/* ---------- transforms ---------- */

bool MatricesMatch(const GfMatrix4d& a, const GfMatrix4d& b)
{
    double scale = 1;
    for (int i = 0; i < 16; i++) scale = std::max(scale, std::abs(b.data()[i]));
    for (int i = 0; i < 16; i++) if (std::abs(a.data()[i] - b.data()[i]) > 1e-5 * scale) return false;
    return true;
}

GfMatrix4d AxisRotation(int axis, double degrees)
{
    const GfVec3d axes[3] = { GfVec3d::XAxis(), GfVec3d::YAxis(), GfVec3d::ZAxis() };
    return GfMatrix4d(1).SetRotate(GfRotation(axes[axis], degrees));
}

/// Euler angles (degrees) of a rotateABC op reproducing `rotation`: USD builds the op as
/// R(A) * R(B) * R(C), which GfRotation::Decompose(C, B, A) splits (see UsdGeomXformCommonAPI).
bool EulerFor(const GfMatrix4d& rotation, UsdGeomXformCommonAPI::RotationOrder order, GfVec3f* angles)
{
    int index[3] = { 0, 1, 2 };
    switch (order) {
        case UsdGeomXformCommonAPI::RotationOrderXZY: index[1] = 2; index[2] = 1; break;
        case UsdGeomXformCommonAPI::RotationOrderYXZ: index[0] = 1; index[1] = 0; break;
        case UsdGeomXformCommonAPI::RotationOrderYZX: index[0] = 1; index[1] = 2; index[2] = 0; break;
        case UsdGeomXformCommonAPI::RotationOrderZXY: index[0] = 2; index[1] = 0; index[2] = 1; break;
        case UsdGeomXformCommonAPI::RotationOrderZYX: index[0] = 2; index[2] = 0; break;
        default: break;
    }
    const GfVec3d axes[3] = { GfVec3d::XAxis(), GfVec3d::YAxis(), GfVec3d::ZAxis() };
    const GfVec3d split = rotation.ExtractRotation().Decompose(axes[index[2]], axes[index[1]], axes[index[0]]);
    GfVec3d euler;
    euler[index[2]] = split[0];
    euler[index[1]] = split[1];
    euler[index[0]] = split[2];
    const GfMatrix4d rebuilt = AxisRotation(index[0], euler[index[0]]) * AxisRotation(index[1], euler[index[1]]) * AxisRotation(index[2], euler[index[2]]);
    *angles = GfVec3f(euler);
    return MatricesMatch(rebuilt, rotation);
}

/// Sets a vector op in its own precision (UsdAttribute::Set is strict about types).
bool SetVec3(const UsdGeomXformOp& op, const GfVec3d& value, UsdTimeCode at)
{
    switch (op.GetPrecision()) {
        case UsdGeomXformOp::PrecisionDouble: return op.Set(value, at);
        case UsdGeomXformOp::PrecisionFloat: return op.Set(GfVec3f(value), at);
        default: return op.Set(GfVec3h(GfVec3f(value)), at);
    }
}

/// Rewrites a translate/pivot/rotate/scale stack so the local matrix becomes `target`, keeping the pivot.
bool SetCommonXform(const UsdGeomXformable& xformable, const GfMatrix4d& target, UsdTimeCode at, UsdTimeCode when)
{
    const UsdGeomXformCommonAPI api(xformable.GetPrim());
    GfVec3d t;
    GfVec3f r, s, p;
    UsdGeomXformCommonAPI::RotationOrder order;
    if (!api || !api.GetXformVectors(&t, &r, &s, &p, &order, at)) return false;
    // local = Pinv * S * R * P * T (row vectors, first op applied last), so P * local = (S * R) * (P * T):
    // the upper 3x3 is scale times rotation and the last row is pivot plus translation.
    const GfMatrix4d x = GfMatrix4d(1).SetTranslate(GfVec3d(p)) * target;
    const bool mirrored = x.GetDeterminant3() < 0;
    GfVec3d scale;
    GfMatrix4d rotation(1);
    for (int i = 0; i < 3; i++) {
        const GfVec3d row(x[i][0], x[i][1], x[i][2]);
        scale[i] = row.GetLength();
        if (mirrored && i == 2) scale[i] = -scale[i]; // ponytail: which axis carries the flip is a guess; any choice reproduces the matrix
        const GfVec3d unit = scale[i] != 0 ? row / scale[i] : GfVec3d(0);
        for (int j = 0; j < 3; j++) rotation[i][j] = unit[j];
    }
    GfVec3f angles;
    if (!EulerFor(rotation, order, &angles)) return false;
    // Ops are only added when the stack lacks them and the value needs them: a translate-only
    // prim that is moved stays translate-only.
    bool hasRotate = false, hasScale = false, resets = false;
    for (const UsdGeomXformOp& op : xformable.GetOrderedXformOps(&resets)) {
        const UsdGeomXformOp::Type type = op.GetOpType();
        hasRotate |= type >= UsdGeomXformOp::TypeRotateXYZ && type <= UsdGeomXformOp::TypeRotateZYX;
        hasScale |= type == UsdGeomXformOp::TypeScale;
    }
    const bool needRotate = hasRotate || !GfIsClose(GfVec3d(angles), GfVec3d(0), 1e-6);
    const bool needScale = hasScale || !GfIsClose(scale, GfVec3d(1), 1e-6);
    const UsdGeomXformCommonAPI::Ops ops = api.CreateXformOps(order, UsdGeomXformCommonAPI::OpTranslate,
        needRotate ? UsdGeomXformCommonAPI::OpRotate : UsdGeomXformCommonAPI::OpNone,
        needScale ? UsdGeomXformCommonAPI::OpScale : UsdGeomXformCommonAPI::OpNone);
    if (!ops.translateOp || (needRotate && !ops.rotateOp) || (needScale && !ops.scaleOp)) return false;
    if (!SetVec3(ops.translateOp, x.ExtractTranslation() - GfVec3d(p), when)) return false;
    if (needRotate && !SetVec3(ops.rotateOp, GfVec3d(angles), when)) return false;
    return !needScale || SetVec3(ops.scaleOp, scale, when);
}

} // namespace

void WriteJsonValue(JsWriter& writer, const VtValue& value, size_t maxElements)
{
    if (value.IsEmpty()) {
        writer.WriteValue(nullptr);
        return;
    }
    if (TryWriteAny<bool, int, unsigned, int64_t, uint64_t, float, double, GfHalf, std::string, TfToken, SdfAssetPath, SdfPath,
            SdfTimeCode, GfVec2f, GfVec2d, GfVec2i, GfVec2h, GfVec3f, GfVec3d, GfVec3i, GfVec3h, GfVec4f, GfVec4d, GfVec4i,
            GfVec4h, GfQuatf, GfQuatd, GfQuath, GfMatrix2d, GfMatrix3d, GfMatrix4d>(writer, value, maxElements)) {
        return;
    }
    if (value.IsHolding<VtDictionary>()) {
        writer.BeginObject();
        for (const auto& [key, item] : value.UncheckedGet<VtDictionary>()) {
            writer.WriteKey(key);
            WriteJsonValue(writer, item, maxElements);
        }
        writer.EndObject();
        return;
    }
    if (TryWriteListOp<TfToken>(writer, value) || TryWriteListOp<std::string>(writer, value) || TryWriteListOp<SdfPath>(writer, value)) return;
    writer.WriteValue(TfStringify(value)); // anything else: USD's own text form
}

std::string Stage::Open(const std::string& url, bool loadPayloads)
{
    Close();
    _stage = UsdStage::Open(url, loadPayloads ? UsdStage::LoadAll : UsdStage::LoadNone);
    _url = url;
    gTracker.Reset(_stage);
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginObject();
    w.WriteKey("ok");
    w.WriteValue(bool(_stage));
    w.WriteKey("url");
    w.WriteValue(url);
    if (!_stage) {
        w.WriteKey("error");
        w.WriteValue("Could not open " + url);
        w.EndObject();
        return stream.str();
    }
    const double start = _stage->GetStartTimeCode(), end = _stage->GetEndTimeCode();
    w.WriteKey("upAxis");
    w.WriteValue(UsdGeomGetStageUpAxis(_stage).GetString());
    w.WriteKey("metersPerUnit");
    w.WriteValue(UsdGeomGetStageMetersPerUnit(_stage));
    w.WriteKey("startTimeCode");
    w.WriteValue(start);
    w.WriteKey("endTimeCode");
    w.WriteValue(end);
    w.WriteKey("hasTimeRange");
    w.WriteValue(_stage->HasAuthoredTimeCodeRange() && end > start);
    w.WriteKey("timeCodesPerSecond");
    w.WriteValue(_stage->GetTimeCodesPerSecond());
    w.WriteKey("defaultPrim");
    if (const UsdPrim prim = _stage->GetDefaultPrim()) w.WriteValue(prim.GetPath().GetString());
    else w.WriteValue(nullptr);
    w.WriteKey("layers");
    w.BeginArray();
    for (const SdfLayerHandle& layer : _stage->GetLayerStack()) w.WriteValue(layer->GetDisplayName());
    w.EndArray();
    w.EndObject();
    return stream.str();
}

void Stage::Close()
{
    gTracker.Reset(nullptr);
    _stage.Reset();
    _url.clear();
}

std::string Stage::Children(const std::string& path) const
{
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginArray();
    if (const UsdPrim prim = _stage ? _stage->GetPrimAtPath(SdfPath(path)) : UsdPrim()) {
        const bool parentVisible = ComputedVisible(prim, UsdTimeCode::Default());
        for (const UsdPrim& child : prim.GetFilteredChildren(AllPrims())) WriteSummary(w, child, UsdTimeCode::Default(), &parentVisible);
    }
    w.EndArray();
    return stream.str();
}

std::string Stage::Visibility(const std::string& pathsJson) const
{
    JsParseError parseError;
    const JsValue js = JsParseString(pathsJson, &parseError);
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginArray();
    // Memoised per ancestor: the hierarchy asks for whole levels, whose ancestors are shared, so
    // each prim's own opinion is read once instead of once per descendant.
    std::unordered_map<SdfPath, bool, SdfPath::Hash> memo { { SdfPath::AbsoluteRootPath(), true } };
    const auto visible = [&](const SdfPath& path) {
        std::vector<SdfPath> chain; // path and its unknown ancestors, nearest first
        SdfPath at = path;
        while (!memo.count(at)) {
            chain.push_back(at);
            at = at.GetParentPath();
        }
        bool result = memo[at];
        for (auto it = chain.rbegin(); it != chain.rend(); ++it) {
            result = result && !AuthoredInvisible(UsdGeomImageable(_stage->GetPrimAtPath(*it)), UsdTimeCode::Default());
            memo[*it] = result;
        }
        return result;
    };
    for (const JsValue& item : js.IsArray() ? js.GetJsArray() : JsArray()) {
        const UsdPrim prim = _stage && item.IsString() && SdfPath::IsValidPathString(item.GetString()) ? _stage->GetPrimAtPath(SdfPath(item.GetString())) : UsdPrim();
        // Non-imageable and missing prims count as visible, like the summaries.
        w.WriteValue(!UsdGeomImageable(prim) || visible(prim.GetPath()));
    }
    w.EndArray();
    return stream.str();
}

std::string Stage::Bounds(const std::string& path, double time) const
{
    const UsdPrim prim = _stage && SdfPath::IsValidPathString(path) ? _stage->GetPrimAtPath(SdfPath(path)) : UsdPrim();
    const UsdGeomImageable imageable(prim);
    if (!imageable) return "null";
    const UsdTimeCode at = Time(time);
    UsdGeomBBoxCache cache(at, { UsdGeomTokens->default_, UsdGeomTokens->render, UsdGeomTokens->proxy }, true);
    const GfRange3d range = cache.ComputeWorldBound(prim).ComputeAlignedRange();
    if (range.IsEmpty()) return "null";
    std::ostringstream stream;
    JsWriter w(stream);
    const double bounds[6] = { range.GetMin()[0], range.GetMin()[1], range.GetMin()[2], range.GetMax()[0], range.GetMax()[1], range.GetMax()[2] };
    WriteNumbers(w, bounds, 6);
    return stream.str();
}

std::string Stage::Details(const std::string& path, double time) const
{
    const UsdPrim prim = _stage ? _stage->GetPrimAtPath(SdfPath(path)) : UsdPrim();
    if (!prim) return "null";
    const UsdTimeCode at = Time(time);
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginObject();
    w.WriteKey("summary");
    WriteSummary(w, prim, at);
    w.WriteKey("specifier");
    const SdfSpecifier specifier = prim.GetSpecifier();
    w.WriteValue(specifier == SdfSpecifierDef ? "def" : specifier == SdfSpecifierOver ? "over" : "class");
    w.WriteKey("purpose");
    const UsdGeomImageable imageable(prim);
    w.WriteValue(imageable ? imageable.ComputePurpose().GetString() : std::string());

    w.WriteKey("metadata");
    WriteMetadata(w, prim, {});

    w.WriteKey("appliedSchemas");
    w.BeginArray();
    for (const TfToken& schema : prim.GetAppliedSchemas()) w.WriteValue(schema.GetString());
    w.EndArray();

    w.WriteKey("attributes");
    w.BeginArray();
    for (const UsdAttribute& attribute : prim.GetAttributes()) {
        const SdfValueTypeName typeName = attribute.GetTypeName();
        const bool authored = attribute.HasAuthoredValue();
        VtValue value;
        if (!(LazyArray(typeName) && authored)) attribute.Get(&value, at); // unauthored arrays show their fallback as before
        SdfPathVector connections;
        attribute.GetConnections(&connections);
        w.BeginObject();
        w.WriteKey("name");
        w.WriteValue(attribute.GetName().GetString());
        w.WriteKey("typeName");
        w.WriteValue(typeName.GetAsToken().GetString());
        w.WriteKey("value");
        WriteJsonValue(w, value, 16); // null for lazy arrays: the panel asks for them on demand
        w.WriteKey("authored");
        w.WriteValue(authored);
        w.WriteKey("timeSamples");
        w.WriteValue(uint64_t(attribute.GetNumTimeSamples()));
        w.WriteKey("custom");
        w.WriteValue(attribute.IsCustom());
        w.WriteKey("variability");
        w.WriteValue(attribute.GetVariability() == SdfVariabilityUniform ? "uniform" : "varying");
        w.WriteKey("metadata");
        WriteMetadata(w, attribute, { SdfFieldKeys->TypeName, SdfFieldKeys->Custom, SdfFieldKeys->Variability, SdfFieldKeys->ConnectionPaths });
        if (!connections.empty()) {
            w.WriteKey("connections");
            WritePaths(w, connections);
        }
        w.EndObject();
    }
    w.EndArray();

    w.WriteKey("relationships");
    w.BeginArray();
    for (const UsdRelationship& relationship : prim.GetRelationships()) {
        SdfPathVector targets;
        relationship.GetTargets(&targets);
        w.BeginObject();
        w.WriteKey("name");
        w.WriteValue(relationship.GetName().GetString());
        w.WriteKey("targets");
        WritePaths(w, targets);
        w.EndObject();
    }
    w.EndArray();

    w.WriteKey("variantSets");
    w.BeginArray();
    const UsdVariantSets variantSets = prim.GetVariantSets();
    for (const std::string& name : variantSets.GetNames()) {
        const UsdVariantSet set = variantSets.GetVariantSet(name);
        w.BeginObject();
        w.WriteKey("name");
        w.WriteValue(name);
        w.WriteKey("variants");
        w.BeginArray();
        for (const std::string& variant : set.GetVariantNames()) w.WriteValue(variant);
        w.EndArray();
        w.WriteKey("selection");
        w.WriteValue(set.GetVariantSelection());
        w.EndObject();
    }
    w.EndArray();

    w.WriteKey("boundMaterial");
    const UsdShadeMaterial material = UsdShadeMaterialBindingAPI(prim).ComputeBoundMaterial();
    if (material) w.WriteValue(material.GetPath().GetString());
    else w.WriteValue(nullptr);

    w.WriteKey("worldXform");
    if (const UsdGeomXformable xformable { prim }) Write(w, xformable.ComputeLocalToWorldTransform(at));
    else w.WriteValue(nullptr);
    // World bounds are a subtree walk: the panel asks Bounds() for them when its section is open.

    w.WriteKey("primvars");
    w.BeginArray();
    {
        const UsdGeomPrimvarsAPI api(prim);
        for (const UsdGeomPrimvar& primvar : api.GetPrimvars()) WritePrimvar(w, primvar, prim, at);
        for (const UsdGeomPrimvar& primvar : api.FindPrimvarsWithInheritance()) {
            if (primvar.GetAttr().GetPrim() != prim) WritePrimvar(w, primvar, prim, at);
        }
    }
    w.EndArray();

    w.WriteKey("arcs");
    w.BeginArray();
    if (!prim.IsInstanceProxy()) {
        UsdPrimCompositionQuery query(prim);
        for (const UsdPrimCompositionQueryArc& arc : query.GetCompositionArcs()) {
            const SdfLayerHandle layer = arc.GetIntroducingLayer();
            const PcpLayerStackRefPtr stack = arc.GetTargetNode().GetLayerStack();
            w.BeginObject();
            w.WriteKey("type");
            w.WriteValue(ArcTypeName(arc.GetArcType()));
            w.WriteKey("layer");
            w.WriteValue(layer ? layer->GetDisplayName() : std::string());
            w.WriteKey("introducedAt");
            w.WriteValue(arc.GetIntroducingPrimPath().GetString());
            w.WriteKey("target");
            w.WriteValue(arc.GetTargetPrimPath().GetString());
            w.WriteKey("targetLayer");
            w.WriteValue(stack && stack->GetIdentifier().rootLayer ? stack->GetIdentifier().rootLayer->GetDisplayName() : std::string());
            w.WriteKey("ancestral");
            w.WriteValue(arc.IsAncestral());
            w.WriteKey("implicit");
            w.WriteValue(arc.IsImplicit());
            w.WriteKey("hasSpecs");
            w.WriteValue(arc.HasSpecs());
            w.EndObject();
        }
    }
    w.EndArray();

    w.WriteKey("refinement");
    if (prim.IsA<UsdGeomMesh>()) {
        bool enabled = false;
        int level = 0;
        if (const UsdAttribute attr = prim.GetAttribute(kRefineEnable)) attr.Get(&enabled);
        if (const UsdAttribute attr = prim.GetAttribute(kRefineLevel)) attr.Get(&level);
        w.BeginObject();
        w.WriteKey("enabled");
        w.WriteValue(enabled);
        w.WriteKey("level");
        w.WriteValue(level);
        w.EndObject();
    } else w.WriteValue(nullptr);

    w.WriteKey("primStack");
    w.BeginArray();
    for (const SdfPrimSpecHandle& spec : prim.GetPrimStack()) {
        w.BeginObject();
        w.WriteKey("layer");
        w.WriteValue(spec->GetLayer()->GetDisplayName());
        w.WriteKey("path");
        w.WriteValue(spec->GetPath().GetString());
        w.EndObject();
    }
    w.EndArray();
    w.EndObject();
    return stream.str();
}

std::string Stage::AttributeValue(const std::string& path, const std::string& name, double time) const
{
    std::ostringstream stream;
    JsWriter w(stream);
    VtValue value;
    if (const UsdPrim prim = _stage ? _stage->GetPrimAtPath(SdfPath(path)) : UsdPrim()) {
        prim.GetAttribute(TfToken(name)).Get(&value, Time(time));
    }
    WriteJsonValue(w, value, size_t(-1));
    return stream.str();
}

std::string Stage::Subtree(const std::string& path, int limit) const
{
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginArray();
    const UsdPrim prim = _stage && SdfPath::IsValidPathString(path) ? _stage->GetPrimAtPath(SdfPath(path)) : UsdPrim();
    if (prim && !prim.IsPseudoRoot()) {
        int count = 0;
        for (const UsdPrim& descendant : UsdPrimRange(prim)) {
            if (count++ >= limit) break;
            w.WriteValue(descendant.GetPath().GetString());
        }
    }
    w.EndArray();
    return stream.str();
}

std::string Stage::Find(const std::string& text, const std::string& typeName, int limit) const
{
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginArray();
    if (_stage) {
        const std::string needle = TfStringToLower(text);
        int found = 0;
        for (const UsdPrim& prim : _stage->TraverseAll()) {
            if (found >= limit) break;
            if (!typeName.empty() && prim.GetTypeName() != typeName) continue;
            if (!needle.empty() && TfStringToLower(prim.GetName().GetString()).find(needle) == std::string::npos) continue;
            w.WriteValue(prim.GetPath().GetString());
            found++;
        }
    }
    w.EndArray();
    return stream.str();
}

std::string Stage::ExportPrim(const std::string& path, const std::string& mode) const
{
    const UsdPrim prim = _stage ? _stage->GetPrimAtPath(SdfPath(path)) : UsdPrim();
    std::string text;
    if (!prim) return text;
    if (prim.IsPseudoRoot()) {
        _stage->ExportToString(&text, false);
        return text;
    }
    if (mode == "authored") {
        const SdfLayerHandle layer = _stage->GetEditTarget().GetLayer();
        if (!layer->GetPrimAtPath(prim.GetPath())) return text;
        const SdfLayerRefPtr out = SdfLayer::CreateAnonymous(".usda");
        SdfCreatePrimInLayer(out, prim.GetPath().GetParentPath());
        if (SdfCopySpec(layer, prim.GetPath(), out, prim.GetPath())) out->ExportToString(&text);
        return text;
    }
    // Composed: a throwaway stage with one prim referencing this subtree, flattened.
    const UsdStageRefPtr scratch = UsdStage::CreateInMemory();
    scratch->GetSessionLayer()->InsertSubLayerPath(_stage->GetSessionLayer()->GetIdentifier());
    UsdPrim holder = scratch->DefinePrim(SdfPath::AbsoluteRootPath().AppendChild(prim.GetName()));
    holder.GetReferences().AddReference(_stage->GetRootLayer()->GetIdentifier(), prim.GetPath());
    if (const SdfLayerRefPtr flat = scratch->Flatten(false)) flat->ExportToString(&text);
    return text;
}

std::string Stage::SetRefinement(const std::string& path, bool enabled, int level)
{
    return Edit(_stage, [&]() -> std::string {
        const UsdPrim prim = _stage->GetPrimAtPath(SdfPath(path));
        if (!prim || prim.IsInstanceProxy()) return "no editable prim at " + path;
        if (prim.HasAttribute(kRefineEnable)) {
            bool wasEnabled = false;
            int wasLevel = 0;
            prim.GetAttribute(kRefineEnable).Get(&wasEnabled);
            prim.GetAttribute(kRefineLevel).Get(&wasLevel);
            gPrevious = VtValue(VtDictionary({ { "enabled", VtValue(wasEnabled) }, { "level", VtValue(wasLevel) } }));
        }
        const bool ok = prim.CreateAttribute(kRefineEnable, SdfValueTypeNames->Bool, true).Set(enabled)
            && prim.CreateAttribute(kRefineLevel, SdfValueTypeNames->Int, true).Set(std::clamp(level, 0, 5));
        return ok ? "" : "could not author refinement on " + path;
    });
}

std::string Stage::ClearRefinement(const std::string& path)
{
    return Edit(_stage, [&]() -> std::string {
        UsdPrim prim = _stage->GetPrimAtPath(SdfPath(path));
        if (!prim || prim.IsInstanceProxy()) return "no editable prim at " + path;
        if (prim.HasAttribute(kRefineEnable)) {
            bool wasEnabled = false;
            int wasLevel = 0;
            prim.GetAttribute(kRefineEnable).Get(&wasEnabled);
            prim.GetAttribute(kRefineLevel).Get(&wasLevel);
            gPrevious = VtValue(VtDictionary({ { "enabled", VtValue(wasEnabled) }, { "level", VtValue(wasLevel) } }));
        }
        prim.RemoveProperty(kRefineEnable);
        prim.RemoveProperty(kRefineLevel);
        return "";
    });
}

std::string Stage::ClearRefinementOverrides()
{
    return Edit(_stage, [&]() -> std::string {
        for (UsdPrim prim : _stage->Traverse()) {
            if (!prim.HasAttribute(kRefineEnable) && !prim.HasAttribute(kRefineLevel)) continue;
            prim.RemoveProperty(kRefineEnable);
            prim.RemoveProperty(kRefineLevel);
        }
        return "";
    });
}

std::string Stage::Reload()
{
    return Edit(_stage, [&] {
        _stage->Reload();
        return std::string();
    });
}

std::string Stage::SetVariant(const std::string& path, const std::string& variantSet, const std::string& variant)
{
    return Edit(_stage, [&]() -> std::string {
        const UsdPrim prim = _stage->GetPrimAtPath(SdfPath(path));
        if (!prim) return "no prim at " + path;
        UsdVariantSet set = prim.GetVariantSet(variantSet);
        gPrevious = VtValue(set.GetVariantSelection());
        return (variant.empty() ? set.ClearVariantSelection() : set.SetVariantSelection(variant)) ? "" : "could not set variant";
    });
}

std::string Stage::SetVisible(const std::string& path, bool visible)
{
    return Edit(_stage, [&]() -> std::string {
        const UsdGeomImageable imageable(_stage->GetPrimAtPath(SdfPath(path)));
        if (!imageable) return path + " is not imageable";
        gPrevious = LayerOpinion(_stage, imageable.GetVisibilityAttr(), UsdTimeCode::Default());
        if (visible) imageable.MakeVisible();
        else imageable.MakeInvisible();
        return "";
    });
}

std::string Stage::SessionVisibility(const std::string& mode, const std::string& json)
{
    return Edit(_stage, [&]() -> std::string {
        JsParseError parseError;
        const JsValue js = JsParseString(json.empty() ? "null" : json, &parseError);
        if (!parseError.reason.empty()) return "invalid JSON: " + parseError.reason;
        const SdfLayerHandle layer = _stage->GetSessionLayer();

        // Target opinion per prim: "invisible" to hide, empty to clear.
        std::map<SdfPath, TfToken> targets;
        const auto selected = [&]() {
            std::vector<SdfPath> paths;
            if (!js.IsArray()) return paths;
            for (const JsValue& item : js.GetJsArray()) {
                if (!item.IsString()) continue;
                if (const UsdPrim prim = EditablePrim(_stage, item.GetString())) paths.push_back(prim.GetPath());
            }
            return paths;
        };
        if (mode == "hide") {
            for (const SdfPath& path : selected()) targets[path] = UsdGeomTokens->invisible;
        } else if (mode == "isolate") {
            // Hide the siblings along each selected prim's ancestor chain: every child of an
            // ancestor that is neither selected nor itself an ancestor of a selected prim.
            // Each ancestor is visited once, so this is linear in the children visited.
            std::unordered_set<SdfPath, SdfPath::Hash> kept, parents;
            for (const SdfPath& path : selected()) {
                kept.insert(path);
                for (SdfPath parent = path.GetParentPath(); !parent.IsEmpty() && parents.insert(parent).second; parent = parent.GetParentPath()) {}
            }
            for (const SdfPath& parent : parents) {
                for (const UsdPrim& child : _stage->GetPrimAtPath(parent).GetChildren()) {
                    const SdfPath& c = child.GetPath();
                    if (kept.count(c) || parents.count(c) || !child.IsA<UsdGeomImageable>()) continue;
                    targets[c] = UsdGeomTokens->invisible;
                }
            }
        } else if (mode == "showAll") {
            layer->Traverse(SdfPath::AbsoluteRootPath(), [&](const SdfPath& path) {
                if (path.IsPropertyPath() && path.GetNameToken() == UsdGeomTokens->visibility) targets[path.GetPrimPath()] = TfToken();
            });
        } else if (mode == "set") {
            if (!js.IsObject()) return "set needs an object of path -> \"invisible\" | null";
            for (const auto& [path, value] : js.GetJsObject()) {
                if (!SdfPath::IsValidPathString(path)) return "invalid path " + path;
                targets[SdfPath(path)] = value.IsString() ? TfToken(value.GetString()) : TfToken();
            }
        } else return "unknown mode " + mode;

        // Plain Sdf edits on the session layer: the edit target stays as it is.
        VtDictionary previous;
        SdfChangeBlock block;
        for (const auto& [path, token] : targets) {
            const SdfPath property = path.AppendProperty(UsdGeomTokens->visibility);
            SdfAttributeSpecHandle attribute = layer->GetAttributeAtPath(property);
            previous[path.GetString()] = attribute && attribute->HasDefaultValue() ? attribute->GetDefaultValue() : VtValue();
            if (token.IsEmpty()) {
                if (attribute) layer->GetPrimAtPath(path)->RemoveProperty(attribute);
                continue;
            }
            if (!attribute) {
                const SdfPrimSpecHandle prim = SdfCreatePrimInLayer(layer, path);
                if (!prim) return "could not author visibility on " + path.GetString();
                attribute = SdfAttributeSpec::New(prim, UsdGeomTokens->visibility, SdfValueTypeNames->Token);
                if (!attribute) return "could not author visibility on " + path.GetString();
            }
            attribute->SetDefaultValue(VtValue(token));
        }
        gPrevious = VtValue(previous);
        return "";
    }, /*track=*/false);
}

std::string Stage::RevertPrim(const std::string& path)
{
    return Edit(_stage, [&]() -> std::string {
        if (!SdfPath::IsValidPathString(path) || !SdfPath(path).IsPrimPath()) return "invalid prim path " + path;
        ChangeTracker::Stash stash { SdfPath(path), {} };
        SdfChangeBlock block;
        for (const auto& [layer, copy] : gTracker.snapshot) {
            SdfLayerRefPtr saved;
            if (layer->GetPrimAtPath(stash.path)) {
                saved = SdfLayer::CreateAnonymous("stash");
                ReplacePrimSpec(layer, saved, stash.path);
            }
            stash.layers.emplace_back(layer, saved);
            ReplacePrimSpec(copy, layer, stash.path);
        }
        const int id = gTracker.nextStash++;
        gTracker.stashes[id] = std::move(stash);
        gPrevious = VtValue(id);
        return "";
    });
}

std::string Stage::RestorePrim(int stash)
{
    return Edit(_stage, [&]() -> std::string {
        const auto found = gTracker.stashes.find(stash);
        if (found == gTracker.stashes.end()) return "nothing to restore";
        SdfChangeBlock block;
        for (const auto& [layer, saved] : found->second.layers) ReplacePrimSpec(saved, layer, found->second.path);
        return "";
    });
}

void Stage::ResetChanges()
{
    gTracker.Reset(_stage);
}

std::string Stage::SetLoaded(const std::string& path, bool loaded)
{
    // Load rules are stage state, not layer content: nothing to track (and no snapshot to take).
    return Edit(_stage, [&]() -> std::string {
        if (loaded) _stage->Load(SdfPath(path));
        else _stage->Unload(SdfPath(path));
        return "";
    }, /*track=*/false);
}

std::string Stage::SetAttribute(const std::string& path, const std::string& name, const std::string& json, double time)
{
    return Edit(_stage, [&]() -> std::string {
        const UsdPrim prim = _stage->GetPrimAtPath(SdfPath(path));
        const UsdAttribute attribute = prim ? prim.GetAttribute(TfToken(name)) : UsdAttribute();
        if (!attribute) return "no attribute " + name + " on " + path;
        JsParseError parseError;
        const JsValue js = JsParseString(json, &parseError);
        if (!parseError.reason.empty()) return "invalid JSON: " + parseError.reason;
        const VtValue value = FromJson(js, attribute.GetTypeName());
        if (value.IsEmpty()) return "unsupported value for type " + attribute.GetTypeName().GetAsToken().GetString();
        gPrevious = LayerOpinion(_stage, attribute, Time(time));
        return attribute.Set(value, Time(time)) ? "" : "could not set " + name;
    });
}

std::string Stage::ClearSessionEdits()
{
    return Edit(_stage, [&]() -> std::string {
        _stage->GetSessionLayer()->Clear();
        return "";
    });
}

namespace {

void WriteXformInfo(JsWriter& w, const UsdPrim& prim, UsdGeomXformCache& cache)
{
    bool resets = false;
    const GfMatrix4d local = cache.GetLocalTransformation(prim, &resets);
    w.BeginObject();
    w.WriteKey("path");
    w.WriteValue(prim.GetPath().GetString());
    w.WriteKey("local");
    Write(w, local);
    w.WriteKey("parent");
    Write(w, resets ? GfMatrix4d(1) : cache.GetParentToWorldTransform(prim));
    w.WriteKey("world");
    Write(w, cache.GetLocalToWorldTransform(prim));
    w.WriteKey("resets");
    w.WriteValue(resets);
    w.EndObject();
}

} // namespace

std::string Stage::XformInfo(const std::string& path, double time) const
{
    const UsdPrim prim = EditablePrim(_stage, path);
    if (!UsdGeomXformable(prim)) return "null";
    UsdGeomXformCache cache(Time(time));
    std::ostringstream stream;
    JsWriter w(stream);
    WriteXformInfo(w, prim, cache);
    return stream.str();
}

std::string Stage::XformInfos(const std::string& pathsJson, double time) const
{
    JsParseError parseError;
    const JsValue js = JsParseString(pathsJson, &parseError);
    UsdGeomXformCache cache(Time(time)); // one cache: the prims of a selection share their ancestors
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginArray();
    for (const JsValue& item : js.IsArray() ? js.GetJsArray() : JsArray()) {
        const UsdPrim prim = item.IsString() ? EditablePrim(_stage, item.GetString()) : UsdPrim();
        if (UsdGeomXformable(prim)) WriteXformInfo(w, prim, cache);
        else w.WriteValue(nullptr);
    }
    w.EndArray();
    return stream.str();
}

namespace {

/// Authors one prim's local matrix (see Stage::SetXform); `before` receives the old one. "" on success.
std::string SetOneXform(const UsdStageRefPtr& stage, const std::string& path, const GfMatrix4d& target, UsdTimeCode at, GfMatrix4d* before)
{
    const UsdPrim prim = EditablePrim(stage, path);
    const UsdGeomXformable xformable(prim);
    if (!xformable) return path + " is not xformable";
    bool resets = false;
    xformable.GetLocalTransformation(before, &resets, at);
    // Animated stacks get a sample at the current frame, static ones a default value.
    const UsdTimeCode when = !at.IsDefault() && xformable.TransformMightBeTimeVarying() ? at : UsdTimeCode::Default();
    std::vector<UsdGeomXformOp> ops = xformable.GetOrderedXformOps(&resets);
    if (ops.size() == 1 && ops[0].GetOpType() == UsdGeomXformOp::TypeTransform && !ops[0].IsInverseOp()) {
        return ops[0].Set(target, when) ? "" : "could not set " + ops[0].GetOpName().GetString();
    }
    if (SetCommonXform(xformable, target, at, when)) {
        GfMatrix4d after;
        xformable.GetLocalTransformation(&after, &resets, at);
        if (MatricesMatch(after, target)) return "";
    }
    // Anything else (single-axis rotates, shears, incompatible animation): a leading
    // xformOp:transform:edit carries the difference, so the existing ops keep working.
    static const TfToken suffix("edit"), name("xformOp:transform:edit");
    UsdGeomXformOp edit;
    for (const UsdGeomXformOp& op : ops) if (op.GetOpName() == name) edit = op;
    if (!edit) {
        edit = xformable.AddTransformOp(UsdGeomXformOp::PrecisionDouble, suffix);
        if (!edit) return "could not add an edit transform to " + path;
        ops = xformable.GetOrderedXformOps(&resets);
        std::rotate(ops.rbegin(), ops.rbegin() + 1, ops.rend()); // the new op goes first (applied last)
        xformable.SetXformOpOrder(ops, resets);
    }
    GfMatrix4d current(1), now;
    edit.Get(&current, at);
    xformable.GetLocalTransformation(&now, &resets, at);
    const GfMatrix4d rest = now * current.GetInverse(); // local = rest * edit
    return edit.Set(rest.GetInverse() * target, when) ? "" : "could not set the edit transform on " + path;
}

} // namespace

std::string Stage::SetXform(const std::string& path, const std::vector<double>& matrix, double time)
{
    return Edit(_stage, [&]() -> std::string {
        if (matrix.size() != 16) return "a transform needs 16 numbers";
        GfMatrix4d target, before;
        std::copy(matrix.begin(), matrix.end(), target.data());
        const std::string error = SetOneXform(_stage, path, target, Time(time), &before);
        if (error.empty()) gPrevious = VtValue(before);
        return error;
    });
}

std::string Stage::SetXforms(const std::string& entriesJson, double time)
{
    return Edit(_stage, [&]() -> std::string {
        JsParseError parseError;
        const JsValue js = JsParseString(entriesJson, &parseError);
        if (!parseError.reason.empty() || !js.IsArray()) return "setXforms needs an array of {path, matrix}: " + parseError.reason;
        // ponytail: one change notice per prim (no SdfChangeBlock: stage queries inside one are stale);
        // a failing entry stops the loop, earlier entries stay written.
        VtArray<GfMatrix4d> befores;
        for (const JsValue& entry : js.GetJsArray()) {
            if (!entry.IsObject()) return "setXforms: an entry is not an object";
            const JsObject& object = entry.GetJsObject();
            const auto path = object.find("path"), matrix = object.find("matrix");
            if (path == object.end() || !path->second.IsString() || matrix == object.end() || !matrix->second.IsArray()) {
                return "setXforms: an entry needs a path and a matrix";
            }
            const JsArray& numbers = matrix->second.GetJsArray();
            if (numbers.size() != 16) return "a transform needs 16 numbers";
            GfMatrix4d target, before;
            for (size_t i = 0; i < 16; i++) {
                if (!numbers[i].IsReal() && !numbers[i].IsInt()) return "a transform needs 16 numbers";
                target.data()[i] = numbers[i].GetReal();
            }
            const std::string error = SetOneXform(_stage, path->second.GetString(), target, Time(time), &before);
            if (!error.empty()) return error;
            befores.push_back(before);
        }
        gPrevious = VtValue(befores);
        return "";
    });
}

std::string Stage::ClearAttribute(const std::string& path, const std::string& name, double time)
{
    return Edit(_stage, [&]() -> std::string {
        const UsdPrim prim = EditablePrim(_stage, path);
        const UsdAttribute attribute = prim ? prim.GetAttribute(TfToken(name)) : UsdAttribute();
        if (!attribute) return "no attribute " + name + " on " + path;
        const UsdTimeCode at = Time(time);
        gPrevious = LayerOpinion(_stage, attribute, at);
        return (at.IsDefault() ? attribute.ClearDefault() : attribute.ClearAtTime(at)) ? "" : "could not clear " + name;
    });
}

std::string Stage::ListLayers() const
{
    std::ostringstream stream;
    JsWriter w(stream);
    w.BeginArray();
    if (_stage) {
        const SdfLayerHandleVector stack = _stage->GetLayerStack(true);
        const SdfLayerHandle target = _stage->GetEditTarget().GetLayer();
        SdfLayerHandleVector layers = stack; // local stack first, strongest first, then the rest
        for (const SdfLayerHandle& layer : _stage->GetUsedLayers()) {
            if (std::find(stack.begin(), stack.end(), layer) == stack.end()) layers.push_back(layer);
        }
        for (const SdfLayerHandle& layer : layers) {
            w.BeginObject();
            w.WriteKey("identifier");
            w.WriteValue(layer->GetIdentifier());
            w.WriteKey("displayName");
            w.WriteValue(layer->GetDisplayName());
            w.WriteKey("format");
            // .usd files wrap usda or usdc; report what is inside so a save keeps the encoding.
            const SdfFileFormatConstPtr format = layer->GetFileFormat();
            const TfToken underlying = format->GetFormatId() == SdfUsdFileFormatTokens->Id ? SdfUsdFileFormat::GetUnderlyingFormatForLayer(*layer) : format->GetFormatId();
            w.WriteValue(underlying.GetString());
            w.WriteKey("anonymous");
            w.WriteValue(layer->IsAnonymous());
            w.WriteKey("dirty");
            w.WriteValue(layer->IsDirty());
            w.WriteKey("inStack");
            w.WriteValue(std::find(stack.begin(), stack.end(), layer) != stack.end());
            w.WriteKey("editTarget");
            w.WriteValue(layer == target);
            w.WriteKey("session");
            w.WriteValue(layer == _stage->GetSessionLayer());
            w.EndObject();
        }
    }
    w.EndArray();
    return stream.str();
}

bool Stage::ExportLayer(const std::string& identifier, const std::string& format, std::string* bytes) const
{
    if (!_stage) return false;
    if (format == "flat") return _stage->ExportToString(bytes, false);
    const SdfLayerHandle layer = SdfLayer::Find(identifier);
    if (!layer) return false;
    if (format == "usda") return layer->ExportToString(bytes);
    // Binary goes through a scratch file in the module's memory filesystem.
    static const std::string scratch = "/tmp/__export.usdc";
    if (!layer->Export(scratch)) return false;
    std::ifstream file(scratch, std::ios::binary);
    bytes->assign(std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>());
    std::remove(scratch.c_str());
    return true;
}

std::string Stage::SetEditTarget(const std::string& identifier)
{
    return Edit(_stage, [&]() -> std::string {
        for (const SdfLayerHandle& layer : _stage->GetLayerStack(true)) {
            if (layer->GetIdentifier() != identifier) continue;
            _stage->SetEditTarget(UsdEditTarget(layer));
            return "";
        }
        return identifier + " is not in the stage's local layer stack";
    }, /*track=*/false); // authors nothing
}

std::string Stage::ReloadLayers(const std::vector<std::string>& identifiers)
{
    return Edit(_stage, [&]() -> std::string {
        std::set<SdfLayerHandle> layers;
        if (identifiers.empty()) {
            for (const SdfLayerHandle& layer : _stage->GetUsedLayers()) if (!layer->IsAnonymous()) layers.insert(layer);
        } else {
            for (const std::string& identifier : identifiers) if (const SdfLayerHandle layer = SdfLayer::Find(identifier)) layers.insert(layer);
        }
        for (const SdfLayerHandle& layer : layers) WebResolver::Forget(layer->GetIdentifier());
        SdfLayer::ReloadLayers(layers, true);
        return "";
    }, /*track=*/false); // the page resets the change baseline after a reload; a save reloads what it wrote
}
