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

test("IFOPT opens the conditional block from the reported range-check sequence", () => {
  const source =
    "{$IFOPT R+} {$DEFINE RANGECHECK} {$ELSE} {$UNDEF RANGECHECK} {$ENDIF} {$R-}"
  assert.deepEqual(analyzePascalSyntax(source), [])
})

test("IFOPT supports mixed casing, whitespace, and both directive comment forms", () => {
  for (const source of [
    "{$ifopt r-}{$else}{$endif}",
    "(*$IfOpT I+*)(*$ElSe*)(*$EnDiF*)",
    "{ $ IFOPT R+ } { $ ELSE } { $ ENDIF }",
    "{$IFOPT R+}{$IFDEF FEATURE}{$ELSE}{$ENDIF}{$ELSE}{$ENDIF}",
  ]) {
    assert.deepEqual(analyzePascalSyntax(source), [], source)
  }
})

test("IFOPT nesting preserves inactive parents and following UTF-16 diagnostic offsets", () => {
  const source = `Text := '😀';
{$IFDEF DISABLED}
{$IFOPT R+}
Hidden := ;
{$ELSE}
AlsoHidden := ;
{$ENDIF}
{$ELSE}
Visible := ;
{$ENDIF}
After := ;
`
  assert.deepEqual(
    analyzePascalSyntax(source).map(({ code, offset, length }) => ({
      code,
      offset,
      length,
    })),
    ["Visible :=", "After :="].map((assignment) => ({
      code: "pascal.expression.missingRightHandSide",
      offset: source.indexOf(assignment) + assignment.indexOf(":="),
      length: 2,
    })),
  )
})

test("IFOPT retains structural errors at the offending directives", () => {
  for (const [source, code, marker, length] of [
    ["{$IFOPT R+}", "pascal.directive.unterminated", "{$IFOPT", 1],
    [
      "{$IFOPT R+}{$ELSE}{$ELSE}{$ENDIF}",
      "pascal.directive.duplicateElse",
      "{$ELSE}",
      7,
    ],
    [
      "{$IFOPT R+}{$ELSE}{$ELSEIF true}{$ENDIF}",
      "pascal.directive.afterElse",
      "{$ELSEIF",
      14,
    ],
    ["{$IFOPT R+}{$ENDIF}{$ELSE}", "pascal.directive.orphanElse", "{$ELSE}", 7],
    ["{$IFOPT R+}{$ENDIF}{$ENDIF}", "pascal.directive.orphanEndIf", "{$ENDIF}", 8],
  ] as const) {
    assert.deepEqual(
      analyzePascalSyntax(source).map(({ code, offset, length }) => ({
        code,
        offset,
        length,
      })),
      [{ code, offset: source.lastIndexOf(marker), length }],
      source,
    )
  }
})

test("IFOPT text in strings and ordinary comments does not open a conditional", () => {
  const source = `Text := '{$IFOPT R+}';
// {$IFOPT R+}
(* The directive {$IFOPT R+} is documentation. *)
`
  assert.deepEqual(analyzePascalSyntax(source), [])
})
