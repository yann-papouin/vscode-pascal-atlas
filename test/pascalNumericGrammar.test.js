'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const grammarPath = path.join(__dirname, '..', 'resources', 'pascal-numeric.injection.tmLanguage.json');
const grammar = JSON.parse(fs.readFileSync(grammarPath, 'utf8'));
const patterns = grammar.patterns.map((pattern) => ({
  name: pattern.name,
  regex: new RegExp(pattern.match, 'g')
}));

function tokenize(source) {
  const tokens = [];
  let offset = 0;

  while (offset < source.length) {
    let bestMatch = null;
    let bestPattern = null;

    for (const pattern of patterns) {
      pattern.regex.lastIndex = offset;
      const match = pattern.regex.exec(source);
      if (!match) {
        continue;
      }
      if (!bestMatch || match.index < bestMatch.index) {
        bestMatch = match;
        bestPattern = pattern;
      }
    }

    if (!bestMatch) {
      break;
    }

    tokens.push({ text: bestMatch[0], scope: bestPattern.name });
    offset = bestMatch.index + bestMatch[0].length;
  }

  return tokens;
}

test('numeric injection excludes comments, strings, and compiler directives', () => {
  assert.match(grammar.injectionSelector, /-comment/);
  assert.match(grammar.injectionSelector, /-string/);
  assert.match(grammar.injectionSelector, /-meta\.preprocessor/);
});

test('recognizes Delphi decimal, real, scientific, and hexadecimal literals', () => {
  assert.deepEqual(tokenize('0 42 1.0 1E-7 12.25e+6 $8F $DEAD_BEEF 1_000_000'), [
    { text: '0', scope: 'constant.numeric.integer.pascal' },
    { text: '42', scope: 'constant.numeric.integer.pascal' },
    { text: '1.0', scope: 'constant.numeric.float.pascal' },
    { text: '1E-7', scope: 'constant.numeric.float.pascal' },
    { text: '12.25e+6', scope: 'constant.numeric.float.pascal' },
    { text: '$8F', scope: 'constant.numeric.hex.pascal' },
    { text: '$DEAD_BEEF', scope: 'constant.numeric.hex.pascal' },
    { text: '1_000_000', scope: 'constant.numeric.integer.pascal' }
  ]);
});

test('recognizes Pascal binary and octal literals without confusing escaped identifiers', () => {
  assert.deepEqual(tokenize('%1010_0011 &755 &Integer'), [
    { text: '%1010_0011', scope: 'constant.numeric.binary.pascal' },
    { text: '&755', scope: 'constant.numeric.octal.pascal' }
  ]);
});

test('does not color numeric-looking fragments inside identifiers or malformed literals', () => {
  assert.deepEqual(tokenize('Version1E7 Value$8F $G1 1E 1__0'), []);
});

test('keeps a Pascal range as two integers instead of a real literal', () => {
  assert.deepEqual(tokenize('1..10'), [
    { text: '1', scope: 'constant.numeric.integer.pascal' },
    { text: '10', scope: 'constant.numeric.integer.pascal' }
  ]);
});
