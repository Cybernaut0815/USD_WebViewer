# USD Web Viewer

A browser viewer for OpenUSD files. Composition and scene processing run in a C++ core compiled to WebAssembly (official OpenUSD 26.08, Hydra 2 scene indices, OpenSubdiv, MaterialX); three.js draws the result with WebGPU and falls back to WebGL2. The page shows the prim hierarchy, the details of the selected prim, and exposes a typed API for host pages.

```
Page, main thread (TypeScript)                 Web Worker: usdcore.wasm (C++)
  <usd-viewer>: hierarchy, viewport, details     UsdStage -> Hydra 2 scene indices -> SceneBridge
  three.js renderer                    <-----    render deltas (refined meshes, curves, points,
  promise RPC (web/src/rpc.ts)         ----->    instances, materials, lights, cameras)
```

## Quick start

All npm commands run inside `web/` (the repo root has no `package.json`).

```
cd web
npm install
npm run dev        # http://localhost:5173/?src=samples/showcase.usda
```

The page needs the wasm core in `web/public/core/` (see [Building the core](#building-the-core)). Without it, develop against a small fake core: `http://localhost:5173/?core=mock-core/&src=mock.usda`.

| Command (in `web/`) | Does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Type-check and build the viewer page into `web/dist` |
| `npm run build:lib` | Build the embeddable `usd-viewer.js` into `web/dist-lib` (three.js stays a peer dependency) |
| `npm test` | Unit tests |
| `npm run e2e` | Browser tests (Chromium, WebGL2 backend); `npm run e2e:update` refreshes the goldens |

## Building the core

Requirements: CMake 3.27+, Ninja, Node 24+, and [emsdk](https://github.com/emscripten-core/emsdk) with Emscripten 5.0.7 (the version OpenUSD 26.08 is tested with).

Two steps: the SDK (oneTBB, OpenSubdiv, MaterialX, OpenUSD; about an hour, once), then the core against it (minutes). The core build copies `usdcore.js` and `usdcore.wasm` into `web/public/core/`.

**Windows**

```
sdk\build.bat    [emsdk dir] [work dir]
native\build.bat [emsdk dir] [work dir] [Release|Debug]
node native\test\smoke.mjs
```

The emsdk directory defaults to `%EMSDK%` (set by `emsdk_env.bat` or `emsdk activate --permanent`), the work directory to `build\` in the repo. Give both scripts the same work directory. If the SDK build fails on long paths, pass a short one such as `C:\uw`.

**Linux and macOS**

```
source <emsdk>/emsdk_env.sh
cmake -S sdk -B build/sdk-build -G Ninja -DSDK_PREFIX=$PWD/build/sdk && cmake --build build/sdk-build
emcmake cmake -S native -B build/core -G Ninja -DSDK_PREFIX=$PWD/build/sdk && cmake --build build/core
node native/test/smoke.mjs build/core
```

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

Requirements on the host page:

- The page, the worker script and the wasm must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the core uses threads). Hosts that cannot send headers can load `coi-serviceworker.min.js` first, as `web/index.html` does.
- The `core/` directory (`worker.js`, `usdcore.js`, `usdcore.wasm`, copied from `web/public/core`) is served from the page's origin; point the `core-url` attribute at it if it is not next to the page. Build `usd-viewer.js` with `npm run build:lib`.
- Assets on other origins need CORS headers.

### Asset sources

Dropped files and folders, `http(s)` URLs, and URL schemes routed through an HTTP gateway:

```js
viewer.registerScheme('omniverse', { gateway: 'https://gateway.example/v1', getAuth: () => 'Bearer …' });
viewer.open('omniverse://server/Projects/scene.usd');
```

The core then reads every `omniverse://` asset as `GET <gateway>/read?url=<asset url>`. This is the hook for the planned Nucleus gateway (a native service linking the Omniverse Client Library, which cannot run in a browser).

## Editing

The viewer is also an editor. Edits go to the stage's **edit target**, the root layer by default (File ▸ Edit target switches to a sublayer or to the session layer, whose edits are never saved):

- **Transforms**: `Q` is the Select tool; the Move / Rotate / Scale tools (`W E R`) drag a gizmo placed at the active prim; every selected prim follows (rotation and scale happen about the active prim's origin). The dragged objects follow the pointer immediately while each step is written to the prims' xform ops as fast as the core accepts (a translate/rotate/scale stack keeps its ops and precision, a lone `xformOp:transform` is set directly, anything else gets a leading `xformOp:transform:edit`). Instances are moved as a whole. `viewer.usd.setXform(path, matrix)` and `setXforms(entries)` do the same from code.
- **Attributes, visibility, variants, payloads, refinement**: from the panels or `viewer.usd.*`. Every edit is undoable (`Ctrl+Z`, `Ctrl+Shift+Z`, `viewer.undo()`): the core reports what an edit replaced and the inverse re-authors it.
- **Hiding**: `H` hides the selection, `Shift+H` hides everything else (the siblings along the selection's ancestors), `Alt+H` shows what those two hid. They write `visibility` into the session layer whatever the edit target is, so the file is never marked dirty and nothing is saved; each is one undo step. Prims the file itself makes invisible stay hidden (the eye in the hierarchy edits those). From code: `viewer.hide()`, `isolate()`, `showAll()`, or `viewer.usd.hide(paths)` / `isolate(paths)` / `showAll()`.
- **Saving**: `Save` (`Ctrl+S`) writes each layer with unsaved edits in its own encoding (usda or usdc). A folder opened with File ▸ Folder… in Chromium is written back in place (File System Access API); otherwise the layer is downloaded. File ▸ Download flattened exports the composed stage as one usda file. Saving is an export: comments and formatting of hand-written usda are rewritten, and members of a usdz package cannot be written back.
- **Changes from outside**: edits made through the API show up at once (they go through the same core). When a folder was opened with write access, its USD files are polled every 2 s and re-read when another program changed them; with unsaved edits the viewer warns instead (File ▸ Reload from disk discards them).

Selection: click selects one prim (empty space clears). **Shift**+click adds a prim and makes it the **active** one (brighter highlight, shown in the property panel; on a prim already selected it only makes it active); **Ctrl**+click removes. In the viewport, Shift+drag draws a rectangle instead of panning: dragged **upward** it adds everything it touches, dragged **downward** only what lies fully inside (tested against screen-space bounding boxes). Ctrl+drag removes the same way. With several prims selected, a dropdown above the property panel picks the one shown. `viewer.select(paths, { active })` does the same from code.

Keys work while the viewport or the hierarchy has focus, not while typing in a field. The **?** button or `F1` opens the Help window, which lists every key and mouse gesture.

Panels: the hierarchy, the property panel and the timebar can each be hidden with the small tabs in the middle of their borders to the viewport (they appear when the pointer comes near the border), the View menu, or `viewer.panels = { hierarchy, details, timeline }`. Dragging a side border resizes that panel; side panels keep their share of the window when it is resized (at least 120 px), while the timebar keeps its height. Shares and visibility are remembered in the browser. The timebar has first / previous / play / next / last, a frame field, the stage's range and fps, and a loop switch (`Space` plays, `,` and `.` step a frame); it is disabled for stages without animation.

The prim search field in the hierarchy has a ✕ (or Escape) that clears it and brings back the full tree.

Camera (View ▸ Camera, `viewer.cameraSettings`): the free camera can be perspective or orthographic; focal length 10–300 mm (35 mm equivalent on a 24 mm high gate, presets 24 / 35 / 50 / 85 / 135, the vertical field of view shown next to it); clipping follows the stage's bounds unless Auto clipping is off, then near and far are set by hand. Stage cameras keep their own lens.

Skies (toolbar, `viewer.sky`): five bundled Poly Haven HDRIs (blue sky, sunset, forest, industrial hangar, studio; CC0, see `web/public/skies/LICENSE.md`). A sky lights the stage and fills the background in place of the stage's own dome light; "No sky" goes back to the stage's lighting. Hosts serve the `skies/` folder next to the page or point the `skies-url` attribute at it.

Display modes (toolbar, `viewer.displayMode`): **shaded** (bound materials) or **plain** (one grey material), each alone, with the edges of every mesh (**+ wire**), or with red edges on the selection only (**+ selection wire**, the active prim brighter, in place of the yellow fill); and **wireframe** (edges only). Edges are the outlines of the authored faces: no triangulation diagonals, and on refined meshes only the boundaries of the cage faces.

Statistics (top right of the viewport, `viewer.stats`): meshes, vertices, faces and edges of the visible meshes as authored in USD (each instance counted, holes left out, independent of refinement and triangulation), and how many distinct materials are bound to them and how many textures those materials use.

Subdivision follows Omniverse's convention: a global refinement level (toolbar; 0 by default like usdview and Omniverse, since most production meshes are polygon cages that only look right unrefined; `Auto` picks the highest level up to 2 whose triangle count stays under 3 million for the stage) and, per mesh, the custom attributes `refinementEnableOverride` / `refinementLevel`, editable in the Refinement section of the property panel and travelling with the file.

Copying: every value in the property panel sits in a box; a click copies it, a right click offers `value`, `name = value`, the typed usda declaration, or the whole section as text (long arrays are fetched in full, not as shown). The hierarchy's right-click menu copies a prim's USD (composed subtree, or only what the edit layer authors) or its path.

Other editor conveniences: locking prims against selection (the lock next to the eye; editor state only, never saved).

## Repository layout

| Path | Contents |
|---|---|
| `sdk/` | CMake superbuild of the wasm SDK: oneTBB, OpenSubdiv, MaterialX, OpenUSD |
| `native/` | The core (`usdcore.js`, `usdcore.wasm`): stage queries, Hydra bridge, geometry conversion, asset resolver |
| `web/` | The viewer: `<usd-viewer>` element, three.js scene sync, panels, tests |
| `web/src/protocol.ts` | The contract between page and core |

## Status

Verified with the browser test suite (`npm run e2e`, WebGL2 backend) and by hand on the WebGPU backend: meshes, subdivision (creases included, automatic and per-prim levels), GeomSubsets, curves, points, point and native instancing, UsdPreviewSurface with textures, MaterialX `standard_surface`, UsdLux lights with a dome light, cameras, variants, payloads, time samples and skinning; the inspector (metadata, primvars, composition arcs), copy menus, locks, display modes with face-edge wireframes, hiding and isolating, statistics, box selection, skies, panel layout, the timebar, gizmo editing with undo, saving and reload-on-change. Pixar's Kitchen_set and UsdSkelExamples load as they are. `usdcore.wasm` is 23 MB (4 MB with brotli).

Not built yet: the Nucleus gateway. The CI workflow in `.github/workflows/ci.yml` has not run anywhere yet.

### Known limits

- Area lights are approximated (rect lights cast no shadows, disk lights are drawn square, cylinder lights as points).
- UDIM textures, light linking, IES profiles, volumes and displacement are not rendered.
- The automatic refinement level is stage-wide (one huge cage lowers every mesh); each mesh is also capped at 2 million output triangles.
- Write-back and disk watching need the File System Access API (Chromium on desktop); elsewhere saving downloads the layer. Layers opened from URLs can only be downloaded and stay flagged as unsaved.
- The gizmo sits at the prim's origin, not at its pivot; undo re-authors earlier values rather than removing the layer's specs.
- Skinned characters are deformed on the CPU: about 10 frames per second for a 300k-vertex character.
- wasm32: a stage has to fit in 4 GB.
