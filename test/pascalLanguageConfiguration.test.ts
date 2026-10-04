import * as assert from 'node:assert/strict';
import { test as test } from 'node:test';
import { collectPascalGenericAngleBrackets, languageConfiguration } from '../src/pascalLanguageConfiguration';

test('Pascal language configuration leaves ambiguous angle brackets to its generic collector', () => {
  const configuration = languageConfiguration({ IndentAction: { Indent: 1, IndentOutdent: 2 } });
  assert.deepEqual(configuration.colorizedBracketPairs, [
    ['{', '}'], ['[', ']'], ['(', ')']
  ]);
});

test('generic angle brackets use their own nested color levels', () => {
  const source = `type
  TStore<T> = class
    Values: TDictionary<string, TList<Integer>>;
  end;
begin
  Result := Convert<Integer>(Value);
end;`;
  const brackets = collectPascalGenericAngleBrackets(source);
  const rendered = brackets.map(item => `${source[item.offset]}:${item.depth}`);
  assert.deepEqual(rendered, [
    '<:0', '>:0',
    '<:0', '<:1', '>:1', '>:0',
    '<:0', '>:0'
  ]);
});

test('comparison operators, comments, and strings never become generic angle pairs', () => {
  const source = `begin
  if (A < B) and (C > D) and (E <> F) and (G >= H) then Exit;
  if Test<A> then Exit;
  Text := 'TList<Integer>';
  // TList<Integer>
  { TList<Integer> }
end;`;
  assert.deepEqual(collectPascalGenericAngleBrackets(source), []);
});
