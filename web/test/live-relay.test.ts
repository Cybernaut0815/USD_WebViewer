import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { live } from '../live-relay.ts';

const server = createServer((req, res) => live(req, res) || (res.writeHead(404), res.end()));
let base = '';
before(() => new Promise<void>((resolve) => server.listen(0, () => ((base = `http://localhost:${(server.address() as any).port}/live/`), resolve()))));
after(() => {
  server.closeAllConnections();
  server.close();
});

/** The next SSE message (up to the blank line) from an open stream. */
async function message(reader: ReadableStreamDefaultReader<Uint8Array>, buffer: { text: string }): Promise<string> {
  while (!buffer.text.includes('\n\n')) buffer.text += new TextDecoder().decode((await reader.read()).value);
  const [first, ...rest] = buffer.text.split('\n\n');
  buffer.text = rest.join('\n\n');
  return first;
}

test('PUT stores bytes and bumps the version, GET returns them, unknown names are 404, other URLs pass through', async () => {
  assert.equal((await fetch(base + 'layers/nope.usda')).status, 404);
  assert.equal((await fetch(base.replace('/live/', '/other'))).status, 404);
  const put = await fetch(base + 'layers/scene/a.usda', { method: 'PUT', body: '#usda 1.0\n', headers: { 'content-type': 'text/usda', 'x-live-origin': 'py' } });
  assert.equal(put.status, 204);
  const got = await fetch(base + 'layers/scene/a.usda');
  assert.equal(await got.text(), '#usda 1.0\n');
  assert.equal(got.headers.get('x-live-version'), '1');
  assert.equal(got.headers.get('access-control-allow-origin'), '*');
  await fetch(base + 'layers/scene/a.usda', { method: 'PUT', body: new Uint8Array([80, 88, 82]), headers: { 'content-type': 'application/octet-stream' } });
  assert.deepEqual(await (await fetch(base + 'layers')).json(), [{ name: 'scene/a.usda', version: 2, origin: '', type: 'application/usdc', size: 3 }]);
  assert.equal((await fetch(base + 'layers/x', { method: 'OPTIONS' })).status, 204);
});

test('events replays the stored layers on connect (marked), then streams every push; DELETE forgets', async () => {
  const abort = new AbortController();
  const reader = (await fetch(base + 'events', { signal: abort.signal })).body!.getReader();
  const buffer = { text: '' };
  assert.equal(await message(reader, buffer), 'event: layer\ndata: {"name":"scene/a.usda","version":2,"origin":"","type":"application/usdc","replay":true}');
  await fetch(base + 'layers/b.usda', { method: 'PUT', body: 'x', headers: { 'x-live-origin': 'viewer' } });
  assert.equal(await message(reader, buffer), 'event: layer\ndata: {"name":"b.usda","version":1,"origin":"viewer","type":"text/usda"}');
  abort.abort();
  assert.equal((await fetch(base + 'layers/b.usda', { method: 'DELETE' })).status, 204);
  assert.equal((await fetch(base + 'layers/b.usda')).status, 404);
  assert.equal((await fetch(base + 'layers', { method: 'DELETE' })).status, 204);
  assert.deepEqual(await (await fetch(base + 'layers')).json(), []);
});
