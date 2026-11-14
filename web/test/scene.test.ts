import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three/webgpu';
import { batchLook, HIDDEN, HIDDEN_DOUBLE, PLAIN } from '../src/materials.ts';
import type { MeshEntry, RenderDelta } from '../src/protocol.ts';
import { type BatchMesh, type Item, SceneSync } from '../src/scene.ts';

/** A unit cube as the core sends it: 24 vertices (4 per face, normals per face), 12 triangles. */
function cube(rid: number, extra: Partial<MeshEntry> = {}): MeshEntry {
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const faces = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]], [[0, 1, 0], [0, 0, 1], [1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]], [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]]];
  faces.forEach(([n, u, v], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...n.map((c, i) => (c + a * u[i] + b * v[i]) * 0.5));
      normals.push(...n);
    }
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return {
    rid, path: `/C${rid}`, purpose: 'default', indices: new Uint32Array(indices), positions: new Float32Array(positions),
    normals: new Float32Array(normals), counts: { points: 8, faces: 6, edges: 12 }, displayColor: [0.8, 0.2, 0.2],
    subsets: null, material: 0, instances: null, ...extra,
  };
}

/** n cubes on a row, 2 apart: their meshes and their matrices. */
function row(n: number, from = 1, extra: Partial<MeshEntry> = {}): RenderDelta {
  const rids = Array.from({ length: n }, (_, i) => from + i);
  const matrices = new Float64Array(rids.flatMap((_, i) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, i * 2, 0, 0, 1]));
  return { meshes: rids.map((rid) => cube(rid, extra)), xforms: { rids: new Uint32Array(rids), matrices } };
}

function sync() {
  const s = new SceneSync(new THREE.Scene(), { readBytes: async () => null, warn() {}, invalidate() {} });
  const batches = () => s.root.children.filter((o) => (o as BatchMesh).isBatch) as BatchMesh[];
  const item = (rid: number) => s.items.get(rid) as Item;
  return { s, batches, item };
}

test('64 or more static meshes of one look draw in one batch; their objects keep geometry and draw nothing', () => {
  const { s, batches, item } = sync();
  s.apply(row(80));
  assert.equal(batches().length, 1);
  assert.equal(batches()[0].instanceCount, 80);
  assert.equal((item(1).object as THREE.Mesh).material, HIDDEN_DOUBLE, 'the stand-in keeps double-sided picking');
  assert.equal(item(1).geometry!.index!.count, 36, 'the item keeps its own geometry');
  assert.notEqual(s.shadedMaterials(1), HIDDEN_DOUBLE, 'hosts still get the look');
  const few = sync();
  few.s.apply(row(10));
  assert.equal(few.batches().length, 0, 'ten draw one by one');
});

test('matrices follow xforms and drag previews; a mirrored item gets a mirrored batch', () => {
  const { s, batches, item } = sync();
  s.apply(row(70));
  const mesh = batches()[0];
  const at = (rid: number) => mesh.getMatrixAt(item(rid).batched!.instance, new THREE.Matrix4());
  s.apply({ xforms: { rids: new Uint32Array([5]), matrices: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]) } });
  assert.deepEqual(at(5).elements, item(5).object!.matrix.elements);
  s.beginPreview(['/C6']);
  s.previewDelta(new THREE.Matrix4().makeTranslation(0, 3, 0));
  assert.equal(at(6).elements[13], 3, 'the preview moves the instance');
  s.endPreview();
  assert.equal(at(6).elements[13], 0);
  // Mirrored: a scale of -1 flips the determinant; the batch mirrors, so batch x instance = the item's matrix.
  const mirrored = row(64, 200);
  mirrored.xforms!.matrices.forEach((_, i, m) => i % 16 === 0 && (m[i] = -1));
  s.apply(mirrored);
  const flipped = batches().find((b) => b.matrix.determinant() < 0)!;
  assert.ok(flipped, 'a second batch for the mirrored items');
  const product = new THREE.Matrix4().multiplyMatrices(flipped.matrix, flipped.getMatrixAt(item(200).batched!.instance, new THREE.Matrix4()));
  assert.deepEqual(product.elements, item(200).object!.matrix.elements);
  // Turning one back leaves its batch (its determinant changed sign).
  s.apply({ xforms: { rids: new Uint32Array([200]), matrices: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } });
  assert.equal(item(200).batched, null);
});

test('visibility, purposes and display colours reach the instances', () => {
  const { s, batches, item } = sync();
  s.apply(row(64));
  const mesh = batches()[0];
  s.apply({ visibility: { rids: new Uint32Array([3]), visible: new Uint8Array([0]) } });
  assert.equal(mesh.getVisibleAt(item(3).batched!.instance), false);
  s.setPurposes(['render']);
  assert.equal(mesh.getVisibleAt(item(4).batched!.instance), false);
  s.setPurposes(['default']);
  assert.equal(mesh.getVisibleAt(item(4).batched!.instance), true);
  s.apply({ meshes: [{ rid: 9, displayColor: [0, 0, 1] }] });
  assert.deepEqual(mesh.getColorAt(item(9).batched!.instance, new THREE.Color()).toArray(), [0, 0, 1]);
  assert.ok((mesh.material as THREE.MeshStandardNodeMaterial).colorNode, 'the display-colour look draws each item in its colour');
  s.setDisplayMode('plain');
  assert.equal(mesh.material, batchLook(PLAIN.double));
  assert.equal((mesh.material as THREE.MeshStandardNodeMaterial).colorNode, null, 'plain is grey for all');
  s.setDisplayMode('wire');
  assert.equal(mesh.material, HIDDEN);
});

test('a material that builds later swaps in place; a transparent one sends the items back to drawing alone', async () => {
  const { s, batches, item } = sync();
  const look = (rid: number, opacity: number) => ({
    rid, path: `/Looks/M${rid}`,
    network: { surface: 'S', nodes: { S: { type: 'UsdPreviewSurface', params: { diffuseColor: [1, 0, 0], opacity }, inputs: {} } } },
  });
  s.apply({ materials: [look(900, 1)], ...row(64, 1, { material: 900 }) });
  const mesh = batches()[0];
  await s.settled();
  assert.equal(batches()[0], mesh, 'the same batch');
  assert.equal((mesh.material as THREE.Material).type, 'MeshPhysicalNodeMaterial');
  s.apply({ materials: [look(900, 0.5)] });
  await s.settled();
  assert.equal(batches().length, 0, 'transparent: no batch');
  assert.equal((item(1).object as THREE.Mesh).material, s.shadedMaterials(1));
});

test('moving points, removal and clear', () => {
  const { s, batches, item } = sync();
  s.apply(row(64));
  s.apply({ meshes: [{ rid: 2, positions: new Float32Array(24 * 3) }] });
  assert.equal(item(2).batched, null, 'a positions-only update draws on its own from then on');
  assert.equal(item(2).dynamic, true);
  assert.equal(batches().length, 1, 'the batch keeps a hole');
  s.apply({ removed: new Uint32Array(Array.from({ length: 64 }, (_, i) => i + 1)) });
  assert.equal(batches().length, 0, 'the last item gone disposes the batch');
  s.apply(row(64, 500));
  s.clear();
  assert.equal(batches().length, 0);
});

test('while the view moves, sub-pixel batched parts draw nothing; stage visibility is kept throughout', () => {
  const { s, batches, item } = sync();
  s.apply(row(64));
  s.apply({ visibility: { rids: new Uint32Array([7]), visible: new Uint8Array([0]) } });
  const mesh = batches()[0];
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e7);
  camera.position.set(64, 0, 1e5); // unit cubes 100 km away: far under a pixel at 1000 px
  camera.updateMatrixWorld();
  s.root.updateMatrixWorld(true);
  s.cullDetail(camera, 1000);
  assert.equal(mesh.getVisibleAt(item(1).batched!.instance), false);
  camera.position.set(64, 0, 50); // 50 units: a cube spans pixels
  camera.updateMatrixWorld();
  s.cullDetail(camera, 1000);
  assert.equal(mesh.getVisibleAt(item(33).batched!.instance), true, 'in view (x 64)');
  assert.equal(mesh.getVisibleAt(item(1).batched!.instance), false, 'out of view (x 0)');
  assert.equal(mesh.getVisibleAt(item(7).batched!.instance), false, 'a hidden prim stays hidden');
  camera.position.set(64, 0, 1e5);
  camera.updateMatrixWorld();
  s.cullDetail(camera, 1000);
  s.cullDetail(null, 0); // the view stopped: everything draws
  assert.equal(mesh.getVisibleAt(item(1).batched!.instance), true);
  assert.equal(mesh.getVisibleAt(item(7).batched!.instance), false);
});

test('culling back faces swaps the batch material; picking from behind still hits double-sided items', () => {
  const { s, batches, item } = sync();
  s.apply(row(64, 1, { doubleSided: true }));
  const mesh = batches()[0];
  s.root.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, -5), new THREE.Vector3(0, 0, 1));
  const hits = ray.intersectObject(item(1).object!);
  assert.ok(hits.length > 0, 'the stand-in is double-sided like the look');
  s.setCullBackfaces(true);
  assert.equal(batches()[0], mesh, 'no regrouping');
  assert.equal((mesh.material as THREE.Material).side, THREE.DoubleSide, 'authored doubleSided stays double-sided');
  const single = sync();
  single.s.apply(row(64, 1, { doubleSided: false }));
  single.s.setCullBackfaces(true);
  assert.equal((single.batches()[0].material as THREE.Material).side, THREE.FrontSide);
  assert.equal((single.item(1).object as THREE.Mesh).material, HIDDEN);
});

test('a batch merges its items: their vertices one after another, each tagged with its slot', () => {
  const { s, batches, item } = sync();
  s.apply(row(64));
  const g = batches()[0].geometry;
  assert.equal(g.attributes.position.count, 64 * 24);
  assert.equal(g.index!.count, 64 * 36);
  const slot = item(10).batched!.instance;
  assert.equal(g.attributes.batchItem.getX(slot * 24 + 5), slot);
  assert.equal(g.index!.getX(slot * 36 + 2), item(10).geometry!.index!.getX(2) + slot * 24);
  // A second batch of the same look (mirrored items) draws with the same material: one shader for both.
  const mirrored = row(64, 200);
  mirrored.xforms!.matrices.forEach((_, i, m) => i % 16 === 0 && (m[i] = -1));
  s.apply(mirrored);
  assert.equal(batches().length, 2);
  assert.equal(batches()[0].material, batches()[1].material);
});

test("in the wire modes a batch draws its items' edges as one line draw sharing its positions", () => {
  const { s, batches, item } = sync();
  // The outline of each cube face (4 corners): 24 edges, 48 indices.
  const outline = new Uint32Array(Array.from({ length: 6 }, (_, f) => [0, 1, 1, 2, 2, 3, 3, 0].map((v) => f * 4 + v)).flat());
  s.apply(row(64, 1, { edges: outline }));
  const mesh = batches()[0];
  assert.equal(mesh.lines, null, 'shaded: none made');
  s.setDisplayMode('shaded-wire');
  const lines = mesh.lines!;
  assert.ok(lines.visible);
  assert.equal(lines.geometry.attributes.position, mesh.geometry.attributes.position, 'the positions are shared');
  const slot = item(3).batched!.instance;
  assert.equal(lines.geometry.index!.getX(slot * 48 + 1), 1 + slot * 24);
  assert.equal(item(3).object!.children.length, 0, 'no lines of its own');
  // Edges alone for one item: the batch's lines are redone.
  s.apply({ meshes: [{ rid: 3, edges: new Uint32Array([0, 2]) }] });
  assert.equal(mesh.lines, lines);
  assert.equal(lines.geometry.index!.count, 63 * 48 + 2);
  s.setDisplayMode('shaded');
  assert.equal(lines.visible, false);
  s.setDisplayMode('wire');
  assert.ok(lines.visible);
  // An item leaving its batch draws its own lines at once; its slot draws nothing.
  s.apply({ meshes: [{ rid: 5, positions: new Float32Array(24 * 3) }] });
  assert.equal(item(5).batched, null);
  assert.ok(item(5).object!.children.some((o) => (o as THREE.LineSegments).isLineSegments));
  assert.equal(mesh.getVisibleAt(4), false);
});

test('the viewer draws root without the batched stand-ins that show nothing; every other walk sees all of root', () => {
  const { s, batches, item } = sync();
  s.apply(row(80));
  const drawn = () => {
    let list: THREE.Object3D[] = [];
    s.drawing(() => (list = [...s.root.children]));
    return list;
  };
  assert.deepEqual(drawn(), batches(), 'only the batch');
  assert.equal(s.root.children.length, 81, 'outside the draw: every stand-in and the batch');
  // A shown selection fill, a host's child and leaving the batch each keep a stand-in drawn.
  s.apply({ selected: [{ rid: 3 }] });
  assert.ok(drawn().includes(item(3).object!), 'selected: its fill draws');
  s.apply({ selected: [] });
  assert.ok(!drawn().includes(item(3).object!), 'deselected: its fill hides');
  item(4).object!.add(new THREE.Object3D());
  assert.ok(drawn().includes(item(4).object!), "a host's child");
  s.apply({ meshes: [{ rid: 5, positions: new Float32Array(24 * 3) }] });
  assert.ok(drawn().includes(item(5).object!), 'out of its batch');
  // The order is root's (three keys the lights' shaders on it), and root is whole again after the draw.
  const order = s.root.children.filter((o) => drawn().includes(o));
  assert.deepEqual(drawn(), order);
  assert.equal(s.root.children.length, 81);
  // A stand-in's world matrix follows an xform at once: the viewer's render no longer walks it.
  s.apply({ xforms: { rids: new Uint32Array([6]), matrices: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]) } });
  assert.deepEqual(item(6).object!.matrixWorld.elements.slice(12, 15), [7, 8, 9]);
  // A root change made inside the draw survives it.
  const added = new THREE.Object3D();
  s.drawing(() => s.root.add(added));
  assert.ok(s.root.children.includes(added));
});

test('culling walks the slots: holes stay hidden, and a still view with nothing culled does no work', () => {
  const { s, batches, item } = sync();
  s.apply(row(64));
  const mesh = batches()[0];
  s.apply({ meshes: [{ rid: 2, positions: new Float32Array(24 * 3) }] }); // slot 1 becomes a hole
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1e7);
  camera.position.set(64, 0, 1e5);
  camera.updateMatrixWorld();
  s.root.updateMatrixWorld(true);
  s.cullDetail(camera, 1000);
  s.cullDetail(null, 0);
  assert.equal(mesh.getVisibleAt(1), false, 'the hole');
  assert.equal(mesh.getVisibleAt(item(3).batched!.instance), true);
  let calls = 0;
  const setVisibleAt = mesh.setVisibleAt.bind(mesh);
  mesh.setVisibleAt = (slot, visible) => (calls++, setVisibleAt(slot, visible));
  s.cullDetail(null, 0);
  assert.equal(calls, 0);
});

test('stats are counted once and redone when what they count changes', () => {
  const { s } = sync();
  s.apply(row(80));
  assert.equal(s.stats().meshes, 80);
  s.apply({ visibility: { rids: new Uint32Array([3]), visible: new Uint8Array([0]) } });
  assert.equal(s.stats().meshes, 79);
  s.apply({ removed: new Uint32Array([4]) });
  assert.equal(s.stats().meshes, 78);
  s.setPurposes(['render']);
  assert.equal(s.stats().meshes, 0);
});

test('removed items leave root in one pass, with three\'s events and root\'s order kept', () => {
  const { s, item } = sync();
  s.apply(row(10));
  const gone = [item(3).object!, item(7).object!];
  const removed: THREE.Object3D[] = [];
  s.root.addEventListener('childremoved', ({ child }) => removed.push(child));
  const before = s.root.children.filter((o) => !gone.includes(o));
  s.apply({ removed: new Uint32Array([3, 7]) });
  assert.deepEqual(s.root.children, before);
  assert.deepEqual(removed, gone);
  assert.ok(gone.every((o) => o.parent === null));
});

test('a pick skips batched items whose bounding sphere the ray misses', () => {
  const { s, item } = sync();
  s.apply(row(64));
  s.apply({ meshes: [cube(500)] }); // alone: never batched
  const towards = (x: number) => new THREE.Ray(new THREE.Vector3(x, 0, 5), new THREE.Vector3(0, 0, -1));
  assert.equal(s.mayHit(item(1), towards(0)), true, 'cube 1 sits at x 0');
  assert.equal(s.mayHit(item(1), towards(10)), false);
  assert.equal(s.mayHit(item(500), towards(10)), true, 'unbatched: always tested in full');
});

test('objectsUnder finds the items at and below the given paths, not siblings sharing a prefix', () => {
  const { s } = sync();
  s.apply({ meshes: [cube(1, { path: '/A/B' }), cube(2, { path: '/A/C/D' }), cube(3, { path: '/AB' })] });
  const paths = (list: THREE.Object3D[]) => list.map((o) => [...s.items.values()].find((i) => i.object === o)!.path).sort();
  assert.deepEqual(paths(s.objectsUnder(['/A'])), ['/A/B', '/A/C/D']);
  assert.deepEqual(paths(s.objectsUnder(['/A/C/D', '/AB'])), ['/A/C/D', '/AB']);
});
