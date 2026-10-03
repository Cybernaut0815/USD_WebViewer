# USD Web Viewer

A browser viewer for OpenUSD files. Composition and scene processing run in a C++ core compiled to WebAssembly (official OpenUSD 26.08, Hydra 2 scene indices, OpenSubdiv, MaterialX); three.js draws the result with WebGPU and falls back to WebGL2. The page shows the prim hierarchy, the details of the selected prim, and exposes a typed API for host pages.

```
Page, main thread (TypeScript)                 Web Worker: usdcore.wasm (C++)
  <usd-viewer>: hierarchy, viewport, details     UsdStage -> Hydra 2 scene indices -> SceneBridge
  three.js renderer                    <-----    render deltas (refined meshes, curves, points,
  promise RPC (web/src/rpc.ts)         ----->    instances, materials, lights, cameras)
```

## Layout

| Path | Contents |
|---|---|
| `sdk/` | CMake superbuild of the wasm SDK: oneTBB, OpenSubdiv, MaterialX, OpenUSD |
| `native/` | The core (`usdcore.js`, `usdcore.wasm`): stage queries, Hydra bridge, geometry conversion, asset resolver |
| `web/` | The viewer: `<usd-viewer>` element, three.js scene sync, panels, tests |
| `web/src/protocol.ts` | The contract between page and core |

## Building

Requirements: CMake 3.27+, Ninja, Node 24+, and [emsdk](https://github.com/emscripten-core/emsdk) with Emscripten 5.0.7 (the version OpenUSD 26.08 is tested with).

Windows (the scripts default to `F:\emsdk` and a work directory `F:\uw`; pass other locations as arguments):

```
sdk\build.bat          rem once, about an hour: builds the SDK into <work>\sdk
native\build.bat       rem builds the core and copies it into web\public\core
node native\test\smoke.mjs
```

Linux and macOS:

```
source <emsdk>/emsdk_env.sh
cmake -S sdk -B build/sdk-build -G Ninja -DSDK_PREFIX=$PWD/build/sdk && cmake --build build/sdk-build
emcmake cmake -S native -B build/core -G Ninja -DSDK_PREFIX=$PWD/build/sdk && cmake --build build/core
node native/test/smoke.mjs build/core
```

Then the viewer:

```
cd web
npm install
npm run dev        # http://localhost:5173/?src=samples/showcase.usda
npm test           # unit tests
npm run e2e        # browser tests (Chromium, WebGL2 backend)
```

Without the wasm core the page can still be developed against a small fake: `?core=mock-core/&src=mock.usda`.

## Embedding

```html
<script type="module" src="usd-viewer.js"></script>
<usd-viewer src="https://example.com/scene.usdz" style="width: 100%; height: 600px"></usd-viewer>
<script type="module">
  const viewer = document.querySelector('usd-viewer');
  await viewer.ready;
  viewer.addEventListener('selectionchange', (e) => console.log(e.detail.paths));
  const children = await viewer.usd.children('/');
  await viewer.usd.setAttribute('/World/Cube', 'xformOp:translate', [0, 1, 0]); // written to the root layer, undoable
  viewer.select('/World/Cube', { frame: true });
</script>
```

The element is a thin layout around two reusable parts: `viewer.session` (a `UsdSession`: core connection, stage, selection, locks, time, undo history, dirty layers; no DOM) and the viewport with one active tool. Host pages add their own panels through the `toolbar`, `left`, `right` and `bottom` slots and listen to the session's events (`stageopen`, `selectionchange`, `primschange`, `dirtychange`, `diskchange`, …), which the element mirrors. The rule for every module: change the stage through `viewer.usd`, then let the core's render delta move the three.js objects; never edit three.js objects to represent stage state.

## Editing

The viewer is also an editor. Edits go to the stage's **edit target**, the root layer by default (File ▸ Edit target switches to a sublayer or to the session layer, whose edits are never saved):

- **Transforms**: the Move / Rotate / Scale tools (`Q W E R`) drag a gizmo placed at the active prim; every selected prim follows (rotation and scale happen about the active prim's origin). The dragged objects follow the pointer immediately while each step is written to the prims' xform ops as fast as the core accepts (a translate/rotate/scale stack keeps its ops and precision, a lone `xformOp:transform` is set directly, anything else gets a leading `xformOp:transform:edit`). Instances are moved as a whole. `viewer.usd.setXform(path, matrix)` and `setXforms(entries)` do the same from code.
- **Attributes, visibility, variants, payloads, refinement**: from the panels or `viewer.usd.*`. Every edit is undoable (`Ctrl+Z`, `Ctrl+Shift+Z`, `viewer.undo()`): the core reports what an edit replaced and the inverse re-authors it.
- **Saving**: `Save` (`Ctrl+S`) writes each layer with unsaved edits in its own encoding (usda or usdc). A folder opened with File ▸ Folder… in Chromium is written back in place (File System Access API); otherwise the layer is downloaded. File ▸ Download flattened exports the composed stage as one usda file. Saving is an export: comments and formatting of hand-written usda are rewritten, and members of a usdz package cannot be written back.
- **Changes from outside**: edits made through the API show up at once (they go through the same core). When a folder was opened with write access, its USD files are polled every 2 s and re-read when another program changed them; with unsaved edits the viewer warns instead (File ▸ Reload from disk discards them).

Subdivision follows Omniverse's convention: a global refinement level (toolbar; 0 by default like usdview and Omniverse, since most production meshes are polygon cages that only look right unrefined; `Auto` picks the highest level up to 2 whose triangle count stays under 3 million for the stage) and, per mesh, the custom attributes `refinementEnableOverride` / `refinementLevel`, editable in the Refinement section of the property panel and travelling with the file.

Selection: click selects one prim, Ctrl+click adds another and makes it the **active** prim (brighter highlight, shown in the property panel); Ctrl+click on a selected prim makes it active, on the active one deselects it. `viewer.select(paths, { active })` does the same from code.

Other editor conveniences: display modes (shaded, shaded + wire, plain + wire, wireframe), locking prims against selection (the lock next to the eye; editor state only, never saved), right-click menus to copy attribute values (`value`, `name = value`, `type name = value` in usda syntax) and a prim's USD (composed subtree, or only what the edit layer authors).

Requirements on the host page:

- The page, the worker script and the wasm must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the core uses threads). Hosts that cannot send headers can load `coi-serviceworker.min.js` first, as `web/index.html` does.
- The `core/` directory (`worker.js`, `usdcore.js`, `usdcore.wasm`, copied from `web/public/core`) is served from the page's origin; point the `core-url` attribute at it if it is not next to the page. `npm run build:lib` builds `usd-viewer.js` (three.js stays a peer dependency).
- Assets on other origins need CORS headers.

## Asset sources

Dropped files and folders, `http(s)` URLs, and URL schemes routed through an HTTP gateway:

```js
viewer.registerScheme('omniverse', { gateway: 'https://gateway.example/v1', getAuth: () => 'Bearer …' });
viewer.open('omniverse://server/Projects/scene.usd');
```

The core then reads every `omniverse://` asset as `GET <gateway>/read?url=<asset url>`. This is the hook for the planned Nucleus gateway (a native service linking the Omniverse Client Library, which cannot run in a browser).

## Status

Verified with the browser test suite (`npm run e2e`, WebGL2 backend) and by hand on the WebGPU backend: meshes, subdivision (creases included, automatic and per-prim levels), GeomSubsets, curves, points, point and native instancing, UsdPreviewSurface with textures, MaterialX `standard_surface`, UsdLux lights with a dome light, cameras, variants, payloads, time samples and skinning; the inspector (metadata, primvars, composition arcs), copy menus, locks, display modes, gizmo editing with undo, saving and reload-on-change. Pixar's Kitchen_set and UsdSkelExamples load as they are. `usdcore.wasm` is 23 MB (4 MB with brotli).

Not built yet: the Nucleus gateway. The CI workflow in `.github/workflows/ci.yml` has not run anywhere yet.

## Known limits

- Area lights are approximated (rect lights cast no shadows, disk lights are drawn square, cylinder lights as points).
- UDIM textures, light linking, IES profiles, volumes and displacement are not rendered.
- The automatic refinement level is stage-wide (one huge cage lowers every mesh); each mesh is also capped at 2 million output triangles.
- Write-back and disk watching need the File System Access API (Chromium on desktop); elsewhere saving downloads the layer. Layers opened from URLs can only be downloaded and stay flagged as unsaved.
- The gizmo sits at the prim's origin, not at its pivot; undo re-authors earlier values rather than removing the layer's specs.
- Skinned characters are deformed on the CPU: about 10 frames per second for a 300k-vertex character.
- wasm32: a stage has to fit in 4 GB.
