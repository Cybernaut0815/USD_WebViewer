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
    /// Force one output vertex per face corner. Set on point-only updates, when
    /// the primvars that originally required that layout are not passed again.
    bool expand = false;
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
    bool expanded = false;         // one vertex per face corner (see MeshIn::expand)
};

MeshOut BuildMesh(const MeshIn& in);

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
