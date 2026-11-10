// The section editor: outlines and dots on the view's clipping planes and boxes, a click selects them, and
// TransformControls moves the selection, never the stage. Its outlines, dots and controls are drawn on HELPERS, a layer
// that screenshot() and host cameras leave out.
import * as THREE from 'three/webgpu';
import { instancedBufferAttribute } from 'three/tsl';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { released } from './scene.ts';
import { clean, equal, MAX, type Section, type SectionBox, separates, type Vec3 } from './section.ts';
import { NavigateTool } from './tools.ts';
import type { Viewport } from './viewport.ts';

/**
 * The selected section entries, indices into the section's planes and boxes. One entry: a plane, or a box with its
 * chosen handles (0-3 the footprint corners, 4 the bottom, 5 the top; without them every one is chosen); rotate turns
 * it instead of moving it. Several entries: the planes, and the boxes with their chosen handles, moved together.
 */
export type SectionGizmo =
  | { plane: number; rotate?: boolean }
  | { box: number; rotate?: boolean; handles?: number[] }
  | { planes: number[]; boxes: { box: number; handles?: number[] }[] };

/** The layer of the viewer's helpers: the view's cameras draw it, screenshot() and new cameras (layer 0 only) do not. */
export const HELPERS = 31;

/** What the pointer is on: a plane (its dot or outline), a box's dot (handle) or a box's outline (no handle). */
interface Hit {
  box: boolean;
  index: number;
  dot: boolean;
  handle?: number;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const ALL = [0, 1, 2, 3, 4, 5];
/** Pixels around a dot's centre, or an outline, that count as on it. */
const REACH = 8;
const CHOSEN = new THREE.Color(0xffc400);
const HANDLE = new THREE.Color(0xffffff);
/** Outlines over everything, never cut by the section themselves (not registered with section()). */
const outline = (opacity: number) => new THREE.LineBasicNodeMaterial({ color: 0x4cc2ff, transparent: true, opacity, depthTest: false, depthWrite: false, toneMapped: false });
const LINE = outline(0.9);
const DIM = outline(0.5);
const FAINT = outline(0.35);
/** Dots 0-3 and 4-7 are the bottom and top of corners 0-3 (one vertical edge each), 8 and 9 the bottom and top faces: handles 0-3, 4, 5. */
const handleOf = (dot: number) => (dot < 8 ? dot % 4 : dot - 4);
const sorted = (values: Iterable<number>) => [...values].sort((a, b) => a - b);

/** Segments for up to count lines: a plane's outline is 9, a box's 12. */
function segments(material: THREE.Material, count: number): THREE.LineSegments {
  const lines = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 6), 3)), material);
  lines.frustumCulled = false; // its points move every frame
  lines.renderOrder = 1; // after the stage's transparent objects
  return lines;
}

function write(lines: THREE.LineSegments, points: Vec3[]): void {
  const attribute = lines.geometry.attributes.position as THREE.BufferAttribute;
  points.forEach((p, i) => attribute.setXYZ(i, ...p));
  attribute.needsUpdate = true;
  lines.geometry.setDrawRange(0, points.length);
  lines.visible = points.length > 0;
}

/**
 * Shows every entry of the section (with Viewport.sectionHandles and the section on; otherwise only the selected ones):
 * a plane as a square as wide as the stage around where the stage's centre falls on it, with a dot there and an arrow
 * to the side kept; a box with a dot at the top and bottom of each corner (the pair is one vertical edge: one footprint
 * corner) and one on each face. A click on a dot chooses that handle (a plane's dot: the plane), on an outline the whole
 * entry; Shift or Ctrl+click adds or removes it; a click on nothing else lets go of all (not in the navigate tool). The
 * translate gizmo in the middle of the chosen handles moves them together: corners in plan only, faces up and down
 * only, planes by its shift along their normals; a plane alone only along its normal. With rotate (one entry) a plane
 * tilts about its dot and a box's footprint turns about the up axis through its middle. A change of the selection fires
 * Viewport.onsectiongizmo. Each drag step is applied from the drag's start through Viewport.setSection (source
 * 'gizmo'); a step the section could not be drawn after is refused.
 */
export class SectionTool {
  private readonly viewport: Viewport;
  private readonly controls: TransformControls;
  /** What TransformControls drags: under root, so its position and rotation are in stage space. */
  private readonly proxy = new THREE.Object3D();
  /** Outlines and dots in stage space, following root's matrix (under root they would be the stage: picked, framed). */
  private readonly helpers = new THREE.Object3D();
  /** The selected entries' outlines, the others', and the selected boxes' inner diagonals. */
  private readonly lines = segments(LINE, MAX * 21);
  private readonly dim = segments(DIM, MAX * 21);
  private readonly faint = segments(FAINT, MAX * 2);
  private readonly dots: THREE.Sprite;
  private readonly dotPositions = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 11 * 3), 3);
  private readonly dotColors = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 11 * 3), 3);
  private planes = new Set<number>();
  /** Selected boxes and their chosen handles: 0-3 the footprint corners, 4 the bottom, 5 the top. */
  private boxes = new Map<number, Set<number>>();
  private rotate = false;
  /** The dots and outline segments as last drawn, in stage space, for the pointer. */
  private dotHits: { p: Vec3; hit: Hit }[] = [];
  private edgeHits: { a: Vec3; b: Vec3; hit: Hit }[] = [];
  /** Each drawn plane's dot (the middle of its outline) and each drawn box's handles, in stage space. */
  private planeAt = new Map<number, THREE.Vector3>();
  private boxAt = new Map<number, Vec3[]>();
  /** The dot or outline under the pointer, kept like TransformControls' hovered axis. */
  private hovered: Hit | null = null;
  private press: { x: number; y: number; hit: Hit | null; toggle: boolean } | null = null;
  private start: { position: THREE.Vector3; quaternion: THREE.Quaternion; section: Section; planeAt: Map<number, THREE.Vector3> } | null = null;
  private readonly abort = new AbortController();
  private readonly follow = () => this.update();

  constructor(viewport: Viewport) {
    this.viewport = viewport;
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
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 2;
    this.helpers.matrixAutoUpdate = false;
    this.helpers.add(this.lines, this.dim, this.faint, this.dots);

    // TransformControls' wiring as in TransformTool, writing the section instead of the stage.
    const controls = (this.controls = new TransformControls(viewport.camera, viewport.canvas));
    for (const object of [controls.getHelper(), this.helpers]) {
      object.traverse((o) => o.layers.set(HELPERS));
      viewport.scene.add(object);
    }
    controls.getRaycaster().layers.enable(HELPERS);
    viewport.sync.root.add(this.proxy);
    viewport.beforeRender.add(this.follow);
    controls.addEventListener('dragging-changed', (e) => {
      viewport.controls.enabled = !e.value && viewport.cameraPath === null;
      // At a drag's end (dragging is false by now) back on the selection, which the drag can have left: a refused last
      // step, corners chosen with a face (their mean moves less than the gizmo), a tilt (the outline's middle moves).
      if (!e.value) this.place();
      viewport.invalidate();
    });
    controls.addEventListener('axis-changed', () => {
      controls.getHelper().updateMatrixWorld();
      viewport.invalidate();
    });
    controls.addEventListener('mouseDown', () => {
      this.start = { position: this.proxy.position.clone(), quaternion: this.proxy.quaternion.clone(), section: viewport.section, planeAt: new Map([...this.planeAt].map(([i, p]) => [i, p.clone()])) };
    });
    controls.addEventListener('objectChange', () => this.moved());
    controls.addEventListener('mouseUp', () => (this.start = null));

    const { canvas } = viewport;
    const { signal } = this.abort;
    canvas.addEventListener('pointermove', (e) => (this.hovered = this.hitAt(e.clientX, e.clientY)), { signal });
    // Capturing on the parent: before the canvas's own listeners (the selection tool, the orbit, the gizmo).
    canvas.parentElement!.addEventListener(
      'pointerdown',
      (e) => {
        if (e.target !== canvas) return;
        this.press = null;
        this.hovered = this.hitAt(e.clientX, e.clientY);
        if (e.button !== 0 || controls.axis !== null || !this.picks()) return; // the gizmo's axes come first
        this.press = { x: e.clientX, y: e.clientY, hit: this.hovered, toggle: e.shiftKey || e.ctrlKey || e.metaKey };
        if (!this.hovered?.dot) return; // a drag from an outline or from nothing orbits
        viewport.controls.enabled = false; // a press on a dot does not
        canvas.setPointerCapture(e.pointerId);
      },
      { signal, capture: true },
    );
    const release = (e: PointerEvent) => {
      const press = this.press;
      if (!press) return;
      this.press = null;
      if (press.hit?.dot) viewport.controls.enabled = viewport.cameraPath === null;
      if (e.type !== 'pointerup' || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 4) return;
      if (press.hit) this.choose(press.hit, press.toggle);
      else if (!press.toggle) this.select(null, true);
    };
    canvas.addEventListener('pointerup', release, { signal });
    canvas.addEventListener('pointercancel', release, { signal });
    this.place();
  }

  /** True while a dot, outline or gizmo axis is under the pointer or a dot is held: the tools leave the pointer alone. */
  grabbed(): boolean {
    return this.controls.dragging || this.controls.axis !== null || this.hovered !== null || !!this.press?.hit?.dot;
  }

  /** True over a dot, outline or gizmo axis at a client point, or while one is held. */
  at(clientX: number, clientY: number): boolean {
    if (this.controls.dragging || this.press?.hit?.dot) return true;
    const rect = this.viewport.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.controls.getRaycaster().setFromCamera(ndc, this.viewport.camera);
    this.controls.pointerHover(null); // the axis TransformControls itself takes there
    return this.controls.axis !== null || this.hitAt(clientX, clientY) !== null;
  }

  /** The selection (see SectionGizmo): null with nothing selected, a box's handles sorted and left out with rotate. */
  get value(): SectionGizmo | null {
    const planes = sorted(this.planes);
    const boxes = sorted(this.boxes.keys());
    if (planes.length + boxes.length > 1) return { planes, boxes: boxes.map((box) => ({ box, handles: sorted(this.boxes.get(box)!) })) };
    if (planes.length) return { plane: planes[0], rotate: this.rotate };
    if (!boxes.length) return null;
    return this.rotate ? { box: boxes[0], rotate: true } : { box: boxes[0], rotate: false, handles: sorted(this.boxes.get(boxes[0])!) };
  }

  /** The selected planes and boxes, by index. */
  get selected(): { planes: number[]; boxes: number[] } {
    return { planes: sorted(this.planes), boxes: sorted(this.boxes.keys()) };
  }

  /**
   * Selects afresh: a box with the handles given (integers 0-5; anything else is ignored) or every one; entries the
   * section lacks are left out, as is rotate with several entries. With notify, fires onsectiongizmo when it changed.
   */
  select(target: SectionGizmo | null, notify = false): void {
    const before = JSON.stringify(this.value);
    const section = this.viewport.section;
    const t = (target ?? {}) as { plane?: unknown; box?: unknown; rotate?: unknown; handles?: unknown; planes?: unknown; boxes?: unknown };
    const index = (i: unknown, count: number): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count;
    const chosen = (handles: unknown) => new Set(Array.isArray(handles) ? handles.filter((h) => Number.isInteger(h) && h >= 0 && h <= 5) : ALL);
    this.planes = new Set();
    this.boxes = new Map();
    this.rotate = false;
    if (index(t.plane, section.planes.length)) this.planes.add(t.plane);
    else if (index(t.box, section.boxes.length)) this.boxes.set(t.box, chosen(t.handles));
    else {
      for (const i of Array.isArray(t.planes) ? t.planes : []) if (index(i, section.planes.length)) this.planes.add(i);
      for (const b of Array.isArray(t.boxes) ? t.boxes : []) if (index(b?.box, section.boxes.length)) this.boxes.set(b.box, chosen(b.handles));
    }
    this.rotate = t.rotate === true && this.planes.size + this.boxes.size === 1 && ('plane' in t || 'box' in t);
    this.start = null; // a drag under way stops moving what was selected
    this.changed(before, notify);
  }

  /** After a change of the section: lets go of the entries it lost and follows it at once. Fires onsectiongizmo. */
  sectionChanged(): void {
    const before = JSON.stringify(this.value);
    const { planes, boxes } = this.viewport.section;
    const count = this.planes.size + this.boxes.size;
    for (const i of this.planes) if (i >= planes.length) this.planes.delete(i);
    for (const i of this.boxes.keys()) if (i >= boxes.length) this.boxes.delete(i);
    if (this.planes.size + this.boxes.size !== count) this.start = null; // a drag under way lost what it moved
    if (this.planes.size + this.boxes.size !== 1) this.rotate = false;
    this.changed(before, true);
  }

  /** Before planes and boxes (indices) are removed: the selection stays on the entries left, at their new indices. */
  removing(planes: number[], boxes: number[]): void {
    const shift = (i: number, gone: number[]) => i - gone.filter((g) => g < i).length;
    this.planes = new Set([...this.planes].filter((i) => !planes.includes(i)).map((i) => shift(i, planes)));
    this.boxes = new Map([...this.boxes].filter(([i]) => !boxes.includes(i)).map(([i, chosen]) => [shift(i, boxes), chosen]));
    if (this.planes.size + this.boxes.size !== 1) this.rotate = false;
    this.start = null; // the indices a drag under way holds are stale
  }

  /** Esc: drops the chosen box handles; false when there were none (planes and rotate have none). */
  clear(): boolean {
    if (this.rotate || ![...this.boxes.values()].some((chosen) => chosen.size)) return false;
    const before = JSON.stringify(this.value);
    for (const chosen of this.boxes.values()) chosen.clear();
    this.changed(before, true);
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
    for (const lines of [this.lines, this.dim, this.faint]) {
      lines.geometry.dispose();
      released(lines); // their materials are shared
    }
    this.dots.material.dispose(); // not its geometry: every sprite shares that quad
    viewport.controls.enabled = viewport.cameraPath === null;
    viewport.invalidate();
  }

  /**
   * Puts the outlines, dots and gizmo on the section and the selection as they are now. Called whenever they change and
   * when a drag ends, not left to the next frame: the first section's warm-up holds frames back while the pointer still
   * works, and until a frame the dots and the attached axes would stay where they were and take the pointer there.
   */
  place(): void {
    this.update();
    this.controls.getHelper().updateMatrixWorld();
    this.viewport.invalidate();
  }

  private changed(before: string, notify: boolean): void {
    this.place();
    if (notify && JSON.stringify(this.value) !== before) this.viewport.onsectiongizmo();
  }

  /** Clicks select, but not in the navigate tool: there a press looks around. */
  private picks(): boolean {
    return !(this.viewport.tool instanceof NavigateTool);
  }

  /** Before each frame: follows the camera and stage space, draws the entries as they are, and puts the gizmo on them. */
  private update(): void {
    const { viewport, controls, proxy } = this;
    controls.camera = viewport.camera; // stage cameras are new objects every frame
    const root = viewport.sync.root;
    this.helpers.matrix.copy(root.matrixWorld);
    this.helpers.matrixWorldNeedsUpdate = true;
    const section = viewport.section;
    const every = viewport.sectionHandles && section.on;
    const H = viewport.sync.upAxis === 'Z' ? 2 : 1;
    /** A footprint corner at a height. */
    const at = (c: Vec3, h: number): Vec3 => {
      const p: Vec3 = [c[0], c[1], c[2]];
      p[H] = h;
      return p;
    };
    const bright: Vec3[] = [];
    const dim: Vec3[] = [];
    const faint: Vec3[] = [];
    const dots: { p: Vec3; hit: Hit; chosen: boolean }[] = [];
    const edges: { a: Vec3; b: Vec3; hit: Hit }[] = [];
    const draw = (points: Vec3[], hit: Hit, selected: boolean) => {
      (selected ? bright : dim).push(...points);
      for (let i = 0; i < points.length; i += 2) edges.push({ a: points[i], b: points[i + 1], hit });
    };
    this.planeAt.clear();
    this.boxAt.clear();
    const r = viewport.stageSphere.radius;
    const centre = viewport.stageSphere.center.clone().applyMatrix4(root.matrixWorld.clone().invert());
    section.planes.forEach((e, index) => {
      const selected = this.planes.has(index);
      if (!every && !selected) return;
      // A square on the plane as wide as the stage, around the stage's centre, with the dot in its middle; the arrow
      // points to the side kept.
      const n = new THREE.Vector3(...e.normal).normalize();
      const c = centre.clone().addScaledVector(n, n.dot(new THREE.Vector3(...e.point).sub(centre)));
      const a = new THREE.Vector3().crossVectors(n, Math.abs(n.x) < 0.9 ? X : Y).setLength(r);
      const b = new THREE.Vector3().crossVectors(n, a);
      const corner = (s: number, t: number) => c.clone().addScaledVector(a, s).addScaledVector(b, t);
      const tip = c.clone().addScaledVector(n, r / 4);
      const barb = (v: THREE.Vector3, s: number) => tip.clone().addScaledVector(n, -r / 16).addScaledVector(v, s / 32);
      const square = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
      const points = [...square.flatMap((p, i) => [p, square[(i + 1) % 4]]), c, tip, ...[barb(a, 1), barb(a, -1), barb(b, 1), barb(b, -1)].flatMap((p) => [tip, p])];
      draw(points.map((p) => p.toArray()), { box: false, index, dot: false }, selected);
      dots.push({ p: c.toArray(), hit: { box: false, index, dot: true }, chosen: selected && !this.rotate });
      this.planeAt.set(index, c);
    });
    section.boxes.forEach((e, index) => {
      const chosen = this.boxes.get(index);
      if (!every && !chosen) return;
      const { corners, bottom, top } = e;
      const mid = (bottom + top) / 2;
      const lo = corners.map((c) => at(c, bottom));
      const hi = corners.map((c) => at(c, top));
      const mean = [0, 1, 2].map((i) => (corners[0][i] + corners[1][i] + corners[2][i] + corners[3][i]) / 4) as Vec3;
      draw([0, 1, 2, 3].flatMap((k) => [lo[k], lo[(k + 1) % 4], hi[k], hi[(k + 1) % 4], lo[k], hi[k]]), { box: true, index, dot: false }, !!chosen);
      if (chosen) {
        const d = separates(corners, 0, viewport.sync.upAxis) ? 0 : 1; // the inner diagonal: where the shader splits the footprint
        faint.push(lo[d], lo[d + 2], hi[d], hi[d + 2]);
      }
      [...lo, ...hi, at(mean, bottom), at(mean, top)].forEach((p, dot) => {
        const handle = handleOf(dot);
        dots.push({ p, hit: { box: true, index, dot: true, handle }, chosen: !!chosen?.has(handle) && !this.rotate });
      });
      this.boxAt.set(index, [...corners.map((c) => at(c, mid)), at(mean, bottom), at(mean, top), at(mean, mid)]);
    });
    write(this.lines, bright);
    write(this.dim, dim);
    write(this.faint, faint);
    dots.forEach(({ p, chosen }, i) => {
      const color = chosen ? CHOSEN : HANDLE;
      this.dotPositions.setXYZ(i, ...p);
      this.dotColors.setXYZ(i, color.r, color.g, color.b);
    });
    this.dotPositions.needsUpdate = this.dotColors.needsUpdate = true;
    this.dots.count = dots.length;
    this.dots.visible = dots.length > 0;
    this.dotHits = dots;
    this.edgeHits = edges;
    if (controls.dragging) return;

    /** A plane's normal as the proxy's local Y, only when it changed: the twist a rotate drag left stays. */
    const along = (plane: number) => {
      const n = new THREE.Vector3(...section.planes[plane].normal).normalize();
      if (Y.clone().applyQuaternion(proxy.quaternion).dot(n) < 1 - 1e-9) proxy.quaternion.setFromUnitVectors(Y, n);
    };
    const [plane] = this.planes;
    const [box] = this.boxes.keys();
    if (this.rotate) {
      // A plane tilts about its dot; a box's footprint turns about the up axis through its middle (the ring alone).
      controls.setMode('rotate');
      if (plane !== undefined) {
        proxy.position.copy(this.planeAt.get(plane)!);
        along(plane);
      } else {
        proxy.position.fromArray(this.boxAt.get(box)![6]);
        proxy.quaternion.identity();
      }
      controls.setSpace(plane !== undefined ? 'local' : 'world');
      controls.showX = controls.showZ = plane !== undefined;
      controls.showY = plane === undefined;
      controls.attach(proxy);
      return;
    }
    controls.setMode('translate');
    const handles = [...this.planes].map((i) => this.planeAt.get(i)!);
    for (const [i, chosen] of this.boxes) for (const h of chosen) handles.push(new THREE.Vector3(...this.boxAt.get(i)![h]));
    if (!handles.length) {
      controls.detach();
      return;
    }
    proxy.position.set(0, 0, 0);
    for (const h of handles) proxy.position.add(h);
    proxy.position.divideScalar(handles.length);
    if (this.planes.size === 1 && !this.boxes.size) {
      // A plane alone moves along its normal: the proxy's local Y.
      along(plane);
      controls.setSpace('local');
      controls.showX = controls.showZ = false;
      controls.showY = true;
    } else {
      // Corners move in plan, faces up and down, planes either way: only those axes show (world Y is the stage's up).
      proxy.quaternion.identity();
      controls.setSpace('world');
      const chosen = [...this.boxes.values()].flatMap((c) => [...c]);
      controls.showX = controls.showZ = this.planes.size > 0 || chosen.some((h) => h < 4);
      controls.showY = this.planes.size > 0 || chosen.some((h) => h >= 4);
    }
    controls.attach(proxy);
  }

  /** A drag step, applied from the drag's start; refused when the section could not be drawn after it. */
  private moved(): void {
    const { start, proxy, viewport } = this;
    if (!start) return;
    const up = viewport.sync.upAxis;
    const section = structuredClone(start.section);
    const [plane] = this.planes;
    const [box] = this.boxes.keys();
    if (this.rotate && plane !== undefined) {
      // The proxy stays on the plane's dot: the centre of the tilt.
      section.planes[plane] = { point: proxy.position.toArray(), normal: Y.clone().applyQuaternion(proxy.quaternion).toArray() };
    } else if (this.rotate) {
      const b = section.boxes[box];
      const turn = proxy.quaternion.clone().multiply(start.quaternion.clone().invert()); // about the up axis through the middle
      b.corners = b.corners.map((c) => new THREE.Vector3(...c).sub(start.position).applyQuaternion(turn).add(start.position).toArray()) as SectionBox['corners'];
    } else {
      const shift = proxy.position.clone().sub(start.position);
      // A plane's point goes with its dot (the outline's middle): moved along its normal, the plane moves by the
      // shift's part along it.
      for (const i of this.planes) section.planes[i].point = start.planeAt.get(i)!.clone().add(shift).toArray();
      const H = up === 'Z' ? 2 : 1;
      const plan = shift.toArray();
      const rise = plan[H];
      plan[H] = 0;
      for (const [i, chosen] of this.boxes) {
        const b = section.boxes[i];
        b.corners = b.corners.map((c, k) => (chosen.has(k) ? c.map((x, j) => x + plan[j]) : c)) as SectionBox['corners'];
        if (chosen.has(4)) b.bottom += rise;
        if (chosen.has(5)) b.top += rise;
      }
    }
    // A footprint that crosses itself or turns over, or a top below the bottom, would not come back from clean() as it
    // went in: the last valid step stays.
    if (equal(clean(section, up), section)) viewport.setSection(section, 'gizmo');
    viewport.invalidate(); // the gizmo moved either way
  }

  /** A click on a dot or outline: selects it alone, or with toggle adds or removes it. */
  private choose(hit: Hit, toggle: boolean): void {
    const before = JSON.stringify(this.value);
    this.rotate = false;
    if (!toggle) {
      this.planes = new Set();
      this.boxes = new Map();
    }
    if (!hit.box) {
      if (!(toggle && this.planes.delete(hit.index))) this.planes.add(hit.index);
    } else if (hit.handle === undefined) {
      if (!(toggle && this.boxes.delete(hit.index))) this.boxes.set(hit.index, new Set(ALL));
    } else {
      const chosen = this.boxes.get(hit.index) ?? new Set<number>();
      if (!(toggle && chosen.delete(hit.handle))) chosen.add(hit.handle);
      this.boxes.set(hit.index, chosen);
    }
    this.changed(before, true);
  }

  /** The dot, or else the outline, under a client point (null: none), from the entries as last drawn. */
  private hitAt(clientX: number, clientY: number): Hit | null {
    if (!this.picks() || (!this.dotHits.length && !this.edgeHits.length)) return null;
    const { canvas, camera, sync } = this.viewport;
    const rect = canvas.getBoundingClientRect();
    const p = new THREE.Vector3();
    /** Client point of a stage-space point; null behind the camera. */
    const screen = (v: Vec3) => {
      p.fromArray(v).applyMatrix4(sync.root.matrixWorld).project(camera);
      return p.z <= 1 ? [rect.left + ((p.x + 1) / 2) * rect.width, rect.top + ((1 - p.y) / 2) * rect.height] : null;
    };
    let hit: Hit | null = null;
    let nearest = REACH;
    for (const dot of this.dotHits) {
      const s = screen(dot.p);
      const distance = s ? Math.hypot(s[0] - clientX, s[1] - clientY) : Infinity;
      if (distance < nearest) [hit, nearest] = [dot.hit, distance];
    }
    if (hit) return hit;
    for (const edge of this.edgeHits) {
      const a = screen(edge.a);
      const b = screen(edge.b);
      if (!a || !b) continue;
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.min(Math.max(((clientX - a[0]) * dx + (clientY - a[1]) * dy) / (dx * dx + dy * dy || 1), 0), 1);
      const distance = Math.hypot(a[0] + t * dx - clientX, a[1] + t * dy - clientY);
      if (distance < nearest) [hit, nearest] = [edge.hit, distance];
    }
    return hit;
  }
}
