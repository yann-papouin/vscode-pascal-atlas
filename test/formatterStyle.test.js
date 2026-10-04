'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { STYLE_RULES, resolveFormatterConfig } = require('../src/formatter/styleRules');

const bundledConfigPath = path.join(__dirname, '..', 'resources', 'DelphiFormatter.config');

test('default style returns the bundled formatter config without reading custom rules', () => {
  const bundledConfig = fs.readFileSync(bundledConfigPath, 'utf8');
  const resolvedConfig = resolveFormatterConfig(bundledConfig, true, () => {
    assert.fail('Custom formatter settings must not be read when the bundled default is enabled.');
  });

  assert.strictEqual(resolvedConfig, bundledConfig);
  assert.strictEqual(fs.readFileSync(bundledConfigPath, 'utf8'), bundledConfig);
});

test('custom style applies configured rules to a copy of the bundled config', () => {
  const bundledConfig = fs.readFileSync(bundledConfigPath, 'utf8');
  const expectedRule = STYLE_RULES[0];
  const resolvedConfig = resolveFormatterConfig(bundledConfig, false, (key, defaultValue) =>
    key === expectedRule.key ? 8 : defaultValue
  );

  assert.notStrictEqual(resolvedConfig, bundledConfig);
  assert.match(resolvedConfig, new RegExp(`Name="${expectedRule.option}"[^>]*Value="8"`));
  assert.strictEqual(fs.readFileSync(bundledConfigPath, 'utf8'), bundledConfig);
});
