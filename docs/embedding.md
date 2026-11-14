# Embedding and API

[← README](../README.md)

Build the element with `npm run build:lib` (in `web/`). The output is `web/dist-lib/usd-viewer.js`; three.js stays a peer dependency.

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

`web/host.html` is a working example of a host page that drives the viewer through this API only.

## Host page requirements

- **Cross-origin isolation.** The page, the worker script and the wasm must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, because the core uses threads (strictly: the page and the worker scripts; the wasm only needs to be same-origin or CORS). Hosts that cannot send headers can serve `sw.js` (`web/public/sw.js`), which adds them to the page and the worker scripts only: register it before the element loads, with `core/` inside its scope, and reload once when the page is not yet `crossOriginIsolated`, as `web/index.html` does.
- **The `core/` directory** (`worker.js`, `usdcore.js`, `usdcore.wasm`, from `web/public/core`) is served from the page's origin. If it is not next to the page, point the `core-url` attribute at it.
- **The `skies/` directory** (`web/public/skies`) is served the same way. If it is elsewhere, point the `skies-url` attribute at it.
- **Assets on other origins** need CORS headers.

## Attributes

| Attribute | Meaning |
|---|---|
| `src` | URL of the stage to open |
| `core-url`, `skies-url` | Where the core and the skies are served (default: `core/`, `skies/` next to the page) |
| `panels="none"` | Viewport only: no toolbar, panels or overlays |
| `readonly` | No edits from the view: of the keys only F and H / Shift+H / Alt+H work (hiding writes the session layer, never saved), the tool keys, and Esc and Del while section entries are selected; the Scale tool is off and Move / Rotate act on sections only, no prim menu, no drop-to-open. Selection, navigation and sections (view only) stay. The panels still edit, so pair it with `panels="none"` |
| `force-webgl` | Use the WebGL2 backend even where WebGPU is available |
| `live` | URL of a [live-link](live.md) relay; empty means `live/` next to the page, which `npm run dev` provides |

## Structure

The element is a thin layout around two reusable parts:
- **`viewer.session`**, a `UsdSession`. It holds the core connection, the stage, selection, locks, time, the undo history, dirty layers and change markers. It touches no DOM. Meshes come without their face edges (`MeshEntry.edges`) until `session.wantEdges()` asks for them (the viewer does at the first wireframe display mode); from then on every mesh brings them. A host's own hierarchy can select exactly like the viewer's with the exported `modifySelect(session, paths, mode, source)` (`'replace'`, `'add'`, `'remove'`, `'up'`) and `selectUpWithSubtree(session, path, source)`.
- **The viewport**, with one active tool.

Host pages extend it in two ways:
- **Panels:** add your own through the `toolbar`, `left`, `right` and `bottom` slots.
- **Events:** listen to the session's events, which the element mirrors: `stageopen`, `stageloaded` (every prim has been sent once; large stages appear page by page in between), `selectionchange`, `primschange`, `dirtychange`, `diskchange`, `livechange`, `changedprims`, and more. The element adds its own: `camerachange`, `cameraschange`, `sectionchange`, `sectiongizmochange`, `toolchange` and others.

The rule for every module: change the stage through `viewer.usd`, then let the core's render delta move the three.js objects. Never edit three.js objects to represent stage state. `web/src/protocol.ts` is the contract between the page and the core.

## Main API

| Member | Purpose |
|---|---|
| `viewer.usd.*` | Stage queries and undoable edits: `children`, `prim`, `bounds`, `attribute`, `attributeHead`, `find`, `subtree`, `xformInfo(s)`, `setAttribute`, `clearAttribute`, `setXform(s)`, `setVisible`, `setVariant`, `setPayloadLoaded`, `setRefinement`, `hide`, `isolate`, `showAll`, `clearPrimEdits`, `layers`, `setEditTarget`, `exportLayer`, `exportPrim`, `exportVariants`, `meshMap`, `reload`. `prim` leaves numeric array values out (`null`); `attribute` fetches one, `attributeHead` only its first 16 values (`{ length, head }`), `bounds` the world bounds; `meshMap(rid)` maps a drawn mesh's triangles to the polygons they came from (its own faces, or a refined surface's), its vertices to the mesh's (`weld`) and, for static meshes whose coincident points draw as one vertex, each authored point to the vertex that draws it (`points`; `null` when every point is its own vertex); `exportVariants` writes the stage flattened as shown, as usdc, with a variant set of primvar and material overrides on chosen prims (`MeshMap`, `ExportVariantsSpec` in `protocol.ts`). `importLayer(name, usdaOrBytes)` replaces a layer's content in place (not undoable) |
| `live` | The [live link](live.md): `connect(relayUrl)`, `disconnect()`, `connected`, `id` |
| `open(source)`, `close()`, `save()` | Open a URL, files or a picked folder; save the dirty layers |
| `select(paths, { active, reveal, frame })`, `selection`, `active`, `frame(paths)`, `pick(x, y)` | Selection and framing; `frame()` without paths frames the stage and the shown `three.overlay` objects, except those with `userData.frame = false` (a ground grid, say; they still count for the clip planes) |
| `highlight = { color, opacity }` | Fill of the selected prims (`#rrggbb`, 0 to 1). Page-wide: every viewer on the page shares it |
| `undo()`, `redo()`, `dirty` | Undo history, unsaved state |
| `tool` | `'select' \| 'translate' \| 'rotate' \| 'scale' \| 'navigate'` |
| `displayMode`, `sky`, `backgroundColor`, `cameraSettings`, `purposes`, `panels`, `exposure`, `toneMapping`, `autoLoadArrays` | View settings; `backgroundColor = 'transparent'` lets the page show through |
| `time`, `play()`, `pause()`, `camera` | Animation, and the stage camera looked through (`null`: the free camera) |
| `cameras`, `view` | `cameras`: the stage's cameras (`path`, the lens as Hydra gives it, 0.1 x the authored focal length and apertures, and the stage-space world matrix); `cameraschange` fires when the list may have changed. `view` gets or sets the free view in world space (`{ eye, target, fov, projection, height }`: vertical fov in degrees, orthographic half-height); setting it leaves a stage camera and orbiting goes on from there |
| `section`, `sectionchange` | Clipping planes and boxes, view only: the GPU discards what they hide, while the stage, its objects and the shadows stay whole. Stage space (stage units and axes; vertical is the stage's up axis): `{ on, planes: [{ point, normal }], boxes: [{ keep: 'inside' \| 'outside', corners, bottom, top }] }`. A point shows when every plane keeps it (the side its normal points to), no `'outside'` box holds it and, when there are `'inside'` boxes, one of them does. A box is a vertical prism: 4 footprint `corners` (`[x, y, z]`, any simple quad, concave too; their up coordinate is ignored) between the heights `bottom` and `top`. At most 8 planes and 8 boxes. Setting replaces the whole section, cleaned (unusable entries dropped, footprints turned counter-clockwise seen from above; read it back); `on: false` keeps the entries but shows everything. Back faces show flat grey while a section is on. The first section on a page builds the sectioned materials in the background where the browser has `scheduler.yield` (Chrome, Edge) and at once elsewhere; the view keeps its last frame until they are ready, and `screenshot()` waits for them. `sectionchange` (`detail.source`: `'api'`, `'gizmo'`, `'ui'` or `'stage'`) fires when it changed; opening a stage clears it. Not the camera's near / far clipping (`cameraSettings`) |
| `sectionGizmo`, `sectiongizmochange`, `sectionGizmoAt(x, y)` | The section entries selected in the view, or `null`. Every entry shows its outline and dots (see `sectionHandles`): a click on a dot or outline selects it, Shift or Ctrl+click adds or removes it, a click on anything else selects none, Esc clears a box's chosen dots (and with none chosen selects none), Del removes the selected entries (source `'ui'`), and a right click opens a menu for them (Flip, Show inside / Cut out, Delete); not in the navigate tool. Like prims, they follow the tool: the Move tool's arrows move them, the Rotate tool's rings turn them, Select and Scale show no gizmo. Prims and sections are never selected together: selecting one clears the other. `{ plane: i }`: a plane (its dot sits in the middle of its outline, where the stage's centre falls on it, wherever its `point` lies; the gizmo sits there). `{ box: i, handles }`: a box with its chosen dots (0-3 the footprint corners in `corners` order, each the top and bottom of one vertical edge, 4 the bottom face, 5 the top face; sorted, `[]` after Esc cleared them). `rotate` in these one-entry values is `true` while the tool is Rotate (then a box's value has no `handles`). Several entries read back as `{ planes: [i, ...], boxes: [{ box: i, handles }, ...] }`. Move moves the chosen dots together: corners only in plan, faces only up and down, planes by the part of the move along their normals (a plane alone only along its normal). Rotate turns the entries about the middle of the planes' dots and the boxes' middles: a plane alone tilts about its dot, and with a box only about the up axis. A step that would make a footprint cross itself or bring a top below its bottom is refused. Setting it selects afresh with the given `handles` chosen (integers 0-5; anything else in the array is ignored), or with every dot chosen when a box has no `handles`, so setting a value read earlier brings the same choice back; indices the section lacks are left out. Setting it also clears the prim selection and switches `tool` to `'rotate'` with `rotate: true`, otherwise to `'translate'` unless it is `'translate'` or `'rotate'` already; `null` or losing the entries lets go of them, other tools keep them. It keeps its indices when the section is replaced, so a host that removes an earlier entry sets it again. It changes only `section` (source `'gizmo'`), never the stage, also when `readonly`. `sectiongizmochange` fires when the value changed: the entries, the choice (a click, Shift or Ctrl+click, Esc or Del) and the tool's `rotate`. `sectionGizmoAt(clientX, clientY)` is true over a dot, an outline or a gizmo axis (or while one is dragged): a host's own pointer handling yields to the gizmo there |
| `sectionHandles` | `true` (default): every section entry shows its outline and dots while the section is on, and a click selects it. `false`: only the selected entries show them (the Section menu's Hide handles); setting it to `false` selects none |
| `stats` | USD counts of what is drawn, plus `fps` / `frameMs` |
| `three` | For hosts that draw on top: `renderer`, `scene`, `root` (the stage objects), `camera` (read it again each time: it changes with the projection and stage cameras; see layer 31 below); `overlay`, a group for host objects that are framed and clipped with the stage but never picked; `beforeRender`, a set of per-frame hooks; `items()`, the render items (`rid`, `path`, `kind`, `object`, `instances`); `objectsFor(path)`; `materials(rid)`, a mesh item's materials as the shaded view draws them (also while a plain view shows); `invalidate()` (the view renders on demand). Static meshes that share a look are drawn by shared `THREE.BatchedMesh` children of `root` (no rid; never picked, framed or measured): their own objects then draw nothing (an invisible material) but keep their geometry, so raycasts, bounds and clones still work. Read their look with `materials(rid)`; setting their `visible` or `material` has no effect (visibility goes through the stage) |
| `three.section(material)`, `three.keeps(point)` | Only NodeMaterials are sectioned. The viewer's own are, so overlay objects drawn with a viewer material are cut too; a host material drawn under `three.root` must be registered with `three.section(material)` (returns it; anything else is refused with a warning). `three.keeps(point)`: false where the section cuts a three-world point away, to filter a host's own raycast hits (`pick()` already goes on to what is behind) |
| `registerScheme(scheme, { gateway, getAuth })` | Route a URL scheme through an HTTP gateway (see below) |
| `showHelp()`, `screenshot()` | Help window, image of the view (without the helpers on layer 31) |

**Layer 31** holds the viewer's helpers (the section gizmo: its arrows, rings, outline and dots), drawn only in the view. The view's cameras, `three.camera` included, see layers 0 and 31; `screenshot()` renders without 31. A host's capture with its own camera leaves them out too, since a new camera sees layer 0 only; one that renders through `three.camera` must `camera.layers.disable(31)` for that render. Hosts keep their own objects off layer 31.

## Asset sources

The viewer reads assets from three kinds of source:
- dropped files and folders;
- `http(s)` URLs;
- URL schemes routed through an HTTP gateway:

```js
viewer.registerScheme('omniverse', { gateway: 'https://gateway.example/v1', getAuth: () => 'Bearer …' });
viewer.open('omniverse://server/Projects/scene.usd');
```

The core then reads every `omniverse://` asset as `GET <gateway>/read?url=<asset url>`. This is the hook for the planned Nucleus gateway: a native service linking the Omniverse Client Library, which cannot run in a browser.
