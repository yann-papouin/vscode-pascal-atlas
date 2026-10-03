'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_BLOCK_LEVEL_COLORS,
  normalizeBlockLevelColors,
  findDelphiKeywordMatchGroup,
  findDelphiModuleKeywordHighlights,
  findDelphiSelfKeywordHighlights,
  findDelphiKeywordHighlights
} = require('../src/formatter/highlighting');

function keywordMatches(source, line, character) {
  return (findDelphiKeywordMatchGroup(source, { line, character }) || []).map((range) => ({
    line: range.line,
    text: source.split('\n')[range.line].slice(range.start, range.end).toLowerCase()
  }));
}

test('structural keyword palette defaults to the requested Dark+ purple cycle', () => {
  assert.deepEqual(DEFAULT_BLOCK_LEVEL_COLORS, ['#E06C75', '#D19A66', '#C586C0']);
  assert.deepEqual(normalizeBlockLevelColors(['#123456', '#abcdef']), ['#123456', '#abcdef']);
  assert.deepEqual(normalizeBlockLevelColors([]), DEFAULT_BLOCK_LEVEL_COLORS);
  assert.deepEqual(normalizeBlockLevelColors(['purple']), DEFAULT_BLOCK_LEVEL_COLORS);
});

test('keyword occurrence highlighting returns only the matching nested begin/end pair', () => {
  const source = `begin
  begin
    Work;
  end;
end;`;
  assert.deepEqual(keywordMatches(source, 0, 1), [
    { line: 0, text: 'begin' },
    { line: 4, text: 'end' }
  ]);
  assert.deepEqual(keywordMatches(source, 1, 3), [
    { line: 1, text: 'begin' },
    { line: 3, text: 'end' }
  ]);
});

test('for highlighting groups only its direction and do keywords', () => {
  const source = `for I := 0 to 10 do
begin
end;
for J := 10 downto 0 do
begin
end;`;
  assert.deepEqual(keywordMatches(source, 0, 1), [
    { line: 0, text: 'for' },
    { line: 0, text: 'to' },
    { line: 0, text: 'do' }
  ]);
  assert.deepEqual(keywordMatches(source, 3, 13), [
    { line: 3, text: 'for' },
    { line: 3, text: 'downto' },
    { line: 3, text: 'do' }
  ]);
});

test('try, repeat, case, while and if return their own structural keyword group', () => {
  const source = `if Ready then
begin
  while Busy do
  begin
  end;
end
else
  repeat
    case Value of
      1: Work;
    end;
  until Done;
try
  Work;
finally
  Finish;
end;`;
  assert.deepEqual(keywordMatches(source, 0, 1).map(item => item.text), ['if', 'then', 'else']);
  assert.deepEqual(keywordMatches(source, 2, 3).map(item => item.text), ['while', 'do']);
  assert.deepEqual(keywordMatches(source, 7, 3).map(item => item.text), ['repeat', 'until']);
  assert.deepEqual(keywordMatches(source, 8, 5).map(item => item.text), ['case', 'of', 'end']);
  assert.deepEqual(keywordMatches(source, 12, 1).map(item => item.text), ['try', 'finally', 'end']);
});

test('unpaired keywords suppress text fallback while escaped and dotted names remain symbols', () => {
  const source = `begin
  Break;
  Other.&Begin;
  Mode.End;
end;`;
  assert.deepEqual(keywordMatches(source, 1, 3), [{ line: 1, text: 'break' }]);
  assert.equal(findDelphiKeywordMatchGroup(source, { line: 2, character: 10 }), undefined);
  assert.equal(findDelphiKeywordMatchGroup(source, { line: 3, character: 8 }), undefined);
});

function tokensAtLevel(highlights, level, sourceLines) {
  return highlights.blockLevelKeywords[level].map(range => ({
    line: range.line,
    text: sourceLines[range.line].slice(range.start, range.end).toLowerCase()
  }));
}

test('structural keywords at the same indentation share the legacy palette level', () => {
  const source = `begin
  for I := 0 to 2 do
  begin
    case I of
      0:
      begin
        Work;
    end;
    end;
  end;
end;`;
  const lines = source.split('\n');
  const highlights = findDelphiKeywordHighlights(source, {
    tabSize: 2,
    indentSize: 2,
    blockLevelCount: 3
  });

  assert.deepEqual(tokensAtLevel(highlights, 0, lines), [
    { line: 0, text: 'begin' },
    { line: 5, text: 'begin' },
    { line: 10, text: 'end' }
  ]);
  assert.deepEqual(tokensAtLevel(highlights, 1, lines), [
    { line: 1, text: 'for' },
    { line: 1, text: 'to' },
    { line: 1, text: 'do' },
    { line: 2, text: 'begin' },
    { line: 9, text: 'end' }
  ]);
  assert.deepEqual(tokensAtLevel(highlights, 2, lines), [
    { line: 3, text: 'case' },
    { line: 3, text: 'of' },
    { line: 7, text: 'end' },
    { line: 8, text: 'end' }
  ]);
});

test('block indentation levels honor non-default indent and tab widths', () => {
  const source = 'begin\n    begin\n\t\tbegin\n\t\tend;\n    end;\nend;';
  const lines = source.split('\n');
  const highlights = findDelphiKeywordHighlights(source, {
    tabSize: 4,
    indentSize: 4,
    blockLevelCount: 3
  });

  assert.deepEqual(tokensAtLevel(highlights, 0, lines).map(item => item.text), ['begin', 'end']);
  assert.deepEqual(tokensAtLevel(highlights, 1, lines).map(item => item.text), ['begin', 'end']);
  assert.deepEqual(tokensAtLevel(highlights, 2, lines).map(item => item.text), ['begin', 'end']);
});

test('variant records and body-less class aliases cannot hide later begin/end tokens', () => {
  const source = `type
  TForward = class(TObject);
  TVariant = record
    case Boolean of
      True: (Enabled: Boolean);
  end;

implementation

procedure Run;
begin
  if Ready then
  begin
    Work;
  end;
end;`;
  const lines = source.split('\n');
  const highlights = findDelphiKeywordHighlights(source, { tabSize: 2, indentSize: 2 });
  const blockTokens = highlights.blockLevelKeywords.flat()
    .filter(range => /^(?:begin|end)$/i.test(lines[range.line].slice(range.start, range.end)))
    .map(range => `${range.line + 1}:${lines[range.line].slice(range.start, range.end).toLowerCase()}`);

  assert.deepEqual(blockTokens.sort(), ['11:begin', '13:begin', '15:end', '16:end'].sort());
  assert.equal(highlights.typeDeclarationEndKeywords.some(range => range.line === 5), true);
  assert.deepEqual(tokensAtLevel(highlights, 1, lines)
    .filter(item => item.line === 11)
    .map(item => item.text), ['if', 'then']);
});

test('module sections and the final end dot stay out of the indentation palette', () => {
  const source = `unit Sample;

interface

uses
  System.SysUtils;

implementation

initialization
  Start;

finalization
  Stop;

end.`;
  const lines = source.split('\n');
  const highlights = findDelphiKeywordHighlights(source, {
    tabSize: 2,
    indentSize: 2,
    blockLevelCount: 3
  });
  const colored = highlights.blockLevelKeywords.flat().map(range =>
    lines[range.line].slice(range.start, range.end).toLowerCase());

  assert.deepEqual(colored, []);
  assert.deepEqual(highlights.typeDeclarationKeywords, []);
});

test('module keywords have a dedicated type-color range without capturing interface types', () => {
  const source = `unit Sample;
interface
uses
  System.SysUtils;
type
  IWorker = interface
  end;
implementation
initialization
finalization
end.`;
  const lines = source.split('\n');
  const highlighted = findDelphiModuleKeywordHighlights(source).map(range => ({
    line: range.line,
    text: lines[range.line].slice(range.start, range.end).toLowerCase()
  }));

  assert.deepEqual(highlighted, [
    { line: 0, text: 'unit' },
    { line: 1, text: 'interface' },
    { line: 2, text: 'uses' },
    { line: 7, text: 'implementation' },
    { line: 8, text: 'initialization' },
    { line: 9, text: 'finalization' },
    { line: 10, text: 'end' }
  ]);
});

test('Self receives a dedicated keyword range without repainting symbols, strings, or comments', () => {
  const source = `begin
  Self.Run;
  SELF.Stop;
  Obj.Self := 1;
  Obj.&Self := 2;
  S := 'Self';
  // Self
end;`;
  const lines = source.split('\n');
  const highlighted = findDelphiSelfKeywordHighlights(source).map(range => ({
    line: range.line,
    text: lines[range.line].slice(range.start, range.end)
  }));

  assert.deepEqual(highlighted, [
    { line: 1, text: 'Self' },
    { line: 2, text: 'SELF' }
  ]);
});

test('an interface type still uses the type-declaration boundary color', () => {
  const source = `type
  IWorker = interface
    procedure Work;
  end;`;
  const lines = source.split('\n');
  const highlights = findDelphiKeywordHighlights(source, { blockLevelCount: 3 });

  assert.deepEqual(highlights.typeDeclarationKeywords.map(range =>
    lines[range.line].slice(range.start, range.end).toLowerCase()), ['interface']);
  assert.deepEqual(highlights.typeDeclarationEndKeywords.map(range =>
    lines[range.line].slice(range.start, range.end).toLowerCase()), ['end']);
});

test('forward classes and type-form of keywords stay out of the block palette', () => {
  const source = `type
  TDocument = class;
  TDocumentClass = class of TDocument;
  TItems = array of TDocument;
  TFlags = set of Byte;
begin
  case Kind of
    0: Work;
  end;
end;`;
  const lines = source.split('\n');
  const highlights = findDelphiKeywordHighlights(source, { blockLevelCount: 3 });
  const typeKeywords = highlights.typeDeclarationKeywords.map(range => ({
    line: range.line,
    text: lines[range.line].slice(range.start, range.end).toLowerCase()
  }));
  const blockKeywords = highlights.blockLevelKeywords.flat().map(range => ({
    line: range.line,
    text: lines[range.line].slice(range.start, range.end).toLowerCase()
  }));

  assert.deepEqual(typeKeywords, [
    { line: 1, text: 'class' },
    { line: 2, text: 'of' },
    { line: 2, text: 'class' },
    { line: 3, text: 'of' },
    { line: 4, text: 'of' }
  ]);
  assert.equal(blockKeywords.some(item => item.text === 'class'), false);
  assert.deepEqual(blockKeywords.filter(item => item.text === 'of'), [
    { line: 6, text: 'of' }
  ]);
});
