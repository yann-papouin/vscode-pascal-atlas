'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

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
    const response = await new Promise((resolve, reject) => {
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.postMessage({ text: source, filePath: 'WorkerSample.pas', options: {} });
    });
    assert.equal(response.error, undefined);
    assert.equal(response.model.roots.length, 1);
    assert.equal(response.model.roots[0].label, 'TWidget');
    assert.equal(response.model.roots[0].children[0].parent, response.model.roots[0]);
  } finally {
    await worker.terminate();
  }
});
