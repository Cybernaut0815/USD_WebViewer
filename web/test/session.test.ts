import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ctrlSelect, History, UsdSession } from '../src/session.ts';

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

function session() {
  const worker = new FakeWorker();
  const s = new UsdSession('http://host/core/', () => worker as any);
  worker.onmessage!({ data: { ready: { usd: 'x', threads: 1 } } });
  return { worker, s };
}

test('select posts setSelection then flush and tells listeners', async () => {
  const { worker, s } = session();
  const seen: unknown[] = [];
  s.addEventListener('selectionchange', (e) => seen.push((e as CustomEvent).detail));
  s.select(['/a'], 'hierarchy');
  await s.idle();
  assert.deepEqual(seen, [{ paths: ['/a'], source: 'hierarchy', active: '/a' }]);
  assert.deepEqual(worker.posted.map((m) => m.method), ['setSelection', 'flush']);
  assert.deepEqual(s.selection, ['/a']);
});

test('ctrl-click adds and activates, activates a selected prim, and deselects the active one', () => {
  const { s } = session();
  s.select(['/a']);
  ctrlSelect(s, '/b', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/a', '/b'], '/b']);
  ctrlSelect(s, '/a', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/a', '/b'], '/a']);
  ctrlSelect(s, '/a', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/b'], '/b']);
  s.select(['/c', '/d'], 'api', '/c');
  assert.equal(s.active, '/c');
});

test('locked prims cover their subtree and drop out of the selection', () => {
  const { s } = session();
  s.select(['/a/b', '/c']);
  s.setLocked('/a', true);
  assert.equal(s.isLocked('/a/b/c'), true);
  assert.equal(s.isLocked('/ab'), false);
  assert.deepEqual(s.selection, ['/c']);
});

test('edit rejects a failed edit and reports resynced prims otherwise', async () => {
  const { worker, s } = session();
  worker.replies.set('setVisible', { ok: false, error: 'nope', resynced: [] });
  await assert.rejects(s.usd.setVisible('/a', false), /nope/);
  worker.replies.set('setVisible', { ok: true, resynced: ['/a'] });
  const seen: unknown[] = [];
  s.addEventListener('primschange', (e) => seen.push((e as CustomEvent).detail));
  await s.usd.setVisible('/a', true);
  assert.deepEqual(seen, [{ resynced: ['/a'] }]);
});

test('undo re-authors what an edit replaced, or clears the opinion when there was none', async () => {
  const { worker, s } = session();
  const dirtyEvents: unknown[] = [];
  s.addEventListener('dirtychange', (e) => dirtyEvents.push((e as CustomEvent).detail.dirty));
  worker.replies.set('setAttribute', { ok: true, resynced: [], previous: 2, dirty: ['root.usda'] });
  await s.usd.setAttribute('/a', 'size', 3);
  assert.deepEqual([...s.dirty], ['root.usda']);
  await s.commands.undo();
  const sets = () => worker.posted.filter((m) => m.method === 'setAttribute').map((m) => m.args);
  assert.deepEqual(sets(), [['/a', 'size', '3', NaN], ['/a', 'size', '2', NaN]]);
  await s.commands.redo();
  assert.equal(sets().length, 3);
  worker.replies.set('setVisible', { ok: true, resynced: [], dirty: [] });
  worker.replies.set('clearAttribute', { ok: true, resynced: [], dirty: [] });
  await s.usd.setVisible('/a', false);
  assert.deepEqual([...s.dirty], []);
  await s.commands.undo();
  const clear = worker.posted.find((m) => m.method === 'clearAttribute');
  assert.deepEqual(clear.args, ['/a', 'visibility', NaN]);
  assert.deepEqual(dirtyEvents, [['root.usda'], []]);
});

test('a multi-prim transform is one command whose undo re-sends the previous matrices', async () => {
  const { worker, s } = session();
  const m = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  worker.replies.set('setXforms', { ok: true, resynced: [], previous: [m(1), m(2)], dirty: [] });
  await s.usd.setXforms([{ path: '/a', matrix: m(5) }, { path: '/b', matrix: m(6) }]);
  assert.equal(s.commands.canUndo, true);
  await s.commands.undo();
  const calls = worker.posted.filter((p) => p.method === 'setXforms').map((p) => JSON.parse(p.args[0]));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], [{ path: '/a', matrix: m(1) }, { path: '/b', matrix: m(2) }]);
});

test('history runs, undoes and redoes in order; a new command drops the redo list', async () => {
  const history = new History();
  const log: string[] = [];
  const command = (name: string) => ({ label: name, do: () => void log.push(`do ${name}`), undo: () => void log.push(`undo ${name}`) });
  await history.run(command('a'));
  await history.run(command('b'));
  await history.undo();
  assert.equal(history.canRedo, true);
  await history.run(command('c'));
  assert.equal(history.canRedo, false);
  await history.undo();
  await history.redo();
  assert.deepEqual(log, ['do a', 'do b', 'undo b', 'do c', 'undo c', 'do c']);
});
