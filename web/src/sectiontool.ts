// The section gizmo: edits one clipping plane or box of the view's section with TransformControls, never the stage.
// Its outline, handle dots and controls are drawn on HELPERS, a layer that screenshot() and host cameras leave out.
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { released } from './scene.ts';
import { clean, equal, type Section, type SectionBox, type SectionPlane, separates, type Vec3 } from './section.ts';
import type { Viewport } from './viewport.ts';

/**
 * The entry the gizmo edits (an index into the section's planes or boxes); rotate turns it instead of moving it. A box's
 * handles are the chosen ones (0-3 the footprint corners, 4 the bottom, 5 the top); without them every one is chosen.
 */
export type SectionGizmo = { plane: number; rotate?: boolean } | { box: number; rotate?: boolean; handles?: number[] };

/** The layer of the viewer's helpers: the view's cameras draw it, screenshot() and new cameras (layer 0 only) do not. */
export const HELPERS = 31;

/** The entry a gizmo target names, if the section has it. */
export function entry(section: Section, target: SectionGizmo): SectionPlane | SectionBox | undefined {
  return 'plane' in target ? section.planes[target.plane] : section.boxes[target.box];
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
/** Pixels around a dot's centre that count as on it. */
const REACH = 8;
const CHOSEN = new THREE.Color(0xffc400);
const HANDLE = new THREE.Color(0xffffff);
/** Outlines over everything, never cut by the section themselves (not registered with section()). */
const outline = (opacity: number) => new THREE.LineBasicNodeMaterial({ color: 0x4cc2ff, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false });
const LINE = outline(0.9);
const FAINT = outline(0.35);
/** Dots 0-3 and 4-7 are the bottom and top of corners 0-3 (one vertical edge each), 8 and 9 the bottom and top faces: handles 0-3, 4, 5. */
const handleOf = (dot: number) => (dot < 8 ? dot % 4 : dot - 4);

function segments(material: THREE.Material, count: number): THREE.LineSegments {
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3)), material);
  lines.frustumCulled = false; // its points move every frame
  lines.renderOrder = 1; // after the stage's transparent objects
  return lines;
}

function write(attribute: THREE.BufferAttribute, points: Vec3[]): void {
  points.forEach((p, i) => attribute.setXYZ(i, ...p));
  attribute.needsUpdate = true;
}

/**
 * Edits one section entry. A plane moves along its normal, or with rotate tilts about the middle of its outline (where
 * the stage's centre falls on it, so the gizmo is in view wherever the plane's own point lies). A box shows a dot at
 * the top and bottom of each corner (the pair is one vertical edge: one footprint corner) and one on each face; a click
 * chooses a handle, Shift or Ctrl+click adds or removes one. The translate gizmo in the middle of the chosen handles
 * moves corners in plan only and faces up and down only; every handle starts chosen (unless the viewport passes the
 * ones a host gave), so at first it moves the whole box. A change of the choice fires Viewport.onsectiongizmo. With
 * rotate the footprint turns about the up axis through its middle. Each drag step is applied from the drag's start
 * through Viewport.setSection (source 'gizmo'); a step the box could not be drawn after is refused.
 */
export class SectionTool {
  readonly target: SectionGizmo;
  private readonly viewport: Viewport;
  private readonly controls: TransformControls;
  /** What TransformControls drags: under root, so its position and rotation are in stage space. */
  private readonly proxy = new THREE.Object3D();
  /** Outline and dots in stage space, following root's matrix (under root they would be the stage: picked, framed). */
  private readonly helpers = new THREE.Object3D();
  private readonly lines: THREE.LineSegments;
  private readonly faint: THREE.LineSegments;
  private readonly dots: THREE.Sprite;
  private readonly dotPositions = new THREE.InstancedBufferAttribute(new Float32Array(30), 3);
  private readonly dotColors = new THREE.InstancedBufferAttribute(new Float32Array(30), 3);
  /** Chosen box handles: 0-3 the footprint corners, 4 the bottom, 5 the top. */
  private chosen = new Set([0, 1, 2, 3, 4, 5]);
  /** The handle whose dot is under the pointer (-1: none), kept like TransformControls' hovered axis. */
  private hovered = -1;
  private press: { x: number; y: number; handle: number; toggle: boolean } | null = null;
  private start: { position: THREE.Vector3; quaternion: THREE.Quaternion; entry: SectionPlane | SectionBox } | null = null;
  private readonly abort = new AbortController();
  private readonly follow = () => this.update();

  /** handles: the box handles chosen at first (every one without). */
  constructor(viewport: Viewport, target: SectionGizmo, handles?: number[]) {
    this.viewport = viewport;
    this.target = target;
    if (handles) this.chosen = new Set(handles);
    const plane = 'plane' in target;
    this.lines = segments(LINE, plane ? 9 : 12);
    this.faint = segments(FAINT, 2);
    // WebGPU draws point primitives 1 px wide: sized dots are instanced sprites.
    this.dots = new THREE.Sprite(
      new THREE.PointsNodeMaterial({
        positionNode: instancedBufferAttribute(this.dotPositions),
        colorNode: instancedBufferAttribute(this.dotColors, 'vec3'),
        size: 9,
        sizeAttenuation: false,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    this.dots.count = 10;
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 2;
    this.faint.visible = !plane;
    this.dots.visible = !plane && !target.rotate;
    this.helpers.matrixAutoUpdate = false;
    this.helpers.add(this.lines, this.faint, this.dots);

    // TransformControls' wiring as in TransformTool, writing the section instead of the stage.
    const controls = (this.controls = new TransformControls(viewport.camera, viewport.canvas));
    controls.setMode(target.rotate ? 'rotate' : 'translate');
    controls.setSpace(plane ? 'local' : 'world'); // the proxy's local Y is a plane's normal; world Y is the stage's up
    if (plane) {
      controls.showX = controls.showZ = !!target.rotate; // tilting the normal
      controls.showY = !target.rotate; // along the normal
    } else if (target.rotate) controls.showX = controls.showZ = false; // the ring about the up axis
    for (const object of [controls.getHelper(), this.helpers]) {
      object.traverse((o) => o.layers.set(HELPERS));
      viewport.scene.add(object);
    }
    controls.getRaycaster().layers.enable(HELPERS);
    viewport.sync.root.add(this.proxy);
    viewport.beforeRender.add(this.follow);
    controls.addEventListener('dragging-changed', (e) => {
      viewport.controls.enabled = !e.value && viewport.cameraPath === null;
      viewport.invalidate();
    });
    controls.addEventListener('axis-changed', () => {
      controls.getHelper().updateMatrixWorld();
      viewport.invalidate();
    });
    controls.addEventListener('mouseDown', () => {
      this.start = { position: this.proxy.position.clone(), quaternion: this.proxy.quaternion.clone(), entry: entry(viewport.section, target)! };
    });
    controls.addEventListener('objectChange', () => this.moved());
    controls.addEventListener('mouseUp', () => (this.start = null));

    const { canvas } = viewport;
    const { signal } = this.abort;
    canvas.addEventListener('pointermove', (e) => (this.hovered = this.dotAt(e.clientX, e.clientY)), { signal });
    // Capturing on the parent: before the canvas's own listeners (the selection tool, the orbit, the gizmo).
    canvas.parentElement!.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target !== canvas) return;
        this.hovered = this.dotAt(e.clientX, e.clientY);
        if (e.button !== 0 || this.hovered < 0 || controls.axis !== null) return; // the gizmo's axes come first
        this.press = { x: e.clientX, y: e.clientY, handle: this.hovered, toggle: e.shiftKey || e.ctrlKey || e.metaKey };
        viewport.controls.enabled = false; // a press on a dot does not orbit
        canvas.setPointerCapture(e.pointerId);
      },
      { signal, capture: true },
    );
    const release = (e: PointerEvent) => {
      const press = this.press;
      if (!press) return;
      this.press = null;
      viewport.controls.enabled = viewport.cameraPath === null;
      if (e.type === 'pointerup' && Math.hypot(e.clientX - press.x, e.clientY - press.y) <= 4) this.choose(press.handle, press.toggle);
    };
    canvas.addEventListener('pointerup', release, { signal });
    canvas.addEventListener('pointercancel', release, { signal });
    // Placed now, not in the next frame (the first section's warm-up holds frames back): until then the dots would sit
    // at the stage origin and the attached axes, unplaced, at the world origin, and both take the pointer there.
    this.update();
    controls.getHelper().updateMatrixWorld();
    viewport.invalidate();
  }

  /** True while a dot or gizmo axis is under the pointer or held: the tools leave the pointer to the gizmo. */
  grabbed(): boolean {
    return this.controls.dragging || this.controls.axis !== null || this.hovered >= 0 || this.press !== null;
  }

  /** True over a dot or gizmo axis at a client point, or while one is held. */
  at(clientX: number, clientY: number): boolean {
    if (this.controls.dragging || this.press) return true;
    const rect = this.viewport.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.controls.getRaycaster().setFromCamera(ndc, this.viewport.camera);
    this.controls.pointerHover(null); // the axis TransformControls itself takes there
    return this.controls.axis !== null || this.dotAt(clientX, clientY) >= 0;
  }

  /** The target, with a box's chosen handles (sorted) unless it rotates. */
  get value(): SectionGizmo {
    return this.dots.visible ? { ...this.target, handles: [...this.chosen].sort((a, b) => a - b) } : { ...this.target };
  }

  /** Esc: drops the chosen box handles; false when there were none (planes and rotate have none). */
  clear(): boolean {
    if (!this.dots.visible || !this.chosen.size) return false;
    this.chosen.clear();
    this.viewport.invalidate();
    this.viewport.onsectiongizmo();
    return true;
  }

  dispose(): void {
    const { viewport, controls } = this;
    this.abort.abort();
    viewport.beforeRender.delete(this.follow);
    controls.detach();
    controls.dispose();
    controls.getHelper().removeFromParent();
    this.proxy.removeFromParent();
    this.helpers.removeFromParent();
    this.lines.geometry.dispose();
    this.faint.geometry.dispose();
    for (const lines of [this.lines, this.faint]) released(lines); // their materials (LINE, FAINT) are shared
    this.dots.material.dispose(); // not its geometry: every sprite shares that quad
    viewport.controls.enabled = viewport.cameraPath === null;
    viewport.invalidate();
  }

  /** Before each frame: follows the camera and stage space, draws the entry as it is, and puts the gizmo on it. */
  private update(): void {
    const { viewport, controls, proxy } = this;
    controls.camera = viewport.camera; // stage cameras are new objects every frame
    const root = viewport.sync.root;
    this.helpers.matrix.copy(root.matrixWorld);
    this.helpers.matrixWorldNeedsUpdate = true;
    const e = entry(viewport.section, this.target);
    if (!e) return; // setSection detaches the gizmo along with its entry
    const H = viewport.sync.upAxis === 'Z' ? 2 : 1;
    /** A footprint corner at a height. */
    const at = (c: Vec3, h: number): Vec3 => {
      const p: Vec3 = [c[0], c[1], c[2]];
      p[H] = h;
      return p;
    };
    if ('normal' in e) {
      // A square on the plane as wide as the stage, around the stage's centre, with the gizmo in its middle; the arrow
      // points to the side kept.
      const n = new THREE.Vector3(...e.normal).normalize();
      const point = new THREE.Vector3(...e.point);
      const r = viewport.stageSphere.radius;
      const centre = viewport.stageSphere.center.clone().applyMatrix4(root.matrixWorld.clone().invert());
      const c = centre.addScaledVector(n, n.dot(point.clone().sub(centre)));
      const a = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? X : Y).setLength(r);
      const b = new THREE.Vector3().crossVectors(n, a);
      const corner = (s: number, t: number) => c.clone().addScaledVector(a, s).addScaledVector(b, t);
      const tip = c.clone().addScaledVector(n, r / 4);
      const barb = (v: THREE.Vector3, s: number) => tip.clone().addScaledVector(n, -r / 16).addScaledVector(v, s / 32);
      const square = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      const points = [...square.flatMap((p, i) => [p, square[(i + 1) % 4]]), c, tip, ...[barb(a, 1), barb(a, -1), barb(b, 1), barb(b, -1)].flatMap((p) => [tip, p])];
      write(this.lines.geometry.attributes.position as THREE.BufferAttribute, points.map((p) => p.toArray()));
      if (!controls.dragging) {
        proxy.position.copy(c);
        // Only when the normal changed: the twist a rotate drag left stays.
        if (Y.clone().applyQuaternion(proxy.quaternion).dot(n) < 1 - 1e-9) proxy.quaternion.setFromUnitVectors(Y, n);
        controls.attach(proxy);
      }
      return;
    }
    const { corners, bottom, top } = e;
    const mid = (bottom + top) / 2;
    const lo = corners.map((c) => at(c, bottom));
    const hi = corners.map((c) => at(c, top));
    const mean = [0, 1, 2].map((i) => (corners[0][i] + corners[1][i] + corners[2][i] + corners[3][i]) / 4) as Vec3;
    write(this.lines.geometry.attributes.position as THREE.BufferAttribute, [0, 1, 2, 3].flatMap((k) => [lo[k], lo[(k + 1) % 4], hi[k], hi[(k + 1) % 4], lo[k], hi[k]]));
    const d = separates(corners, 0, viewport.sync.upAxis) ? 0 : 1; // the inner diagonal: where the shader splits the footprint
    write(this.faint.geometry.attributes.position as THREE.BufferAttribute, [lo[d], lo[d + 2], hi[d], hi[d + 2]]);
    write(this.dotPositions, [...lo, ...hi, at(mean, bottom), at(mean, top)]);
    for (let i = 0; i < 10; i++) {
      const color = this.chosen.has(handleOf(i)) ? CHOSEN : HANDLE;
      this.dotColors.setXYZ(i, color.r, color.g, color.b);
    }
    this.dotColors.needsUpdate = true;
    if (controls.dragging) return;
    proxy.quaternion.identity();
    if (this.target.rotate) {
      proxy.position.fromArray(at(mean, mid));
      controls.attach(proxy);
      return;
    }
    const handles = [...this.chosen].map((h) => (h < 4 ? at(corners[h], mid) : at(mean, h === 4 ? bottom : top)));
    if (!handles.length) {
      controls.detach();
      return;
    }
    proxy.position.set(0, 0, 0);
    for (const h of handles) proxy.position.add(new THREE.Vector3(...h));
    proxy.position.divideScalar(handles.length);
    // Corners move in plan, faces up and down: only those axes show.
    controls.showX = controls.showZ = [...this.chosen].some((h) => h < 4);
    controls.showY = this.chosen.has(4) || this.chosen.has(5);
    controls.attach(proxy);
  }

  /** A drag step, applied from the drag's start; refused when the box could not be drawn after it. */
  private moved(): void {
    const { start, proxy, viewport, target } = this;
    if (!start) return;
    const section = viewport.section;
    const up = viewport.sync.upAxis;
    if ('plane' in target) {
      // The proxy stays on the plane, at the outline's middle: the point of the moved plane, the centre of a tilted one.
      const { normal } = start.entry as SectionPlane;
      section.planes[target.plane] = { point: proxy.position.toArray(), normal: target.rotate ? Y.clone().applyQuaternion(proxy.quaternion).toArray() : normal };
    } else {
      const box = structuredClone(start.entry) as SectionBox;
      if (target.rotate) {
        const turn = proxy.quaternion.clone().multiply(start.quaternion.clone().invert()); // about the up axis through the middle
        box.corners = box.corners.map((c) => new THREE.Vector3(...c).sub(start.position).applyQuaternion(turn).add(start.position).toArray()) as SectionBox['corners'];
      } else {
        const H = up === 'Z' ? 2 : 1;
        const shift = proxy.position.clone().sub(start.position).toArray();
        const rise = shift[H];
        shift[H] = 0;
        box.corners = box.corners.map((c, k) => (this.chosen.has(k) ? c.map((x, i) => x + shift[i]) : c)) as SectionBox['corners'];
        if (this.chosen.has(4)) box.bottom += rise;
        if (this.chosen.has(5)) box.top += rise;
      }
      section.boxes[target.box] = box;
    }
    // A footprint that crosses itself or turns over, or a top below the bottom, would not come back from clean() as it
    // went in: the last valid step stays.
    if (equal(clean(section, up), section)) viewport.setSection(section, 'gizmo');
    viewport.invalidate(); // the gizmo moved either way
  }

  /** A click on a dot: chooses its handle alone, or with toggle adds or removes it. */
  private choose(handle: number, toggle: boolean): void {
    const before = [...this.chosen].join();
    if (!toggle) this.chosen = new Set([handle]);
    else if (!this.chosen.delete(handle)) this.chosen.add(handle);
    this.viewport.invalidate();
    if ([...this.chosen].join() !== before) this.viewport.onsectiongizmo();
  }

  /** The box handle whose dot is under a client point (-1: none), from the dots as last drawn. */
  private dotAt(clientX: number, clientY: number): number {
    if (!this.dots.visible) return -1;
    const { canvas, camera, sync } = this.viewport;
    const rect = canvas.getBoundingClientRect();
    const p = new THREE.Vector3();
    let handle = -1;
    let nearest = REACH;
    for (let i = 0; i < 10; i++) {
      p.fromBufferAttribute(this.dotPositions, i).applyMatrix4(sync.root.matrixWorld).project(camera);
      const distance = Math.hypot(rect.left + ((p.x + 1) / 2) * rect.width - clientX, rect.top + ((1 - p.y) / 2) * rect.height - clientY);
      if (p.z <= 1 && distance < nearest) [handle, nearest] = [handleOf(i), distance]; // z > 1: behind the camera
    }
    return handle;
  }
}
