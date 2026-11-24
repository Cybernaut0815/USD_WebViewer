import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three/webgpu';
import { batchLook, HIDDEN, HIDDEN_DOUBLE, LINE, LINE_ALONE, MAX_BANDS, paintEdge, paintLook, PLAIN } from '../src/materials.ts';
import type { MeshEntry, RenderDelta } from '../src/protocol.ts';
import { type BatchMesh, type Item, paintPlan, SceneSync } from '../src/scene.ts';

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
  const warnings: string[] = [];
  const s = new SceneSync(new THREE.Scene(), { readBytes: async () => null, warn: (message) => warnings.push(message), invalidate() {} });
  const batches = () => s.root.children.filter((o) => (o as BatchMesh).isBatch) as BatchMesh[];
  const item = (rid: number) => s.items.get(rid) as Item;
  return { s, batches, item, warnings };
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
  // Mirrored: a scale of -1 flips the determinant; the batch mirrors (its own matrix), its slots keep stage matrices.
  const mirrored = row(64, 200);
  mirrored.xforms!.matrices.forEach((_, i, m) => i % 16 === 0 && (m[i] = -1));
  s.apply(mirrored);
  const flipped = batches().find((b) => b.matrix.determinant() < 0)!;
  assert.ok(flipped, 'a second batch for the mirrored items');
  assert.deepEqual(flipped.getMatrixAt(item(200).batched!.instance, new THREE.Matrix4()).elements, item(200).object!.matrix.elements);
  // Turning one back leaves its batch (its determinant changed sign).
  s.apply({ xforms: { rids: new Uint32Array([200]), matrices: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } });
  assert.equal(item(200).batched, null);
});

test('far from the stage origin a batch keeps float64 placement: its slots hold matrices relative to its own', () => {
  const { s, batches, item } = sync();
  const far = row(64);
  far.xforms!.matrices.forEach((_, i, m) => i % 16 === 12 && (m[i] = 5_000_000.25 + 10.5 * Math.floor(i / 16)));
  s.apply(far);
  const mesh = batches()[0], k = item(3).batched!.instance;
  assert.equal(mesh.matrix.elements[12], 5_000_000.25, 'the batch sits at its first item');
  assert.equal((mesh as any).matrices.image.data[16 * k + 12], 21, 'a small float32 translation in the texture');
  assert.equal(mesh.getMatrixAt(k, new THREE.Matrix4()).elements[12], item(3).object!.matrix.elements[12], 'exact in stage space');
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

test('cutouts keep their alpha test in batches and in flat variants (three r186 clones drop it)', async () => {
  const { s, batches, item } = sync();
  const cutout = { rid: 900, path: '/Looks/Leaf', network: { surface: 'S', nodes: { S: { type: 'UsdPreviewSurface', params: { opacityThreshold: 0.5 }, inputs: {} } } } };
  s.apply({ materials: [cutout], ...row(64, 1, { material: 900, normals: null }) });
  s.apply(row(3, 100, { material: 900, normals: null }));
  await s.settled();
  assert.equal((batches()[0].material as THREE.Material).alphaTest, 0.5, 'the batch of flat items');
  assert.equal(((item(100).object as THREE.Mesh).material as THREE.Material).alphaTest, 0.5, 'a flat item drawn alone');
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

test('paint draws items from values in pieces and gives their drawing back', () => {
  const { s, batches, item, warnings } = sync();
  s.apply(row(80));
  const base = batches()[0];
  const paint = (items: { rid: number; values: ArrayLike<number> }[], per: 'face' | 'vertex' | 'corner' = 'face') => [...s.paint(items, per)];
  const all = (value: (rid: number, f: number) => number) => Array.from({ length: 80 }, (_, i) => ({ rid: i + 1, values: Float32Array.from({ length: 12 }, (_, f) => value(i + 1, f)) }));
  paint([...all((rid, f) => rid * 100 + f), { rid: 1, values: [1] }, { rid: 999, values: [] }]);
  assert.equal(base.parent, null, 'the base batch went with its last item');
  assert.equal(batches().length, 1);
  const piece = batches()[0];
  const g = piece.geometry;
  const slot = (rid: number) => item(rid).painted![0].slot;
  assert.equal(g.index, null, 'de-indexed');
  assert.equal(g.attributes.position.count, 80 * 36);
  for (let c = 0; c < 36; c++) assert.equal(g.attributes.paintValue.getX(slot(7) * 36 + c), 700 + Math.floor(c / 3), 'values[f] at corners 3f..3f+2');
  assert.equal(g.attributes.batchItem.getX(slot(7) * 36 + 5), slot(7));
  assert.equal(g.attributes.position.getY(slot(7) * 36 + 4), item(7).geometry!.attributes.position.getY(item(7).geometry!.index!.getX(4)), 'local positions');
  assert.equal((item(7).object as THREE.Mesh).material, HIDDEN_DOUBLE, 'a stand-in');
  assert.equal(warnings.length, 1, 'a second entry for rid 1 and a rid without a mesh: one warning');
  // The same items the same way: the same piece and positions, new values.
  const position = g.attributes.position;
  paint(all((rid, f) => -rid - f));
  assert.equal(batches()[0], piece);
  assert.equal(g.attributes.position, position);
  assert.equal(g.attributes.paintValue.getX(slot(7) * 36 + 3), -8);
  // Visibility, xforms and a host's child.
  s.apply({ visibility: { rids: new Uint32Array([3]), visible: new Uint8Array([0]) } });
  assert.equal(piece.getVisibleAt(slot(3)), false, 'a hidden prim');
  assert.equal(piece.getVisibleAt(slot(4)), true);
  s.apply({ xforms: { rids: new Uint32Array([5]), matrices: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 7, 8, 9, 1]) } });
  assert.deepEqual(piece.getMatrixAt(slot(5), new THREE.Matrix4()).elements.slice(12, 15), [7, 8, 9]);
  item(4).object!.add(new THREE.Object3D());
  let drawn: THREE.Object3D[] = [];
  s.drawing(() => (drawn = [...s.root.children]));
  assert.ok(drawn.includes(item(4).object!), "a host's child under a painted item is drawn");
  assert.ok(!drawn.includes(item(2).object!), 'other stand-ins are not');
  // Mirroring a painted item drops its paint (its pieces wind for the old sign): it draws itself, its slot is a hole.
  const eight = slot(8);
  s.apply({ xforms: { rids: new Uint32Array([8]), matrices: new Float64Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) } });
  assert.equal(item(8).painted, null);
  assert.equal(piece.getVisibleAt(eight), false);
  // New indices drop the item's paint; clearing gives the items back to one batch.
  const six = slot(6);
  s.apply({ meshes: [cube(6)] });
  assert.equal(item(6).painted, null);
  assert.equal(piece.getVisibleAt(six), false, 'its slot is a hole');
  paint([]);
  assert.deepEqual(batches().map((b) => [b.instanceCount, !!b.geometry.attributes.paintValue]), [[79, false]], 'all but the mirrored one, which draws alone');
  assert.equal(piece.parent, null);
  // Per vertex: values[index[c]] at corner c.
  paint([{ rid: 3, values: Float32Array.from({ length: 24 }, (_, v) => v * 10) }], 'vertex');
  const one = batches().find((b) => b.geometry.attributes.paintValue)!;
  const index = item(3).geometry!.index!;
  for (let c = 0; c < 36; c++) assert.equal(one.geometry.attributes.paintValue.getX(c), index.getX(c) * 10);
  // Per corner: values[c] at corner c, so two corners at one vertex can differ; another mode is another set of pieces.
  paint([{ rid: 3, values: Float32Array.from({ length: 36 }, (_, c) => c + 0.5) }], 'corner');
  const cornered = batches().find((b) => b.geometry.attributes.paintValue)!;
  assert.notEqual(cornered, one);
  for (let c = 0; c < 36; c++) assert.equal(cornered.geometry.attributes.paintValue.getX(c), c + 0.5);
  paint([{ rid: 3, values: new Float32Array(24) }], 'corner');
  assert.equal(warnings.length, 2, 'one value per vertex is not one per corner: skipped');
});

test('in the wire modes painted items keep their colours and draw their own edges over them', () => {
  const { s, item } = sync();
  const outline = new Uint32Array(Array.from({ length: 6 }, (_, f) => [0, 1, 1, 2, 2, 3, 3, 0].map((v) => f * 4 + v)).flat());
  const own = (rid: number) => item(rid).object!.children.filter((o) => (o as THREE.LineSegments).isLineSegments) as THREE.LineSegments[];
  const lines = (rid: number) => own(rid).length;
  const paint = (rids: number[]) => [...s.paint(rids.map((rid) => ({ rid, values: new Float32Array(12) })), 'face')];
  s.apply(row(3, 1, { edges: outline }));
  s.setDisplayMode('shaded-wire');
  assert.deepEqual([1, 2, 3].map(lines), [1, 1, 1]);
  paint([2]);
  assert.deepEqual([1, 2, 3].map(lines), [1, 1, 1], 'painted, it keeps one set of lines');
  assert.ok(item(2).painted, 'and its colours');
  s.setDisplayMode('wire');
  assert.deepEqual([1, 2, 3].map(lines), [1, 1, 1]);
  assert.equal(own(2)[0].material, LINE, 'over its colours: the lines over a surface');
  assert.equal(own(1)[0].material, LINE_ALONE, 'an unpainted item alone: the lines against the background');
  s.apply({ meshes: [{ rid: 2, edges: outline }] });
  assert.equal(lines(2), 1, 'new edges make its lines again');
  paint([]);
  assert.deepEqual([1, 2, 3].map(lines), [1, 1, 1], 'unpainted: still one set each');
  assert.equal(own(2)[0].material, LINE_ALONE);
  s.setDisplayMode('shaded');
  paint([3]);
  assert.deepEqual([1, 2, 3].map(lines), [0, 0, 0], 'no wire mode: no lines');
  s.setDisplayMode('plain-wire');
  assert.deepEqual([1, 2, 3].map(lines), [1, 1, 1]);
});

test('a paint style takes one band, a list of them, or none; more than the shader holds is refused', () => {
  const look = paintLook(), base = { stops: ['#000000', '#ffffff'], min: 0, max: 1 };
  look.style = { ...base, band: [0.2, 0.4] };
  assert.deepEqual(look.style.band, [0.2, 0.4]);
  look.style = { ...base, band: [[0.1, 0.2], [0.6, 0.9]] };
  assert.deepEqual(look.style.band, [[0.1, 0.2], [0.6, 0.9]]);
  look.style = { ...base, band: null };
  assert.equal(look.style.band, null);
  const many = Array.from({ length: MAX_BANDS + 1 }, (_, i): [number, number] => [i, i + 0.5]);
  assert.throws(() => (look.style = { ...base, band: many }), /at most 32 bands/);
  look.style = { ...base, band: many.slice(0, MAX_BANDS) };
  assert.equal((look.style.band as number[][]).length, MAX_BANDS);
});

test('paint thresholds split float32 values as the doubles do', () => {
  const below = (f: number, x: number) => f < paintEdge(x, true), above = (f: number, x: number) => f > paintEdge(x, false);
  // a histogram's last bin keeps its top value: [5, 6 + 6e-9) holds 6, which float32(6 + 6e-9) = 6 would not
  assert.ok(Math.fround(6) < paintEdge(6 + 6e-9, true));
  for (const x of [0.7, -0.7, 6 + 6e-9, 1e-45, -1e-45, 3, 1 / 3, 1e30]) {
    for (const v of [x, Math.fround(x) * (1 + 2 ** -23), Math.fround(x) * (1 - 2 ** -23), 0]) {
      const f = Math.fround(v);
      assert.equal(below(f, x), f < x, `${f} < ${x}`);
      assert.equal(above(f, x), f > x, `${f} > ${x}`);
    }
  }
  assert.equal(paintEdge(2.5, true), 2.5, 'a float32 stays');
});

test('paintPlan cuts the triangles in order into pieces by corners and parts, a big item across several', () => {
  assert.deepEqual(paintPlan([5, 3], 9), [[[0, 0, 3]], [[0, 3, 2], [1, 0, 1]], [[1, 1, 2]]]);
  assert.deepEqual(paintPlan([2, 0, 1], 9), [[[0, 0, 2], [2, 0, 1]]], 'an item without triangles takes no part');
  assert.deepEqual(paintPlan([1, 1, 1], 99, 2), [[[0, 0, 1], [1, 0, 1]], [[2, 0, 1]]], 'at most 2 parts');
});

test('objectsUnder finds the items at and below the given paths, not siblings sharing a prefix', () => {
  const { s } = sync();
  s.apply({ meshes: [cube(1, { path: '/A/B' }), cube(2, { path: '/A/C/D' }), cube(3, { path: '/AB' })] });
  const paths = (list: THREE.Object3D[]) => list.map((o) => [...s.items.values()].find((i) => i.object === o)!.path).sort();
  assert.deepEqual(paths(s.objectsUnder(['/A'])), ['/A/B', '/A/C/D']);
  assert.deepEqual(paths(s.objectsUnder(['/A/C/D', '/AB'])), ['/A/C/D', '/AB']);
});
