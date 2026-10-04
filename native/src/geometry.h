// Pure geometry conversions: polygon meshes (with optional OpenSubdiv
// refinement) to triangle lists, and basis curves to polylines. No Hydra types
// beyond plain value arrays, so every function here is a deterministic mapping.
#pragma once

#include "pxr/base/gf/vec3f.h"
#include "pxr/base/tf/token.h"
#include "pxr/base/vt/array.h"
#include "pxr/base/vt/types.h"
#include "pxr/imaging/pxOsd/subdivTags.h"

#include <cstdint>
#include <string>
#include <vector>

PXR_NAMESPACE_USING_DIRECTIVE

/// A primvar as read from Hydra, with `size` floats per element.
struct PrimvarIn {
    std::string name;
    TfToken interpolation; // constant, uniform, varying, vertex, faceVarying
    int size = 0;
    std::vector<float> values;
    /// faceVarying only: one index into `values` per face-vertex. Authored
    /// indices keep UV seams welded for subdivision; iota otherwise.
    VtIntArray indices;
};

struct MeshIn {
    TfToken scheme;      // none, bilinear, catmullClark, loop
    TfToken orientation; // rightHanded, leftHanded
    VtIntArray faceVertexCounts, faceVertexIndices, holeIndices;
    PxOsdSubdivTags tags;
    VtVec3fArray points;
    std::vector<PrimvarIn> primvars; // authored normals travel as "normals"
    int refineLevel = 0;
};

struct PrimvarOut {
    std::string name;
    int size = 0;
    std::vector<float> data; // same vertex layout as MeshOut::positions
};

struct MeshOut {
    std::vector<uint32_t> indices; // triangle list
    std::vector<float> positions;
    std::vector<float> normals; // empty: none available, shade flat
    std::vector<PrimvarOut> primvars;
    std::vector<int> triangleFace; // authored face each triangle came from
    /// Line pairs along authored face boundaries (no triangulation diagonals, and on
    /// refined meshes no edges inside an authored face), in the layout of `indices`.
    std::vector<uint32_t> edges;
    bool refined = false; // the output is the refined surface, not the authored mesh
    /// Faces drawn and distinct edges of the mesh that was triangulated (the authored
    /// counts unless `refined`, when CountMesh gives them).
    size_t drawnFaces = 0, distinctEdges = 0;
    /// Output vertex -> mesh vertex. Corners are welded by their mesh vertex and the values of
    /// the faceVarying and uniform primvars, so only seams split vertices; empty when the
    /// output vertices are the mesh vertices.
    std::vector<uint32_t> weld;
    /// Corner -> output vertex, kept only for meshes with faceVarying normals (BuildMeshPoints needs it).
    std::vector<uint32_t> cornerVertex;
};

MeshOut BuildMesh(const MeshIn& in);

/// Positions and normals of a mesh whose points moved, in the layout (`weld`, `cornerVertex`)
/// of its last BuildMesh: no triangulation, no edges. False when the mesh does not fit that
/// layout any more (or is refined): convert it fully again.
bool BuildMeshPoints(const MeshIn& in, const std::vector<uint32_t>& weld, const std::vector<uint32_t>& cornerVertex, MeshOut* out);

/// Counts of the authored mesh: points, faces drawn (holes and degenerate faces
/// left out) and the distinct edges of those faces.
struct MeshCounts {
    size_t points = 0, faces = 0, edges = 0;
};

MeshCounts CountMesh(const MeshIn& in);

struct CurvesIn {
    TfToken type, basis, wrap; // linear|cubic, bezier|bspline|catmullRom, nonperiodic|periodic
    VtIntArray counts, indices;
    VtVec3fArray points;
    std::vector<PrimvarIn> primvars; // "widths" (size 1) and "displayColor" (size 3), any interpolation
    int refineLevel = 0;
};

struct CurvesOut {
    std::vector<float> points;
    std::vector<uint32_t> counts; // polyline vertices per curve
    std::vector<float> widths;    // per polyline vertex, empty: none
    std::vector<float> colors;    // per polyline vertex, empty: none
};

CurvesOut BuildCurves(const CurvesIn& in);
