// Applies render deltas from the core to a three.js scene graph.
import * as THREE from 'three/webgpu';
import { CLUSTERED, clusterRaycast } from './clusters.ts';
import {
  ACTIVE,
  ACTIVE_LINE,
  buildMaterial,
  displayMaterial,
  hairlineMaterial,
  HIDDEN,
  HIDDEN_DOUBLE,
  HIGHLIGHT,
  instancedLines,
  LINE,
  LINE_ALONE,
  PLAIN,
  type MaterialHost,
  pointsMaterial,
  ribbonMaterial,
  SELECTED_LINE,
  TextureCache,
} from './materials.ts';
import type {
  CameraParams,
  CurvesEntry,
  LightEntry,
  LightParams,
  MaterialEntry,
  MeshCounts,
  MeshEntry,
  Path,
  PointsEntry,
  RenderDelta,
  Rid,
  Subset,
} from './protocol.ts';
import { section } from './sectionnode.ts';
import { hasAncestorIn } from './session.ts';
import * as units from './units.ts';

const GREY = [0.18, 0.18, 0.18];

// Batches (see SceneSync.batchUp): three draws a BatchedMesh in one pass however many items it holds, where it
// costs ~10 µs of CPU per frame for every plain mesh. Smaller groups of one look draw one by one; bigger items gain
// nothing; a batch holds at most BATCH_VERTICES / BATCH_INDICES, so each buffer stays under 128 MB.
const MIN_BATCH = 64;
const BATCH_ITEM_VERTICES = 65_536;
const BATCH_VERTICES = 4_194_304;
const BATCH_INDICES = 25_165_824;
/** While a flush pages in, a look's pending items become a batch once there are this many (or vertices). */
const BATCH_PENDING_ITEMS = 4096;
const BATCH_PENDING_VERTICES = 2_000_000;
/** three's area-light tables (about 250 KB of script) arrive with the first rect or disk light. */
let areaTables: Promise<void> | null = null;
let areaReady = false;
const MIRROR = new THREE.Matrix4().makeScale(-1, 1, 1);
const MATRIX = new THREE.Matrix4();
const COLOR = new THREE.Color();
const SPHERE = new THREE.Sphere();

/** Many small static items of one look in one THREE.BatchedMesh; each item's own object then draws nothing. */
interface Batch {
  key: string;
  material: Rid; // the look: a material record, or the display-colour fallback while it has none
  flat: boolean;
  doubleSided: boolean;
  /** Items whose matrix mirrors: the batch's own matrix mirrors too, so three culls the right faces. */
  mirrored: boolean;
  vertexColors: boolean;
  /** Per-instance colours exist (they are part of the shader): the fallback look tints each item with them. */
  colored: boolean;
  mesh: THREE.BatchedMesh;
  items: Set<Item>;
  /** Bounding sphere of each instance in stage space (x, y, z, radius), for culling sub-pixel parts. */
  spheres: Float32Array;
  /** Instances culled as sub-pixel for the frame being drawn (see cullDetail). */
  tiny: Uint8Array;
}

export interface Item {
  rid: Rid;
  path: Path;
  kind: 'mesh' | 'curves' | 'points' | 'light' | 'camera';
  purpose: string;
  usdVisible: boolean;
  matrix: THREE.Matrix4; // world matrix in stage space
  object: THREE.Object3D | null;
  geometry: THREE.BufferGeometry | null;
  edges: THREE.BufferGeometry | null; // authored face edges as line pairs, sharing the mesh positions
  counts: MeshCounts | null;
  own: THREE.Material | null; // fallback material owned by this item
  material: Rid;
  subsets: Subset[] | null;
  displayColor: number[];
  displayOpacity: number;
  flat: boolean; // no normals available
  doubleSided: boolean;
  instances: Float32Array | null;
  /** The instance matrices as the line overlays read them (shared by every overlay of the item). */
  instanceBuffer: THREE.InstancedInterleavedBuffer | null;
  /** Overlays of an instanced item sit in root, not under its object: dropped with the object. */
  overlays: THREE.Object3D[];
  /** The selection highlight drawn over the item, made on its first selection and kept (hidden) until the object goes. */
  fill: THREE.Mesh | null;
  /** The batch drawing this mesh, and its ids there; its object then draws an invisible stand-in. */
  batched: { batch: Batch; geometry: number; instance: number } | null;
  /** Its points move (deforming, or updated without new indices): never batched. */
  dynamic: boolean;
  curves: { points?: Float32Array; counts?: Uint32Array; widths?: Float32Array | null; colors?: Float32Array | null };
  lightType: string;
  lightParams: LightParams | null;
  cameraParams: CameraParams | null;
}

interface MaterialRecord {
  entry: MaterialEntry;
  material: THREE.Material | null; // smooth, double-sided
  variants: Map<string, THREE.Material>; // flat-shaded and single-sided clones, made on demand
}

export interface SceneHost extends MaterialHost {
  invalidate(): void;
}

/**
 * shaded: materials; plain: one grey material; -wire: plus the edges of every mesh; -selwire: plus
 * red edges on the selection instead of the highlight fill; wire: edges only. Edges are the
 * authored faces' outlines, never the triangulation.
 */
export type DisplayMode = 'shaded' | 'shaded-wire' | 'shaded-selwire' | 'plain' | 'plain-wire' | 'plain-selwire' | 'wire';

/** USD counts of what is drawn; instances count once each. */
export interface SceneStats {
  meshes: number;
  points: number;
  faces: number;
  edges: number;
  materials: number;
  textures: number;
}

export class SceneSync {
  /** Everything from the stage lives under this group; it carries the up-axis rotation. */
  readonly root = new THREE.Group();
  readonly items = new Map<Rid, Item>();
  readonly textures: TextureCache;
  purposes = new Set(['default', 'proxy']);
  /** Hide the back of meshes that are not authored doubleSided (off by default, like usdview). */
  cullBackfaces = false;
  displayMode: DisplayMode = 'shaded';
  /** The stage's up axis; root turns Z up into three's Y up. */
  upAxis: 'Y' | 'Z' = 'Y';
  private wires: THREE.Object3D[] = [];
  private readonly batches = new Set<Batch>();
  /** Meshes drawing on their own that may join a batch (batchUp sorts them out). */
  private readonly loose = new Set<Item>();
  /** `loose` changed since batchUp last ran on a flush's last page. */
  private batchDirty = false;
  /** Bumped on every change, so callers can cache what they derive from the scene. */
  version = 0;
  private sun: THREE.DirectionalLight | null = null; // the one light that casts shadows
  private readonly materials = new Map<Rid, MaterialRecord>();
  /** Selection wires (the *-selwire display modes), made afresh for each selection. */
  private highlights: THREE.Object3D[] = [];
  /** Items whose fill highlight shows. */
  private lit = new Set<Item>();
  /** When the sun's shadow map was last redrawn, and whether a redraw waits for its turn (see invalidate). */
  private lastShadow = 0;
  private shadowLater: ReturnType<typeof setTimeout> | 0 = 0;
  /** The current flush has more pages coming. */
  private paging = false;
  private selected: { rid: Rid; instances?: Uint32Array }[] = [];
  private activePath: Path | null = null;
  /** Items a drag moves ahead of the core, with the world matrix they started from. */
  private preview = new Map<Rid, { item: Item; start: THREE.Matrix4 }>();
  private lastBoundsBump = 0;
  /** What the pages of the current flush changed; the per-item passes run once, on its last page. */
  private pending = { rebuilt: false, structural: false, lights: false, selected: false, visibility: false, moved: false, edges: false };
  private domeRid: Rid = 0;
  private studio: THREE.Texture | null = null;
  private sky: THREE.Texture | null = null;
  private plainBackground = false;
  private readonly building = new Set<Promise<unknown>>(); // materials and textures still loading
  private readonly scene: THREE.Scene;
  private readonly host: SceneHost;

  constructor(scene: THREE.Scene, host: SceneHost) {
    this.scene = scene;
    this.host = host;
    this.textures = new TextureCache(host);
    scene.add(this.root);
  }

  /** Environment used while the stage has no lights of its own. */
  setStudioEnvironment(texture: THREE.Texture): void {
    this.studio = texture;
    this.updateEnvironment();
  }

  setUpAxis(axis: 'Y' | 'Z'): void {
    this.upAxis = axis;
    this.root.rotation.x = axis === 'Z' ? -Math.PI / 2 : 0;
    this.root.updateMatrixWorld(true);
  }

  apply(delta: RenderDelta): void {
    // What can change the shadows; a delta with only the selection (or cameras) does not.
    const content = !!(delta.removed || delta.materials || delta.meshes || delta.curves || delta.points || delta.lights || delta.xforms || delta.visibility);
    this.paging = !!delta.more;
    delta.removed?.forEach((rid) => this.remove(rid));
    delta.materials?.forEach((entry) => this.material(entry));
    let rebuilt = !!delta.removed;
    delta.meshes?.forEach((entry) => {
      rebuilt = this.mesh(entry) || rebuilt;
    });
    delta.curves?.forEach((entry) => this.curves(entry));
    delta.points?.forEach((entry) => this.points(entry));
    delta.lights?.forEach((entry) => this.light(entry));
    delta.cameras?.forEach((entry) => {
      const item = this.item(entry, 'camera');
      if (entry.params) item.cameraParams = entry.params;
    });
    if (delta.xforms) {
      const { rids, matrices } = delta.xforms;
      rids.forEach((rid, i) => {
        const item = this.items.get(rid);
        if (!item) return;
        item.matrix.fromArray(matrices, i * 16);
        if (item.kind === 'light') this.rebuildLight(item);
        else if (item.object && !item.instances && !this.preview.has(rid)) {
          item.object.matrix.copy(item.matrix);
          this.follow(item);
        }
      });
    }
    if (delta.visibility) {
      const { rids, visible } = delta.visibility;
      rids.forEach((rid, i) => {
        const item = this.items.get(rid);
        if (!item) return;
        item.usdVisible = visible[i] !== 0;
        this.updateVisible(item);
      });
    }
    if (delta.selected) this.selected = delta.selected;
    const p = this.pending;
    p.rebuilt ||= rebuilt;
    p.structural ||= rebuilt || !!(delta.curves || delta.points || delta.lights || delta.cameras);
    p.lights ||= !!(delta.lights || delta.removed);
    p.selected ||= !!delta.selected;
    p.visibility ||= !!delta.visibility;
    p.moved ||= !!(delta.xforms || delta.meshes);
    p.edges ||= !!delta.meshes?.some((m) => m.edges); // edges alone change no object: the lines are redone below
    if (this.batchDirty) this.batchUp(!delta.more);
    // Items draw as they arrive; the passes over every item below run once per flush, on its last
    // page. The bounds (clip planes, shadow fit) still follow the pages, at most twice a second.
    const now = performance.now();
    if (delta.more) {
      if ((p.structural || p.moved) && now - this.lastBoundsBump > 500) {
        this.version++;
        this.lastBoundsBump = now;
      }
      content ? this.invalidate() : this.host.invalidate();
      return;
    }
    this.pending = { rebuilt: false, structural: false, lights: false, selected: false, visibility: false, moved: false, edges: false };
    // Rebuilt meshes are new objects, so the overlays are redone with them; instanced overlays
    // live outside their mesh and take its visibility when built. A deforming mesh keeps its
    // objects, so its overlays (which share the geometry) need nothing. New edges redo the lines.
    if (p.selected || (this.selected.length && (p.rebuilt || p.edges))) this.highlight(this.selected);
    if (p.rebuilt || p.edges) this.wireframes();
    else if (p.visibility) this.syncOverlayVisibility();
    if (p.lights) this.updateEnvironment();
    // The version drives a walk over every object (bounds, shadow fit): structural changes bump
    // it at once, moving or deforming objects at most twice a second.
    if (p.structural || (p.moved && now - this.lastBoundsBump > 500)) {
      this.version++;
      this.lastBoundsBump = now;
    }
    // The last page also draws a shadow map an earlier page deferred (it would land after idle()).
    content || this.shadowLater ? this.invalidate() : this.host.invalidate();
  }

  /**
   * Redraws, and renders the sun's shadow map again: the stage's content changed (camera moves and the selection do
   * not come here). While a stage streams in (more pages, materials or textures to come) or a gizmo drags prims, the
   * shadow map, which draws every caster, is redrawn at most twice a second, and once more after the last change.
   */
  private invalidate(): void {
    this.host.invalidate();
    if (!this.sun) return;
    const now = performance.now();
    const wait = this.paging || this.building.size || this.preview.size ? this.lastShadow + 500 - now : 0;
    if (wait <= 0) {
      this.sun.shadow.needsUpdate = true;
      this.lastShadow = now;
      clearTimeout(this.shadowLater); // drawn now: a redraw still waiting would only repeat it
      this.shadowLater = 0;
    } else if (!this.shadowLater) {
      this.shadowLater = setTimeout(() => {
        this.shadowLater = 0;
        this.invalidate();
      }, wait);
    }
  }

  /** Forces the next frame to refit bounds and shadows (after a drag). */
  touch(): void {
    this.version++;
    this.lastBoundsBump = performance.now();
    this.invalidate();
  }

  /* ---------- drag prediction ---------- */

  /**
   * The one exception to "the core moves the objects": while a gizmo drags, the listed
   * subtrees follow the pointer at once; the core's xforms confirm and take over at the end.
   */
  beginPreview(paths: Path[]): void {
    this.preview.clear();
    const roots = new Set(paths);
    for (const item of this.items.values()) {
      // ponytail: instanced prims and lights wait for the core (instance matrices and light rigs are built there).
      if (!item.object || item.instances || item.kind === 'light' || item.kind === 'camera') continue;
      if (roots.has(item.path) || hasAncestorIn(item.path, roots)) this.preview.set(item.rid, { item, start: item.matrix.clone() });
    }
  }

  /** World-space delta since the drag started, applied to every previewed object. */
  previewDelta(delta: THREE.Matrix4): void {
    for (const { item, start } of this.preview.values()) {
      item.object!.matrix.multiplyMatrices(delta, start);
      this.follow(item);
    }
    this.invalidate();
  }

  endPreview(): void {
    for (const { item } of this.preview.values()) {
      item.object?.matrix.copy(item.matrix);
      this.follow(item);
    }
    this.preview.clear();
    this.touch();
  }

  /**
   * Fits the shadow of the first distant light around a world-space sphere.
   * ponytail: one shadow-casting light; give sphere and rect lights shadows when a scene needs them.
   */
  fitShadow(sphere: THREE.Sphere): void {
    const sun = this.sun;
    if (!sun?.parent || !(sun.parent.parent === this.root)) return;
    const radius = Math.max(sphere.radius, 1e-6);
    const centre = sun.parent.worldToLocal(sphere.center.clone());
    // The target is a child of the light, so moving the light keeps its direction (-Z).
    sun.position.set(centre.x, centre.y, centre.z + radius * 2);
    const camera = sun.shadow.camera;
    camera.left = camera.bottom = -radius;
    camera.right = camera.top = radius;
    camera.near = radius * 0.01;
    camera.far = radius * 4;
    camera.updateProjectionMatrix();
    sun.shadow.normalBias = radius * 0.004;
  }

  clear(): void {
    for (const rid of [...this.items.keys()]) this.remove(rid); // the last item of a batch disposes it
    this.loose.clear();
    for (const record of this.materials.values()) disposeRecord(record);
    this.materials.clear();
    this.selected = [];
    this.highlight([]);
    this.wireframes();
    this.textures.dispose();
    this.updateEnvironment();
    this.version++; // the next stage must not inherit this one's bounds
  }

  /** Resolves once every material and texture requested so far has finished loading. */
  async settled(): Promise<void> {
    while (this.building.size) await Promise.allSettled([...this.building]);
  }

  private track<T>(work: Promise<T>): Promise<T> {
    this.building.add(work);
    work.finally(() => this.building.delete(work)).catch(() => {});
    return work;
  }

  setPurposes(purposes: Iterable<string>): void {
    this.purposes = new Set(purposes);
    for (const item of this.items.values()) this.updateVisible(item);
    this.syncOverlayVisibility();
    this.invalidate();
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    for (const item of this.items.values()) if (item.kind === 'mesh') this.assign(item);
    this.restyleBatches();
    this.highlight(this.selected);
    this.wireframes();
    this.invalidate();
  }

  /** Edge overlays on every mesh, or none, depending on the display mode. */
  private wireframes(): void {
    for (const proxy of this.wires) dispose(proxy);
    this.wires = [];
    if (!['shaded-wire', 'plain-wire', 'wire'].includes(this.displayMode)) return;
    const material = this.displayMode === 'wire' ? LINE_ALONE : LINE;
    for (const item of this.items.values()) {
      const proxy = this.lines(item, material);
      if (proxy) this.wires.push(proxy);
    }
  }

  /** USD counts of the visible meshes, the materials bound to them and those materials' textures. */
  stats(): SceneStats {
    const stats: SceneStats = { meshes: 0, points: 0, faces: 0, edges: 0, materials: 0, textures: 0 };
    const materials = new Set<Rid>();
    for (const item of this.items.values()) {
      if (item.kind !== 'mesh' || !item.object?.visible) continue;
      const copies = item.instances ? item.instances.length / 16 : 1;
      stats.meshes += copies;
      stats.points += (item.counts?.points ?? 0) * copies;
      stats.faces += (item.counts?.faces ?? 0) * copies;
      stats.edges += (item.counts?.edges ?? 0) * copies;
      // With subsets the mesh's own material is listed as the subset of the remaining faces.
      for (const rid of item.subsets?.length ? item.subsets.map((s) => s.material) : [item.material]) if (rid) materials.add(rid);
    }
    const textures = new Set<string>();
    for (const rid of materials) this.materials.get(rid)?.entry.textures?.forEach((t) => textures.add(t));
    stats.materials = materials.size;
    stats.textures = textures.size;
    return stats;
  }

  /** The active prim gets the brighter highlight. */
  setActive(path: Path | null): void {
    if (path === this.activePath) return;
    this.activePath = path;
    if (this.selected.length) this.highlight(this.selected);
    this.host.invalidate(); // the highlight only: no shadows
  }

  setCullBackfaces(cull: boolean): void {
    this.cullBackfaces = cull;
    for (const item of this.items.values()) {
      if (item.kind !== 'mesh') continue;
      item.own?.dispose();
      item.own = null;
      this.assign(item);
    }
    this.restyleBatches(); // the side is not part of a batch's key: only its material changes
    this.invalidate();
  }

  cameras(): { path: Path; params: CameraParams; matrix: THREE.Matrix4 }[] {
    const list = [];
    for (const item of this.items.values()) {
      if (item.kind === 'camera' && item.cameraParams) {
        list.push({ path: item.path, params: item.cameraParams, matrix: item.matrix });
      }
    }
    return list;
  }

  objectsFor(path: Path): THREE.Object3D[] {
    return this.objectsUnder([path]);
  }

  /** The objects of every item at or below any of the paths: one pass over the items, whatever their number. */
  objectsUnder(paths: readonly Path[]): THREE.Object3D[] {
    const roots = new Set(paths);
    const list = [];
    for (const item of this.items.values()) if (item.object && (roots.has(item.path) || hasAncestorIn(item.path, roots))) list.push(item.object);
    return list;
  }

  /* ---------- items ---------- */

  private item(entry: { rid: Rid; path?: Path; purpose?: string }, kind: Item['kind']): Item {
    let item = this.items.get(entry.rid);
    if (!item) {
      item = {
        rid: entry.rid,
        path: entry.path ?? '',
        kind,
        purpose: entry.purpose ?? 'default',
        usdVisible: true,
        matrix: new THREE.Matrix4(),
        object: null,
        geometry: null,
        edges: null,
        counts: null,
        own: null,
        material: 0,
        subsets: null,
        displayColor: GREY,
        displayOpacity: 1,
        flat: false,
        doubleSided: false,
        instances: null,
        instanceBuffer: null,
        overlays: [],
        fill: null,
        batched: null,
        dynamic: false,
        curves: {},
        lightType: '',
        lightParams: null,
        cameraParams: null,
      };
      this.items.set(entry.rid, item);
    }
    return item;
  }

  private remove(rid: Rid): void {
    const item = this.items.get(rid);
    if (item) {
      this.detach(item);
      item.geometry?.dispose();
      item.edges?.dispose();
      item.own?.dispose();
      this.items.delete(rid);
      if (rid === this.domeRid) this.domeRid = 0;
      return;
    }
    const record = this.materials.get(rid);
    if (record) {
      disposeRecord(record);
      this.materials.delete(rid);
    }
  }

  private detach(item: Item): void {
    this.unbatch(item, false);
    this.loose.delete(item);
    if (!item.object) return;
    // Root-level overlays would otherwise keep drawing (and re-uploading) the disposed geometry
    // until the flush's last page rebuilds them; disposing twice is harmless.
    for (const proxy of item.overlays) dispose(proxy);
    item.overlays = [];
    item.fill = null; // one of the overlays
    this.root.remove(item.object);
    item.object.traverse((o) => (o as any).isLight && (o as THREE.Light).dispose());
    if ((item.object as THREE.InstancedMesh).isInstancedMesh) (item.object as THREE.InstancedMesh).dispose();
    else released(item.object);
    item.object = null;
  }

  private attach(item: Item, object: THREE.Object3D): void {
    this.detach(item);
    object.userData.rid = item.rid;
    object.matrixAutoUpdate = false;
    if (!item.instances) object.matrix.copy(item.matrix);
    else if (item.instances.length === 16 && !(object as THREE.InstancedMesh).isInstancedMesh) object.matrix.fromArray(item.instances);
    item.object = object;
    this.root.add(object);
    this.updateVisible(item);
  }

  private updateVisible(item: Item): void {
    if (item.object) item.object.visible = item.usdVisible && this.purposes.has(item.purpose);
    const batched = item.batched;
    if (batched) batched.batch.mesh.setVisibleAt(batched.instance, item.object!.visible && !batched.batch.tiny[batched.instance]);
  }

  /* ---------- materials ---------- */

  private material(entry: MaterialEntry): void {
    let record = this.materials.get(entry.rid);
    if (!record) {
      record = { entry, material: null, variants: new Map() };
      this.materials.set(entry.rid, record);
    }
    record.entry = entry;
    this.track(buildMaterial(entry, this.textures, this.host)).then((material) => {
      const current = this.materials.get(entry.rid);
      if (current !== record || current.entry !== entry) {
        material?.dispose(); // superseded or removed while textures were loading
        return;
      }
      disposeRecord(record);
      record.material = material;
      for (const item of this.items.values()) {
        if (item.material !== entry.rid && !item.subsets?.some((s) => s.material === entry.rid)) continue;
        this.assign(item); // a batched item whose new look cannot batch (transparent, ...) leaves its batch
        if (item.kind === 'mesh' && !item.batched) this.unsettle(item);
      }
      for (const b of this.batches) if (b.material === entry.rid) this.restyle(b); // swapped in place, no copy
      this.batchUp(!this.paging);
      this.invalidate();
    });
  }

  /** The materials a mesh item draws with in the shaded view, whatever the view shows now (hosts exporting the look). */
  shadedMaterials(rid: Rid): THREE.Material | THREE.Material[] | null {
    const item = this.items.get(rid);
    return item?.kind === 'mesh' && item.geometry ? this.materialsFor(item, !!item.geometry.attributes.color, 'shaded') : null;
  }

  private materialsFor(item: Item, vertexColors: boolean, mode: DisplayMode = this.displayMode): THREE.Material | THREE.Material[] {
    const single = this.cullBackfaces && !item.doubleSided;
    if (mode === 'wire') return single ? HIDDEN : HIDDEN_DOUBLE;
    if (mode.startsWith('plain')) return plainLook(item.flat, single);
    const fallback = () => (item.own ??= style(displayMaterial(item.displayColor, item.displayOpacity, vertexColors), item.flat, single));
    const one = (rid: Rid) => {
      const record = this.materials.get(rid);
      return record?.material ? this.variant(record, item.flat, single) : fallback();
    };
    const materials = item.subsets?.length ? item.subsets.map((s) => one(s.material)) : one(item.material);
    // A material that reads displayColor needs a colour stream even where the colour is constant.
    const g = item.geometry;
    if (g && !g.attributes.color && [materials].flat().some((m) => m.userData.readsDisplayColor)) {
      const count = g.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < colors.length; i++) colors[i] = item.displayColor[i % 3];
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    return materials;
  }

  /** Re-resolves the materials of an existing object (mesh or curves). */
  private assign(item: Item): void {
    if (item.kind !== 'mesh' || !item.object || !item.geometry) return;
    if (item.batched && !this.fits(item)) this.unbatch(item, false);
    if (item.batched) {
      // The batch draws it: the object keeps an invisible stand-in with the look's side (raycasts honour it).
      (item.object as THREE.Mesh).material = this.cullBackfaces && !item.doubleSided ? HIDDEN : HIDDEN_DOUBLE;
      this.tint(item);
      return;
    }
    (item.object as THREE.Mesh).material = this.materialsFor(item, !!item.geometry.attributes.color);
  }

  /* ---------- meshes ---------- */

  /** True when the item's object was replaced, or its instance matrices changed in place: its overlays are stale. */
  private mesh(e: MeshEntry): boolean {
    const item = this.item(e, 'mesh');
    let rebuild = !item.object;
    let restyle = false;
    let moved = false;
    // Moving points (animation, skinning, an edit through the fast path) would copy into a batch every time.
    if (e.deforming || (!e.indices && (e.positions || e.normals !== undefined || e.primvars))) {
      item.dynamic = true;
      this.unbatch(item);
    }
    if (e.displayColor || e.displayOpacity !== undefined) {
      item.displayColor = e.displayColor ?? item.displayColor;
      item.displayOpacity = e.displayOpacity ?? item.displayOpacity;
      item.own?.dispose();
      item.own = null;
      restyle = true;
    }
    if (e.material !== undefined) {
      item.material = e.material;
      restyle = true;
    }
    if (e.doubleSided !== undefined && e.doubleSided !== item.doubleSided) {
      item.doubleSided = e.doubleSided;
      item.own?.dispose();
      item.own = null;
      restyle = true;
    }
    if (e.indices) {
      // A new index buffer means new topology: the entry carries every stream. Edges of the old layout go with
      // it (an entry with edges replaces them below; without, edges are off in the core).
      item.geometry?.dispose();
      if (!e.edges) {
        item.edges?.dispose();
        item.edges = null;
      }
      item.geometry = new THREE.BufferGeometry();
      item.geometry.setIndex(new THREE.BufferAttribute(e.indices, 1));
      rebuild = true;
    }
    const g = item.geometry;
    if (!g) return false;
    if (e.positions) {
      stream(g, 'position', e.positions, 3);
      g.computeBoundingBox();
      // The sphere around the box: conservative, fine for culling and the pick pre-test, and
      // two passes over the vertices cheaper than computeBoundingSphere (per frame when deforming).
      g.boundingSphere ??= new THREE.Sphere();
      g.boundingBox!.getBoundingSphere(g.boundingSphere);
    }
    if (e.counts) item.counts = e.counts;
    if (e.edges && item.edges && !e.indices) {
      // Edges alone for the layout the item has: only the index changes. Disposing the old edges geometry would
      // also drop the GPU buffer of the position attribute it shares with the mesh.
      item.edges.setIndex(new THREE.BufferAttribute(e.edges, 1));
    } else if (e.edges) {
      // With the indices (a new geometry and position attribute), or alone for an item without edges yet; later
      // same-size position updates swap that attribute's array, so the lines follow.
      item.edges?.dispose();
      item.edges = new THREE.BufferGeometry();
      item.edges.setAttribute('position', g.attributes.position);
      item.edges.setIndex(new THREE.BufferAttribute(e.edges, 1));
      item.edges.boundingBox = g.boundingBox; // updated in place by computeBounding*
      item.edges.boundingSphere = g.boundingSphere;
    }
    if (e.normals !== undefined) {
      if (e.normals) stream(g, 'normal', e.normals, 3);
      else g.deleteAttribute('normal');
      if (item.flat !== !e.normals) {
        item.flat = !e.normals;
        item.own?.dispose();
        item.own = null;
        restyle = true;
      }
    }
    for (const pv of e.primvars ?? []) {
      const name = pv.name === 'st' ? 'uv' : pv.name === 'displayColor' ? 'color' : `pv_${pv.name}`;
      stream(g, name, pv.data, pv.size);
      if (pv.size === 2 && !g.attributes.uv) g.setAttribute('uv', g.attributes[name]);
    }
    if (e.subsets !== undefined) {
      item.subsets = e.subsets;
      g.clearGroups();
      e.subsets?.forEach((s, i) => g.addGroup(s.start, s.count, i));
      restyle = true;
    }
    if (e.instances !== undefined) {
      const mesh = item.object as THREE.InstancedMesh | null;
      const one = e.instances?.length === 16;
      const same = !!e.instances && !!mesh && item.instances?.length === e.instances.length && (one ? !mesh.isInstancedMesh : mesh.isInstancedMesh);
      item.instances = e.instances;
      if (same && !rebuild && one) {
        mesh!.matrix.fromArray(e.instances!); // a single instance is a plain mesh placed by it
        this.follow(item);
        moved = true;
      } else if (same && !rebuild) {
        (mesh!.instanceMatrix.array as Float32Array).set(e.instances!);
        mesh!.instanceMatrix.needsUpdate = true;
        if (item.instanceBuffer) item.instanceBuffer.needsUpdate = true;
        mesh!.computeBoundingSphere();
        moved = true;
      } else rebuild = true;
    }
    if (rebuild) {
      const materials = this.materialsFor(item, !!g.attributes.color);
      let object: THREE.Mesh;
      // A single instance (most prototypes of an instanced stage) draws as a plain mesh placed by its matrix: three
      // builds every InstancedMesh's shaders on its own (its uuid is in the cache key), plain meshes share theirs.
      if (item.instances && item.instances.length !== 16) { // none at all is an InstancedMesh drawing nothing
        // Built with one instance: the attribute below replaces the constructor's own array.
        const instanced = new THREE.InstancedMesh(g, materials, 1);
        instanced.instanceMatrix = new THREE.InstancedBufferAttribute(item.instances, 16);
        instanced.count = item.instances.length / 16;
        instanced.computeBoundingSphere();
        item.instanceBuffer = new THREE.InstancedInterleavedBuffer(item.instances, 16, 1);
        object = instanced;
      } else {
        item.instanceBuffer = null;
        object = new THREE.Mesh(g, materials);
        if (g.index!.count > CLUSTERED) object.raycast = clusterRaycast; // picks in milliseconds, not seconds
      }
      object.castShadow = object.receiveShadow = true;
      this.attach(item, object);
      this.unsettle(item);
      return true;
    }
    if (restyle) this.assign(item);
    return moved;
  }

  /* ---------- batches ---------- */

  /** A mesh drawing on its own that might join a batch: batchUp looks at it next time. */
  private unsettle(item: Item): void {
    if (item.dynamic || item.batched) return;
    this.loose.add(item);
    this.batchDirty = true;
  }

  /**
   * True when a batch can draw the item: a plain static mesh, small, without subsets, with an opaque look that
   * leaves the vertex stage to the batch (a positionNode would replace its transform).
   */
  private batchable(item: Item): boolean {
    const g = item.geometry;
    const object = item.object as THREE.Mesh | null;
    if (item.kind !== 'mesh' || item.dynamic || !g?.index || !object?.isMesh || (object as THREE.InstancedMesh).isInstancedMesh) return false;
    if (item.subsets?.length || g.attributes.position.count > BATCH_ITEM_VERTICES) return false;
    const material = this.materials.get(item.material)?.material;
    if (!material) return item.displayOpacity >= 1;
    const m = material as THREE.MeshPhysicalNodeMaterial;
    return !m.transparent && !m.transmission && !m.positionNode && !(m.userData.readsDisplayColor && !g.attributes.color);
  }

  /** Items of one key share a batch: one look (side apart, which only swaps the material), one vertex layout. */
  private keyOf(item: Item): string {
    const g = item.geometry!;
    const layout = Object.keys(g.attributes).sort().map((name) => `${name}:${g.attributes[name].itemSize}`);
    return `${item.material}|${item.flat}|${item.doubleSided}|${item.object!.matrix.determinant() < 0}|${layout}`;
  }

  private fits(item: Item): boolean {
    return !!item.batched && this.batchable(item) && this.keyOf(item) === item.batched.batch.key;
  }

  /**
   * Gathers loose batchable meshes by key. While a flush pages in, a key's items make an exact-size batch once
   * there are BATCH_PENDING_ITEMS of them (or vertices); on its last page every key with MIN_BATCH or more does.
   * Each batch costs a shader build (its matrices texture is in three's cache key), so this keeps them few.
   */
  private batchUp(last: boolean): void {
    const groups = new Map<string, Item[]>();
    for (const item of this.loose) {
      if (!this.batchable(item)) {
        this.loose.delete(item); // unsettle() brings it back when it changes
        continue;
      }
      const key = this.keyOf(item);
      let group = groups.get(key);
      if (!group) groups.set(key, (group = []));
      group.push(item);
    }
    for (const [key, items] of groups) {
      const vertices = items.reduce((sum, item) => sum + item.geometry!.attributes.position.count, 0);
      if (last ? items.length < MIN_BATCH : items.length < BATCH_PENDING_ITEMS && vertices < BATCH_PENDING_VERTICES) continue;
      // Split by the size caps.
      let start = 0, v = 0, i = 0;
      for (let k = 0; k < items.length; k++) {
        const g = items[k].geometry!;
        if (k > start && (v + g.attributes.position.count > BATCH_VERTICES || i + g.index!.count > BATCH_INDICES)) {
          this.batch(key, items.slice(start, k), v, i);
          start = k;
          v = i = 0;
        }
        v += g.attributes.position.count;
        i += g.index!.count;
      }
      this.batch(key, items.slice(start), v, i);
    }
    if (last) this.batchDirty = false;
  }

  /** One exact-size batch, never grown: BatchedMesh's growth makes a new matrices texture, a new shader key. */
  private batch(key: string, items: Item[], vertices: number, indices: number): void {
    const first = items[0];
    const mesh = new THREE.BatchedMesh(items.length, vertices, indices, HIDDEN);
    const b: Batch = {
      key,
      material: first.material,
      flat: first.flat,
      doubleSided: first.doubleSided,
      mirrored: first.object!.matrix.determinant() < 0,
      vertexColors: !!first.geometry!.attributes.color,
      colored: false,
      mesh,
      items: new Set(),
      spheres: new Float32Array(items.length * 4),
      tiny: new Uint8Array(items.length),
    };
    mesh.perObjectFrustumCulled = true;
    mesh.sortObjects = false; // measured: sorting 14k instances costs ~15 ms a frame; opaque needs no order
    mesh.frustumCulled = false; // its own bounds would go stale as items move; the instances are culled
    mesh.boundingBox = new THREE.Box3(); // empty: bounds and framing keep measuring the items
    mesh.geometry.boundingSphere = new THREE.Sphere(); // spares the renderer an O(vertices) compute
    mesh.raycast = () => {}; // the items are picked
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // three culls front faces by the object's determinant, not an instance's: mirrored items get a mirrored batch.
    if (b.mirrored) mesh.matrix.copy(MIRROR);
    for (const item of items) {
      const geometry = mesh.addGeometry(item.geometry!);
      item.batched = { batch: b, geometry, instance: mesh.addInstance(geometry) };
      b.items.add(item);
      this.loose.delete(item);
      item.own?.dispose();
      item.own = null;
      item.geometry!.dispose(); // its GPU buffers, if it drew alone before; the arrays stay, for picking
      item.object!.frustumCulled = false; // its stand-in never draws: no per-frame sphere test
      this.assign(item);
      this.follow(item);
      this.updateVisible(item);
    }
    // Uploaded by its first frame, the batch's arrays (as large as its items' geometry) are not read again: batches
    // never change geometry. three computes each geometry's bounds lazily from them, so those come first.
    mesh.onAfterRender = () => {
      mesh.onAfterRender = () => {};
      for (let id = 0; id < items.length; id++) mesh.getBoundingSphereAt(id, SPHERE);
      const g = mesh.geometry;
      for (const attribute of [g.index!, ...Object.values(g.attributes)] as THREE.BufferAttribute[]) {
        attribute.array = new (attribute.array.constructor as Float32ArrayConstructor)(0);
      }
    };
    mesh.material = this.batchMaterial(b);
    this.batches.add(b);
    this.root.add(mesh);
  }

  /** The item draws on its own again (with `restore`, its look). Its batch keeps the hole until it is empty. */
  private unbatch(item: Item, restore = true): void {
    const batched = item.batched;
    if (!batched) return;
    const b = batched.batch;
    item.batched = null;
    b.items.delete(item);
    if (b.items.size) b.mesh.setVisibleAt(batched.instance, false);
    else {
      // ponytail: deleteGeometry scans every instance (O(n) per item): holes stay until the batch is empty.
      b.mesh.removeFromParent();
      b.mesh.dispose();
      this.batches.delete(b);
    }
    if (item.object) item.object.frustumCulled = true;
    if (restore) this.assign(item);
    this.unsettle(item);
  }

  /** Moves a batched item's instance with its object's matrix; a determinant changing sign leaves the batch. */
  private follow(item: Item): void {
    const batched = item.batched;
    if (!batched) return;
    const m = item.object!.matrix;
    const b = batched.batch;
    if (m.determinant() < 0 !== b.mirrored) {
      this.unbatch(item);
      return;
    }
    b.mesh.setMatrixAt(batched.instance, b.mirrored ? MATRIX.multiplyMatrices(MIRROR, m) : m);
    const sphere = SPHERE.copy(item.geometry!.boundingSphere!).applyMatrix4(m);
    b.spheres.set([sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius], batched.instance * 4);
  }

  /**
   * While the view moves (camera given), batched parts whose bounding sphere spans less than a pixel's radius draw
   * nothing: in a whole-stage view that can be most of the triangles. null: everything draws again.
   * `height` is the drawing buffer's height in pixels.
   */
  cullDetail(camera: THREE.Camera | null, height: number): void {
    let scale = 0; // pixels per unit at depth 1 (perspective) or at any depth (orthographic)
    const perspective = (camera as THREE.PerspectiveCamera | null)?.isPerspectiveCamera;
    if (camera && perspective) scale = height / (2 * Math.tan(((camera as THREE.PerspectiveCamera).fov * Math.PI) / 360));
    else if (camera) {
      const ortho = camera as THREE.OrthographicCamera;
      scale = (height * ortho.zoom) / Math.max(ortho.top - ortho.bottom, 1e-9);
    }
    const view = MATRIX.multiplyMatrices(camera?.matrixWorldInverse ?? MATRIX.identity(), this.root.matrixWorld).elements;
    for (const b of this.batches) {
      const s = b.spheres;
      for (const item of b.items) {
        const i = item.batched!.instance;
        let tiny = false;
        if (camera) {
          const x = s[i * 4], y = s[i * 4 + 1], z = s[i * 4 + 2];
          const depth = -(view[2] * x + view[6] * y + view[10] * z + view[14]);
          tiny = perspective ? depth > 0 && s[i * 4 + 3] * scale < depth : s[i * 4 + 3] * scale < 1;
        }
        if (tiny === !!b.tiny[i]) continue;
        b.tiny[i] = tiny ? 1 : 0;
        b.mesh.setVisibleAt(i, item.object!.visible && !tiny);
      }
    }
  }

  /** The look a batch draws with, as materialsFor gives it for one of its items. */
  private batchMaterial(b: Batch): THREE.Material {
    const single = this.cullBackfaces && !b.doubleSided;
    if (this.displayMode === 'wire') return HIDDEN;
    if (this.displayMode.startsWith('plain')) return plainLook(b.flat, single);
    const record = this.materials.get(b.material);
    return record?.material ? this.variant(record, b.flat, single) : fallbackLook(b.flat, single, b.vertexColors);
  }

  /** A batched item's colour: its displayColor while the batch shows the fallback look, white otherwise. */
  private tint(item: Item): void {
    const batched = item.batched;
    if (!batched) return;
    const b = batched.batch;
    const fallback = this.displayMode.startsWith('shaded') && !b.vertexColors && !this.materials.get(b.material)?.material;
    if (!fallback && !b.colored) return; // no colours texture: the look multiplies by nothing
    const [r, g, bl] = fallback ? item.displayColor : [1, 1, 1];
    b.mesh.setColorAt(batched.instance, COLOR.setRGB(r, g, bl));
    b.colored = true;
  }

  /** New look for a batch (display mode, cull toggle, its record's material built). */
  private restyle(b: Batch): void {
    for (const item of b.items) this.tint(item);
    b.mesh.material = this.batchMaterial(b);
  }

  private restyleBatches(): void {
    for (const b of this.batches) this.restyle(b);
  }

  /** A record's material as an item of these flags draws it (variants are made once and kept). */
  private variant(record: MaterialRecord, flat: boolean, single: boolean): THREE.Material {
    if (!flat && !single) return record.material!;
    const key = `${flat}|${single}`;
    let variant = record.variants.get(key);
    if (!variant) record.variants.set(key, (variant = style(section(record.material!.clone()), flat, single)));
    return variant;
  }

  /* ---------- curves ---------- */

  private curves(e: CurvesEntry): void {
    const item = this.item(e, 'curves');
    Object.assign(item.curves, pick(e, ['points', 'counts', 'widths', 'colors']));
    if (e.displayColor) item.displayColor = e.displayColor;
    const { points, counts, widths, colors } = item.curves;
    if (!points || !counts) return;
    item.geometry?.dispose();
    item.own?.dispose();
    if (widths) {
      item.geometry = ribbonGeometry(points, counts, widths, colors ?? null);
      item.own = ribbonMaterial(item.displayColor, !!colors);
      const mesh = new THREE.Mesh(item.geometry, item.own);
      mesh.frustumCulled = false; // expanded in the vertex stage
      this.attach(item, mesh);
    } else {
      item.geometry = hairlineGeometry(points, counts, colors ?? null);
      item.own = hairlineMaterial(item.displayColor, !!colors);
      this.attach(item, new THREE.LineSegments(item.geometry, item.own));
    }
  }

  /* ---------- points ---------- */

  private points(e: PointsEntry): void {
    const item = this.item(e, 'points');
    Object.assign(item.curves, pick(e, ['points', 'widths', 'colors']));
    if (e.displayColor) item.displayColor = e.displayColor;
    const { points, widths, colors } = item.curves;
    if (!points) return;
    item.own?.dispose();
    const count = points.length / 3;
    if (widths) {
      item.own = pointsMaterial(
        new THREE.InstancedBufferAttribute(points, 3),
        new THREE.InstancedBufferAttribute(widths, 1),
        colors ? new THREE.InstancedBufferAttribute(colors, 3) : null,
        item.displayColor,
      );
      const sprite = new THREE.Sprite(item.own as THREE.SpriteNodeMaterial);
      (sprite as any).count = count;
      sprite.frustumCulled = false;
      this.attach(item, sprite);
    } else {
      // ponytail: points without widths are 1 px on WebGPU; give them sprites if that matters.
      item.geometry?.dispose();
      item.geometry = new THREE.BufferGeometry();
      item.geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
      if (colors) item.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      const material = section(new THREE.PointsNodeMaterial({ size: 3, sizeAttenuation: false, vertexColors: !!colors }));
      if (!colors) material.color.setRGB(item.displayColor[0], item.displayColor[1], item.displayColor[2]);
      item.own = material;
      this.attach(item, new THREE.Points(item.geometry, material));
    }
  }

  /* ---------- lights ---------- */

  private light(e: LightEntry): void {
    const item = this.item(e, 'light');
    if (e.type) item.lightType = e.type;
    if (e.params) item.lightParams = e.params;
    this.rebuildLight(item);
  }

  private rebuildLight(item: Item): void {
    const p = item.lightParams;
    if (!p) return;
    if (item.lightType === 'domeLight') {
      this.domeRid = item.rid;
      this.updateEnvironment();
      return;
    }
    const scale = new THREE.Vector3().setFromMatrixScale(item.matrix);
    const size = (scale.x + scale.y + scale.z) / 3;
    const color = new THREE.Color().setRGB(p.color[0], p.color[1], p.color[2]).multiplyScalar(p.diffuse);
    const cone = p.coneAngle !== undefined && p.coneAngle < 90;
    const spot = (candela: number) => {
      const light = new THREE.SpotLight(color, candela, 0, ((p.coneAngle ?? 90) * Math.PI) / 180, p.coneSoftness ?? 0, 2);
      light.target.position.set(0, 0, -1);
      light.add(light.target);
      return light;
    };
    let light: THREE.Light;
    switch (item.lightType) {
      case 'distantLight': {
        const directional = new THREE.DirectionalLight(color, units.distantIrradiance(p));
        directional.target.position.set(0, 0, -1);
        directional.add(directional.target);
        const attached = this.sun?.parent?.parent === this.root;
        const isSun = !attached || this.sun!.userData.rid === item.rid;
        if (p.shadow && isSun) {
          directional.castShadow = true;
          directional.shadow.mapSize.set(2048, 2048);
          directional.shadow.bias = -0.0005;
          directional.shadow.radius = 3; // PCF kernel in texels: soft edges (r186 has no PCFSoftShadowMap)
          // The map is view independent: rendered when the content changes (invalidate()), not per frame.
          directional.shadow.autoUpdate = false;
          directional.shadow.needsUpdate = true;
          directional.userData.rid = item.rid;
          this.sun = directional;
        }
        light = directional;
        break;
      }
      case 'rectLight': {
        const width = (p.width ?? 1) * scale.x;
        const height = (p.height ?? 1) * scale.y;
        const nits = units.rectNits(p, width, height);
        if (!cone && !this.areaLights(item)) return;
        light = cone ? spot(nits * width * height) : new THREE.RectAreaLight(color, nits, width, height);
        break;
      }
      case 'diskLight': {
        // ponytail: disk drawn as an equal-area square; needs a custom light node to be round.
        const [side, nits] = units.diskAsRect(p, (p.radius ?? 0.5) * size);
        if (!cone && !this.areaLights(item)) return;
        light = cone ? spot(nits * side * side) : new THREE.RectAreaLight(color, nits, side, side);
        break;
      }
      case 'cylinderLight':
        // ponytail: cylinder approximated by a point light with the same mean intensity.
        light = new THREE.PointLight(color, units.cylinderCandela(p, (p.radius ?? 0.5) * size, (p.length ?? 1) * scale.x), 0, 2);
        break;
      default: {
        // sphereLight and anything unknown
        const candela = units.sphereCandela(p, (p.radius ?? 0.5) * size);
        light = cone ? spot(candela) : new THREE.PointLight(color, candela, 0, 2);
      }
    }
    // The holder carries rotation and translation only; sizes above are already in world units.
    const holder = new THREE.Group();
    holder.add(light);
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    item.matrix.decompose(position, rotation, new THREE.Vector3());
    this.attach(item, holder);
    holder.matrix.compose(position, rotation, new THREE.Vector3(1, 1, 1));
  }

  /** False until three's area-light tables are loaded (a RectAreaLight cannot draw without them); the light is built then. */
  private areaLights(item: Item): boolean {
    if (areaReady) return true;
    areaTables ??= import('three/addons/lights/RectAreaLightTexturesLib.js').then(({ RectAreaLightTexturesLib }) => {
      THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
      areaReady = true;
    });
    this.track(
      areaTables.then(() => {
        if (this.items.get(item.rid) !== item) return;
        this.rebuildLight(item);
        this.host.invalidate();
      }),
    );
    return false;
  }

  /** Keeps the background colour even where a sky or the dome's texture would fill it (lighting unchanged). */
  get solidBackground(): boolean {
    return this.plainBackground;
  }
  set solidBackground(solid: boolean) {
    this.plainBackground = solid;
    if (solid) this.scene.background = null; // at once: a dome's texture is re-applied asynchronously
    this.updateEnvironment();
  }

  /** A viewer sky (equirectangular) that lights the stage and fills the background instead of its dome; null: the stage's own. */
  setSky(texture: THREE.Texture | null): void {
    this.sky = texture;
    this.updateEnvironment();
  }

  private updateEnvironment(): void {
    const dome = this.items.get(this.domeRid);
    const p = dome?.lightParams;
    const hasLights = [...this.items.values()].some((i) => i.kind === 'light' && i.usdVisible);
    const set = (texture: THREE.Texture | null, intensity: number, background: boolean) => {
      this.scene.environment = texture;
      this.scene.environmentIntensity = intensity;
      this.scene.background = background && !this.plainBackground ? texture : null;
      this.scene.backgroundIntensity = intensity;
      this.scene.environmentRotation.set(0, 0, 0);
      this.scene.backgroundRotation.set(0, 0, 0);
      this.host.invalidate(); // lighting only: the casters, and so the shadow map, stay as they are
    };
    if (this.sky) {
      this.sky.mapping = THREE.EquirectangularReflectionMapping;
      set(this.sky, 1, true);
      return;
    }
    if (!p || !dome.usdVisible) {
      set(hasLights ? null : this.studio, 1, false);
      return;
    }
    if (!p.texture) {
      set(this.studio, units.luminance(p), false);
      return;
    }
    this.track(this.textures.get(p.texture, THREE.NoColorSpace)).then((texture) => {
      if (this.items.get(this.domeRid) !== dome || !texture || this.sky) return;
      texture.mapping = THREE.EquirectangularReflectionMapping;
      set(texture, units.luminance(p), true);
      // OpenEXR lat-long puts +Z at the image centre, three puts +X there.
      const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
      const world = new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().multiplyMatrices(this.root.matrixWorld, dome.matrix),
      );
      const euler = new THREE.Euler().setFromQuaternion(world.multiply(turn));
      this.scene.environmentRotation.copy(euler);
      this.scene.backgroundRotation.copy(euler);
    });
  }

  /* ---------- selection ---------- */

  private highlight(selected: { rid: Rid; instances?: Uint32Array }[]): void {
    for (const proxy of this.highlights) dispose(proxy);
    this.highlights = [];
    const wire = this.displayMode.endsWith('selwire');
    const lit = new Set<Item>();
    // ponytail: one overlay mesh per selected item; switch to an outline pass above a few thousand.
    for (const { rid, instances } of selected.slice(0, 2000)) {
      const item = this.items.get(rid);
      if (!item) continue;
      const active = this.activePath !== null && (item.path === this.activePath || item.path.startsWith(`${this.activePath}/`));
      if (!wire) {
        if (this.fill(item, active ? ACTIVE : HIGHLIGHT, instances)) lit.add(item);
        continue;
      }
      const proxy = this.lines(item, active ? ACTIVE_LINE : SELECTED_LINE, instances);
      if (proxy) this.highlights.push(proxy);
    }
    for (const item of this.lit) if (!lit.has(item) && item.fill) item.fill.visible = false;
    this.lit = lit;
  }

  /**
   * Shows an item's highlight: a mesh drawn on top of it with another material, sharing its geometry. It is made on
   * the item's first selection and then kept, hidden when deselected: a new overlay would cost a shader build (an
   * instanced one always, its uuid is in three's cache key) and a disposed one takes its shared build with it.
   */
  private fill(item: Item, material: THREE.Material, instances?: Uint32Array): boolean {
    if (item.kind !== 'mesh' || !item.object || !item.geometry) return false;
    let proxy = item.fill;
    if (!proxy) {
      // An instanced highlight has room for every instance; a partial selection draws the first `count`.
      proxy = instanced(item) ? new THREE.InstancedMesh(item.geometry, material, item.instances!.length / 16) : new THREE.Mesh(item.geometry, material);
      this.place(item, proxy);
      if (!instanced(item)) item.overlays.push(proxy); // released with the object
      item.fill = proxy;
    }
    // With subsets the geometry has groups; a single material ignores them only when unset.
    const groups = item.geometry.groups.length;
    if ((groups ? (proxy.material as THREE.Material[])[0] : proxy.material) !== material) proxy.material = groups ? item.geometry.groups.map(() => material) : material;
    if (instanced(item)) {
      const fill = proxy as THREE.InstancedMesh;
      const all = item.instances!;
      if (instances) instances.forEach((index, i) => fill.instanceMatrix.array.set(all.subarray(index * 16, index * 16 + 16), i * 16));
      else fill.instanceMatrix.array.set(all);
      fill.count = instances ? instances.length : all.length / 16;
      fill.instanceMatrix.needsUpdate = true;
      fill.visible = item.object.visible;
    } else proxy.visible = true;
    return true;
  }

  /** The item's authored face edges drawn as lines (wireframe, selection wire), sharing its positions. */
  private lines(item: Item, material: THREE.LineBasicNodeMaterial, instances?: Uint32Array): THREE.LineSegments | null {
    if (item.kind !== 'mesh' || !item.object || !item.edges) return null;
    if (!instanced(item)) return this.place(item, new THREE.LineSegments(item.edges, material));
    const all = item.instances!;
    const buffer = instances
      ? new THREE.InstancedInterleavedBuffer(pickInstances(all, instances), 16, 1)
      : (item.instanceBuffer ??= new THREE.InstancedInterleavedBuffer(all, 16, 1));
    const proxy = new THREE.LineSegments(item.edges, instancedLines(material, buffer));
    (proxy as any).count = buffer.count; // the renderer draws `count` instances of any object
    proxy.userData.ownsMaterial = true;
    return this.place(item, proxy);
  }

  /** Instanced overlays live outside their item: give them its visibility again (children follow it already). */
  private syncOverlayVisibility(): void {
    for (const proxy of [...this.wires, ...this.highlights]) {
      const item = proxy.userData.item as Item | undefined;
      if (item?.object) proxy.visible = item.object.visible;
    }
    for (const item of this.lit) if (instanced(item) && item.fill) item.fill.visible = item.object!.visible;
  }

  /** Overlays of plain items are children (they follow the transform); instanced ones sit in root. */
  private place<T extends THREE.Object3D>(item: Item, proxy: T): T {
    if (instanced(item)) {
      proxy.frustumCulled = false;
      proxy.visible = item.object!.visible;
      proxy.userData.item = item;
      item.overlays.push(proxy);
      this.root.add(proxy);
    } else item.object!.add(proxy);
    proxy.raycast = () => {};
    proxy.renderOrder = 1;
    return proxy;
  }
}

/* ---------- helpers ---------- */

/** Flat shading (no normals) and the side of a look. */
function style(material: THREE.Material, flat: boolean, single: boolean): THREE.Material {
  (material as THREE.MeshStandardNodeMaterial).flatShading = flat;
  material.side = single ? THREE.FrontSide : THREE.DoubleSide;
  return material;
}

/** The "no materials" look. */
function plainLook(flat: boolean, single: boolean): THREE.Material {
  return flat ? (single ? PLAIN.flatSingle : PLAIN.flatDouble) : single ? PLAIN.single : PLAIN.double;
}

/** The display-colour look batches share; each instance is tinted with its item's colour (see SceneSync.tint). */
const FALLBACKS = new Map<string, THREE.Material>();
function fallbackLook(flat: boolean, single: boolean, vertexColors: boolean): THREE.Material {
  const key = `${flat}|${single}|${vertexColors}`;
  let material = FALLBACKS.get(key);
  if (!material) FALLBACKS.set(key, (material = style(displayMaterial([1, 1, 1], 1, vertexColors), flat, single)));
  return material;
}

/** The item draws as an InstancedMesh: more than one instance (a single one is a plain mesh placed by its matrix). */
function instanced(item: Item): boolean {
  return !!(item.object as THREE.InstancedMesh | null)?.isInstancedMesh;
}

/** 16 floats per chosen instance (a copy of all of them when `picked` is omitted). */
function pickInstances(all: Float32Array, picked?: Uint32Array): Float32Array {
  if (!picked) return all.slice();
  const matrices = new Float32Array(picked.length * 16);
  picked.forEach((index, i) => matrices.set(all.subarray(index * 16, index * 16 + 16), i * 16));
  return matrices;
}

function dispose(proxy: THREE.Object3D): void {
  const item = proxy.userData.item as Item | undefined; // an instanced item's overlay: no longer one of them
  if (item) item.overlays = item.overlays.filter((o) => o !== proxy);
  proxy.removeFromParent();
  if ((proxy as THREE.InstancedMesh).isInstancedMesh) (proxy as THREE.InstancedMesh).dispose();
  else released(proxy);
  if (proxy.userData.ownsMaterial) ((proxy as THREE.LineSegments).material as THREE.Material).dispose();
}

/**
 * Tells the renderer an object is gone for good. It keeps a render object per object and material, holding the
 * geometry, until one of them fires 'dispose': objects drawn with shared materials (PLAIN, HIGHLIGHT) would keep
 * every closed stage's geometry alive.
 */
export function released(object: THREE.Object3D): void {
  (object as unknown as THREE.EventDispatcher<{ dispose: object }>).dispatchEvent({ type: 'dispose' });
}

function disposeRecord(record: MaterialRecord): void {
  record.material?.dispose();
  record.variants.forEach((variant) => variant.dispose());
  record.variants.clear();
  record.material = null;
}

function pick<T extends object, K extends keyof T>(source: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/** Same-size updates swap the array so the GPU buffer is reused. */
function stream(g: THREE.BufferGeometry, name: string, data: Float32Array, size: number): void {
  const existing = g.attributes[name] as THREE.BufferAttribute | undefined;
  if (existing && existing.array.length === data.length && existing.itemSize === size) {
    existing.array = data;
    existing.needsUpdate = true;
  } else g.setAttribute(name, new THREE.BufferAttribute(data, size));
}

function hairlineGeometry(points: Float32Array, counts: Uint32Array, colors: Float32Array | null): THREE.BufferGeometry {
  const segments = points.length / 3 - counts.length;
  const index = new Uint32Array(Math.max(segments, 0) * 2);
  let at = 0;
  let first = 0;
  for (const count of counts) {
    for (let i = 0; i + 1 < count; i++) {
      index[at++] = first + i;
      index[at++] = first + i + 1;
    }
    first += count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(points, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

/** Two vertices per curve point; the material pushes them apart by `side * width / 2`. */
function ribbonGeometry(
  points: Float32Array,
  counts: Uint32Array,
  widths: Float32Array,
  colors: Float32Array | null,
): THREE.BufferGeometry {
  const n = points.length / 3;
  const position = new Float32Array(n * 6);
  const tangent = new Float32Array(n * 6);
  const side = new Float32Array(n * 2);
  const width = new Float32Array(n * 2);
  const color = colors ? new Float32Array(n * 6) : null;
  const index = new Uint32Array(Math.max(n - counts.length, 0) * 6);
  let at = 0;
  let first = 0;
  for (const count of counts) {
    for (let i = 0; i < count; i++) {
      const p = first + i;
      const a = (first + Math.max(i - 1, 0)) * 3;
      const b = (first + Math.min(i + 1, count - 1)) * 3;
      let tx = points[b] - points[a];
      let ty = points[b + 1] - points[a + 1];
      let tz = points[b + 2] - points[a + 2];
      const length = Math.hypot(tx, ty, tz) || 1;
      tx /= length;
      ty /= length;
      tz /= length;
      for (let s = 0; s < 2; s++) {
        const v = p * 2 + s;
        position.set(points.subarray(p * 3, p * 3 + 3), v * 3);
        tangent.set([tx, ty, tz], v * 3);
        side[v] = s ? 1 : -1;
        width[v] = widths[p];
        color?.set(colors!.subarray(p * 3, p * 3 + 3), v * 3);
      }
      if (i + 1 < count) {
        const v = p * 2;
        index.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], at);
        at += 6;
      }
    }
    first += count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('curveTangent', new THREE.BufferAttribute(tangent, 3));
  g.setAttribute('side', new THREE.BufferAttribute(side, 1));
  g.setAttribute('width', new THREE.BufferAttribute(width, 1));
  if (color) g.setAttribute('color', new THREE.BufferAttribute(color, 3));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}
