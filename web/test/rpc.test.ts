import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CoreClient } from '../src/rpc.ts';

class FakeWorker {
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  posted: any[] = [];
  transfers: any[][] = [];
  postMessage(message: any, transfer: any[] = []) {
    this.posted.push(message);
    this.transfers.push(transfer);
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

test("an export's arrays are transferred (each buffer once), other calls' copied", () => {
  const { worker, core } = client();
  const floats = new Float32Array(8), ints = new Int32Array(floats.buffer, 0, 2); // one buffer twice: listed once
  void core.call('exportVariants', '{}', floats, ints);
  void core.call('importLayer', 'x', new Uint8Array(4), 'usda', false);
  assert.deepEqual(worker.transfers, [[floats.buffer], []]);
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
