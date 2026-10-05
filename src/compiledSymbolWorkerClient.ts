import { WorkerOperation, WorkerEvent } from "./shared/identifiers"
import { Worker } from "node:worker_threads"
import type { OutputChannel } from "vscode"
import { workerPath } from "./runtimePaths"
import { isRecord, isInteger } from "./shared/guards"
import type {
  CompiledWorkerPayload,
  RttiClassDescriptor,
} from "./shared/compiledProtocol"
import {
  isCompiledClassMap,
  isCompiledMethodArray,
  isCompiledPackageData,
} from "./shared/compiledProtocol"

class CompiledSymbolWorkerClient {
  private worker: Worker | undefined
  private nextId = 1
  private readonly pending = new Map<
    number,
    { complete: (value: unknown) => void; reject: (error: Error) => void }
  >()

  /** Create a lazy compiled-symbol worker client with per-request promise tracking. */
  constructor(
    private readonly context: {
      /** Resolve a resource path relative to the installed extension root. */
      asAbsolutePath(relativePath: string): string
    },
    private readonly output?: OutputChannel,
  ) {}

  /**
   * Start or reuse the parser worker, route correlated replies, and reject outstanding
   * requests when the worker errors or exits unsuccessfully.
   */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const worker = new Worker(workerPath("compiledSymbolWorker.js"))
    worker.on(
      WorkerEvent.Message,
      /**
       * Match the reply envelope to a pending request; its completion callback validates
       * the result payload.
       */ (message: unknown) => {
        if (!isRecord(message) || !isInteger(message.id)) return
        const request = this.pending.get(message.id)
        if (!request) return
        // Consume a request before completing it so duplicate or late worker replies cannot settle the same promise twice.
        this.pending.delete(message.id)
        typeof message.error === "string"
          ? request.reject(new Error(message.error))
          : request.complete(message.value)
      },
    )
    /**
     * Reject every outstanding parse request after worker failure and release the
     * failed worker so a later request can restart it.
     */
    const fail = (error: Error) => {
      // Worker failure must settle every caller; leaving promises pending would strand interactive lookups.
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
      if (this.worker === worker) this.worker = undefined
    }
    worker.on(WorkerEvent.Error, fail)
    worker.on(
      WorkerEvent.Exit,
      /**
       * Reject outstanding parse requests when the worker exits with a nonzero status.
       */ (code) => {
        if (code !== 0)
          fail(new Error(`Compiled-symbol worker exited with code ${code}.`))
      },
    )
    this.worker = worker
    return worker
  }

  /**
   * Post a correlated parse operation and resolve only a validated result; reject
   * malformed replies or synchronous worker-launch/post failures.
   */
  private request<Result>(
    payload: CompiledWorkerPayload,
    validate: (value: unknown) => value is Result,
  ): Promise<Result> {
    const id = this.nextId++
    return new Promise<Result>(
      /**
       * Connect asynchronous completion and rejection to the compiled symbol worker
       * client request promise.
       */ (resolve, reject) => {
        this.pending.set(id, {
          /**
           * Validate a worker result for this operation before resolving the caller's
           * typed parsing promise.
           */
          complete(value) {
            validate(value)
              ? resolve(value)
              : reject(new Error("Invalid compiled-symbol worker response."))
          },
          reject,
        })
        try {
          this.ensureWorker().postMessage({ id, ...payload })
        } catch (error) {
          this.pending.delete(id)
          reject(error)
        }
      },
    )
  }

  /**
   * Parse mangled package symbols off-thread and return a validated class/interface
   * Map.
   */
  parseMangledClasses(text: string, bplPath: string) {
    return this.request(
      { operation: WorkerOperation.MangledClasses, text, bplPath },
      isCompiledClassMap,
    )
  }

  /**
   * Build a validated package symbol index off-thread while preserving transferred
   * nested Maps and Sets.
   */
  parsePackageIndex(text: string, bplPath: string) {
    return this.request(
      { operation: WorkerOperation.PackageIndex, text, bplPath },
      isCompiledPackageData,
    )
  }

  /**
   * Parse RTTI members off-thread using only the class identity and known method names
   * required by the worker.
   */
  parseRttiMembers(text: string, classInfo: RttiClassDescriptor) {
    return this.request(
      {
        operation: WorkerOperation.RttiMembers,
        text,
        classInfo: {
          symbol: classInfo.symbol,
          namespace: classInfo.namespace,
          methods: (classInfo.methods || []).map(
            /**
             * Transfer only the known method names needed to reconcile RTTI members.
             */ (method) => ({ name: method.name }),
          ),
        },
      },
      isCompiledMethodArray,
    )
  }

  /**
   * Reject pending parse promises, clear correlation state, and terminate the active
   * worker without waiting for its final exit event.
   */
  dispose() {
    const worker = this.worker
    this.worker = undefined
    for (const request of this.pending.values())
      request.reject(new Error("Compiled-symbol worker disposed."))
    this.pending.clear()
    if (worker) void worker.terminate()
  }
}
export { CompiledSymbolWorkerClient }
