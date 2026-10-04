import { errorStack, errorMessage, isRecord } from './shared/guards';
import { WorkerOperation, WorkerEvent } from './shared/identifiers';
import { parentPort } from 'node:worker_threads';
import { isCompiledWorkerRequest, type CompiledWorkerResult } from './shared/compiledProtocol';
import { parseTdumpClassNames, parseTdumpClassUnits, parseTdumpPackageIndex, parseTdumpMangledClasses, parseTdumpRttiMembers } from './binarySymbols';

const port = parentPort;
if (!port) throw new Error('Compiled-symbol worker requires a worker thread.');
port.on(WorkerEvent.Message, (message: unknown) => {
  try {
    if (!isCompiledWorkerRequest(message)) throw new Error(`Unknown compiled-symbol worker operation: ${isRecord(message) ? message.operation : undefined}`);
    let value: CompiledWorkerResult;
    switch (message.operation) {
      case WorkerOperation.MangledClasses: value = parseTdumpMangledClasses(message.text, message.bplPath); break;
      case WorkerOperation.PackageIndex: value = {
        names: parseTdumpClassNames(message.text), units: parseTdumpClassUnits(message.text),
        packageIndex: parseTdumpPackageIndex(message.text, message.bplPath), bplPath: message.bplPath
      }; break;
      case WorkerOperation.RttiMembers: value = parseTdumpRttiMembers(message.text, message.classInfo); break;
    }
    port.postMessage({ id: message.id, value });
  } catch (error) {
    port.postMessage({ id: isRecord(message) ? message.id : undefined, error: errorStack(error) || errorMessage(error) });
  }
});
