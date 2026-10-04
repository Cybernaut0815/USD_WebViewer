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
| `force-webgl` | Use the WebGL2 backend even where WebGPU is available |

## Structure

The element is a thin layout around two reusable parts:
- **`viewer.session`**, a `UsdSession`. It holds the core connection, the stage, selection, locks, time, the undo history, dirty layers and change markers. It touches no DOM.
- **The viewport**, with one active tool.

Host pages extend it in two ways:
- **Panels:** add your own through the `toolbar`, `left`, `right` and `bottom` slots.
- **Events:** listen to the session's events, which the element mirrors: `stageopen`, `stageloaded` (every prim has been sent once; large stages appear page by page in between), `selectionchange`, `primschange`, `dirtychange`, `diskchange`, `changedprims`, and more.

The rule for every module: change the stage through `viewer.usd`, then let the core's render delta move the three.js objects. Never edit three.js objects to represent stage state. `web/src/protocol.ts` is the contract between the page and the core.

## Main API

| Member | Purpose |
|---|---|
| `viewer.usd.*` | Stage queries and undoable edits: `children`, `prim`, `bounds`, `attribute`, `find`, `subtree`, `xformInfo(s)`, `setAttribute`, `clearAttribute`, `setXform(s)`, `setVisible`, `setVariant`, `setPayloadLoaded`, `setRefinement`, `hide`, `isolate`, `showAll`, `clearPrimEdits`, `layers`, `setEditTarget`, `exportLayer`, `exportPrim`, `reload`. `prim` leaves numeric array values out (`null`); `attribute` fetches one, `bounds` the world bounds. |
| `open(source)`, `close()`, `save()` | Open a URL, files or a picked folder; save the dirty layers |
| `select(paths, { active, reveal, frame })`, `selection`, `active`, `frame(paths)`, `pick(x, y)` | Selection and framing |
| `undo()`, `redo()`, `dirty` | Undo history, unsaved state |
| `tool` | `'select' \| 'translate' \| 'rotate' \| 'scale' \| 'navigate'` |
| `displayMode`, `sky`, `backgroundColor`, `cameraSettings`, `purposes`, `panels`, `exposure`, `toneMapping` | View settings |
| `time`, `play()`, `pause()`, `camera` | Animation and stage cameras |
| `stats` | USD counts of what is drawn, plus `fps` / `frameMs` |
| `three` | The renderer, scene, root group and camera, for hosts that draw on top |
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
