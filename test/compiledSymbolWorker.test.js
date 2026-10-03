'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { CompiledSymbolWorkerClient } = require('../src/compiledSymbolWorkerClient');

test('compiled mangled-symbol parsing runs through the worker and returns Maps', async () => {
  const context = {
    asAbsolutePath(relativePath) {
      return path.resolve(__dirname, '..', relativePath);
    }
  };
  const client = new CompiledSymbolWorkerClient(context);
  try {
    const classes = await client.parseMangledClasses('_ZN4Unit4TFoo3BarE', 'Sample.bpl');
    assert.ok(classes instanceof Map);
    assert.equal(classes.get('tfoo').symbol, 'TFoo');
    assert.equal(classes.get('tfoo').methods[0].name, 'Bar');
  } finally {
    client.dispose();
  }
});

test('compiled package indexing runs through the worker and preserves nested Maps', async () => {
  const context = {
    asAbsolutePath(relativePath) {
      return path.resolve(__dirname, '..', relativePath);
    }
  };
  const client = new CompiledSymbolWorkerClient(context);
  try {
    const index = await client.parsePackageIndex('', 'Sample.bpl');
    assert.ok(index.names instanceof Map);
    assert.ok(index.units instanceof Map);
    assert.ok(index.packageIndex.units instanceof Map);
    assert.ok(index.packageIndex.classes instanceof Map);
    assert.ok(index.packageIndex.globals instanceof Map);
    assert.ok(index.packageIndex.routines instanceof Map);
  } finally {
    client.dispose();
  }
});
