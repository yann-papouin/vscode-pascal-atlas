'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === 'vscode') return { extensions: { all: [] } };
  return originalLoad.call(this, request, parent, isMain);
};
const { REQUIRED_EXTENSIONS, REDUNDANT_EXTENSIONS } = require('../src/dependencySupport');
Module._load = originalLoad;

test('dependency checks retain Vallenta and C/C++ without Delphi Debugger', () => {
  assert.deepEqual(REQUIRED_EXTENSIONS.map(extension => extension.id), [
    'VallentaStudio.vallenta-studio',
    'ms-vscode.cpptools'
  ]);
  assert.equal(REQUIRED_EXTENSIONS.some(extension => /delphi.?debugger/i.test(extension.id)), false);
  assert.equal(REDUNDANT_EXTENSIONS.some(extension => /delphi.?debugger/i.test(extension.id)), false);
});
