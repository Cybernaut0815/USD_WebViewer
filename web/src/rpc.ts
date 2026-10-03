import type { Boot, CoreApi, LogEntry, Response } from './protocol.ts';

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void };

/** Promise RPC to the wasm core's worker. Calls are answered strictly in order. */
export class CoreClient {
  readonly ready: Promise<{ usd: string; threads: number }>;
  onlog: (entry: LogEntry) => void = () => {};
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(coreUrl: URL | string, makeWorker = (url: URL) => new Worker(url, { type: 'module' })) {
    this.worker = makeWorker(new URL('worker.js', coreUrl));
    this.ready = new Promise((resolve, reject) => {
      this.worker.onmessage = (event: MessageEvent<Boot | Response>) => {
        const message = event.data;
        if ('ready' in message) return resolve(message.ready);
        if ('fatal' in message) return reject(new Error(message.fatal));
        message.log?.forEach((entry) => this.onlog(entry));
        const call = this.pending.get(message.id);
        if (!call) return;
        this.pending.delete(message.id);
        if ('error' in message) call.reject(new Error(message.error));
        else call.resolve(message.result);
      };
      this.worker.onerror = (event) => {
        const error = new Error(`core worker failed: ${event.message || 'could not load'}`);
        reject(error);
        this.failAll(error);
      };
    });
  }

  call<K extends keyof CoreApi>(method: K, ...args: Parameters<CoreApi[K]>): Promise<ReturnType<CoreApi[K]>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.failAll(new Error('core disposed'));
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }
}
