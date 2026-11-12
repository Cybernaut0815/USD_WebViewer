// Worker glue around the wasm core. The only code that touches embind.
// Protocol: see web/src/protocol.ts.

let core;
let drops = 0;

const boot = (async () => {
  const { default: createCore } = await import('./usdcore.js');
  core = await createCore();
  // ponytail: 4 measured faster than 8 for the mesh build (allocator contention); raise once mimalloc is measured.
  const threads = Math.min(4, navigator.hardwareConcurrency || 4);
  core.init(threads);
  return { usd: core.usdVersion(), threads };
})();
boot.then(
  (ready) => postMessage({ ready }),
  (error) => postMessage({ fatal: `USD core failed to start: ${error?.message ?? error}` }),
);

// The first stage opened pays about 0.2 s for the plugin, schema and imaging registries. A page that opens nothing at
// once (no src) pays it here instead, on a tiny stage half a second after the core is ready, so its first open is
// that much faster; one that opened a stage by then skips it.
let opened = false;
boot.then(() =>
  setTimeout(() => {
    if (opened) return;
    try {
      core.FS.writeFile('/tmp/warm.usda', '#usda 1.0\ndef Mesh "M" {}\n');
      core.openStage('/tmp/warm.usda', false);
      core.flush(1000);
      core.closeStage();
    } catch {}
    core.takeDiagnostics(); // not the page's
  }, 500),
);

// Calls answered here instead of by the wasm module.
const local = {
  // Dropped files are mounted lazily (no copy until USD reads them) as plain paths.
  mount(files) {
    const dir = `/drop/${++drops}`;
    core.FS.mkdirTree(dir);
    core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: files.map((f) => ({ name: f.path, data: f.file })) }, dir);
    return dir;
  },
  // The files behind a mount changed on disk: swap the Blobs, then reloadLayers re-reads them.
  remount(dir, files) {
    core.FS.unmount(dir);
    core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: files.map((f) => ({ name: f.path, data: f.file })) }, dir);
  },
};

const TEXT = new Set(['exportPrim']);

// Every typed array in a result owns a fresh buffer, so all of them can be transferred.
function buffers(value, out = []) {
  if (ArrayBuffer.isView(value)) out.push(value.buffer);
  else if (Array.isArray(value)) value.forEach((v) => buffers(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => buffers(v, out));
  return out;
}

onmessage = async ({ data: { id, method, args } }) => {
  try {
    await boot;
    if (method === 'openStage') opened = true;
    let result;
    if (local[method]) result = local[method](...args);
    else {
      result = core[method](...args);
      // Convention: every string the core returns is JSON, except exported USD text.
      if (typeof result === 'string' && !TEXT.has(method)) result = JSON.parse(result);
    }
    const log = JSON.parse(core.takeDiagnostics());
    postMessage({ id, result, log }, [...new Set(buffers(result))]);
  } catch (error) {
    postMessage({ id, error: String(error?.message ?? error) });
  }
};
