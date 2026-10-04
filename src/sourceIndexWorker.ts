import { WorkerEvent } from './shared/identifiers';
import { errorStack, errorMessage, isInteger, isRecord } from './shared/guards';
import { parentPort } from 'node:worker_threads';
import { parseSourceUnitSymbols } from './usesQuickFix';

const port = parentPort;
if (!port) throw new Error('Source-index worker requires a worker thread.');
port.on(WorkerEvent.Message, (message: unknown) => {
  try {
    if (!isRecord(message) || !isInteger(message.id) || typeof message.text !== 'string' || typeof message.filePath !== 'string') throw new Error('Invalid source-index worker request.');
    port.postMessage({ id: message.id, unit: parseSourceUnitSymbols(message.text, message.filePath) });
  } catch (error) {
    port.postMessage({ id: isRecord(message) ? message.id : undefined, error: errorStack(error) || errorMessage(error) });
  }
});
