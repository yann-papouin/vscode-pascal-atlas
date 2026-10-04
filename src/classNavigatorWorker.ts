import { errorStack, errorMessage } from './shared/guards';
import { isNavigatorWorkerRequest } from './shared/navigator';
import type { NavigatorWorkerResponse } from './shared/navigator';
import { parentPort } from 'node:worker_threads';
import { buildClassNavigatorModel } from './classNavigator';

const port = parentPort;
if (!port) throw new Error('Class navigator worker requires a parent port.');
port.on('message', (request: unknown) => {
  const startedAt = Date.now();
  try {
    if (!isNavigatorWorkerRequest(request)) throw new Error('Invalid class navigator worker request.');
    const model = buildClassNavigatorModel(
      request.text,
      request.filePath,
      request.options || {}
    );
    const response: NavigatorWorkerResponse = { model, elapsedMs: Date.now() - startedAt };
    port.postMessage(response);
  } catch (error) {
    const response: NavigatorWorkerResponse = { error: errorStack(error) || errorMessage(error) || String(error) };
    port.postMessage(response);
  }
});
