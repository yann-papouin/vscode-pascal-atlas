'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === 'vscode') return { extensions: { getExtension: () => undefined } };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  BUNDLED_DEBUGGER_ASSET,
  BUNDLED_DEBUGGER_VERSION,
  debuggerNeedsBundledUpgrade,
  versionLessThan
} = require('../src/dependencySupport');
Module._load = originalLoad;

test('bundled Delphi debugger upgrades only older dependency versions', () => {
  assert.equal(BUNDLED_DEBUGGER_VERSION, '0.7.2');
  assert.equal(versionLessThan('0.7.0', BUNDLED_DEBUGGER_VERSION), true);
  assert.equal(versionLessThan('0.7.1', BUNDLED_DEBUGGER_VERSION), true);
  assert.equal(versionLessThan('0.7.2', BUNDLED_DEBUGGER_VERSION), false);
  assert.equal(versionLessThan('0.8.0', BUNDLED_DEBUGGER_VERSION), false);
  assert.equal(debuggerNeedsBundledUpgrade({ packageJSON: { version: '0.7.0' } }), true);
  assert.equal(debuggerNeedsBundledUpgrade({ packageJSON: { version: '0.7.1' } }), true);
  assert.equal(debuggerNeedsBundledUpgrade({ packageJSON: { version: '0.7.2' } }), false);
  assert.equal(fs.existsSync(BUNDLED_DEBUGGER_ASSET), true);
});
