import { sourcePath } from './helpers';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test as test } from 'node:test';
import { findVisibleEditor, shouldRetireEditor } from '../src/editorDecorationLifecycle';

function editor(uri: string, viewColumn: number) {
  return {
    viewColumn,
    document: {
      uri: { toString: () => uri }
    }
  };
}

test('diff panes remain live when focus moves between visible editors', () => {
  const original = editor('git:/MainUnit.pas?ref=HEAD', 1);
  const modified = editor('file:/MainUnit.pas', 2);
  const visible = [original, modified];

  assert.equal(shouldRetireEditor(visible, original), false);
  assert.equal(shouldRetireEditor(visible, modified), false);
});

test('a recreated visible editor is resolved by URI and view column', () => {
  const stale = editor('git:/MainUnit.pas?ref=HEAD', 1);
  const replacement = editor('git:/MainUnit.pas?ref=HEAD', 1);

  assert.equal(findVisibleEditor([replacement], stale), replacement);
  assert.equal(shouldRetireEditor([replacement], stale), false);
  assert.equal(shouldRetireEditor([], stale), true);
});

test('decoration commits are retried and only successful commits are logged complete', () => {
  const source = fs.readFileSync(sourcePath('extension.js'), 'utf8');
  assert.match(source, /if \(!this\.applyDecorationRanges\(editor, ranges\)\) \{[\s\S]*?state\.pending = true;[\s\S]*?return;/);
  assert.match(source, /if \(!this\.applyDecorationRanges\(editor, ranges\)\) \{[\s\S]*?failedState\.pending = true;[\s\S]*?return;[\s\S]*?Complete decoration/);
});
