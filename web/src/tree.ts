// Hierarchy panel: lazily loaded prim tree drawn as a window of fixed-height
// rows, so the DOM stays small however many prims the stage has.
import type { Path, PrimSummary } from './protocol.ts';
import { hasAncestorIn, type SelectMode } from './session.ts';

const ROW = 22; // px, must match .row in viewer.css

interface TreeNode {
  summary: PrimSummary;
  depth: number;
  expanded: boolean;
  children: TreeNode[] | null; // null = not loaded yet
}

/** Visible rows of a tree in display order. Exported for tests. */
export function flatten(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    out.push(node);
    if (node.expanded && node.children) flatten(node.children, out);
  }
  return out;
}

/** First row index and row count to draw for a scroll position. Exported for tests. */
export function rowWindow(scrollTop: number, viewHeight: number, total: number): [number, number] {
  const first = Math.max(Math.floor(scrollTop / ROW) - 4, 0);
  const count = Math.min(Math.ceil(viewHeight / ROW) + 8, total - first);
  return [first, Math.max(count, 0)];
}

export class Tree {
  readonly element = document.createElement('div');
  /** Shift-click adds, Ctrl-click removes. */
  /** Shift-click adds, Ctrl-click removes, Shift+Ctrl adds the parent, Shift+Alt a level up with its
   * subtree ('subtree'); Alt-click adds the rows between the last clicked row and this one. */
  onselect: (paths: Path[], mode: SelectMode | 'subtree') => void = () => {};
  onvisible: (path: Path, visible: boolean) => void = () => {};
  onframe: (path: Path) => void = () => {};
  onlock: (path: Path, locked: boolean) => void = () => {};
  oncontext: (path: Path, x: number, y: number) => void = () => {};
  /** Editor-only lock state, asked per row while drawing. */
  isLocked: (path: Path) => boolean = () => false;
  /** Edited in this session ('self') or something below was ('below'), asked per row while drawing. */
  changeState: (path: Path) => 'self' | 'below' | null = () => null;
  private readonly spacer = document.createElement('div');
  private roots: TreeNode[] = [];
  private rows: TreeNode[] = [];
  private selected = new Set<Path>();
  private active: Path | null = null;
  /** The last row clicked without Alt: where an Alt-click range starts. */
  private anchor: Path | null = null;
  private readonly load: (path: Path) => Promise<PrimSummary[]>;

  constructor(load: (path: Path) => Promise<PrimSummary[]>) {
    this.load = load;
    this.element.className = 'tree';
    this.element.tabIndex = 0;
    this.element.setAttribute('role', 'tree');
    this.element.append(this.spacer);
    this.element.addEventListener('scroll', () => this.draw());
    this.element.addEventListener('click', (event) => this.click(event));
    this.element.addEventListener('dblclick', (event) => {
      const node = this.nodeAt(event);
      if (node) this.onframe(node.summary.path);
    });
    this.element.addEventListener('keydown', (event) => this.key(event));
    this.element.addEventListener('contextmenu', (event) => {
      const node = this.nodeAt(event);
      if (!node) return;
      event.preventDefault();
      this.oncontext(node.summary.path, event.clientX, event.clientY);
    });
    new ResizeObserver(() => this.draw()).observe(this.element);
  }

  async reset(): Promise<void> {
    this.selected.clear();
    this.roots = this.wrap(await this.load('/'), 0);
    // A lone root prim is almost always what the user wants to see inside.
    if (this.roots.length === 1) await this.expand(this.roots[0]);
    this.refresh();
  }

  clear(): void {
    this.roots = [];
    this.selected.clear();
    this.refresh();
  }

  /** Shows a flat list of paths (search results), or the tree again with null. */
  private search: TreeNode[] | null = null;
  showResults(paths: Path[] | null): void {
    this.search =
      paths &&
      paths.map((path) => ({
        summary: { ...BLANK, path, name: path },
        depth: 0,
        expanded: false,
        children: [],
      }));
    this.refresh();
  }

  /** Redraws the visible rows (badges, locks) without reloading anything. */
  redraw(): void {
    this.draw();
  }

  setSelection(paths: readonly Path[], active: Path | null = paths.at(-1) ?? null): void {
    this.selected = new Set(paths);
    this.active = active;
    this.draw();
  }

  /** Expands the ancestors of `path` and scrolls it into view. */
  async reveal(path: Path): Promise<void> {
    if (this.search) return;
    const names = path.split('/').filter(Boolean);
    let level = this.roots;
    let node: TreeNode | undefined;
    for (const [i, name] of names.entries()) {
      node = level.find((n) => n.summary.name === name);
      if (!node) return;
      if (i < names.length - 1) {
        await this.expand(node);
        level = node.children ?? [];
      }
    }
    this.refresh();
    const index = this.rows.findIndex((row) => row.summary.path === path);
    if (index < 0) return;
    const top = index * ROW;
    if (top < this.element.scrollTop || top + ROW > this.element.scrollTop + this.element.clientHeight) {
      this.element.scrollTop = top - this.element.clientHeight / 2;
    }
  }

  /** Reloads loaded children under the given paths after a stage edit. */
  async invalidate(paths: Path[]): Promise<void> {
    if (paths.some((p) => p === '/')) {
      const open = new Set(flatten(this.roots).filter((n) => n.expanded).map((n) => n.summary.path));
      this.roots = this.wrap(await this.load('/'), 0);
      await this.reopen(this.roots, open);
    } else {
      // One pass over the rows, the reloads in parallel; a path under another reloaded path is
      // covered by that reload (reopen loads fresh children).
      const byPath = new Map(flatten(this.roots).map((n) => [n.summary.path, n]));
      const set = new Set(paths);
      const reloads = [...set].flatMap((path) => {
        const node = byPath.get(path);
        if (!node?.children || hasAncestorIn(path, set)) return [];
        const open = new Set(flatten(node.children).filter((n) => n.expanded).map((n) => n.summary.path));
        return [
          this.load(path).then(async (children) => {
            node.children = this.wrap(children, node.depth + 1);
            await this.reopen(node.children, open);
          }),
        ];
      });
      await Promise.all(reloads);
    }
    this.refresh();
  }

  /**
   * Updates the computed visibility of loaded rows with one query, after an edit that only changed
   * visibility (cheaper than reloading every expanded level). With `touched` (the prims the edit
   * changed) only the rows at or below them are asked about; without it, every loaded row.
   */
  async refreshVisibility(query: (paths: Path[]) => Promise<boolean[]>, touched?: readonly Path[]): Promise<void> {
    // Every loaded node, collapsed ones too: expanding reuses their cached summaries.
    let nodes: TreeNode[] = [...(this.search ?? [])];
    const walk = (list: TreeNode[]) => list.forEach((n) => (nodes.push(n), n.children && walk(n.children)));
    walk(this.roots);
    if (touched?.length) {
      const set = new Set(touched);
      nodes = nodes.filter((n) => set.has(n.summary.path) || hasAncestorIn(n.summary.path, set));
    }
    if (!nodes.length) return;
    const visible = await query(nodes.map((n) => n.summary.path));
    nodes.forEach((node, i) => (node.summary.visible = visible[i] ?? node.summary.visible));
    this.draw();
  }

  private async reopen(nodes: TreeNode[], open: Set<Path>): Promise<void> {
    for (const node of nodes) {
      if (!open.has(node.summary.path)) continue;
      await this.expand(node);
      await this.reopen(node.children ?? [], open);
    }
  }

  private wrap(children: PrimSummary[], depth: number): TreeNode[] {
    return children.map((summary) => ({ summary, depth, expanded: false, children: null }));
  }

  private async expand(node: TreeNode): Promise<void> {
    node.children ??= this.wrap(await this.load(node.summary.path), node.depth + 1);
    node.expanded = true;
  }

  private refresh(): void {
    this.rows = this.search ?? flatten(this.roots);
    this.spacer.style.height = `${this.rows.length * ROW}px`;
    this.draw();
  }

  private draw(): void {
    const [first, count] = rowWindow(this.element.scrollTop, this.element.clientHeight, this.rows.length);
    const fragment = document.createDocumentFragment();
    for (let i = first; i < first + count; i++) fragment.append(this.row(this.rows[i], i));
    this.spacer.replaceChildren(fragment);
  }

  private row(node: TreeNode, index: number): HTMLElement {
    const s = node.summary;
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.index = String(index);
    row.style.top = `${index * ROW}px`;
    row.style.paddingLeft = `${node.depth * 14 + 4}px`;
    row.setAttribute('role', 'treeitem');
    row.classList.toggle('selected', this.selected.has(s.path));
    row.classList.toggle('active', s.path === this.active);
    const locked = this.isLocked(s.path);
    row.classList.toggle('dim', !s.active || !s.visible || locked);
    row.title = s.path;
    const twisty = element('span', 'twisty', s.hasChildren ? (node.expanded ? '▾' : '▸') : '');
    const name = element('span', 'name', s.name);
    row.append(twisty, name);
    if (s.typeName) row.append(element('span', 'type', s.typeName));
    const badge = (text: string, title: string) => Object.assign(element('span', 'badge', text), { title });
    if (s.hasPayload) row.append(badge('P', 'Has a payload (load / unload in the details panel)'));
    if (s.hasVariantSets) row.append(badge('V', 'Has variant sets (choose in the details panel)'));
    if (s.isInstance) row.append(badge('I', 'Instanceable: drawn as an instance of a shared prototype'));
    const change = this.changeState(s.path);
    const marker = element('span', 'changed', change === 'self' ? '◆' : change === 'below' ? '◇' : '');
    if (change) marker.title = change === 'self' ? 'Changed in this session' : 'Something below changed in this session';
    row.append(marker);
    if (!this.search) {
      const lock = element('button', 'lock', locked ? '🔒' : '🔓');
      lock.title = locked ? 'Unlock (selectable again)' : 'Lock (not selectable in the viewport)';
      lock.classList.toggle('on', locked);
      const eye = element('button', 'eye', s.visible ? '●' : '○');
      eye.title = s.visible ? 'Hide' : 'Show';
      row.append(lock, eye);
    }
    return row;
  }

  private nodeAt(event: Event): TreeNode | null {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.row');
    return row ? (this.rows[Number(row.dataset.index)] ?? null) : null;
  }

  private async click(event: MouseEvent): Promise<void> {
    const node = this.nodeAt(event);
    if (!node) return;
    const target = event.target as HTMLElement;
    if (target.classList.contains('twisty') && node.summary.hasChildren) {
      if (node.expanded) node.expanded = false;
      else await this.expand(node);
      this.refresh();
    } else if (target.classList.contains('eye')) {
      node.summary.visible = !node.summary.visible;
      this.onvisible(node.summary.path, node.summary.visible);
      this.draw();
    } else if (target.classList.contains('lock')) {
      this.onlock(node.summary.path, !this.isLocked(node.summary.path));
    } else if (event.altKey && !event.shiftKey) {
      this.onselect(this.range(node.summary.path), 'add');
    } else {
      const e = event;
      this.anchor = node.summary.path;
      const ctrl = e.ctrlKey || e.metaKey;
      this.onselect([node.summary.path], e.shiftKey && e.altKey ? 'subtree' : e.shiftKey && ctrl ? 'up' : e.shiftKey ? 'add' : ctrl ? 'remove' : 'replace');
    }
  }

  private async key(event: KeyboardEvent): Promise<void> {
    const current = this.rows.findIndex((row) => this.selected.has(row.summary.path));
    const node = this.rows[current];
    let next = current;
    if (event.key === 'ArrowDown') next = Math.min(current + 1, this.rows.length - 1);
    else if (event.key === 'ArrowUp') next = Math.max(current - 1, 0);
    else if (event.key === 'ArrowRight' && node?.summary.hasChildren) {
      await this.expand(node);
      this.refresh();
    } else if (event.key === 'ArrowLeft' && node?.expanded) {
      node.expanded = false;
      this.refresh();
    } else return; // other keys (F, tools, hiding) are the viewer's
    event.preventDefault();
    if (next !== current && this.rows[next]) {
      this.anchor = this.rows[next].summary.path;
      this.onselect([this.anchor], 'replace');
    }
  }

  /** The visible rows from the anchor to `path`, ending with `path` (just `path` when the anchor is not shown). */
  private range(path: Path): Path[] {
    const paths = this.rows.map((row) => row.summary.path);
    const from = paths.indexOf(this.anchor ?? this.active ?? '');
    const to = paths.indexOf(path);
    if (from < 0 || to < 0) return [path];
    const slice = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
    return from <= to ? slice : slice.reverse();
  }
}

const BLANK: PrimSummary = {
  name: '',
  path: '',
  typeName: '',
  kind: '',
  hasChildren: false,
  active: true,
  visible: true,
  isInstance: false,
  hasPayload: false,
  loaded: true,
  hasVariantSets: false,
};

// Text always goes through textContent: prim names come from untrusted files.
function element(tag: string, className: string, text: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  el.textContent = text;
  return el;
}
