// Viewport tools: exactly one is active at a time and owns the pointer events on the canvas.
import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Path, XformInfo } from './protocol.ts';
import type { UsdSession, XformEntry } from './session.ts';
import { modifySelect, type SelectMode } from './session.ts';
import type { Viewport } from './viewport.ts';

export interface Tool {
  activate(viewport: Viewport): void;
  deactivate(): void;
}

/**
 * A click that did not drag selects what is under the pointer; Shift adds, Ctrl removes. With
 * Shift or Ctrl a drag draws a rectangle instead of orbiting: dragged upward it takes what it
 * touches, dragged downward only what lies fully inside.
 */
export class SelectTool implements Tool {
  protected readonly session: UsdSession;
  private abort: AbortController | null = null;

  constructor(session: UsdSession) {
    this.session = session;
  }

  activate(viewport: Viewport): void {
    this.abort = new AbortController();
    const { signal } = this.abort;
    const canvas = viewport.canvas;
    let down: { x: number; y: number; mode: SelectMode; orbit: boolean } | null = null;
    let box: HTMLElement | null = null;
    const rect = (from: { x: number; y: number }, e: PointerEvent) => ({
      left: Math.min(from.x, e.clientX),
      top: Math.min(from.y, e.clientY),
      right: Math.max(from.x, e.clientX),
      bottom: Math.max(from.y, e.clientY),
    });
    // Capture phase: runs before OrbitControls' own pointerdown on the canvas, so it can stop the pan.
    canvas.addEventListener(
      'pointerdown',
      (e) => {
        down = null;
        if (e.button !== 0 || this.grabbed()) return;
        const mode: SelectMode = (e.shiftKey && (e.ctrlKey || e.metaKey) ? 'up' : e.shiftKey ? 'add' : e.ctrlKey || e.metaKey ? 'remove' : 'replace');
        down = { x: e.clientX, y: e.clientY, mode, orbit: viewport.controls.enabled };
        if (mode !== 'replace') {
          viewport.controls.enabled = false;
          canvas.setPointerCapture(e.pointerId);
        }
      },
      { signal, capture: true },
    );
    // Right click without a drag (a right drag pans): the prim menu for what is under the pointer.
    let rightDown: [number, number] | null = null;
    canvas.addEventListener('pointerdown', (e) => (rightDown = e.button === 2 ? [e.clientX, e.clientY] : null), { signal });
    canvas.addEventListener(
      'contextmenu',
      async (e) => {
        const start = rightDown;
        rightDown = null;
        if (!start || Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 4) return;
        e.preventDefault();
        const hit = viewport.pick(e.clientX, e.clientY);
        const result = hit ? await this.session.usd.resolvePick(hit.rid, hit.instance) : null;
        if (result) viewport.oncontext(result.path, e.clientX, e.clientY);
      },
      { signal },
    );
    canvas.addEventListener(
      'pointermove',
      (e) => {
        if (!down || down.mode === 'replace' || (!box && Math.hypot(e.clientX - down.x, e.clientY - down.y) <= 4)) return;
        box ??= canvas.parentElement!.appendChild(Object.assign(document.createElement('div'), { className: 'marquee' }));
        const r = rect(down, e);
        const origin = canvas.getBoundingClientRect();
        Object.assign(box.style, {
          left: `${r.left - origin.left}px`,
          top: `${r.top - origin.top}px`,
          width: `${r.right - r.left}px`,
          height: `${r.bottom - r.top}px`,
        });
        box.classList.toggle('touch', e.clientY < down.y);
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerup',
      async (e) => {
        const start = down;
        down = null;
        if (!start || e.button !== 0) return;
        if (start.mode !== 'replace') viewport.controls.enabled = start.orbit;
        const marquee = box !== null;
        box?.remove();
        box = null;
        let hits: { rid: number; instance: number }[];
        if (marquee) hits = viewport.boxPick(rect(start, e), e.clientY > start.y);
        else if (Math.hypot(e.clientX - start.x, e.clientY - start.y) <= 4) {
          const hit = viewport.pick(e.clientX, e.clientY);
          hits = hit ? [hit] : [];
        } else return; // an orbit drag
        const results = await Promise.all(hits.map((hit) => this.session.usd.resolvePick(hit.rid, hit.instance)));
        const paths = [...new Set(results.flatMap((r) => (r && !this.session.isLocked(r.path) ? [r.path] : [])))];
        modifySelect(this.session, paths, marquee && start.mode === 'up' ? 'add' : start.mode, 'viewport');
      },
      { signal },
    );
  }

  deactivate(): void {
    this.abort?.abort();
    this.abort = null;
  }

  /** True when something else (a gizmo handle) took the pointer down. */
  protected grabbed(): boolean {
    return false;
  }
}

export type TransformMode = 'translate' | 'rotate' | 'scale';

/** A prim being dragged: where it started, and how to turn a world delta into its local matrix. */
interface Target {
  path: Path;
  local: number[];
  world: THREE.Matrix4;
  parentInverse: THREE.Matrix4;
}

/**
 * Moves the selected prims with a gizmo placed at the active one. The gizmo drags a geometry-less
 * proxy; each step applies the proxy's world delta to every target (so rotation and scale happen
 * about the active prim), the page previews the move at once, and the resulting local matrices
 * are written to the stage with one write in flight. One undo entry per drag.
 */
export class TransformTool extends SelectTool {
  mode: TransformMode;
  private controls: TransformControls | null = null;
  private viewport: Viewport | null = null;
  private readonly proxy = new THREE.Object3D();
  private readonly proxyStart = new THREE.Matrix4();
  private infos: XformInfo[] = [];
  private anchor: XformInfo | null = null;
  private targets: Target[] = [];
  private dragging = false;
  private last: XformEntry[] | null = null;
  private pending: XformEntry[] | null = null;
  private inflight: Promise<void> | null = null;
  private listeners: AbortController | null = null;
  private readonly follow = () => {
    if (this.controls && this.viewport) this.controls.camera = this.viewport.camera;
  };

  constructor(session: UsdSession, mode: TransformMode) {
    super(session);
    this.mode = mode;
  }

  setMode(mode: TransformMode): void {
    this.mode = mode;
    this.controls?.setMode(mode);
  }

  activate(viewport: Viewport): void {
    // The gizmo's pointer listeners go first, so a pointer down on a handle is seen as grabbed by the pick.
    const controls = new TransformControls(viewport.camera, viewport.canvas);
    this.controls = controls;
    super.activate(viewport);
    this.viewport = viewport;
    controls.setMode(this.mode);
    controls.setSpace('world');
    viewport.scene.add(controls.getHelper());
    viewport.sync.root.add(this.proxy);
    viewport.beforeRender.add(this.follow);
    controls.addEventListener('change', () => viewport.invalidate());
    controls.addEventListener('dragging-changed', (e) => (viewport.controls.enabled = !e.value && viewport.cameraPath === null));
    controls.addEventListener('mouseDown', () => this.grab());
    controls.addEventListener('objectChange', () => this.moved());
    controls.addEventListener('mouseUp', () => this.release());
    this.listeners = new AbortController();
    const { signal } = this.listeners;
    for (const type of ['selectionchange', 'lockchange', 'primschange', 'timechange'] as const) {
      this.session.addEventListener(type, () => !this.dragging && this.retarget(), { signal });
    }
    this.retarget();
  }

  deactivate(): void {
    super.deactivate();
    this.listeners?.abort();
    this.listeners = null;
    if (this.controls && this.viewport) {
      this.controls.detach();
      this.controls.getHelper().removeFromParent();
      this.controls.dispose();
      this.viewport.beforeRender.delete(this.follow);
      this.viewport.controls.enabled = this.viewport.cameraPath === null;
      this.viewport.invalidate();
    }
    this.proxy.removeFromParent();
    this.controls = null;
    this.viewport = null;
    this.infos = [];
    this.anchor = null;
  }

  protected override grabbed(): boolean {
    // The selection listener runs before the gizmo's own pointerdown, so a hovered handle counts too.
    return !!this.controls?.dragging || this.controls?.axis != null;
  }

  /** Re-reads the selected prims that can move and puts the gizmo on the active one. */
  private async retarget(): Promise<void> {
    const session = this.session;
    const chosen = session.selection.filter((p) => !session.isLocked(p));
    // A prim moves with its selected ancestor; moving both would apply the offset twice.
    const roots = chosen.filter((p) => !chosen.some((q) => q !== p && p.startsWith(q === '/' ? '/' : `${q}/`)));
    const infos = (await Promise.all(roots.map((p) => session.usd.xformInfo(p)))).filter((i): i is XformInfo => i !== null);
    if (this.dragging) return; // a drag started meanwhile; it keeps its targets
    // Two selected paths can resolve to one editable prim (instance proxies): keep the first.
    this.infos = infos.filter((info, i) => infos.findIndex((o) => o.path === info.path) === i);
    const active = session.active;
    this.anchor = (active && this.infos.find((i) => active === i.path || active.startsWith(`${i.path}/`))) || this.infos[0] || null;
    if (!this.controls) return;
    if (this.anchor) {
      this.proxy.matrix.fromArray(this.anchor.world);
      this.proxy.matrix.decompose(this.proxy.position, this.proxy.quaternion, this.proxy.scale);
      this.controls.attach(this.proxy);
    } else this.controls.detach();
    this.viewport?.invalidate();
  }

  private grab(): void {
    this.dragging = true;
    this.proxy.updateMatrix();
    this.proxyStart.copy(this.proxy.matrix);
    this.targets = this.infos.map((info) => ({
      path: info.path,
      local: [...info.local],
      world: new THREE.Matrix4().fromArray(info.world),
      parentInverse: new THREE.Matrix4().fromArray(info.parent).invert(),
    }));
    this.last = null;
    this.viewport?.sync.beginPreview(this.targets.map((t) => t.path));
  }

  /** World delta of the proxy since the grab, applied to every target: local = parent⁻¹ · delta · world. */
  private moved(): void {
    if (!this.dragging || !this.targets.length) return;
    this.proxy.updateMatrix();
    const delta = new THREE.Matrix4().multiplyMatrices(this.proxy.matrix, this.proxyStart.clone().invert());
    this.viewport?.sync.previewDelta(delta);
    const moved = new THREE.Matrix4();
    this.pending = this.targets.map((t) => {
      moved.multiplyMatrices(delta, t.world).premultiply(t.parentInverse);
      return { path: t.path, matrix: [...moved.elements] };
    });
    this.pump();
  }

  /** At most one write in flight; the newest matrices win. */
  private pump(): void {
    if (this.inflight || !this.pending) return;
    const entries = this.pending;
    this.pending = null;
    this.last = entries;
    this.inflight = this.session
      .edit(this.session.core.call('setXforms', JSON.stringify(entries), this.session.time), { quiet: true })
      .then(() => undefined, (error: Error) => this.session.report('error', error.message))
      .finally(() => {
        this.inflight = null;
        this.pump();
      });
  }

  private async release(): Promise<void> {
    while (this.inflight) await this.inflight;
    this.dragging = false;
    const { targets, last } = this;
    if (targets.length && last) {
      const time = this.session.time;
      const write = async (entries: XformEntry[]) => void (await this.session.edit(this.session.core.call('setXforms', JSON.stringify(entries), time)));
      const before = targets.map((t) => ({ path: t.path, matrix: t.local }));
      this.session.commands.push({ label: this.mode, do: () => write(last), undo: () => write(before) });
    }
    this.targets = [];
    this.viewport?.sync.endPreview();
    this.session.emit('primschange', { resynced: [] }); // panels and this tool re-read the moved prims
  }
}
