#include "geometry.h"

#include "pxr/imaging/pxOsd/meshTopology.h"
#include "pxr/imaging/pxOsd/refinerFactory.h"
#include "pxr/imaging/pxOsd/tokens.h"

#include <opensubdiv/far/primvarRefiner.h>
#include <opensubdiv/far/topologyRefiner.h>

#include <algorithm>
#include <cmath>

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
    /// uniform primvars stay indexed by authored face; the others follow this mesh.
    std::vector<PrimvarIn> primvars;
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
    poly->primvars = in.primvars;
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
        poly->primvars.push_back(std::move(out));
    }
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

} // namespace

MeshOut BuildMesh(const MeshIn& in)
{
    MeshOut out;
    if (in.points.empty()) return out;
    Poly poly;
    const bool subdivision = in.scheme == PxOsdOpenSubdivTokens->catmullClark || in.scheme == PxOsdOpenSubdivTokens->loop;
    if (!(subdivision && in.refineLevel > 0 && Refine(in, &poly))) {
        poly = Poly();
        MakePoly(in, &poly);
    }
    const bool polygonal = in.scheme == PxOsdOpenSubdivTokens->none;
    const int vertices = int(poly.points.size() / 3);
    const size_t corners = poly.indices.size();

    // Primvars that vary per face or per face-vertex need one output vertex per corner.
    bool expand = in.expand;
    for (const PrimvarIn& pv : poly.primvars) {
        if (pv.name == kNormals && !polygonal) continue;
        if (pv.interpolation == kFaceVarying || pv.interpolation == kUniform) expand = true;
    }

    out.expanded = expand;

    // Fan triangulation. `source` remembers which mesh vertex each output index refers to.
    std::vector<int> cornerFace(corners, 0);
    std::vector<uint32_t> sourceTriangles; // mesh vertex indices, for smooth normals
    // Face edges by welded vertex pair, sorted afterwards (one allocation, not one per edge:
    // the meshes are built in parallel and the wasm allocator serialises small allocations).
    // An edge met twice from the same authored face lies inside it (refinement): not drawn.
    struct Edge {
        uint64_t key;
        uint32_t order; // first sighting wins
        uint32_t a, b;
        int base;
    };
    std::vector<Edge> edges;
    edges.reserve(corners);
    out.indices.reserve(corners * 3);
    sourceTriangles.reserve(corners * 3);
    size_t offset = 0;
    for (size_t f = 0; f < poly.counts.size(); f++) {
        const int n = poly.counts[f];
        if (n < 0 || offset + n > corners) break; // malformed topology
        bool valid = n >= 3 && !poly.hole[f];
        for (int i = 0; i < n; i++) {
            cornerFace[offset + i] = int(f);
            const int v = poly.indices[offset + i];
            if (v < 0 || v >= vertices) valid = false;
        }
        for (int i = 1; valid && i + 1 < n; i++) {
            size_t a = offset, b = offset + i, c = offset + i + 1;
            if (poly.flip) std::swap(b, c);
            for (size_t corner : { a, b, c }) {
                out.indices.push_back(expand ? uint32_t(corner) : uint32_t(poly.indices[corner]));
                sourceTriangles.push_back(uint32_t(poly.indices[corner]));
            }
            out.triangleFace.push_back(poly.baseFace[f]);
        }
        for (int i = 0; valid && i < n; i++) {
            const size_t c0 = offset + i, c1 = offset + (i + 1) % n;
            edges.push_back({ EdgeKey(poly.indices[c0], poly.indices[c1]), uint32_t(edges.size()),
                expand ? uint32_t(c0) : uint32_t(poly.indices[c0]), expand ? uint32_t(c1) : uint32_t(poly.indices[c1]),
                poly.baseFace[f] });
        }
        offset += n;
    }
    std::sort(edges.begin(), edges.end(), [](const Edge& x, const Edge& y) { return x.key != y.key ? x.key < y.key : x.order < y.order; });
    out.edges.reserve(edges.size() * 2);
    for (size_t i = 0; i < edges.size();) {
        size_t j = i + 1;
        bool drawn = true;
        for (; j < edges.size() && edges[j].key == edges[i].key; j++) drawn &= edges[j].base != edges[i].base;
        if (drawn) {
            out.edges.push_back(edges[i].a);
            out.edges.push_back(edges[i].b);
        }
        i = j;
    }

    // Lays per-vertex data out the way the output positions are laid out.
    const auto layout = [&](const std::vector<float>& perVertex, int size) {
        if (!expand) return std::vector<float>(perVertex.begin(), perVertex.begin() + size_t(vertices) * size);
        std::vector<float> data(corners * size, 0.0f);
        for (size_t corner = 0; corner < corners; corner++) {
            const int v = poly.indices[corner];
            if (v < 0 || v >= vertices) continue;
            std::copy_n(&perVertex[size_t(v) * size], size, &data[corner * size]);
        }
        return data;
    };
    out.positions = layout(poly.points, 3);

    for (const PrimvarIn& pv : poly.primvars) {
        const bool isNormals = pv.name == kNormals;
        if (isNormals && !polygonal) continue;
        std::vector<float> data;
        if (pv.interpolation == kVertex || pv.interpolation == kVarying) {
            if (pv.values.size() < size_t(vertices) * pv.size) continue;
            data = layout(pv.values, pv.size);
        } else if (pv.interpolation == kFaceVarying) {
            if (pv.indices.size() != corners) continue;
            const size_t count = pv.values.size() / pv.size;
            data.assign(corners * pv.size, 0.0f);
            for (size_t corner = 0; corner < corners; corner++) {
                const int index = pv.indices[corner];
                if (index >= 0 && size_t(index) < count) std::copy_n(&pv.values[size_t(index) * pv.size], pv.size, &data[corner * pv.size]);
            }
        } else if (pv.interpolation == kUniform) {
            const size_t count = pv.values.size() / pv.size;
            data.assign(corners * pv.size, 0.0f);
            for (size_t corner = 0; corner < corners; corner++) {
                const int face = poly.baseFace[cornerFace[corner]];
                if (face >= 0 && size_t(face) < count) std::copy_n(&pv.values[size_t(face) * pv.size], pv.size, &data[corner * pv.size]);
            }
        } else continue; // constant primvars are sent as plain values, not streams
        if (isNormals) out.normals = std::move(data);
        else out.primvars.push_back({ pv.name, pv.size, std::move(data) });
    }

    if (out.normals.empty() && !poly.vertexNormals.empty()) {
        out.normals = layout(poly.vertexNormals, 3); // limit normals of the refined surface
    } else if (out.normals.empty() && !polygonal) {
        // Subdivision cage drawn unrefined: area-weighted smooth normals, as Storm does.
        std::vector<float> smooth(size_t(vertices) * 3, 0.0f);
        for (size_t t = 0; t + 2 < sourceTriangles.size(); t += 3) {
            const float* a = &poly.points[size_t(sourceTriangles[t]) * 3];
            const float* b = &poly.points[size_t(sourceTriangles[t + 1]) * 3];
            const float* c = &poly.points[size_t(sourceTriangles[t + 2]) * 3];
            const float u[3] = { b[0] - a[0], b[1] - a[1], b[2] - a[2] };
            const float v[3] = { c[0] - a[0], c[1] - a[1], c[2] - a[2] };
            const float n[3] = { u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0] };
            for (int k = 0; k < 3; k++) {
                for (int axis = 0; axis < 3; axis++) smooth[size_t(sourceTriangles[t + k]) * 3 + axis] += n[axis];
            }
        }
        Normalize(smooth);
        out.normals = layout(smooth, 3);
    }
    return out;
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
