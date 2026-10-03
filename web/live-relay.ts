// Live-link relay: external programs PUT layers here, the viewer follows over server-sent events, and the
// viewer's own edits come back the same way. Mounted at /live/ by the dev server (vite.config.ts) or run
// alone:  node live-relay.ts [port]        (default 8765)
// Protocol and examples: docs/live.md. No dependencies.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

interface Layer {
  bytes: Buffer;
  type: string;
  version: number;
  origin: string; // X-Live-Origin of the pusher, so clients can skip their own pushes
}

const layers = new Map<string, Layer>();
const clients = new Set<ServerResponse>();
setInterval(() => clients.forEach((client) => client.write(': keep-alive\n\n')), 20_000).unref();

// The viewer page is cross-origin isolated (COEP require-corp) and may use a relay on another port.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, X-Live-Origin',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'X-Live-Version',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const event = (name: string, layer: Layer, replay = false) =>
  `event: layer\ndata: ${JSON.stringify({ name, version: layer.version, origin: layer.origin, type: layer.type, ...(replay && { replay }) })}\n\n`;

/** Answers requests under /live/ and returns true; false for any other URL, so the caller can pass it on. */
export function live(req: IncomingMessage, res: ServerResponse): boolean {
  const { pathname } = new URL(req.url ?? '/', 'http://relay');
  if (!pathname.startsWith('/live/')) return false;
  const path = pathname.slice('/live/'.length);
  const name = path.startsWith('layers/') ? decodeURIComponent(path.slice('layers/'.length)) : '';
  const send = (status: number, headers: Record<string, string> = {}, body?: Buffer | string) => {
    res.writeHead(status, { ...CORS, ...headers });
    res.end(body);
    return true;
  };
  if (req.method === 'OPTIONS') return send(204);
  if (req.method === 'GET' && path === 'events') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders(); // EventSource fires onopen even when there is nothing to replay
    for (const [n, layer] of layers) res.write(event(n, layer, true));
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return true;
  }
  if (path === 'layers' && req.method === 'GET') {
    const list = [...layers].map(([n, l]) => ({ name: n, version: l.version, origin: l.origin, type: l.type, size: l.bytes.length }));
    return send(200, { 'Content-Type': 'application/json' }, JSON.stringify(list));
  }
  if (req.method === 'DELETE') {
    if (name) layers.delete(name);
    else if (path === 'layers') layers.clear();
    else return send(404);
    return send(204);
  }
  if (!name) return send(404);
  if (req.method === 'GET') {
    const layer = layers.get(name);
    return layer ? send(200, { 'Content-Type': layer.type, 'X-Live-Version': String(layer.version) }, layer.bytes) : send(404);
  }
  if (req.method === 'PUT') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk)); // ponytail: no size limit, this is a localhost tool
    req.on('end', () => {
      const type = /usdc|octet-stream/.test(String(req.headers['content-type'])) ? 'application/usdc' : 'text/usda';
      const layer = { bytes: Buffer.concat(chunks), type, version: (layers.get(name)?.version ?? 0) + 1, origin: String(req.headers['x-live-origin'] ?? '') };
      layers.set(name, layer);
      for (const client of clients) client.write(event(name, layer));
      send(204);
    });
    return true;
  }
  return send(405);
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 8765);
  createServer((req, res) => live(req, res) || (res.writeHead(404), res.end())).listen(port, () => console.log(`live relay at http://localhost:${port}/live/`));
}
