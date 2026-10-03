// <usd-viewer>: the layout around a UsdSession and a Viewport, plus the public API.
// Host pages extend it through the `toolbar`, `left`, `right` and `bottom` slots,
// `viewer.session` and the events mirrored from the session.
import type * as THREE from 'three/webgpu';
import type { LocalFile } from './files.ts';
import { copyText, type MenuItem, showMenu } from './menu.ts';
import { h, Props, usdaText } from './props.ts';
import type { Path, PickResult, StageInfo } from './protocol.ts';
import { ctrlSelect, type OpenOptions, type SchemeOptions, type UsdSessionEventMap, type UsdStageApi, UsdSession } from './session.ts';
import { timeline } from './timeline.ts';
import { toolbar } from './toolbar.ts';
import { SelectTool, type TransformMode, TransformTool } from './tools.ts';
import { Tree } from './tree.ts';
import css from './viewer.css?inline';
import type { DisplayMode } from './scene.ts';
import { type ToneMapping, Viewport } from './viewport.ts';

export type OpenSource = string | URL | File | readonly File[] | readonly LocalFile[] | FileSystemDirectoryHandle;
export type ToolName = 'select' | TransformMode;
export type { OpenOptions, SchemeOptions, UsdStageApi };
export type UsdViewerEventMap = UsdSessionEventMap & { toolchange: Event; displaymodechange: Event };

const sheet = new CSSStyleSheet();
sheet.replaceSync(css);
const MIRRORED: (keyof UsdSessionEventMap)[] = [
  'stageopen', 'stageclose', 'selectionchange', 'timechange', 'playchange', 'primschange', 'lockchange', 'refinechange', 'dirtychange', 'diskchange', 'log', 'error',
];
const TOOL_KEYS: Record<string, ToolName> = { q: 'select', w: 'translate', e: 'rotate', r: 'scale' };

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
  private disposed = false;
  private toolName: ToolName = 'select';
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
    this.tree = new Tree((path) => this.session.usd.children(path));
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

  /** Resolves when no flush is pending, every texture is in, and a frame has been drawn. */
  async idle(): Promise<void> {
    await this.session.idle();
    await this.viewport.sync.settled();
    await this.viewport.nextFrame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    removeEventListener('beforeunload', this.unload);
    this.session.dispose();
    this.viewport.dispose();
  }

  /** The active viewport tool: select, or a transform gizmo (Q W E R). */
  get tool(): ToolName {
    return this.toolName;
  }
  set tool(name: ToolName) {
    if (name === this.toolName) return;
    this.toolName = name;
    const current = this.viewport.tool;
    if (name === 'select') this.viewport.tool = new SelectTool(this.session);
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
  get displayMode(): DisplayMode {
    return this.viewport.sync.displayMode;
  }
  set displayMode(mode: DisplayMode) {
    this.viewport.sync.setDisplayMode(mode);
    this.dispatchEvent(new Event('displaymodechange'));
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
    this.setStatus('');
  }

  private build(): HTMLElement {
    const search = h('input', { type: 'search', placeholder: 'Search prims (type:Mesh name)' }) as HTMLInputElement;
    let searchTimer = 0;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = window.setTimeout(async () => {
        const type = /(?:^|\s)type:(\S+)/.exec(search.value)?.[1] ?? '';
        const text = search.value.replace(/(?:^|\s)type:\S+/, '').trim();
        this.tree.showResults(text || type ? await this.usd.find(text, type) : null);
      }, 200);
    });
    this.props.show(null);
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      if (key === 'f' && !e.ctrlKey) this.frame(this.selection);
      else if (e.ctrlKey && key === 'z') (e.shiftKey ? this.redo() : this.undo());
      else if (e.ctrlKey && key === 'y') this.redo();
      else if (e.ctrlKey && key === 's') this.save().catch(() => {});
      else if (!e.ctrlKey && TOOL_KEYS[key]) this.tool = TOOL_KEYS[key];
      else return;
      e.preventDefault();
    });
    return h(
      'div',
      { className: 'app' },
      toolbar(this, this.viewport),
      h('aside', { className: 'left' }, search, this.tree.element, h('slot', { name: 'left' })),
      h('main', {}, this.canvas, this.status),
      h('aside', { className: 'right' }, this.props.element, h('slot', { name: 'right' })),
      h('footer', { className: 'bottom' }, timeline(this.session), h('slot', { name: 'bottom' })),
    );
  }

  /** Connects the panels to the session and mirrors its events on the element. */
  private wire(): void {
    const session = this.session;
    const on = <K extends keyof UsdSessionEventMap>(type: K, handler: (event: UsdSessionEventMap[K]) => void) =>
      session.addEventListener(type, handler as EventListener);
    for (const type of MIRRORED) {
      on(type, (e) => this.dispatchEvent(new CustomEvent(type, { detail: (e as CustomEvent).detail })));
    }
    on('delta', (e) => this.viewport.sync.apply(e.detail));
    on('stageopen', (e) => {
      this.viewport.sync.setUpAxis(e.detail.upAxis);
      this.tree.reset().then(() => this.viewport.frame());
    });
    on('stageclose', () => {
      this.viewport.sync.clear();
      this.viewport.lookThrough(null);
      this.tree.clear();
      this.props.show(null);
    });
    on('selectionchange', async (e) => {
      const { paths, source, active } = e.detail;
      this.tree.setSelection(paths, active);
      this.viewport.sync.setActive(active);
      if (source === 'viewport' && active) await this.tree.reveal(active);
      this.showProps(active);
    });
    on('primschange', async (e) => {
      await this.tree.invalidate(e.detail.resynced);
      this.showProps(this.active);
    });
    on('lockchange', () => this.tree.redraw());
    on('refinechange', () => {
      this.props.globalRefine = { setting: session.refineLevel, effective: session.effectiveRefineLevel };
    });

    this.tree.onselect = (path, toggle) => (toggle ? ctrlSelect(session, path, 'hierarchy') : session.select([path], 'hierarchy'));
    this.tree.onvisible = (path, visible) => this.usd.setVisible(path, visible).catch(() => {});
    this.tree.onframe = (path) => this.frame([path]);
    this.props.onvariant = (path, set, variant) => this.usd.setVariant(path, set, variant).catch(() => {});
    this.props.onloaded = (path, loaded) => this.usd.setPayloadLoaded(path, loaded).catch(() => {});
    this.props.onnavigate = (path) => this.select(path, { reveal: true });
    this.props.onframe = (path) => this.frame([path]);
    this.props.onrefinement = (path, enabled, level) => this.usd.setRefinement(path, enabled, level).catch(() => {});
    this.props.oncontext = (path, attribute, x, y) => {
      // Values in the panel are truncated; the clipboard gets the whole thing.
      const text = async (form: 'value' | 'name' | 'typed') => {
        const value = usdaText(await this.usd.attribute(path, attribute.name), attribute.typeName);
        return form === 'value' ? value : form === 'name' ? `${attribute.name} = ${value}` : `${attribute.typeName} ${attribute.name} = ${value}`;
      };
      showMenu(this.shadowRoot!, x, y, [
        { label: 'Copy value', action: () => text('value').then(copyText) },
        { label: 'Copy name = value', action: () => text('name').then(copyText) },
        { label: 'Copy type name = value', action: () => text('typed').then(copyText) },
      ]);
    };
    this.tree.isLocked = (path) => session.isLocked(path);
    this.tree.onlock = (path, locked) => session.setLocked(path, locked);
    this.tree.oncontext = (path, x, y) => {
      const locked = session.isLocked(path);
      const items: MenuItem[] = [
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

  private setStatus(text: string): void {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  private fatal(message: string): void {
    this.status.classList.add('fatal');
    this.setStatus(message);
  }
}
