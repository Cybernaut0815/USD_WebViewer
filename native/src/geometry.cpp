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

/// A polygon mesh ready for triangulation: either the authored mesh or its refinement.
struct Poly {
    std::vector<int> counts, indices; // faces
    std::vector<int> baseFace;        // authored face of each face
    std::vector<bool> hole;
    std::vector<float> points;        // xyz per vertex
    std::vector<float> vertexNormals; // xyz per vertex, empty: none
    /// uniform primvars stay indexed by authored face; the others follow this mesh. The authored
    /// primvars are read in place; refinement fills `refined` and points at that instead.
    const std::vector<PrimvarIn>* primvars = nullptr;
    std::vector<PrimvarIn> refined;
    bool flip = false; // left-handed winding still to be corrected
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
    poly->counts.assign(in.faceVertexCounts.cbegin(), in.faceVertexCounts.cend());
    poly->indices.assign(in.faceVertexIndices.cbegin(), in.faceVertexIndices.cend());
    poly->baseFace.resize(poly->counts.size());
    for (size_t f = 0; f < poly->counts.size(); f++) poly->baseFace[f] = int(f);
    poly->hole.assign(poly->counts.size(), false);
    for (int f : in.holeIndices) {
        if (f >= 0 && size_t(f) < poly->hole.size()) poly->hole[f] = true;
    }
    poly->points.assign(in.points.cdata()->data(), in.points.cdata()->data() + in.points.size() * 3);
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
    poly->points.assign(size_t(vertices) * 3, 0.0f);
    poly->vertexNormals.assign(size_t(vertices) * 3, 0.0f);
    std::vector<float> du(size_t(vertices) * 3), dv(size_t(vertices) * 3);
    {
        Span src { refined.data(), 3 }, position { poly->points.data(), 3 }, t1 { du.data(), 3 }, t2 { dv.data(), 3 };
        primvarRefiner.Limit(src, position, t1, t2);
    }
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
        poly->counts.push_back(faceVertices.size());
        for (int i = 0; i < faceVertices.size(); i++) poly->indices.push_back(faceVertices[i]);
        poly->hole.push_back(last.IsFaceHole(f));
        int base = f;
        for (int l = level; l > 0; l--) base = refiner->GetLevel(l).GetFaceParentFace(base);
        poly->baseFace.push_back(base);
    }

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
    std::vector<uint32_t> cornerVertex; // corner -> output vertex; empty: poly.indices
    std::vector<uint32_t> rep;          // output vertex -> one corner that uses it (welded only)
    size_t vertices = 0;
    uint32_t at(size_t corner, const Poly& poly) const { return cornerVertex.empty() ? uint32_t(poly.indices[corner]) : cornerVertex[corner]; }
    size_t meshVertex(uint32_t out) const { return weld.empty() ? out : weld[out]; }
};

/// Welds the corners by (mesh vertex, per-corner values): the bits of each faceVarying or uniform
/// channel's value at the corner, so equal values weld whether the primvar is indexed or written
/// out per corner, and seams (different values) split. One hash table, open addressing.
void Weld(const Poly& poly, const std::vector<const PrimvarIn*>& perCorner, const std::vector<int>& cornerFace, Layout* layout)
{
    const size_t corners = poly.indices.size();
    size_t words = 1;
    for (const PrimvarIn* pv : perCorner) words += size_t(pv->size);
    std::vector<uint32_t> keys(corners * words, 0);
    for (size_t corner = 0; corner < corners; corner++) {
        uint32_t* row = &keys[corner * words];
        row[0] = uint32_t(poly.indices[corner]);
        size_t w = 1;
        for (const PrimvarIn* pv : perCorner) {
            const size_t count = pv->values.size() / pv->size;
            const int element = pv->interpolation == kFaceVarying ? pv->indices[corner] : poly.baseFace[cornerFace[corner]];
            for (int k = 0; k < pv->size; k++) row[w++] = element >= 0 && size_t(element) < count ? Bits(pv->values[size_t(element) * pv->size + k]) : 0;
        }
    }
    size_t capacity = 16;
    while (capacity < corners * 2) capacity <<= 1;
    std::vector<uint32_t> table(capacity, UINT32_MAX); // the corner whose row owns the slot
    layout->cornerVertex.assign(corners, 0);
    for (size_t corner = 0; corner < corners; corner++) {
        const uint32_t* row = &keys[corner * words];
        for (size_t slot = HashRow(row, words) & (capacity - 1);; slot = (slot + 1) & (capacity - 1)) {
            const uint32_t owner = table[slot];
            if (owner == UINT32_MAX) {
                table[slot] = uint32_t(corner);
                layout->cornerVertex[corner] = uint32_t(layout->weld.size());
                layout->weld.push_back(row[0]);
                layout->rep.push_back(uint32_t(corner));
                break;
            }
            if (std::equal(row, row + words, &keys[size_t(owner) * words])) {
                layout->cornerVertex[corner] = layout->cornerVertex[owner];
                break;
            }
        }
    }
    layout->vertices = layout->weld.size();
}

} // namespace

MeshOut BuildMesh(const MeshIn& in)
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

    // Primvars that vary per face or per face-vertex split the output vertices where their
    // values differ (a faceVarying primvar whose indices do not match the corners is not sent).
    std::vector<const PrimvarIn*> perCorner;
    bool uniform = false, faceVaryingNormals = false;
    for (const PrimvarIn& pv : primvars) {
        if (pv.name == kNormals && !polygonal) continue;
        if (pv.interpolation == kFaceVarying && pv.indices.size() == corners) perCorner.push_back(&pv);
        else if (pv.interpolation == kUniform) perCorner.push_back(&pv);
        else continue;
        uniform = uniform || pv.interpolation == kUniform;
        faceVaryingNormals = faceVaryingNormals || (pv.name == kNormals && pv.interpolation == kFaceVarying);
    }

    // Faces with fewer than three corners, holes and faces with indices out of range are not
    // drawn. The authored face of each corner is only needed to look up uniform primvars.
    std::vector<uint8_t> drawn(poly.counts.size(), 0);
    std::vector<int> cornerFace(uniform ? corners : 0, 0);
    size_t triangles = 0;
    size_t offset = 0;
    for (size_t f = 0; f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break; // malformed topology
        bool valid = n >= 3 && !poly.hole[f];
        for (int i = 0; i < n; i++) {
            if (uniform) cornerFace[offset + i] = int(f);
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

    Layout layout;
    if (!perCorner.empty()) Weld(poly, perCorner, cornerFace, &layout);
    else layout.vertices = size_t(vertices);
    const size_t outVertices = layout.vertices;

    // Fan triangulation, and the face edges bucketed by their smaller vertex: a counting sort
    // (two passes and one allocation; the meshes are built in parallel), then each bucket, a
    // handful of records on ordinary meshes, sorted by the other vertex. An edge met twice from
    // the same authored face lies inside it (refinement): not drawn.
    struct EdgeRec {
        uint32_t other; // the larger vertex
        uint32_t a, b;  // in the layout of `indices`
        int base;
    };
    out.indices.reserve(triangles * 3);
    out.triangleFace.reserve(triangles);
    std::vector<uint32_t> start(size_t(vertices) + 2, 0); // start[v + 2] counts, then start[v + 1] places, then [start[v], start[v + 1]) is bucket v
    offset = 0;
    for (size_t f = 0; f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break;
        if (drawn[f]) {
            for (int i = 1; i + 1 < n; i++) {
                size_t a = offset, b = offset + i, c = offset + i + 1;
                if (poly.flip) std::swap(b, c);
                for (size_t corner : { a, b, c }) out.indices.push_back(layout.at(corner, poly));
                out.triangleFace.push_back(poly.baseFace[f]);
            }
            for (int i = 0; i < n; i++) start[size_t(std::min(poly.indices[offset + i], poly.indices[offset + (i + 1) % n])) + 2]++;
        }
        offset += n;
    }
    for (size_t i = 1; i < start.size(); i++) start[i] += start[i - 1];
    std::vector<EdgeRec> records(start.back());
    offset = 0;
    for (size_t f = 0; f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break;
        if (drawn[f]) {
            for (int i = 0; i < n; i++) {
                const size_t c0 = offset + i, c1 = offset + (i + 1) % n;
                const int v0 = poly.indices[c0], v1 = poly.indices[c1];
                records[start[size_t(std::min(v0, v1)) + 1]++] = { uint32_t(std::max(v0, v1)), layout.at(c0, poly), layout.at(c1, poly), poly.baseFace[f] };
            }
        }
        offset += n;
    }
    out.edges.reserve(records.size()); // every edge of a closed mesh is met twice
    for (int v = 0; v < vertices; v++) {
        const size_t lo = start[v], hi = start[v + 1];
        if (hi - lo > 1) std::sort(records.begin() + lo, records.begin() + hi, [](const EdgeRec& x, const EdgeRec& y) { return x.other < y.other; });
        for (size_t i = lo; i < hi;) {
            size_t j = i + 1;
            bool draw = true;
            for (; j < hi && records[j].other == records[i].other; j++) draw &= records[j].base != records[i].base;
            out.distinctEdges++;
            if (draw) {
                out.edges.push_back(records[i].a);
                out.edges.push_back(records[i].b);
            }
            i = j;
        }
    }
    std::vector<EdgeRec>().swap(records);
    std::vector<uint32_t>().swap(start);

    // Per-vertex data in the output layout: each output vertex copies its mesh vertex.
    const auto gather = [&](const std::vector<float>& perVertex, int size) {
        if (layout.weld.empty()) return std::vector<float>(perVertex.begin(), perVertex.begin() + size_t(vertices) * size);
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
        if (isNormals && !polygonal) continue;
        std::vector<float> data;
        if (pv.interpolation == kVertex || pv.interpolation == kVarying) {
            if (pv.values.size() < size_t(vertices) * pv.size) continue;
            data = gather(pv.values, pv.size);
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
                const int face = poly.baseFace[cornerFace[layout.rep[o]]];
                if (face >= 0 && size_t(face) < count) std::copy_n(&pv.values[size_t(face) * pv.size], pv.size, &data[o * pv.size]);
            }
        } else continue; // constant primvars are sent as plain values, not streams
        if (isNormals) out.normals = std::move(data);
        else out.primvars.push_back({ pv.name, pv.size, std::move(data) });
    }

    if (out.normals.empty() && !poly.vertexNormals.empty()) {
        // Limit normals of the refined surface.
        out.normals = layout.weld.empty() ? std::move(poly.vertexNormals) : gather(poly.vertexNormals, 3);
    } else if (out.normals.empty() && !polygonal) {
        // Subdivision cage drawn unrefined: area-weighted smooth normals, as Storm does
        // (BuildMeshPoints repeats this calculation triangle for triangle).
        std::vector<float> smooth(size_t(vertices) * 3, 0.0f);
        for (size_t t = 0; t + 2 < out.indices.size(); t += 3) {
            const size_t m[3] = { layout.meshVertex(out.indices[t]), layout.meshVertex(out.indices[t + 1]), layout.meshVertex(out.indices[t + 2]) };
            AccumulateNormal(poly.points.data(), m, smooth);
        }
        Normalize(smooth);
        out.normals = gather(smooth, 3);
    }
    // Last: the smooth normals above read the points in place.
    out.positions = layout.weld.empty() ? std::move(poly.points) : gather(poly.points, 3);
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
