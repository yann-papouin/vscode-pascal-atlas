import * as assert from "node:assert/strict"
import { test } from "node:test"
import {
  alignWrappedParameters,
  normalizeInlineVariableContinuations,
  postprocessPascal,
} from "../src/formatter/postprocess"

const visualizerDeclarations = [
  "  public",
  "    { IOTADebuggerVisualizer }",
  "    function GetSupportedTypeCount: Integer;",
  "    procedure GetSupportedType(Index: Integer; var TypeName: string;",
  "      var AllDescendants: Boolean);",
  "    function GetVisualizerIdentifier: string;",
  "    function GetVisualizerName: string;",
]

test("inline variable alignment preserves methods following a wrapped var parameter", () => {
  assert.deepEqual(
    normalizeInlineVariableContinuations(visualizerDeclarations),
    visualizerDeclarations,
  )
})

test("formatter postprocessing preserves visualizer declaration alignment and newlines", () => {
  for (const newline of ["\n", "\r\n"]) {
    const source = visualizerDeclarations.join(newline)
    const options = {
      normalizeTypeNameCapitalization: false,
      normalizeVariableNameCapitalization: false,
    }
    const formatted = postprocessPascal(source, options)
    assert.equal(formatted, source)
    assert.equal(postprocessPascal(formatted, options), source)
  }
})

test("inline variable alignment ignores var parameters throughout a multiline signature", () => {
  const lines = [
    "    procedure Run(",
    "      var First: Integer;",
    "        var Second: Integer",
    "    );",
    "    function Next: Integer;",
  ]
  assert.deepEqual(normalizeInlineVariableContinuations(lines), lines)
  const aligned = alignWrappedParameters(lines)
  assert.equal(aligned[2], "      var Second: Integer")
  assert.deepEqual(normalizeInlineVariableContinuations(aligned), aligned)
})

test("inline variable alignment preserves blank caret lines and comments after parameters", () => {
  const lines = [
    "procedure Run(First: Integer;",
    "  var Last: Integer);",
    "",
    "{ Next routine }",
    "function Next: Integer;",
  ]
  assert.deepEqual(
    normalizeInlineVariableContinuations(lines, { includeBlankLineIndexes: [2] }),
    lines,
  )
})

test("inline variable alignment ignores var parameters inside procedural types", () => {
  const lines = [
    "type",
    "  TCallback = reference to procedure(",
    "    Callback: procedure(var Value: Integer);",
    "    VAR State: Integer);",
    "  TNext = Integer;",
  ]
  assert.deepEqual(normalizeInlineVariableContinuations(lines), lines)
})

test("inline variable alignment still aligns statements and eligible blank lines", () => {
  const lines = [
    "procedure Run(var Parameter: Integer);",
    "begin",
    "  var Value: Integer;",
    "",
    "      { Comment with unmatched ( }",
    "      Value := 1;",
    "  var Other := CreateValue(",
    "    NestedValue(",
    "      Parameter));",
    "",
    "      // Comment with unmatched )",
    "      DoWork(Other);",
    "  var Text := '(';",
    "      DoWork(Text);",
    "end;",
  ]
  const expected = [...lines]
  expected[3] = "  "
  expected[4] = "  { Comment with unmatched ( }"
  expected[5] = "  Value := 1;"
  expected[9] = "  "
  expected[10] = "  // Comment with unmatched )"
  expected[11] = "  DoWork(Other);"
  expected[13] = "  DoWork(Text);"
  assert.deepEqual(
    normalizeInlineVariableContinuations(lines, { includeBlankLineIndexes: [3, 9] }),
    expected,
  )
})

test("inline variables inside anonymous routine arguments retain continuation alignment", () => {
  const lines = [
    "Run(",
    "  procedure(",
    "    var Parameter: Integer)",
    "  begin",
    "    var Value: Integer;",
    "        DoWork(Value);",
    "  end);",
  ]
  const expected = [...lines]
  expected[5] = "    DoWork(Value);"
  assert.deepEqual(normalizeInlineVariableContinuations(lines), expected)
})
