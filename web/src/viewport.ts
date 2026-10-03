// The 3D view: renderer, cameras, navigation, picking and framing.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import type { Path, Rid } from './protocol.ts';
import { type SceneHost, SceneSync } from './scene.ts';
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
  private readonly resizer: ResizeObserver;
  private dirty = false;
  private frameRequest = 0;
  private presented: (() => void)[] = [];
  private stageSphere = new THREE.Sphere();
  private stageVersion = -1;
  private activeTool: Tool | null = null;
  private frameTimes: number[] = []; // when the frames of the last second were drawn
  /** CPU time of the last renderer.render call, in milliseconds. */
  frameMs = 0;
  /** Called before each frame is drawn, with the camera of that frame in place (gizmos, overlays). */
  readonly beforeRender = new Set<() => void>();
  /** Right click on a prim in the view (set by the element: its prim menu). */
  oncontext: (path: Path, x: number, y: number) => void = () => {};

  constructor(canvas: HTMLCanvasElement, host: Omit<SceneHost, 'invalidate'>, forceWebGL: boolean) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    this.renderer.setClearColor(DEFAULT_BACKGROUND);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.sync = new SceneSync(this.scene, {
      readBytes: (path) => host.readBytes(path),
      warn: (message) => host.warn(message),
      invalidate: () => this.invalidate(),
    });
    this.controls = new OrbitControls(this.freeCamera, canvas);
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => this.invalidate());
    this.freeCamera.position.set(3, 2, 4);
    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(canvas);
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

  /** Requests one render on the next animation frame. */
  invalidate(): void {
    this.dirty = true;
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      if (!this.dirty || !this.backend) return;
      this.dirty = false;
      this.refreshBounds();
      if (this.cameraPath) this.followStageCamera();
      else this.fitClipPlanes();
      for (const hook of this.beforeRender) hook();
      try {
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

  get background(): string {
    return `#${this.renderer.getClearColor(new THREE.Color()).getHexString()}`;
  }
  set background(color: string) {
    this.renderer.setClearColor(/^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_BACKGROUND);
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
    const distance = (radius / Math.sin((this.freeCamera.fov * Math.PI) / 360)) * 1.15;
    const direction = view.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(1, 0.6, 1);
    this.controls.target.copy(sphere.center);
    view.position.copy(sphere.center).addScaledVector(direction.normalize(), distance);
    if (view === this.orthoCamera) {
      view.zoom = view.top / (radius * 1.15);
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

  /** First render item under a client-space point. */
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
      if (visible && rid) return { rid, instance: hit.instanceId ?? -1 };
    }
    return null;
  }

  /**
   * Render items (and instances) in a client-space rectangle: those whose screen bounds lie fully
   * inside it, or with `touching` those whose screen bounds overlap it.
   * ponytail: bounding boxes, not silhouettes, so touching over-selects near corners; test vertices if that bites.
   */
  boxPick(r: { left: number; top: number; right: number; bottom: number }, contained: boolean): { rid: Rid; instance: number }[] {
    const canvas = this.canvas.getBoundingClientRect();
    this.sync.root.updateMatrixWorld(true);
    this.camera.updateMatrixWorld();
    const corner = new THREE.Vector3();
    const inRect = (box: THREE.Box3, world: THREE.Matrix4): boolean => {
      let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
      for (let i = 0; i < 8; i++) {
        corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
        corner.applyMatrix4(world).project(this.camera);
        if (corner.z > 1) return false; // behind the camera
        const x = canvas.left + ((corner.x + 1) / 2) * canvas.width;
        const y = canvas.top + ((1 - corner.y) / 2) * canvas.height;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      return contained
        ? left >= r.left && right <= r.right && top >= r.top && bottom <= r.bottom
        : left <= r.right && right >= r.left && top <= r.bottom && bottom >= r.top;
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
          world.multiplyMatrices(object.matrixWorld, instance.fromArray(item.instances, i * 16));
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
    // Read back in the same task as a render, before the drawing buffer is cleared.
    this.renderer.render(this.scene, this.camera);
    return new Promise((resolve, reject) =>
      this.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('screenshot failed'))), type, quality),
    );
  }

  dispose(): void {
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
    const sphere = this.stageSphere;
    if (!this.autoClip || !(sphere.radius > 0)) return;
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
    this.camera = camera;
  }
}
