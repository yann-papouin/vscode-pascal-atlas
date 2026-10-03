'use strict';

const { parentPort } = require('node:worker_threads');
const {
  parseTdumpClassNames,
  parseTdumpClassUnits,
  parseTdumpPackageIndex,
  parseTdumpMangledClasses,
  parseTdumpRttiMembers
} = require('./binarySymbols');

parentPort.on('message', message => {
  try {
    let value;
    if (message.operation === 'mangledClasses') {
      value = parseTdumpMangledClasses(message.text, message.bplPath);
    } else if (message.operation === 'packageIndex') {
      value = {
        names: parseTdumpClassNames(message.text),
        units: parseTdumpClassUnits(message.text),
        packageIndex: parseTdumpPackageIndex(message.text, message.bplPath),
        bplPath: message.bplPath
      };
    } else if (message.operation === 'rttiMembers') {
      value = parseTdumpRttiMembers(message.text, message.classInfo);
    } else {
      throw new Error(`Unknown compiled-symbol worker operation: ${message.operation}`);
    }
    parentPort.postMessage({ id: message.id, value });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error?.stack || error?.message || String(error)
    });
  }
});
