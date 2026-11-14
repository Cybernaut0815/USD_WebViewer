// <usd-viewer>: the layout around a UsdSession and a Viewport, plus the public API.
// Host pages extend it through the `toolbar`, `left`, `right` and `bottom` slots,
// `viewer.session` and the events mirrored from the session.
import type * as THREE from 'three/webgpu';
import type { LocalFile } from './files.ts';
import type { LiveLink } from './live.ts';
import { copyText, type MenuItem, showMenu } from './menu.ts';
import { ACTIVE, HIGHLIGHT, TextureCache } from './materials.ts';
import { h, Props } from './props.ts';
import type { CameraParams, Path, PickResult, StageInfo } from './protocol.ts';
import { EMPTY, MAX, type Section, type SectionBox, type SectionPlane, type SectionSource, type Vec3 } from './section.ts';
import { section } from './sectionnode.ts';
import type { SectionGizmo } from './sectiontool.ts';
import { modifySelect, selectUpWithSubtree, type OpenOptions, type SchemeOptions, type UsdSessionEventMap, type UsdStageApi, UsdSession } from './session.ts';
import { timeline } from './timeline.ts';
import { toolbar } from './toolbar.ts';
import { NavigateTool, SelectTool, type TransformMode, TransformTool, typing } from './tools.ts';
import { Tree } from './tree.ts';
import css from './viewer.css?inline';
import type { DisplayMode, Item, SceneStats } from './scene.ts';
import { type CameraSettings, DEFAULT_BACKGROUND, type ToneMapping, type ViewState, Viewport } from './viewport.ts';

export type OpenSource = string | URL | File | readonly File[] | readonly LocalFile[] | FileSystemDirectoryHandle;
export type ToolName = 'select' | TransformMode | 'navigate';
export type { OpenOptions, SchemeOptions, UsdStageApi };
export type UsdViewerEventMap = UsdSessionEventMap & { toolchange: Event; displaymodechange: Event; skychange: Event; panelschange: Event; camerachange: Event; cameraschange: Event; backgroundchange: Event; refinebudgetchange: Event; autoloadchange: Event; sectionchange: CustomEvent<{ source: SectionSource }>; sectiongizmochange: Event };
export { DEFAULT_BACKGROUND };
export type { CameraSettings, ViewState };
/** Which panels around the viewport are shown. */
export interface PanelState {
  hierarchy: boolean;
  details: boolean;
  timeline: boolean;
}

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
const MIRRORED: (keyof UsdSessionEventMap)[] = [
  'stageopen', 'stageloaded', 'stageclose', 'selectionchange', 'timechange', 'playchange', 'primschange', 'changedprims', 'lockchange', 'refinechange', 'dirtychange', 'diskchange', 'livechange', 'log', 'error',
];
const TOOL_KEYS: Record<string, ToolName> = { q: 'select', w: 'translate', e: 'rotate', r: 'scale' };
/** The buttons at the top left of the viewport: tool, label, key. */
const TOOL_BUTTONS: [ToolName, string, string][] = [
  ['select', 'Select', 'Q'],
  ['translate', 'Move', 'W'],
  ['rotate', 'Rotate', 'E'],
  ['scale', 'Scale', 'R'],
  ['navigate', 'Navigate', 'N'],
];
/**
 * A core worker the page started before the bundle loaded (index.html), taken once if it is for this URL; its
 * messages and errors from before are replayed to the client's handlers, ahead of any later ones.
 */
function adoptWorker(url: URL): Worker {
  const early = (globalThis as { usdCoreWorker?: { url: string; worker: Worker; early: Event[] } }).usdCoreWorker;
  if (!early || early.url !== url.href) return new Worker(url, { type: 'module' });
  delete (globalThis as { usdCoreWorker?: unknown }).usdCoreWorker;
  const { worker } = early;
  worker.onmessage = worker.onerror = null;
  queueMicrotask(() => {
    for (const event of early.early) (event.type === 'message' ? worker.onmessage : worker.onerror)?.call(worker, event as MessageEvent & ErrorEvent);
  });
  return worker;
}

/** Viewer skies: Poly Haven CC0 HDRIs in public/skies (see LICENSE.md there), by file name. */
export const SKIES: Record<string, string> = { 'blue-sky': 'Blue sky', sunset: 'Sunset', forest: 'Forest', industrial: 'Industrial', studio: 'Studio' };
/** The Help window's contents; the key handler in build() implements the keyboard rows. */
const SHORTCUTS: [string, [string, string][]][] = [
  ['Tools', [['Q', 'Select'], ['W', 'Move'], ['E', 'Rotate'], ['R', 'Scale'], ['N', 'Navigate: fly like a game (below); Move, Rotate and Scale are off'], ['Buttons', 'The same tools at the top left of the view']]],
  [
    'Selection',
    [
      ['Click', 'Select a prim (empty space clears)'],
      ['Shift+click', 'Add to the selection (on a selected prim: make it active)'],
      ['Ctrl+click', 'Remove from the selection'],
      ['Shift+Ctrl+click', "Add the prim's parent; again: the next level up"],
      ['Shift+Alt+click', 'Add the parent with everything below it; again: the next level up'],
      ['Alt+click (hierarchy)', 'Add every row between the last clicked row and this one'],
      ['Shift+drag up', 'Add everything the rectangle touches'],
      ['Shift+drag down', 'Add everything fully inside the rectangle'],
      ['Ctrl+drag up / down', 'Remove, the same way'],
      ['Esc', 'Select nothing'],
    ],
  ],
  [
    'Hierarchy',
    [
      ['↑ ↓ ← →', 'Move the selection, expand, collapse'],
      ['P', 'Has a payload (load / unload in the details panel)'],
      ['V', 'Has variant sets (choose in the details panel)'],
      ['I', 'Instanceable: drawn as an instance of a shared prototype'],
      ['◆', 'Changed in this session (kept until the stage is reloaded)'],
      ['◇', 'Something below changed in this session'],
      ['🔓 / 🔒', 'Lock against selection in the viewport (editor only, not saved)'],
      ['● / ○', 'Visible / invisible: click to toggle (written to the edit target)'],
    ],
  ],
  [
    'View',
    [
      ['Left drag', 'Orbit'],
      ['Right drag', 'Pan'],
      ['Wheel / middle drag', 'Zoom (towards the cursor)'],
      ['Hold a mouse button (navigate)', 'Look around with the mouse; let go to use the mouse normally'],
      ['W A S D (navigate)', 'Forward, left, back, right'],
      ['Wheel (navigate)', 'Flight speed, shown at the top left of the view'],
      ['Shift / Alt (navigate)', 'Faster / slower while held'],
      ['F', 'Frame the selection, or everything'],
      ['H', 'Hide the selection (session layer, not saved)'],
      ['Shift+H', 'Hide everything but the selection'],
      ['Alt+H', 'Show what H and Shift+H hid'],
    ],
  ],
  [
    'Section',
    [
      ['Section (view)', 'Add clipping planes and boxes; hide their handles, turn them off, clear them'],
      ['Click a dot or outline', 'Select a plane, a box, or a box corner (its vertical edge), top or bottom'],
      ['Shift / Ctrl+click', 'Add or remove it'],
      ['W / E', 'Move / rotate the selected planes and boxes together'],
      ['Right click', 'Flip planes, show inside or cut out boxes, delete'],
      ['Del', 'Delete the selected planes and boxes'],
      ['Esc', 'Clear the box handles chosen; again: select none'],
    ],
  ],
  ['Time', [['Space', 'Play / pause'], [', and .', 'Previous / next frame']]],
  [
    'Editing',
    [
      ['Ctrl+Z', 'Undo'],
      ['Ctrl+Shift+Z, Ctrl+Y', 'Redo'],
      ['Ctrl+S', 'Save'],
      ['Click a value', 'Copy it (right click: more ways to copy)'],
      ['Right click a prim', 'Prim menu (hierarchy or viewport): copy its USD, lock, Clear edits'],
    ],
  ],
  ['Help', [['F1 or ?', 'This window']]],
];
const LAYOUT_KEY = 'usd-viewer:layout';
/** Selections above this size fill the prim picker's options only when it is opened. */
const LAZY_PICKER = 200;

/**
 * The automatic refinement budget this machine gets by default, in output triangles: 3M at 4 GB
 * of memory, scaled with navigator.deviceMemory (Chromium only, rounded, at most 8) between 1.5M
 * and 6M, and 25% less with fewer than 4 CPU threads (refinement runs on the CPU). The core's
 * 32-bit heap (4 GB, shared with the stage) caps any budget at 8M.
 */
export function hardwareRefineBudget(): number {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;
  let budget = Math.min(Math.max((3e6 * memory) / 4, 1.5e6), 6e6);
  if ((navigator.hardwareConcurrency ?? 4) < 4) budget *= 0.75;
  return Math.round(Math.min(budget, 8e6) / 1e5) * 1e5;
}

export class UsdViewerElement extends HTMLElement {
  static readonly observedAttributes = ['src', 'panels', 'readonly', 'live'];

  /** The headless part: stage, selection, time, commands. Modules and host pages work with this. */
  readonly session: UsdSession;
  /** Resolves when the renderer and the core are up; rejects with instructions otherwise. */
  readonly ready: Promise<void>;

  private readonly viewport: Viewport;
  private readonly tree: Tree;
  private readonly props = new Props();
  private readonly canvas = h('canvas') as HTMLCanvasElement;
  private readonly status = h('div', { className: 'status' });
  private readonly statsBox = h('div', { className: 'stats' });
  private readonly picker = h('select', { className: 'picker', title: 'Prim shown below (of the selection)', hidden: true }) as HTMLSelectElement;
  private readonly help = h('dialog', { className: 'help' }) as HTMLDialogElement;
  private readonly skyTextures: TextureCache;
  private skyName: string | null = null;
  /** Panel widths and visibility, kept per browser. */
  // widths: share of the element; refineBudget: null follows the hardware
  private layout = { left: 0.2, right: 0.25, hierarchy: true, details: true, timeline: true, background: DEFAULT_BACKGROUND, refineBudget: null as number | null, autoLoadArrays: false };
  /** Tabs on the viewport's borders that show and hide the panels. */
  private readonly toggles = {
    left: h('button', { className: 'toggle side' }),
    right: h('button', { className: 'toggle side' }),
    time: h('button', { className: 'toggle time' }),
  };
  private statsFrame = 0;
  private statsTimer = 0;
  private disposed = false;
  private toolName: ToolName = 'select';
  /** The tool N returns to when it leaves navigate. */
  private toolBeforeNavigate: ToolName = 'select';
  /** Between stageopen and stageloaded: the view is framed on the first meshes, then again at the end. */
  private loading = false;
  private framed = false;
  /** A wire display mode asked the core for face edges (session.wantEdges). */
  private edgesWanted = false;
  /** The selection behind the picker; its options are built when it is opened (selections can be huge). */
  private pickerPaths: readonly Path[] = [];
  private readonly unload = (event: BeforeUnloadEvent) => {
    if (this.session.dirty.size) event.preventDefault();
  };

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    this.session = new UsdSession(new URL(this.getAttribute('core-url') ?? 'core/', document.baseURI), adoptWorker);
    this.viewport = new Viewport(
      this.canvas,
      { readBytes: (path) => this.session.readBytes(path), warn: (message) => this.session.report('warn', message) },
      this.hasAttribute('force-webgl'),
    );
    this.viewport.tool = new SelectTool(this.session);
    this.skyTextures = new TextureCache({ readBytes: (path) => this.session.readBytes(path), warn: (message) => this.session.report('warn', message) });
    this.tree = new Tree((path) => this.session.usd.children(path));
    try {
      const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
      for (const side of ['left', 'right'] as const) if (!(saved[side] > 0 && saved[side] < 1)) delete saved[side]; // older pixel widths
      if (!(saved.refineBudget >= 5e5 && saved.refineBudget <= 8e6)) delete saved.refineBudget; // null: the hardware's
      Object.assign(this.layout, saved);
    } catch {} // storage blocked or corrupt: defaults
    this.viewport.background = this.layout.background;
    this.props.autoLoad = this.layout.autoLoadArrays = this.layout.autoLoadArrays === true;
    root.append(this.build());
    this.wire();
    this.ready = this.start();
    this.ready.catch((error) => this.fatal(error.message));
    addEventListener('beforeunload', this.unload);
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'src' && value) this.open(value).catch(() => {});
    if (name === 'panels') this.shadowRoot!.firstElementChild!.classList.toggle('bare', value === 'none');
    if (name === 'readonly' && value !== null && this.tool === 'scale') this.tool = 'select';
    if (name === 'readonly' && this.viewport.tool instanceof TransformTool) this.viewport.tool.refresh(); // readonly: no prim gizmo
    // live="" means the relay at live/ next to the page (what the dev server provides).
    if (name === 'live') value === null ? this.session.live.disconnect() : this.session.live.connect(new URL(value || 'live/', document.baseURI).href);
  }

  /* ---------- public API (delegates to the session and the viewport) ---------- */

  get usd(): UsdStageApi {
    return this.session.usd;
  }
  /** The live link behind the `live` attribute: `connect(url)`, `disconnect()`, `connected`. */
  get live(): LiveLink {
    return this.session.live;
  }
  get stage(): StageInfo | null {
    return this.session.stage;
  }
  get backend(): 'webgpu' | 'webgl2' | null {
    return this.viewport.backend;
  }

  /** three.js objects for hosts that want to draw on top of the stage. */
  get three(): {
    renderer: THREE.WebGPURenderer;
    scene: THREE.Scene;
    root: THREE.Group;
    camera: THREE.Camera;
    /** Host objects: framed (frame() without paths; userData.frame = false opts out) and clipped with the stage, never picked. */
    overlay: THREE.Group;
    /** Called before each frame is drawn, with that frame's camera in place. */
    beforeRender: Set<() => void>;
    /** The render items, live. Instanced meshes: the prototype's (Hydra) path, stage-space instance matrices. */
    items(): readonly Readonly<Pick<Item, 'rid' | 'path' | 'kind' | 'object' | 'instances'>>[];
    objectsFor(path: Path): THREE.Object3D[];
    /** A mesh item's materials as the shaded view draws them, also while another view mode shows (null: no mesh). */
    materials(rid: number): THREE.Material | THREE.Material[] | null;
    invalidate(): void;
    /** Registers a host material to be cut by the section, like the viewer's own, and returns it. NodeMaterials only. */
    section<T extends THREE.Material>(material: T): T;
    /** False where the section cuts this three-world point away: filters a host's own raycast hits. */
    keeps(worldPoint: THREE.Vector3): boolean;
  } {
    const v = this.viewport;
    return {
      renderer: v.renderer,
      scene: v.scene,
      root: v.sync.root,
      camera: v.camera,
      overlay: v.overlay,
      beforeRender: v.beforeRender,
      items: () => [...v.sync.items.values()],
      objectsFor: (path) => v.sync.objectsFor(path),
      materials: (rid) => v.sync.shadedMaterials(rid),
      invalidate: () => v.invalidate(),
      section,
      keeps: (point) => v.keeps(point),
    };
  }

  async open(source: OpenSource, options: OpenOptions = {}): Promise<StageInfo> {
    await this.ready;
    if (this.session.dirty.size && !confirm('Discard unsaved edits?')) throw new Error('open cancelled: unsaved edits');
    this.setStatus('Loading…');
    try {
      if (typeof source === 'string' || source instanceof URL) {
        return await this.session.open(new URL(source, document.baseURI).href, options);
      }
      if ('kind' in source) return await this.session.open(source, options);
      const list = source instanceof File ? [source] : [...source];
      const files: LocalFile[] = list.map((f) => (f instanceof File ? { path: f.name, file: f } : f));
      return await this.session.open(files, options);
    } catch (error: any) {
      this.session.report('error', error.message);
      throw error;
    } finally {
      this.setStatus('');
    }
  }

  close(): Promise<void> {
    return this.session.close();
  }

  /** Resolves when the tool's core calls are done, no flush is pending, every texture is in, and a frame has been drawn. */
  async idle(): Promise<void> {
    await this.viewport.tool?.idle?.();
    await this.session.idle();
    await this.viewport.sync.settled();
    await this.viewport.fullFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    removeEventListener('beforeunload', this.unload);
    clearInterval(this.statsTimer);
    this.session.dispose();
    this.viewport.dispose();
  }

  /** The active viewport tool: select, a transform gizmo (Q W E R), or navigate (N, W A S D flies). */
  get tool(): ToolName {
    return this.toolName;
  }
  set tool(name: ToolName) {
    if (name === this.toolName || (this.hasAttribute('readonly') && name === 'scale')) return; // readonly: Move and Rotate for sections only
    this.toolName = name;
    const current = this.viewport.tool;
    if (name === 'select') this.viewport.tool = new SelectTool(this.session);
    else if (name === 'navigate') this.viewport.tool = new NavigateTool(this.session);
    else if (current instanceof TransformTool) current.setMode(name);
    else this.viewport.tool = new TransformTool(this.session, name, () => !this.hasAttribute('readonly'));
    // Sections follow the tool like prims: Move and Rotate put their gizmo on the selected ones.
    this.viewport.sectionMode = name === 'translate' || name === 'rotate' ? name : 'none';
    this.dispatchEvent(new Event('toolchange'));
  }

  /** True while some layer has unsaved edits. */
  get dirty(): boolean {
    return this.session.dirty.size > 0;
  }
  /** Writes dirty layers back into the opened folder, or downloads them. */
  save(): Promise<string[]> {
    return this.session.save();
  }

  get selection(): readonly Path[] {
    return this.session.selection;
  }
  /** The prim shown in the property panel: the last selected one unless `select` named another. */
  get active(): Path | null {
    return this.session.active;
  }

  select(paths: Path | readonly Path[] | null, options: { reveal?: boolean; frame?: boolean; active?: Path } = {}): void {
    const list = paths === null ? [] : typeof paths === 'string' ? [paths] : [...paths];
    this.session.select(list, 'api', options.active);
    if (options.reveal && this.active) this.tree.reveal(this.active);
    if (options.frame) this.frame(list);
  }

  /** Frames the prims, or with no paths the whole stage and the shown overlay objects (but those with userData.frame = false). */
  frame(paths?: readonly Path[]): void {
    const v = this.viewport;
    v.frame(paths?.length ? v.sync.objectsUnder(paths) : [v.sync.root, ...v.overlay.children.filter((o) => o.visible && o.userData.frame !== false)]);
  }

  async pick(clientX: number, clientY: number): Promise<PickResult | null> {
    const hit = this.viewport.pick(clientX, clientY);
    return hit ? this.session.usd.resolvePick(hit.rid, hit.instance) : null;
  }

  get time(): number {
    return this.session.time;
  }
  set time(value: number) {
    this.session.time = value;
  }
  get playing(): boolean {
    return this.session.playing;
  }
  play(): void {
    this.session.play();
  }
  pause(): void {
    this.session.pause();
  }

  /**
   * The stage's cameras: prim path, lens as Hydra gives it (apertures and focal length at 0.1 x the authored values, so
   * in scene units) and the world matrix in stage space (16 numbers, THREE.Matrix4.elements order). `cameraschange`
   * fires when the list may have changed.
   */
  get cameras(): { path: Path; params: CameraParams; matrix: number[] }[] {
    return this.viewport.sync.cameras().map((c) => ({ path: c.path, params: c.params, matrix: c.matrix.toArray() }));
  }
  /** The free view in world space. Setting it leaves a stage camera; orbiting then goes on from the new view. */
  get view(): ViewState {
    return this.viewport.viewState;
  }
  set view(state: ViewState) {
    if (this.camera !== null) this.camera = null;
    this.viewport.viewState = state;
  }

  /**
   * Clipping planes and boxes, in stage space (stage units and axes; vertical is the stage's up axis). View only: the
   * stage, its three.js objects and the shadows stay whole; pick() and the marquee follow it. Gets a copy; setting
   * replaces the whole section, cleaned (see Section), and fires `sectionchange` when it changed. Opening a stage
   * clears it.
   */
  get section(): Section {
    return this.viewport.section;
  }
  set section(next: Section) {
    this.viewport.setSection(next, 'api');
  }

  /**
   * The section entries selected in the view, or null: one plane, one box with its chosen `handles` (left out when the
   * tool rotates), or several entries (`planes`, `boxes` with their `handles`). Like prims, the Move and Rotate tools put
   * their gizmo on them (`rotate` in a one-entry value: the Rotate tool); prims and sections are never selected
   * together. Setting selects afresh (a box with the handles given, or every one chosen: the whole box moves), so a
   * value read earlier brings the same choice back; indices the section lacks are left out. It also switches the tool
   * to Rotate with `rotate: true`, otherwise to Move unless it is Move or Rotate already, and clears the prim
   * selection. Losing the entry, or selecting a prim, lets go of it. It keeps its indices when the section is replaced:
   * a host that removes an earlier entry sets it again. It changes only `section` (source 'gizmo'), also when readonly.
   * Fires `sectiongizmochange` when the value changed, a click, Esc, Del or a tool switch included.
   */
  get sectionGizmo(): SectionGizmo | null {
    return this.viewport.sectionGizmo;
  }
  set sectionGizmo(target: SectionGizmo | null) {
    this.viewport.sectionGizmo = target;
    if (!this.viewport.sectionGizmo) return;
    if ((target as { rotate?: unknown }).rotate === true) this.tool = 'rotate';
    else if (this.tool !== 'translate' && this.tool !== 'rotate') this.tool = 'translate';
  }
  /**
   * Outlines and dots on every section entry while the section is on (default), which a click selects; off, only the
   * selected entries show them. The Section menu's Hide / Show handles; turning it off lets go of the selection.
   */
  get sectionHandles(): boolean {
    return this.viewport.sectionHandles;
  }
  set sectionHandles(on: boolean) {
    this.viewport.sectionHandles = on;
  }
  /** True over a section dot, outline or gizmo axis at a client point: a host's own pointer handling yields there. */
  sectionGizmoAt(clientX: number, clientY: number): boolean {
    return this.viewport.sectionGizmoAt(clientX, clientY);
  }

  /** Path of the stage camera being looked through, or null for the free camera. */
  get camera(): Path | null {
    return this.viewport.cameraPath;
  }
  set camera(path: Path | null) {
    this.viewport.lookThrough(path);
    this.dispatchEvent(new Event('camerachange'));
  }
  set exposure(ev: number) {
    this.viewport.exposure = ev;
  }
  set toneMapping(mode: ToneMapping) {
    this.viewport.toneMapping = mode;
  }
  /**
   * A viewer sky (key of SKIES) lighting the stage and filling the background in place of its dome;
   * 'colour': the stage's lighting in front of the plain background colour; null: the stage as authored.
   */
  get sky(): string | null {
    return this.skyName;
  }
  set sky(name: string | null) {
    this.skyName = name === 'colour' || (name && SKIES[name]) ? name : null;
    this.dispatchEvent(new Event('skychange'));
    // 'colour': the background colour behind the stage, even where its dome light has a texture.
    this.viewport.sync.solidBackground = this.skyName === 'colour';
    if (!this.skyName || this.skyName === 'colour') {
      this.viewport.sync.setSky(null);
      return;
    }
    const wanted = this.skyName;
    const url = new URL(`${wanted}.hdr`, new URL(this.getAttribute('skies-url') ?? 'skies/', document.baseURI)).href;
    this.skyTextures.get(url, '').then((texture) => {
      if (this.skyName === wanted) this.viewport.sync.setSky(texture);
    });
  }

  /**
   * Background colour (#rrggbb, or 'transparent' to show the page behind) wherever no sky or dome texture fills the
   * background. Remembered per browser.
   */
  get backgroundColor(): string {
    return this.viewport.background;
  }
  set backgroundColor(color: string) {
    this.viewport.background = color;
    this.layout.background = this.viewport.background;
    this.applyLayout();
    this.dispatchEvent(new Event('backgroundchange'));
  }

  /** Selection fill of every selected prim, the active one included. Page-wide: all viewers share these materials. */
  set highlight({ color, opacity }: { color: string; opacity: number }) {
    for (const material of [HIGHLIGHT, ACTIVE]) {
      material.color.set(color);
      material.opacity = opacity;
    }
    this.viewport.invalidate();
  }

  /** Numeric array values (points, indices, uvs) in the details panel: loaded on selection, or on click (default). Remembered per browser. */
  get autoLoadArrays(): boolean {
    return this.layout.autoLoadArrays;
  }
  set autoLoadArrays(on: boolean) {
    this.props.autoLoad = this.layout.autoLoadArrays = on;
    this.applyLayout();
    this.showProps(this.active);
    this.dispatchEvent(new Event('autoloadchange'));
  }

  /** Panels around the viewport; hidden ones give their space to it. Remembered per browser. */
  get panels(): PanelState {
    const { hierarchy, details, timeline } = this.layout;
    return { hierarchy, details, timeline };
  }
  set panels(state: Partial<PanelState>) {
    Object.assign(this.layout, state);
    this.applyLayout();
    this.dispatchEvent(new Event('panelschange'));
  }

  /** The free camera's projection, focal length and clipping (stage cameras keep their own). */
  /**
   * Output triangles "Refine: auto" may produce for the stage's authored subdivision surfaces.
   * Defaults to hardwareRefineBudget(); setting null goes back to it. Remembered per browser.
   */
  get refineBudget(): number {
    return this.layout.refineBudget ?? hardwareRefineBudget();
  }
  set refineBudget(triangles: number | null) {
    this.layout.refineBudget = triangles === null ? null : Math.min(Math.max(triangles, 5e5), 8e6);
    this.applyLayout();
    this.session.usd.setRefineBudget(this.refineBudget).catch(() => {});
    this.dispatchEvent(new Event('refinebudgetchange'));
  }

  get cameraSettings(): CameraSettings {
    return this.viewport.cameraSettings;
  }
  set cameraSettings(settings: Partial<CameraSettings>) {
    this.viewport.cameraSettings = settings;
    this.dispatchEvent(new Event('camerachange'));
  }

  /** Opens the window listing keys and mouse gestures. */
  showHelp(): void {
    if (!this.help.open) this.help.showModal();
  }

  get displayMode(): DisplayMode {
    return this.viewport.sync.displayMode;
  }
  set displayMode(mode: DisplayMode) {
    this.viewport.sync.setDisplayMode(mode);
    // The wire modes draw the faces' edges, which the core sends from their first use on ('wire' shows nothing
    // until they are in: say so on a stage that is open).
    if (mode.includes('wire')) {
      const first = !this.edgesWanted && !!this.session.stage;
      this.edgesWanted = true;
      const loaded = this.session.wantEdges();
      if (first) {
        this.setStatus('Loading edges…');
        loaded.finally(() => this.status.textContent === 'Loading edges…' && this.setStatus(''));
      }
    }
    this.dispatchEvent(new Event('displaymodechange'));
  }
  /** Purposes drawn besides visibility (default and proxy unless changed). */
  get purposes(): string[] {
    return [...this.viewport.sync.purposes];
  }
  set purposes(purposes: Iterable<string>) {
    this.viewport.sync.setPurposes(purposes);
    this.updateStats();
  }
  /** USD counts of what the viewport draws (the overlay at its top right), and how fast it draws. */
  get stats(): SceneStats & { fps: number | null; frameMs: number } {
    return { ...this.viewport.sync.stats(), fps: this.viewport.fps, frameMs: this.viewport.frameMs };
  }

  /** H: hides the selection (session layer, never saved; undoable). */
  async hide(): Promise<void> {
    if (this.selection.length) await this.usd.hide(this.selection);
  }
  /** Shift+H: hides everything but the selection. */
  async isolate(): Promise<void> {
    if (this.selection.length) await this.usd.isolate(this.selection);
  }
  /** Alt+H: shows what hide and isolate hid. */
  showAll(): Promise<void> {
    return this.usd.showAll();
  }
  screenshot(type?: string, quality?: number): Promise<Blob> {
    return this.viewport.screenshot(type, quality);
  }
  registerScheme(scheme: string, options: SchemeOptions): void {
    this.session.registerScheme(scheme, options);
  }
  undo(): Promise<void> {
    return this.session.commands.undo();
  }
  redo(): Promise<void> {
    return this.session.commands.redo();
  }

  /* ---------- wiring ---------- */

  private async start(): Promise<void> {
    if (!crossOriginIsolated) {
      throw new Error(
        'This page is not cross-origin isolated. Serve it with the headers ' +
          '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp".',
      );
    }
    this.setStatus('Starting USD core…');
    await Promise.all([this.viewport.init(), this.session.ready]);
    this.session.core.call('setRefineBudget', this.refineBudget);
    this.setStatus('');
  }

  private build(): HTMLElement {
    const search = h('input', { type: 'search', placeholder: 'Search prims (type:Mesh name)' }) as HTMLInputElement;
    const clear = h('button', { className: 'clear', title: 'Clear search', hidden: true }, '✕') as HTMLButtonElement;
    let searchTimer = 0;
    const reset = () => {
      clearTimeout(searchTimer);
      search.value = '';
      clear.hidden = true;
      this.tree.showResults(null);
      search.focus();
    };
    clear.addEventListener('click', reset);
    search.addEventListener('keydown', (e) => e.key === 'Escape' && reset());
    search.addEventListener('input', () => {
      clear.hidden = !search.value;
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(async () => {
        const type = /(?:^|\s)type:(\S+)/.exec(search.value)?.[1] ?? '';
        const text = search.value.replace(/(?:^|\s)type:\S+/, '').trim();
        this.tree.showResults(text || type ? await this.usd.find(text, type) : null);
      }, 200);
    });
    this.props.show(null);
    this.canvas.tabIndex = 0;
    const close = h('button', { className: 'close', title: 'Close' }, '✕');
    close.addEventListener('click', () => this.help.close());
    this.help.addEventListener('click', (event) => event.target === this.help && this.help.close());
    this.help.append(
      h('div', { className: 'head' }, h('strong', {}, 'Keys and mouse'), close),
      ...SHORTCUTS.map(([group, rows]) => h('section', {}, h('h4', {}, group), h('table', {}, ...rows.map(([keys, what]) => h('tr', {}, h('td', {}, h('kbd', {}, keys)), h('td', {}, what)))))),
    );
    this.picker.addEventListener('change', () => this.session.select(this.selection, 'api', this.picker.value));
    for (const type of ['pointerdown', 'keydown', 'focus']) {
      this.picker.addEventListener(type, () => {
        if (this.picker.options.length === this.pickerPaths.length) return;
        this.picker.replaceChildren(...this.pickerPaths.map((path) => h('option', { value: path, selected: path === this.active, title: path }, path)));
      });
    }
    this.toggles.time.addEventListener('click', () => (this.panels = { timeline: !this.layout.timeline }));
    const sectionButton = h('button', { className: 'section', title: 'Section: clipping planes and boxes (view only)' }, 'Section');
    sectionButton.addEventListener('click', () => {
      const r = sectionButton.getBoundingClientRect();
      this.sectionMenu(r.left, r.bottom + 4);
    });
    const tools = h(
      'div',
      { className: 'tools' },
      ...TOOL_BUTTONS.map(([name, label, key]) => {
        const button = h('button', { value: name, title: name === 'navigate' ? `${label} (${key}): hold a mouse button to look, W A S D to fly` : `${label} (${key})` }, label);
        button.addEventListener('click', () => (this.tool = name));
        return button;
      }),
      sectionButton,
    );
    const syncTools = () => tools.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.value === this.tool));
    this.addEventListener('toolchange', syncTools);
    syncTools();
    const app = h(
      'div',
      { className: 'app' },
      toolbar(this, this.viewport),
      h('aside', { className: 'left' }, h('div', { className: 'search' }, search, clear), this.tree.element, h('slot', { name: 'left' })),
      this.splitter('left'),
      h('main', {}, this.canvas, tools, this.status, this.statsBox, this.toggles.time),
      this.splitter('right'),
      h('aside', { className: 'right' }, this.picker, this.props.element, h('slot', { name: 'right' })),
      h('footer', { className: 'bottom' }, timeline(this.session), h('slot', { name: 'bottom' })),
      this.help,
    );
    // Keys work from the viewport and the panels, not while typing.
    app.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      const target = e.composedPath()[0] as HTMLElement;
      const key = e.key.toLowerCase();
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const gizmo = e.key === 'Escape' && this.viewport.sectionGizmo !== null;
      const removing = (e.key === 'Delete' || e.key === 'Backspace') && this.viewport.sectionGizmo !== null;
      const none = e.key === 'Escape' && !gizmo && this.selection.length > 0 && !this.help.open; // as a click on nothing
      // readonly: F and the H keys only (hiding writes the session layer, never saved; the Help window lists editing
      // keys), and Esc and Del for the selection (they edit the view only)
      const tools = plain && ((TOOL_KEYS[key] && TOOL_KEYS[key] !== 'scale') || key === 'n'); // readonly: Move and Rotate move sections only
      if (this.hasAttribute('readonly') && !(key === 'f' && plain) && e.code !== 'KeyH' && !gizmo && !removing && !none && !tools) return;
      if (key === 'f' && plain) this.frame(this.selection);
      else if (e.ctrlKey && key === 'z') (e.shiftKey ? this.redo() : this.undo());
      else if (e.ctrlKey && key === 'y') this.redo();
      else if (e.ctrlKey && key === 's') this.save().catch(() => {});
      else if (plain && key === 'n') {
        if (this.tool === 'navigate') this.tool = this.toolBeforeNavigate;
        else {
          this.toolBeforeNavigate = this.tool;
          this.tool = 'navigate';
        }
      } else if (plain && TOOL_KEYS[key] && (this.tool !== 'navigate' || key === 'q')) this.tool = TOOL_KEYS[key]; // navigate owns W
      else if (e.code === 'KeyH' && !e.ctrlKey && !e.metaKey) {
        (e.altKey ? this.showAll() : e.shiftKey ? this.isolate() : this.hide()).catch(() => {});
      } else if (e.key === ' ' && plain && target.tagName !== 'BUTTON') this.session.playing ? this.session.pause() : this.session.play();
      else if ((e.key === ',' || e.key === '.') && !e.ctrlKey && !e.metaKey && this.stage?.hasTimeRange) this.step(e.key === '.' ? 1 : -1);
      else if (e.key === 'F1' || e.key === '?') this.showHelp();
      else if (gizmo) this.viewport.escapeSectionGizmo();
      else if (none) modifySelect(this.session, [], 'replace', 'viewport');
      else if (removing) this.viewport.removeSelectedSections();
      else return;
      e.preventDefault();
    });
    // The panel tabs show only while the pointer is near their border of the viewport.
    const main = app.querySelector('main')!;
    app.addEventListener('pointermove', (e) => {
      const r = main.getBoundingClientRect();
      const near = 32;
      const inside = e.clientY > r.top && e.clientY < r.bottom;
      app.classList.toggle('near-left', inside && Math.abs(e.clientX - r.left) < near);
      app.classList.toggle('near-right', inside && Math.abs(e.clientX - r.right) < near);
      app.classList.toggle('near-time', e.clientX > r.left && e.clientX < r.right && Math.abs(e.clientY - r.bottom) < near);
    });
    app.addEventListener('pointerleave', () => app.classList.remove('near-left', 'near-right', 'near-time'));
    queueMicrotask(() => this.applyLayout()); // once the element is in the shadow root
    return app;
  }

  /** One frame forward or back, clamped to the stage's range. */
  private step(direction: 1 | -1): void {
    const stage = this.stage!;
    const now = Number.isNaN(this.time) ? stage.startTimeCode : this.time;
    this.pause();
    this.time = Math.min(Math.max(direction > 0 ? Math.floor(now) + 1 : Math.ceil(now) - 1, stage.startTimeCode), stage.endTimeCode);
  }

  /** The Section menu at a client point: adds planes and boxes (selected for the gizmo), edits, flips and removes them. */
  private sectionMenu(x: number, y: number): void {
    const v = this.viewport;
    const s = this.section;
    const up = v.sync.upAxis === 'Z' ? 2 : 1;
    const set = (next: Section) => v.setSection(next, 'ui');
    const add = (plane: SectionPlane | null, box: SectionBox | null) => {
      set({ ...s, planes: plane ? [...s.planes, plane] : s.planes, boxes: box ? [...s.boxes, box] : s.boxes });
      v.sectionGizmo = plane ? { plane: s.planes.length } : { box: s.boxes.length }; // selected; the tool stays
    };
    /** Stage-space bounds of objects, of the whole stage by default: [min, max]. */
    const bounds = (objects?: THREE.Object3D[]) => {
      const box = v.bounds(objects).applyMatrix4(v.sync.root.matrixWorld.clone().invert());
      return [box.min.toArray(), box.max.toArray()];
    };
    const centred = (axis: number) => () => {
      const [lo, hi] = bounds();
      const normal: Vec3 = [0, 0, 0];
      normal[axis] = -1; // the negative side stays: below a horizontal plane
      add({ point: lo.map((l, i) => (l + hi[i]) / 2) as Vec3, normal }, null);
    };
    const facing = () => {
      const toStage = v.sync.root.matrixWorld.clone().invert();
      const point = v.controls.target.clone().applyMatrix4(toStage).toArray();
      add({ point, normal: v.camera.getWorldDirection(v.controls.target.clone()).transformDirection(toStage).toArray() }, null); // keeps what lies beyond
    };
    const around = () => {
      const objects = this.selection.flatMap((p) => v.sync.objectsFor(p));
      const [lo, hi] = bounds(objects.length ? objects : undefined);
      const margin = Math.hypot(...hi.map((h, i) => h - lo[i])) / 100; // the selection's own faces stay clear of the box's
      const a = lo.map((l) => l - margin);
      const b = hi.map((h) => h + margin);
      const [P, Q] = [0, 1, 2].filter((i) => i !== up);
      const corner = (p: number[], q: number[]) => {
        const c = [...a] as Vec3;
        c[P] = p[P];
        c[Q] = q[Q];
        return c;
      };
      add(null, { keep: 'inside', corners: [corner(a, a), corner(b, a), corner(b, b), corner(a, b)], bottom: a[up], top: b[up] });
    };
    const empty = !s.planes.length && !s.boxes.length;
    const items: MenuItem[] = [
      ...['X', 'Y', 'Z'].map((name, axis) => ({ label: `Plane ${name}${axis === up ? ' (horizontal)' : ''}`, action: centred(axis), disabled: s.planes.length >= MAX })),
      { label: 'Plane facing the view', action: facing, disabled: s.planes.length >= MAX },
      { label: this.selection.length ? 'Box around the selection' : 'Box around the stage', action: around, disabled: s.boxes.length >= MAX },
      { label: v.sectionHandles ? 'Hide handles' : 'Show handles', action: () => (v.sectionHandles = !v.sectionHandles), disabled: empty },
      {
        label: s.on ? 'Sections off' : 'Sections on',
        action: () => {
          if (s.on) v.sectionGizmo = null; // its handles go with the cut
          set({ ...s, on: !s.on });
        },
        disabled: empty,
      },
      { label: 'Clear', action: () => set(EMPTY), disabled: empty },
      {
        label: 'Select all',
        action: () => (v.sectionGizmo = { planes: s.planes.map((_, i) => i), boxes: s.boxes.map((_, box) => ({ box })) }),
        disabled: empty || !s.on,
      },
      ...this.selectedSectionItems(true),
    ];
    showMenu(this.shadowRoot!, x, y, items);
  }

  /** The menu of the selected planes and boxes (a right click on one): flip, show inside or cut out, delete. */
  private selectedSectionMenu(x: number, y: number): void {
    showMenu(this.shadowRoot!, x, y, this.selectedSectionItems(false));
  }

  /** Flip, show inside or cut out, delete the selected planes and boxes; `all` lists them disabled when they do not apply. */
  private selectedSectionItems(all: boolean): MenuItem[] {
    const v = this.viewport;
    const s = this.section;
    const { planes, boxes } = v.sectionSelected;
    const inside = boxes.every((i) => s.boxes[i].keep === 'inside');
    const many = (n: number, one: string, more: string) => (n > 1 ? more : one);
    const items: MenuItem[] = [];
    if (planes.length || all) {
      const flipped = s.planes.map((p, i) => (planes.includes(i) ? { point: p.point, normal: p.normal.map((n) => -n || 0) as Vec3 } : p));
      items.push({ label: many(planes.length, 'Flip plane', 'Flip planes'), action: () => v.setSection({ ...s, planes: flipped }, 'ui'), disabled: !planes.length });
    }
    if (boxes.length || all) {
      const keep = inside ? 'outside' : 'inside';
      const kept = s.boxes.map((b, i) => (boxes.includes(i) ? { ...b, keep } : b));
      items.push({ label: inside ? 'Cut out' : 'Show inside', action: () => v.setSection({ ...s, boxes: kept }, 'ui'), disabled: !boxes.length });
    }
    items.push({ label: all ? 'Delete selected' : 'Delete', action: () => v.removeSelectedSections(), disabled: !planes.length && !boxes.length });
    return items;
  }

  /** A draggable border between a side panel and the viewport, with a tab in its middle that shows or hides the panel. */
  private splitter(side: 'left' | 'right'): HTMLElement {
    const panel = side === 'left' ? 'hierarchy' : 'details';
    const element = h('div', { className: `split ${side}-split`, title: 'Drag to resize' });
    element.append(this.toggles[side]);
    this.toggles[side].addEventListener('pointerdown', (e) => e.stopPropagation()); // a click, not a drag
    this.toggles[side].addEventListener('click', () => (this.panels = { [panel]: !this.layout[panel] }));
    element.addEventListener('pointerdown', (down) => {
      if (!this.layout[panel]) return;
      element.setPointerCapture(down.pointerId);
      const start = this.layout[side];
      const width = element.parentElement!.clientWidth;
      const move = (e: PointerEvent) => {
        const delta = side === 'left' ? e.clientX - down.clientX : down.clientX - e.clientX;
        this.layout[side] = Math.min(Math.max(start + delta / width, 0.05), 0.6);
        this.applyLayout();
      };
      element.addEventListener('pointermove', move);
      element.addEventListener('lostpointercapture', () => element.removeEventListener('pointermove', move), { once: true });
    });
    return element;
  }

  private applyLayout(): void {
    const app = this.shadowRoot!.querySelector('.app') as HTMLElement | null;
    if (!app) return;
    const { left, right, hierarchy, details, timeline } = this.layout;
    // Side panels are a share of the window, so they scale with it; the timebar keeps its own height.
    const column = (shown: boolean, share: number) => (shown ? `max(120px, ${(share * 100).toFixed(2)}%)` : '0');
    app.style.gridTemplateColumns = `${column(hierarchy, left)} auto minmax(0, 1fr) auto ${column(details, right)}`;
    app.style.background = this.layout.background === 'transparent' ? 'none' : '';
    app.classList.toggle('no-left', !hierarchy);
    app.classList.toggle('no-right', !details);
    app.classList.toggle('no-time', !timeline);
    this.toggles.left.textContent = hierarchy ? '‹' : '›';
    this.toggles.left.title = hierarchy ? 'Hide the hierarchy' : 'Show the hierarchy';
    this.toggles.right.textContent = details ? '›' : '‹';
    this.toggles.right.title = details ? 'Hide the details' : 'Show the details';
    this.toggles.time.textContent = timeline ? '▾' : '▴';
    this.toggles.time.title = timeline ? 'Hide the timebar' : 'Show the timebar';
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
    } catch {} // a per-browser convenience only
  }

  /** Connects the panels to the session and mirrors its events on the element. */
  private wire(): void {
    const session = this.session;
    const on = <K extends keyof UsdSessionEventMap>(type: K, handler: (event: UsdSessionEventMap[K]) => void) =>
      session.addEventListener(type, handler as EventListener);
    // Before the mirrored event: a host's stageopen listener sees the new up axis, and a section it sets there stays.
    on('stageopen', (e) => {
      // FPS changes without deltas, so the overlay also refreshes on a timer while a stage is open.
      clearInterval(this.statsTimer);
      this.statsTimer = window.setInterval(() => this.updateStats(), 500);
      this.loading = true;
      this.framed = false;
      this.viewport.sync.setUpAxis(e.detail.upAxis);
      this.viewport.setSection(EMPTY, 'stage'); // its numbers were in the last stage's space
      this.tree.reset().catch(() => {});
    });
    for (const type of MIRRORED) {
      on(type, (e) => this.dispatchEvent(new CustomEvent(type, { detail: (e as CustomEvent).detail })));
    }
    this.viewport.onsection = (source) => {
      this.showSectionProps();
      this.dispatchEvent(new CustomEvent('sectionchange', { detail: { source } }));
    };
    this.viewport.onsectiongizmo = () => {
      if (this.viewport.sectionGizmo && this.selection.length) this.session.select([], 'api'); // never both selected
      this.showSectionProps();
      this.dispatchEvent(new Event('sectiongizmochange'));
    };
    this.viewport.onsectionmenu = (x, y) => this.selectedSectionMenu(x, y);
    on('delta', (e) => {
      this.viewport.sync.apply(e.detail);
      if (e.detail.cameras?.length || e.detail.removed?.length) this.dispatchEvent(new Event('cameraschange'));
      // The first page with meshes gets framed at once; stageloaded frames the complete stage.
      if (this.loading && !this.framed && e.detail.meshes?.length) {
        this.framed = true;
        this.viewport.frame();
      }
      const d = e.detail;
      if (d.meshes || d.curves || d.points || d.removed || d.visibility || d.materials) this.updateStats(); // not for a selection alone
    });
    on('stageloaded', () => {
      this.loading = false;
      this.viewport.frame();
    });
    on('stageclose', () => {
      clearInterval(this.statsTimer);
      this.updateStats();
      this.viewport.sync.clear();
      this.camera = null; // after the clear: the camera menu rebuilds from the empty scene
      this.dispatchEvent(new Event('cameraschange')); // the clear sends no delta
      this.tree.clear();
      this.props.show(null);
    });
    on('selectionchange', async (e) => {
      const { paths, source, active } = e.detail;
      if (paths.length) this.viewport.sectionGizmo = null; // never both selected
      this.tree.setSelection(paths, active);
      this.viewport.sync.setActive(active);
      this.picker.hidden = paths.length < 2;
      this.pickerPaths = paths;
      if (paths.length > 1 && paths.length <= LAZY_PICKER) {
        this.picker.replaceChildren(...paths.map((path) => h('option', { value: path, selected: path === active, title: path }, path)));
      } else if (paths.length > 1) {
        // Thousands of options (a subtree or marquee selection) are built when the picker is opened.
        const shown = active ?? paths[0];
        this.picker.replaceChildren(h('option', { value: shown, selected: true, title: shown }, shown));
      }
      if (source === 'viewport' && active) this.tree.reveal(active).catch(() => {}); // the panel need not wait for it
      this.showProps(active);
    });
    on('primschange', async (e) => {
      // Visibility is computed down the tree, so every loaded row may have changed: one batched query.
      if (e.detail.visibility) await this.tree.refreshVisibility((paths) => session.core.call('primVisibility', JSON.stringify(paths)), e.detail.touched);
      if (e.detail.resynced.length) await this.tree.invalidate(e.detail.resynced);
      this.showProps(this.active);
    });
    on('changedprims', () => this.tree.redraw());
    on('lockchange', () => this.tree.redraw());
    on('refinechange', () => {
      this.props.globalRefine = { setting: session.refineLevel, effective: session.effectiveRefineLevel };
    });

    this.tree.onselect = (paths, mode) =>
      mode === 'subtree' ? selectUpWithSubtree(session, paths[0], 'hierarchy').catch(() => {}) : modifySelect(session, paths, mode, 'hierarchy');
    this.tree.onvisible = (path, visible) => this.usd.setVisible(path, visible).catch(() => {});
    this.tree.onframe = (path) => this.frame([path]);
    this.props.onvariant = (path, set, variant) => this.usd.setVariant(path, set, variant).catch(() => {});
    this.props.onloaded = (path, loaded) => this.usd.setPayloadLoaded(path, loaded).catch(() => {});
    this.props.onnavigate = (path) => this.select(path, { reveal: true });
    this.props.onframe = (path) => this.frame([path]);
    this.props.onrefinement = (path, enabled, level) => this.usd.setRefinement(path, enabled, level).catch(() => {});
    this.props.onsectionedit = (next) => this.viewport.setSection(next, 'ui');
    this.props.onsectiondelete = (planes, boxes) => this.viewport.removeSections(planes, boxes, 'ui');
    // Values in the panel are truncated; the clipboard gets the whole thing.
    this.props.attributeValue = (path, name) => this.usd.attribute(path, name);
    this.props.attributeHead = (path, name) => this.usd.attributeHead(path, name);
    this.props.bounds = (path) => this.usd.bounds(path);
    this.props.oncopy = (text) => text.then(copyText).catch(() => {});
    this.props.oncontext = (x, y, choices) =>
      showMenu(this.shadowRoot!, x, y, choices.map((choice) => ({ label: choice.label, action: () => choice.text().then(copyText).catch(() => {}) })));
    this.tree.isLocked = (path) => session.isLocked(path);
    this.tree.changeState = (path) => session.changeState(path);
    this.tree.onlock = (path, locked) => session.setLocked(path, locked);
    // The prim menu: right click in the hierarchy or on the prim in the viewport.
    this.tree.oncontext = this.viewport.oncontext = (path, x, y) => {
      if (this.hasAttribute('readonly')) return;
      const locked = session.isLocked(path);
      const items: MenuItem[] = [
        {
          label: 'Clear edits',
          action: () => this.usd.clearPrimEdits(path).catch(() => {}),
          disabled: !session.changeState(path),
        },
        { label: 'Copy composed USD', action: () => this.usd.exportPrim(path, 'composed').then(copyText) },
        { label: 'Copy authored USD', action: () => this.usd.exportPrim(path, 'authored').then(copyText) },
        { label: 'Copy path', action: () => copyText(path) },
        { label: locked ? 'Unlock' : 'Lock', action: () => session.setLocked(path, !locked) },
        { label: 'Clear refinement override', action: () => this.usd.clearRefinement(path).catch(() => {}) },
      ];
      showMenu(this.shadowRoot!, x, y, items);
    };
  }

  /** Shows a prim in the property panel, ignoring answers for a selection that changed meanwhile. */
  private async showProps(path: Path | null): Promise<void> {
    if (!path) return this.showSectionProps();
    const info = await this.usd.prim(path).catch(() => null);
    if (this.active === path) this.props.show(info);
  }

  /** With no prim selected, the property panel edits the selected planes and boxes, or shows its hint. */
  private showSectionProps(): void {
    if (this.active) return;
    const v = this.viewport;
    if (v.sectionGizmo) this.props.showSection(v.section, v.sectionSelected, v.sync.upAxis);
    else this.props.show(null);
  }

  /** Redraws the stats overlay once per frame at most. */
  private updateStats(): void {
    if (this.statsFrame) return;
    this.statsFrame = requestAnimationFrame(() => {
      this.statsFrame = 0;
      const s = this.stats;
      const rows: [string, number][] = [
        ['Meshes', s.meshes],
        ['Vertices', s.points],
        ['Faces', s.faces],
        ['Edges', s.edges],
        ['Materials', s.materials],
        ['Textures', s.textures],
      ];
      const fps = this.viewport.fps;
      const timing: [string, string][] = [
        ['FPS', fps === null ? 'idle' : String(fps)],
        ['Frame', `${this.viewport.frameMs.toFixed(1)} ms`],
      ];
      this.statsBox.replaceChildren(
        ...rows.flatMap(([label, value]) => [h('span', {}, label), h('output', {}, value.toLocaleString())]),
        ...timing.flatMap(([label, value]) => [h('span', {}, label), h('output', {}, value)]),
      );
      this.statsBox.hidden = !this.session.stage;
    });
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  private fatal(message: string): void {
    this.status.classList.add('fatal');
    this.setStatus(message);
  }
}
