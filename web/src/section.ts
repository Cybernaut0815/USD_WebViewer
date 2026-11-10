// Sections as data: clipping planes and vertical clipping boxes in stage space. clean() checks host input, rows()
// packs it for the shader, keeps() and boxClipped() run the shader's test on the CPU (picking, marquee).
// No imports, so `node --test` can run this file directly.

export type Vec3 = [number, number, number];
/** The stage's up axis: boxes stand on the plane across it. */
export type Up = 'Y' | 'Z';
/** What changed a section: the API, the gizmo, the viewer's menu, or a new stage (which clears it). */
export type SectionSource = 'api' | 'gizmo' | 'ui' | 'stage';

/** Keeps the side its normal points to: normal · (p - point) >= 0. */
export interface SectionPlane {
  point: Vec3;
  normal: Vec3;
}

/**
 * A vertical prism: a footprint of 4 corners in plan (a simple quad, concave allowed; their up coordinate is ignored)
 * between the heights bottom and top on the up axis. 'inside' shows only what is in it, 'outside' cuts it away.
 */
export interface SectionBox {
  keep: 'inside' | 'outside';
  corners: [Vec3, Vec3, Vec3, Vec3];
  bottom: number;
  top: number;
}

/**
 * Clipping planes and boxes in stage space. A point shows when every plane keeps it, no 'outside' box holds it and,
 * when there are 'inside' boxes, one of them does. on: false keeps the entries but shows everything.
 */
export interface Section {
  on: boolean;
  planes: SectionPlane[];
  boxes: SectionBox[];
}

export const EMPTY: Section = { on: true, planes: [], boxes: [] };
/** Planes, and boxes, at most: the shader's uniform array is sized for them. */
export const MAX = 8;
/** Rows of 4 numbers in the packed form: a header, MAX planes, MAX boxes of 8 rows. */
export const ROWS = 1 + MAX + MAX * 8;

/** Plan axes u, v (u × v = up, so counter-clockwise reads as seen from above) and the up axis, as indices of x y z. */
const axes = (up: Up) => (up === 'Z' ? [0, 1, 2] : [2, 0, 1]);
const vec = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : null);

/** True when the diagonal from corner k to k + 2 has the other two corners on opposite sides, clear of it. */
export function separates(c: readonly Vec3[], k: number, up: Up): boolean {
  const [U, V] = axes(up);
  const a = c[k], du = c[k + 2][U] - a[U], dv = c[k + 2][V] - a[V];
  const side = (p: Vec3) => du * (p[V] - a[V]) - dv * (p[U] - a[U]);
  const s1 = side(c[k + 1]), s3 = side(c[(k + 3) % 4]), tolerance = 1e-9 * (du * du + dv * dv);
  return (s1 > tolerance && s3 < -tolerance) || (s1 < -tolerance && s3 > tolerance);
}

/**
 * The section without what cannot be drawn: non-finite numbers, zero normals, footprints that cross themselves or
 * have about no area, top <= bottom; at most MAX planes and MAX boxes. Footprints come back counter-clockwise seen
 * from above (corner 0 stays first). Never throws.
 */
export function clean(input: unknown, up: Up): Section {
  try {
    const o = (input ?? {}) as { on?: unknown; planes?: unknown; boxes?: unknown };
    const planes: SectionPlane[] = [];
    for (const p of Array.isArray(o.planes) ? o.planes : []) {
      const point = vec(p?.point), normal = vec(p?.normal);
      const length = normal ? Math.hypot(...normal) : 0;
      if (point && normal && length > 0 && length < Infinity && planes.length < MAX) planes.push({ point, normal });
    }
    const boxes: SectionBox[] = [];
    for (const b of Array.isArray(o.boxes) ? o.boxes : []) {
      const c = (Array.isArray(b?.corners) && b.corners.length === 4 ? (b.corners as unknown[]).map(vec) : []).filter((v) => v !== null);
      const { keep, bottom, top } = b ?? {};
      if (c.length !== 4 || (keep !== 'inside' && keep !== 'outside') || boxes.length === MAX) continue;
      if (!Number.isFinite(bottom) || !Number.isFinite(top) || !(top > bottom)) continue;
      // One diagonal with the other corners on its two sides: the quad is simple, has area, and splits into two triangles.
      if (!separates(c, 0, up) && !separates(c, 1, up)) continue;
      const [U, V] = axes(up);
      let twiceArea = 0;
      for (let i = 0; i < 4; i++) twiceArea += c[i][U] * c[(i + 1) % 4][V] - c[(i + 1) % 4][U] * c[i][V];
      const corners: SectionBox['corners'] = twiceArea > 0 ? [c[0], c[1], c[2], c[3]] : [c[0], c[3], c[2], c[1]];
      boxes.push({ keep, corners, bottom, top });
    }
    return { on: o.on !== false, planes, boxes };
  } catch {
    return { on: true, planes: [], boxes: [] }; // a host's object whose getters throw
  }
}

/** Same content (both cleaned). */
export function equal(a: Section, b: Section): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * A cleaned section packed as ROWS rows of 4: row 0 is the header (planes, boxes, 'inside' boxes, active), all 0
 * when off; then MAX plane rows; then per box: meta (1 for 'inside', 1 when the footprint is convex, 0, 0), bottom,
 * top, the inner diagonal, the two outer edges of triangle A, those of triangle B. Every other row is an affine
 * function of a stage-space point, (a, b, c, d) · (x, y, z, 1), that is >= 0 on the kept or inner side; plane rows
 * and edges are normalized (signed distances).
 */
export function rows(section: Section, up: Up): Float64Array {
  const r = new Float64Array(ROWS * 4);
  const { planes, boxes } = section;
  if (!section.on || !(planes.length + boxes.length)) return r;
  const [U, V, H] = axes(up);
  const set = (i: number, u: number, v: number, h: number, w: number) => {
    r[i * 4 + U] = u;
    r[i * 4 + V] = v;
    r[i * 4 + H] = h;
    r[i * 4 + 3] = w;
  };
  /** Left of the plan edge a -> b: the inner side, for counter-clockwise corners. */
  const edge = (i: number, a: Vec3, b: Vec3) => {
    const du = b[U] - a[U], dv = b[V] - a[V], length = Math.hypot(du, dv);
    set(i, -dv / length, du / length, 0, (dv * a[U] - du * a[V]) / length);
  };
  planes.forEach(({ point: p, normal: n }, i) => {
    const length = Math.hypot(...n);
    r.set([n[0] / length, n[1] / length, n[2] / length, -(n[0] * p[0] + n[1] * p[1] + n[2] * p[2]) / length], (1 + i) * 4);
  });
  boxes.forEach((box, n) => {
    const at = 1 + MAX + n * 8, c = box.corners;
    const first = separates(c, 0, up), k = first ? 0 : 1;
    r.set([box.keep === 'inside' ? 1 : 0, first && separates(c, 1, up) ? 1 : 0], at * 4);
    set(at + 1, 0, 0, 1, -box.bottom);
    set(at + 2, 0, 0, -1, box.top);
    // The diagonal k -> k + 2 splits the quad into A = (k, k+1, k+2) and B = (k+2, k+3, k); its sign picks the
    // triangle, whose two outer edges then decide. One shared row, no epsilon: no crack along the diagonal.
    edge(at + 3, c[k + 2], c[k]);
    edge(at + 4, c[k], c[k + 1]);
    edge(at + 5, c[k + 1], c[k + 2]);
    edge(at + 6, c[k + 2], c[(k + 3) % 4]);
    edge(at + 7, c[(k + 3) % 4], c[k]);
  });
  r.set([planes.length, boxes.length, boxes.filter((b) => b.keep === 'inside').length, 1]);
  return r;
}

const row = (r: Float64Array, i: number, x: number, y: number, z: number) => r[i * 4] * x + r[i * 4 + 1] * y + r[i * 4 + 2] * z + r[i * 4 + 3];

/** The shader's test on the CPU (the same predicate): true when the section shows this stage-space point. */
export function keeps(r: Float64Array, x: number, y: number, z: number): boolean {
  const f = (i: number) => row(r, i, x, y, z);
  for (let i = 1; i <= r[0]; i++) if (f(i) < 0) return false;
  let shown = !r[2];
  for (let b = 0; b < r[1]; b++) {
    const i = 1 + MAX + b * 8;
    const inside = f(i + 1) >= 0 && f(i + 2) >= 0 && (f(i + 3) >= 0 ? f(i + 4) >= 0 && f(i + 5) >= 0 : f(i + 6) >= 0 && f(i + 7) >= 0);
    if (r[i * 4] === 1) shown ||= inside;
    else if (inside) return false;
  }
  return shown;
}

/**
 * True only when the section provably hides all of the convex hull of these stage-space points (an object's bounds
 * corners): behind one plane, outside every 'inside' box by one of its rows, or within one convex 'outside' box.
 */
export function boxClipped(r: Float64Array, corners: readonly Vec3[]): boolean {
  const all = (i: number, kept: boolean) => corners.every(([x, y, z]) => row(r, i, x, y, z) >= 0 === kept);
  for (let i = 1; i <= r[0]; i++) if (all(i, false)) return true;
  let outside = r[2] > 0;
  for (let b = 0; b < r[1]; b++) {
    const i = 1 + MAX + b * 8;
    // The heights always bound the box; the edge lines of a concave footprint run through it.
    const bounding = r[i * 4 + 1] === 1 ? [1, 2, 4, 5, 6, 7] : [1, 2];
    if (r[i * 4] === 1) outside &&= bounding.some((k) => all(i + k, false));
    else if (bounding.length > 2 && bounding.every((k) => all(i + k, true))) return true;
  }
  return outside;
}
