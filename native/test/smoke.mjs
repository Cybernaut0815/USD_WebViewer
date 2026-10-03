// Self-check of the wasm core under node:  node native/test/smoke.mjs [dir with usdcore.js]
// Each block opens a small inline stage and asserts on what the core reports.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? new URL('../../web/public/core', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { default: createCore } = await import(pathToFileURL(path.join(dir, 'usdcore.js')).href);
const started = performance.now();
const core = await createCore();
core.init(4);
console.log(`core ${core.usdVersion()} ready in ${Math.round(performance.now() - started)} ms`);

const names = new Map(); // rid -> path; only the creating entry carries the path
function open(name, text) {
  names.clear();
  core.FS.writeFile(`/tmp/${name}`, text);
  const info = JSON.parse(core.openStage(`/tmp/${name}`, true));
  assert.ok(info.ok, `${info.error}
${core.takeDiagnostics()}`);
  return info;
}
/** Everything pending, merged into one delta. */
function flush() {
  const all = {};
  for (;;) {
    const delta = core.flush(1000);
    for (const [key, value] of Object.entries(delta)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry.path) names.set(entry.rid, entry.path);
          else if (entry.rid) entry.path = names.get(entry.rid);
        }
        (all[key] ??= []).push(...value);
      } else if (key !== 'more') all[key] = value;
    }
    if (!delta.more) return all;
  }
}
const diagnostics = () => JSON.parse(core.takeDiagnostics());
const noErrors = () => assert.deepEqual(diagnostics().filter((d) => d.level === 'error'), []);

/* ---------- hierarchy, implicit shapes, time ---------- */
{
  const info = open('cube.usda', `#usda 1.0
(
    defaultPrim = "World"
    upAxis = "Z"
    startTimeCode = 1
    endTimeCode = 10
)
def Xform "World" (kind = "component")
{
    def Cube "Cube" (
        doc = "a cube"
        customData = { string note = "x"; int depth = 2 }
    )
    {
        double size = 2
        color3f[] primvars:displayColor = [(1, 0, 0)]
        double3 xformOp:translate.timeSamples = { 1: (0, 0, 0), 10: (9, 0, 0) }
        uniform token[] xformOpOrder = ["xformOp:translate"]
    }
    def DistantLight "Sun"
    {
        float inputs:intensity = 3
    }
    def Camera "Cam"
    {
        float focalLength = 35
    }
}`);
  assert.equal(info.upAxis, 'Z');
  assert.equal(info.hasTimeRange, true);
  assert.equal(info.defaultPrim, '/World');

  const roots = JSON.parse(core.primChildren('/'));
  assert.deepEqual(roots.map((p) => p.name), ['World']);
  assert.equal(roots[0].kind, 'component');
  assert.deepEqual(JSON.parse(core.primChildren('/World')).map((p) => p.typeName), ['Cube', 'DistantLight', 'Camera']);

  core.setTime(1);
  const first = flush();
  assert.equal(first.meshes.length, 1);
  const cube = first.meshes[0];
  assert.equal(cube.path, '/World/Cube');
  assert.equal(cube.indices.length, 36, 'a cube is 12 triangles');
  assert.equal(cube.edges.length, 24, 'a cube is drawn with its 12 face edges, no diagonals');
  assert.deepEqual(cube.counts, { points: 8, faces: 6, edges: 12 });
  assert.deepEqual(cube.displayColor, [1, 0, 0]);
  assert.equal(cube.instances, null);
  assert.equal(first.lights.length, 1);
  assert.equal(first.lights[0].type, 'distantLight');
  assert.equal(first.lights[0].params.intensity, 3);
  assert.equal(first.cameras[0].params.focalLength > 0, true);
  assert.ok(first.xforms.rids.includes(cube.rid));

  core.setTime(10);
  const moved = flush();
  assert.equal(moved.meshes, undefined, 'an animated transform must not resend geometry');
  const at = [...moved.xforms.rids].indexOf(cube.rid);
  assert.equal(moved.xforms.matrices[at * 16 + 12], 9);

  const details = JSON.parse(core.primDetails('/World/Cube', 10));
  assert.equal(details.summary.typeName, 'Cube');
  assert.equal(details.worldXform[12], 9);
  assert.equal(details.attributes.find((a) => a.name === 'size').value, 2);
  assert.equal(details.attributes.find((a) => a.name === 'size').variability, 'varying');
  assert.deepEqual(details.metadata.customData, { note: 'x', depth: 2 }, 'dictionaries nest');
  assert.equal(details.metadata.documentation, 'a cube');
  assert.equal(JSON.parse(core.primDetails('/World', 10)).metadata.kind, 'component');
  assert.equal(details.primvars.find((p) => p.name === 'displayColor').interpolation, 'constant');
  assert.equal(details.arcs[0].type, 'root');
  assert.equal(details.refinement, null, 'only meshes refine');
  assert.ok(core.exportPrim('/World', 'composed').includes('def Cube "Cube"'), 'composed export has the children');
  assert.ok(core.exportPrim('/World/Cube', 'authored').includes('double size = 2'));
  assert.deepEqual(JSON.parse(core.findPrims('cu', '', 10)), ['/World/Cube']);

  // Session-layer edit, then the same value read back.
  const edit = JSON.parse(core.setAttribute('/World/Cube', 'size', '4', NaN));
  assert.ok(edit.ok, edit.error);
  assert.deepEqual(edit.changed, ['/World/Cube'], 'the edited prim is reported for the change markers');
  const attr = (v) => JSON.parse(core.setAttribute('/World/Cube', 'size', String(v), NaN));
  assert.deepEqual(attr(2).changed, [], 'back to the value as opened: no longer changed');
  attr(5);
  const reverted = JSON.parse(core.revertPrim('/World/Cube'));
  assert.ok(reverted.ok, reverted.error);
  assert.equal(JSON.parse(core.attributeValue('/World/Cube', 'size', NaN)), 2, 'Clear edits restores the value as opened');
  assert.deepEqual(reverted.changed, []);
  const restored = JSON.parse(core.restorePrim(reverted.previous));
  assert.equal(JSON.parse(core.attributeValue('/World/Cube', 'size', NaN)), 5, 'undoing Clear edits brings the edit back');
  assert.deepEqual(restored.changed, ['/World/Cube']);
  core.revertPrim('/World/Cube');
  assert.equal(attr(4).changed.length, 1);
  assert.equal(JSON.parse(core.attributeValue('/World/Cube', 'size', NaN)), 4);
  assert.equal(flush().meshes.length, 1, 'the edit reaches the renderer');

  core.setSelection(['/World']);
  assert.deepEqual(flush().selected.map((s) => s.rid), [cube.rid]);
  assert.equal(JSON.parse(core.resolvePick(cube.rid, -1)).path, '/World/Cube');
  noErrors();
}

/* ---------- subdivision, subsets, materials ---------- */
{
  open('subdiv.usda', `#usda 1.0
def Xform "World"
{
    def Mesh "Box" (prepend apiSchemas = ["MaterialBindingAPI"])
    {
        token subdivisionScheme = "catmullClark"
        int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
        int[] faceVertexIndices = [0, 1, 3, 2, 2, 3, 5, 4, 4, 5, 7, 6, 6, 7, 1, 0, 1, 7, 5, 3, 6, 0, 2, 4]
        point3f[] points = [(-1, -1, 1), (1, -1, 1), (-1, 1, 1), (1, 1, 1), (-1, 1, -1), (1, 1, -1), (-1, -1, -1), (1, -1, -1)]
        texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1)] (interpolation = "faceVarying")
        int[] primvars:st:indices = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3]
        rel material:binding = </World/Looks/Red>
        custom bool refinementEnableOverride = 0
        def GeomSubset "top" (prepend apiSchemas = ["MaterialBindingAPI"])
        {
            uniform token elementType = "face"
            uniform token familyName = "materialBind"
            int[] indices = [1]
            rel material:binding = </World/Looks/Textured>
        }
    }
    def "Ref" (
        prepend references = </World/Box>
    )
    {
    }
    def Scope "Looks"
    {
        def Material "Red"
        {
            token outputs:surface.connect = </World/Looks/Red/Shader.outputs:surface>
            def Shader "Shader"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor = (1, 0, 0)
                float inputs:roughness = 0.25
                token outputs:surface
            }
        }
        def Material "Textured"
        {
            token outputs:surface.connect = </World/Looks/Textured/Shader.outputs:surface>
            def Shader "Shader"
            {
                uniform token info:id = "UsdPreviewSurface"
                color3f inputs:diffuseColor.connect = </World/Looks/Textured/Tex.outputs:rgb>
                token outputs:surface
            }
            def Shader "Tex"
            {
                uniform token info:id = "UsdUVTexture"
                asset inputs:file = @./missing.png@
                float2 inputs:st.connect = </World/Looks/Textured/Reader.outputs:result>
                float3 outputs:rgb
            }
            def Shader "Reader"
            {
                uniform token info:id = "UsdPrimvarReader_float2"
                string inputs:varname = "st"
                float2 outputs:result
            }
        }
    }
}`);
  core.setRefineLevel(-1); // the default is 0; Auto is opt-in
  const auto = flush();
  assert.equal(auto.refineLevel, 2, 'two small cages fit level 2 in the budget');
  assert.equal(auto.meshes.find((m) => m.path === '/World/Box').indices.length, 576, 'automatic refinement');
  core.setRefineLevel(0);
  const first = flush();
  assert.equal(first.refineLevel, 0);
  const box = first.meshes.find((m) => m.path === '/World/Box');
  assert.equal(box.indices.length, 36);
  assert.equal(box.edges.length, 24, 'face corners (faceVarying st) still give 12 edges, each once');
  assert.ok([...box.edges].every((i) => i < box.positions.length / 3), 'edges index the corner layout');
  assert.deepEqual(box.counts, { points: 8, faces: 6, edges: 12 });
  assert.equal(box.normals.length, box.positions.length, 'subdivision cages get smooth normals');
  assert.equal(box.primvars.find((p) => p.name === 'st').size, 2);

  const info = JSON.parse(core.primDetails('/World/Box', NaN));
  assert.deepEqual(info.metadata.apiSchemas, ['MaterialBindingAPI'], 'list ops come out applied');
  const st = info.primvars.find((p) => p.name === 'st');
  assert.equal(st.interpolation, 'faceVarying');
  assert.equal(st.indexed, true);
  assert.equal(st.indices.length, 24);
  assert.equal(info.attributes.find((a) => a.name === 'primvars:st').metadata.interpolation, 'faceVarying');
  assert.equal(info.attributes.find((a) => a.name === 'refinementEnableOverride').custom, true);
  assert.deepEqual(info.refinement, { enabled: false, level: 0 });
  assert.ok(JSON.parse(core.primDetails('/World/Ref', NaN)).arcs.some((a) => a.type === 'reference' && a.target === '/World/Box'));

  // Omniverse-style per-prim override wins over the global level and is authored in the layer.
  assert.ok(JSON.parse(core.setRefinement('/World/Box', true, 3)).ok);
  const own = flush().meshes.find((m) => m.path === '/World/Box');
  assert.equal(own.indices.length, 2304, '6 quads x 64 at level 3');
  assert.equal(own.subsets.find((s) => s.count === 384).count, 384, 'the subset quad refined 64 times');
  assert.deepEqual(JSON.parse(core.primDetails('/World/Box', NaN)).refinement, { enabled: true, level: 3 });
  assert.ok(core.exportPrim('/World/Box', 'authored').includes('custom int refinementLevel = 3'));
  assert.ok(JSON.parse(core.clearRefinement('/World/Box')).ok);
  assert.equal(flush().meshes.find((m) => m.path === '/World/Box').indices.length, 36);

  const materials = Object.fromEntries(auto.materials.map((m) => [m.path, m]));
  const red = materials['/World/Looks/Red'].network;
  assert.equal(red.nodes[red.surface].type, 'UsdPreviewSurface');
  assert.deepEqual(red.nodes[red.surface].params.diffuseColor, [1, 0, 0]);
  const textured = materials['/World/Looks/Textured'].network;
  const link = textured.nodes[textured.surface].inputs.diffuseColor;
  assert.equal(textured.nodes[link.node].type, 'UsdUVTexture');
  assert.equal(link.output, 'rgb');
  assert.equal(textured.nodes[link.node].params.file.asset, './missing.png');
  assert.deepEqual(materials['/World/Looks/Red'].textures, []);
  assert.deepEqual(materials['/World/Looks/Textured'].textures, ['./missing.png'], 'unresolved assets count by their authored path');

  assert.equal(box.subsets.length, 2, 'one subset plus the remaining faces');
  const top = box.subsets.find((s) => s.material === materials['/World/Looks/Textured'].rid);
  assert.equal(top.count, 6, 'one quad');
  assert.equal(box.subsets.reduce((sum, s) => sum + s.count, 0), 36);

  core.setRefineLevel(2);
  const refined = flush().meshes.find((m) => m.path === '/World/Box');
  assert.equal(refined.indices.length, 576, '6 quads -> 96 quads at level 2');
  assert.equal(refined.subsets.find((s) => s.material === top.material).count, 96, '16 refined quads');
  assert.equal(refined.edges.length, 12 * 4 * 2, 'only the cage edges, each split in 4, none inside a cage face');
  assert.deepEqual(refined.counts, box.counts, 'counts are the authored mesh');
  core.setRefineLevel(0);
  noErrors();
}

/* ---------- face edges of n-gons and holes ---------- */
{
  open('ngon.usda', `#usda 1.0
def Mesh "Shape"
{
    int[] faceVertexCounts = [5, 4]
    int[] faceVertexIndices = [0, 1, 2, 3, 4, 1, 5, 6, 2]
    int[] holeIndices = [1]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0.5, 1.5, 0), (0, 1, 0), (2, 0, 0), (2, 1, 0)]
}`);
  const shape = flush().meshes[0];
  assert.equal(shape.indices.length, 9, 'a pentagon is 3 triangles; the hole is not drawn');
  assert.deepEqual([...shape.edges].sort(), [0, 1, 1, 2, 2, 3, 3, 4, 4, 0].sort(), 'the pentagon outline, no fan diagonals');
  assert.deepEqual(shape.counts, { points: 7, faces: 1, edges: 5 });
  noErrors();
}

/* ---------- undoing a transform clears its change marker; Clear edits removes added specs ---------- */
{
  open('xf.usda', `#usda 1.0
def Xform "T"
{
    double3 xformOp:translate = (1, 2, 3)
    uniform token[] xformOpOrder = ["xformOp:translate"]
    def Cube "Child" {}
}`);
  flush();
  const m = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const moved = JSON.parse(core.setXform('/T', m(5, 0, 0), NaN));
  assert.deepEqual(moved.changed, ['/T']);
  assert.deepEqual(JSON.parse(core.setXform('/T', moved.previous, NaN)).changed, [], 'the undo path leaves nothing marked');
  // A new attribute on the child, then Clear edits on the parent: the subtree goes back, the spec is gone.
  core.setAttribute('/T/Child', 'size', '3', NaN);
  core.setXform('/T', m(7, 0, 0), NaN);
  const cleared = JSON.parse(core.revertPrim('/T'));
  assert.deepEqual(cleared.changed, []);
  assert.deepEqual(JSON.parse(core.attributeValue('/T', 'xformOp:translate', NaN)), [1, 2, 3]);
  assert.ok(!core.exportPrim('/T', 'authored').includes('size'), 'the added attribute is gone');
  noErrors();
}

/* ---------- isolating a large selection stays linear ---------- */
{
  const groups = Array.from({ length: 40 }, (_, g) => `    def Xform "G${g}"\n    {\n${Array.from({ length: 50 }, (_, c) => `        def Cube "C${c}" {}`).join('\n')}\n    }`);
  open('many.usda', `#usda 1.0\ndef Xform "World"\n{\n${groups.join('\n')}\n}`);
  flush();
  // Keep 30 cubes in each of the first 30 groups: 900 selected prims.
  const keep = Array.from({ length: 30 }, (_, g) => Array.from({ length: 30 }, (_, c) => `/World/G${g}/C${c}`)).flat();
  const started = performance.now();
  const edit = JSON.parse(core.sessionVisibility('isolate', JSON.stringify(keep)));
  const ms = performance.now() - started;
  assert.ok(edit.ok, edit.error);
  const hidden = Object.keys(edit.previous);
  assert.equal(hidden.length, 30 * 20 + 10, '20 siblings in each kept group, plus the 10 other groups');
  assert.ok(hidden.includes('/World/G0/C30') && hidden.includes('/World/G39') && !hidden.includes('/World/G0/C0'));
  assert.ok(ms < 2000, `isolate took ${Math.round(ms)} ms`);
  noErrors();
}

/* ---------- viewer hiding in the session layer ---------- */
{
  open('hide.usda', `#usda 1.0
def Xform "World"
{
    def Cube "A" {}
    def Cube "B" {}
    def Xform "G"
    {
        def Cube "C" {}
        def Cube "D" {}
    }
    def Material "M" {}
}`);
  flush();
  const visible = (parent) => Object.fromEntries(JSON.parse(core.primChildren(parent)).map((p) => [p.name, p.visible]));
  const run = (mode, value) => {
    const edit = JSON.parse(core.sessionVisibility(mode, JSON.stringify(value)));
    assert.ok(edit.ok, edit.error);
    assert.deepEqual(edit.dirty, [], 'the session layer is never saved');
    assert.deepEqual(edit.changed, [], 'viewer hiding is not a change');
    return edit.previous;
  };
  assert.deepEqual(run('hide', ['/World/A']), { '/World/A': null });
  assert.deepEqual(visible('/World'), { A: false, B: true, G: true, M: true });
  const isolated = run('isolate', ['/World/G/C']);
  assert.deepEqual(isolated, { '/World/A': 'invisible', '/World/B': null, '/World/G/D': null }, 'imageable siblings along the chain only');
  assert.deepEqual(visible('/World'), { A: false, B: false, G: true, M: true });
  assert.deepEqual(visible('/World/G'), { C: true, D: false });
  run('set', isolated); // undo
  assert.deepEqual(visible('/World'), { A: false, B: true, G: true, M: true });
  assert.deepEqual(visible('/World/G'), { C: true, D: true });
  assert.deepEqual(run('showAll', null), { '/World/A': 'invisible' });
  assert.deepEqual(visible('/World'), { A: true, B: true, G: true, M: true });
  run('hide', ['/World/G']);
  assert.deepEqual(JSON.parse(core.primVisibility(JSON.stringify(['/World/G/C', '/World/A', '/World/M', '/nope']))), [false, true, true, true], 'computed: inherited from G');
  run('showAll', null);
  run('hide', ['/World/B']);
  const rootText = new TextDecoder().decode(core.exportLayer('/tmp/hide.usda', 'usda'));
  assert.ok(rootText.includes('def Cube "B"') && !rootText.includes('visibility'), 'the root layer stays untouched');
  noErrors();
}

/* ---------- automatic refinement policy ---------- */
{
  open('schemes.usda', `#usda 1.0
def Mesh "Bilinear"
{
    uniform token subdivisionScheme = "bilinear"
    int[] faceVertexCounts = [4]
    int[] faceVertexIndices = [0, 1, 2, 3]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
}
def Mesh "LoopTri"
{
    uniform token subdivisionScheme = "loop"
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
}
def Mesh "LoopQuad"
{
    uniform token subdivisionScheme = "loop"
    int[] faceVertexCounts = [4]
    int[] faceVertexIndices = [0, 1, 2, 3]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0)]
}
def Mesh "Omni"
{
    int[] faceVertexCounts = [4, 4, 4, 4, 4, 4]
    int[] faceVertexIndices = [0, 1, 3, 2, 2, 3, 5, 4, 4, 5, 7, 6, 6, 7, 1, 0, 1, 7, 5, 3, 6, 0, 2, 4]
    point3f[] points = [(-1, -1, 1), (1, -1, 1), (-1, 1, 1), (1, 1, 1), (-1, 1, -1), (1, 1, -1), (-1, -1, -1), (1, -1, -1)]
    custom bool refinementEnableOverride = 1
    custom int refinementLevel = 1
}`);
  core.setRefineLevel(-1);
  const by = Object.fromEntries(flush().meshes.map((m) => [m.path, m.indices.length]));
  assert.equal(by['/Bilinear'], 6, 'bilinear is its own limit surface');
  assert.equal(by['/LoopTri'], 48, 'loop triangle at the automatic level 2');
  assert.equal(by['/LoopQuad'], 6, 'loop needs triangles: cage');
  assert.equal(by['/Omni'], 144, 'Omniverse attributes: level 1 regardless of the global level');
  noErrors();

  // A big cage: 310 x 310 quads only fit level 1 under the budget.
  const n = 310;
  const points = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) points.push(`(${x}, ${y}, 0)`);
  const counts = Array(n * n).fill(4).join(', ');
  const indices = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) indices.push(y * (n + 1) + x, y * (n + 1) + x + 1, (y + 1) * (n + 1) + x + 1, (y + 1) * (n + 1) + x);
  open('grid.usda', `#usda 1.0
def Mesh "Grid"
{
    int[] faceVertexCounts = [${counts}]
    int[] faceVertexIndices = [${indices.join(', ')}]
    point3f[] points = [${points.join(', ')}]
}`);
  const grid = flush();
  assert.equal(grid.refineLevel, 1);
  assert.equal(grid.meshes[0].indices.length, n * n * 4 * 6);
  core.setRefineLevel(0);
  noErrors();
}

/* ---------- instancing, curves, points ---------- */
{
  open('instances.usda', `#usda 1.0
def Xform "World"
{
    def PointInstancer "Outer"
    {
        point3f[] positions = [(0, 0, 0), (0, 10, 0)]
        int[] protoIndices = [0, 0]
        rel prototypes = </World/Outer/Inner>
        def PointInstancer "Inner"
        {
            point3f[] positions = [(0, 0, 0), (2, 0, 0), (4, 0, 0)]
            int[] protoIndices = [0, 0, 0]
            rel prototypes = </World/Outer/Inner/Proto>
            def Cube "Proto"
            {
                double size = 1
            }
        }
    }
    def BasisCurves "Curve"
    {
        uniform token type = "cubic"
        uniform token basis = "bezier"
        int[] curveVertexCounts = [4]
        point3f[] points = [(0, 0, 0), (1, 2, 0), (2, 2, 0), (3, 0, 0)]
        float[] widths = [0.1] (interpolation = "constant")
    }
    def Points "Dots"
    {
        point3f[] points = [(0, 0, 5), (1, 0, 5)]
        float[] widths = [0.2, 0.4]
    }
}`);
  const delta = flush();
  const proto = delta.meshes[0];
  assert.equal(proto.instances.length, 96, 'nested 2 x 3 instances');
  // Outer instance 1, inner instance 2: translated by (4, 10, 0).
  assert.deepEqual([...proto.instances.slice(5 * 16 + 12, 5 * 16 + 15)], [4, 10, 0]);
  const pick = JSON.parse(core.resolvePick(proto.rid, 5));
  assert.equal(pick.path, '/World/Outer');
  assert.equal(pick.instanceIndex, 1);

  const curve = delta.curves[0];
  assert.deepEqual([...curve.counts], [5], 'one bezier segment, 4 samples plus the end point');
  assert.deepEqual([...curve.points.slice(12, 15)], [3, 0, 0]);
  assert.equal(curve.widths.length, 5);

  const dots = delta.points[0];
  assert.equal(dots.points.length, 6);
  assert.deepEqual([...dots.widths].map((w) => +w.toFixed(1)), [0.2, 0.4]);
  noErrors();
}

/* ---------- animated points keep the vertex layout ---------- */
{
  open('deform.usda', `#usda 1.0
(
    startTimeCode = 1
    endTimeCode = 2
)
def Mesh "Quad"
{
    uniform token subdivisionScheme = "none"
    int[] faceVertexCounts = [4, 4]
    int[] faceVertexIndices = [0, 1, 2, 3, 1, 4, 5, 2]
    point3f[] points.timeSamples = {
        1: [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (2, 0, 0), (2, 1, 0)],
        2: [(0, 0, 0), (1, 0, 0), (1, 1, 5), (0, 1, 0), (2, 0, 0), (2, 1, 0)],
    }
    texCoord2f[] primvars:st = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0), (1, 0), (1, 1), (0, 1)] (
        interpolation = "faceVarying"
    )
}`);
  core.setTime(1);
  const first = flush().meshes[0];
  core.setTime(2);
  const second = flush().meshes[0];
  assert.equal(second.indices, undefined, 'moving points must not resend topology');
  assert.equal(second.primvars, undefined, 'nor texture coordinates');
  assert.equal(first.positions.length, 8 * 3, 'faceVarying data needs one vertex per face corner');
  assert.equal(second.positions.length, first.positions.length, 'same vertex layout on every frame');
  assert.equal(second.positions[2 * 3 + 2], 5);
  noErrors();
}

/* ---------- editing: transforms, undo information, layers ---------- */
{
  const info = open('edit.usda', `#usda 1.0
(
    defaultPrim = "World"
    startTimeCode = 1
    endTimeCode = 10
)
def Xform "World"
{
    def Xform "A"
    {
        float3 xformOp:translate = (1, 0, 0)
        float3 xformOp:rotateXYZ = (0, 90, 0)
        float3 xformOp:scale = (2, 2, 2)
        uniform token[] xformOpOrder = ["xformOp:translate", "xformOp:rotateXYZ", "xformOp:scale"]
        def Cube "B"
        {
            double3 xformOp:translate = (0, 1, 0)
            uniform token[] xformOpOrder = ["xformOp:translate"]
        }
    }
    def Xform "M"
    {
        matrix4d xformOp:transform = ( (1, 0, 0, 0), (0, 1, 0, 0), (0, 0, 1, 0), (5, 0, 0, 1) )
        uniform token[] xformOpOrder = ["xformOp:transform"]
    }
    def Xform "Odd"
    {
        float xformOp:rotateY = 30
        uniform token[] xformOpOrder = ["xformOp:rotateY"]
    }
    def Xform "Spin"
    {
        float3 xformOp:rotateZXY.timeSamples = { 1: (0, 0, 0), 10: (0, 90, 0) }
        uniform token[] xformOpOrder = ["xformOp:rotateZXY"]
    }
    def Xform "Plain"
    {
        def Cube "Geo" {}
    }
    def Xform "Inst" (
        instanceable = true
        references = </World/Plain>
    )
    {
    }
}`);
  flush();
  const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const near = (a, b, eps = 1e-4) => assert.ok(a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps), `${a} != ${b}`);
  const local = (path, t = NaN) => JSON.parse(core.xformInfo(path, t)).local;

  const b = JSON.parse(core.xformInfo('/World/A/B', NaN));
  assert.equal(b.path, '/World/A/B');
  near(b.local.slice(12, 15), [0, 1, 0]);
  near(b.world.slice(12, 15), [1, 2, 0], 1e-4); // scaled by 2, turned about Y, moved by (1, 0, 0)
  assert.equal(core.xformInfo('/World', NaN) !== 'null', true, 'an Xform without ops is still xformable');
  assert.equal(core.xformInfo('/World/A/B.nope', NaN), 'null');

  // A translate-only stack keeps its single op (double precision) and gets no rotate or scale.
  let edit = JSON.parse(core.setXform('/World/A/B', translate(3, 4, 5), NaN));
  assert.ok(edit.ok, edit.error);
  near(edit.previous.slice(12, 15), [0, 1, 0]);
  assert.deepEqual(edit.dirty, ['/tmp/edit.usda'], 'the root layer is the edit target');
  let authored = core.exportPrim('/World/A/B', 'authored');
  assert.ok(authored.includes('double3 xformOp:translate = (3, 4, 5)'), authored);
  assert.ok(!authored.includes('rotateXYZ') && !authored.includes('xformOp:transform:edit'), authored);
  near(local('/World/A/B'), translate(3, 4, 5));

  // A float TRS stack is rewritten in float, rotation included.
  const c = Math.SQRT1_2;
  const target = [c, 0, -c, 0, 0, 1, 0, 0, c, 0, c, 0, 7, 8, 9, 1]; // 45 degrees about Y, then translate
  edit = JSON.parse(core.setXform('/World/A', target, NaN));
  assert.ok(edit.ok, edit.error);
  near(local('/World/A'), target);
  authored = core.exportPrim('/World/A', 'authored');
  assert.ok(authored.includes('float3 xformOp:translate = (7, 8, 9)'), authored);
  assert.ok(!authored.includes('xformOp:transform:edit'), authored);
  near(JSON.parse(core.attributeValue('/World/A', 'xformOp:rotateXYZ', NaN)), [0, 45, 0], 1e-3);
  near(JSON.parse(core.attributeValue('/World/A', 'xformOp:scale', NaN)), [1, 1, 1], 1e-5);

  // A lone matrix op is set directly.
  edit = JSON.parse(core.setXform('/World/M', translate(1, 2, 3), NaN));
  assert.ok(edit.ok, edit.error);
  near(JSON.parse(core.attributeValue('/World/M', 'xformOp:transform', NaN)), translate(1, 2, 3));

  // Anything else gets a leading edit transform; the existing op is untouched.
  edit = JSON.parse(core.setXform('/World/Odd', translate(1, 2, 3), NaN));
  assert.ok(edit.ok, edit.error);
  near(local('/World/Odd'), translate(1, 2, 3));
  authored = core.exportPrim('/World/Odd', 'authored');
  assert.ok(authored.includes('float xformOp:rotateY = 30'), authored);
  assert.ok(authored.includes('xformOpOrder = ["xformOp:transform:edit", "xformOp:rotateY"]'), authored);
  edit = JSON.parse(core.setXform('/World/Odd', translate(4, 5, 6), NaN)); // a second edit reuses the op
  near(local('/World/Odd'), translate(4, 5, 6));
  assert.equal((core.exportPrim('/World/Odd', 'authored').match(/transform:edit/g) || []).length, 2, 'declared once, ordered once');

  // Animated ops get a sample at the frame; other frames keep their values.
  edit = JSON.parse(core.setXform('/World/Spin', translate(0, 0, 2), 5));
  assert.ok(edit.ok, edit.error);
  near(local('/World/Spin', 5), translate(0, 0, 2));
  // The rotation keeps its keys (a third one was added); the new translate op has one key, which holds everywhere.
  near(local('/World/Spin', 1).slice(0, 12), translate(0, 0, 0).slice(0, 12));
  near(local('/World/Spin', 10).slice(0, 3), [0, 0, -1], 1e-4); // still turned 90 degrees about Y at frame 10
  const spin = JSON.parse(core.primDetails('/World/Spin', 5));
  assert.equal(spin.attributes.find((a) => a.name === 'xformOp:rotateZXY').timeSamples, 3);

  // `previous` undoes a move; instance proxies edit their instance.
  edit = JSON.parse(core.setXform('/World/A/B', translate(9, 9, 9), NaN));
  edit = JSON.parse(core.setXform('/World/A/B', edit.previous, NaN));
  near(local('/World/A/B'), translate(3, 4, 5));
  assert.equal(JSON.parse(core.xformInfo('/World/Inst/Geo', NaN)).path, '/World/Inst');
  edit = JSON.parse(core.setXform('/World/Inst/Geo', translate(1, 1, 1), NaN));
  assert.ok(edit.ok, edit.error);
  near(local('/World/Inst'), translate(1, 1, 1));

  // Visibility and refinement report what they replaced.
  edit = JSON.parse(core.setVisible('/World/A', false));
  assert.equal(edit.previous, undefined, 'no earlier opinion');
  edit = JSON.parse(core.setVisible('/World/A', true));
  assert.equal(edit.previous, 'invisible');
  edit = JSON.parse(core.clearAttribute('/World/A', 'visibility', NaN));
  assert.ok(edit.ok, edit.error);
  assert.equal(edit.previous, 'inherited');
  assert.equal(JSON.parse(core.primDetails('/World/A', NaN)).attributes.find((a) => a.name === 'visibility').authored, false);
  edit = JSON.parse(core.setRefinement('/World/A/B', true, 2));
  assert.equal(edit.previous, undefined);
  edit = JSON.parse(core.setRefinement('/World/A/B', false, 1));
  assert.deepEqual(edit.previous, { enabled: true, level: 2 });
  edit = JSON.parse(core.clearRefinement('/World/A/B'));
  assert.deepEqual(edit.previous, { enabled: false, level: 1 });

  // Layers: the local stack first, export in both formats, edit target switching, reload.
  let layers = JSON.parse(core.listLayers());
  assert.equal(layers.length, 2);
  assert.ok(layers[0].session && layers[0].anonymous && layers[0].inStack && !layers[0].editTarget);
  assert.ok(layers[1].identifier === '/tmp/edit.usda' && layers[1].editTarget && layers[1].dirty && layers[1].format === 'usda');
  const text = new TextDecoder().decode(core.exportLayer('/tmp/edit.usda', 'usda'));
  assert.ok(text.includes('xformOp:transform:edit'), 'the export carries the edits');
  const binary = core.exportLayer('/tmp/edit.usda', 'usdc');
  assert.equal(new TextDecoder().decode(binary.slice(0, 8)), 'PXR-USDC');
  assert.ok(new TextDecoder().decode(core.exportLayer('', 'flat')).includes('def Xform "World"'));
  assert.equal(core.exportLayer('/nope.usda', 'usda'), null);
  assert.ok(JSON.parse(core.setEditTarget(layers[0].identifier)).ok);
  edit = JSON.parse(core.setVisible('/World/M', false));
  assert.deepEqual(edit.dirty, ['/tmp/edit.usda'], 'session edits never count as unsaved');
  assert.ok(core.exportPrim('/World/M', 'authored').includes('visibility = "invisible"'), 'authored export follows the edit target');
  assert.ok(!JSON.parse(core.setEditTarget('/nope.usda')).ok);
  assert.ok(JSON.parse(core.setEditTarget('/tmp/edit.usda')).ok);
  layers = JSON.parse(core.listLayers());
  assert.ok(layers[1].editTarget);
  edit = JSON.parse(core.reloadLayers([]));
  assert.ok(edit.ok, edit.error);
  assert.deepEqual(edit.dirty, []);
  near(local('/World/M'), translate(5, 0, 0));
  near(local('/World/A/B'), translate(0, 1, 0));
  assert.ok(JSON.parse(core.listLayers())[1].dirty === false);

  // Several prims in one edit (a multi-selection drag), with the old matrices for undo.
  const entries = (a, b) => JSON.stringify([{ path: '/World/A/B', matrix: a }, { path: '/World/M', matrix: b }]);
  edit = JSON.parse(core.setXforms(entries(translate(1, 1, 1), translate(2, 2, 2)), NaN));
  assert.ok(edit.ok, edit.error);
  assert.equal(edit.previous.length, 2);
  near(edit.previous[0].slice(12, 15), [0, 1, 0]);
  near(edit.previous[1].slice(12, 15), [5, 0, 0]);
  near(local('/World/A/B'), translate(1, 1, 1));
  near(local('/World/M'), translate(2, 2, 2));
  edit = JSON.parse(core.setXforms(entries(edit.previous[0], edit.previous[1]), NaN));
  assert.ok(edit.ok, edit.error);
  near(local('/World/M'), translate(5, 0, 0));
  edit = JSON.parse(core.setXforms(JSON.stringify([{ path: '/World/Nope', matrix: translate(1, 1, 1) }, { path: '/World/M', matrix: translate(9, 9, 9) }]), NaN));
  assert.ok(!edit.ok && edit.error.includes('/World/Nope'));
  near(local('/World/M'), translate(5, 0, 0), 1e-4);
  assert.ok(!JSON.parse(core.setXforms('{"not":"an array"}', NaN)).ok);
  noErrors();
}

core.closeStage();
console.log('smoke test passed');
process.exit(0); // the thread pool keeps node alive otherwise
