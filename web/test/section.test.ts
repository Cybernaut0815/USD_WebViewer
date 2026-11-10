import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boxClipped, clean, EMPTY, equal, keeps, MAX, rows, type Section, type SectionBox, type Up, type Vec3 } from '../src/section.ts';

/** A stage point from plan coordinates (u, v; u × v = up, so counter-clockwise reads as seen from above) and a height. */
const at = (up: Up, u: number, v: number, h = 0): Vec3 => (up === 'Z' ? [u, v, h] : [v, h, u]);
const box = (up: Up, keep: SectionBox['keep'], plan: [number, number][], bottom: number, top: number) =>
  ({ keep, corners: plan.map(([u, v]) => at(up, u, v)), bottom, top }) as SectionBox;
const shows = (up: Up, section: Section, u: number, v: number, h = 0) => keeps(rows(clean(section, up), up), ...at(up, u, v, h));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

const SQUARE: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
/** An arrowhead pointing +u: corner 3 is the reflex one, the notch around (0.5, 2) lies outside. */
const ARROW: [number, number][] = [[0, 0], [4, 2], [0, 4], [1, 2]];

test('clean keeps what can be drawn and drops the rest, never throwing', () => {
  const thrower = new Proxy({}, { get: () => { throw new Error('no'); } });
  for (const junk of [undefined, null, 0, 'planes', [], { planes: 'x', boxes: 7 }, thrower]) assert.deepEqual(clean(junk, 'Z'), EMPTY);
  const square = box('Z', 'inside', SQUARE, 0, 1);
  const cleaned = clean(
    {
      on: false,
      planes: [
        { point: [0, 0, 0], normal: [0, 0, 2] },
        { point: [0, 0, NaN], normal: [0, 0, 1] },
        { point: [0, 0, 0], normal: [0, 0, 0] },
        { point: [0, 0], normal: [0, 0, 1] },
        { point: [0, 0, 0], normal: ['1', 0, 0] },
        null,
      ],
      boxes: [
        square,
        { ...square, top: 0 }, // no height
        { ...square, bottom: 2 }, // upside down
        { ...square, top: Infinity },
        { ...square, keep: 'maybe' },
        { ...square, corners: square.corners.slice(0, 3) },
        { ...square, corners: [[0, 0, 0], [1, 1, 0], [1, 0, 0], [0, 1, 0]] }, // a bow tie: its edges cross
        { ...square, corners: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]] }, // no area
        { ...square, corners: [[0, 0, 0], [0, 0, 0], [1, 1, 0], [0, 1, 0]] }, // two corners in one place
        { ...square, corners: [[0, 0, 0], [1, 0, 0], [1, 1e-12, 0], [0, 1e-12, 0]] }, // about no area
      ],
    },
    'Z',
  );
  assert.deepEqual(cleaned, { on: false, planes: [{ point: [0, 0, 0], normal: [0, 0, 2] }], boxes: [square] });
  // At most MAX of each; a missing `on` means on.
  const many = clean({ planes: Array(MAX + 3).fill({ point: [0, 0, 0], normal: [1, 0, 0] }), boxes: Array(MAX + 3).fill(square) }, 'Z');
  assert.deepEqual([many.on, many.planes.length, many.boxes.length], [true, MAX, MAX]);
  assert.ok(equal(many, clean(many, 'Z')));
  assert.ok(!equal(many, { ...many, on: false }));
});

test('footprints come back counter-clockwise seen from above, corner 0 first, on either up axis', () => {
  for (const up of ['Y', 'Z'] as const) {
    const clockwise = box(up, 'outside', [[0, 0], [0, 1], [1, 1], [1, 0]], 0, 1);
    assert.deepEqual(clean({ boxes: [clockwise] }, up).boxes[0].corners, box(up, 'outside', SQUARE, 0, 1).corners);
    const counter = box(up, 'outside', ARROW, 0, 1);
    assert.deepEqual(clean({ boxes: [counter] }, up).boxes[0], counter);
  }
  // Seen from above a Y-up stage, +z is to the right and +x up: x then z turns clockwise.
  assert.deepEqual(clean({ boxes: [{ keep: 'inside', corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], bottom: 0, top: 1 }] }, 'Y').boxes[0].corners, [
    [0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0],
  ]);
});

test('a concave footprint leaves its notch out, between bottom and top, on either up axis', () => {
  for (const up of ['Y', 'Z'] as const) {
    for (const plan of [ARROW, [...ARROW].reverse()]) {
      const section = { on: true, planes: [], boxes: [box(up, 'inside', plan, 0, 1)] };
      const inside = (u: number, v: number, h = 0.5) => shows(up, section, u, v, h);
      assert.ok(inside(2, 2), 'on the inner diagonal');
      assert.ok(inside(0.5, 0.5) && inside(0.6, 3) && inside(3.9, 2), 'in either triangle');
      assert.ok(!inside(0.5, 2) && !inside(0.2, 1.5) && !inside(0.2, 2.5), 'in the notch');
      assert.ok(!inside(3, 0.5) && !inside(5, 2) && !inside(-0.1, 2), 'around it');
      assert.ok(inside(2, 2, 0) && inside(2, 2, 1) && !inside(2, 2, 1.01) && !inside(2, 2, -0.01), 'bottom and top count as inside');
    }
  }
});

test('planes all have to keep a point, inside boxes add up, outside boxes win', () => {
  for (const up of ['Y', 'Z'] as const) {
    const planes = [{ point: at(up, 0, 0), normal: at(up, 1, 0) }, { point: at(up, 0, 0), normal: at(up, 0, 1) }];
    const both: Section = { on: true, planes, boxes: [] };
    assert.ok(shows(up, both, 1, 1) && !shows(up, both, 1, -1) && !shows(up, both, -1, 1));
    const square = (u: number) => box(up, 'inside', SQUARE.map(([a, b]) => [a + u, b]), 0, 1);
    const shown: Section = { on: true, planes: [], boxes: [square(0), square(2)] };
    assert.ok(shows(up, shown, 0.5, 0.5, 0.5) && shows(up, shown, 2.5, 0.5, 0.5) && !shows(up, shown, 1.5, 0.5, 0.5));
    const cut: Section = { ...shown, boxes: [...shown.boxes, { ...square(0.5), keep: 'outside' }] };
    assert.ok(shows(up, cut, 0.25, 0.5, 0.5) && !shows(up, cut, 0.75, 0.5, 0.5) && shows(up, cut, 2.5, 0.5, 0.5));
    // Off: the entries stay, everything shows, the header is all 0.
    const off = { ...cut, planes, on: false };
    assert.ok(shows(up, off, 1.5, -1, 5));
    assert.deepEqual([...rows(clean(off, up), up)].filter(Boolean), []);
  }
});

test('rows: header counts, unit normals and edges, heights on the up axis', () => {
  const r = rows(clean({ planes: [{ point: [0, 0, 3], normal: [0, 0, 2] }], boxes: [box('Y', 'outside', SQUARE, -1, 2), box('Y', 'inside', ARROW, 0, 1)] }, 'Y'), 'Y');
  assert.deepEqual([...r.subarray(0, 8)], [1, 2, 1, 1, 0, 0, 1, -3]);
  const first = (1 + MAX) * 4;
  assert.deepEqual([...r.subarray(first, first + 12)], [0, 1, 0, 0, 0, 1, 0, 1, 0, -1, 0, 2]); // meta (outside, convex), bottom, top on y
  const second = first + 32;
  assert.deepEqual([...r.subarray(second, second + 4)], [1, 0, 0, 0]); // inside, concave
  for (let i = 3; i < 8; i++) close(Math.hypot(r[second + i * 4], r[second + i * 4 + 1], r[second + i * 4 + 2]), 1);
});

test('boxClipped is true only where the whole box is hidden', () => {
  const up = 'Z';
  const cube = (u: number, v: number, h: number, size = 0.5): Vec3[] =>
    Array.from({ length: 8 }, (_, i) => at(up, u + (i & 1 ? size : -size), v + (i & 2 ? size : -size), h + (i & 4 ? size : -size)));
  const clipped = (section: Section, corners: Vec3[]) => boxClipped(rows(clean(section, up), up), corners);
  const plane: Section = { on: true, planes: [{ point: [0, 0, 0], normal: [1, 0, 0] }], boxes: [] };
  assert.ok(clipped(plane, cube(-1, 0, 0)) && !clipped(plane, cube(0, 0, 0)) && !clipped(plane, cube(1, 0, 0)));
  assert.ok(!clipped({ ...plane, on: false }, cube(-1, 0, 0)));
  // Outside every inside box: by a height, or an edge of a convex footprint; not by an edge of a concave one.
  const square: Section = { on: true, planes: [], boxes: [box(up, 'inside', SQUARE, 0, 1)] };
  assert.ok(clipped(square, cube(0.5, 0.5, 3)) && clipped(square, cube(-2, 0.5, 0.5)) && !clipped(square, cube(0.5, 0.5, 0.5)));
  const both: Section = { ...square, boxes: [...square.boxes, box(up, 'inside', ARROW, 0, 1)] };
  assert.ok(clipped(both, cube(0.5, 0.5, 3)) && !clipped(both, cube(-2, 0.5, 0.5)) && !clipped(both, cube(2, 2, 0.5)));
  assert.ok(!keeps(rows(clean(both, up), up), ...at(up, 0.45, 2, 0.5)) && !clipped(both, cube(0.45, 2, 0.5, 0.1)), 'in the notch: hidden, not provably');
  // Within an outside box: only a convex footprint proves it.
  const cut: Section = { on: true, planes: [], boxes: [box(up, 'outside', [[-1, -1], [1, -1], [1, 1], [-1, 1]], -1, 1)] };
  assert.ok(clipped(cut, cube(0, 0, 0)) && !clipped(cut, cube(0, 0, 0.75)) && !clipped(cut, cube(2, 0, 0)));
  assert.ok(!clipped({ on: true, planes: [], boxes: [box(up, 'outside', ARROW, -1, 1)] }, cube(2, 2, 0, 0.1)));

  // Against keeps(): no point of a clipped box shows (seeded, so the run is the same every time).
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const mixed: Section = {
    on: true,
    planes: [{ point: [0, 0, 0.2], normal: [0.3, -0.2, 1] }],
    boxes: [box(up, 'inside', [[-2, -2], [3, -2], [3, 3], [-2, 3]], -1, 2), box(up, 'outside', ARROW, -0.5, 1)],
  };
  const r = rows(clean(mixed, up), up);
  let count = 0;
  for (let n = 0; n < 2000; n++) {
    const corners = cube(random() * 10 - 4, random() * 10 - 4, random() * 6 - 3, random());
    if (!boxClipped(r, corners)) continue;
    count++;
    const [lo, hi] = [corners[0], corners[7]];
    for (let s = 0; s < 20; s++) {
      const p = lo.map((l, i) => l + (hi[i] - l) * random()) as Vec3;
      assert.ok(!keeps(r, ...p), `${p} shows in a clipped box`);
    }
  }
  assert.ok(count > 200, `only ${count} boxes clipped`);
});
