// <usd-viewer>: the layout around a UsdSession and a Viewport, plus the public API.
// Host pages extend it through the `toolbar`, `left`, `right` and `bottom` slots,
// `viewer.session` and the events mirrored from the session.
import type * as THREE from 'three/webgpu';
import type { LocalFile } from './files.ts';
import { copyText, type MenuItem, showMenu } from './menu.ts';
import { TextureCache } from './materials.ts';
import { h, Props } from './props.ts';
import type { Path, PickResult, StageInfo } from './protocol.ts';
import { modifySelect, selectUpWithSubtree, type OpenOptions, type SchemeOptions, type UsdSessionEventMap, type UsdStageApi, UsdSession } from './session.ts';
import { timeline } from './timeline.ts';
import { toolbar } from './toolbar.ts';
import { NavigateTool, SelectTool, type TransformMode, TransformTool, typing } from './tools.ts';
import { Tree } from './tree.ts';
import css from './viewer.css?inline';
import type { DisplayMode, SceneStats } from './scene.ts';
import { type CameraSettings, DEFAULT_BACKGROUND, type ToneMapping, Viewport } from './viewport.ts';

export type OpenSource = string | URL | File | readonly File[] | readonly LocalFile[] | FileSystemDirectoryHandle;
export type ToolName = 'select' | TransformMode | 'navigate';
export type { OpenOptions, SchemeOptions, UsdStageApi };
export type UsdViewerEventMap = UsdSessionEventMap & { toolchange: Event; displaymodechange: Event; skychange: Event; panelschange: Event; camerachange: Event; backgroundchange: Event; refinebudgetchange: Event };
export { DEFAULT_BACKGROUND };
export type { CameraSettings };
/** Which panels around the viewport are shown. */
export interface PanelState {
  hierarchy: boolean;
  details: boolean;
  timeline: boolean;
}

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
const MIRRORED: (keyof UsdSessionEventMap)[] = [
  'stageopen', 'stageloaded', 'stageclose', 'selectionchange', 'timechange', 'playchange', 'primschange', 'lockchange', 'refinechange', 'dirtychange', 'diskchange', 'log', 'error',
];
const TOOL_KEYS: Record<string, ToolName> = { q: 'select', w: 'translate', e: 'rotate', r: 'scale' };
/** Viewer skies: Poly Haven CC0 HDRIs in public/skies (see LICENSE.md there), by file name. */
export const SKIES: Record<string, string> = { 'blue-sky': 'Blue sky', sunset: 'Sunset', forest: 'Forest', industrial: 'Industrial', studio: 'Studio' };
/** The Help window's contents; the key handler in build() implements the keyboard rows. */
const SHORTCUTS: [string, [string, string][]][] = [
  ['Tools', [['Q', 'Select'], ['W', 'Move'], ['E', 'Rotate'], ['R', 'Scale'], ['N', 'Navigate: W A S D move the camera; Move, Rotate and Scale are off']]],
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
      ['W A S D (navigate)', 'Forward, left, back, right; speed follows the zoom'],
      ['F', 'Frame the selection, or everything'],
      ['H', 'Hide the selection (session layer, not saved)'],
      ['Shift+H', 'Hide everything but the selection'],
      ['Alt+H', 'Show what H and Shift+H hid'],
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
  static readonly observedAttributes = ['src', 'panels'];

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
  private layout = { left: 0.2, right: 0.25, hierarchy: true, details: true, timeline: true, background: DEFAULT_BACKGROUND, refineBudget: null as number | null };
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
  /** The selection behind the picker; its options are built when it is opened (selections can be huge). */
  private pickerPaths: readonly Path[] = [];
  private readonly unload = (event: BeforeUnloadEvent) => {
    if (this.session.dirty.size) event.preventDefault();
  };

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [sheet];
    this.session = new UsdSession(new URL(this.getAttribute('core-url') ?? 'core/', document.baseURI));
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
    root.append(this.build());
    this.wire();
    this.ready = this.start();
    this.ready.catch((error) => this.fatal(error.message));
    addEventListener('beforeunload', this.unload);
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'src' && value) this.open(value).catch(() => {});
    if (name === 'panels') this.shadowRoot!.firstElementChild!.classList.toggle('bare', value === 'none');
  }

  /* ---------- public API (delegates to the session and the viewport) ---------- */

  get usd(): UsdStageApi {
    return this.session.usd;
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
    objectsFor(path: Path): THREE.Object3D[];
    invalidate(): void;
  } {
    const v = this.viewport;
    return {
      renderer: v.renderer,
      scene: v.scene,
      root: v.sync.root,
      camera: v.camera,
      objectsFor: (path) => v.sync.objectsFor(path),
      invalidate: () => v.invalidate(),
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
    await this.viewport.nextFrame();
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
    if (name === this.toolName) return;
    this.toolName = name;
    const current = this.viewport.tool;
    if (name === 'select') this.viewport.tool = new SelectTool(this.session);
    else if (name === 'navigate') this.viewport.tool = new NavigateTool(this.session);
    else if (current instanceof TransformTool) current.setMode(name);
    else this.viewport.tool = new TransformTool(this.session, name);
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

  frame(paths?: readonly Path[]): void {
    this.viewport.frame(paths?.length ? paths.flatMap((p) => this.viewport.sync.objectsFor(p)) : undefined);
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

  /** Path of the stage camera being looked through, or null for the free camera. */
  get camera(): Path | null {
    return this.viewport.cameraPath;
  }
  set camera(path: Path | null) {
    this.viewport.lookThrough(path);
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

  /** Background colour (#rrggbb) wherever no sky or dome texture fills the background. Remembered per browser. */
  get backgroundColor(): string {
    return this.viewport.background;
  }
  set backgroundColor(color: string) {
    this.viewport.background = color;
    this.layout.background = this.viewport.background;
    this.applyLayout();
    this.dispatchEvent(new Event('backgroundchange'));
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
    const app = h(
      'div',
      { className: 'app' },
      toolbar(this, this.viewport),
      h('aside', { className: 'left' }, h('div', { className: 'search' }, search, clear), this.tree.element, h('slot', { name: 'left' })),
      this.splitter('left'),
      h('main', {}, this.canvas, this.status, this.statsBox, this.toggles.time),
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
    for (const type of MIRRORED) {
      on(type, (e) => this.dispatchEvent(new CustomEvent(type, { detail: (e as CustomEvent).detail })));
    }
    on('delta', (e) => {
      this.viewport.sync.apply(e.detail);
      // The first page with meshes gets framed at once; stageloaded frames the complete stage.
      if (this.loading && !this.framed && e.detail.meshes?.length) {
        this.framed = true;
        this.viewport.frame();
      }
      this.updateStats();
    });
    on('stageopen', (e) => {
      // FPS changes without deltas, so the overlay also refreshes on a timer while a stage is open.
      clearInterval(this.statsTimer);
      this.statsTimer = window.setInterval(() => this.updateStats(), 500);
      this.loading = true;
      this.framed = false;
      this.viewport.sync.setUpAxis(e.detail.upAxis);
      this.tree.reset().catch(() => {});
    });
    on('stageloaded', () => {
      this.loading = false;
      this.viewport.frame();
    });
    on('stageclose', () => {
      clearInterval(this.statsTimer);
      this.updateStats();
      this.viewport.sync.clear();
      this.viewport.lookThrough(null);
      this.tree.clear();
      this.props.show(null);
    });
    on('selectionchange', async (e) => {
      const { paths, source, active } = e.detail;
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
      if (source === 'viewport' && active) await this.tree.reveal(active);
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
    // Values in the panel are truncated; the clipboard gets the whole thing.
    this.props.attributeValue = (path, name) => this.usd.attribute(path, name);
    this.props.bounds = (path) => this.usd.bounds(path);
    this.props.oncopy = (text) => text.then(copyText).catch(() => {});
    this.props.oncontext = (x, y, choices) =>
      showMenu(this.shadowRoot!, x, y, choices.map((choice) => ({ label: choice.label, action: () => choice.text().then(copyText).catch(() => {}) })));
    this.tree.isLocked = (path) => session.isLocked(path);
    this.tree.changeState = (path) => session.changeState(path);
    this.tree.onlock = (path, locked) => session.setLocked(path, locked);
    // The prim menu: right click in the hierarchy or on the prim in the viewport.
    this.tree.oncontext = this.viewport.oncontext = (path, x, y) => {
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
    const info = path ? await this.usd.prim(path).catch(() => null) : null;
    if (this.active === path) this.props.show(info);
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
