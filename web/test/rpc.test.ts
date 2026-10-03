import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreClient } from '../src/rpc.ts';

class FakeWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  posted: any[] = [];
  postMessage(message: any) {
    this.posted.push(message);
  }
  terminate() {}
  reply(data: any) {
    this.onmessage!({ data });
  }
}

function client() {
  const worker = new FakeWorker();
  return { worker, core: new CoreClient('http://host/core/', () => worker as any) };
}

test('answers are matched to calls by id, in any order', async () => {
  const { worker, core } = client();
  worker.reply({ ready: { usd: 'x', threads: 1 } });
  assert.deepEqual(await core.ready, { usd: 'x', threads: 1 });
  const a = core.call('primChildren', '/');
  const b = core.call('findPrims', 'x', '', 1);
  worker.reply({ id: worker.posted[1].id, result: ['/x'] });
  worker.reply({ id: worker.posted[0].id, result: [] });
  assert.deepEqual(await a, []);
  assert.deepEqual(await b, ['/x']);
});

test('errors reject the call and logs are forwarded', async () => {
  const { worker, core } = client();
  const seen: string[] = [];
  core.onlog = (entry) => seen.push(entry.message);
  const call = core.call('closeStage');
  worker.reply({ id: worker.posted[0].id, error: 'boom', log: [{ level: 'warn', message: 'careful' }] });
  await assert.rejects(call, /boom/);
  assert.deepEqual(seen, ['careful']);
});

test('a worker failure rejects everything pending', async () => {
  const { worker, core } = client();
  const call = core.call('closeStage');
  worker.onerror!({ message: 'gone' });
  await assert.rejects(call, /gone/);
  await assert.rejects(core.ready, /gone/);
});
