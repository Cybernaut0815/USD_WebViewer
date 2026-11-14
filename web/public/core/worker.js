// Worker glue around the wasm core. The only code that touches embind.
// Protocol: see web/src/protocol.ts.

let core;
let drops = 0;
const dropped = new Map(); // mounted path -> File, for reading a stage's root layer ahead (preload)

// The wasm downloads from the start, alongside the glue (on its own, the glue would ask for it only once loaded).
const WASM = new URL('usdcore.wasm', import.meta.url);
const wasm = fetch(WASM, { credentials: 'same-origin' });
let failed;
const failure = new Promise((_, reject) => (failed = reject)); // the glue waits forever on a failed instantiate
function instantiateWasm(imports, done) {
  WebAssembly.instantiateStreaming(wasm, imports)
    .catch(() => fetch(WASM).then((response) => response.arrayBuffer()).then((bytes) => WebAssembly.instantiate(bytes, imports))) // not served as application/wasm
    .then(({ instance, module }) => done(instance, module), failed);
  return {};
}

const boot = (async () => {
  const { default: createCore } = await import('./usdcore.js');
  core = await Promise.race([createCore({ instantiateWasm }), failure]);
  // ponytail: 4 measured faster than 8 for the mesh build (allocator contention); raise once mimalloc is measured.
  const threads = Math.min(4, navigator.hardwareConcurrency || 4);
  core.init(threads);
  postMessage({ ready: { usd: core.usdVersion(), threads } });
  // The first stage opened pays about 0.2 s for the plugin, schema and imaging registries: paid here, on a tiny stage,
  // before any request runs (they wait for boot), so the first open is that much faster.
  try {
    core.FS.writeFile('/tmp/warm.usda', '#usda 1.0\ndef Mesh "M" {}\n');
    core.openStage('/tmp/warm.usda', false);
    core.flush(1000);
    core.closeStage();
  } catch {}
  core.takeDiagnostics(); // not the page's
})();
boot.catch((error) => postMessage({ fatal: `USD core failed to start: ${error?.message ?? error}` }));

// Calls answered here instead of by the wasm module.
const local = {
  // Dropped files are mounted lazily (no copy until USD reads them) as plain paths.
  mount(files) {
    const dir = `/drop/${++drops}`;
    core.FS.mkdirTree(dir);
    local.remount(dir, files, false);
    return dir;
  },
  // The files behind a mount changed on disk: swap the Blobs, then reloadLayers re-reads them.
  remount(dir, files, mounted = true) {
    if (mounted) core.FS.unmount(dir);
    core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: files.map((f) => ({ name: f.path, data: f.file })) }, dir);
    for (const path of dropped.keys()) if (path.startsWith(`${dir}/`)) dropped.delete(path);
    for (const f of files) dropped.set(`${dir}/${f.path}`, f.file);
  },
};

// A big dropped root layer is read ahead, asynchronously with several reads in flight, into a block the core then
// opens: about 4x the throughput of the synchronous reads WORKERFS makes (FileReaderSync). Smaller files and
// sublayers are read by the core itself; so is this one if anything here fails.
const CHUNK = 64 << 20;
async function preload(path) {
  const file = dropped.get(path);
  if (!file || file.size < CHUNK) return;
  const handle = core.beginFile(path, file.size);
  if (!handle) return;
  let complete = false;
  try {
    let next = 0;
    const reader = async () => {
      while (next < file.size) {
        const at = next;
        next += CHUNK;
        const bytes = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
        if (!core.writeFile(handle, at, bytes)) throw new Error('not written');
      }
    };
    await Promise.all([reader(), reader(), reader(), reader()]);
    complete = true;
  } catch {}
  core.endFile(handle, complete);
}

const TEXT = new Set(['exportPrim']);

// Every typed array in a result owns a fresh buffer, so all of them can be transferred.
function buffers(value, out = []) {
  if (ArrayBuffer.isView(value)) out.push(value.buffer);
  else if (Array.isArray(value)) value.forEach((v) => buffers(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => buffers(v, out));
  return out;
}

// One call at a time, in order, also while a preload waits for its reads.
let queue = boot.catch(() => {});
onmessage = ({ data }) => (queue = queue.then(() => answer(data)));

async function answer({ id, method, args }) {
  try {
    await boot;
    let result;
    if (local[method]) result = local[method](...args);
    else {
      if (method === 'openStage') await preload(args[0]);
      result = core[method](...args);
      // Convention: every string the core returns is JSON, except exported USD text.
      if (typeof result === 'string' && !TEXT.has(method)) result = JSON.parse(result);
    }
    const log = JSON.parse(core.takeDiagnostics());
    postMessage({ id, result, log }, [...new Set(buffers(result))]);
  } catch (error) {
    postMessage({ id, error: String(error?.message ?? error) });
  }
}
