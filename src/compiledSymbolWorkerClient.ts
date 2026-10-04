import { WorkerOperation, WorkerEvent } from './shared/identifiers';
import { Worker } from 'node:worker_threads';
import type { OutputChannel } from 'vscode';
import { workerPath } from './runtimePaths';
import { isRecord, isInteger } from './shared/guards';
import type { CompiledWorkerPayload, RttiClassDescriptor } from './shared/compiledProtocol';
import { isCompiledClassMap, isCompiledMethodArray, isCompiledPackageData } from './shared/compiledProtocol';

class CompiledSymbolWorkerClient {
  private worker: Worker | undefined;
  private nextId = 1;
  private readonly pending = new Map<number, { complete: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly context: { asAbsolutePath(relativePath: string): string }, private readonly output?: OutputChannel) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(workerPath('compiledSymbolWorker.js'));
    worker.on(WorkerEvent.Message, (message: unknown) => {
      if (!isRecord(message) || !isInteger(message.id)) return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      typeof message.error === 'string' ? request.reject(new Error(message.error)) : request.complete(message.value);
    });
    const fail = (error: Error) => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      if (this.worker === worker) this.worker = undefined;
    };
    worker.on(WorkerEvent.Error, fail);
    worker.on(WorkerEvent.Exit, code => {
      if (code !== 0) fail(new Error(`Compiled-symbol worker exited with code ${code}.`));
    });
    this.worker = worker;
    return worker;
  }

  private request<Result>(payload: CompiledWorkerPayload, validate: (value: unknown) => value is Result): Promise<Result> {
    const id = this.nextId++;
    return new Promise<Result>((resolve, reject) => {
      this.pending.set(id, {
        complete(value) {
          validate(value) ? resolve(value) : reject(new Error('Invalid compiled-symbol worker response.'));
        },
        reject
      });
      try {
        this.ensureWorker().postMessage({ id, ...payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  parseMangledClasses(text: string, bplPath: string) {
    return this.request({ operation: WorkerOperation.MangledClasses, text, bplPath }, isCompiledClassMap);
  }

  parsePackageIndex(text: string, bplPath: string) {
    return this.request({ operation: WorkerOperation.PackageIndex, text, bplPath }, isCompiledPackageData);
  }

  parseRttiMembers(text: string, classInfo: RttiClassDescriptor) {
    return this.request({ operation: WorkerOperation.RttiMembers, text, classInfo: {
      symbol: classInfo.symbol, namespace: classInfo.namespace,
      methods: (classInfo.methods || []).map(method => ({ name: method.name }))
    } }, isCompiledMethodArray);
  }

  dispose() {
    const worker = this.worker;
    this.worker = undefined;
    for (const request of this.pending.values()) request.reject(new Error('Compiled-symbol worker disposed.'));
    this.pending.clear();
    if (worker) void worker.terminate();
  }
}
export { CompiledSymbolWorkerClient };
