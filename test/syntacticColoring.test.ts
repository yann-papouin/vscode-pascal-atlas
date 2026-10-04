import * as assert from 'node:assert/strict';
import { test as test } from 'node:test';
import { collectPascalSyntacticColoring, isPascalIntrinsicIdentifier, isPascalNonNavigableIdentifierAt, isPascalVisibilityDirectiveAt } from '../src/syntacticColoring';

test('colors declarations and calls when external Pascal metadata is unavailable', () => {
  const code = `
function DeleteAssemblyNode(Params: IJson): TMVCResult;
begin
  PostCustomMsg('done', Params.AsArray.S[0]);
end;
`;
  const coloring = collectPascalSyntacticColoring(code);
  assert.deepEqual([...coloring.typeNames].sort(), ['ijson', 'tmvcresult']);
  assert.equal(coloring.calls.has(code.indexOf('PostCustomMsg')), true);
  assert.equal(coloring.members.get(code.indexOf('AsArray')), 'property');
  assert.equal(coloring.members.get(code.indexOf('.S') + 1), 'property');
});

test('distinguishes unresolved method calls from property access', () => {
  const code = 'Value.UnknownCall(Arg); Value.UnknownProperty;';
  const coloring = collectPascalSyntacticColoring(code);
  assert.equal(coloring.members.get(code.indexOf('UnknownCall')), 'method');
  assert.equal(coloring.members.get(code.indexOf('UnknownProperty')), 'property');
});

test('intrinsic type casts keep type coloring without swallowing escaped or member calls', () => {
  const code = `begin
  Wide := PWideChar(IntToStr(Value));
  Count := Integer(Source);
  Text := string(Value);
  Qualified := System.PWideChar(Value);
  &PWideChar(Value);
  Obj.PWideChar(Value);
end;`;
  const coloring = collectPascalSyntacticColoring(code);
  const offsets = [...code.matchAll(/PWideChar/g)].map(match => match.index);

  assert.equal(coloring.typeCasts.has(offsets[0]), true);
  assert.equal(coloring.typeCasts.has(code.indexOf('Integer')), true);
  assert.equal(coloring.typeCasts.has(code.indexOf('string')), true);
  assert.equal(coloring.typeCasts.has(offsets[1]), true);
  assert.equal(coloring.calls.has(offsets[2]), true);
  assert.equal(coloring.members.get(offsets[3]), 'method');
  assert.equal(coloring.calls.has(offsets[0]), false);
});

test('recognizes visibility directives without suppressing real same-name symbols', () => {
  const code = `type
  TExample = class
  strict private
    FValue: Integer;
  public
    procedure Run;
  end;
  TVisibility = (
    Private,
    Public
  );
procedure Public;
begin
  TVisibility.Public;
  PublicValue := 1;
end;`;
  const occurrences = [...code.matchAll(/\b(?:strict|private|public|PublicValue)\b/gi)]
    .map(match => ({
      text: match[0],
      offset: match.index,
      directive: isPascalVisibilityDirectiveAt(code, match.index, match[0])
    }));
  assert.deepEqual(occurrences.map(item => item.directive), [
    true, true, true, false, false, false, false, false
  ]);
});

test('navigation excludes standalone keywords and Delphi intrinsic types only', () => {
  const code = `begin
  Value := Integer(Count);
  Flag := Boolean(Value);
  Self.Run;
  TVisibility.Public;
  Obj.Integer;
  &Integer := 1;
end;`;
  const blocked = (text: string, occurrence = 0) => {
    let offset = -1;
    for (let index = 0; index <= occurrence; index += 1) {
      offset = code.indexOf(text, offset + 1);
    }
    return isPascalNonNavigableIdentifierAt(code, offset, text);
  };

  assert.equal(blocked('begin'), true);
  assert.equal(blocked('Integer'), true);
  assert.equal(blocked('Boolean'), true);
  assert.equal(blocked('Self'), true);
  assert.equal(blocked('Public'), false);
  assert.equal(blocked('Integer', 1), false);
  assert.equal(blocked('Integer', 2), false);
  assert.equal(isPascalIntrinsicIdentifier('ByteBool'), true);
  assert.equal(isPascalIntrinsicIdentifier('PChar'), true);
});
