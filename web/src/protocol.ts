// The contract between the page and the wasm core running in a worker.
// The C++ side (native/src) produces exactly these shapes; this file is the
// single source of truth for both.

export type Path = string; // absolute SdfPath text
export type Rid = number; // uint32 render item id, unique per open stage, 0 = none
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/* ---------- transport ---------- */

export interface Request {
  id: number;
  method: string;
  args: unknown[];
}
export interface LogEntry {
  level: 'info' | 'warn' | 'error';
  message: string;
}
export type Response =
  | { id: number; result: unknown; log?: LogEntry[] }
  | { id: number; error: string; log?: LogEntry[] };
export type Boot = { ready: { usd: string; threads: number } } | { fatal: string };

/* ---------- RPC: executed strictly in order inside the worker ---------- */

export interface CoreApi {
  /** Handled by the worker glue: mounts dropped files, returns the directory they appear under. */
  mount(files: { path: string; file: Blob }[]): string;
  registerScheme(scheme: string, httpBase: string, authHeader: string): void;
  openStage(url: string, loadPayloads: boolean): StageInfo;
  closeStage(): void;
  reloadStage(): Edit;
  primChildren(path: Path): PrimSummary[];
  /** Computed visibility of each path (true for non-imageable or missing prims). */
  primVisibility(pathsJson: string): boolean[];
  primDetails(path: Path, time: number): PrimInfo;
  /** World-space aligned bounds of an imageable prim's subtree (min xyz, max xyz); null otherwise. */
  primBounds(path: Path, time: number): number[] | null;
  attributeValue(path: Path, name: string, time: number): Json;
  /** attributeValue with arrays past 16 values as { length, head }: what the panel shows. */
  attributeHead(path: Path, name: string, time: number): Json;
  findPrims(text: string, typeName: string, limit: number): Path[];
  /** The prim and everything below it, in traversal order, at most `limit` paths. */
  primSubtree(path: Path, limit: number): Path[];
  /** usda text of a prim subtree: composed (flattened) or only what the edit layer authors. '' on failure. */
  exportPrim(path: Path, mode: 'composed' | 'authored'): string;
  readAsset(resolvedPath: string): Uint8Array<ArrayBuffer> | null;
  setTime(time: number): void;
  /** Global subdivision refinement level; -1 = automatic from a triangle budget. */
  setRefineLevel(level: number): void;
  /** Output triangles the automatic level may produce (clamped to 0.5M–8M; also scales the per-mesh cap). */
  setRefineBudget(triangles: number): void;
  /** Omniverse-style per-prim override: authors refinementEnableOverride + refinementLevel on the mesh. */
  setRefinement(path: Path, enabled: boolean, level: number): Edit;
  clearRefinement(path: Path): Edit;
  clearRefinementOverrides(): Edit;
  flush(maxItems: number): RenderDelta;
  setSelection(paths: Path[]): void;
  resolvePick(rid: Rid, instanceIndex: number): PickResult | null;
  setVariant(path: Path, variantSet: string, variant: string): Edit;
  setVisible(path: Path, visible: boolean): Edit;
  /**
   * Viewer hiding through `visibility` opinions in the session layer (never saved).
   * hide / isolate: JSON array of paths; showAll: clears every such opinion; set: JSON object
   * path -> "invisible" | null. `previous` is the earlier state in the shape `set` takes.
   */
  sessionVisibility(mode: 'hide' | 'isolate' | 'showAll' | 'set', json: string): Edit;
  setLoaded(path: Path, loaded: boolean): Edit;
  /** The prim and its subtree as when the stage was opened (local layer stack); `previous` is a stash id. */
  revertPrim(path: Path): Edit;
  restorePrim(stash: number): Edit;
  /** Takes the current layers as the baseline of the change markers (after a reload). */
  resetChanges(): void;
  setAttribute(path: Path, name: string, jsonValue: string, time: number): Edit;
  /** Removes the edit target's opinion: the default value (NaN time) or the sample at `time`. */
  clearAttribute(path: Path, name: string, time: number): Edit;
  clearSessionEdits(): Edit;
  /** Matrices of an xformable prim (instance proxies: their instance); null for other prims. */
  xformInfo(path: Path, time: number): XformInfo | null;
  /** The same for a JSON array of paths, computed with one shared transform cache. */
  xformInfos(pathsJson: string, time: number): (XformInfo | null)[];
  /** Authors a local matrix (16 numbers, row-major like THREE.Matrix4.elements); `previous` is the old local matrix. */
  setXform(path: Path, matrix: number[], time: number): Edit;
  /** Several prims in one edit: JSON of `{ path, matrix }[]`; `previous` lists the old local matrices in order. */
  setXforms(entriesJson: string, time: number): Edit;
  listLayers(): LayerInfo[];
  /** Only layers of the local layer stack (root, its sublayers, session). */
  setEditTarget(identifier: string): Edit;
  /** A layer as usda text or usdc binary, or the whole stage flattened; null when unknown. */
  exportLayer(identifier: string, format: 'usda' | 'usdc' | 'flat'): Uint8Array<ArrayBuffer> | null;
  /** Re-reads layers from their source (all non-anonymous used layers when empty), dropping local edits to them. */
  reloadLayers(identifiers: string[]): Edit;
  /** Worker glue: replaces the files behind a mount directory (changed on disk). */
  remount(dir: string, files: { path: string; file: Blob }[]): void;
}

/** NaN as a time argument means UsdTimeCode::Default. */
export const DEFAULT_TIME = NaN;

/* ---------- stage and prim queries ---------- */

export interface StageInfo {
  ok: boolean;
  error?: string;
  url: string;
  upAxis: 'Y' | 'Z';
  metersPerUnit: number;
  startTimeCode: number;
  endTimeCode: number;
  hasTimeRange: boolean;
  timeCodesPerSecond: number;
  defaultPrim: Path | null;
  layers: string[]; // strongest first
}
export interface PrimSummary {
  name: string;
  path: Path;
  typeName: string;
  kind: string;
  hasChildren: boolean;
  active: boolean;
  visible: boolean; // computed visibility
  isInstance: boolean;
  hasPayload: boolean;
  loaded: boolean;
  hasVariantSets: boolean;
}
export interface AttributeInfo {
  name: string;
  typeName: string;
  /** Long arrays are truncated: { length, head }. Numeric arrays are null: the panel fetches them with attributeValue on demand. */
  value: Json;
  authored: boolean;
  timeSamples: number;
  custom: boolean;
  variability: 'varying' | 'uniform';
  /** Other authored metadata: interpolation, elementSize, colorSpace, documentation, displayName, customData, ... */
  metadata: { [key: string]: Json };
  connections?: Path[];
}
export interface PrimvarInfo {
  name: string; // without the primvars: prefix
  typeName: string;
  interpolation: string;
  elementSize: number;
  indexed: boolean;
  value: Json; // truncated like AttributeInfo.value, null for numeric arrays
  indices?: Json; // present when indexed; null when value is

  authored: boolean;
  inheritedFrom?: Path; // ancestor that defines it; absent for the prim's own primvars
}
export interface ArcInfo {
  type: 'root' | 'inherit' | 'variant' | 'relocate' | 'reference' | 'payload' | 'specialize';
  layer: string; // display name of the layer introducing the arc, '' for root
  introducedAt: Path;
  target: Path;
  targetLayer: string;
  ancestral: boolean;
  implicit: boolean;
  hasSpecs: boolean;
}
export interface PrimInfo {
  summary: PrimSummary;
  specifier: string;
  purpose: string;
  /** Authored prim metadata; dictionaries (customData, assetInfo) nest, list ops (apiSchemas) are applied arrays. */
  metadata: { [key: string]: Json };
  primvars: PrimvarInfo[];
  arcs: ArcInfo[];
  /** Per-prim refinement override (meshes only, null otherwise). */
  refinement: { enabled: boolean; level: number } | null;
  appliedSchemas: string[];
  attributes: AttributeInfo[];
  relationships: { name: string; targets: Path[] }[];
  variantSets: { name: string; variants: string[]; selection: string }[];
  boundMaterial: Path | null;
  worldXform: number[] | null; // 16 (bounds: primBounds)
  primStack: { layer: string; path: Path }[];
}
export interface Edit {
  ok: boolean;
  error?: string;
  resynced: Path[];
  /** Every prim that differs from the stage as opened after this edit, for the hierarchy's change markers. */
  changed?: Path[];
  /** The prims this edit changed at all (resynced or info only): what a visibility refresh has to look at. */
  touched?: Path[];
  /** What the edit replaced, when there was an opinion to replace (the inverse edit's input). */
  previous?: Json;
  /** Identifiers of non-anonymous layers with unsaved changes after the edit. */
  dirty: string[];
}
export interface XformInfo {
  path: Path; // the prim edits land on
  local: number[]; // 16, row-major
  parent: number[]; // parent-to-world; identity when the prim resets the xform stack
  world: number[];
  resets: boolean;
}
export interface LayerInfo {
  identifier: string;
  displayName: string;
  format: string; // usda, usdc, usdz, ...
  anonymous: boolean;
  dirty: boolean;
  inStack: boolean; // local layer stack: root, sublayers, session
  editTarget: boolean;
  session: boolean;
}
export interface PickResult {
  path: Path;
  instancer?: Path;
  instanceIndex?: number;
}

/* ---------- render delta ----------
   An omitted field means unchanged. `path` is present only on the entry that
   creates the item. If a vertex or index count changes, the entry carries the
   complete stream set. Every typed array owns a fresh buffer and is transferred. */

export interface RenderDelta {
  more?: boolean; // call flush again
  refineLevel?: number; // the global level in effect (automatic resolved)
  removed?: Uint32Array;
  materials?: MaterialEntry[]; // applied first
  meshes?: MeshEntry[];
  curves?: CurvesEntry[];
  points?: PointsEntry[];
  lights?: LightEntry[];
  cameras?: CameraEntry[];
  /** 16 doubles per rid, USD row-major, which is THREE.Matrix4.elements order. */
  xforms?: { rids: Uint32Array; matrices: Float64Array };
  visibility?: { rids: Uint32Array; visible: Uint8Array };
  /** Complete replacement of the highlighted set. */
  selected?: { rid: Rid; instances?: Uint32Array }[];
}
interface Item {
  rid: Rid;
  path?: Path;
  purpose?: string; // default | render | proxy | guide, sent on creation
}
export interface Primvar {
  name: string;
  size: number; // components per element
  data: Float32Array;
}
export interface Subset {
  start: number; // index range
  count: number;
  material: Rid;
}
export interface MeshCounts {
  points: number;
  faces: number; // drawn faces: holes and degenerate faces left out
  edges: number; // distinct edges of those faces
}
export interface MeshEntry extends Item {
  indices?: Uint32Array; // triangle list
  /** Line pairs along the authored faces (no triangulation diagonals), same layout as indices; sent with them. */
  edges?: Uint32Array;
  /** The authored mesh's counts; sent with indices. */
  counts?: MeshCounts;
  positions?: Float32Array;
  normals?: Float32Array | null; // null: none available, shade flat
  primvars?: Primvar[]; // uv sets and vertex-rate displayColor, same layout as positions
  subsets?: Subset[] | null;
  material?: Rid; // 0 = none
  displayColor?: [number, number, number];
  displayOpacity?: number;
  doubleSided?: boolean;
  /** 16 floats per instance, fully composed world matrices; null: not instanced. */
  instances?: Float32Array | null;
}
export interface CurvesEntry extends Item {
  points?: Float32Array; // evaluated polyline vertices
  counts?: Uint32Array; // vertices per curve
  widths?: Float32Array | null; // per vertex; null: hairline
  colors?: Float32Array | null; // per vertex
  displayColor?: [number, number, number];
  material?: Rid;
}
export interface PointsEntry extends Item {
  points?: Float32Array;
  widths?: Float32Array | null;
  colors?: Float32Array | null;
  displayColor?: [number, number, number];
}
export interface LightParams {
  color: [number, number, number]; // linear, colour temperature already applied
  intensity: number;
  exposure: number;
  normalize: boolean;
  diffuse: number;
  specular: number;
  angle?: number; // distant, degrees
  radius?: number;
  width?: number;
  height?: number;
  length?: number;
  coneAngle?: number; // degrees, only when shaping is authored
  coneSoftness?: number;
  shadow: boolean;
  texture?: string; // dome, resolved path
  textureFormat?: string;
}
export interface LightEntry extends Item {
  /** Hydra prim type: distantLight, sphereLight, rectLight, diskLight, cylinderLight, domeLight. */
  type?: string;
  params?: LightParams;
}
export interface CameraParams {
  projection: 'perspective' | 'orthographic';
  focalLength: number;
  horizontalAperture: number;
  verticalAperture: number;
  clippingRange: [number, number];
}
export interface CameraEntry extends Item {
  params?: CameraParams;
}

/* ---------- materials ---------- */

export interface AssetValue {
  asset: string;
  resolved: string;
}
export interface MaterialNode {
  type: string; // UsdPreviewSurface, UsdUVTexture, UsdPrimvarReader_float2, UsdTransform2d, ...
  params: { [name: string]: Json | AssetValue };
  inputs: { [name: string]: { node: string; output: string } };
}
export interface MaterialNetwork {
  surface: string; // name of the surface terminal node
  nodes: { [name: string]: MaterialNode };
}
export interface MaterialEntry {
  rid: Rid;
  path: Path;
  network?: MaterialNetwork; // universal render context
  mtlx?: string; // MaterialX document when an mtlx terminal exists
  textures?: string[]; // resolved paths of every asset parameter
}
