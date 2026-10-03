// Worker glue around the wasm core. The only code that touches embind.
// Protocol: see web/src/protocol.ts.

let core;
let drops = 0;

const boot = (async () => {
  const { default: createCore } = await import('./usdcore.js');
  core = await createCore();
  const threads = Math.min(8, navigator.hardwareConcurrency || 4);
  core.init(threads);
  return { usd: core.usdVersion(), threads };
})();
boot.then(
  (ready) => postMessage({ ready }),
  (error) => postMessage({ fatal: `USD core failed to start: ${error?.message ?? error}` }),
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
