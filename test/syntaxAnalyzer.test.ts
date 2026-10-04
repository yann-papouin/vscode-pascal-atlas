import * as assert from "node:assert/strict"
import { test } from "node:test"
import { analyzePascalSyntax } from "../src/syntaxAnalyzer"

test("lightweight syntax diagnostics leave Delphi block grammar to the compiler", () => {
  const source = `unit BlockGrammar;
interface
type
  EExample = class(Exception);
  TItems = class(TList<Integer>);
  TRealClass = class
  private type
    TNested = class(TObjectList<Integer>);
  public
    procedure Run;
  end;
implementation
procedure TRealClass.Run;
begin
end;
end.
`
  assert.equal(
    analyzePascalSyntax(source).some((item) => item.code.startsWith("pascal.block.")),
    false,
  )
})

test("lightweight syntax diagnostics retain deterministic lexical and delimiter errors", () => {
  const source = `unit SafeChecks;
interface
const Value = ;
procedure Run(A: Integer;
implementation
begin
  A := ;
  Text := 'unterminated
end.
`
  const codes = analyzePascalSyntax(source).map((item) => item.code)
  assert.ok(codes.includes("pascal.string.unterminated"))
  assert.ok(codes.includes("pascal.delimiter.unclosed"))
  assert.ok(codes.includes("pascal.declaration.missingValue"))
  assert.ok(codes.includes("pascal.expression.missingRightHandSide"))
  assert.equal(
    codes.some((code) => code.startsWith("pascal.block.")),
    false,
  )
})
