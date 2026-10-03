'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');

class CompiledSymbolWorkerClient {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.worker = undefined;
    this.nextId = 1;
    this.pending = new Map();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    const worker = new Worker(this.context.asAbsolutePath(path.join('src', 'compiledSymbolWorker.js')));
    worker.on('message', message => {
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      message.error ? request.reject(new Error(message.error)) : request.resolve(message.value);
    });
    const fail = error => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      if (this.worker === worker) this.worker = undefined;
    };
    worker.on('error', fail);
    worker.on('exit', code => {
      if (code !== 0) fail(new Error(`Compiled-symbol worker exited with code ${code}.`));
    });
    this.worker = worker;
    return worker;
  }

  request(operation, payload) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ensureWorker().postMessage({ id, operation, ...payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  parseMangledClasses(text, bplPath) {
    return this.request('mangledClasses', { text, bplPath });
  }

  parsePackageIndex(text, bplPath) {
    return this.request('packageIndex', { text, bplPath });
  }

  parseRttiMembers(text, classInfo) {
    return this.request('rttiMembers', {
      text,
      classInfo: {
        symbol: classInfo.symbol,
        namespace: classInfo.namespace,
        methods: (classInfo.methods || []).map(method => ({ name: method.name }))
      }
    });
  }

  dispose() {
    const worker = this.worker;
    this.worker = undefined;
    for (const request of this.pending.values()) {
      request.reject(new Error('Compiled-symbol worker disposed.'));
    }
    this.pending.clear();
    if (worker) void worker.terminate();
  }
}

module.exports = { CompiledSymbolWorkerClient };
