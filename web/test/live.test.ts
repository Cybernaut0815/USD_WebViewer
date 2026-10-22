import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { UsdSession } from '../src/session.ts';

class FakeWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  posted: any[] = [];
  replies = new Map<string, unknown>();
  postMessage(message: any) {
    this.posted.push(message);
    const result = this.replies.has(message.method) ? this.replies.get(message.method) : {};
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, result } }));
  }
  terminate() {}
}

/** A relay as the page sees it: one EventSource per subscription, fetches recorded and answered at once. */
class FakeEventSource extends EventTarget {
  static open: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.open.push(this);
  }
  close() {
    this.closed = true;
  }
  push(data: object) {
    this.dispatchEvent(new MessageEvent('layer', { data: JSON.stringify(data) }));
  }
}
const fetches: { url: string; init?: RequestInit }[] = [];
(globalThis as any).EventSource = FakeEventSource;
globalThis.fetch = async (url: any, init?: RequestInit) => {
  fetches.push({ url: String(url), init });
  return new Response(new Uint8Array([35, 117, 115, 100, 97])); // "#usda"
};

function session() {
  const worker = new FakeWorker();
  const s = new UsdSession('http://host/core/', () => worker as any);
  worker.onmessage!({ data: { ready: { usd: 'x', threads: 1 } } });
  return { worker, s };
}

test('importLayer sends the bytes with a sniffed format, clears the undo history and takes the markers from the core', async () => {
  const { worker, s } = session();
  worker.replies.set('setAttribute', { ok: true, resynced: [], changed: ['/a'], previous: 1, dirty: ['/drop/1/geo.usda'] });
  await s.usd.setAttribute('/a', 'size', 2);
  assert.equal(s.commands.canUndo, true);
  worker.replies.set('importLayer', { ok: true, resynced: ['/a'], changed: ['/a', '/b'], dirty: ['/drop/1/geo.usda'] });
  await s.usd.importLayer('geo.usda', '#usda 1.0\n');
  await s.usd.importLayer('geo.usda', new TextEncoder().encode('PXR-USDC\0\0'), undefined, false);
  const calls = worker.posted.filter((m) => m.method === 'importLayer').map((m) => [m.args[0], new TextDecoder().decode(m.args[1]).slice(0, 8), m.args[2], m.args[3]]);
  assert.deepEqual(calls, [['geo.usda', '#usda 1.', 'usda', true], ['geo.usda', 'PXR-USDC', 'usdc', false]]);
  assert.equal(s.commands.canUndo, false);
  assert.deepEqual([...s.dirty], ['/drop/1/geo.usda']);
  assert.equal(s.changeState('/b'), 'self');
  worker.replies.set('importLayer', { ok: false, error: 'no layer named x.usda', resynced: [], dirty: [] });
  await assert.rejects(s.usd.importLayer('x.usda', '', 'usda', false), /no layer named/);
});

test('the live link subscribes per stage, applies pushes by name, skips its own echoes and replays of unknown layers, and publishes edits', async () => {
  const { worker, s } = session();
  worker.replies.set('importLayer', { ok: true, resynced: [], dirty: [] });
  worker.replies.set('listLayers', [{ identifier: '/drop/1/geo.usda', displayName: 'geo.usda', format: 'usda', anonymous: false, dirty: true, inStack: true, editTarget: true, session: false }]);
  worker.replies.set('exportLayer', new Uint8Array([1, 2]));
  s.live.publishDelay = 0;
  const applied: string[] = [];
  s.addEventListener('livechange', (e) => applied.push((e as CustomEvent).detail.name));

  s.live.connect('http://relay/live');
  assert.equal(s.live.connected, false, 'nothing to follow until a stage is open');
  s.stage = {} as any;
  s.emit('stageopen', {});
  assert.equal(s.live.connected, true);
  const source = FakeEventSource.open.at(-1)!;
  assert.equal(source.url, 'http://relay/live/events');

  source.push({ name: 'geo.usda', version: 1, origin: 'py' });
  source.push({ name: 'geo.usda', version: 2, origin: 'py' });
  source.push({ name: 'mat.usda', version: 1, origin: 'py' });
  source.push({ name: 'geo.usda', version: 3, origin: s.live.id });
  source.push({ name: 'old.usda', version: 7, origin: 'py', replay: true });
  await s.live.idle();
  await sleep(1);
  await s.live.idle();
  // The first geo push was already in flight when the second arrived; the rest coalesce per name.
  const gets = fetches.filter((f) => !f.init).map((f) => f.url.replace('http://relay/live/layers/', ''));
  assert.deepEqual(gets, ['geo.usda', 'geo.usda', 'mat.usda', 'old.usda']);
  const imports = worker.posted.filter((m) => m.method === 'importLayer').map((m) => [m.args[0], m.args[3]]);
  assert.deepEqual(imports, [['geo.usda', true], ['geo.usda', true], ['mat.usda', true], ['old.usda', false]]);
  assert.deepEqual(applied, ['geo.usda', 'geo.usda', 'mat.usda', 'old.usda']);
  assert.equal(fetches.filter((f) => f.init?.method === 'PUT').length, 0, 'applied pushes are not echoed back');

  // The viewer's own edit: the edit target is exported and PUT under its display name.
  s.emit('primschange', { resynced: [] });
  await sleep(5);
  await s.live.idle();
  const puts = fetches.filter((f) => f.init?.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, 'http://relay/live/layers/geo.usda');
  assert.equal((puts[0].init!.headers as Record<string, string>)['X-Live-Origin'], s.live.id);
  assert.deepEqual([...(puts[0].init!.body as Uint8Array)], [1, 2]);

  s.emit('stageclose', {});
  assert.equal(s.live.connected, false);
  assert.equal(source.closed, true);
  s.live.disconnect();
});
