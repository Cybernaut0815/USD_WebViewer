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
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.freeCamera;
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
  /** Called before each frame is drawn, with the camera of that frame in place (gizmos, overlays). */
  readonly beforeRender = new Set<() => void>();

  constructor(canvas: HTMLCanvasElement, host: Omit<SceneHost, 'invalidate'>, forceWebGL: boolean) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGPURenderer({ canvas, antialias: true, forceWebGL });
    this.renderer.setClearColor(0x26282b);
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
        this.renderer.render(this.scene, this.camera);
      } finally {
        this.presented.splice(0).forEach((done) => done()); // waiters must not hang on a failed frame
      }
    });
  }

  /** Resolves after the next frame has been rendered. */
  nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      this.presented.push(resolve);
      this.invalidate();
    });
  }

  set exposure(ev: number) {
    this.renderer.toneMappingExposure = 2 ** ev;
    this.invalidate();
  }
  set toneMapping(mode: ToneMapping) {
    this.renderer.toneMapping = TONE_MAPPING[mode];
    this.invalidate();
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
    const distance = (radius / Math.sin((this.freeCamera.fov * Math.PI) / 360)) * 1.15;
    const direction = this.freeCamera.position.clone().sub(this.controls.target);
    if (direction.lengthSq() === 0) direction.set(1, 0.6, 1);
    this.controls.target.copy(sphere.center);
    this.freeCamera.position.copy(sphere.center).addScaledVector(direction.normalize(), distance);
    this.controls.update();
    this.invalidate();
  }

  /** Looks through a stage camera, or returns to the free camera with null. */
  lookThrough(path: Path | null): void {
    this.cameraPath = path;
    this.controls.enabled = path === null;
    if (path === null) this.camera = this.freeCamera;
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
    if (!(sphere.radius > 0)) return;
    const distance = this.freeCamera.position.distanceTo(sphere.center);
    this.freeCamera.near = Math.max((distance - sphere.radius) * 0.5, sphere.radius * 1e-3);
    this.freeCamera.far = distance + sphere.radius * 2;
    this.freeCamera.updateProjectionMatrix();
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
