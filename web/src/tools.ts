// Viewport tools: exactly one is active at a time and owns the pointer events on the canvas.
import * as THREE from 'three/webgpu';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import type { Path, XformInfo } from './protocol.ts';
import type { UsdSession, XformEntry } from './session.ts';
import { ctrlSelect } from './session.ts';
import type { Viewport } from './viewport.ts';

export interface Tool {
  activate(viewport: Viewport): void;
  deactivate(): void;
}

/** A click that did not drag selects what is under the pointer (ctrl toggles). */
export class SelectTool implements Tool {
  protected readonly session: UsdSession;
  private abort: AbortController | null = null;

  constructor(session: UsdSession) {
    this.session = session;
  }

  activate(viewport: Viewport): void {
    this.abort = new AbortController();
    const { signal } = this.abort;
    let down: [number, number] | null = null;
    viewport.canvas.addEventListener('pointerdown', (e) => (down = this.grabbed() ? null : [e.clientX, e.clientY]), { signal });
    viewport.canvas.addEventListener(
      'pointerup',
      async (e) => {
        if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.button !== 0) return;
        const hit = viewport.pick(e.clientX, e.clientY);
        const result = hit ? await this.session.usd.resolvePick(hit.rid, hit.instance) : null;
        const path = result && !this.session.isLocked(result.path) ? result.path : null;
        if (path && (e.ctrlKey || e.metaKey)) ctrlSelect(this.session, path, 'viewport');
        else this.session.select(path ? [path] : [], 'viewport');
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
    return !!this.controls?.dragging;
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
