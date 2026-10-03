'use strict';

const { parentPort } = require('node:worker_threads');
const { parseSourceUnitSymbols } = require('./usesQuickFix');

parentPort.on('message', message => {
  try {
    parentPort.postMessage({
      id: message.id,
      unit: parseSourceUnitSymbols(message.text, message.filePath)
    });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error?.stack || error?.message || String(error)
    });
  }
});
