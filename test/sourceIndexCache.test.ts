import type { SourceIndex } from "../src/shared/sourceModels"
import { sourcePath } from "./helpers"
import { isInteger } from "../src/shared/guards"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import {
  buildSourceUnitIndex,
  findSourceMemberDefinitions,
  findMissingUnitReferences,
  parseSourceUnitSymbols,
  selectBestPascalDefinitions,
} from "../src/usesQuickFix"

test("source index cache restores unchanged workspaces and invalidates changed files", async (t) => {
  const root = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "pascal-atlas-source-cache-"),
  )
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }))
  const sourcePath = path.join(root, "CacheSample.pas")
  const cachePath = path.join(root, ".cache", "source-index.json.gz")
  await fs.promises.writeFile(
    sourcePath,
    [
      "unit CacheSample;",
      "interface",
      "type",
      "  TFirst = class end;",
      "implementation",
      "end.",
    ].join("\n"),
  )

  const initial = await buildSourceUnitIndex([root], { cachePath })
  assert.equal(initial.cacheHit, false)
  assert.equal(initial.definitions.has("tfirst"), true)
  assert.equal(fs.existsSync(cachePath), true)

  const restored = await buildSourceUnitIndex([root], { cachePath })
  assert.equal(restored.cacheHit, true)
  assert.equal(restored.definitions.has("tfirst"), true)

  await fs.promises.writeFile(
    sourcePath,
    [
      "unit CacheSample;",
      "interface",
      "type",
      "  TSecondLonger = class end;",
      "implementation",
      "end.",
    ].join("\n"),
  )
  const rebuilt = await buildSourceUnitIndex([root], { cachePath })
  assert.equal(rebuilt.cacheHit, false)
  assert.equal(rebuilt.definitions.has("tsecondlonger"), true)
})

test("missing-unit scan ignores member names after a dot without prefix rescans", () => {
  const index = new Map([
    ["tmissing", new Set<string>(["Missing.Types"])],
    ["membername", new Set<string>(["Wrong.Member.Unit"])],
    ["unknowncall", new Set<string>(["Missing.Functions"])],
  ])
  const source = `unit MissingSample;
interface
implementation
procedure Run;
var Value: TMissing;
begin
  Value.MemberName;
  UnknownCall;
end;
end.
`
  const references = findMissingUnitReferences(source, index)
  assert.deepEqual(
    references.map((item) => item.symbol),
    ["TMissing", "UnknownCall"],
  )
})

test("missing-unit assistance is driven by compiler diagnostics instead of speculative Problems", () => {
  const extensionSource = fs.readFileSync(sourcePath("extension.js"), "utf8")
  assert.doesNotMatch(
    extensionSource,
    /createDiagnosticCollection\(['"]pascalAtlas\.missingUnits/,
  )
  assert.doesNotMatch(extensionSource, /Unknown type.*missing Unit in uses/)
  assert.match(extensionSource, /unknownSymbolFromDiagnostic\(diagnostic\.message\)/)
  assert.match(extensionSource, /registerCodeActionsProvider\(/)
  assert.match(extensionSource, /new vscode\.CodeAction\([\s\S]*?Add .* to uses/)
})

test("definition links pin Ctrl-hover decoration to the exact source token", () => {
  const extensionSource = fs.readFileSync(sourcePath("extension.js"), "utf8")
  assert.match(
    extensionSource,
    /definitionLink\(originSelectionRange(?:: vscode\.Range)?,[\s\S]*?originSelectionRange,[\s\S]*?targetUri/,
  )
  assert.match(
    extensionSource,
    /locationsForDefinitions\([\s\S]*?document,[\s\S]*?token\.range[\s\S]*?\);/,
  )
  assert.match(
    extensionSource,
    /location:\s*this\.definitionLink\([\s\S]*?token\.range/,
  )
  assert.match(
    extensionSource,
    /return this\.definitionLink\([\s\S]*?compiledReference\.token\.range/,
  )
})

test("source index attaches class and static routines to their declaring type", () => {
  const source = `unit StaticMembers;
interface
type
  TProjectQueries = class
    constructor Create;
    class function ExportFiles: Boolean; static;
  end;
implementation
constructor TProjectQueries.Create;
begin
end;
class function TProjectQueries.ExportFiles: Boolean;
begin
  Result := True;
end;
end.`
  const parsed = parseSourceUnitSymbols(source, "StaticMembers.pas")
  assert.ok(parsed)
  const members = parsed.members.filter((item) => item.owner === "TProjectQueries")
  const create = members.find((item) => item.symbol === "Create")
  assert.ok(create)
  const exportFiles = members.find((item) => item.symbol === "ExportFiles")
  assert.ok(exportFiles)
  assert.equal(isInteger(create.implementationOffset), true)
  assert.equal(isInteger(exportFiles.implementationOffset), true)
})

test("source index records generic collection aliases and global function result types", () => {
  const source = `unit ChainedTypes;
interface
uses System.Generics.Collections;
type
  TTestData = class
    FName: string;
    procedure Compare(
      var Value: Integer);
  end;
  TTestDatas = TList<TTestData>;
function CurrentData: TTestData;
implementation
function CurrentData: TTestData;
begin
end;
end.`
  const parsed = parseSourceUnitSymbols(source, "ChainedTypes.pas")
  assert.ok(parsed)
  const alias = parsed.types.find((item) => item.symbol === "TTestDatas")
  assert.ok(alias)
  const routine = parsed.definitions.find(
    (item) => item.kind === "routine" && item.symbol === "CurrentData",
  )
  assert.ok(routine)
  assert.equal(alias.aliasedType, "TList<TTestData>")
  assert.equal(alias.elementType, "TTestData")
  assert.equal(routine.typeName, "TTestData")
})

test("source member lookup follows Delphi type aliases", () => {
  const source = `unit AliasMembers;
interface
type
  TActualPoint = class
    Id: Integer;
    property Name: string read FName;
  end;
  TPointAlias = TActualPoint;
implementation
end.`
  const parsed = parseSourceUnitSymbols(source, "AliasMembers.pas")
  assert.ok(parsed)
  const types: SourceIndex["types"] = new Map()
  const members: SourceIndex["members"] = new Map()
  for (const definition of parsed.types) {
    const key = definition.symbol.toLowerCase()
    if (!types.has(key)) types.set(key, [])
    types.get(key)!.push(definition)
  }
  for (const definition of parsed.members) {
    assert.ok(definition.owner)
    const owner = definition.owner.toLowerCase()
    const member = definition.symbol.toLowerCase()
    if (!members.has(owner)) members.set(owner, new Map())
    if (!members.get(owner)!.has(member)) members.get(owner)!.set(member, [])
    members.get(owner)!.get(member)!.push(definition)
  }

  assert.equal(
    findSourceMemberDefinitions({ types, members }, "TPointAlias", "Id")[0].kind,
    "field",
  )
  assert.equal(
    findSourceMemberDefinitions({ types, members }, "TPointAlias", "Name")[0].kind,
    "property",
  )
})

test("classes without an explicit ancestor inherit TObject members", () => {
  const source = `unit ImplicitAncestor;
interface
type
  TObject = class
    procedure Free;
  end;
  TWorker = class
    procedure Run;
  end;
implementation
end.`
  const parsed = parseSourceUnitSymbols(source, "ImplicitAncestor.pas")
  assert.ok(parsed)
  const types: SourceIndex["types"] = new Map()
  const members: SourceIndex["members"] = new Map()
  for (const definition of parsed.types) {
    const key = definition.symbol.toLowerCase()
    if (!types.has(key)) types.set(key, [])
    types.get(key)!.push(definition)
  }
  for (const definition of parsed.members) {
    assert.ok(definition.owner)
    const owner = definition.owner.toLowerCase()
    const member = definition.symbol.toLowerCase()
    if (!members.has(owner)) members.set(owner, new Map())
    if (!members.get(owner)!.has(member)) members.get(owner)!.set(member, [])
    members.get(owner)!.get(member)!.push(definition)
  }

  assert.deepEqual(types.get("tobject")![0].baseTypes, [])
  assert.deepEqual(types.get("tworker")![0].baseTypes, ["TObject"])
  assert.equal(
    findSourceMemberDefinitions({ types, members }, "TWorker", "Free")[0].kind,
    "routine",
  )
})

test("normal navigation selects one implementation for overloaded RTL routines", () => {
  const definitions = [
    {
      symbol: "IntToStr",
      kind: "routine",
      unitName: "System.SysUtils",
      offset: 100,
      implementationOffset: 1000,
      signature: "function IntToStr(Value: Integer): string;",
    },
    {
      symbol: "IntToStr",
      kind: "routine",
      unitName: "System.SysUtils",
      offset: 200,
      implementationOffset: 2000,
      signature: "function IntToStr(Value: Int64): string;",
    },
  ]

  const selected = selectBestPascalDefinitions(definitions, {
    preferImplementation: true,
    singleTarget: true,
    usedUnitNames: ["System.SysUtils"],
  })
  assert.equal(selected.usedImplementation, true)
  assert.equal(selected.definitions.length, 1)
  assert.equal(selected.definitions[0].implementationOffset, 1000)

  const all = selectBestPascalDefinitions(definitions, {
    preferImplementation: true,
    singleTarget: false,
    usedUnitNames: ["System.SysUtils"],
  })
  assert.equal(all.definitions.length, 2)
})

test("source parsing retains mixed-case keyword captures and implementation positions", () => {
  const source = `UniT CaptureSample;
InTeRfAcE
TyPe
  THandler = cLaSs
  pUbLiC
    pRoCeDuRe Run(Value: TValue);
  eNd;
iMpLeMeNtAtIoN
pRoCeDuRe THandler.Run(Value: TValue);
bEgIn
eNd;
eNd.`
  const parsed = parseSourceUnitSymbols(source, "CaptureSample.pas")
  assert.ok(parsed)
  assert.equal(parsed.unitName, "CaptureSample")
  assert.equal(
    parsed.types.find((definition) => definition.symbol === "THandler")?.structureKind,
    "class",
  )
  const routine = parsed.members.find((definition) => definition.symbol === "Run")
  assert.ok(routine)
  assert.equal(routine.offset, source.indexOf("Run(Value"))
  assert.equal(
    routine.implementationOffset,
    source.indexOf("THandler.Run") + "THandler.".length,
  )
  assert.match(routine.signature || "", /pRoCeDuRe Run\(Value: TValue\);/)
})
