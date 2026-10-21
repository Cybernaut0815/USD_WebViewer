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

- **Cross-origin isolation.** The page, the worker script and the wasm must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, because the core uses threads. Hosts that cannot send headers can load `coi-serviceworker.min.js` first, as `web/index.html` does.
- **The `core/` directory** (`worker.js`, `usdcore.js`, `usdcore.wasm`, from `web/public/core`) is served from the page's origin. If it is not next to the page, point the `core-url` attribute at it.
- **The `skies/` directory** (`web/public/skies`) is served the same way. If it is elsewhere, point the `skies-url` attribute at it.
- **Assets on other origins** need CORS headers.

## Attributes

| Attribute | Meaning |
|---|---|
| `src` | URL of the stage to open |
| `core-url`, `skies-url` | Where the core and the skies are served (default: `core/`, `skies/` next to the page) |
| `panels="none"` | Viewport only: no toolbar, panels or overlays |
| `readonly` | No edits from the view: of the keys only F and H / Shift+H / Alt+H work (hiding writes the session layer, never saved), the Move / Rotate / Scale tools are off, no prim menu, no drop-to-open. Selection and navigation stay. The panels still edit, so pair it with `panels="none"` |
| `force-webgl` | Use the WebGL2 backend even where WebGPU is available |

## Structure

The element is a thin layout around two reusable parts:
- **`viewer.session`**, a `UsdSession`. It holds the core connection, the stage, selection, locks, time, the undo history, dirty layers and change markers. It touches no DOM. A host's own hierarchy can select exactly like the viewer's with the exported `modifySelect(session, paths, mode, source)` (`'replace'`, `'add'`, `'remove'`, `'up'`) and `selectUpWithSubtree(session, path, source)`.
- **The viewport**, with one active tool.

Host pages extend it in two ways:
- **Panels:** add your own through the `toolbar`, `left`, `right` and `bottom` slots.
- **Events:** listen to the session's events, which the element mirrors: `stageopen`, `stageloaded` (every prim has been sent once; large stages appear page by page in between), `selectionchange`, `primschange`, `dirtychange`, `diskchange`, `changedprims`, and more. The element adds its own: `camerachange`, `cameraschange`, `toolchange` and others.

The rule for every module: change the stage through `viewer.usd`, then let the core's render delta move the three.js objects. Never edit three.js objects to represent stage state. `web/src/protocol.ts` is the contract between the page and the core.

## Main API

| Member | Purpose |
|---|---|
| `viewer.usd.*` | Stage queries and undoable edits: `children`, `prim`, `bounds`, `attribute`, `attributeHead`, `find`, `subtree`, `xformInfo(s)`, `setAttribute`, `clearAttribute`, `setXform(s)`, `setVisible`, `setVariant`, `setPayloadLoaded`, `setRefinement`, `hide`, `isolate`, `showAll`, `clearPrimEdits`, `layers`, `setEditTarget`, `exportLayer`, `exportPrim`, `exportVariants`, `meshMap`, `reload`. `prim` leaves numeric array values out (`null`); `attribute` fetches one, `attributeHead` only its first 16 values (`{ length, head }`), `bounds` the world bounds; `meshMap(rid)` maps a drawn mesh's triangles to the polygons they came from (its own faces, or a refined surface's); `exportVariants` writes the stage flattened as shown, as usdc, with a variant set of primvar and material overrides on chosen prims (`MeshMap`, `ExportVariantsSpec` in `protocol.ts`). |
| `open(source)`, `close()`, `save()` | Open a URL, files or a picked folder; save the dirty layers |
| `select(paths, { active, reveal, frame })`, `selection`, `active`, `frame(paths)`, `pick(x, y)` | Selection and framing; `frame()` without paths frames the stage and the shown `three.overlay` objects, except those with `userData.frame = false` (a ground grid, say; they still count for the clip planes) |
| `highlight = { color, opacity }` | Fill of the selected prims (`#rrggbb`, 0 to 1). Page-wide: every viewer on the page shares it |
| `undo()`, `redo()`, `dirty` | Undo history, unsaved state |
| `tool` | `'select' \| 'translate' \| 'rotate' \| 'scale' \| 'navigate'` |
| `displayMode`, `sky`, `backgroundColor`, `cameraSettings`, `purposes`, `panels`, `exposure`, `toneMapping`, `autoLoadArrays` | View settings; `backgroundColor = 'transparent'` lets the page show through |
| `time`, `play()`, `pause()`, `camera` | Animation, and the stage camera looked through (`null`: the free camera) |
| `cameras`, `view` | `cameras`: the stage's cameras (`path`, the lens as Hydra gives it, 0.1 x the authored focal length and apertures, and the stage-space world matrix); `cameraschange` fires when the list may have changed. `view` gets or sets the free view in world space (`{ eye, target, fov, projection, height }`: vertical fov in degrees, orthographic half-height); setting it leaves a stage camera and orbiting goes on from there |
| `stats` | USD counts of what is drawn, plus `fps` / `frameMs` |
| `three` | For hosts that draw on top: `renderer`, `scene`, `root` (the stage objects), `camera` (read it again each time: it changes with the projection and stage cameras); `overlay`, a group for host objects that are framed and clipped with the stage but never picked; `beforeRender`, a set of per-frame hooks; `items()`, the render items (`rid`, `path`, `kind`, `object`, `instances`); `objectsFor(path)`; `materials(rid)`, a mesh item's materials as the shaded view draws them (also while a plain view shows); `invalidate()` (the view renders on demand) |
| `registerScheme(scheme, { gateway, getAuth })` | Route a URL scheme through an HTTP gateway (see below) |
| `showHelp()`, `screenshot()` | Help window, image of the view |

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
