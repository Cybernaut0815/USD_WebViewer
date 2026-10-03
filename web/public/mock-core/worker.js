// A fake core that speaks the worker protocol (web/src/protocol.ts) with a tiny
// built-in scene. Lets the page be developed and tested without the wasm build:
// open the app with ?core=mock-core/&src=mock.usda

const CUBE = (() => {
  // 24 vertices (4 per face) so normals are per face.
  const faces = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  const positions = [], normals = [], uvs = [], indices = [], edges = []; // edges: face outlines
  faces.forEach(([n, u, v], f) => {
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      positions.push(...n.map((c, i) => (c + a * u[i] + b * v[i]) * 0.5));
      normals.push(...n);
      uvs.push((a + 1) / 2, (b + 1) / 2);
    }
    indices.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
    edges.push(f * 4, f * 4 + 1, f * 4 + 1, f * 4 + 2, f * 4 + 2, f * 4 + 3, f * 4 + 3, f * 4);
  });
  return { positions, normals, uvs, indices, edges };
})();

const translate = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const PRIMS = {
  '/': ['World'],
  '/World': ['Cube', 'Instances', 'Big', 'Light'],
  '/World/Big': Array.from({ length: 50000 }, (_, i) => `Child_${i}`),
};
const TYPES = { '/World': 'Xform', '/World/Cube': 'Mesh', '/World/Instances': 'PointInstancer', '/World/Big': 'Scope', '/World/Light': 'DistantLight' };

let open = false, time = 1, sent = false, timeDirty = false, selection = null, visible = true, visDirty = false;
let sessionHidden = false; // the cube's session-layer visibility opinion

function summary(path) {
  const name = path.split('/').pop();
  return {
    name, path, typeName: TYPES[path] ?? 'Scope', kind: path === '/World' ? 'assembly' : '',
    hasChildren: !!PRIMS[path], active: true, visible: path === '/World/Cube' ? visible && !sessionHidden : true,
    isInstance: false, hasPayload: false, loaded: true, hasVariantSets: false,
  };
}

let cubeOffset = 0; // authored by setXform
let rootLayer = 'mock.usda', dirty = false, reloads = 0;
const edited = () => { dirty = true; return { ok: true, resynced: [], changed: ['/World/Cube'], dirty: [rootLayer] }; };
const cubeMatrix = () => translate(Math.sin((time - 1) / 47 * Math.PI * 2) + cubeOffset, 0, 0);

const api = {
  mount: () => '/drop/1',
  registerScheme() {},
  openStage(url) {
    open = true; sent = false; time = 1; rootLayer = url; dirty = false; cubeOffset = 0;
    return { ok: true, url, upAxis: 'Y', metersPerUnit: 1, startTimeCode: 1, endTimeCode: 48, hasTimeRange: true, timeCodesPerSecond: 24, defaultPrim: '/World', layers: [url] };
  },
  closeStage() { open = false; },
  reloadStage: () => ({ ok: true, resynced: ['/'], dirty: [] }),
  primSubtree(path, limit) {
    const out = [];
    const walk = (p) => {
      if (out.length >= limit) return;
      out.push(p);
      for (const name of PRIMS[p] ?? []) walk(`${p}/${name}`);
    };
    if (path !== '/') walk(path);
    return out;
  },
  primVisibility: (json) => JSON.parse(json).map((path) => summary(path).visible),
  primChildren: (path) => (PRIMS[path] ?? []).map((name) => summary(path === '/' ? `/${name}` : `${path}/${name}`)),
  primDetails: (path) => ({
    summary: summary(path), specifier: 'def', purpose: 'default',
    metadata: path === '/World' ? { kind: 'assembly', customData: { note: 'mock', nested: { depth: 2 } } } : {},
    appliedSchemas: [],
    attributes: [{ name: 'size', typeName: 'double', value: 1, authored: true, timeSamples: 0, custom: false, variability: 'varying', metadata: { documentation: 'edge length' } },
      { name: 'faceVertexCounts', typeName: 'int[]', value: [4, 4, 4], authored: true, timeSamples: 0, custom: false, variability: 'varying', metadata: {} }],
    primvars: [{ name: 'displayColor', typeName: 'color3f[]', interpolation: 'constant', elementSize: 1, indexed: false, value: [[0.8, 0.2, 0.2]], authored: true }],
    arcs: [{ type: 'root', layer: '', introducedAt: '', target: path, targetLayer: 'mock.usda', ancestral: false, implicit: false, hasSpecs: true }],
    refinement: TYPES[path] === 'Mesh' ? { enabled: false, level: 0 } : null,
    relationships: [], variantSets: [], boundMaterial: null, worldXform: translate(0, 0, 0), worldBounds: null, primStack: [{ layer: 'mock.usda', path }],
  }),
  exportPrim: (path) => `def Xform "${path.split('/').pop()}"\n{\n}\n`,
  setRefinement: () => edited(),
  clearRefinement: () => edited(),
  clearRefinementOverrides: () => edited(),
  attributeValue: (path, name) => (name === 'faceVertexCounts' ? [4, 4, 4] : name === 'primvars:displayColor' ? [[0.8, 0.2, 0.2]] : 1),
  findPrims: (text, type, limit) => Object.keys(TYPES).filter((p) => p.includes(text) && (!type || TYPES[p] === type)).slice(0, limit),
  readAsset: () => null,
  setTime(t) { time = Number.isNaN(t) ? 1 : t; timeDirty = true; },
  setRefineLevel() {},
  setRefineBudget() {},
  flush() {
    if (!open) return {};
    const delta = {};
    if (!sent) {
      sent = true;
      const instances = new Float32Array([...translate(-2, 0, 2), ...translate(0, 0, 2), ...translate(2, 0, 2)]);
      const cube = () => ({
        indices: new Uint32Array(CUBE.indices), positions: new Float32Array(CUBE.positions), normals: new Float32Array(CUBE.normals),
        edges: new Uint32Array(CUBE.edges), counts: { points: 8, faces: 6, edges: 12 },
        primvars: [{ name: 'st', size: 2, data: new Float32Array(CUBE.uvs) }],
      });
      delta.meshes = [
        { rid: 1, path: '/World/Cube', purpose: 'default', ...cube(), displayColor: [0.8, 0.2, 0.2], subsets: null, material: 0, instances: null },
        { rid: 2, path: '/World/Instances/Proto', purpose: 'default', ...cube(), displayColor: [0.2, 0.5, 0.9], subsets: null, material: 0, instances },
      ];
      // A sine-shaped ribbon, a hairline and a row of sized points.
      const wave = Array.from({ length: 33 }, (_, i) => [i / 8 - 2, 1.2 + 0.3 * Math.sin(i / 3), 0]).flat();
      delta.curves = [
        { rid: 4, path: '/World/Ribbon', purpose: 'default', points: new Float32Array(wave), counts: new Uint32Array([33]),
          widths: new Float32Array(Array.from({ length: 33 }, (_, i) => 0.05 + 0.15 * (i / 32))), colors: null, displayColor: [0.2, 0.8, 0.3] },
        { rid: 5, path: '/World/Hair', purpose: 'default', points: new Float32Array(wave.map((v, i) => (i % 3 === 1 ? v + 0.6 : v))),
          counts: new Uint32Array([33]), widths: null, colors: null, displayColor: [1, 1, 1] },
      ];
      delta.points = [
        { rid: 6, path: '/World/Dots', purpose: 'default', points: new Float32Array([-2, 2.6, 0, -1, 2.6, 0, 0, 2.6, 0, 1, 2.6, 0, 2, 2.6, 0]),
          widths: new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]), colors: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1]) },
      ];
      delta.lights = [{ rid: 3, path: '/World/Light', type: 'distantLight', params: { color: [1, 1, 1], intensity: 3, exposure: 0, normalize: true, diffuse: 1, specular: 1, angle: 0.53, shadow: true } }];
      delta.xforms = { rids: new Uint32Array([1, 3, 4, 5, 6]), matrices: new Float64Array([...cubeMatrix(), ...[1, 0, 0, 0, 0, 0.7, -0.7, 0, 0, 0.7, 0.7, 0, 0, 0, 0, 1], ...translate(0, 0, 0), ...translate(0, 0, 0), ...translate(0, 0, 0)]) };
    } else if (timeDirty) {
      delta.xforms = { rids: new Uint32Array([1]), matrices: new Float64Array(cubeMatrix()) };
    }
    timeDirty = false;
    if (visDirty) { delta.visibility = { rids: new Uint32Array([1]), visible: new Uint8Array([visible && !sessionHidden ? 1 : 0]) }; visDirty = false; }
    if (selection) {
      delta.selected = [];
      for (const p of selection) {
        if ('/World/Cube'.startsWith(p)) delta.selected.push({ rid: 1 });
        const m = /^\/World\/Instances(?:\/(\d))?$/.exec(p);
        if (m || p === '/World') delta.selected.push(m?.[1] ? { rid: 2, instances: new Uint32Array([Number(m[1])]) } : { rid: 2 });
      }
      selection = null;
    }
    return delta;
  },
  setSelection(paths) { selection = paths; },
  resolvePick: (rid, instance) => (rid === 1 ? { path: '/World/Cube' } : { path: '/World/Instances', instancer: '/World/Instances', instanceIndex: instance }),
  setVariant: () => ({ ok: true, resynced: [], dirty: [] }),
  setVisible(path, v) { if (path === '/World/Cube') { visible = v; visDirty = true; } return edited(); },
  // Only the cube can be hidden here; the real core handles every imageable prim.
  sessionVisibility(mode, json) {
    const value = JSON.parse(json);
    const previous = { '/World/Cube': sessionHidden ? 'invisible' : null };
    const keeps = (paths) => paths.some((p) => '/World/Cube'.startsWith(p));
    if (mode === 'hide' && value.includes('/World/Cube')) sessionHidden = true;
    else if (mode === 'isolate' && !keeps(value)) sessionHidden = true;
    else if (mode === 'showAll') sessionHidden = false;
    else if (mode === 'set' && '/World/Cube' in value) sessionHidden = value['/World/Cube'] === 'invisible';
    else return { ok: true, resynced: [], previous: {}, dirty: dirty ? [rootLayer] : [] };
    visDirty = true;
    return { ok: true, resynced: [], previous, dirty: dirty ? [rootLayer] : [] };
  },
  setLoaded: () => ({ ok: true, resynced: [], dirty: [] }),
  // The mock has no snapshot: Clear edits just reports the cube as unchanged again.
  revertPrim: () => ({ ok: true, resynced: [], changed: [], previous: 1, dirty: dirty ? [rootLayer] : [] }),
  restorePrim: () => edited(),
  resetChanges() {},
  setAttribute: () => edited(),
  clearAttribute: () => edited(),
  clearSessionEdits: () => ({ ok: true, resynced: [], dirty: [] }),
  xformInfo: (path) => (path === '/World/Cube' ? { path, local: cubeMatrix(), parent: translate(0, 0, 0), world: cubeMatrix(), resets: false } : null),
  setXform(path, m) {
    if (path !== '/World/Cube') return { ok: false, error: 'not xformable', resynced: [], dirty: [] };
    const previous = cubeMatrix();
    cubeOffset = m[12] - Math.sin((time - 1) / 47 * Math.PI * 2);
    timeDirty = true;
    return { ...edited(), previous };
  },
  setXforms(json, t) {
    const entries = JSON.parse(json);
    const cube = entries.find((e) => e.path === '/World/Cube');
    if (!cube) return { ok: false, error: 'not xformable', resynced: [], dirty: [] };
    const result = api.setXform('/World/Cube', cube.matrix, t);
    return { ...result, previous: entries.map(() => result.previous) };
  },
  listLayers: () => [{ identifier: rootLayer, displayName: 'mock.usda', format: 'usda', anonymous: false, dirty, inStack: true, editTarget: true, session: false }],
  setEditTarget: () => ({ ok: true, resynced: [], dirty: [] }),
  exportLayer: () => new TextEncoder().encode(`#usda 1.0\n# cube offset ${cubeOffset}\n`),
  reloadLayers() { dirty = false; return { ok: true, resynced: ['/'], dirty: [] }; },
  remount() {},
};

function buffers(value, out = []) {
  if (ArrayBuffer.isView(value)) out.push(value.buffer);
  else if (Array.isArray(value)) value.forEach((v) => buffers(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => buffers(v, out));
  return out;
}

onmessage = ({ data: { id, method, args } }) => {
  try {
    const result = api[method](...args);
    postMessage({ id, result }, [...new Set(buffers(result))]);
  } catch (error) {
    postMessage({ id, error: String(error?.message ?? error) });
  }
};
postMessage({ ready: { usd: 'mock', threads: 1 } });
