'use strict';

const { parentPort } = require('node:worker_threads');
const { analyzePascalSyntax } = require('./syntaxAnalyzer');

parentPort.on('message', request => {
  try {
    parentPort.postMessage({
      id: request.id,
      uri: request.uri,
      version: request.version,
      diagnostics: analyzePascalSyntax(request.text, { defines: request.defines })
    });
  } catch (error) {
    parentPort.postMessage({
      id: request.id,
      uri: request.uri,
      version: request.version,
      error: error.stack || error.message
    });
  }
});
