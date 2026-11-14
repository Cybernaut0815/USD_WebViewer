// Raycasts of huge meshes through boxes around runs of triangles in index order. Exporters (CAD, scans) write
// triangles roughly in space order, so a ray tests the few runs whose box it meets instead of every triangle, with
// three's own triangle test: hits, faceIndex and sorting stay exactly those of Mesh.raycast.
// ponytail: index-order runs, no BVH; add one if a stage's triangle order turns out scrambled.
import * as THREE from 'three/webgpu';

/** Triangles per box. */
const RUN = 1024;
/** Meshes with more indices than this raycast through their runs (SceneSync.mesh sets it). */
export const CLUSTERED = 3 * 262_144;

const cache = new WeakMap<THREE.BufferGeometry, { version: number; index: THREE.BufferAttribute; boxes: Float32Array }>();
const inverse = new THREE.Matrix4();
const localRay = new THREE.Ray();
const box = new THREE.Box3();

/** min xyz, max xyz of each run of RUN triangles, made on the first raycast and again after the points move. */
function runBoxes(g: THREE.BufferGeometry): Float32Array {
  const position = g.attributes.position as THREE.BufferAttribute;
  const index = g.index!;
  const cached = cache.get(g);
  if (cached && cached.version === position.version && cached.index === index) return cached.boxes;
  const p = position.array as Float32Array;
  const indices = index.array;
  const corners = index.count - (index.count % 3);
  const boxes = new Float32Array(Math.ceil(corners / (3 * RUN)) * 6);
  for (let run = 0, k = 0; k < corners; run++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const end = Math.min(k + 3 * RUN, corners); k < end; k++) {
      const v = indices[k] * 3;
      const x = p[v], y = p[v + 1], z = p[v + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    boxes.set([x0, y0, z0, x1, y1, z1], run * 6);
  }
  cache.set(g, { version: position.version, index, boxes });
  return boxes;
}

/** A Mesh.raycast for huge indexed meshes: three's raycast, run on the draw ranges whose run box the ray meets. */
export function clusterRaycast(this: THREE.Mesh, raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
  const g = this.geometry;
  if (!g.index || !(g.attributes.position as THREE.BufferAttribute)?.isBufferAttribute) {
    THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
    return;
  }
  const boxes = runBoxes(g);
  localRay.copy(raycaster.ray).applyMatrix4(inverse.copy(this.matrixWorld).invert());
  const { start, count } = g.drawRange;
  try {
    for (let run = 0; run * 6 < boxes.length; run++) {
      if (!localRay.intersectsBox(box.set(box.min.fromArray(boxes, run * 6), box.max.fromArray(boxes, run * 6 + 3)))) continue;
      // The run within the geometry's own draw range; three intersects that with its groups.
      const from = Math.max(start, run * 3 * RUN), to = Math.min(start + count, (run + 1) * 3 * RUN);
      if (to <= from) continue;
      g.setDrawRange(from, to - from);
      THREE.Mesh.prototype.raycast.call(this, raycaster, intersects);
    }
  } finally {
    g.setDrawRange(start, count);
  }
}
