// UsdSession: the headless part of the viewer. Owns the core connection, the
// open stage, selection, time, locks, the command stack and the flush pump.
// Panels, tools and host pages talk to this; nothing here touches the DOM.
import { collectHandle, download, isUsdFile, type LocalFile, rootCandidates } from './files.ts';
import { LiveLink } from './live.ts';
import type { Edit, Json, LayerInfo, LogEntry, Path, PickResult, PrimInfo, PrimSummary, RenderDelta, StageInfo, XformInfo } from './protocol.ts';
import { CoreClient } from './rpc.ts';

export interface OpenOptions {
  /** Root layer path inside a set of files; defaults to the shallowest USD file. */
  root?: string;
  loadPayloads?: boolean;
}
export interface SchemeOptions {
  /** Base URL of a gateway that serves `<gateway>/read?url=<asset url>`. */
  gateway: string;
  /** Value for the Authorization header, asked for before each stage open. */
  getAuth?: () => Promise<string> | string;
}
export type SelectionSource = 'viewport' | 'hierarchy' | 'api';
export interface XformEntry {
  path: Path;
  matrix: number[]; // 16, THREE.Matrix4.elements order
}

/** Stage access for host pages. Namespaced because HTMLElement already owns getAttribute/setAttribute. */
export interface UsdStageApi {
  children(path?: Path): Promise<PrimSummary[]>;
  prim(path: Path, time?: number): Promise<PrimInfo>;
  /** World-space aligned bounds (min xyz, max xyz) of an imageable prim's subtree; null otherwise. */
  bounds(path: Path, time?: number): Promise<number[] | null>;
  attribute(path: Path, name: string, time?: number): Promise<Json>;
  find(text: string, typeName?: string, limit?: number): Promise<Path[]>;
  /** The prim and everything below it, in traversal order (at most `limit`, default 10,000). */
  subtree(path: Path, limit?: number): Promise<Path[]>;
  resolvePick(rid: number, instance: number): Promise<PickResult | null>;
  setVariant(path: Path, variantSet: string, variant: string): Promise<void>;
  setVisible(path: Path, visible: boolean): Promise<void>;
  /** Viewer hiding, written to the session layer (never saved): hide prims, hide everything else, undo both. */
  hide(paths: readonly Path[]): Promise<void>;
  isolate(paths: readonly Path[]): Promise<void>;
  showAll(): Promise<void>;
  /** "Clear edits": the prim and everything below it back to how the stage was opened (undoable). */
  clearPrimEdits(path: Path): Promise<void>;
  setPayloadLoaded(path: Path, loaded: boolean): Promise<void>;
  /** Writes to the stage's edit target; `time` omitted writes the default value. */
  setAttribute(path: Path, name: string, value: Json, time?: number): Promise<void>;
  /** Removes the edit target's opinion (the default value, or the sample at `time`). */
  clearAttribute(path: Path, name: string, time?: number): Promise<void>;
  /** Local, parent and world matrices of a prim that can move; null otherwise. `time` defaults to the current frame. */
  xformInfo(path: Path, time?: number): Promise<XformInfo | null>;
  /** xformInfo for several prims in one call (one transform cache for all of them). */
  xformInfos(paths: readonly Path[], time?: number): Promise<(XformInfo | null)[]>;
  /** Authors a local matrix (16 numbers in THREE.Matrix4.elements order) at the current frame. */
  setXform(path: Path, matrix: ArrayLike<number>, time?: number): Promise<void>;
  /** Several prims in one undoable edit. */
  setXforms(entries: XformEntry[], time?: number): Promise<void>;
  layers(): Promise<LayerInfo[]>;
  /** Where edits go: any layer of the local stack (root, its sublayers, the session layer). */
  setEditTarget(identifier: string): Promise<void>;
  /** A layer as usda text or usdc binary, or the whole stage flattened (any identifier). */
  exportLayer(identifier: string, format: 'usda' | 'usdc' | 'flat'): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Re-reads layers from their files or URLs (all of them when omitted), discarding unsaved edits and the undo history. */
  reload(identifiers?: string[]): Promise<void>;
  /**
   * Live link: replaces a layer's content with usda text or usdc bytes (format sniffed when omitted). `name` is an
   * identifier, a unique trailing path ("scene/geo.usda"), or '' for the root layer; unknown names become in-memory
   * overlays composed on top unless `create` is false. Not undoable.
   */
  importLayer(name: string, data: Uint8Array | string, format?: 'usda' | 'usdc', create?: boolean): Promise<void>;
  /** Global subdivision refinement level; -1 = automatic. */
  setComplexity(level: number): Promise<void>;
  /** Output triangles the automatic level may produce; the viewer sets it from the hardware. */
  setRefineBudget(triangles: number): Promise<void>;
  /** Omniverse-style per-prim override (refinementEnableOverride + refinementLevel on the mesh). */
  setRefinement(path: Path, enabled: boolean, level: number): Promise<void>;
  clearRefinement(path: Path): Promise<void>;
  clearRefinementOverrides(): Promise<void>;
  /** usda text of a prim and its children: fully composed, or only what the edit layer authors. */
  exportPrim(path: Path, mode?: 'composed' | 'authored'): Promise<string>;
  /** Clears the session layer (viewer-only edits made while it was the edit target). */
  clearEdits(): Promise<void>;
}

/** An undoable action. `do` runs when the command is first run and on redo. */
export interface Command {
  label: string;
  do(): void | Promise<void>;
  undo(): void | Promise<void>;
}

/** Linear undo/redo stack. ponytail: unbounded, no coalescing; add both when a tool needs them. */
export class History extends EventTarget {
  private done: Command[] = [];
  private undone: Command[] = [];
  get canUndo(): boolean {
    return this.done.length > 0;
  }
  get canRedo(): boolean {
    return this.undone.length > 0;
  }
  async run(command: Command): Promise<void> {
    await command.do();
    this.done.push(command);
    this.undone = [];
    this.dispatchEvent(new Event('change'));
  }
  async undo(): Promise<void> {
    const command = this.done.pop();
    if (!command) return;
    await command.undo();
    this.undone.push(command);
    this.dispatchEvent(new Event('change'));
  }
  async redo(): Promise<void> {
    const command = this.undone.pop();
    if (!command) return;
    await command.do();
    this.done.push(command);
    this.dispatchEvent(new Event('change'));
  }
  /** Records a command that already ran (a drag that wrote as it went). */
  push(command: Command): void {
    this.done.push(command);
    this.undone = [];
    this.dispatchEvent(new Event('change'));
  }
  clear(): void {
    this.done = [];
    this.undone = [];
    this.dispatchEvent(new Event('change'));
  }
}

export interface UsdSessionEventMap {
  stageopen: CustomEvent<StageInfo>;
  /** The first flush after stageopen is complete: every prim of the stage has been sent once. */
  stageloaded: Event;
  stageclose: Event;
  selectionchange: CustomEvent<{ paths: Path[]; source: SelectionSource; active: Path | null }>;
  timechange: CustomEvent<{ time: number }>;
  playchange: Event;
  /** `visibility`: the edit changed visibility, which no resync reports; `touched`: every prim it changed. */
  primschange: CustomEvent<{ resynced: Path[]; touched?: Path[]; visibility?: boolean }>;
  /** Prims were edited for the first time since the stage was opened (see `changed`). */
  changedprims: Event;
  /** Every render delta the core produced, in order; the viewport applies them. */
  delta: CustomEvent<RenderDelta>;
  lockchange: CustomEvent<{ path: Path; locked: boolean }>;
  refinechange: CustomEvent<{ level: number }>;
  /** The set of layers with unsaved edits changed. */
  dirtychange: CustomEvent<{ dirty: string[] }>;
  /** Layers were re-read because their files changed on disk. */
  diskchange: CustomEvent<{ identifiers: string[] }>;
  /** A live-link push replaced a layer (see `live`). */
  livechange: CustomEvent<{ name: string }>;
  log: CustomEvent<LogEntry>;
  error: CustomEvent<LogEntry>;
}

export class UsdSession extends EventTarget {
  readonly core: CoreClient;
  readonly ready: Promise<{ usd: string; threads: number }>;
  stage: StageInfo | null = null;
  readonly log: LogEntry[] = [];
  readonly commands = new History();
  /** Prims (and their subtrees) that tools must not select or edit. Editor state only, never saved. */
  readonly locked = new Set<Path>();
  /** Global refinement level: 0 like usdview and Omniverse; -1 = automatic from a triangle budget. */
  refineLevel = 0;
  /** The level the core resolved the global setting to. */
  effectiveRefineLevel = 0;
  /** Identifiers of layers with unsaved edits. */
  readonly dirty = new Set<string>();
  /** Prims whose specs differ from the stage as opened or reloaded (saving keeps them; undo or Clear edits removes them). Viewer hiding does not count. */
  readonly changed = new Set<Path>();
  /** Live link to a relay: other programs push layers in, the viewer's edits go out (web/src/live.ts). */
  readonly live = new LiveLink(this);
  private changedBelow = new Set<Path>(); // ancestors of changed prims
  /** Edits below are undoable: the core reports what each one replaced, and the inverse re-authors it. */
  readonly usd: UsdStageApi = {
    children: (path = '/') => this.core.call('primChildren', path),
    prim: (path, time = this.currentTime) => this.core.call('primDetails', path, time),
    bounds: (path, time = this.currentTime) => this.core.call('primBounds', path, time),
    attribute: (path, name, time = this.currentTime) => this.core.call('attributeValue', path, name, time),
    find: (text, typeName = '', limit = 500) => this.core.call('findPrims', text, typeName, limit),
    subtree: (path, limit = SUBTREE_LIMIT) => this.core.call('primSubtree', path, limit),
    resolvePick: (rid, instance) => this.core.call('resolvePick', rid, instance),
    setVariant: (path, set, variant) =>
      this.recorded(
        () => this.core.call('setVariant', path, set, variant),
        (previous) => this.core.call('setVariant', path, set, typeof previous === 'string' ? previous : ''),
      ),
    setVisible: (path, visible) =>
      this.recorded(
        () => this.core.call('setVisible', path, visible),
        (previous) => this.restore(path, 'visibility', previous, NaN),
        true,
      ),
    hide: (paths) => this.sessionVisibility('hide', paths),
    isolate: (paths) => this.sessionVisibility('isolate', paths),
    showAll: () => this.sessionVisibility('showAll', []),
    clearPrimEdits: (path) =>
      this.recorded(
        () => this.core.call('revertPrim', path),
        (previous) => this.core.call('restorePrim', previous as number),
      ),
    setPayloadLoaded: (path, loaded) =>
      this.recorded(
        () => this.core.call('setLoaded', path, loaded),
        () => this.core.call('setLoaded', path, !loaded),
      ),
    setAttribute: (path, name, value, time = NaN) =>
      this.recorded(
        () => this.core.call('setAttribute', path, name, JSON.stringify(value), time),
        (previous) => this.restore(path, name, previous, time),
        name === 'visibility',
      ),
    clearAttribute: (path, name, time = NaN) =>
      this.recorded(
        () => this.core.call('clearAttribute', path, name, time),
        (previous) => (previous === undefined ? null : this.restore(path, name, previous, time)),
        name === 'visibility',
      ),
    xformInfo: (path, time = this.currentTime) => this.core.call('xformInfo', path, time),
    xformInfos: (paths, time = this.currentTime) => this.core.call('xformInfos', JSON.stringify(paths), time),
    setXform: (path, matrix, time = this.currentTime) =>
      this.recorded(
        () => this.core.call('setXform', path, [...(matrix as number[])], time),
        (previous) => this.core.call('setXform', path, previous as number[], time),
      ),
    setXforms: (entries, time = this.currentTime) =>
      this.recorded(
        () => this.core.call('setXforms', JSON.stringify(entries), time),
        (previous) => {
          const matrices = previous as number[][];
          return this.core.call('setXforms', JSON.stringify(entries.map((e, i) => ({ path: e.path, matrix: matrices[i] }))), time);
        },
      ),
    setComplexity: async (level) => {
      this.refineLevel = level;
      this.core.call('setRefineLevel', level);
      this.emit('refinechange', { level });
      await this.flush();
    },
    setRefineBudget: async (triangles) => {
      this.core.call('setRefineBudget', triangles);
      await this.flush();
    },
    setRefinement: (path, enabled, level) =>
      this.recorded(
        () => this.core.call('setRefinement', path, enabled, level),
        (previous) => this.restoreRefinement(path, previous),
      ),
    clearRefinement: (path) =>
      this.recorded(
        () => this.core.call('clearRefinement', path),
        (previous) => this.restoreRefinement(path, previous),
      ),
    clearRefinementOverrides: () => this.edit(this.core.call('clearRefinementOverrides')).then(() => undefined), // ponytail: not undoable
    exportPrim: (path, mode = 'composed') => this.core.call('exportPrim', path, mode),
    layers: () => this.core.call('listLayers'),
    setEditTarget: (identifier) => this.edit(this.core.call('setEditTarget', identifier)).then(() => undefined),
    exportLayer: (identifier, format) => this.core.call('exportLayer', identifier, format),
    reload: async (identifiers = []) => {
      await this.edit(this.core.call('reloadLayers', identifiers));
      this.commands.clear();
      this.resetChanges();
    },
    importLayer: async (name, data, format, create = true) => {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      format ??= new TextDecoder().decode(bytes.subarray(0, 8)) === 'PXR-USDC' ? 'usdc' : 'usda';
      await this.edit(this.core.call('importLayer', name, bytes, format, create));
      this.commands.clear(); // ponytail: not undoable, the replaced content is gone (like reload)
    },
    clearEdits: async () => {
      await this.edit(this.core.call('clearSessionEdits'));
      this.commands.clear();
    },
  };

  private selected: Path[] = [];
  private activePath: Path | null = null;
  private currentTime = NaN;
  private wantedTime: number | undefined;
  private needFlush = false;
  private pumping: Promise<void> | null = null;
  private playStart = 0;
  private playFrom = 0;
  private playRequest = 0;
  private disposed = false;
  private readonly drops = new Map<string, Map<string, File>>();
  private readonly schemes = new Map<string, SchemeOptions>();
  /** Write-back handles of a picked folder, by layer identifier (/drop/<n>/<path>). */
  private readonly handles = new Map<string, FileSystemFileHandle>();
  private readonly seen = new Map<string, number>(); // lastModified per watched file
  private watchTimer = 0;
  private checking = false;
  private warnedDisk = false;

  constructor(coreUrl: URL | string, makeWorker?: (url: URL) => Worker) {
    super();
    this.core = new CoreClient(coreUrl, makeWorker);
    this.core.onlog = (entry) => this.report(entry.level, entry.message);
    this.ready = this.core.ready;
  }

  /* ---------- stage ---------- */

  /** Opens a URL (absolute), a set of local files, or a picked folder (which can then be saved into). */
  async open(source: string | readonly LocalFile[] | FileSystemDirectoryHandle, options: OpenOptions = {}): Promise<StageInfo> {
    await this.ready;
    await this.close();
    let url: string;
    if (typeof source === 'string') url = source;
    else {
      let files: LocalFile[];
      let handles = new Map<string, FileSystemFileHandle>();
      if ('kind' in source) ({ files, handles } = await collectHandle(source));
      else files = [...source];
      const root = options.root ?? rootCandidates(files)[0];
      if (!root) throw new Error('No USD file found in the selection.');
      const dir = await this.core.call('mount', files);
      this.drops.set(dir, new Map(files.map((f) => [f.path, f.file])));
      for (const [path, handle] of handles) {
        if (!isUsdFile(path)) continue; // ponytail: textures are not watched or written
        this.handles.set(`${dir}/${path}`, handle);
        this.seen.set(`${dir}/${path}`, (await handle.getFile()).lastModified);
      }
      url = `${dir}/${root}`;
    }
    for (const [scheme, options] of this.schemes) {
      this.core.call('registerScheme', scheme, options.gateway, (await options.getAuth?.()) ?? '');
    }
    const logged = this.log.length;
    const info = await this.core.call('openStage', url, options.loadPayloads ?? true);
    if (!info.ok) throw new Error(info.error ?? 'could not open stage');
    // The browser only hands over the files the user picked, never their siblings.
    if (this.log.slice(logged).some((entry) => entry.message.includes('Could not open asset @/drop/'))) {
      this.report('error', 'Referenced files are missing: the browser only sees the files you picked. Use "Folder…" or drop the whole folder that contains the USD file.');
    }
    this.stage = info;
    this.emit('stageopen', info);
    await this.flush(info.hasTimeRange ? info.startTimeCode : NaN);
    if (this.stage === info) this.dispatchEvent(new Event('stageloaded'));
    if (this.handles.size) this.watchTimer = window.setInterval(() => this.checkDisk(), 2000);
    return info;
  }

  async close(): Promise<void> {
    if (!this.stage) return;
    this.pause();
    clearInterval(this.watchTimer);
    this.stage = null;
    this.selected = [];
    this.activePath = null;
    this.locked.clear();
    this.commands.clear();
    this.setChanged([]);
    await this.core.call('closeStage');
    this.drops.clear();
    this.handles.clear();
    this.seen.clear();
    this.warnedDisk = false;
    this.setDirty([]);
    this.dispatchEvent(new Event('stageclose'));
  }

  /* ---------- saving and watching ---------- */

  /** True when a folder was picked with write access, so Save overwrites the files. */
  get canWriteBack(): boolean {
    return this.handles.size > 0;
  }

  /**
   * Writes every layer with unsaved edits: into the picked folder when there is one, else as a
   * download. The in-memory layer is then re-read from what was written, which marks it clean.
   * Returns the identifiers saved.
   */
  async save(): Promise<string[]> {
    const saved: string[] = [];
    for (const layer of await this.usd.layers()) {
      if (!layer.dirty || layer.anonymous) continue;
      if (layer.format === 'usdz') {
        this.report('warn', `${layer.displayName}: members of a usdz package cannot be written back; use "Download flattened".`);
        continue;
      }
      const format = layer.format === 'usdc' ? 'usdc' : 'usda';
      const bytes = await this.usd.exportLayer(layer.identifier, format);
      if (!bytes) continue;
      const handle = this.handles.get(layer.identifier);
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        this.seen.set(layer.identifier, (await handle.getFile()).lastModified);
      } else download(layer.displayName, bytes);
      const drop = /^(\/drop\/\d+)\/(.*)$/.exec(layer.identifier);
      const files = drop ? this.drops.get(drop[1]) : undefined;
      if (drop && files) {
        files.set(drop[2], new File([bytes], drop[2].split('/').pop()!));
        await this.core.call('remount', drop[1], [...files].map(([path, file]) => ({ path, file })));
        await this.edit(this.core.call('reloadLayers', [layer.identifier])); // saving keeps the markers: the baseline stays
      }
      saved.push(layer.identifier);
    }
    return saved;
  }

  /** Re-reads layers whose files changed on disk; with unsaved edits it only warns. */
  private async checkDisk(): Promise<void> {
    if (this.checking || !this.stage) return;
    this.checking = true;
    try {
      const changed: string[] = [];
      for (const [identifier, handle] of this.handles) {
        const file = await handle.getFile();
        if (this.seen.get(identifier) === file.lastModified) continue;
        this.seen.set(identifier, file.lastModified);
        changed.push(identifier);
        const drop = /^(\/drop\/\d+)\/(.*)$/.exec(identifier)!;
        this.drops.get(drop[1])?.set(drop[2], file);
      }
      if (!changed.length) return;
      if (this.dirty.size) {
        if (!this.warnedDisk) this.report('warn', `Changed on disk while you have unsaved edits: ${changed.join(', ')}. Save overwrites the files; Reload takes the disk version.`);
        this.warnedDisk = true;
        return;
      }
      for (const dir of new Set(changed.map((id) => id.replace(/^(\/drop\/\d+)\/.*$/, '$1')))) {
        const files = this.drops.get(dir);
        if (files) await this.core.call('remount', dir, [...files].map(([path, file]) => ({ path, file })));
      }
      await this.edit(this.core.call('reloadLayers', changed));
      this.commands.clear();
      this.resetChanges();
      this.emit('diskchange', { identifiers: changed });
    } catch (error: any) {
      this.report('error', error.message);
    } finally {
      this.checking = false;
    }
  }

  /** Resolves when no flush is pending. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.live.disconnect();
    this.core.dispose();
  }

  /** Routes a URL scheme (for example `omniverse`) through an HTTP gateway. */
  registerScheme(scheme: string, options: SchemeOptions): void {
    this.schemes.set(scheme, options);
  }

  /* ---------- selection and locks ---------- */

  get selection(): readonly Path[] {
    return this.selected;
  }

  /** The prim the panels show and tools act on: the last one selected unless chosen explicitly. */
  get active(): Path | null {
    return this.activePath;
  }

  select(paths: readonly Path[], source: SelectionSource = 'api', active?: Path): void {
    this.selected = [...paths];
    this.activePath = active !== undefined && this.selected.includes(active) ? active : (this.selected.at(-1) ?? null);
    this.core.call('setSelection', this.selected);
    this.flush();
    this.emit('selectionchange', { paths: this.selected, source, active: this.activePath });
  }

  /** True when the prim or one of its ancestors is locked. */
  isLocked(path: Path): boolean {
    for (const locked of this.locked) {
      if (path === locked || path.startsWith(locked === '/' ? '/' : `${locked}/`)) return true;
    }
    return false;
  }

  setLocked(path: Path, locked: boolean): void {
    if (locked) this.locked.add(path);
    else this.locked.delete(path);
    if (locked && this.selected.some((p) => this.isLocked(p))) this.select(this.selected.filter((p) => !this.isLocked(p)));
    this.emit('lockchange', { path, locked });
  }

  /* ---------- time ---------- */

  get time(): number {
    return this.currentTime;
  }
  set time(value: number) {
    this.currentTime = value;
    this.flush(value);
    this.emit('timechange', { time: value });
  }

  /** Playback wraps around at the end; off: it stops on the last frame. */
  loop = true;

  get playing(): boolean {
    return this.playRequest !== 0;
  }
  play(): void {
    const stage = this.stage;
    if (!stage?.hasTimeRange || this.playing) return;
    this.playStart = performance.now();
    this.playFrom = Number.isNaN(this.currentTime) || this.currentTime >= stage.endTimeCode ? stage.startTimeCode : this.currentTime;
    const tick = () => {
      // Time follows the wall clock, so slow frames are dropped instead of queued.
      const span = stage.endTimeCode - stage.startTimeCode;
      const elapsed = ((performance.now() - this.playStart) / 1000) * stage.timeCodesPerSecond;
      const offset = this.playFrom - stage.startTimeCode + elapsed;
      if (!this.loop && offset >= span) {
        this.time = stage.endTimeCode;
        this.pause();
        return;
      }
      this.time = stage.startTimeCode + (offset % (span || 1));
      this.playRequest = requestAnimationFrame(tick);
    };
    this.playRequest = requestAnimationFrame(tick);
    this.dispatchEvent(new Event('playchange'));
  }
  pause(): void {
    if (!this.playRequest) return;
    cancelAnimationFrame(this.playRequest);
    this.playRequest = 0;
    this.dispatchEvent(new Event('playchange'));
  }

  /* ---------- core traffic ---------- */

  /**
   * Runs flushes one at a time; the latest requested time wins. Deltas go out as `delta` events.
   * A flush arrives in pages: a small first one for a quick first picture, then larger ones that
   * still leave room for other calls in between. One page is requested ahead of the one being
   * applied, so the core converts while the page uploads.
   */
  flush(time?: number): Promise<void> {
    if (time !== undefined) this.wantedTime = time;
    this.needFlush = true;
    this.pumping ??= (async () => {
      let next: Promise<RenderDelta> | null = null;
      const apply = (delta: RenderDelta) => {
        if (delta.refineLevel !== undefined && delta.refineLevel !== this.effectiveRefineLevel) {
          this.effectiveRefineLevel = delta.refineLevel;
          this.emit('refinechange', { level: this.refineLevel });
        }
        this.emit('delta', delta);
      };
      try {
        while (this.needFlush && !this.disposed) {
          this.needFlush = false;
          if (this.wantedTime !== undefined) {
            this.currentTime = this.wantedTime;
            this.core.call('setTime', this.wantedTime);
            this.wantedTime = undefined;
          }
          let page = 0;
          next = this.core.call('flush', FLUSH_PAGES[0]);
          while (next) {
            const delta: RenderDelta = await next;
            page++;
            next = delta.more && !this.disposed ? this.core.call('flush', FLUSH_PAGES[Math.min(page, FLUSH_PAGES.length - 1)]) : null;
            next?.catch(() => {}); // a listener throwing below must not leave it unhandled
            apply(delta);
          }
        }
      } catch (error: any) {
        this.report('error', error.message);
        // The core has already dropped the prefetched page's prims from its dirty set: deliver it.
        if (next) await next.then(apply).catch(() => {});
      } finally {
        this.pumping = null;
      }
    })();
    return this.pumping;
  }

  /**
   * Awaits an edit, fails on error, flushes, and tells listeners which prims resynced. Not
   * undoable by itself; `quiet` skips the primschange event (a drag emits one at its end).
   */
  async edit(call: Promise<Edit>, options: { quiet?: boolean; visibility?: boolean } = {}): Promise<Edit> {
    const result = await call;
    if (!result.ok) throw new Error(result.error ?? 'edit failed');
    this.setDirty(result.dirty ?? []);
    if (result.changed) this.setChanged(result.changed);
    await this.flush();
    if (!options.quiet) this.emit('primschange', { resynced: result.resynced, touched: result.touched ?? [], visibility: options.visibility });
    return result;
  }

  /** Runs an edit as an undoable command; `inverse` builds the undo call from what the edit replaced. */
  private recorded(
    forward: () => Promise<Edit>,
    inverse: (previous: Json | undefined) => Promise<Edit> | null,
    visibility = false,
  ): Promise<void> {
    let previous: Json | undefined;
    let first = true;
    return this.commands.run({
      label: 'edit',
      do: async () => {
        const result = await this.edit(forward(), { visibility });
        if (first) previous = result.previous;
        first = false;
      },
      undo: async () => {
        const call = inverse(previous);
        if (call) await this.edit(call, { visibility });
      },
    });
  }

  private sessionVisibility(mode: 'hide' | 'isolate' | 'showAll', paths: readonly Path[]): Promise<void> {
    return this.recorded(
      () => this.core.call('sessionVisibility', mode, JSON.stringify(paths)),
      (previous) => this.core.call('sessionVisibility', 'set', JSON.stringify(previous ?? {})),
      true,
    );
  }

  /** Whether a prim was edited in this session ('self'), or something below it was ('below'). */
  changeState(path: Path): 'self' | 'below' | null {
    return this.changed.has(path) ? 'self' : this.changedBelow.has(path) ? 'below' : null;
  }

  /** The core reports the full list after every edit: prims that differ from the stage as opened. */
  private setChanged(paths: readonly Path[]): void {
    const next = paths.filter((p) => p !== '/');
    if (next.length === this.changed.size && next.every((p) => this.changed.has(p))) return;
    this.changed.clear();
    this.changedBelow.clear();
    for (const path of next) {
      this.changed.add(path);
      for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) this.changedBelow.add(path.slice(0, i));
    }
    this.dispatchEvent(new Event('changedprims'));
  }

  /** After a reload: what is loaded now is the new "as opened" state. */
  private resetChanges(): void {
    this.core.call('resetChanges');
    this.setChanged([]);
  }

  /** Puts an attribute back to an earlier opinion, or removes the opinion when there was none. */
  private restore(path: Path, name: string, previous: Json | undefined, time: number): Promise<Edit> {
    return previous === undefined
      ? this.core.call('clearAttribute', path, name, time)
      : this.core.call('setAttribute', path, name, JSON.stringify(previous), time);
  }

  private restoreRefinement(path: Path, previous: Json | undefined): Promise<Edit> {
    const before = previous as { enabled: boolean; level: number } | null | undefined;
    return before ? this.core.call('setRefinement', path, before.enabled, before.level) : this.core.call('clearRefinement', path);
  }

  private setDirty(identifiers: string[]): void {
    if (identifiers.length === this.dirty.size && identifiers.every((id) => this.dirty.has(id))) return;
    this.dirty.clear();
    for (const id of identifiers) this.dirty.add(id);
    this.emit('dirtychange', { dirty: identifiers });
  }

  /** Bytes of a resolved asset path, for textures. */
  async readBytes(resolved: string): Promise<ArrayBuffer | Blob | null> {
    if (!resolved.includes('[')) {
      const drop = /^(\/drop\/\d+)\/(.*)$/.exec(resolved);
      if (drop) return this.drops.get(drop[1])?.get(drop[2]) ?? null;
      if (/^https?:/.test(resolved)) {
        const response = await fetch(resolved);
        return response.ok ? response.blob() : null;
      }
    }
    // Package members (file.usdz[texture.png]) and gateway schemes go through the core's resolver.
    const bytes = await this.core.call('readAsset', resolved);
    return bytes ? (bytes.buffer as ArrayBuffer) : null;
  }

  report(level: LogEntry['level'], message: string): void {
    this.log.push({ level, message });
    this.emit(level === 'error' ? 'error' : 'log', { level, message });
  }

  /** Dispatches a session event; modules use it for events they own (a tool's final primschange). */
  emit(type: keyof UsdSessionEventMap, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

/** Geometry prims per flush page: the first page is small so the first picture is quick. */
const FLUSH_PAGES = [128, 512, 1000];

/** add: Shift; remove: Ctrl; up: Shift+Ctrl adds the nearest ancestor that is not selected yet. */
export type SelectMode = 'replace' | 'add' | 'remove' | 'up';

/** Shift+Alt selects at most this many prims of a subtree. */
export const SUBTREE_LIMIT = 10000;

/** True when `set` holds an ancestor of `path` (the pseudo-root counts). Linear in the depth, not in the set. */
export function hasAncestorIn(path: Path, set: ReadonlySet<Path>): boolean {
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) if (set.has(path.slice(0, i))) return true;
  return set.has('/') && path !== '/';
}

/** The nearest ancestor of `path` (below the pseudo-root) not in `selected`; undefined when all are. */
function unselectedAncestor(path: Path, selected: ReadonlySet<Path>): Path | undefined {
  for (let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    if (!selected.has(path.slice(0, i))) return path.slice(0, i);
  }
  return undefined;
}

/**
 * Shift (add) and Ctrl (remove) selection. Adding makes the last given path active, so Shift-click
 * on an already selected prim only activates it; removing keeps the active prim when it stays.
 */
export function modifySelect(session: UsdSession, paths: readonly Path[], mode: SelectMode, source: SelectionSource): void {
  const current = session.selection;
  if (mode === 'up') {
    const path = paths.at(-1);
    if (!path) return;
    const up = unselectedAncestor(path, new Set([...current, path]));
    modifySelect(session, up ? [path, up] : [path], 'add', source);
  } else if (mode === 'replace') session.select(paths, source);
  else if (mode === 'add') {
    // Sets, not Array.includes: Shift+Alt can add thousands of prims at once.
    const have = new Set(current);
    const added = paths.filter((p) => !have.has(p) && (have.add(p), true));
    session.select([...current, ...added], source, paths.at(-1) ?? session.active ?? undefined);
  } else {
    const drop = new Set(paths);
    const kept = current.filter((p) => !drop.has(p));
    session.select(kept, source, session.active && !drop.has(session.active) ? session.active : undefined);
  }
}

/**
 * Shift+Alt: like Shift+Ctrl it climbs to the nearest ancestor not selected yet (one level per
 * click), but adds that ancestor's whole subtree, which becomes the active prim. Once every
 * ancestor is selected, the top-level ancestor's subtree is taken again.
 */
export async function selectUpWithSubtree(session: UsdSession, path: Path, source: SelectionSource): Promise<void> {
  const second = path.indexOf('/', 1);
  const topLevel = second > 0 ? path.slice(0, second) : path;
  const target = unselectedAncestor(path, new Set([...session.selection, path])) ?? topLevel;
  const subtree = await session.usd.subtree(target);
  if (subtree.length >= SUBTREE_LIMIT) session.report('warn', `Selected the first ${SUBTREE_LIMIT.toLocaleString('en')} prims below ${target}.`);
  modifySelect(session, [path, ...subtree.filter((p) => p !== target), target], 'add', source);
}
