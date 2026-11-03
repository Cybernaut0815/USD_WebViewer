// Sections on the GPU: every sectioned NodeMaterial runs one shared discard node first in its fragment stage, fed by
// one page-wide uniform array that each render fills for its own scene and camera. Nothing changes before the first
// section on the page: until then materials keep their cache keys and shaders.
import * as THREE from 'three/webgpu';
import { bool, Fn, frontFacing, Loop, positionView, renderGroup, select, uniformArray, vec3, vec4 } from 'three/tsl';
import { MAX, ROWS } from './section.ts';

/** NodeMaterial with the flag added below (its type is a default export, which `declare module` cannot extend). */
type Sectionable = THREE.NodeMaterial & {
  /** Runs the section's discard and greys back faces. Inherited false; section() sets it on what it registers. */
  section: boolean;
};

/** The packed section rows (stage space, see section.ts rows()) a scene draws with, and the group carrying stage space. */
export const SECTIONS = new WeakMap<THREE.Scene, { rows: Float64Array; root: THREE.Object3D }>();

const VECTORS = Array.from({ length: ROWS }, () => new THREE.Vector4());
const NONE = new Float64Array(4);
const viewToStage = new THREE.Matrix4();
/** Row i of the stage-space rows r times the view-to-stage matrix e (elements): the row tests view-space points. */
const view = (r: Float64Array, e: number[], i: number) => {
  const o = i * 4, a = r[o], b = r[o + 1], c = r[o + 2], d = r[o + 3];
  VECTORS[i].set(
    a * e[0] + b * e[1] + c * e[2] + d * e[3],
    a * e[4] + b * e[5] + c * e[6] + d * e[7],
    a * e[8] + b * e[9] + c * e[10] + d * e[11],
    a * e[12] + b * e[13] + c * e[14] + d * e[15],
  );
};
/**
 * The rows in view space for the render at hand, refilled once per render: each row times root⁻¹ · camera.matrixWorld
 * tests positionView directly. The header is always written, so a scene without a section draws whole whatever
 * another viewer on the page showed last. Only the Vector4s change: the array keeps its size and buffer, and nothing
 * is allocated.
 */
const DATA = uniformArray<'vec4'>(VECTORS, 'vec4')
  .setGroup(renderGroup)
  .onRenderUpdate(({ scene, camera }): undefined => {
    const entry = scene ? SECTIONS.get(scene) : undefined;
    const r = entry && camera ? entry.rows : NONE;
    VECTORS[0].fromArray(r);
    if (!entry || !camera) return;
    const e = viewToStage.copy(entry.root.matrixWorld).invert().multiply(camera.matrixWorld).elements;
    for (let i = 1; i <= r[0]; i++) view(r, e, i);
    for (let box = 0; box < r[1]; box++) {
      const at = 1 + MAX + box * 8;
      VECTORS[at].fromArray(r, at * 4); // meta: not a row
      for (let k = 1; k < 8; k++) view(r, e, at + k);
    }
  });

/**
 * True where the section shows the fragment (section.ts keeps() is the same test). Loops run to exactly the header's
 * counts and fold into one bool: no break, which Firefox's WGSL uniformity check refuses ahead of derivatives.
 */
const shows = Fn(() => {
  const header = DATA.element(0);
  const p = vec4(positionView, 1).toVar(); // assigned here, not where the first loop happens to read it
  const kept = (i: Parameters<typeof DATA.element>[0]) => DATA.element(i).dot(p).greaterThanEqual(0);
  const keep = bool(true).toVar();
  Loop(header.x.toInt(), ({ i }) => {
    keep.assign(keep.and(kept(i.add(1))));
  });
  const shown = header.z.lessThan(0.5).toVar(); // no 'inside' boxes: everything is shown
  Loop(header.y.toInt(), ({ i }) => {
    const at = i.mul(8).add(1 + MAX);
    const inside = kept(at.add(1))
      .and(kept(at.add(2)))
      .and(select(kept(at.add(3)), kept(at.add(4)).and(kept(at.add(5))), kept(at.add(6)).and(kept(at.add(7)))))
      .toVar();
    const show = DATA.element(at).x.greaterThan(0.5);
    shown.assign(shown.or(show.and(inside)));
    keep.assign(keep.and(show.or(inside.not())));
  });
  return keep.and(shown);
});
/**
 * The one discard every sectioned material runs first in its fragment stage: one shared node, built once. (A void
 * Fn() call would be a variable intent, which a stack skips unless it is assigned.)
 */
export const SECTION = shows().not().discard();

const ACTIVE = DATA.element(0).w.greaterThan(0.5);
/** Back faces while a section is on: flat, unlit (linear, before tone mapping). */
const GREY = vec3(0.2);

// ponytail: wraps two methods of three 0.186.1's NodeMaterial: setup() calls setupClipping() at the start of the
// fragment stage and setupOutput() for the final colour, and no subclass overrides either. Re-check both on a three
// upgrade; the e2e section goldens are the tripwire.
const proto = THREE.NodeMaterial.prototype as Sectionable;
const { setupClipping, setupOutput } = proto;
proto.section = false;
proto.setupClipping = function (this: Sectionable, builder) {
  const clipping = setupClipping.call(this, builder);
  if (this.section) (builder as unknown as { stack: { addToStack(node: unknown): void } }).stack.addToStack(SECTION);
  return clipping;
};
proto.setupOutput = function (this: Sectionable, builder, outputNode) {
  const out = setupOutput.call(this, builder, outputNode) as THREE.Node<'vec4'>;
  if (!this.section || this.transparent) return out;
  // Where the section opens a solid its back faces show: flat grey, so colours read on front faces only. The colour
  // goes into a variable first, so the select's branches hold no lighting: its texture reads need uniform control flow.
  const lit = out.toVar();
  return select(frontFacing.or(ACTIVE.not()), lit, vec4(GREY, lit.a));
};

const registered = new Set<Sectionable>();
let armed = false;

/**
 * Registers a material for sectioning and returns it. From the first section any viewer on the page shows, it runs
 * the section (one recompile). NodeMaterials only: others warn and are never sectioned.
 */
export function section<T extends THREE.Material>(material: T): T {
  if (!('isNodeMaterial' in material)) {
    console.warn(`usd-viewer: only NodeMaterials can be sectioned, not ${material.type}`);
    return material;
  }
  const m = material as unknown as Sectionable;
  if (!registered.has(m)) {
    registered.add(m);
    m.addEventListener('dispose', () => registered.delete(m));
  }
  if (armed && !m.section) {
    m.section = true;
    m.needsUpdate = true;
  }
  return material;
}

// ponytail: arming recompiles every drawn material on the next frame; prewarm with compileAsync if that hitch measures
// over ~250 ms. Planes could use hardware clip distances, fully cut objects could be culled (never through
// object.visible) and cut edges smoothed under MSAA: each only once a measurement asks for it.
/** Sections every registered material from now on. Page-wide and never undone: undoing would recompile them all again. */
export function arm(): void {
  if (armed) return;
  armed = true;
  for (const m of registered) {
    m.section = true;
    m.needsUpdate = true;
  }
}
