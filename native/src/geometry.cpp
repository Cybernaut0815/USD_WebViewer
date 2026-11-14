#include "geometry.h"

#include "pxr/imaging/pxOsd/meshTopology.h"
#include "pxr/imaging/pxOsd/refinerFactory.h"
#include "pxr/imaging/pxOsd/tokens.h"

#include <opensubdiv/far/primvarRefiner.h>
#include <opensubdiv/far/topologyRefiner.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace {

using namespace OpenSubdiv;

const TfToken kConstant("constant"), kUniform("uniform"), kVarying("varying"), kVertex("vertex"),
    kFaceVarying("faceVarying"), kNormals("normals");

/// Read-only elements in place: an authored VtArray's, or a vector's the refinement filled.
template <class T>
struct View {
    const T* p = nullptr;
    size_t n = 0;
    View() = default;
    View(const T* data, size_t size) : p(data), n(size) {}
    explicit View(const std::vector<T>& v) : p(v.data()), n(v.size()) {}
    const T& operator[](size_t i) const { return p[i]; }
    size_t size() const { return n; }
    const T* data() const { return p; }
    const T* begin() const { return p; }
    const T* end() const { return p + n; }
};

/// A polygon mesh ready for triangulation: the authored mesh, read in place (a 13 M point mesh is
/// hundreds of MB per copy), or its refinement, held in the `own` vectors.
struct Poly {
    View<int> counts, indices; // faces
    View<float> points;        // xyz per vertex
    std::vector<int> baseFaces; // authored face of each face; empty: the face itself
    std::vector<bool> hole;
    std::vector<float> vertexNormals; // xyz per vertex, empty: none
    std::vector<int> ownCounts, ownIndices;
    std::vector<float> ownPoints;
    /// uniform primvars stay indexed by authored face; the others follow this mesh. The authored
    /// primvars are read in place; refinement fills `refined` and points at that instead.
    const std::vector<PrimvarIn>* primvars = nullptr;
    std::vector<PrimvarIn> refined;
    bool flip = false; // left-handed winding still to be corrected
    int baseFace(size_t f) const { return baseFaces.empty() ? int(f) : baseFaces[f]; }
};

/// View of a float buffer as elements of `n` floats, in the shape OpenSubdiv's
/// PrimvarRefiner wants (Clear / AddWithWeight on each element).
struct Span {
    float* p;
    int n;
    struct Item {
        float* p;
        int n;
        void Clear() { std::fill(p, p + n, 0.0f); }
        void AddWithWeight(const Item& s, float w)
        {
            for (int i = 0; i < n; i++) p[i] += w * s.p[i];
        }
    };
    Item operator[](int i) const { return { p + size_t(i) * n, n }; }
};

void MakePoly(const MeshIn& in, Poly* poly)
{
    poly->counts = View<int>(in.faceVertexCounts.cdata(), in.faceVertexCounts.size());
    poly->indices = View<int>(in.faceVertexIndices.cdata(), in.faceVertexIndices.size());
    poly->hole.assign(poly->counts.size(), false);
    for (int f : in.holeIndices) {
        if (f >= 0 && size_t(f) < poly->hole.size()) poly->hole[f] = true;
    }
    poly->points = View<float>(in.points.cdata()->data(), in.points.size() * 3);
    poly->primvars = &in.primvars;
    poly->flip = in.orientation == PxOsdOpenSubdivTokens->leftHanded;
}

/// Uniform OpenSubdiv refinement to `in.refineLevel`, with limit positions and normals.
bool Refine(const MeshIn& in, Poly* poly)
{
    // OpenSubdiv's loop refinement asserts on non-triangles; pxOsd only warns.
    if (in.scheme == PxOsdOpenSubdivTokens->loop
        && std::any_of(in.faceVertexCounts.cbegin(), in.faceVertexCounts.cend(), [](int n) { return n != 3; })) {
        return false;
    }
    const PxOsdMeshTopology topology(in.scheme, in.orientation, in.faceVertexCounts, in.faceVertexIndices,
        in.holeIndices, in.tags);
    std::vector<const PrimvarIn*> faceVarying;
    std::vector<VtIntArray> fvarTopologies;
    for (const PrimvarIn& pv : in.primvars) {
        if (pv.interpolation == kFaceVarying && pv.indices.size() == in.faceVertexIndices.size()) {
            faceVarying.push_back(&pv);
            fvarTopologies.push_back(pv.indices);
        }
    }
    const PxOsdTopologyRefinerSharedPtr refiner = PxOsdRefinerFactory::Create(topology, fvarTopologies);
    if (!refiner) return false;
    const int coarseVertices = refiner->GetLevel(0).GetNumVertices();
    if (int(in.points.size()) < coarseVertices) return false;

    Far::TopologyRefiner::UniformOptions options(in.refineLevel);
    options.fullTopologyInLastLevel = true;
    refiner->RefineUniform(options);
    const int level = refiner->GetMaxLevel();
    const Far::TopologyLevel& last = refiner->GetLevel(level);
    const Far::PrimvarRefiner primvarRefiner(*refiner);

    // Carries per-vertex data from the coarse mesh to the last level.
    const auto refineVertices = [&](const float* source, int size, bool varying) {
        std::vector<float> from(source, source + size_t(coarseVertices) * size), to;
        for (int l = 1; l <= level; l++) {
            to.assign(size_t(refiner->GetLevel(l).GetNumVertices()) * size, 0.0f);
            Span src { from.data(), size }, dst { to.data(), size };
            if (varying) primvarRefiner.InterpolateVarying(l, src, dst);
            else primvarRefiner.Interpolate(l, src, dst);
            from.swap(to);
        }
        return from;
    };

    const int vertices = last.GetNumVertices();
    std::vector<float> refined = refineVertices(in.points.cdata()->data(), 3, false);
    poly->ownPoints.assign(size_t(vertices) * 3, 0.0f);
    poly->vertexNormals.assign(size_t(vertices) * 3, 0.0f);
    std::vector<float> du(size_t(vertices) * 3), dv(size_t(vertices) * 3);
    {
        Span src { refined.data(), 3 }, position { poly->ownPoints.data(), 3 }, t1 { du.data(), 3 }, t2 { dv.data(), 3 };
        primvarRefiner.Limit(src, position, t1, t2);
    }
    poly->points = View<float>(poly->ownPoints);
    for (int v = 0; v < vertices; v++) {
        const float* a = &du[size_t(v) * 3];
        const float* b = &dv[size_t(v) * 3];
        float n[3] = { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
        const float length = std::sqrt(n[0] * n[0] + n[1] * n[1] + n[2] * n[2]);
        for (int k = 0; k < 3; k++) poly->vertexNormals[size_t(v) * 3 + k] = length > 0 ? n[k] / length : 0.0f;
    }

    // Faces of the last level, and the authored face each one descends from.
    for (int f = 0; f < last.GetNumFaces(); f++) {
        const Far::ConstIndexArray faceVertices = last.GetFaceVertices(f);
        poly->ownCounts.push_back(faceVertices.size());
        for (int i = 0; i < faceVertices.size(); i++) poly->ownIndices.push_back(faceVertices[i]);
        poly->hole.push_back(last.IsFaceHole(f));
        int base = f;
        for (int l = level; l > 0; l--) base = refiner->GetLevel(l).GetFaceParentFace(base);
        poly->baseFaces.push_back(base);
    }
    poly->counts = View<int>(poly->ownCounts);
    poly->indices = View<int>(poly->ownIndices);

    for (const PrimvarIn& pv : in.primvars) {
        if (pv.name == kNormals) continue; // authored normals do not apply to subdivision surfaces
        PrimvarIn out;
        out.name = pv.name;
        out.size = pv.size;
        out.interpolation = pv.interpolation;
        if (pv.interpolation == kVertex || pv.interpolation == kVarying) {
            if (pv.values.size() < size_t(coarseVertices) * pv.size) continue;
            out.values = refineVertices(pv.values.data(), pv.size, pv.interpolation == kVarying);
            out.interpolation = kVertex;
        } else if (pv.interpolation == kFaceVarying) {
            const auto found = std::find(faceVarying.begin(), faceVarying.end(), &pv);
            if (found == faceVarying.end()) continue;
            const int channel = int(found - faceVarying.begin());
            const int coarseValues = refiner->GetLevel(0).GetNumFVarValues(channel);
            if (pv.values.size() < size_t(coarseValues) * pv.size) continue;
            std::vector<float> from(pv.values.begin(), pv.values.begin() + size_t(coarseValues) * pv.size), to;
            for (int l = 1; l <= level; l++) {
                to.assign(size_t(refiner->GetLevel(l).GetNumFVarValues(channel)) * pv.size, 0.0f);
                Span src { from.data(), pv.size }, dst { to.data(), pv.size };
                primvarRefiner.InterpolateFaceVarying(l, src, dst, channel);
                from.swap(to);
            }
            out.values.swap(from);
            VtIntArray indices;
            indices.reserve(poly->indices.size());
            for (int f = 0; f < last.GetNumFaces(); f++) {
                const Far::ConstIndexArray values = last.GetFaceFVarValues(f, channel);
                for (int i = 0; i < values.size(); i++) indices.push_back(values[i]);
            }
            out.indices = indices;
        } else {
            out.values = pv.values; // uniform: looked up through baseFace
        }
        poly->refined.push_back(std::move(out));
    }
    poly->primvars = &poly->refined;
    return true;
}

uint64_t EdgeKey(int a, int b)
{
    return (uint64_t(uint32_t(std::min(a, b))) << 32) | uint32_t(std::max(a, b));
}

void Normalize(std::vector<float>& normals)
{
    for (size_t i = 0; i + 2 < normals.size(); i += 3) {
        const float length = std::sqrt(normals[i] * normals[i] + normals[i + 1] * normals[i + 1] + normals[i + 2] * normals[i + 2]);
        if (length > 0) {
            normals[i] /= length;
            normals[i + 1] /= length;
            normals[i + 2] /= length;
        }
    }
}

/// Adds the area-weighted normal of triangle (a, b, c) to each of its vertices.
void AccumulateNormal(const float* points, const size_t m[3], std::vector<float>& smooth)
{
    const float* a = &points[m[0] * 3];
    const float* b = &points[m[1] * 3];
    const float* c = &points[m[2] * 3];
    const float u[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] };
    const float v[3] = { c[0] - a[0], c[1] - a[1], c[2] - a[2] };
    const float n[3] = { u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0] };
    for (int k = 0; k < 3; k++) {
        for (int axis = 0; axis < 3; axis++) smooth[m[k] * 3 + axis] += n[axis];
    }
}

uint32_t Bits(float f)
{
    uint32_t u;
    std::memcpy(&u, &f, 4);
    return u;
}

uint32_t HashRow(const uint32_t* row, size_t words)
{
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < words; i++) {
        h = (h ^ row[i]) * 16777619u;
        h ^= h >> 15;
    }
    return h;
}

/// How the output vertices relate to the mesh. Corners are welded when their mesh vertex and
/// every per-corner value agree, so seams split vertices and the rest stays shared.
struct Layout {
    std::vector<uint32_t> weld;         // output vertex -> mesh vertex; empty: the mesh vertices themselves
    std::vector<uint32_t> cornerVertex; // corner -> output vertex; empty: through pointVertex, or poly.indices
    std::vector<uint32_t> pointVertex;  // mesh vertex -> output vertex when coincident points share one (no seams)
    std::vector<uint32_t> rep;          // output vertex -> one corner that uses it (welded only)
    size_t vertices = 0;
    uint32_t at(size_t corner, const Poly& poly) const
    {
        if (!cornerVertex.empty()) return cornerVertex[corner];
        return pointVertex.empty() ? uint32_t(poly.indices[corner]) : pointVertex[size_t(poly.indices[corner])];
    }
    size_t meshVertex(uint32_t out) const { return weld.empty() ? out : weld[out]; }
};

/// Welds the corners by (mesh vertex, per-corner values): the bits of each faceVarying or uniform
/// channel's value at the corner, so equal values weld whether the primvar is indexed or written
/// out per corner, and seams (different values) split. With `canon` (WeldPoints) a corner's mesh
/// vertex is the first of its coincident points.
/// Most corners repeat the elements (primvar indices, face for uniform) of their vertex's first corner:
/// those take its output vertex at once. Only the others are hashed, in an open-addressing table of output
/// vertices kept at most half full, which gets a vertex's first row before its first hashed corner, so the
/// result is the one hashing every corner would give. Rows are rebuilt from their corner when compared.
void Weld(const Poly& poly, const std::vector<const PrimvarIn*>& perCorner, const std::vector<int>& cornerFace,
    const std::vector<uint32_t>& canon, Layout* layout)
{
    const size_t corners = poly.indices.size(), points = poly.points.size() / 3;
    size_t words = 1;
    for (const PrimvarIn* pv : perCorner) words += size_t(pv->size);
    const auto element = [&](const PrimvarIn* pv, size_t corner) {
        return pv->interpolation == kFaceVarying ? pv->indices[corner] : poly.baseFace(size_t(cornerFace[corner]));
    };
    const auto fill = [&](size_t corner, uint32_t* row) {
        const int vertex = poly.indices[corner];
        row[0] = !canon.empty() && vertex >= 0 && size_t(vertex) < canon.size() ? canon[size_t(vertex)] : uint32_t(vertex);
        size_t w = 1;
        for (const PrimvarIn* pv : perCorner) {
            const size_t count = pv->values.size() / pv->size;
            const int e = element(pv, corner);
            for (int k = 0; k < pv->size; k++) row[w++] = e >= 0 && size_t(e) < count ? Bits(pv->values[size_t(e) * pv->size + k]) : 0;
        }
    };
    std::vector<uint32_t> row(words), other(words);
    size_t capacity = 1024, used = 0;
    std::vector<uint32_t> table(capacity, UINT32_MAX); // the output vertex whose row owns the slot
    const auto insert = [&](uint32_t vertex, const uint32_t* r) {
        size_t slot = HashRow(r, words) & (capacity - 1);
        while (table[slot] != UINT32_MAX) slot = (slot + 1) & (capacity - 1);
        table[slot] = vertex;
        if (++used * 2 <= capacity) return;
        std::vector<uint32_t> old(capacity * 2, UINT32_MAX);
        old.swap(table);
        capacity <<= 1;
        for (const uint32_t o : old) {
            if (o == UINT32_MAX) continue;
            fill(layout->rep[o], other.data());
            size_t s = HashRow(other.data(), words) & (capacity - 1);
            while (table[s] != UINT32_MAX) s = (s + 1) & (capacity - 1);
            table[s] = o;
        }
    };
    const auto added = [&](size_t corner, uint32_t key) {
        const uint32_t o = uint32_t(layout->weld.size());
        layout->cornerVertex[corner] = o;
        layout->weld.push_back(key);
        layout->rep.push_back(uint32_t(corner));
        return o;
    };
    const size_t channels = perCorner.size();
    std::vector<uint32_t> first(points, UINT32_MAX); // mesh vertex -> output vertex of its first corner
    std::vector<int> firstElements(points * channels); // and that corner's elements, read where the vertex is
    std::vector<uint8_t> hashed(points, 0);          // that output vertex is in the table
    layout->cornerVertex.assign(corners, 0);
    for (size_t corner = 0; corner < corners; corner++) {
        const int vertex = poly.indices[corner];
        const bool valid = vertex >= 0 && size_t(vertex) < points;
        if (valid) {
            const uint32_t key = canon.empty() ? uint32_t(vertex) : canon[size_t(vertex)];
            int* elements = &firstElements[size_t(key) * channels];
            if (first[key] == UINT32_MAX) {
                first[key] = added(corner, key);
                for (size_t c = 0; c < channels; c++) elements[c] = element(perCorner[c], corner);
                continue;
            }
            bool same = true;
            for (size_t c = 0; same && c < channels; c++) same = element(perCorner[c], corner) == elements[c];
            if (same) {
                layout->cornerVertex[corner] = first[key];
                continue;
            }
            if (!hashed[key]) { // a seam here: the first row joins the table, so equal values still weld to it
                hashed[key] = 1;
                fill(layout->rep[first[key]], other.data());
                insert(first[key], other.data());
            }
        }
        fill(corner, row.data());
        for (size_t slot = HashRow(row.data(), words) & (capacity - 1);; slot = (slot + 1) & (capacity - 1)) {
            const uint32_t owner = table[slot];
            if (owner == UINT32_MAX) {
                insert(added(corner, row[0]), row.data());
                break;
            }
            fill(layout->rep[owner], other.data());
            if (row == other) {
                layout->cornerVertex[corner] = owner;
                break;
            }
        }
    }
    layout->vertices = layout->weld.size();
}

// ponytail: calibration knobs of FlatNormals. A face agrees within 30 degrees (either sign: a flipped normal
// draws the same double-sided), and up to 1% of the area may disagree (slivers, export noise).
constexpr double kFlatCos2 = 0.75;
constexpr double kFlatShare = 0.01;

/// True when a polygonal mesh's normals only restate its faces: one value per face (uniform, or faceVarying
/// constant over each face) parallel to the face itself. Flat shading draws them the same, without splitting
/// every face into its own vertices. The normal of a face is the sum of its fan's cross products.
bool FlatNormals(const Poly& poly, const std::vector<uint8_t>& drawn, const PrimvarIn& normals)
{
    const bool uniform = normals.interpolation == kUniform;
    if (normals.size != 3 || (!uniform && normals.interpolation != kFaceVarying)) return false;
    const size_t corners = poly.indices.size(), count = normals.values.size() / 3;
    if (!uniform && normals.indices.size() != corners) return false;
    double total = 0, disagreeing = 0;
    size_t offset = 0;
    for (size_t f = 0; f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break;
        if (drawn[f]) {
            const int element = uniform ? poly.baseFace(f) : normals.indices[offset];
            if (element < 0 || size_t(element) >= count) return false;
            const float* value = &normals.values[size_t(element) * 3];
            for (int i = 1; !uniform && i < n; i++) {
                const int other = normals.indices[offset + i];
                if (other == element) continue;
                if (other < 0 || size_t(other) >= count || !std::equal(value, value + 3, &normals.values[size_t(other) * 3])) return false;
            }
            const float* p0 = &poly.points[size_t(poly.indices[offset]) * 3];
            double g[3] = { 0, 0, 0 };
            for (int i = 1; i + 1 < n; i++) {
                const float* p1 = &poly.points[size_t(poly.indices[offset + i]) * 3];
                const float* p2 = &poly.points[size_t(poly.indices[offset + i + 1]) * 3];
                const double a[3] = { p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2] };
                const double b[3] = { p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2] };
                g[0] += a[1] * b[2] - a[2] * b[1];
                g[1] += a[2] * b[0] - a[0] * b[2];
                g[2] += a[0] * b[1] - a[1] * b[0];
            }
            const double gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
            const double nn = double(value[0]) * value[0] + double(value[1]) * value[1] + double(value[2]) * value[2];
            const double gn = g[0] * value[0] + g[1] * value[1] + g[2] * value[2];
            if (gg > 0 && nn > 0) {
                const double area = std::sqrt(gg);
                total += area;
                if (gn * gn < kFlatCos2 * gg * nn) disagreeing += area;
            }
        }
        offset += n;
    }
    return total > 0 && disagreeing <= kFlatShare * total;
}

/// Coincident points: canon[v] is the first point whose position and per-point values (`perPoint`, the
/// vertex and varying primvars that are sent) are bitwise equal to v's, so canon[v] <= v. Empty when no
/// two points coincide. One open-addressing table of point ids; rows are compared straight from the arrays.
std::vector<uint32_t> WeldPoints(const Poly& poly, const std::vector<const PrimvarIn*>& perPoint)
{
    const size_t vertices = poly.points.size() / 3;
    size_t words = 3;
    for (const PrimvarIn* pv : perPoint) words += size_t(pv->size);
    std::vector<uint32_t> row(words), other(words);
    const auto fill = [&](size_t v, uint32_t* to) {
        std::memcpy(to, &poly.points[v * 3], 3 * sizeof(float));
        size_t w = 3;
        for (const PrimvarIn* pv : perPoint) {
            std::memcpy(to + w, &pv->values[v * size_t(pv->size)], size_t(pv->size) * sizeof(float));
            w += size_t(pv->size);
        }
    };
    size_t capacity = 16, used = 0;
    while (capacity < vertices) capacity <<= 1; // doubled whenever more than half full
    std::vector<uint32_t> table(capacity, UINT32_MAX), canon(vertices);
    bool merged = false;
    for (size_t v = 0; v < vertices; v++) {
        fill(v, row.data());
        for (size_t slot = HashRow(row.data(), words) & (capacity - 1);; slot = (slot + 1) & (capacity - 1)) {
            const uint32_t owner = table[slot];
            if (owner == UINT32_MAX) {
                table[slot] = uint32_t(v);
                canon[v] = uint32_t(v);
                used++;
                break;
            }
            fill(owner, other.data());
            if (row == other) {
                canon[v] = owner;
                merged = true;
                break;
            }
        }
        if (used * 2 > capacity) {
            std::vector<uint32_t> old(capacity * 2, UINT32_MAX);
            old.swap(table);
            capacity <<= 1;
            for (const uint32_t owner : old) {
                if (owner == UINT32_MAX) continue;
                fill(owner, other.data());
                size_t slot = HashRow(other.data(), words) & (capacity - 1);
                while (table[slot] != UINT32_MAX) slot = (slot + 1) & (capacity - 1);
                table[slot] = owner;
            }
        }
    }
    if (!merged) canon.clear();
    return canon;
}

} // namespace

MeshOut BuildMesh(MeshIn& in)
{
    MeshOut out;
    if (in.points.empty()) return out;
    Poly poly;
    const bool subdivision = in.scheme == PxOsdOpenSubdivTokens->catmullClark || in.scheme == PxOsdOpenSubdivTokens->loop;
    out.refined = subdivision && in.refineLevel > 0 && Refine(in, &poly);
    if (!out.refined) {
        poly = Poly();
        MakePoly(in, &poly);
    }
    const bool polygonal = in.scheme == PxOsdOpenSubdivTokens->none;
    const int vertices = int(poly.points.size() / 3);
    const size_t corners = poly.indices.size();
    const std::vector<PrimvarIn>& primvars = *poly.primvars;

    // Faces with fewer than three corners, holes and faces with indices out of range are not drawn.
    std::vector<uint8_t> drawn(poly.counts.size(), 0);
    size_t triangles = 0;
    size_t offset = 0;
    for (size_t f = 0; f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break; // malformed topology
        bool valid = n >= 3 && !poly.hole[f];
        for (int i = 0; i < n; i++) {
            const int v = poly.indices[offset + i];
            if (v < 0 || v >= vertices) valid = false;
        }
        if (valid) {
            drawn[f] = 1;
            triangles += size_t(n) - 2;
            out.drawnFaces++;
        }
        offset += n;
    }

    // Subdivision surfaces ignore authored normals. A static polygonal mesh ignores normals that only restate
    // its faces: flat shading draws them the same, and they would split every face into vertices of its own.
    const PrimvarIn* normals = nullptr;
    for (const PrimvarIn& pv : primvars) {
        if (pv.name == kNormals) normals = &pv;
    }
    const bool skipNormals = !polygonal || (in.staticPoints && normals && FlatNormals(poly, drawn, *normals));
    if (skipNormals && normals && poly.primvars == &in.primvars) { // freed before the outputs are allocated
        in.primvars.erase(in.primvars.begin() + (normals - in.primvars.data()));
        normals = nullptr;
    }

    // Primvars that vary per face or per face-vertex split the output vertices where their
    // values differ (a faceVarying primvar whose indices do not match the corners is not sent).
    // Per-point primvars (the ones sent) take part in welding coincident points.
    std::vector<const PrimvarIn*> perCorner, perPoint;
    bool uniform = false, faceVaryingNormals = false;
    for (const PrimvarIn& pv : primvars) {
        if (pv.name == kNormals && skipNormals) continue;
        if (pv.interpolation == kVertex || pv.interpolation == kVarying) {
            if (pv.values.size() >= size_t(vertices) * pv.size) perPoint.push_back(&pv);
            continue;
        }
        if (pv.interpolation == kFaceVarying && pv.indices.size() == corners) perCorner.push_back(&pv);
        else if (pv.interpolation == kUniform) perCorner.push_back(&pv);
        else continue;
        uniform = uniform || pv.interpolation == kUniform;
        faceVaryingNormals = faceVaryingNormals || (pv.name == kNormals && pv.interpolation == kFaceVarying);
    }

    // The authored face of each corner is only needed to look up uniform primvars.
    std::vector<int> cornerFace(uniform ? corners : 0, 0);
    offset = 0;
    for (size_t f = 0; uniform && f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break;
        std::fill_n(cornerFace.begin() + offset, n, int(f));
        offset += n;
    }

    // Face edges bucketed by their smaller vertex: a counting sort (two passes and one allocation; the meshes are built
    // in parallel), then each bucket, a handful of records on ordinary meshes, sorted by the other vertex. An edge met
    // twice from the same authored face lies inside it (refinement): not drawn. The buckets take 4 (count only) to 16
    // (line pairs) bytes per corner: counting needs no layout and runs before the welds, line pairs after them, and
    // both before the triangles, so no two of these large allocations coexist.
    Layout layout;
    const auto faceEdges = [&] {
        struct EdgeRec {
            uint32_t other; // the larger vertex
            uint32_t a, b;  // in the layout of `indices`
            int base;
        };
        std::vector<uint32_t> start(size_t(vertices) + 2, 0); // start[v + 2] counts, then start[v + 1] places, then [start[v], start[v + 1]) is bucket v
        offset = 0;
        for (size_t f = 0; f < poly.counts.size(); f++) {
            const int n = poly.counts[f];
            if (n < 0 || offset + n > corners) break;
            for (int i = 0; drawn[f] && i < n; i++) start[size_t(std::min(poly.indices[offset + i], poly.indices[offset + (i + 1) % n])) + 2]++;
            offset += n;
        }
        for (size_t i = 1; i < start.size(); i++) start[i] += start[i - 1];
        if (in.edges) {
            std::vector<EdgeRec> records(start.back());
            offset = 0;
            for (size_t f = 0; f < poly.counts.size(); f++) {
                const int n = poly.counts[f];
                if (n < 0 || offset + n > corners) break;
                if (drawn[f]) {
                    for (int i = 0; i < n; i++) {
                        const size_t c0 = offset + i, c1 = offset + (i + 1) % n;
                        const int v0 = poly.indices[c0], v1 = poly.indices[c1];
                        records[start[size_t(std::min(v0, v1)) + 1]++] = { uint32_t(std::max(v0, v1)), layout.at(c0, poly), layout.at(c1, poly), poly.baseFace(f) };
                    }
                }
                offset += n;
            }
            // Each record group of one edge: counted once, drawn unless all of it lies inside one authored face.
            const auto edgesOf = [&](int v, auto&& visit) {
                const size_t lo = start[v], hi = start[v + 1];
                for (size_t i = lo; i < hi;) {
                    size_t j = i + 1;
                    bool draw = true;
                    for (; j < hi && records[j].other == records[i].other; j++) draw &= records[j].base != records[i].base;
                    visit(records[i], draw);
                    i = j;
                }
            };
            size_t drawnEdges = 0;
            for (int v = 0; v < vertices; v++) {
                const size_t lo = start[v], hi = start[v + 1];
                if (hi - lo > 1) std::sort(records.begin() + lo, records.begin() + hi, [](const EdgeRec& x, const EdgeRec& y) { return x.other < y.other; });
                edgesOf(v, [&](const EdgeRec&, bool draw) {
                    out.distinctEdges++;
                    drawnEdges += draw;
                });
            }
            out.edges.reserve(drawnEdges * 2);
            for (int v = 0; v < vertices; v++) {
                edgesOf(v, [&](const EdgeRec& edge, bool draw) {
                    if (!draw) return;
                    out.edges.push_back(edge.a);
                    out.edges.push_back(edge.b);
                });
            }
        } else if (!out.refined) {
            // Only the stats' count: the larger vertex of each face edge, bucketed by the smaller one (4 bytes per
            // corner instead of a 16-byte record). A refined mesh is counted on its cage (CountMesh).
            std::vector<uint32_t> others(start.back());
            offset = 0;
            for (size_t f = 0; f < poly.counts.size(); f++) {
                const int n = poly.counts[f];
                if (n < 0 || offset + n > corners) break;
                for (int i = 0; drawn[f] && i < n; i++) {
                    const int v0 = poly.indices[offset + i], v1 = poly.indices[offset + (i + 1) % n];
                    others[start[size_t(std::min(v0, v1)) + 1]++] = uint32_t(std::max(v0, v1));
                }
                offset += n;
            }
            for (int v = 0; v < vertices; v++) {
                const auto lo = others.begin() + start[v], hi = others.begin() + start[v + 1];
                std::sort(lo, hi);
                out.distinctEdges += size_t(std::unique(lo, hi) - lo);
            }
        }
    };
    if (!in.edges) faceEdges();

    // Coincident points of a static polygonal mesh (CAD exports repeat them per face group) draw as one vertex.
    const std::vector<uint32_t> canon = polygonal && in.staticPoints ? WeldPoints(poly, perPoint) : std::vector<uint32_t>();

    if (!perCorner.empty()) Weld(poly, perCorner, cornerFace, canon, &layout);
    else if (!canon.empty()) {
        layout.pointVertex.resize(size_t(vertices));
        for (int v = 0; v < vertices; v++) {
            if (canon[v] == uint32_t(v)) {
                layout.pointVertex[v] = uint32_t(layout.weld.size());
                layout.weld.push_back(uint32_t(v));
            } else layout.pointVertex[v] = layout.pointVertex[canon[v]];
        }
        layout.vertices = layout.weld.size();
    } else layout.vertices = size_t(vertices);
    const size_t outVertices = layout.vertices;

    out.flipped = poly.flip;
    if (in.edges) faceEdges();

    // Fan triangulation.
    out.indices.reserve(triangles * 3);
    if (out.refined) out.triangleFace.reserve(triangles); // unrefined: trianglePoly is the authored face
    out.trianglePoly.reserve(triangles);
    offset = 0;
    for (size_t f = 0; f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break;
        for (int i = 1; drawn[f] && i + 1 < n; i++) {
            size_t a = offset, b = offset + i, c = offset + i + 1;
            if (poly.flip) std::swap(b, c);
            for (size_t corner : { a, b, c }) out.indices.push_back(layout.at(corner, poly));
            if (out.refined) out.triangleFace.push_back(poly.baseFace(f));
            out.trianglePoly.push_back(int(f));
        }
        offset += n;
    }

    // The corner map (4 bytes per corner) is read below only to keep it for faceVarying normals or to find the
    // vertex of welded points at seams; otherwise it goes before the per-vertex streams are allocated. No layout.at()
    // after this point.
    if (!faceVaryingNormals && (canon.empty() || !layout.pointVertex.empty())) std::vector<uint32_t>().swap(layout.cornerVertex);
    // Per-vertex data in the output layout: each output vertex copies its mesh vertex.
    const auto gather = [&](const float* perVertex, int size) {
        if (layout.weld.empty()) return std::vector<float>(perVertex, perVertex + size_t(vertices) * size);
        std::vector<float> data(outVertices * size, 0.0f);
        for (size_t o = 0; o < outVertices; o++) {
            const uint32_t v = layout.weld[o];
            if (v < uint32_t(vertices)) std::copy_n(&perVertex[size_t(v) * size], size, &data[o * size]);
        }
        return data;
    };

    // Per-corner data comes from one corner each output vertex was welded from (they all agree).
    for (const PrimvarIn& pv : primvars) {
        const bool isNormals = pv.name == kNormals;
        if (isNormals && skipNormals) continue;
        std::vector<float> data;
        if (pv.interpolation == kVertex || pv.interpolation == kVarying) {
            if (pv.values.size() < size_t(vertices) * pv.size) continue;
            data = gather(pv.values.data(), pv.size);
        } else if (pv.interpolation == kFaceVarying) {
            if (pv.indices.size() != corners) continue;
            const size_t count = pv.values.size() / pv.size;
            data.assign(outVertices * pv.size, 0.0f);
            for (size_t o = 0; o < outVertices; o++) {
                const int index = pv.indices[layout.rep[o]];
                if (index >= 0 && size_t(index) < count) std::copy_n(&pv.values[size_t(index) * pv.size], pv.size, &data[o * pv.size]);
            }
        } else if (pv.interpolation == kUniform) {
            const size_t count = pv.values.size() / pv.size;
            data.assign(outVertices * pv.size, 0.0f);
            for (size_t o = 0; o < outVertices; o++) {
                const int face = poly.baseFace(cornerFace[layout.rep[o]]);
                if (face >= 0 && size_t(face) < count) std::copy_n(&pv.values[size_t(face) * pv.size], pv.size, &data[o * pv.size]);
            }
        } else continue; // constant primvars are sent as plain values, not streams
        if (isNormals) out.normals = std::move(data);
        else out.primvars.push_back({ pv.name, pv.size, std::move(data) });
    }

    if (out.normals.empty() && !poly.vertexNormals.empty()) {
        // Limit normals of the refined surface.
        out.normals = layout.weld.empty() ? std::move(poly.vertexNormals) : gather(poly.vertexNormals.data(), 3);
    } else if (out.normals.empty() && !polygonal) {
        // Subdivision cage drawn unrefined: area-weighted smooth normals, as Storm does
        // (BuildMeshPoints repeats this calculation triangle for triangle).
        std::vector<float> smooth(size_t(vertices) * 3, 0.0f);
        for (size_t t = 0; t + 2 < out.indices.size(); t += 3) {
            const size_t m[3] = { layout.meshVertex(out.indices[t]), layout.meshVertex(out.indices[t + 1]), layout.meshVertex(out.indices[t + 2]) };
            AccumulateNormal(poly.points.data(), m, smooth);
        }
        Normalize(smooth);
        out.normals = gather(smooth.data(), 3);
    }
    // Last: the smooth normals above read the points in place.
    // Welded coincident points: which output vertex draws each mesh vertex (MeshMap's points), with seams the
    // vertex of the first drawn corner of its point.
    if (!canon.empty() && !layout.pointVertex.empty()) out.pointVertex = std::move(layout.pointVertex);
    else if (!canon.empty()) {
        std::vector<uint32_t> first(size_t(vertices), UINT32_MAX);
        offset = 0;
        for (size_t f = 0; f < poly.counts.size(); f++) {
            const int n = poly.counts[f];
            if (n < 0 || offset + n > corners) break;
            for (int i = 0; drawn[f] && i < n; i++) {
                uint32_t& slot = first[canon[size_t(poly.indices[offset + i])]];
                if (slot == UINT32_MAX) slot = layout.cornerVertex[offset + i];
            }
            offset += n;
        }
        out.pointVertex.resize(size_t(vertices));
        for (int v = 0; v < vertices; v++) out.pointVertex[v] = first[canon[v]];
    }
    out.positions = layout.weld.empty() && !poly.ownPoints.empty() ? std::move(poly.ownPoints) : gather(poly.points.data(), 3);
    out.weld = std::move(layout.weld);
    if (faceVaryingNormals) out.cornerVertex = std::move(layout.cornerVertex);
    return out;
}

bool BuildMeshPoints(const MeshIn& in, const std::vector<uint32_t>& weld, const std::vector<uint32_t>& cornerVertex, MeshOut* out)
{
    if (in.refineLevel > 0 || in.points.empty()) return false; // ponytail: refined surfaces take the full path; cache the refiner if they animate
    const size_t points = in.points.size();
    const size_t vertices = weld.empty() ? points : weld.size();
    const auto gather = [&](const float* perVertex, size_t count, int size, std::vector<float>* data) {
        data->assign(vertices * size, 0.0f);
        for (size_t o = 0; o < vertices; o++) {
            const size_t v = weld.empty() ? o : weld[o];
            if (v >= count) return false;
            std::copy_n(perVertex + v * size, size, &(*data)[o * size]);
        }
        return true;
    };
    if (!gather(in.points.cdata()->data(), points, 3, &out->positions)) return false;

    if (in.scheme == PxOsdOpenSubdivTokens->none) {
        for (const PrimvarIn& pv : in.primvars) {
            if (pv.name != kNormals) continue;
            if (pv.size != 3) return false;
            if (pv.interpolation == kVertex || pv.interpolation == kVarying) {
                if (pv.values.size() < points * 3) break; // too short: BuildMesh leaves such a mesh flat too
                if (!gather(pv.values.data(), pv.values.size() / 3, 3, &out->normals)) return false;
            } else if (pv.interpolation == kFaceVarying) {
                // Corners welded by equal normals must still agree; where they drifted apart the
                // full build splits them again.
                const size_t corners = in.faceVertexIndices.size();
                if (cornerVertex.size() != corners || pv.indices.size() != corners) return false;
                const size_t count = pv.values.size() / 3;
                out->normals.assign(vertices * 3, 0.0f);
                std::vector<uint8_t> written(vertices, 0);
                for (size_t corner = 0; corner < corners; corner++) {
                    const int index = pv.indices[corner];
                    const uint32_t o = cornerVertex[corner];
                    if (index < 0 || size_t(index) >= count || o >= vertices) continue;
                    const float* n = &pv.values[size_t(index) * 3];
                    float* dst = &out->normals[size_t(o) * 3];
                    if (!written[o]) {
                        std::copy_n(n, 3, dst);
                        written[o] = 1;
                    } else if (dst[0] != n[0] || dst[1] != n[1] || dst[2] != n[2]) return false;
                }
            } else return false; // uniform or constant normals: the full build lays them out
            break;
        }
        return true;
    }

    // A subdivision cage at level 0: the smooth normals of BuildMesh, same triangles in the same order.
    const size_t corners = in.faceVertexIndices.size();
    const int* indices = in.faceVertexIndices.cdata();
    std::vector<uint8_t> hole(in.faceVertexCounts.size(), 0);
    for (int f : in.holeIndices) {
        if (f >= 0 && size_t(f) < hole.size()) hole[f] = 1;
    }
    const bool flip = in.orientation == PxOsdOpenSubdivTokens->leftHanded;
    std::vector<float> smooth(points * 3, 0.0f);
    size_t offset = 0;
    for (size_t f = 0; f < in.faceVertexCounts.size(); f++) {
        const int n = in.faceVertexCounts[f];
        if (n < 0 || offset + n > corners) break;
        bool valid = n >= 3 && !hole[f];
        for (int i = 0; valid && i < n; i++) valid = indices[offset + i] >= 0 && size_t(indices[offset + i]) < points;
        for (int i = 1; valid && i + 1 < n; i++) {
            size_t b = offset + i, c = offset + i + 1;
            if (flip) std::swap(b, c);
            const size_t m[3] = { size_t(indices[offset]), size_t(indices[b]), size_t(indices[c]) };
            AccumulateNormal(in.points.cdata()->data(), m, smooth);
        }
        offset += n;
    }
    Normalize(smooth);
    return gather(smooth.data(), points, 3, &out->normals);
}

MeshCounts CountMesh(const MeshIn& in)
{
    MeshCounts counts;
    counts.points = in.points.size();
    std::vector<bool> hole(in.faceVertexCounts.size(), false);
    for (int f : in.holeIndices) {
        if (f >= 0 && size_t(f) < hole.size()) hole[f] = true;
    }
    std::vector<uint64_t> edges; // sorted and deduplicated below: one allocation, see BuildMesh
    edges.reserve(in.faceVertexIndices.size());
    size_t offset = 0;
    for (size_t f = 0; f < in.faceVertexCounts.size(); f++) {
        const int n = in.faceVertexCounts[f];
        if (n < 0 || offset + n > in.faceVertexIndices.size()) break; // malformed topology
        if (n >= 3 && !hole[f]) {
            counts.faces++;
            for (int i = 0; i < n; i++) edges.push_back(EdgeKey(in.faceVertexIndices[offset + i], in.faceVertexIndices[offset + (i + 1) % n]));
        }
        offset += n;
    }
    std::sort(edges.begin(), edges.end());
    counts.edges = size_t(std::unique(edges.begin(), edges.end()) - edges.begin());
    return counts;
}

/* ---------- curves ---------- */

namespace {

/// Basis weights of the four control points of a cubic segment at parameter t.
void CubicWeights(const TfToken& basis, float t, float w[4])
{
    static const TfToken bspline("bspline"), catmullRom("catmullRom");
    const float t2 = t * t, t3 = t2 * t;
    if (basis == bspline) {
        w[0] = (1 - 3 * t + 3 * t2 - t3) / 6;
        w[1] = (4 - 6 * t2 + 3 * t3) / 6;
        w[2] = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
        w[3] = t3 / 6;
    } else if (basis == catmullRom) {
        w[0] = (-t3 + 2 * t2 - t) / 2;
        w[1] = (3 * t3 - 5 * t2 + 2) / 2;
        w[2] = (-3 * t3 + 4 * t2 + t) / 2;
        w[3] = (t3 - t2) / 2;
    } else { // bezier
        const float s = 1 - t;
        w[0] = s * s * s;
        w[1] = 3 * s * s * t;
        w[2] = 3 * s * t2;
        w[3] = t3;
    }
}

} // namespace

CurvesOut BuildCurves(const CurvesIn& in)
{
    static const TfToken cubicToken("cubic"), periodicToken("periodic"), bezier("bezier"), widths("widths");
    CurvesOut out;
    const bool cubic = in.type == cubicToken;
    const bool periodic = in.wrap == periodicToken;
    const int step = cubic && in.basis == bezier ? 3 : 1;
    const int samples = cubic ? 4 << std::clamp(in.refineLevel, 0, 4) : 1;
    const int pointCount = int(in.points.size());
    const auto controlPoint = [&](int index) { // through the optional index buffer
        if (in.indices.empty()) return index;
        return index >= 0 && size_t(index) < in.indices.size() ? in.indices[index] : -1;
    };

    int first = 0;        // first control vertex of the curve
    int varyingFirst = 0; // first varying-rate value of the curve
    for (size_t curve = 0; curve < in.counts.size(); curve++) {
        const int n = in.counts[curve];
        int segments;
        if (!cubic) segments = periodic ? n : n - 1;
        else if (step == 3) segments = periodic ? n / 3 : (n - 4) / 3 + 1;
        else segments = periodic ? n : n - 3;
        const int varyingCount = cubic ? (periodic ? segments : segments + 1) : n;
        if (n < (cubic ? 4 : 2) || segments < 1) {
            first += n;
            varyingFirst += std::max(varyingCount, 0);
            continue;
        }
        uint32_t emitted = 0;
        for (int segment = 0; segment < segments; segment++) {
            const int last = segment == segments - 1 ? samples : samples - 1;
            for (int sample = 0; sample <= last; sample++) {
                const float t = float(sample) / float(samples);
                float w[4] = { 1 - t, t, 0, 0 };
                int local[4]; // control vertices within the curve
                const int controls = cubic ? 4 : 2;
                if (cubic) CubicWeights(in.basis, t, w);
                for (int k = 0; k < controls; k++) {
                    const int index = segment * step + k;
                    local[k] = periodic ? index % n : std::min(index, n - 1);
                }
                float p[3] = { 0, 0, 0 };
                for (int k = 0; k < controls; k++) {
                    const int index = controlPoint(first + local[k]);
                    if (index < 0 || index >= pointCount) continue;
                    for (int axis = 0; axis < 3; axis++) p[axis] += w[k] * in.points[index][axis];
                }
                out.points.insert(out.points.end(), p, p + 3);
                for (const PrimvarIn& pv : in.primvars) {
                    std::vector<float>& target = pv.name == widths ? out.widths : out.colors;
                    const size_t count = pv.values.size() / pv.size;
                    for (int c = 0; c < pv.size; c++) {
                        const auto value = [&](size_t element) { return element < count ? pv.values[element * pv.size + c] : 0.0f; };
                        float v;
                        if (pv.interpolation == kVertex) {
                            v = 0;
                            for (int k = 0; k < controls; k++) v += w[k] * value(size_t(first + local[k]));
                        } else if (pv.interpolation == kVarying) {
                            const int a = segment, b = periodic ? (segment + 1) % varyingCount : segment + 1;
                            v = (1 - t) * value(size_t(varyingFirst + a)) + t * value(size_t(varyingFirst + b));
                        } else if (pv.interpolation == kUniform) v = value(curve);
                        else v = value(0);
                        target.push_back(v);
                    }
                }
                emitted++;
            }
        }
        out.counts.push_back(emitted);
        first += n;
        varyingFirst += varyingCount;
    }
    return out;
}
