// The 3D view: renderer, cameras, navigation, picking and framing.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import type { Path, Rid } from './protocol.ts';
import { type SceneHost, SceneSync } from './scene.ts';
import { boxClipped, clean, EMPTY, equal, keeps, rows, type Section, type SectionSource, type Vec3 } from './section.ts';
import { arm, SECTIONS, WARM_UPS } from './sectionnode.ts';
import { HELPERS, type SectionGizmo, type SectionMode, SectionTool } from './sectiontool.ts';
import type { Tool } from './tools.ts';
import { verticalFov } from './units.ts';

export type ToneMapping = 'none' | 'neutral' | 'aces' | 'agx';
/** The view's background where no sky or dome texture fills it. */
export const DEFAULT_BACKGROUND = '#26282b';

/** The free camera's lens. Focal length is 35 mm equivalent on a 24 mm high gate, so it fixes the vertical field of view. */
export interface CameraSettings {
  projection: 'perspective' | 'orthographic';
  focalLength: number; // mm
  /** Near and far follow the stage's bounds; off: the values below. */
  autoClip: boolean;
  near: number;
  far: number;
}
/**
 * The free view in world space: the eye, the orbit target, the vertical field of view (degrees), the projection and the
 * orthographic half-height. Up is world +Y, the orbit's own.
 */
export interface ViewState {
  eye: [number, number, number];
  target: [number, number, number];
  fov: number;
  projection: CameraSettings['projection'];
  height: number;
}
const GATE = 24; // mm, vertical
const focalToFov = (focal: number) => (2 * Math.atan(GATE / 2 / focal) * 180) / Math.PI;
const fovToFocal = (fov: number) => GATE / 2 / Math.tan((fov * Math.PI) / 360);
const TONE_MAPPING: Record<ToneMapping, THREE.ToneMapping> = {
  none: THREE.LinearToneMapping, // keeps exposure working
  neutral: THREE.NeutralToneMapping,
  aces: THREE.ACESFilmicToneMapping,
  agx: THREE.AgXToneMapping,
};

export class Viewport {
  readonly renderer: THREE.WebGPURenderer;
  readonly scene = new THREE.Scene();
  readonly sync: SceneSync;
  readonly freeCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
  /** The free camera in orthographic projection; shares position and orbit with the perspective one. */
  readonly orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.freeCamera;
  private autoClip = true;
  backend: 'webgpu' | 'webgl2' | null = null;
  readonly canvas: HTMLCanvasElement;
  readonly controls: OrbitControls;
  /** Path of the stage camera being looked through, null for the free camera. */
  cameraPath: Path | null = null;
  /** Navigate's speed factor (the wheel's setting), kept while other tools are active. */
  flySpeed = 1;
  private readonly resizer: ResizeObserver;
  private dirty = false;
  private frameRequest = 0;
  private presented: (() => void)[] = [];
  /** The first section's materials building off-frame (warm()); no frame is drawn meanwhile. */
  private warming: Promise<void> | null = null;
  /** World bounds of the stage, refreshed before the first frame after it changed. */
  readonly stageSphere = new THREE.Sphere();
  private stageVersion = -1;
  private activeTool: Tool | null = null;
  private frameTimes: number[] = []; // when the frames of the last second were drawn
  /** CPU time of the last renderer.render call, in milliseconds. */
  frameMs = 0;
  /** Called before each frame is drawn, with the camera of that frame in place (gizmos, overlays). */
  readonly beforeRender = new Set<() => void>();
  /** Host objects (the element's three.overlay): framed and clipped with the stage, never picked. */
  readonly overlay = new THREE.Group();
  /** Right click on a prim in the view (set by the element: its prim menu). */
  oncontext: (path: Path, x: number, y: number) => void = () => {};
  /** The section changed (set by the element: its sectionchange event). */
  onsection: (source: SectionSource) => void = () => {};
  /** The section's selection (sectionGizmo) changed, its chosen handles included (set by the element: sectiongizmochange). */
  onsectiongizmo: () => void = () => {};
  /** A right click on a section entry, which is selected by then (set by the element: its section menu). */
  onsectionmenu: (x: number, y: number) => void = () => {};
  private sectionState = EMPTY;
  /** The section packed for the shader and keeps() (section.ts rows()), in stage space. */
  private sectionRows = rows(EMPTY, 'Y');
  /** Made with the first section entry or selection, then kept. */
  private sectionTool: SectionTool | null = null;
  private handles = true;
  private mode: SectionMode = 'none';

  constructor(canvas: HTMLCanvasElement, host: Omit<SceneHost, 'invalidate'>, forceWebGL: boolean) {
    this.canvas = canvas;
    for (const camera of [this.freeCamera, this.orthoCamera]) camera.layers.enable(HELPERS);
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    this.renderer.setClearColor(DEFAULT_BACKGROUND);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.sync = new SceneSync(this.scene, {
      readBytes: (path) => host.readBytes(path),
      warn: (message) => host.warn(message),
      invalidate: () => this.invalidate(),
    });
    this.scene.add(this.overlay);
    this.controls = new OrbitControls(this.freeCamera, canvas);
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.invalidate());
    this.freeCamera.position.set(3, 2, 4);
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(canvas);
    WARM_UPS.add(this.warm);
  }

  async init(): Promise<void> {
    await this.renderer.init();
    this.backend = (this.renderer.backend as any).isWebGPUBackend ? 'webgpu' : 'webgl2';
    THREE.RectAreaLightNode.setLTC(RectAreaLightTexturesLib.init());
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.sync.setStudioEnvironment(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);
    pmrem.dispose();
    this.resize();
  }

  /** The tool that owns pointer input on the canvas; setting it deactivates the previous one. */
  get tool(): Tool | null {
    return this.activeTool;
  }
  set tool(next: Tool | null) {
    this.activeTool?.deactivate();
    this.activeTool = next;
    next?.activate(this);
  }

  /** Requests one render on the next animation frame (after the warm-up, while one runs). */
  invalidate(): void {
    this.dirty = true;
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      // While warming the canvas keeps its last frame: a render would build the rest at once, the freeze again.
      if (!this.dirty || !this.backend || this.warming) return;
      this.dirty = false;
      this.refreshBounds();
      if (this.cameraPath) this.followStageCamera();
      else this.fitClipPlanes();
      try {
        this.camera.updateMatrixWorld(); // hooks see this frame's camera (lookAt leaves its matrices a step behind)
        for (const hook of this.beforeRender) hook();
        const start = performance.now();
        this.renderer.render(this.scene, this.camera);
        const end = performance.now();
        this.frameMs = end - start;
        this.frameTimes.push(end);
        while (this.frameTimes[0] < end - 1000) this.frameTimes.shift();
      } finally {
        this.presented.splice(0).forEach((done) => done()); // waiters must not hang on a failed frame
      }
    });
  }

  /** Frames drawn in the last second; null when nothing was drawn (the view renders on demand). */
  get fps(): number | null {
    const now = performance.now();
    const count = this.frameTimes.filter((t) => t > now - 1000).length;
    return count ? count : null;
  }

  /** Resolves after the next frame has been rendered. */
  nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      this.presented.push(resolve);
      this.invalidate();
    });
  }

  /**
   * Builds what the view draws with the newly sectioned materials off-frame: three yields between objects. Without
   * scheduler.yield it would wait a frame per object (about 30 s for 1,800 meshes, and never in a hidden tab), so
   * there the next frame builds them at once.
   */
  private readonly warm = (): void => {
    // Not globalThis.scheduler: the DOM lib of TypeScript before 6 does not declare it, and hosts check this source.
    if (!this.backend || typeof (globalThis as { scheduler?: { yield?: unknown } }).scheduler?.yield !== 'function') return;
    // ponytail: three r186's compileAsync queues what the view draws at once and builds it later, one object per
    // yield, which takes two workarounds; drop them once three handles both. It would build a transparent double-sided
    // material's two passes (back, then front) as one variant, which draws them a little differently until the
    // material changes: such materials stay out of the queue (hidden while it is made) and build in the first frame.
    // And it builds what is disposed meanwhile all the same, and keeps it: the 'dispose' events heard meanwhile fire
    // again once it is done, so three frees what it built for them. A stage closed meanwhile still shows its last frame
    // until the queue is built (up to the whole warm-up); end the hold on stageclose if that matters.
    type Disposable = THREE.EventDispatcher<{ dispose: object }>;
    const drawn = new Set<Disposable>(), gone = new Set<Disposable>(), twoPass = new Set<THREE.Material>();
    const heard = ({ target }: { target: Disposable }) => void gone.add(target);
    this.scene.traverseVisible((o) => {
      const { geometry, material } = o as THREE.Mesh;
      if (!geometry) return;
      for (const t of [o, geometry, ...[material ?? []].flat()]) drawn.add(t as unknown as Disposable);
      for (const m of [material ?? []].flat()) if (m.visible && m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) twoPass.add(m);
    });
    for (const m of twoPass) m.visible = false;
    const queued = this.renderer.compileAsync(this.scene, this.camera); // queues before its first await
    for (const m of twoPass) m.visible = true;
    for (const t of drawn) t.addEventListener('dispose', heard);
    this.warming = queued
      .catch(() => {}) // a failed warm-up only means the next frame builds them
      .finally(() => {
        this.warming = null;
        for (const t of drawn) t.removeEventListener('dispose', heard);
        if (!WARM_UPS.has(this.warm)) return; // disposed: no frame, and the renderer went with what it built
        this.invalidate();
        for (const t of gone) t.dispatchEvent({ type: 'dispose' });
      });
  };

  get background(): string {
    return this.renderer.getClearAlpha() ? `#${this.renderer.getClearColor(new THREE.Color()).getHexString()}` : 'transparent';
  }
  set background(color: string) {
    // 'transparent': clear alpha 0, the page behind the element shows through.
    this.renderer.setClearColor(/^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_BACKGROUND, color === 'transparent' ? 0 : 1);
    this.invalidate();
  }

  set exposure(ev: number) {
    this.renderer.toneMappingExposure = 2 ** ev;
    this.invalidate();
  }
  set toneMapping(mode: ToneMapping) {
    this.renderer.toneMapping = TONE_MAPPING[mode];
    this.invalidate();
  }

  /** The free camera in its current projection (what the orbit controls move). */
  get view(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.controls.object as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  }

  get cameraSettings(): CameraSettings {
    const view = this.view;
    return {
      projection: view === this.orthoCamera ? 'orthographic' : 'perspective',
      focalLength: fovToFocal(this.freeCamera.fov),
      autoClip: this.autoClip,
      near: view.near,
      far: view.far,
    };
  }
  set cameraSettings(settings: Partial<CameraSettings>) {
    if (settings.focalLength !== undefined) {
      this.freeCamera.fov = focalToFov(Math.min(Math.max(settings.focalLength, 1), 2000));
      this.freeCamera.updateProjectionMatrix();
    }
    if (settings.projection && settings.projection !== this.cameraSettings.projection) this.switchProjection(settings.projection);
    if (settings.autoClip !== undefined) this.autoClip = settings.autoClip;
    for (const camera of [this.freeCamera, this.orthoCamera]) {
      if (settings.near !== undefined) camera.near = settings.near;
      if (settings.far !== undefined) camera.far = settings.far;
      camera.updateProjectionMatrix();
    }
    this.invalidate();
  }

  get viewState(): ViewState {
    const view = this.view, target = this.controls.target, ortho = view === this.orthoCamera;
    const height = ortho ? this.orthoCamera.top / this.orthoCamera.zoom : view.position.distanceTo(target) * Math.tan((this.freeCamera.fov * Math.PI) / 360);
    return {
      eye: [view.position.x, view.position.y, view.position.z], target: [target.x, target.y, target.z],
      fov: this.freeCamera.fov, projection: ortho ? 'orthographic' : 'perspective', height,
    };
  }
  /** Moves the free view (the orbit goes on from there); leaving a stage camera is the element's part. */
  set viewState(state: ViewState) {
    if (state.projection !== this.cameraSettings.projection) this.switchProjection(state.projection);
    this.freeCamera.fov = Math.min(Math.max(state.fov, 0.01), 179);
    this.freeCamera.updateProjectionMatrix();
    const view = this.view;
    view.position.fromArray(state.eye);
    this.controls.target.fromArray(state.target);
    if (view.position.distanceToSquared(this.controls.target) < 1e-18) this.controls.target.z -= 1; // no direction: look along -Z
    if (view === this.orthoCamera) {
      const half = Math.max(state.height, 1e-6);
      this.orthoCamera.top = half;
      this.orthoCamera.bottom = -half;
      this.orthoCamera.zoom = 1;
      this.resize();
    }
    this.controls.update();
    this.invalidate();
  }

  /** Swaps the free camera's projection, keeping what is in view around the orbit target the same size. */
  private switchProjection(projection: CameraSettings['projection']): void {
    const persp = this.freeCamera;
    const ortho = this.orthoCamera;
    const target = this.controls.target;
    const tanHalf = Math.tan((persp.fov * Math.PI) / 360);
    if (projection === 'orthographic') {
      const half = Math.max(persp.position.distanceTo(target) * tanHalf, 1e-6);
      ortho.position.copy(persp.position);
      ortho.quaternion.copy(persp.quaternion);
      ortho.top = half;
      ortho.bottom = -half;
      ortho.zoom = 1;
      this.controls.object = ortho;
    } else {
      const half = ortho.top / ortho.zoom;
      const direction = ortho.position.clone().sub(target).normalize();
      persp.position.copy(target).addScaledVector(direction, half / tanHalf);
      persp.quaternion.copy(ortho.quaternion);
      this.controls.object = persp;
    }
    if (this.cameraPath === null) this.camera = this.view;
    this.resize();
    this.controls.update();
  }

  /** World-space bounds of the given objects, or of the whole stage. */
  bounds(objects: THREE.Object3D[] = [this.sync.root]): THREE.Box3 {
    const box = new THREE.Box3();
    this.sync.root.updateMatrixWorld(true);
    for (const object of objects) box.expandByObject(object);
    return box;
  }

  frame(objects?: THREE.Object3D[]): void {
    const box = this.bounds(objects);
    if (box.isEmpty()) return;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const radius = Math.max(sphere.radius, 1e-6);
    const view = this.view;
    const half = (this.freeCamera.fov * Math.PI) / 360; // half the vertical field of view
    // a canvas narrower than tall fits its width; one with no width (hidden, collapsed) its height, having none to fit
    const aspect = this.canvas.clientWidth ? this.freeCamera.aspect : 1;
    const fit = Math.min(half, Math.atan(Math.tan(half) * aspect));
    const distance = (radius / Math.sin(fit)) * 1.15;
    const direction = view.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(1, 0.6, 1);
    this.controls.target.copy(sphere.center);
    view.position.copy(sphere.center).addScaledVector(direction.normalize(), distance);
    if (view === this.orthoCamera) {
      view.zoom = (view.top * Math.min(1, aspect)) / (radius * 1.15); // the half-width is top * aspect (resize)
      view.updateProjectionMatrix();
    }
    this.controls.update();
    this.invalidate();
  }

  /** Looks through a stage camera, or returns to the free camera with null. */
  lookThrough(path: Path | null): void {
    this.cameraPath = path;
    this.controls.enabled = path === null;
    if (path === null) this.camera = this.view;
    this.resize();
  }

  /** Clipping planes and boxes in stage space (see section.ts): a copy. */
  get section(): Section {
    return structuredClone(this.sectionState);
  }

  /**
   * Cleans and applies a section at once, before any frame (a host's own render of a hidden page is cut too); a no-op
   * when nothing changed. GPU only: the stage's objects stay as they are and the shadow map is not redrawn.
   */
  setSection(input: unknown, source: SectionSource): void {
    const next = clean(input, this.sync.upAxis);
    if (equal(next, this.sectionState)) return;
    this.sectionState = next;
    this.sectionRows = rows(next, this.sync.upAxis);
    SECTIONS.set(this.scene, { rows: this.sectionRows, root: this.sync.root });
    // The outlines first (letting go of what went, following at once: see SectionTool.place), so the first section's
    // warm-up builds them too.
    if (next.planes.length || next.boxes.length) this.editor();
    this.sectionTool?.sectionChanged();
    if (this.sectionRows[3]) arm();
    this.invalidate(); // not SceneSync's: that one redraws the shadow map
    this.onsection(source);
  }

  /** Removes planes and boxes (indices); the selection stays on the entries left. */
  removeSections(planes: number[], boxes: number[], source: SectionSource): void {
    const before = JSON.stringify(this.sectionGizmo);
    const s = this.sectionState;
    this.sectionTool?.removing(planes, boxes);
    this.setSection({ ...s, planes: s.planes.filter((_, i) => !planes.includes(i)), boxes: s.boxes.filter((_, i) => !boxes.includes(i)) }, source);
    if (JSON.stringify(this.sectionGizmo) !== before) this.onsectiongizmo();
  }

  /** Del: removes the selected planes and boxes (source 'ui'). */
  removeSelectedSections(): void {
    const { planes, boxes } = this.sectionSelected;
    this.removeSections(planes, boxes, 'ui');
  }

  /** The selected planes and boxes, by index. */
  get sectionSelected(): { planes: number[]; boxes: number[] } {
    return this.sectionTool?.selected ?? { planes: [], boxes: [] };
  }

  /** What the section gizmo does with the selection: nothing, move or turn it (the element sets it from its tool). */
  get sectionMode(): SectionMode {
    return this.mode;
  }
  set sectionMode(mode: SectionMode) {
    const before = JSON.stringify(this.sectionGizmo);
    this.mode = mode;
    this.sectionTool?.place();
    if (JSON.stringify(this.sectionGizmo) !== before) this.onsectiongizmo(); // the one-entry forms carry rotate
  }

  /** The selected section entries, a box with its chosen handles (see SectionGizmo); null with none. */
  get sectionGizmo(): SectionGizmo | null {
    return this.sectionTool?.value ?? null;
  }
  /** Selects afresh (see SectionTool.select); null, or entries the section lacks, select nothing. */
  set sectionGizmo(target: SectionGizmo | null) {
    const before = JSON.stringify(this.sectionGizmo);
    if (target) this.editor().select(target);
    else this.sectionTool?.select(null);
    if (JSON.stringify(this.sectionGizmo) !== before) this.onsectiongizmo();
  }

  /**
   * Outlines and dots on every section entry while the section is on, which a click selects; off, only the selected
   * entries show them. Turning it off lets go of the selection.
   */
  get sectionHandles(): boolean {
    return this.handles;
  }
  set sectionHandles(on: boolean) {
    this.handles = on;
    if (!on) this.sectionGizmo = null;
    this.sectionTool?.place();
  }

  /** True while a section dot, outline or gizmo axis is under the pointer or dragged: the tools leave the pointer alone then. */
  gizmoGrabbed(): boolean {
    return this.sectionTool?.grabbed() ?? false;
  }

  /** True over a section dot, outline or gizmo axis at a client point (hosts' pointer arbitration). */
  sectionGizmoAt(clientX: number, clientY: number): boolean {
    return this.sectionTool?.at(clientX, clientY) ?? false;
  }

  /** Esc: drops the chosen box handles, or with none chosen lets go of the selection. */
  escapeSectionGizmo(): void {
    if (this.sectionTool && !this.sectionTool.clear()) this.sectionGizmo = null;
  }

  private editor(): SectionTool {
    return (this.sectionTool ??= new SectionTool(this));
  }

  /** False where the section cuts a three-world point away. */
  keeps(point: THREE.Vector3): boolean {
    if (!this.sectionRows[3]) return true; // no section on: nothing to convert (hosts ask per hover hit)
    const p = point.clone().applyMatrix4(this.sync.root.matrixWorld.clone().invert());
    return keeps(this.sectionRows, p.x, p.y, p.z);
  }

  /** First render item under a client-space point (where the section cuts it away, the one behind). */
  pick(clientX: number, clientY: number): { rid: Rid; instance: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    // ponytail: CPU raycast, linear in triangles; add three-mesh-bvh or an id pass for huge meshes.
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.camera);
    for (const hit of raycaster.intersectObjects(this.sync.root.children, true)) {
      let object: THREE.Object3D | null = hit.object;
      let visible = true;
      let rid = 0;
      for (; object && object !== this.sync.root; object = object.parent) {
        visible &&= object.visible;
        rid ||= object.userData.rid ?? 0;
      }
      // A single instance is a plain mesh (see SceneSync.mesh): instance 0 of its item.
      if (visible && rid && this.keeps(hit.point)) return { rid, instance: hit.instanceId ?? (this.sync.items.get(rid)?.instances ? 0 : -1) };
    }
    return null;
  }

  /**
   * Render items (and instances) in a client-space rectangle: those whose screen bounds lie fully
   * inside it, or with `touching` those whose screen bounds overlap it; not those the section provably cuts away.
   * ponytail: bounding boxes, not silhouettes, so touching over-selects near corners; test vertices if that bites.
   */
  boxPick(r: { left: number; top: number; right: number; bottom: number }, contained: boolean): { rid: Rid; instance: number }[] {
    const canvas = this.canvas.getBoundingClientRect();
    this.sync.root.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    const corner = new THREE.Vector3();
    const cornerOf = (box: THREE.Box3, i: number) => corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
    const toStage = this.sync.root.matrixWorld.clone().invert();
    const stage = new THREE.Matrix4();
    const corners = Array.from({ length: 8 }, (): Vec3 => [0, 0, 0]); // in stage space, for the section
    const inRect = (box: THREE.Box3, world: THREE.Matrix4): boolean => {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (let i = 0; i < 8; i++) {
        cornerOf(box, i).applyMatrix4(world).project(this.camera);
        if (corner.z > 1) return false; // behind the camera
        const x = canvas.left + ((corner.x + 1) / 2) * canvas.width;
        const y = canvas.top + ((1 - corner.y) / 2) * canvas.height;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      const inside = contained
        ? left >= r.left && right <= r.right && top >= r.top && bottom <= r.bottom
        : left <= r.right && right >= r.left && top <= r.bottom && bottom >= r.top;
      if (!inside || !this.sectionRows[3]) return inside; // stage space only for what the section could hide
      stage.multiplyMatrices(toStage, world);
      for (let i = 0; i < 8; i++) cornerOf(box, i).applyMatrix4(stage).toArray(corners[i]);
      return !boxClipped(this.sectionRows, corners);
    };
    const hits: { rid: Rid; instance: number }[] = [];
    const world = new THREE.Matrix4();
    const instance = new THREE.Matrix4();
    for (const item of this.sync.items.values()) {
      const object = item.object;
      if (!object || item.kind === 'light' || item.kind === 'camera') continue;
      let shown = true;
      for (let o: THREE.Object3D | null = object; o; o = o.parent) shown &&= o.visible;
      if (!shown) continue;
      if (item.kind === 'mesh' && item.geometry?.boundingBox) {
        if (!item.instances) {
          if (inRect(item.geometry.boundingBox, object.matrixWorld)) hits.push({ rid: item.rid, instance: -1 });
          continue;
        }
        for (let i = 0; i * 16 < item.instances.length && hits.length < 5000; i++) {
          world.multiplyMatrices(this.sync.root.matrixWorld, instance.fromArray(item.instances, i * 16)); // instances are in stage space
          if (inRect(item.geometry.boundingBox, world)) hits.push({ rid: item.rid, instance: i });
        }
      } else {
        // Curves and points: their world bounds as a whole.
        const box = new THREE.Box3().setFromObject(object);
        if (!box.isEmpty() && inRect(box, world.identity())) hits.push({ rid: item.rid, instance: -1 });
      }
    }
    return hits;
  }

  async screenshot(type = 'image/png', quality?: number): Promise<Blob> {
    await this.nextFrame();
    // Read back in the same task as a render, before the drawing buffer is cleared; without the helpers.
    this.camera.layers.disable(HELPERS);
    try {
      this.renderer.render(this.scene, this.camera);
    } finally {
      this.camera.layers.enable(HELPERS);
    }
    if (this.sectionTool) this.invalidate(); // back on screen
    return new Promise((resolve, reject) =>
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('screenshot failed'))), type, quality),
    );
  }

  dispose(): void {
    WARM_UPS.delete(this.warm);
    this.sectionTool?.dispose();
    this.sectionTool = null;
    this.tool = null;
    cancelAnimationFrame(this.frameRequest);
    this.resizer.disconnect();
    this.controls.dispose();
    this.sync.clear();
    this.renderer.dispose();
  }

  private resize(): void {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.freeCamera.aspect = width / height;
    this.freeCamera.updateProjectionMatrix();
    this.orthoCamera.left = this.orthoCamera.bottom * (width / height);
    this.orthoCamera.right = this.orthoCamera.top * (width / height);
    this.orthoCamera.updateProjectionMatrix();
    this.invalidate();
  }

  /** Walking every object is linear in the stage, so only redo it when the stage changed. */
  private refreshBounds(): void {
    if (this.stageVersion === this.sync.version) return;
    this.stageVersion = this.sync.version;
    this.bounds().getBoundingSphere(this.stageSphere);
    if (this.stageSphere.radius > 0) this.sync.fitShadow(this.stageSphere);
  }

  private fitClipPlanes(): void {
    if (!this.autoClip) return;
    // ponytail: the overlay is measured every frame (a few objects); version it like the stage if hosts add thousands.
    const box = new THREE.Box3();
    for (const o of this.overlay.children) if (o.visible) box.expandByObject(o);
    const sphere = box.getBoundingSphere(new THREE.Sphere()).union(this.stageSphere);
    if (!(sphere.radius > 0)) return;
    const view = this.view;
    const distance = view.position.distanceTo(sphere.center);
    // Orthographic depth has no precision falloff, so its near plane may sit behind the camera.
    view.near = view === this.orthoCamera ? distance - sphere.radius * 2 : Math.max((distance - sphere.radius) * 0.5, sphere.radius * 1e-3);
    view.far = distance + sphere.radius * 2;
    view.updateProjectionMatrix();
  }

  private followStageCamera(): void {
    const source = this.sync.cameras().find((c) => c.path === this.cameraPath);
    if (!source) return;
    const { params, matrix } = source;
    const aspect = this.canvas.clientWidth / Math.max(this.canvas.clientHeight, 1);
    const [near, far] = params.clippingRange;
    let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
    if (params.projection === 'orthographic') {
      const halfHeight = params.verticalAperture / 2;
      camera = new THREE.OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, near, far);
    } else {
      // ponytail: aperture offsets are ignored; override the projection matrix if a shot needs them.
      camera = new THREE.PerspectiveCamera(verticalFov(params.verticalAperture, params.focalLength), aspect, near, far);
    }
    const world = new THREE.Matrix4().multiplyMatrices(this.sync.root.matrixWorld, matrix);
    world.decompose(camera.position, camera.quaternion, new THREE.Vector3());
    camera.updateMatrixWorld();
    camera.layers.enable(HELPERS);
    this.camera = camera;
  }
}
