import type { NavigatorWorkerResponse } from '../src/shared/navigator';
import { required } from './helpers';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test as test } from 'node:test';
import { Worker } from 'node:worker_threads';

test('large-file class navigation model is transferable from a worker', async () => {
  const worker = new Worker(path.resolve(__dirname, '..', 'src', 'classNavigatorWorker.js'));
  try {
    const source = `unit WorkerSample;
interface
type
  TWidgetClass = class of TWidget;
  TWidget = class
  public
    procedure Run;
  end;
implementation
procedure TWidget.Run;
begin
end;
end.
`;
    const response = await new Promise<NavigatorWorkerResponse>((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage({ text: source, filePath: 'WorkerSample.pas', options: {} });
    });
    assert.equal(response.error, undefined);
    assert.equal(required(response.model).roots.length, 1);
    assert.equal(response.model.roots[0].label, 'TWidget');
    assert.equal(response.model.roots[0].children[0].parent, response.model.roots[0]);
  } finally {
    await worker.terminate();
  }
});
