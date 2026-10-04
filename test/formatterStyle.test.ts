import { resourcePath } from './helpers';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test as test } from 'node:test';
import { STYLE_RULES, resolveFormatterConfig } from '../src/formatter/styleRules';

const bundledConfigPath = resourcePath('DelphiFormatter.config');

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
  const resolvedConfig = resolveFormatterConfig(bundledConfig, false, (key: string, defaultValue: import("../src/formatter/styleRules").StyleValue) =>
    key === expectedRule.key ? 8 : defaultValue
  );

  assert.notStrictEqual(resolvedConfig, bundledConfig);
  assert.match(resolvedConfig, new RegExp(`Name="${expectedRule.option}"[^>]*Value="8"`));
  assert.strictEqual(fs.readFileSync(bundledConfigPath, 'utf8'), bundledConfig);
});
