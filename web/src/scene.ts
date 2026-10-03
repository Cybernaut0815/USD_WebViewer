// Applies render deltas from the core to a three.js scene graph.
import * as THREE from 'three/webgpu';
import {
  ACTIVE,
  ACTIVE_LINE,
  buildMaterial,
  displayMaterial,
  hairlineMaterial,
  HIDDEN,
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
import * as units from './units.ts';

const GREY = [0.18, 0.18, 0.18];

interface Item {
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
  private wires: THREE.Object3D[] = [];
  /** Bumped on every change, so callers can cache what they derive from the scene. */
  version = 0;
  private sun: THREE.DirectionalLight | null = null; // the one light that casts shadows
  private readonly materials = new Map<Rid, MaterialRecord>();
  private highlights: THREE.Object3D[] = [];
  private selected: { rid: Rid; instances?: Uint32Array }[] = [];
  private activePath: Path | null = null;
  /** Items a drag moves ahead of the core, with the world matrix they started from. */
  private preview = new Map<Rid, { item: Item; start: THREE.Matrix4 }>();
  private lastBoundsBump = 0;
  private domeRid: Rid = 0;
  private studio: THREE.Texture | null = null;
  private sky: THREE.Texture | null = null;
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
    this.root.rotation.x = axis === 'Z' ? -Math.PI / 2 : 0;
    this.root.updateMatrixWorld(true);
  }

  apply(delta: RenderDelta): void {
    delta.removed?.forEach((rid) => this.remove(rid));
    delta.materials?.forEach((entry) => this.material(entry));
    delta.meshes?.forEach((entry) => this.mesh(entry));
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
        else if (item.object && !item.instances && !this.preview.has(rid)) item.object.matrix.copy(item.matrix);
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
    // Rebuilt meshes are new objects, so the overlays are redone with them; instanced overlays
    // live outside their mesh and take its visibility when built.
    const rebuilt = delta.meshes || delta.removed || delta.visibility;
    if (delta.selected) this.selected = delta.selected;
    if (delta.selected || (this.selected.length && rebuilt)) this.highlight(this.selected);
    if (rebuilt) this.wireframes();
    if (delta.lights || delta.removed) this.updateEnvironment();
    // The version drives a walk over every object (bounds, shadow fit): structural changes bump
    // it at once, moving objects at most twice a second.
    const structural = !!(delta.removed || delta.meshes || delta.curves || delta.points || delta.lights || delta.cameras);
    const now = performance.now();
    if (structural || (delta.xforms && now - this.lastBoundsBump > 500)) {
      this.version++;
      this.lastBoundsBump = now;
    }
    this.host.invalidate();
  }

  /** Forces the next frame to refit bounds and shadows (after a drag). */
  touch(): void {
    this.version++;
    this.lastBoundsBump = performance.now();
    this.host.invalidate();
  }

  /* ---------- drag prediction ---------- */

  /**
   * The one exception to "the core moves the objects": while a gizmo drags, the listed
   * subtrees follow the pointer at once; the core's xforms confirm and take over at the end.
   */
  beginPreview(paths: Path[]): void {
    this.preview.clear();
    const under = (path: Path, root: Path) => path === root || path.startsWith(root === '/' ? '/' : `${root}/`);
    for (const item of this.items.values()) {
      // ponytail: instanced prims and lights wait for the core (instance matrices and light rigs are built there).
      if (!item.object || item.instances || item.kind === 'light' || item.kind === 'camera') continue;
      if (paths.some((root) => under(item.path, root))) this.preview.set(item.rid, { item, start: item.matrix.clone() });
    }
  }

  /** World-space delta since the drag started, applied to every previewed object. */
  previewDelta(delta: THREE.Matrix4): void {
    for (const { item, start } of this.preview.values()) item.object!.matrix.multiplyMatrices(delta, start);
    this.host.invalidate();
  }

  endPreview(): void {
    for (const { item } of this.preview.values()) item.object?.matrix.copy(item.matrix);
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
    for (const rid of [...this.items.keys()]) this.remove(rid);
    for (const record of this.materials.values()) disposeRecord(record);
    this.materials.clear();
    this.selected = [];
    this.highlight([]);
    this.wireframes();
    this.textures.dispose();
    this.updateEnvironment();
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
    this.highlight(this.selected);
    this.wireframes();
    this.host.invalidate();
  }

  setDisplayMode(mode: DisplayMode): void {
    if (mode === this.displayMode) return;
    this.displayMode = mode;
    for (const item of this.items.values()) if (item.kind === 'mesh') this.assign(item);
    this.highlight(this.selected);
    this.wireframes();
    this.host.invalidate();
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
    this.host.invalidate();
  }

  setCullBackfaces(cull: boolean): void {
    this.cullBackfaces = cull;
    for (const item of this.items.values()) {
      if (item.kind !== 'mesh') continue;
      item.own?.dispose();
      item.own = null;
      this.assign(item);
    }
    this.host.invalidate();
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
    const list = [];
    for (const item of this.items.values()) {
      if (item.object && (item.path === path || item.path.startsWith(path === '/' ? '/' : path + '/'))) {
        list.push(item.object);
      }
    }
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
    if (!item.object) return;
    this.root.remove(item.object);
    item.object.traverse((o) => (o as any).isLight && (o as THREE.Light).dispose());
    if ((item.object as THREE.InstancedMesh).isInstancedMesh) (item.object as THREE.InstancedMesh).dispose();
    item.object = null;
  }

  private attach(item: Item, object: THREE.Object3D): void {
    this.detach(item);
    object.userData.rid = item.rid;
    object.matrixAutoUpdate = false;
    if (!item.instances) object.matrix.copy(item.matrix);
    item.object = object;
    this.root.add(object);
    this.updateVisible(item);
  }

  private updateVisible(item: Item): void {
    if (item.object) item.object.visible = item.usdVisible && this.purposes.has(item.purpose);
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
        if (item.material === entry.rid || item.subsets?.some((s) => s.material === entry.rid)) this.assign(item);
      }
      this.host.invalidate();
    });
  }

  private materialsFor(item: Item, vertexColors: boolean): THREE.Material | THREE.Material[] {
    if (this.displayMode === 'wire') return HIDDEN;
    const single = this.cullBackfaces && !item.doubleSided;
    if (this.displayMode.startsWith('plain')) return single ? PLAIN.single : PLAIN.double;
    const style = (material: THREE.Material) => {
      (material as any).flatShading = item.flat;
      material.side = single ? THREE.FrontSide : THREE.DoubleSide;
      return material;
    };
    const fallback = () => (item.own ??= style(displayMaterial(item.displayColor, item.displayOpacity, vertexColors)));
    const one = (rid: Rid) => {
      const record = this.materials.get(rid);
      if (!record?.material) return fallback();
      if (!item.flat && !single) return record.material;
      const key = `${item.flat}|${single}`;
      let variant = record.variants.get(key);
      if (!variant) record.variants.set(key, (variant = style(record.material.clone())));
      return variant;
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
    if (item.kind === 'mesh' && item.object && item.geometry) {
      (item.object as THREE.Mesh).material = this.materialsFor(item, !!item.geometry.attributes.color);
    }
  }

  /* ---------- meshes ---------- */

  private mesh(e: MeshEntry): void {
    const item = this.item(e, 'mesh');
    let rebuild = !item.object;
    let restyle = false;
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
      // A new index buffer means new topology: the entry carries every stream.
      item.geometry?.dispose();
      item.geometry = new THREE.BufferGeometry();
      item.geometry.setIndex(new THREE.BufferAttribute(e.indices, 1));
      rebuild = true;
    }
    const g = item.geometry;
    if (!g) return;
    if (e.positions) {
      stream(g, 'position', e.positions, 3);
      g.computeBoundingBox();
      g.computeBoundingSphere();
    }
    if (e.counts) item.counts = e.counts;
    if (e.edges) {
      // Edges come with the indices, so the mesh geometry (and its position attribute) is new too;
      // later same-size position updates swap that attribute's array, so the lines follow.
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
      const same = !!e.instances && mesh?.isInstancedMesh && item.instances?.length === e.instances.length;
      item.instances = e.instances;
      if (same && !rebuild) {
        (mesh!.instanceMatrix.array as Float32Array).set(e.instances!);
        mesh!.instanceMatrix.needsUpdate = true;
        mesh!.computeBoundingSphere();
      } else rebuild = true;
    }
    if (rebuild) {
      const materials = this.materialsFor(item, !!g.attributes.color);
      let object: THREE.Mesh;
      if (item.instances) {
        const count = item.instances.length / 16;
        const instanced = new THREE.InstancedMesh(g, materials, count);
        instanced.instanceMatrix = new THREE.InstancedBufferAttribute(item.instances, 16);
        instanced.computeBoundingSphere();
        object = instanced;
      } else object = new THREE.Mesh(g, materials);
      object.castShadow = object.receiveShadow = true;
      this.attach(item, object);
    } else if (restyle) this.assign(item);
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
      const material = new THREE.PointsNodeMaterial({ size: 3, sizeAttenuation: false, vertexColors: !!colors });
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
        light = cone ? spot(nits * width * height) : new THREE.RectAreaLight(color, nits, width, height);
        break;
      }
      case 'diskLight': {
        // ponytail: disk drawn as an equal-area square; needs a custom light node to be round.
        const [side, nits] = units.diskAsRect(p, (p.radius ?? 0.5) * size);
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
      this.scene.background = background ? texture : null;
      this.scene.backgroundIntensity = intensity;
      this.scene.environmentRotation.set(0, 0, 0);
      this.scene.backgroundRotation.set(0, 0, 0);
      this.host.invalidate();
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
    // ponytail: one overlay mesh per selected item; switch to an outline pass above a few thousand.
    for (const { rid, instances } of selected.slice(0, 2000)) {
      const item = this.items.get(rid);
      if (!item) continue;
      const active = this.activePath !== null && (item.path === this.activePath || item.path.startsWith(`${this.activePath}/`));
      const proxy = wire
        ? this.lines(item, active ? ACTIVE_LINE : SELECTED_LINE, instances)
        : this.overlay(item, active ? ACTIVE : HIGHLIGHT, instances);
      if (proxy) this.highlights.push(proxy);
    }
  }

  /** A mesh drawn on top of an item with another material (highlight), sharing its geometry. */
  private overlay(item: Item, material: THREE.Material, instances?: Uint32Array): THREE.Mesh | null {
    if (item.kind !== 'mesh' || !item.object || !item.geometry) return null;
    let proxy: THREE.Mesh;
    if (item.instances) {
      const matrices = pickInstances(item.instances, instances);
      const instanced = new THREE.InstancedMesh(item.geometry, material, matrices.length / 16);
      instanced.instanceMatrix = new THREE.InstancedBufferAttribute(matrices, 16);
      proxy = instanced;
    } else proxy = new THREE.Mesh(item.geometry, material);
    // With subsets the geometry has groups; a single material ignores them only when unset.
    if (item.geometry.groups.length) proxy.material = item.geometry.groups.map(() => material);
    return this.place(item, proxy);
  }

  /** The item's authored face edges drawn as lines (wireframe, selection wire), sharing its positions. */
  private lines(item: Item, material: THREE.LineBasicNodeMaterial, instances?: Uint32Array): THREE.LineSegments | null {
    if (item.kind !== 'mesh' || !item.object || !item.edges) return null;
    if (!item.instances) return this.place(item, new THREE.LineSegments(item.edges, material));
    const matrices = pickInstances(item.instances, instances);
    const proxy = new THREE.LineSegments(item.edges, instancedLines(material, matrices));
    (proxy as any).count = matrices.length / 16; // the renderer draws `count` instances of any object
    proxy.userData.ownsMaterial = true;
    return this.place(item, proxy);
  }

  /** Overlays of plain items are children (they follow the transform); instanced ones sit in root. */
  private place<T extends THREE.Object3D>(item: Item, proxy: T): T {
    if (item.instances) {
      proxy.frustumCulled = false;
      proxy.visible = item.object!.visible;
      this.root.add(proxy);
    } else item.object!.add(proxy);
    proxy.raycast = () => {};
    proxy.renderOrder = 1;
    return proxy;
  }
}

/* ---------- helpers ---------- */

/** 16 floats per chosen instance (all when `picked` is omitted). */
function pickInstances(all: Float32Array, picked?: Uint32Array): Float32Array {
  if (!picked) return all.slice();
  const matrices = new Float32Array(picked.length * 16);
  picked.forEach((index, i) => matrices.set(all.subarray(index * 16, index * 16 + 16), i * 16));
  return matrices;
}

function dispose(proxy: THREE.Object3D): void {
  proxy.removeFromParent();
  if ((proxy as THREE.InstancedMesh).isInstancedMesh) (proxy as THREE.InstancedMesh).dispose();
  if (proxy.userData.ownsMaterial) ((proxy as THREE.LineSegments).material as THREE.Material).dispose();
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
