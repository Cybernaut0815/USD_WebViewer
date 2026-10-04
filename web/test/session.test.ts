import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasAncestorIn, History, modifySelect, selectUpWithSubtree, UsdSession } from '../src/session.ts';

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

test('shift adds and activates (or only activates a selected prim), ctrl removes and keeps the active prim', () => {
  const { s } = session();
  s.select(['/a']);
  modifySelect(s, ['/b'], 'add', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/a', '/b'], '/b']);
  modifySelect(s, ['/a'], 'add', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/a', '/b'], '/a']);
  modifySelect(s, ['/c', '/d'], 'add', 'viewport');
  assert.deepEqual([s.selection, s.active], [['/a', '/b', '/c', '/d'], '/d']);
  modifySelect(s, ['/b', '/c'], 'remove', 'viewport');
  assert.deepEqual([s.selection, s.active], [['/a', '/d'], '/d']);
  modifySelect(s, ['/d'], 'remove', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/a'], '/a']);
  modifySelect(s, ['/b'], 'replace', 'hierarchy');
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

test('open emits stageopen, the deltas, then stageloaded once the first flush is through', async () => {
  const { worker, s } = session();
  worker.replies.set('openStage', { ok: true, url: 'x.usda', upAxis: 'Y', metersPerUnit: 1, startTimeCode: 0, endTimeCode: 0, hasTimeRange: false, timeCodesPerSecond: 24, defaultPrim: null, layers: [] });
  const order: string[] = [];
  for (const type of ['stageopen', 'delta', 'stageloaded'] as const) s.addEventListener(type, () => order.push(type));
  await s.open('http://host/x.usda');
  assert.deepEqual(order, ['stageopen', 'delta', 'stageloaded']);
});

test('hasAncestorIn walks the path, not the set', () => {
  assert.equal(hasAncestorIn('/a/b', new Set(['/a'])), true);
  assert.equal(hasAncestorIn('/a/b', new Set(['/'])), true);
  assert.equal(hasAncestorIn('/a/b', new Set(['/ab', '/a/b', '/a/b/c'])), false);
  assert.equal(hasAncestorIn('/', new Set(['/'])), false);
});

test('edit rejects a failed edit and reports resynced prims otherwise', async () => {
  const { worker, s } = session();
  worker.replies.set('setVisible', { ok: false, error: 'nope', resynced: [] });
  await assert.rejects(s.usd.setVisible('/a', false), /nope/);
  worker.replies.set('setVisible', { ok: true, resynced: ['/a'] });
  const seen: unknown[] = [];
  s.addEventListener('primschange', (e) => seen.push((e as CustomEvent).detail));
  await s.usd.setVisible('/a', true);
  assert.deepEqual(seen, [{ resynced: ['/a'], touched: [], visibility: true }]);
});

test('the change markers follow the list the core reports after each edit', async () => {
  const { worker, s } = session();
  let events = 0;
  s.addEventListener('changedprims', () => events++);
  worker.replies.set('setAttribute', { ok: true, resynced: [], changed: ['/a/b'], previous: 2, dirty: ['root.usda'] });
  await s.usd.setAttribute('/a/b', 'size', 3);
  assert.deepEqual([s.changeState('/a/b'), s.changeState('/a'), s.changeState('/c')], ['self', 'below', null]);
  await s.usd.setAttribute('/a/b', 'size', 4); // same list: no new event
  assert.equal(events, 1);
  worker.replies.set('setAttribute', { ok: true, resynced: [], changed: [], dirty: [] }); // undo restored the original
  await s.commands.undo();
  assert.deepEqual([s.changeState('/a/b'), s.changeState('/a')], [null, null]);
  assert.equal(events, 2);
});

test('adding thousands of prims keeps order and the active prim, and stays fast', () => {
  const { s } = session();
  s.select(['/a', '/p0']);
  const many = Array.from({ length: 5000 }, (_, i) => `/p${i}`);
  const started = performance.now();
  modifySelect(s, many, 'add', 'api');
  modifySelect(s, many.slice(0, 2500), 'remove', 'api');
  assert.ok(performance.now() - started < 200, 'linear, not quadratic');
  assert.equal(s.selection.length, 1 + 2500);
  assert.deepEqual([s.selection[0], s.selection[1], s.active], ['/a', '/p2500', '/p4999']);
});

test('shift+alt climbs one level per click and takes the whole subtree there', async () => {
  const { worker, s } = session();
  const subtrees: Record<string, string[]> = {
    '/a/b': ['/a/b', '/a/b/c', '/a/b/d', '/a/b/d/e'],
    '/a': ['/a', '/a/b', '/a/b/c', '/a/b/d', '/a/b/d/e', '/a/x'],
  };
  worker.postMessage = function (message: any) {
    this.posted.push(message);
    const result = message.method === 'primSubtree' ? subtrees[message.args[0]] : {};
    queueMicrotask(() => this.onmessage?.({ data: { id: message.id, result } }));
  };
  await selectUpWithSubtree(s, '/a/b/c', 'viewport');
  assert.deepEqual([new Set(s.selection), s.active], [new Set(['/a/b/c', '/a/b', '/a/b/d', '/a/b/d/e']), '/a/b']);
  await selectUpWithSubtree(s, '/a/b/c', 'viewport');
  assert.deepEqual([s.selection.length, s.active], [6, '/a']);
});

test('shift+ctrl adds the nearest unselected ancestor, one level per click', () => {
  const { s } = session();
  s.select(['/a/b/c']);
  modifySelect(s, ['/a/b/c'], 'up', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/a/b/c', '/a/b'], '/a/b']);
  modifySelect(s, ['/a/b/c'], 'up', 'hierarchy');
  assert.deepEqual([s.selection, s.active], [['/a/b/c', '/a/b', '/a'], '/a']);
  modifySelect(s, ['/a/b/c'], 'up', 'hierarchy');
  assert.deepEqual(s.selection, ['/a/b/c', '/a/b', '/a']);
  s.select([]);
  modifySelect(s, ['/x/y'], 'up', 'viewport'); // an unselected prim: it and its parent
  assert.deepEqual([s.selection, s.active], [['/x/y', '/x'], '/x']);
});

test('hiding is one command whose undo sets the session layer back to what it held', async () => {
  const { worker, s } = session();
  worker.replies.set('sessionVisibility', { ok: true, resynced: [], previous: { '/a': null, '/b': 'invisible' }, dirty: [] });
  await s.usd.isolate(['/c']);
  await s.commands.undo();
  const calls = worker.posted.filter((p) => p.method === 'sessionVisibility').map((p) => p.args);
  assert.deepEqual(calls, [['isolate', '["/c"]'], ['set', '{"/a":null,"/b":"invisible"}']]);
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
