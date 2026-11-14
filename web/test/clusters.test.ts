import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three/webgpu';
import { clusterRaycast } from '../src/clusters.ts';

/** A rippled n x n quad grid, two triangles per quad, under a rotated and moved matrix. */
function grid(n: number): THREE.Mesh {
  const positions = new Float32Array((n + 1) * (n + 1) * 3);
  for (let y = 0, v = 0; y <= n; y++) for (let x = 0; x <= n; x++, v++) positions.set([x, y, Math.sin(x * 0.3) * Math.cos(y * 0.2)], v * 3);
  const indices = new Uint32Array(n * n * 6);
  for (let y = 0, k = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      indices.set([a, a + 1, a + n + 2, a, a + n + 2, a + n + 1], k);
      k += 6;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide }));
  mesh.rotation.set(0.3, -0.5, 0.2);
  mesh.position.set(5, -3, 2);
  mesh.updateMatrixWorld(true);
  return mesh;
}

const rays = (mesh: THREE.Mesh, count: number) =>
  Array.from({ length: count }, (_, i) => {
    const target = new THREE.Vector3((i * 37) % 512, (i * 91) % 512, 0).applyMatrix4(mesh.matrixWorld);
    const origin = target.clone().add(new THREE.Vector3(Math.sin(i), 3, Math.cos(i)).multiplyScalar(40));
    return new THREE.Raycaster(origin, target.clone().sub(origin).normalize());
  });

test('run boxes give the hits of a plain raycast: first hit, faceIndex and point', () => {
  const mesh = grid(512); // 524,288 triangles
  for (const raycaster of rays(mesh, 40)) {
    const plain: THREE.Intersection[] = [];
    THREE.Mesh.prototype.raycast.call(mesh, raycaster, plain);
    const fast: THREE.Intersection[] = [];
    clusterRaycast.call(mesh, raycaster, fast);
    plain.sort((a, b) => a.distance - b.distance);
    fast.sort((a, b) => a.distance - b.distance);
    assert.equal(fast.length > 0, plain.length > 0);
    if (!plain.length) continue;
    assert.equal(fast[0].faceIndex, plain[0].faceIndex);
    assert.ok(fast[0].point.distanceTo(plain[0].point) < 1e-9);
  }
  assert.deepEqual([mesh.geometry.drawRange.start, mesh.geometry.drawRange.count], [0, Infinity], 'the draw range is restored');
});

test('moved points rebuild the boxes; groups are honoured', () => {
  const mesh = grid(64);
  const g = mesh.geometry;
  g.addGroup(0, 64 * 6 * 32, 0); // the lower half only
  mesh.material = [mesh.material as THREE.Material];
  const raycaster = rays(mesh, 1)[0];
  const hits = (fn: (r: THREE.Raycaster, out: THREE.Intersection[]) => void) => {
    const out: THREE.Intersection[] = [];
    fn.call(mesh, raycaster, out);
    return out.map((h) => h.faceIndex).sort();
  };
  assert.deepEqual(hits(clusterRaycast), hits(THREE.Mesh.prototype.raycast));
  (g.attributes.position.array as Float32Array).forEach((_, i, a) => i % 3 === 2 && (a[i] += 10));
  g.attributes.position.needsUpdate = true;
  g.computeBoundingBox();
  g.computeBoundingSphere();
  assert.deepEqual(hits(clusterRaycast), hits(THREE.Mesh.prototype.raycast));
});
