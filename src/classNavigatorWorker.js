'use strict';

const { parentPort } = require('node:worker_threads');
const { buildClassNavigatorModel } = require('./classNavigator');

parentPort.on('message', request => {
  const startedAt = Date.now();
  try {
    const model = buildClassNavigatorModel(
      request.text,
      request.filePath,
      request.options || {}
    );
    parentPort.postMessage({ model, elapsedMs: Date.now() - startedAt });
  } catch (error) {
    parentPort.postMessage({ error: error.stack || error.message || String(error) });
  }
});
