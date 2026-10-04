import type {
  EditorPosition,
  EditorRange,
  EditorSelection,
  EditableDocument,
  CounterpartEditor,
  ImplementationApi,
  SourceEdit,
} from "../src/shared/implementation"
import type { NavigatorModel } from "../src/shared/models"
import { required } from "./helpers"
import { projectRoot } from "./helpers"
import { isInteger } from "../src/shared/guards"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { test } from "node:test"
import {
  buildClassNavigatorModel,
  implementationRoutineForest,
} from "../src/classNavigator"
import { maskPascalNonCode } from "../src/binarySymbols"
import {
  createImplementationCommand,
  planRoutineImplementation,
  planRoutineCounterpart,
  readClassLayout,
} from "../src/implementationCore"

const body = (name: string) => `procedure ${name};\nbegin\nend;`
const unit = (
  declarations: readonly string[],
  bodies: readonly string[] = [],
  tail = "end.",
) => `unit CreateSample;
interface
type
  TDemo = class
  public
${declarations.map((heading) => "    " + heading).join("\n")}
  end;
implementation
${bodies.join("\n\n")}
${tail}`
const modelFor = (source: string) =>
  buildClassNavigatorModel(source, "CreateSample.pas")
function generate(
  source: string,
  name = "Missing",
  options: Partial<{ insertSpaces: boolean; tabSize: number } | undefined> = {},
) {
  const model = modelFor(source)
  const target = required(model.routineNodes.find((node) => node.name === name))
  const plan = planRoutineImplementation(
    source,
    model,
    required(target.declarationStartOffset),
    options,
  )
  assert.ok(plan.reason === undefined, plan.reason)
  const result = source.slice(0, plan.offset) + plan.text + source.slice(plan.offset)
  const after = modelFor(result)
  const implemented = after.routineNodes.find((node) => node.id === target.id)
  assert.ok(
    isInteger(implemented?.implementationOffset),
    "Generated heading must match its declaration",
  )
  assert.equal(implemented.missingCounterpart, undefined)
  return { result, plan, after, target }
}
const order = (source: string) =>
  implementationRoutineForest(maskPascalNonCode(source)).map((routine) =>
    [routine.header.owner, routine.header.name].filter(Boolean).join("."),
  )

const neighbors = ["procedure Before;", "procedure Missing;", "procedure After;"]
for (const [description, bodies, expected] of [
  [
    "adjacent bodies",
    ["TDemo.Before", "TDemo.After"],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"],
  ],
  [
    "reversed adjacent bodies",
    ["TDemo.After", "TDemo.Before"],
    ["TDemo.After", "TDemo.Missing", "TDemo.Before"],
  ],
  [
    "separated bodies",
    ["TDemo.Before", "TOther.Work", "TDemo.After"],
    ["TDemo.Before", "TDemo.Missing", "TOther.Work", "TDemo.After"],
  ],
  ["previous body only", ["TDemo.Before"], ["TDemo.Before", "TDemo.Missing"]],
  ["next body only", ["TDemo.After"], ["TDemo.Missing", "TDemo.After"]],
] satisfies Array<[string, string[], string[]]>) {
  test(`implementation placement uses ${description}`, () => {
    assert.deepEqual(
      order(generate(unit(neighbors, bodies.map(body))).result),
      expected,
    )
  })
}

test("missing immediate neighbors use alphabetical placement without searching outward", () => {
  const source = unit(
    [
      "procedure Alpha;",
      "procedure UnimplementedPrev;",
      "procedure Missing;",
      "procedure UnimplementedNext;",
      "procedure Zeta;",
    ],
    [body("TDemo.Zeta"), body("TDemo.Alpha")],
  )
  assert.deepEqual(order(generate(source).result), [
    "TDemo.Missing",
    "TDemo.Zeta",
    "TDemo.Alpha",
  ])
})

test("alphabetical fallback compares only the owning class and appends after its last body", () => {
  const source = unit(
    ["procedure Missing;"],
    [body("TDemo.Alpha"), body("TOther.Zeta"), body("TDemo.Beta"), body("TOther.Last")],
  )
  assert.deepEqual(order(generate(source).result), [
    "TDemo.Alpha",
    "TOther.Zeta",
    "TDemo.Beta",
    "TDemo.Missing",
    "TOther.Last",
  ])
})

test("alphabetical fallback keeps overload bodies together", () => {
  const source = unit(
    ["procedure Run(Value: Integer); overload;"],
    ["procedure TDemo.Run(Value: string);\nbegin\nend;"],
  )
  const { result } = generate(source, "Run")
  assert.ok(
    result.indexOf("procedure TDemo.Run(Value: Integer)") >
      result.indexOf("procedure TDemo.Run(Value: string)"),
  )
})

test("a class without bodies appends before lifecycle sections", () => {
  const source = unit(
    ["procedure Missing;"],
    [body("TOther.Last")],
    "initialization\n  StartUp;\nfinalization\n  ShutDown;\nend.",
  )
  const { result } = generate(source)
  assert.deepEqual(order(result), ["TOther.Last", "TDemo.Missing"])
  assert.ok(
    result.indexOf("procedure TDemo.Missing;") < result.indexOf("initialization"),
  )
  assert.ok(
    result.includes("initialization\n  StartUp;\nfinalization\n  ShutDown;\nend."),
  )
})

test("an empty implementation preserves uses, type, const and var declarations", () => {
  const source = unit(
    ["procedure Missing;"],
    [],
    "uses SysUtils;\ntype TLocal = Integer;\nconst Value = 1;\nvar Count: Integer;\nend.",
  )
  const { result } = generate(source)
  assert.ok(
    result.indexOf("procedure TDemo.Missing;") > result.indexOf("var Count: Integer;"),
  )
  assert.match(result, /procedure TDemo\.Missing;\nbegin\n  \nend;\n\nend\./)
})

test("standalone globals use global neighbors and exact overload matching", () => {
  const source = `unit CreateSample;
interface
procedure Before;
function Missing(const Caption: string = 'default'; Value: Integer = 10): Boolean;
procedure After;
implementation
${body("Before")}

${body("TOther.Work")}

${body("After")}
end.`
  const { result } = generate(source)
  assert.deepEqual(order(result), ["Before", "Missing", "TOther.Work", "After"])
  assert.match(
    result,
    /function Missing\(const Caption: string; Value: Integer\): Boolean;/,
  )
  const overloaded = `unit CreateSample;
interface
procedure Run(Value: Integer); overload;
implementation
procedure Run(Value: string);
begin
end;
end.`
  assert.ok(
    generate(overloaded, "Run").result.includes(
      "procedure Run(Value: Integer);\nbegin",
    ),
  )
})

test("global alphabetical fallback ignores class bodies", () => {
  const source = `unit CreateSample;
interface
procedure Missing;
implementation
${body("Zeta")}

${body("TOther.Alpha")}
end.`
  assert.deepEqual(order(generate(source).result), ["Missing", "Zeta", "TOther.Alpha"])
})

test("multiline headings keep types and case, omit defaults/directives and place the caret after begin", () => {
  const source = unit(
    [
      "FUNCTION Missing(\n      const Caption: string = 'a; begin end';\n      A, B: Integer = 1\n    ): Boolean; virtual;",
    ],
    [],
  )
  const model = modelFor(source)
  const target = required(model.routineNodes.find((node) => node.name === "Missing"))
  const plan = planRoutineImplementation(source, model, source.indexOf("A, B: Integer"))
  assert.equal(plan.reason, undefined)
  assert.match(
    plan.text,
    /FUNCTION TDemo\.Missing\(const Caption: string; A, B: Integer\): Boolean;\nBEGIN\n  \nEND;/,
  )
  assert.equal(plan.text.includes("virtual"), false)
  const result = source.slice(0, plan.offset) + plan.text + source.slice(plan.offset)
  assert.equal(result.slice(plan.caretOffset - 8, plan.caretOffset), "BEGIN\n  ")
  assert.equal(result.slice(plan.caretOffset, plan.caretOffset + 5), "\nEND;")
  assert.equal(
    required(modelFor(result).routineNodes.find((node) => node.id === target.id))
      .missingCounterpart,
    undefined,
  )
})

test("generic owner names omit constraints and nested owners retain their parameters", () => {
  const source = `unit CreateSample;
interface
type
  TOuter<T: class, constructor> = class
  type
    TInner<U: record> = class
    public
      class function Missing<V: class; W: record>(const Value: V): U; static;
    end;
  end;
implementation
end.`
  const { result } = generate(source)
  assert.match(
    result,
    /class function TOuter<T>\.TInner<U>\.Missing<V, W>\(const Value: V\): U;/,
  )
})

test("CRLF and tabs follow the anchor heading indentation and editor settings", () => {
  const source = unit(
    ["procedure Before;", "procedure Missing;"],
    ["\tprocedure TDemo.Before;\n\tbegin\n\tend;"],
  ).replace(/\n/g, "\r\n")
  const { plan, result } = generate(source, "Missing", {
    insertSpaces: false,
    tabSize: 4,
  })
  assert.match(plan.text, /\tprocedure TDemo\.Missing;\r\n\tbegin\r\n\t\t\r\n\tend;/)
  assert.equal(result.slice(plan.caretOffset - 2, plan.caretOffset), "\t\t")
  assert.equal(/(?<!\r)\n/.test(plan.text), false)
})

test("after insertion keeps trailing comments and before insertion keeps attached documentation", () => {
  const source = unit(neighbors, [
    body("TDemo.Before") + " // trailing note",
    "// After documentation\n" + body("TDemo.After"),
  ])
  const { result } = generate(source)
  assert.ok(result.includes("end; // trailing note\n\nprocedure TDemo.Missing;"))
  assert.ok(result.includes("// After documentation\nprocedure TDemo.After;"))
  const nextOnly = unit(
    ["procedure Missing;", "procedure After;"],
    ["(* Attached\n   documentation *)\n" + body("TDemo.After")],
  )
  const inserted = generate(nextOnly).result
  assert.ok(
    inserted.indexOf("procedure TDemo.Missing;") < inserted.indexOf("(* Attached"),
  )
  assert.ok(inserted.includes("documentation *)\nprocedure TDemo.After;"))
})

test("local routines, compound blocks and assembly bodies provide complete top-level anchors", () => {
  const previous = `procedure TDemo.Before;
  procedure Local;
  begin
    case Value of
      1: begin Work; end;
    end;
  end;
begin
  try
    Local;
  except
    HandleError;
  end;
end;`
  const source = unit(neighbors, [
    previous,
    "procedure TDemo.After;\nasm\n  MOV EAX, 0\nend;",
  ])
  const { result } = generate(source)
  assert.deepEqual(order(result), ["TDemo.Before", "TDemo.Missing", "TDemo.After"])
  assert.ok(result.includes(previous + "\n\nprocedure TDemo.Missing;"))
})

test("existing, abstract, external and interface methods do not produce edits", () => {
  for (const source of [
    unit(["procedure Missing;"], [body("TDemo.Missing")]),
    unit(["procedure Missing; virtual; abstract;"]),
    unit(["procedure Missing; external 'library.dll';"]),
    "unit CreateSample;\ninterface\ntype\n  IContract = interface\n    procedure Missing;\n  end;\nimplementation\nend.",
  ]) {
    const model = modelFor(source)
    const target = required(model.routineNodes.find((node) => node.name === "Missing"))
    assert.ok(
      planRoutineImplementation(source, model, required(target.declarationStartOffset))
        .reason,
    )
  }
})

test("incomplete declarations, malformed bodies and missing section boundaries reject edits", () => {
  for (const source of [
    unit(["procedure Missing"]),
    unit(neighbors, ["procedure TDemo.Before;\nbegin\n  Work;"]),
    unit(["procedure Missing;"]).replace("implementation", ""),
    unit(["procedure Missing;"]).replace("end.", ""),
  ]) {
    const model = modelFor(source)
    const target = model.routineNodes.find((node) => node.name === "Missing")
    assert.ok(
      planRoutineImplementation(
        source,
        model,
        target?.declarationStartOffset ?? source.indexOf("Missing"),
      ).reason,
    )
  }
})

/** Exercise the command with a real model and an editable VS Code-shaped document. */
function editorHarness(initial: string) {
  let source = initial
  const infos: string[] = []
  const edits: Array<{
    insertions: Array<Omit<SourceEdit, "endOffset"> & { endOffset?: number }>
    options: { undoStopBefore: boolean; undoStopAfter: boolean }
  }> = []
  const undo: string[] = []
  class Position implements EditorPosition {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range implements EditorRange<Position> {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class Selection extends Range implements EditorSelection<Position> {
    active: Position
    isEmpty: boolean
    constructor(start: Position, end: Position) {
      super(start, end)
      this.active = end
      this.isEmpty = start.line === end.line && start.character === end.character
    }
  }
  const document: EditableDocument<Position> = {
    uri: { toString: () => "file:///CreateSample.pas" },
    languageId: "pascal",
    version: 1,
    eol: 1,
    getText: () => source,
    positionAt: (offset) => {
      const lines = source.slice(0, offset).split("\n")
      return new Position(lines.length - 1, required(lines.at(-1)).length)
    },
    offsetAt: (position) =>
      source
        .split("\n")
        .slice(0, position.line)
        .reduce((sum, line) => sum + line.length + 1, 0) + position.character,
  }
  const position = document.positionAt(source.indexOf("Missing"))
  const selection = new Selection(position, position)
  type HarnessEditor = CounterpartEditor<Position, Range, Selection> & {
    selections: Selection[]
    acceptEdits: boolean
    revealed?: Range
  }
  const editor: HarnessEditor = {
    document,
    selection,
    selections: [selection],
    options: { tabSize: 2, insertSpaces: true },
    acceptEdits: true,
    revealRange(range) {
      this.revealed = range
    },
    async edit(callback, options) {
      if (!this.acceptEdits) return false
      const insertions: Array<Omit<SourceEdit, "endOffset"> & { endOffset?: number }> =
        []
      callback({
        insert: (position, text) => {
          insertions.push({ offset: document.offsetAt(position), text })
        },
        replace: (range, text) => {
          insertions.push({
            offset: document.offsetAt(range.start),
            endOffset: document.offsetAt(range.end),
            text,
          })
        },
      })
      if (!insertions.length) return false
      undo.push(source)
      edits.push({ insertions, options })
      for (const insertion of insertions.sort(
        (left, right) => right.offset - left.offset,
      )) {
        source =
          source.slice(0, insertion.offset) +
          insertion.text +
          source.slice(insertion.endOffset ?? insertion.offset)
      }
      document.version += 1
      return true
    },
  }
  const workspace: ImplementationApi<Position, Range, Selection>["workspace"] = {
    getConfiguration: () => ({ get: () => true }),
  }
  const window: ImplementationApi<Position, Range, Selection>["window"] = {
    activeTextEditor: editor,
    showInformationMessage: (message) => infos.push(message),
    showErrorMessage: (message) => infos.push(message),
  }
  const vscode = {
    window,
    workspace,
    Selection,
    Range,
    EndOfLine: { LF: 1, CRLF: 2 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 4 },
  }
  return {
    vscode,
    document,
    editor,
    infos,
    edits,
    readyModel: async () => modelFor(source),
    undo: () => {
      source = required(undo.pop())
      document.version += 1
    },
    change: (text: string) => {
      source = text
      document.version += 1
    },
  }
}

test("the editor command creates one undoable implementation and moves the caret into its blank body", async () => {
  const original = unit(neighbors, [body("TDemo.Before"), body("TDemo.After")])
  const env = editorHarness(original)
  let updated = 0
  const command = createImplementationCommand(env.vscode, {
    readyModel: env.readyModel,
    onCreated: () => {
      updated += 1
    },
  })
  assert.equal(await command(), true)
  assert.equal(env.edits.length, 1)
  assert.equal(env.edits[0].insertions.length, 1)
  assert.deepEqual(env.edits[0].options, { undoStopBefore: true, undoStopAfter: true })
  const caret = env.document.offsetAt(env.editor.selection.active)
  assert.equal(env.document.getText().slice(caret - 8, caret), "begin\n  ")
  assert.equal(env.document.getText().slice(caret, caret + 5), "\nend;")
  assert.equal(required(env.editor.revealed).start, env.editor.selection.active)
  assert.equal(updated, 1)
  const declaration = env.document.positionAt(env.document.getText().indexOf("Missing"))
  env.editor.selection = new env.vscode.Selection(declaration, declaration)
  assert.equal(await command(), false)
  assert.match(required(env.infos.at(-1)), /already has an implementation/)
  assert.equal(env.edits.length, 1)
  env.undo()
  assert.equal(env.document.getText(), original)
})

test("the command rejects concurrent requests and source changes during asynchronous parsing", async () => {
  const original = unit(["procedure Missing;"])
  const env = editorHarness(original)
  let resolve!: (model: NavigatorModel) => void
  const model = modelFor(original)
  const ready = new Promise<NavigatorModel>((done) => {
    resolve = done
  })
  const command = createImplementationCommand(env.vscode, { readyModel: () => ready })
  const first = command()
  assert.equal(await command(), false)
  assert.match(required(env.infos.at(-1)), /already being created/)
  env.change(original + "\n// typed while waiting")
  resolve(model)
  assert.equal(await first, false)
  assert.match(required(env.infos.at(-1)), /document, caret or active editor changed/)
  assert.equal(env.edits.length, 0)
})

test("the command respects selection, editor changes and rejected document edits", async () => {
  const env = editorHarness(unit(["procedure Missing;"]))
  const command = createImplementationCommand(env.vscode, {
    readyModel: env.readyModel,
  })
  env.editor.selections.push(env.editor.selection)
  assert.equal(await command(), false)
  env.editor.selections.pop()
  env.editor.selection.isEmpty = false
  assert.equal(await command(), false)
  env.editor.selection.isEmpty = true
  env.editor.acceptEdits = false
  assert.equal(await command(), false)
  assert.equal(env.edits.length, 0)
  env.editor.acceptEdits = true
  const switchEditor = createImplementationCommand(env.vscode, {
    readyModel: async () => {
      env.vscode.window.activeTextEditor = { ...env.editor }
      return env.readyModel()
    },
  })
  assert.equal(await switchEditor(), false)
  assert.equal(env.edits.length, 0)
})

test("the manifest exposes Ctrl+Shift+C independently of Navigator visibility or mode", () => {
  const manifest: {
    contributes: {
      commands: Array<{ command: string; title: string }>
      keybindings: Array<{ command: string; key: string; when: string }>
    }
  } = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"))
  const command = required(
    manifest.contributes.commands.find(
      (item) => item.command === "pascalAtlas.createImplementation",
    ),
  )
  assert.equal(command.title, "Pascal Atlas: Create Missing Routine Counterpart")
  const binding = required(
    manifest.contributes.keybindings.find((item) => item.command === command.command),
  )
  assert.equal(binding.key, "ctrl+shift+c")
  assert.match(binding.when, /editorTextFocus.*!editorReadonly/)
  assert.match(binding.when, /pascal\|objectpascal/)
  assert.doesNotMatch(binding.when, /classNavigator|navigator\.mode/)
})

test("default strings containing directive text do not affect safe insertion checks", () => {
  const source = unit([
    "procedure Earlier(Value: string = '{$IFDEF EXAMPLE}');",
    "procedure Missing;",
  ])
  assert.equal(generate(source).plan.reason, undefined)
  const guarded = unit(["{$IFDEF EXAMPLE}", "procedure Missing;", "{$ENDIF}"])
  const model = modelFor(guarded)
  const target = required(model.routineNodes.find((node) => node.name === "Missing"))
  assert.match(
    required(
      planRoutineImplementation(guarded, model, required(target.declarationStartOffset))
        .reason,
    ),
    /safely resolved/,
  )
})

test("same-line implementation/end boundaries remain usable in an otherwise complete unit", () => {
  const source = unit(["procedure Missing;"]).replace(
    /implementation\s+end\./,
    "implementation end.",
  )
  const { result } = generate(source)
  assert.match(
    result,
    /implementation \n\nprocedure TDemo\.Missing;\nbegin\n  \nend;\n\nend\./,
  )
})

test("generic overload arity prevents accepting another overload as the missing body", () => {
  const source = unit(
    [
      "procedure Run<T>(Value: T); overload;",
      "procedure Run<T, U>(Value: T); overload;",
    ],
    ["procedure TDemo.Run<T, U>(Value: T);\nbegin\nend;"],
  )
  const model = modelFor(source)
  const target = required(
    model.routineNodes.find((node) => required(node.signature).includes("Run<T>(")),
  )
  const plan = planRoutineImplementation(
    source,
    model,
    required(target.declarationStartOffset),
  )
  assert.equal(plan.reason, undefined)
  assert.match(plan.text, /procedure TDemo\.Run<T>\(Value: T\);/)
  const result = source.slice(0, plan.offset) + plan.text + source.slice(plan.offset)
  assert.equal(
    modelFor(result).routineNodes.filter((node) => node.missingCounterpart).length,
    0,
  )
})

test("a caret move during parsing and read-only file systems reject the command without changes", async () => {
  const env = editorHarness(unit(["procedure Missing;"]))
  env.vscode.workspace.fs = { isWritableFileSystem: () => false }
  const readOnly = createImplementationCommand(env.vscode, {
    readyModel: env.readyModel,
  })
  assert.equal(await readOnly(), false)
  assert.match(required(env.infos.at(-1)), /read-only/)
  env.vscode.workspace.fs = undefined
  const moved = createImplementationCommand(env.vscode, {
    readyModel: async () => {
      const next = env.document.positionAt(
        env.document.getText().indexOf("implementation"),
      )
      env.editor.selection = new env.vscode.Selection(next, next)
      return env.readyModel()
    },
  })
  assert.equal(await moved(), false)
  assert.equal(env.edits.length, 0)
})

test("declaration source order wins over Navigator visibility sorting and lifecycle ranking", () => {
  const source = unit(
    [
      "private",
      "constructor Create;",
      "public",
      "procedure Missing;",
      "protected",
      "destructor Destroy;",
    ],
    [
      "constructor TDemo.Create;\nbegin\nend;",
      "destructor TDemo.Destroy;\nbegin\nend;",
    ],
  )
  assert.deepEqual(order(generate(source).result), [
    "TDemo.Create",
    "TDemo.Missing",
    "TDemo.Destroy",
  ])
})

test("standalone compiler directives remain with the existing implementation code", () => {
  const source = unit(
    ["procedure Missing;", "procedure After;"],
    ["{$R 'forms.dfm'}\n// Documentation\n" + body("TDemo.After")],
  )
  const { result } = generate(source)
  assert.ok(
    result.indexOf("{$R 'forms.dfm'}") < result.indexOf("procedure TDemo.Missing;"),
  )
  assert.ok(result.includes("// Documentation\nprocedure TDemo.After;"))
})

test("routine names on the following line still expose the entire declaration heading", () => {
  const source = unit([
    "class function\n      Missing(\n        Value: Integer\n      ): Integer; static;",
  ])
  const { result } = generate(source)
  assert.match(result, /class function TDemo\.Missing\(Value: Integer\): Integer;/)
})

function applyCounterpart(
  source: string,
  plan: import("../src/shared/implementation").CounterpartPlan,
) {
  for (const edit of [...plan.edits].sort(
    (left, right) => right.offset - left.offset,
  )) {
    source = source.slice(0, edit.offset) + edit.text + source.slice(edit.endOffset)
  }
  return source
}

function declare(source: string, name = "Missing", caret?: number) {
  const model = modelFor(source)
  const target = required(
    model.routineNodes.find(
      (node) => node.name === name && isInteger(node.implementationOffset),
    ),
  )
  const plan = planRoutineCounterpart(
    source,
    model,
    required(caret ?? target.implementationOffset),
  )
  assert.ok(plan.reason === undefined, plan.reason)
  assert.equal(plan.direction, "declaration")
  const result = applyCounterpart(source, plan)
  const after = modelFor(result)
  const repaired = after.routineNodes.find((node) => node.id === target.id)
  assert.ok(repaired, "The generated declaration retains its routine identity")
  assert.equal(repaired.missingCounterpart, undefined)
  assert.ok(isInteger(repaired.declarationOffset))
  assert.equal(result.slice(plan.caretOffset, plan.caretOffset + name.length), name)
  assert.equal(plan.caretOffset, repaired.declarationOffset)
  return { result, after, repaired, plan }
}
const declarationOrder = (source: string) =>
  required(
    readClassLayout(
      source,
      required(
        required(modelFor(source).roots.find((node) => node.label === "TDemo")).offset,
      ),
    ),
  )
    .members.filter((member) => member.kind === "routine")
    .map((member) => member.name)

for (const [description, declarations, bodies, expected] of [
  [
    "adjacent declarations",
    ["procedure Before;", "procedure After;"],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"],
    ["Before", "Missing", "After"],
  ],
  [
    "reversed adjacent declarations",
    ["procedure After;", "procedure Before;"],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"],
    ["After", "Missing", "Before"],
  ],
  [
    "separated declarations",
    ["procedure Before;", "procedure Unimplemented;", "procedure After;"],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"],
    ["Before", "Missing", "Unimplemented", "After"],
  ],
  [
    "previous declaration only",
    ["procedure Before;"],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"],
    ["Before", "Missing"],
  ],
  [
    "next declaration only",
    ["procedure After;"],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"],
    ["Missing", "After"],
  ],
] satisfies Array<[string, string[], string[], string[]]>) {
  test(`reverse generation uses ${description}`, () => {
    assert.deepEqual(
      declarationOrder(declare(unit(declarations, bodies.map(body))).result),
      expected,
    )
  })
}

test("reverse placement does not search past missing immediate counterparts", () => {
  const source = unit(
    ["procedure Zeta;", "procedure Alpha;"],
    [
      "TDemo.Zeta",
      "TDemo.MissingPrevious",
      "TDemo.Missing",
      "TDemo.MissingNext",
      "TDemo.Alpha",
    ].map(body),
  )
  assert.deepEqual(declarationOrder(declare(source).result), [
    "Missing",
    "Zeta",
    "Alpha",
  ])
})

test("reverse placement prefers protected over private and public neighbors", () => {
  for (const other of ["private", "public"]) {
    const source = unit(
      [other, "procedure Before;", "protected", "procedure After;"],
      ["TDemo.Before", "TDemo.Missing", "TDemo.After"].map(body),
    )
    const { result, repaired } = declare(source)
    assert.equal(repaired.access, "protected")
    assert.match(result, /protected\n    procedure Missing;\n    procedure After;/)
  }
})

test("private is preferred when no protected neighbor exists, retaining strict visibility", () => {
  for (const section of ["private", "strict private", "strict protected"]) {
    const source = unit(
      [section, "procedure Before;", "public", "procedure After;"],
      ["TDemo.Before", "TDemo.Missing", "TDemo.After"].map(body),
    )
    const { repaired } = declare(source)
    assert.equal(repaired.access, section.replace(" ", "-"))
  }
})

test("neighbors in separate visibility blocks use the previous block", () => {
  const source = unit(
    [
      "protected",
      "procedure After;",
      "private",
      "FValue: Integer;",
      "protected",
      "procedure Before;",
    ],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"].map(body),
  )
  assert.deepEqual(declarationOrder(declare(source).result), [
    "After",
    "Before",
    "Missing",
  ])
})

test("alphabetical fallback uses public declarations across blocks and keeps overloads together", () => {
  const source = unit(
    [
      "private",
      "procedure Alpha;",
      "public",
      "procedure Zeta;",
      "protected",
      "procedure Other;",
      "public",
      "procedure Omega;",
    ],
    [body("TDemo.Missing")],
  )
  const { result, repaired } = declare(source)
  assert.equal(repaired.access, "public")
  assert.match(result, /public\n    procedure Missing;\n    procedure Zeta;/)
  const overloaded = unit(
    ["procedure Missing(Value: Integer); overload;"],
    ["procedure TDemo.Missing(Value: string);\nbegin\nend;"],
  )
  const created = declare(overloaded).result
  assert.match(
    created,
    /procedure Missing\(Value: Integer\); overload;\n    procedure Missing\(Value: string\); overload;/,
  )
})

test("empty public blocks accept declarations after fields; absent public gets a new block", () => {
  const empty = unit(
    ["FValue: Integer;", "property Value: Integer read FValue;"],
    [body("TDemo.Missing")],
  )
  assert.match(
    declare(empty).result,
    /property Value: Integer read FValue;\n    procedure Missing;\n  end;/,
  )
  const absent = unit(["private", "FValue: Integer;"], [body("TDemo.Missing")])
    .replace("  public\n", "")
    .replace("    private\n", "  private\n")
  const { result, after } = declare(absent)
  assert.match(result, /FValue: Integer;\n  public\n    procedure Missing;\n  end;/)
  assert.equal(
    required(
      required(readClassLayout(result, required(after.roots[0].offset))).members.find(
        (member) => member.name === "FValue",
      ),
    ).access,
    "private",
  )
})

test("nested class visibility does not leak into the outer class or its insertion anchors", () => {
  const source = unit(
    [
      "private",
      "type",
      "TInner = class",
      "public",
      "procedure Inner;",
      "end;",
      "procedure Before;",
    ],
    ["TDemo.Before", "TDemo.Missing"].map(body),
  )
  const initial = modelFor(source)
  assert.equal(
    required(initial.routineNodes.find((node) => node.name === "Before")).access,
    "private",
  )
  const { repaired } = declare(source)
  assert.equal(repaired.access, "private")
})

test("anonymous record fields and inline visibility labels retain the correct class boundary", () => {
  const source = unit(
    ["private", "FData: record", "Value: Integer;", "end;", "public procedure Before;"],
    ["TDemo.Before", "TDemo.Missing"].map(body),
  )
  const { result, repaired } = declare(source)
  assert.equal(repaired.access, "public")
  assert.ok(
    result.indexOf("procedure Missing;") > result.indexOf("public procedure Before;"),
  )
  assert.ok(result.includes("FData: record\n    Value: Integer;\n    end;"))
})

test("shorthand classes expand while forward-only or unavailable owners reject creation", () => {
  const source =
    "unit CreateSample;\ninterface\ntype\n  TDemo = class(TObject); // class note\nimplementation\n" +
    body("TDemo.Missing") +
    "\nend."
  const { result } = declare(source)
  assert.match(
    result,
    /TDemo = class\(TObject\)\n  public\n    procedure Missing;\n  end; \/\/ class note/,
  )
  for (const altered of [
    source.replace("class(TObject)", "class"),
    source.replace("  TDemo = class(TObject); // class note\n", ""),
  ]) {
    const model = modelFor(altered)
    const target = required(model.routineNodes.find((node) => node.name === "Missing"))
    assert.match(
      required(
        planRoutineCounterpart(altered, model, required(target.implementationOffset))
          .reason,
      ),
      /class definition/,
    )
  }
})

test("reverse generation retains defaults, calling conventions, generic parameters and class modifiers", () => {
  const source = `unit CreateSample;
interface
type
  TOuter<T: class> = class
  type
    TInner<U> = class
    public
    end;
  end;
implementation
class function TOuter<T>.TInner<U>.Missing<V>(
  const Text: string = 'a  b''c'; Value: V = nil): U; stdcall;
begin
end;
end.`
  const { result, repaired } = declare(source)
  assert.match(
    result,
    /class function Missing<V>\( const Text: string = 'a  b''c'; Value: V = nil\): U; stdcall;/,
  )
  assert.equal(required(repaired.parent).name, "TInner")
  assert.ok(result.includes("class function TOuter<T>.TInner<U>.Missing<V>("))
})

test("reverse anchors include multiline directives, trailing notes and attached documentation/attributes", () => {
  const source = unit(
    [
      "procedure Before;",
      "  reintroduce;",
      "  virtual; // trailing note",
      "// documentation for After",
      "[SomeAttribute]",
      "procedure After;",
    ],
    ["TDemo.Before", "TDemo.Missing", "TDemo.After"].map(body),
  )
  const { result } = declare(source)
  assert.match(result, /virtual; \/\/ trailing note\n    procedure Missing;/)
  assert.ok(
    result.includes(
      "// documentation for After\n    [SomeAttribute]\n    procedure After;",
    ),
  )
  const nextOnly = unit(
    ["// documentation", "[SomeAttribute]", "procedure After;"],
    ["TDemo.Missing", "TDemo.After"].map(body),
  )
  assert.match(
    declare(nextOnly).result,
    /procedure Missing;\n    \/\/ documentation\n    \[SomeAttribute\]\n    procedure After;/,
  )
})

test("global reverse generation uses interface neighbors and ignores other classes", () => {
  const source = `unit CreateSample;
interface
procedure After;
procedure Before;
implementation
${body("Before")}
${body("TOther.Work")}
${body("Missing")}
${body("After")}
end.`
  const { result, repaired } = declare(source)
  assert.match(
    result,
    /interface\nprocedure After;\nprocedure Missing;\nprocedure Before;/,
  )
  assert.ok(required(repaired.declarationOffset) < result.indexOf("implementation"))
})

test("global declarations append after interface types when none exist and preserve literal/comment headers", () => {
  const source = `unit CreateSample;
interface
type TItem = Integer;
var Item: TItem;
implementation
function Missing(Value: TItem { type note }; const Text: string = 'a  b'): Integer; cdecl;
begin
  Result := Value;
end;
end.`
  const { result } = declare(source)
  assert.match(
    result,
    /var Item: TItem;\n\nfunction Missing\(Value: TItem \{ type note \}; const Text: string = 'a  b'\): Integer; cdecl;\n\nimplementation/,
  )
})

test("overload repairs update directives and expand abbreviated headings without changing bodies", () => {
  const source = unit(
    ["procedure Missing(Value: Integer); reintroduce; virtual;"],
    [
      "procedure TDemo.Missing; // heading note\nbegin\n  Use(Value);\nend;",
      "procedure TDemo.Missing(Value: string);\nbegin\n  Use(Value);\nend;",
    ],
  )
  const model = modelFor(source)
  const target = required(
    model.routineNodes.find((node) => node.missingCounterpart === "declaration"),
  )
  const plan = planRoutineCounterpart(
    source,
    model,
    required(target.implementationOffset),
  )
  assert.equal(plan.reason, undefined)
  const result = applyCounterpart(source, plan)
  assert.match(
    result,
    /procedure Missing\(Value: Integer\); reintroduce; overload; virtual;/,
  )
  assert.match(result, /procedure Missing\(Value: string\); overload;/)
  assert.ok(
    result.includes(
      "procedure TDemo.Missing(Value: Integer); // heading note\nbegin\n  Use(Value);\nend;",
    ),
  )
  assert.equal(result.slice(plan.caretOffset, plan.caretOffset + 7), "Missing")
  assert.equal(
    modelFor(result).routineNodes.filter((node) => node.missingCounterpart).length,
    0,
  )
  assert.equal(plan.edits.length, 3)
})

test("global private overloads remain private while their directives are made consistent", () => {
  const source =
    "unit CreateSample;\ninterface\nimplementation\nprocedure Missing(Value: string);\nbegin\nend;\nprocedure Missing(Value: Integer);\nbegin\nend;\nend."
  const model = modelFor(source)
  const plan = planRoutineCounterpart(
    source,
    model,
    source.lastIndexOf("Missing(Value: Integer)"),
  )
  assert.equal(plan.reason, undefined)
  const result = applyCounterpart(source, plan)
  assert.match(
    result,
    /interface\n\nprocedure Missing\(Value: Integer\); overload;\n\nimplementation/,
  )
  assert.match(result, /implementation\nprocedure Missing\(Value: string\); overload;/)
  assert.equal(
    modelFor(result).routineNodes.filter(
      (node) => required(node.declarationOffset) < result.indexOf("implementation"),
    ).length,
    1,
  )
})

test("invalid overload signatures and property contracts reject all changes", () => {
  for (const [declarations, implementation] of [
    [
      ["function Missing(Value: Integer): Integer;"],
      "function TDemo.Missing(Value: Integer): string;",
    ],
    [
      ["procedure Missing(var Value: Integer);"],
      "procedure TDemo.Missing(const Value: Integer);",
    ],
    [
      ["function Missing: Integer;", "property Value: Integer read Missing;"],
      "function TDemo.Missing(Index: Integer): Integer;",
    ],
    [["Missing: Integer;"], "procedure TDemo.Missing;"],
  ] satisfies Array<[string[], string]>) {
    const source = unit(declarations, [implementation + "\nbegin\nend;"])
    const model = modelFor(source)
    const target = required(
      model.routineNodes.find((node) => node.missingCounterpart === "declaration"),
    )
    const plan = planRoutineCounterpart(
      source,
      model,
      required(target.implementationOffset),
    )
    assert.ok(plan.reason)
    assert.equal(plan.edits, undefined)
  }
})

test("a caret inside a top-level body works, while local routines and existing counterparts are rejected", () => {
  const source = unit(
    [],
    [
      "procedure TDemo.Missing;\n  procedure Local;\n  begin\n  end;\nbegin\n  Local;\nend;",
    ],
  )
  const model = modelFor(source)
  const caret = source.lastIndexOf("Local;")
  assert.equal(declare(source, "Missing", caret).plan.direction, "declaration")
  assert.match(
    required(planRoutineCounterpart(source, model, source.indexOf("Local;")).reason),
    /Local routines/,
  )
  const paired = unit(
    ["procedure Missing(Value: Integer);"],
    ["procedure TDemo.Missing;\nbegin\nend;"],
  )
  assert.match(
    required(
      planRoutineCounterpart(
        paired,
        modelFor(paired),
        paired.indexOf("TDemo.Missing") + 6,
      ).reason,
    ),
    /already has a declaration/,
  )
})

test("reverse generation honors CRLF and tab indentation", () => {
  const source =
    "unit CreateSample;\ninterface\ntype\n\tTDemo = class\n\tprivate\n\t\tprocedure Before;\n\tend;\nimplementation\n" +
    [body("TDemo.Before"), body("TDemo.Missing")].join("\n") +
    "\nend."
  const text = source.replace(/\n/g, "\r\n")
  const plan = planRoutineCounterpart(
    text,
    modelFor(text),
    text.lastIndexOf("Missing"),
    { insertSpaces: false, tabSize: 4 },
  )
  assert.equal(plan.reason, undefined)
  assert.equal(plan.edits[0].text, "\t\tprocedure Missing;\r\n")
})

test("reverse creation and overload repairs are one undoable edit with the caret on the new declaration", async () => {
  const source = unit(
    ["procedure Missing(Value: Integer);"],
    [
      "procedure TDemo.Missing;\nbegin\nend;",
      "procedure TDemo.Missing(Value: string);\nbegin\nend;",
    ],
  )
  const env = editorHarness(source)
  const position = env.document.positionAt(source.lastIndexOf("Missing(Value: string)"))
  env.editor.selection = new env.vscode.Selection(position, position)
  const command = createImplementationCommand(env.vscode, {
    readyModel: env.readyModel,
  })
  assert.equal(await command(), true)
  assert.equal(env.edits.length, 1)
  assert.equal(env.edits[0].insertions.length, 3)
  const current = modelFor(env.document.getText())
  const target = required(
    current.routineNodes.find((node) =>
      required(node.signature).includes("Value: string"),
    ),
  )
  assert.equal(
    env.document.offsetAt(env.editor.selection.active),
    target.declarationOffset,
  )
  assert.equal(await command(), false)
  assert.equal(env.edits.length, 1)
  env.undo()
  assert.equal(env.document.getText(), source)
})

test("the command performs shorthand class expansion using the same undo group", async () => {
  const source =
    "unit CreateSample;\ninterface\ntype\n  TDemo = class(TObject);\nimplementation\n" +
    body("TDemo.Missing") +
    "\nend."
  const env = editorHarness(source)
  assert.equal(
    await createImplementationCommand(env.vscode, { readyModel: env.readyModel })(),
    true,
  )
  assert.equal(env.edits.length, 1)
  assert.ok(
    required(env.edits[0].insertions[0].endOffset) > env.edits[0].insertions[0].offset,
  )
  env.undo()
  assert.equal(env.document.getText(), source)
})

test("line comments in implementation headers remain legal in the copied declaration", () => {
  const source =
    "unit CreateSample;\ninterface\nimplementation\nfunction Missing(\n  // parameter note\n  Value: Integer): Integer;\nbegin\n  Result := Value;\nend;\nend."
  const { result } = declare(source)
  assert.ok(result.includes("// parameter note\n Value: Integer): Integer;"))
  assert.equal(
    modelFor(result).routineNodes.filter((node) => node.name === "Missing").length,
    1,
  )
})

test("nested empty interfaces with GUIDs do not disturb outer private visibility", () => {
  const source = unit(
    [
      "private",
      "type",
      "IEmpty = interface",
      "['{01234567-89AB-CDEF-0123-456789ABCDEF}']",
      "end;",
      "procedure Before;",
    ],
    ["TDemo.Before", "TDemo.Missing"].map(body),
  )
  const { repaired } = declare(source)
  assert.equal(repaired.access, "private")
})

test("overload repair supplies an omitted function result type and preserves defining comments", () => {
  const source = unit(
    ["function Missing: Integer;"],
    [
      "function TDemo.Missing { heading note };\nbegin\n  Result := 1;\nend;",
      "function TDemo.Missing(Value: Integer): Integer;\nbegin\n  Result := Value;\nend;",
    ],
  )
  const model = modelFor(source)
  const target = required(
    model.routineNodes.find((node) => node.missingCounterpart === "declaration"),
  )
  const plan = planRoutineCounterpart(
    source,
    model,
    required(target.implementationOffset),
  )
  assert.equal(plan.reason, undefined)
  assert.match(
    applyCounterpart(source, plan),
    /function TDemo\.Missing: Integer \{ heading note \};/,
  )
})

test("a conditional visibility label is rejected even when its following declaration is outside the guard", () => {
  const source = unit(
    ["{$IFDEF FEATURE}", "protected", "{$ENDIF}", "procedure Before;"],
    ["TDemo.Before", "TDemo.Missing"].map(body),
  )
  const model = modelFor(source)
  const target = required(model.routineNodes.find((node) => node.name === "Missing"))
  assert.match(
    required(
      planRoutineCounterpart(source, model, required(target.implementationOffset))
        .reason,
    ),
    /visibility section is conditional/,
  )
})
