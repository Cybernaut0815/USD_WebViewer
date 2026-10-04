# Architecture and status

[← README](../README.md)

## How it works

```
Page, main thread (TypeScript)                 Web Worker: usdcore.wasm (C++)
  <usd-viewer>: hierarchy, viewport, details     UsdStage -> Hydra 2 scene indices -> SceneBridge
  three.js renderer                    <-----    render deltas (refined meshes, curves, points,
  promise RPC (web/src/rpc.ts)         ----->    instances, materials, lights, cameras)
```

**In the worker:**
- The official OpenUSD 26.08 runs composition and Hydra 2 scene indices.
- OpenSubdiv refines meshes.
- MaterialX provides material networks.

**From the worker to the page:** the core sends render deltas, made of typed arrays that are transferred rather than copied:
- meshes as triangles, with the authored face outlines for wireframes;
- curves, points and instances;
- materials, lights and cameras.

**On the page:** three.js draws the deltas with WebGPU, falling back to WebGL2. Edits go back to the core as RPC calls and come back as new deltas.

## Repository layout

| Path | Contents |
|---|---|
| `sdk/` | CMake superbuild of the wasm SDK: oneTBB, OpenSubdiv, MaterialX, OpenUSD |
| `native/` | The core (`usdcore.js`, `usdcore.wasm`): stage queries and edits, Hydra bridge, geometry conversion, asset resolver; `native/test/smoke.mjs` |
| `web/` | The viewer: `<usd-viewer>` element, three.js scene sync, panels, unit and browser tests |
| `web/src/protocol.ts` | The contract between page and core |
| `web/public/` | The core build output, the mock core, sample stages, skies |

## Status

**Verified** with the browser test suite (`npm run e2e`, WebGL2 backend), and by hand on the WebGPU backend:
- **Geometry:**
  - meshes, subdivision (creases included, automatic and per-prim levels) and GeomSubsets;
  - curves and points;
  - point and native instancing;
  - time samples and skinning.
- **Shading:** UsdPreviewSurface with textures, MaterialX `standard_surface`, UsdLux lights with a dome light, and cameras.
- **Composition:** variants and payloads.
- **Inspecting:** the inspector (metadata, primvars, composition arcs), copying, locks, display modes with face-edge wireframes, statistics and skies.
- **Selecting:** hiding and isolating, box selection.
- **Editing:** gizmo editing with undo, change markers and Clear edits, saving, and reload-on-change.

Pixar's Kitchen_set and UsdSkelExamples load as they are. `usdcore.wasm` is 23 MB, or 4 MB with brotli.

**Not built yet:** the Nucleus gateway. The CI workflow in `.github/workflows/ci.yml` has not run anywhere yet.

## Known limits

- **Lighting:** area lights are approximated. Rect lights cast no shadows, disk lights are drawn square, and cylinder lights are drawn as points.
- **Not rendered:** UDIM textures, light linking, IES profiles, volumes and displacement.
- **Refinement:**
  - The automatic level is shared by every authored subdivision surface, so one huge cage lowers it for all of them.
  - Each mesh is also capped at two thirds of the Auto budget (2 million triangles at the default 3 million).
  - Refinement runs on the CPU. Meshes are read and refined on four core threads (more measured slower: the parallel build contends on shared locks), but a level change on a large stage still takes seconds: Kitchen_set at level 1 is 1.1 million refined quads.
- **Loading** is paged: the first picture shows the first 128 geometry prims, later pages carry up to 1000 prims or 256 MB of streams each, and the view is framed again when the stage is complete (`stageloaded`).
- **Saving:** write-back and disk watching need the File System Access API, which means Chromium on desktop. Elsewhere, saving downloads the layer. Layers opened from URLs can only be downloaded, and stay flagged as unsaved.
- **Transforms and undo:**
  - The gizmo sits at the prim's origin, not at its pivot.
  - Undo re-authors earlier values rather than removing the layer's specs. A transform op added to a prim that had none therefore stays after undo, and so does its change marker. Clear edits removes it.
- **Skinning** runs on the CPU. A frame of a deforming mesh is a positions-only update laid out like the last full conversion (no triangulation): the 90 meshes of UsdSkelExamples' HumanFemale take about 50 ms per frame in the core on a 2020 laptop.
- **Memory:** the core is wasm32, so a stage has to fit in 4 GB. Meshes reach the page welded (vertices split only where a faceVarying or uniform primvar differs: about a third of the face corners on textured stages), a flush converts meshes 64 at a time within a 256 MB page, and ten 1-million-quad grids peak at about 2.5 GB.
