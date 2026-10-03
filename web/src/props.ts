// Property panel: details of the selected prim.
import type { Json, Path, PrimInfo } from './protocol.ts';

// Text always goes through textContent: everything shown here comes from untrusted files.
export function h(tag: string, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElement {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...children);
  return el;
}

const isTruncated = (v: object) => 'head' in v && 'length' in v;
const isAsset = (v: object) => 'asset' in v && 'resolved' in v;

export function format(value: Json): string {
  if (value === null) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(+value.toPrecision(7));
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `[${value.map(format).join(', ')}]`;
  if (isTruncated(value)) return `${format((value as { head: Json }).head)}… (${(value as { length: number }).length})`;
  if (isAsset(value)) return `@${value.asset}@`;
  return JSON.stringify(value);
}

/** USD text form of a value, for the clipboard: vectors as tuples, arrays as lists, strings quoted. */
export function usdaText(value: Json, typeName: string): string {
  const base = typeName.replace(/\[\]$/, '');
  const quote = (v: string) => (base === 'asset' ? `@${v}@` : JSON.stringify(v));
  const atom = (v: Json): string => {
    if (v === null) return 'None';
    if (typeof v === 'string') return quote(v);
    if (typeof v === 'number') return format(v);
    if (typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return `(${v.map(atom).join(', ')})`;
    if (isAsset(v)) return `@${(v as { asset: string }).asset}@`;
    return JSON.stringify(v);
  };
  if (value && typeof value === 'object' && !Array.isArray(value) && isTruncated(value)) value = (value as { head: Json }).head;
  if (typeName.endsWith('[]') && Array.isArray(value)) return `[${value.map(atom).join(', ')}]`;
  return atom(value);
}

function table(rows: (Node | string)[][]): HTMLElement {
  return h('table', {}, ...rows.map((cells) => (cells.length === 1 && cells[0] instanceof HTMLTableRowElement ? cells[0] : h('tr', {}, ...cells.map((cell) => h('td', {}, cell))))));
}

/** What a value box puts on the clipboard. */
interface Copy {
  name: string;
  text: string;
  /** USD type: offers the typed declaration and joins a section's text as usda lines. */
  typeName?: string;
  /** The untruncated USD text, fetched on demand (long arrays arrive truncated). */
  full?: () => Promise<string>;
}
const copies = new WeakMap<Element, Copy>();

/** A boxed value: click copies it, right click offers more forms. Shows `content` or the text. */
function box(copy: Copy, ...content: (Node | string)[]): HTMLElement {
  const el = h('span', { className: 'value', title: 'Click to copy, right click for more' }, ...(content.length ? content : [copy.text]));
  copies.set(el, copy);
  return el;
}

/** Nested dictionaries render as sub-tables, everything else as a value box. */
function cell(value: Json, name: string): Node | string {
  if (value && typeof value === 'object' && !Array.isArray(value) && !isTruncated(value) && !isAsset(value)) {
    return table(Object.entries(value).map(([k, v]) => [k, cell(v, k)]));
  }
  return box({ name, text: format(value) });
}

const fullText = (copy: Copy) => (copy.full ? copy.full() : Promise.resolve(copy.text));
const line = async (copy: Copy) => `${copy.typeName ? `${copy.typeName} ` : ''}${copy.name} = ${await fullText(copy)}`;

export interface CopyChoice {
  label: string;
  text: () => Promise<string>;
}

export class Props {
  readonly element = h('div', { className: 'props' });
  /** The global refinement setting and what it resolved to, shown next to a mesh's own override. */
  globalRefine = { setting: -1, effective: 0 };
  onvariant: (path: Path, variantSet: string, variant: string) => void = () => {};
  onloaded: (path: Path, loaded: boolean) => void = () => {};
  onnavigate: (path: Path) => void = () => {};
  onframe: (path: Path) => void = () => {};
  onrefinement: (path: Path, enabled: boolean, level: number) => void = () => {};
  /** Click on a value box: the host copies the text. */
  oncopy: (text: Promise<string>) => void = () => {};
  /** Right click on a value box: the host shows these copy choices. */
  oncontext: (x: number, y: number, choices: CopyChoice[]) => void = () => {};
  /** Full value of an attribute, for copying what the panel shows truncated. */
  attributeValue: (path: Path, name: string) => Promise<Json> = () => Promise.resolve(null);
  /** Which sections the user folded or unfolded; kept when another prim is shown. */
  private readonly folded = new Map<string, boolean>();

  constructor() {
    const target = (event: Event) => {
      const el = (event.target as Element).closest('.value');
      return el && !(event.target as Element).closest('a') && copies.has(el) ? el : null;
    };
    this.element.addEventListener('click', (event) => {
      const el = target(event);
      if (!el) return;
      this.oncopy(fullText(copies.get(el)!));
      el.classList.add('copied');
      setTimeout(() => el.classList.remove('copied'), 600);
    });
    this.element.addEventListener('contextmenu', (event) => {
      const el = target(event);
      if (!el) return;
      event.preventDefault();
      const copy = copies.get(el)!;
      // The section: the enclosing <details>, or the table at the top of the panel.
      const scope = el.closest('details') ?? el.closest('.props > table') ?? this.element;
      const all = [...scope.querySelectorAll('.value')].flatMap((v) => (copies.has(v) ? [copies.get(v)!] : []));
      const choices: CopyChoice[] = [
        { label: 'Copy value', text: () => fullText(copy) },
        { label: 'Copy name = value', text: async () => `${copy.name} = ${await fullText(copy)}` },
      ];
      if (copy.typeName) choices.push({ label: 'Copy typed declaration', text: () => line(copy) });
      choices.push({ label: 'Copy section as text', text: async () => (await Promise.all(all.map(line))).join('\n') });
      this.oncontext(event.clientX, event.clientY, choices);
    });
  }

  private section(title: string, open: boolean, ...content: (Node | string)[]): HTMLElement {
    const key = title.replace(/\s*\(.*$/, '');
    const details = h('details', { open: this.folded.get(key) ?? open }, h('summary', {}, title), ...content) as HTMLDetailsElement;
    details.addEventListener('toggle', () => this.folded.set(key, details.open));
    return details;
  }

  show(info: PrimInfo | null): void {
    if (!info) {
      this.element.replaceChildren(h('p', { className: 'hint' }, 'Select a prim to see its details.'));
      return;
    }
    const s = info.summary;
    const link = (path: Path) => {
      const a = h('a', { href: '#' }, path);
      a.addEventListener('click', (event) => {
        event.preventDefault();
        this.onnavigate(path);
      });
      return a;
    };
    const frame = h('button', {}, 'Frame');
    frame.addEventListener('click', () => this.onframe(s.path));
    const field = (name: string, text: string): (Node | string)[] => [name, box({ name, text })];
    const head: (Node | string)[][] = [
      field('Path', s.path),
      field('Kind', s.kind),
      field('Specifier', info.specifier),
      field('Purpose', info.purpose),
      field('Active', String(s.active)),
      field('Visible', String(s.visible)),
    ];
    if (typeof info.metadata.displayName === 'string') head.push(field('Display name', info.metadata.displayName));
    if (typeof info.metadata.documentation === 'string') head.push(field('Documentation', info.metadata.documentation));
    if (info.boundMaterial) head.push(['Material', box({ name: 'Material', text: info.boundMaterial }, link(info.boundMaterial))]);
    if (info.appliedSchemas.length) head.push(field('API schemas', info.appliedSchemas.join(', ')));
    const parts: HTMLElement[] = [
      h('div', { className: 'head' }, h('strong', {}, s.name || '/'), h('span', { className: 'type' }, s.typeName), frame),
      table(head),
    ];

    if (info.variantSets.length) {
      parts.push(
        this.section(
          'Variants',
          true,
          table(
            info.variantSets.map((set) => {
              const select = h('select') as HTMLSelectElement;
              for (const variant of ['', ...set.variants]) {
                select.append(h('option', { value: variant, selected: variant === set.selection }, variant || '(none)'));
              }
              select.addEventListener('change', () => this.onvariant(s.path, set.name, select.value));
              return [set.name, select];
            }),
          ),
        ),
      );
    }
    if (s.hasPayload) {
      const box = h('input', { type: 'checkbox', checked: s.loaded }) as HTMLInputElement;
      box.addEventListener('change', () => this.onloaded(s.path, box.checked));
      parts.push(this.section('Payload', true, h('label', {}, box, ' Loaded')));
    }
    if (info.refinement) {
      // Omniverse-style per-prim subdivision override, authored on the mesh.
      const { enabled, level } = info.refinement;
      const override = h('input', { type: 'checkbox', checked: enabled }) as HTMLInputElement;
      const value = h('input', { type: 'number', min: '0', max: '5', step: '1', value: String(level), disabled: !enabled }) as HTMLInputElement;
      const apply = () => this.onrefinement(s.path, override.checked, Number(value.value));
      override.addEventListener('change', () => {
        value.disabled = !override.checked;
        apply();
      });
      value.addEventListener('change', apply);
      const global = this.globalRefine.setting < 0 ? `auto (${this.globalRefine.effective})` : String(this.globalRefine.setting);
      parts.push(
        this.section(
          'Refinement',
          true,
          table([
            ['Override', h('label', {}, override, ' use this prim’s level')],
            ['Level', value],
            field('Global', global),
            field('Effective', String(enabled ? level : this.globalRefine.effective)),
          ]),
        ),
      );
    }
    if (info.worldXform) {
      const m = info.worldXform;
      const rows = [0, 1, 2, 3].map((r) => m.slice(r * 4, r * 4 + 4).map((v) => format(v)));
      const matrix = box(
        { name: 'worldTransform', typeName: 'matrix4d', text: `( ${rows.map((r) => `(${r.join(', ')})`).join(', ')} )` },
        h('table', { className: 'matrix' }, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c))))),
      );
      const transform: (Node | string)[][] = [['Matrix', matrix]];
      if (info.worldBounds) {
        const b = info.worldBounds.map((v) => format(v));
        transform.push(['Bounds min', box({ name: 'boundsMin', typeName: 'double3', text: `(${b.slice(0, 3).join(', ')})` })]);
        transform.push(['Bounds max', box({ name: 'boundsMax', typeName: 'double3', text: `(${b.slice(3).join(', ')})` })]);
      }
      parts.push(this.section('World transform', false, table(transform)));
    }
    if (info.attributes.length) {
      const rows: (Node | string)[][] = [];
      for (const a of info.attributes) {
        const name = h('span', { className: a.authored ? '' : 'fallback', title: a.typeName }, a.name);
        if (a.timeSamples) name.append(h('span', { className: 'badge', title: `${a.timeSamples} time samples` }, 'T'));
        if (a.custom) name.append(h('span', { className: 'badge', title: 'custom attribute' }, 'C'));
        if (a.variability === 'uniform') name.append(h('span', { className: 'badge', title: 'uniform (not time varying)' }, 'U'));
        const value = a.connections?.length
          ? box({ name: `${a.name}.connect`, typeName: a.typeName, text: a.connections.map((c) => `<${c}>`).join(', ') }, ...a.connections.map(link))
          : box({
              name: a.name,
              typeName: a.typeName,
              text: format(a.value),
              full: async () => usdaText(await this.attributeValue(s.path, a.name), a.typeName),
            });
        const metadata = Object.entries(a.metadata);
        const row = h('tr', {}, h('td', {}, name), h('td', {}, h('span', { className: 'type' }, a.typeName)), h('td', {}, value));
        if (metadata.length) {
          const twisty = h('span', { className: 'twisty', title: 'attribute metadata' }, '▸');
          const meta = h('tr', { className: 'meta', hidden: true }, h('td', { colSpan: 3 }, cell(a.metadata, a.name)));
          twisty.addEventListener('click', () => {
            meta.hidden = !meta.hidden;
            twisty.textContent = meta.hidden ? '▸' : '▾';
          });
          name.prepend(twisty);
          rows.push([row], [meta]);
        } else rows.push([row]);
      }
      parts.push(this.section(`Attributes (${info.attributes.length})`, true, table(rows)));
    }
    if (info.primvars.length) {
      parts.push(
        this.section(
          `Primvars (${info.primvars.length})`,
          true,
          table(
            info.primvars.map((p) => {
              const name = h('span', { className: p.inheritedFrom ? 'fallback' : '', title: p.inheritedFrom ? `inherited from ${p.inheritedFrom}` : '' }, p.name);
              if (p.indexed) name.append(h('span', { className: 'badge', title: 'indexed' }, 'I'));
              const decl = `${p.typeName} ${p.interpolation}${p.elementSize !== 1 ? ` ×${p.elementSize}` : ''}`;
              const value = box({
                name: `primvars:${p.name}`,
                typeName: p.typeName,
                text: format(p.value),
                full: async () => usdaText(await this.attributeValue(p.inheritedFrom ?? s.path, `primvars:${p.name}`), p.typeName),
              });
              return [name, h('span', { className: 'type' }, decl), value];
            }),
          ),
        ),
      );
    }
    if (info.relationships.length) {
      parts.push(this.section('Relationships', true, table(info.relationships.map((r) => [r.name, box({ name: r.name, typeName: 'rel', text: `[${r.targets.map((t) => `<${t}>`).join(', ')}]` }, ...r.targets.map(link))]))));
    }
    const metadata = Object.entries(info.metadata);
    if (metadata.length) parts.push(this.section('Metadata', true, table(metadata.map(([k, v]) => [k, cell(v, k)]))));
    if (info.arcs.length || info.primStack.length) {
      const arcs = info.arcs.map((arc) => {
        const name = `${arc.type}${arc.ancestral ? ' (ancestral)' : ''}${arc.implicit ? ' (implicit)' : ''}`;
        return [name, box({ name, text: `${arc.layer || '(root)'} → ${arc.targetLayer} ${arc.target}` })];
      });
      const stack = info.primStack.map((spec) => [spec.layer, box({ name: spec.layer, text: spec.path })]);
      parts.push(this.section('Composition', false, table(arcs), table(stack)));
    }
    this.element.replaceChildren(...parts);
  }
}
