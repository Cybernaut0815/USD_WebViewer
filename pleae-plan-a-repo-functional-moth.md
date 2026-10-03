# USD Web Viewer: repository plan

## Context

New repository at `F:\Github\USD_web_viewer` (empty, not yet a git repo): a browser viewer for OpenUSD files with a C++/WASM core. It must render meshes, subdivision surfaces, curves, points, materials and UsdLux lights; show a hierarchy panel and a property panel that stay in sync with viewport picking; and expose a typed JS/TS API to host pages. Viewer only for now. Later stage: open assets from an NVIDIA Omniverse Nucleus server.

What the research found (October 2026) and why the plan looks the way it does:

- Official OpenUSD 26.08 builds for wasm32 with Emscripten (pthreads, oneTBB, static libs). Pixar's script builds only core USD, but Hydra and usdImaging compile with GPU support off plus two small patches (usd-wg-webview and Needle both ship this).
- Hydra Storm in the browser is not upstream (HgiWebGPU is open PR #4146; the Autodesk fork is 70-90 MB with gaps in subdivision, curves and picking). Rejected.
- Every existing viewer misses part of the brief: Needle (noncommercial licence, no curves), usd-wg-webview (no subdivision), Babylon loader (no lights, curves, subdivision), LightUSD (own composition engine), three.js USDLoader (partial composition).
- Legacy `UsdImagingDelegate` is deprecated, so the core is Hydra 2 native (scene indices). Nobody has shipped that on the web yet.
- The Omniverse Client Library is binary-only (Windows/Linux x64, native sockets) and cannot run in WASM. Nucleus itself is in maintenance mode.

Decisions (confirmed with the owner):

| Topic | Decision |
|---|---|
| Renderer | three.js 0.186.1 `WebGPURenderer` (automatic WebGL2 fallback) on the main thread, fed by the C++ core |
| Core | OpenUSD 26.08 + Hydra 2 scene indices + OpenSubdiv 3.6.1 (CPU) + MaterialX 1.39.5 / hdMtlx, Emscripten 5.0.7 (the version Pixar tests), wasm32, pthreads |
| Hosting model | One wasm module inside a dedicated Web Worker; promise RPC over `postMessage`; typed arrays copied out of the heap once, then transferred |
| UI | HTML + TypeScript, no framework, packaged as a `<usd-viewer>` custom element |
| Nucleus | Later: native C++ gateway in this repo linking the Omniverse Client Library. The viewer reaches it over HTTPS through a URL-scheme table that exists from day one |

## Architecture

```
Page, main thread (TypeScript)                       Web Worker: usdcore.wasm (C++)
+-------------------------------------+   RPC      +------------------------------------------+
| <usd-viewer>                        | ---------> | bindings.cpp     embind free functions   |
|  tree.ts    hierarchy panel         |            | stage.cpp        UsdStage, queries, edits|
|  props.ts   property panel          |  delta     | sceneBridge.cpp  Hydra 2 observer        |
|  viewport.ts three.js WebGPU/WebGL2 | <--------- | geometry.cpp     triangulate, subdivide, |
|  scene.ts / materials.ts            | (transfer) |                  curves, instancing      |
|  rpc.ts                             |            | webResolver.cpp  http + scheme table     |
+-------------------------------------+            +------------------------------------------+
                                                       | sync fetch                | later
                                                   http(s) assets        Nucleus gateway (native C++,
                                                                         Omniverse Client Library)
```

Data flow: `UsdStage` -> `UsdImagingSceneIndex` -> filtering scene indices -> `SceneBridge` (observer) -> render delta (refined meshes, tessellated curves, points, instance matrices, material networks, lights, cameras) -> worker glue -> `SceneSync` builds three.js objects. Queries for the panels go straight to the `UsdStage` through the same RPC.

## Repository layout

```
sdk/CMakeLists.txt               superbuild: oneTBB, OpenSubdiv, MaterialX, OpenUSD as wasm32 static libs
sdk/patch.cmake                  two source patches + MaterialX stdlib prune
native/CMakeLists.txt            target usdcore: find_package(pxr), whole-archive link, embedded resources, flags,
                                 post-build copy into web/public/core/
native/plugInfo.json             registers WebResolver
native/src/bindings.cpp          EMSCRIPTEN_BINDINGS: the whole core API, init, diagnostics
native/src/stage.{h,cpp}         stage ownership, hierarchy/detail JSON, VtValue<->JSON, session-layer edits
native/src/sceneBridge.{h,cpp}   scene-index chain, prim records, dirty tracking, flush to delta
native/src/geometry.{h,cpp}      pure functions: triangulation, subdivision, normals, curves, instance matrices
native/src/webResolver.{h,cpp}   ArResolver: http fetch, scheme-to-gateway table, URL anchoring
native/test/smoke.mjs            node self-check, assert-based, inline usda
web/package.json  tsconfig.json  vite.config.ts  playwright.config.ts  index.html
web/public/core/worker.js        worker glue (plain JS): loads usdcore.js, dispatches RPC, mounts dropped files
web/public/core/usdcore.{js,wasm}   build output, gitignored
web/public/coi-serviceworker.min.js  _headers      cross-origin isolation for static hosts
web/src/protocol.ts              the contract: RPC + render-delta types (hand-written, single source of truth)
web/src/rpc.ts                   CoreClient: worker lifecycle, promise RPC, error mapping
web/src/files.ts                 drag-and-drop / folder collection, root-layer choice, texture byte lookup
web/src/scene.ts                 SceneSync.apply(delta): registry by rid, meshes, instances, curves, points, lights, cameras, disposal
web/src/materials.ts             UsdPreviewSurface -> TSL, MaterialX, texture cache, ribbon/point/highlight materials
web/src/units.ts                 pure functions: light units, camera frustum, up axis, dome rotation
web/src/viewport.ts              renderer, on-demand loop, controls, picking, highlight, environment, frame pump
web/src/tree.ts  props.ts        hierarchy panel, property panel
web/src/viewer.ts  viewer.css    UsdViewerElement: layout, toolbar, timeline, selection store, public API
web/src/index.ts                 exports + customElements.define('usd-viewer')
web/test/*.test.ts               node --test (units, rpc, tree windowing)
web/e2e/viewer.spec.ts  e2e/mock-core/worker.js  e2e/fetch-assets.mjs
gateway/CMakeLists.txt  gateway/main.cpp           later stage
.github/workflows/ci.yml   README.md   .gitignore
```

Outside the repo (short paths, all on F: because C: has 35 GB free): `F:\emsdk` (toolchain), `F:\uw\b` (SDK build tree, 5-8 GB), `F:\uw\sdk` (SDK prefix), `F:\uw\core` (core build tree).

## Toolchain and SDK build

Pins: emsdk 5.0.7, oneTBB 2021.12.0, OpenSubdiv 3.6.1, MaterialX 1.39.5, OpenUSD 26.08 (archive URLs as in OpenUSD's `build_scripts/build_usd.py`; add `URL_HASH SHA256` after the first download).

`build_usd.py` is not used: for wasm it refuses MaterialX and usdImaging and hard-codes `.bat` launchers. `sdk/CMakeLists.txt` is a `project(sdk NONE)` superbuild with four chained `ExternalProject_Add` calls, identical on Windows and Linux.

Common arguments (through `CMAKE_CACHE_ARGS`; `<P>` = prefix with forward slashes):
`-G Ninja -DCMAKE_TOOLCHAIN_FILE=$ENV{EMSDK}/upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=<P> -DCMAKE_PREFIX_PATH=<P> -DCMAKE_FIND_ROOT_PATH=<P> -DBUILD_SHARED_LIBS=OFF`

| Dependency | Extra arguments |
|---|---|
| oneTBB | `-DTBB_TEST=OFF -DTBB_STRICT=OFF`, C/CXX flags `-pthread --use-port=zlib` |
| OpenSubdiv | `-DNO_EXAMPLES=ON -DNO_TUTORIALS=ON -DNO_REGRESSION=ON -DNO_DOC=ON -DNO_OMP=ON -DNO_CUDA=ON -DNO_OPENCL=ON -DNO_DX=ON -DNO_TESTS=ON -DNO_GLEW=ON -DNO_GLFW=ON -DNO_PTEX=ON -DNO_TBB=ON -DNO_METAL=ON -DNO_OPENGL=ON`, same flags |
| MaterialX | `-DMATERIALX_BUILD_SHARED_LIBS=OFF -DMATERIALX_BUILD_GEN_GLSL=ON` (one generator must stay on or the stdlib is not installed), `GEN_OSL/MDL/MSL/SLANG=OFF`, `-DMATERIALX_BUILD_RENDER=OFF -DMATERIALX_BUILD_TESTS=OFF`, CXX flags `-pthread -fexceptions` |
| OpenUSD | `-DPXR_BUILD_IMAGING=ON -DPXR_BUILD_USD_IMAGING=ON -DPXR_ENABLE_GL_SUPPORT=OFF -DPXR_ENABLE_METAL_SUPPORT=OFF -DPXR_ENABLE_VULKAN_SUPPORT=OFF -DPXR_ENABLE_MATERIALX_SUPPORT=ON -DMaterialX_DIR=<P>/lib/cmake/MaterialX -DPXR_FIND_TBB_IN_CONFIG=ON -DPXR_ENABLE_PYTHON_SUPPORT=OFF` and OFF for: tests, examples, tutorials, tools, validation, docs, usdview, Ptex, OpenVDB, Embree, Prman, OpenImageIO, OpenColorIO, Alembic, Draco; C/CXX flags `-pthread --use-port=zlib`, exe linker flags `-pthread` |

With GL/Metal/Vulkan off, Storm, hdx, hgiGL, glf, garch and usdImagingGL skip themselves. Built: hd, hdsi, hdar, hdGp, hdMtlx, hio (+OpenEXR, AVIF), pxOsd, geomUtil, cameraUtil, usdImaging, usdSkelImaging, usdVolImaging, usdProcImaging, usdShaders, sdrGlslfx, usdMtlx.

Patches (`sdk/patch.cmake`, string replacement that fails loudly if the pattern is gone):

| File | Change | Reason |
|---|---|---|
| OpenUSD `pxr/imaging/hgi/hgi.cpp` | delete `#error Unknown Platform` (line 198), keep `return nullptr` | hgi has no CMake gate and no Emscripten branch |
| MaterialX `cmake/modules/MaterialXConfig.cmake.in` | `if(UNIX AND NOT APPLE)` -> `... AND NOT EMSCRIPTEN` | toolchain sets UNIX, X11 lookup fails |
| after MaterialX install | remove `<P>/libraries/*/gen*` and `<P>/libraries/targets` | usdMtlx embeds the whole stdlib; only `.mtlx` definitions are needed |

Windows (cmd.exe):
```
git clone https://github.com/emscripten-core/emsdk F:\emsdk
F:\emsdk\emsdk.bat install 5.0.7 && F:\emsdk\emsdk.bat activate 5.0.7
F:\emsdk\emsdk_env.bat
set CMAKE_BUILD_PARALLEL_LEVEL=8
cmake -S sdk -B F:\uw\b -G Ninja -DSDK_PREFIX=F:/uw/sdk && cmake --build F:\uw\b
emcmake cmake -S native -B F:\uw\core -G Ninja -DSDK_PREFIX=F:/uw/sdk && cmake --build F:\uw\core
```
`native/CMakeLists.txt` derives `pxr_DIR`, `CMAKE_PREFIX_PATH`, `CMAKE_FIND_ROOT_PATH` and `MaterialX_DIR` from `SDK_PREFIX`. Always run `emsdk_env.bat` first so emcc uses its bundled Python, not system Python 3.14. 15.8 GB RAM: keep `-j8`, dev links at `-O1`. Estimated SDK build 45-75 minutes.

Fallback if the native Windows SDK build fails (Pixar tests wasm only on Ubuntu): the CI job builds the SDK on ubuntu-22.04 and publishes `usd-wasm-sdk-26.08-em5.0.7.tar.zst`; wasm static libs and CMake configs are host-independent, so extract it into `F:\uw\sdk` and build only `native/` locally. Second fallback: `wsl --install -d Ubuntu-22.04` and run the same commands.

## C++ core (`native/`)

Link pattern (no public OpenUSD helper exists; mirrors Pixar's `wasmFetchResolver` example):
- every `PXR_LIBRARIES` entry linked with `-Wl,--whole-archive` (otherwise plugin and type registry functions are stripped; usdShaders and sdrGlslfx are included, which avoids the known blank-UsdPreviewSurface pitfall);
- strip the inherited per-file `--embed-file` options from each target's `INTERFACE_LINK_OPTIONS` and embed the directory once: `--embed-file <P>/lib/usd@/usd` (hundreds of per-file flags overflow the Windows command line);
- `--embed-file native/plugInfo.json@/usd/webResolver/resources/plugInfo.json`.

Flags: compile `-pthread -fexceptions` (must match the SDK). Link `-pthread -fexceptions -lembind -lworkerfs.js --no-entry -sMODULARIZE -sEXPORT_ES6 -sENVIRONMENT=worker,node -sALLOW_MEMORY_GROWTH -sINITIAL_MEMORY=256MB -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB -sDEFAULT_PTHREAD_STACK_SIZE=2MB -sPTHREAD_POOL_SIZE=8 -sFETCH -sFETCH_SUPPORT_INDEXEDDB=0 -sEXPORTED_RUNTIME_METHODS=FS`; release `-O2`, dev `-O1 -sASSERTIONS=1 -sSTACK_OVERFLOW_CHECK=2`. No LTO, no closure, no Asyncify/JSPI.

File and network access:
- Dropped files and folders: `worker.js` mounts the `File` objects with Emscripten WORKERFS at `/drop/<n>/` (`FS.mount(FS.filesystems.WORKERFS, {blobs:[{name, data}]}, dir)`). Lazy, no upfront copy, plain filesystem paths, so `ArDefaultResolver` semantics (relative references, usdz) apply unchanged. Fallback if WORKERFS misbehaves under pthreads: a resolver-owned in-memory store.
- `WebResolver : ArDefaultResolver`, made primary with `ArSetPreferredResolver("WebResolver")`. Paths without a scheme go to the base class. `http(s)://` is read with synchronous `emscripten_fetch` (allowed on worker threads) into `ArInMemoryAsset`. Any other scheme is looked up in a table filled by `registerScheme(scheme, httpBase, authHeader)` and read as `GET <httpBase>/read?url=<encoded>`: this is the Nucleus seam. `_Resolve` is the identity for URLs (no extra round trips); `_CreateIdentifier` does RFC 3986 anchoring; a `weak_ptr` cache keeps http `.usdz` packages open; `ArResolverScopedCache` wraps `openStage`, `flush`, `readAsset`.

Scene-index chain (built once; stage set afterwards so the observer sees `PrimsAdded`):
```
UsdImagingSceneIndex::New(args{addDrawModeSceneIndex}, nullptr)      // UsdImagingCreateSceneIndices is deprecated in 26.08
-> HdsiImplicitSurfaceSceneIndex (cube, sphere, cone, cylinder, capsule, plane to mesh)
-> HdsiNurbsApproximatingSceneIndex -> HdsiTetMeshConversionSceneIndex
-> HdSiExtComputationPrimvarPruningSceneIndex    // skinning results become ordinary primvars
-> HdsiPinnedCurveExpandingSceneIndex -> HdsiVelocityMotionResolvingSceneIndex
-> HdsiMaterialBindingResolvingSceneIndex ({preview, allPurpose}) -> HdsiMaterialPrimvarTransferSceneIndex
-> HdDependencyForwardingSceneIndex              // required: several filters above declare dependencies only
-> HdsiPrimManagingSceneIndexObserver (factory = SceneBridge)
```
`UsdImagingSceneIndex` already contains flattening, native and point instancer propagation, draw modes, material binding resolution, usdSkelImaging resolving and the selection scene index.

`SceneBridge` (observer, not a render delegate: no `HdRenderIndex`, tasks or Rprim classes):
- The factory creates a record for `mesh`, `basisCurves`, `points`, `geomSubset`, `instancer`, `material`, `camera` and light types, assigns a `uint32` rid, and queues it as added. Record destruction queues the rid as removed. `_Dirty` unions the dirtied `HdDataSourceLocatorSet`.
- Dependencies: a geomSubset marks its parent mesh topology dirty; an instancer marks its dependents' instances dirty (transitively for nesting).
- `flush(maxItems)`: `ApplyPendingUpdates()`, propagate dependencies, convert materials, lights and cameras, convert up to `maxItems` geometry records with `WorkParallelForN` into plain structs, compute instance matrices, build the JS delta on the calling thread, return `more: true` if records remain.
- Locator dispatch: `xform` and `visibility` go to packed channels; `primvars/points` gives a points-only update; `mesh` gives a geometry rebuild; `materialBindings` a binding update; instancer `instancerTopology`/`primvars`/`xform` a matrix recompute; unknown or empty locator a full rebuild of that record.

Conversions (`geometry.cpp`, pure functions):
- Mesh: `HdMeshTopology` from `HdMeshSchema` + `HdSubdivisionTagsSchema`. If the scheme is catmullClark or loop and refine level > 0: `PxOsdRefinerFactory::Create`, `RefineUniform`, `Far::PrimvarRefiner` (`Interpolate`, `InterpolateVarying`, `InterpolateFaceVarying`, `Limit` for positions and normals). Triangulate with `HdMeshUtil::ComputeTriangleIndices`. Layout is per-vertex when no primvar is faceVarying or uniform, otherwise one vertex per face-vertex. Normals: authored, else `Hd_SmoothNormals`, else limit normals when refined, else omitted (three.js flat shading). GeomSubsets become contiguous index ranges with material rids.
- Curves: `HdBasisCurvesTopologySchema`; tessellate linear and cubic (bezier, bspline, catmullRom; periodic, nonperiodic; pinned already expanded) into polylines with `4 << refineLevel` samples per segment; emit points, counts, widths, optional normals.
- Points: positions, widths, colour.
- Instancers: port of `HdEmbreeInstancer::ComputeInstanceTransforms` reading `hydra:instanceTransforms/Translations/Rotations/Scales`; nested levels flattened; native instancing arrives as ordinary instancers.
- Materials: universal-context network emitted as generic JSON (nodes, authored parameters, connections, resolved asset paths); TypeScript owns UsdPreviewSurface semantics and defaults. If an `mtlx`-context terminal exists: `HdMtlxCreateMtlxDocumentFromHdMaterialNetworkInterface` + `mx::writeToXmlString`. Both are sent when both exist.
- Lights: Hydra prim type is the light type; `HdLightTokens` read explicitly (intensity, exposure, normalize, colour with colour temperature applied, sizes, shaping, shadow enable, dome texture and format). Cameras: `HdCameraSchema`.
- Selection: `setSelection` calls `ClearSelection`/`AddSelection`; prims whose `selections` locator changes are reported in the delta. Pick resolution ports `HdxPrimOriginInfo::FromPickHit`.

Core API (embind free functions, one global app instance, no JS-managed C++ lifetimes; every string return is JSON):

| Group | Functions |
|---|---|
| Lifecycle | `init(threads)`, `warmThreads()`, `registerScheme(scheme, httpBase, authHeader)`, `takeDiagnostics()` |
| Stage | `openStage(url, loadPayloads)` -> stage info (up axis, metersPerUnit, time range, timeCodesPerSecond, default prim, layer stack, errors); `closeStage()`, `reloadStage()` |
| Queries | `primChildren(path)`, `primDetails(path, time)`, `attributeValue(path, name, time)`, `findPrims(text, typeName, limit)`, `readAsset(resolvedPath)` -> `Uint8Array` |
| Render | `setTime(t)`, `setRefineLevel(n)`, `flush(maxItems)` -> render delta, `setSelection(paths)`, `resolvePick(rid, instanceIndex)` |
| Session-layer edits | `setVariant`, `setVisible`, `setLoaded`, `setAttribute(path, name, jsonValue, time)`, `clearSessionEdits()`; each returns the resynced paths |

## Web side (`web/`)

Contract (`web/src/protocol.ts`): transport `{id, method, args}` -> `{id, result | error, log}`. Render delta rules: an omitted field means unchanged; `path` is present only when the entry creates the item; a vertex-count or index-count change carries the complete stream set; every typed array is a fresh buffer and is transferred.

```ts
interface RenderDelta {
  more?: boolean;
  removed?: Uint32Array;
  materials?: { rid: number; path: string; network?: object; mtlx?: string }[];          // applied first
  meshes?:  { rid; path?; purpose?; indices?; positions?; normals?; primvars?; subsets?; material?;
              displayColor?; displayOpacity?; doubleSided?; extent?; instances?: Float32Array | null }[];
  curves?:  { rid; path?; purpose?; points?; counts?; widths?; normals?; colors?; material? }[];
  points?:  { rid; path?; purpose?; points?; widths?; colors? }[];
  lights?:  { rid; path?; type; params }[];
  cameras?: { rid; path?; params }[];
  xforms?:     { rids: Uint32Array; matrices: Float64Array };    // 16 per rid, USD row-major = THREE.Matrix4.elements order
  visibility?: { rids: Uint32Array; visible: Uint8Array };
  selected?:   { rid: number; instances?: Uint32Array }[];
}
```

Renderer mapping:

| USD | three.js | Notes |
|---|---|---|
| Mesh (incl. refined, skinned, implicit, draw-mode cards) | `Mesh` + `BufferGeometry`, `matrixAutoUpdate = false`; subsets as geometry groups + material array | same-count updates swap `attr.array`; count change builds a new geometry |
| Instancing (point, native, nested) | `InstancedMesh`, matrices from the delta | `intersection.instanceId` + `resolvePick` give the instance path |
| BasisCurves | camera-facing ribbon mesh, 2 vertices per point, expansion in a TSL `positionNode` (per-point widths; `Line2` cannot do that); no widths: 1 px `LineSegments` | custom `raycast` |
| Points | one `Sprite` with `count = n`, `SpriteNodeMaterial` with instanced position and width | custom `raycast` |
| UsdPreviewSurface | one `MeshPhysicalNodeMaterial`; constants as properties, connected inputs as TSL nodes (channel select, scale/bias, wrap, UsdTransform2d, per-texture primvar, specular workflow, clearcoat, ior, opacity threshold, normal, displacement, occlusion) | interpretation lives in `materials.ts`; reference: three.js `USDComposer.js` (MIT) |
| MaterialX | `MaterialXLoader.parse(xml, {uvSpace:'bottom-left', throwOnErrors:false})` with a `LoadingManager` handler that supplies decoded bitmaps | supports standard_surface, gltf_pbr, open_pbr_surface; fallback chain mtlx -> preview -> displayColor, warnings shown in the UI |
| Textures | `createImageBitmap` (pre-flipped) for png/jpeg/webp/avif; `EXRLoader`/`HDRLoader` for exr/hdr | bytes: dropped `File` directly, http via `fetch`, everything else (usdz members, gateway schemes) via `readAsset` |
| Unbound geometry | shared `MeshStandardNodeMaterial` reading displayColor/displayOpacity | |
| DistantLight / SphereLight / shaping cone | `DirectionalLight` / `PointLight` / `SpotLight` | formulas in `units.ts`: `L = intensity * 2^exposure`, normalize and size factors per the UsdLux schema, one named `LIGHT_CALIBRATION = 1` knob |
| RectLight / DiskLight / CylinderLight | `RectAreaLight` / equal-area `RectAreaLight` / `PointLight` | approximations: no area-light shadows, disk drawn square, cylinder as point |
| DomeLight | `scene.environment` + `background` (PMREM automatic), intensity, rotation | no lights in the stage: `RoomEnvironment` default |
| Camera | `PerspectiveCamera` / `OrthographicCamera` with custom projection (aperture offsets); free camera with `OrbitControls` | Z-up stages: root rotated -90 degrees about X |
| Purposes | per-item `purpose`, toggled on the page | default: default + proxy |
| Colour | linear Rec.709 working space, sRGB output, tone mapping Neutral (ACES, AgX, none selectable), exposure control | |

Runtime behaviour: render on demand (rAF only when invalidated). Frame pump keeps one `flush` in flight and the latest requested time wins, so playback drops frames instead of queueing. Picking: CPU `Raycaster` on click. Selection highlight: tinted overlay proxies sharing geometry (works on both backends; whole-scene outline pass deferred).

UI (`viewer.ts`, `tree.ts`, `props.ts`): CSS grid with toolbar, hierarchy, viewport, properties, timeline; native elements (`<details>`, `<select>`, `<dialog>`, `<input type=range>`, `<progress>`), side panels sized with CSS `resize`. All USD-derived strings go through `textContent`.
- Hierarchy: lazy `primChildren` per expand, windowed fixed-height rows (about 60 DOM rows at any stage size), type/payload/variant/instance badges, visibility toggle, search via `findPrims`, keyboard navigation.
- Properties: header (path, type, kind, specifier, purpose, visibility), variants, payload, transform, type-specific summary (mesh, curves, material, light, camera, instancer), attributes table (type, value, time-sampled and authored markers, connections), relationships, metadata, composition (prim stack, arcs).
- Selection store in `viewer.ts`: viewport click -> raycast -> `resolvePick` -> select; tree click -> select; every change reveals the tree row, refreshes properties, calls `setSelection`, fires `selectionchange`.
- Opening: file and folder drop (`webkitGetAsEntry` walk), file/folder pickers, URL dialog, `?src=`; `.usdz` handled by the core.

Public API (host pages): `<usd-viewer src core-url panels force-webgl>`; `ready`, `open(source, options)`, `close()`, `idle()`, `dispose()`, `selection`, `select()`, `frame()`, `pick()`, `time`, `play()`, `pause()`, `camera`, `exposure`, `toneMapping`, `screenshot()`, `registerScheme(scheme, {gateway, getAuth})`; namespaced stage access `viewer.usd.children/prim/attribute/find/setVariant/setVisible/setPayloadLoaded/setAttribute/setComplexity`; events `stageopen`, `stageclose`, `selectionchange`, `timechange`, `primschange`, `log`, `error`; escape hatch `viewer.three` (`renderer`, `scene`, `root`, `camera`, `objectsFor(path)`, `invalidate()`).

Host requirements: page, worker script and wasm served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (the viewer checks `crossOriginIsolated` and fails with instructions); `core/` served same-origin; cross-origin assets need CORS.

Tooling: dependencies `three@0.186.1` (exact), `vite`, `typescript`, `@types/three`, `@playwright/test`. Unit tests with `node --test` (Vitest's engine range excludes the installed Node 25.8). Vite sets COOP/COEP on dev and preview; worker glue and wasm are static files under `public/core/` loaded by runtime URL (library mode would inline them as base64). Playwright: Chromium, `?forceWebGL=1`, SwiftShader flags, golden screenshots; a second project runs against `e2e/mock-core/` with no wasm. Deployment: static `dist/`; GitHub Pages uses `coi-serviceworker`, Netlify uses `_headers`.

## Nucleus gateway (later stage, `gateway/`)

- One native executable linking the Omniverse Client Library (2.74.0; binaries downloaded from NVIDIA's CDN at configure time, never committed) plus a single-header HTTP server. Platforms: Windows x64 (needs MSVC Build Tools, not yet installed) and Linux x64.
- Endpoints: `GET /v1/stat`, `/v1/list`, `/v1/read` (ETag from the entry hash, `If-None-Match`), `/v1/resolve`, `/v1/events` (Server-Sent Events from `omniClientStatSubscribe`/`ListSubscribe`, viewer calls `reloadStage()`).
- Auth: gateway holds one Nucleus service identity (`omniClientRegisterAuthCallback`, API token); browser users authenticate to the gateway with a bearer token. Only allowlisted `omniverse://` hosts are accepted. CORS origin allowlist plus `Cross-Origin-Resource-Policy: cross-origin`.
- Viewer side: `viewer.registerScheme('omniverse', {gateway, getAuth})` -> core `registerScheme`. Resolved paths stay canonical `omniverse://...`, so no core change is needed. A Nucleus browse dialog uses `/v1/list`.
- Before deployment: review the Client Library licence terms (proprietary, "NVIDIA Platforms" clause). NVIDIA's Apache-2.0 `ovstorage` is the alternative if Nucleus is replaced by Omniverse Storage APIs.

## Milestones

| # | Scope | Verification |
|---|---|---|
| M0 | `git init`, `.gitignore`, emsdk 5.0.7 on F:, web scaffold: `<usd-viewer>` with `WebGPURenderer`, default environment, orbit controls, isolation check | `emcc --version` prints 5.0.7; `npm run dev` shows a lit cube; backend badge changes with `?forceWebGL=1` |
| M1 | SDK superbuild (`sdk/`), CI job for it | `F:\uw\sdk\pxrConfig.cmake` exists; `lib` has `libusd_usdImaging.a`, `libusd_hdMtlx.a`, `libusd_usdSkelImaging.a`, `libosdCPU.a`, `libtbb.a`, `libMaterialXCore.a` |
| M2 | `protocol.ts`, `rpc.ts`, mock core, frame pump, `SceneSync` for meshes, subsets, instances, removal (runs while M1 compiles) | `npm test` passes; mock golden passes; never more than one flush in flight; GPU memory returns to baseline after `close()` |
| M3 | Minimal core: `init`, resolver, `openStage`, `primChildren` | `node native/test/smoke.mjs` reports resolver `WebResolver` and the expected prim count; record wasm size and init time |
| M4 | Scene-index chain, bridge, meshes, `worker.js`; open by URL, drop, usdz: first real pixels | smoke: cube gives 36 indices; animated xform delta contains only `xforms`; `subdivMesh.usda` by URL, Kitchen_set folder drop and `CarbonFrameBike.usdz` render |
| M5 | Hierarchy, properties, selection, picking, highlight, framing | e2e: tree click fires `selectionchange` and fills properties; canvas click reveals the tree row; a 50,000-child parent keeps at most 100 row elements |
| M6 | Subdivision + complexity control, primvars, GeomSubsets, UsdPreviewSurface, textures | smoke: catmullClark cube at level 2 gives 576 indices, two subsets give two groups; goldens for `testPreviewSurface*`, `TextureTransformTest`, `McUsd` |
| M7 | Instancing, curves, points | smoke: 3 point instances give 48 floats, nested 2x3 gives 96; goldens `basicCurves`, `curveWithVertexColor`, `points`; instance pick returns the proxy path |
| M8 | Lights, dome, shadows, cameras, tone mapping | goldens `usdLux.usda`, `domeLight{Yup,Zup}.usda` with orientation matching the Storm baselines in the same folders; look-through camera works |
| M9 | Timeline, playback, skinning | `skeleton.usda` at two frames; later frames carry only positions/normals for skinned rids |
| M10 | MaterialX | `chess_set.usda` golden; `standard_shader_ball_scene.usda` renders through the fallback chain with warnings listed |
| M11 | Variants, payloads, visibility, `setAttribute`, API hardening, library build, host sample page | Teapot variant switch updates viewport, tree and properties; sample page drives the viewer through the public API only |
| M12 | CI complete (sdk, core, web jobs), static deploy | workflow green, SDK cache hit on second run, deployed page reports `crossOriginIsolated === true` |
| Later | Nucleus gateway, `registerScheme`, Nucleus browse dialog | `curl .../v1/read?url=omniverse://...` returns bytes and ETag; viewer opens an `omniverse://` stage |

CI and deploy need the repo on GitHub; nothing is pushed without asking first.

## Scope limits in v1 (each with its upgrade)

- Area lights approximated; shadows only from the first distant light. Upgrade: custom TSL light nodes.
- UDIM: first tile only. Upgrade: array texture + tile lookup node.
- `opacityMode: transparent` renders like presence; displacement does not recompute normals.
- Not rendered: OpenVDB volumes, particle fields. Ignored with a warning: light linking, light filters, portals, IES.
- NURBS drawn through Hydra's approximation.
- CPU picking (large meshes: add three-mesh-bvh or a GPU id pass); one draw call per prim (about 10k draws: add `BatchedMesh`).
- No progress bar during a synchronous load (indeterminate spinner).
- Asset sources are http(s), dropped files and gateway schemes; arbitrary JS-implemented sources need a SharedArrayBuffer bridge.
- wasm32: 4 GB ceiling (upgrade: wasm64 build of the same SDK). Threads require cross-origin isolation (upgrade: single-threaded SDK flavour, as Babylon's loader does).
- Default refine level 0 like usdview (USD's fallback scheme is catmullClark, so level 1 would quadruple most scenes); toolbar control 0-3.

## Risks and fallbacks

| Risk | Mitigation |
|---|---|
| Imaging-enabled wasm SDK hits compile blockers, especially on a Windows host | CI Linux build is the reference; Windows consumes the tarball; WSL as last resort |
| wasm size and startup (estimate 25-45 MB raw, 5-8 MB brotli) | measure at M3; curated whole-archive list, `-Oz`, pruned MaterialX stdlib |
| Observer invalidation bugs (instancers, subsets, resync order) | mirror `HdSceneIndexAdapterSceneDelegate`; full record rebuild on unknown locators; smoke assertions per milestone |
| three.js WebGPU/WebGL2 backend differences | exact version pin; goldens on WebGL2; manual WebGPU checklist per milestone |
| WORKERFS or nested workers misbehave (Safari) | in-memory store fallback; runtime diagnostic |
| TBB starts with few threads in a worker-hosted module | `warmThreads()` + thread-count probe at M3 |
| MaterialX coverage in three.js | fallback chain with visible warnings |
| Hosts cannot send COOP/COEP | diagnostic, `coi-serviceworker`, documented requirements |
| Client Library licence and single-identity gateway | legal review before deployment |

## Reference sources to mirror (not copy blindly)

- OpenUSD v26.08: `pxr/imaging/hd/sceneIndexAdapterSceneDelegate.cpp` (schema reads), `pxr/imaging/plugin/hdEmbree/instancer.cpp` (instance transforms), `pxr/usdImaging/usdImaging/testenv/testUsdImagingHdMtlx.cpp` (MaterialX export), `pxr/imaging/hdx/pickTask.cpp` (pick to path), `extras/usd/examples/wasmFetchResolver/` (resolver and link pattern), `pxr/usdImaging/usdImagingGL/engine.cpp` (chain wiring).
- Needle fork C++ (`webRenderDelegate.cpp`, same licence as OpenUSD): OpenSubdiv refinement helpers. Needle's JavaScript is noncommercial: never copied.
- usd-wg-webview `docs/wasm-sdk.md` (BSD-3): SDK fixups. three.js r186 `USDComposer.js`, `webgpu_instance_points.html`, `webgpu_lights_rectarealight.html` (MIT).

## End-to-end verification

1. `cmake --build F:\uw\core` then `node native/test/smoke.mjs`: all assertions pass.
2. `cd web && npm test && npm run e2e`: unit tests and goldens pass (mock core and real core).
3. `npm run dev`, then open by `?src=` and by drag-and-drop: Kitchen_set (references, payloads), `chess_set.usda` (MaterialX), `usdLux.usda` (lights), `basicCurves.usda` (curves), `subdivMesh.usda` at complexity 0-3, `pi_ni.usda` (instancing), `skeleton.usda` (playback), `CarbonFrameBike.usdz`.
4. In each: click in viewport selects the prim in the hierarchy and fills properties; click in hierarchy highlights in the viewport; variant switch and visibility toggle update all three.
5. Host sample page: `open`, `select`, `usd.setAttribute`, `selectionchange` work through the public API only.
6. Check both backends: default (WebGPU) and `?forceWebGL=1`.
