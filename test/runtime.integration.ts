import * as assert from "node:assert/strict"
import { test } from "node:test"
import { Worker } from "node:worker_threads"
import { artifactPath } from "./helpers"
import { isRecord } from "../src/shared/guards"
import { WorkerOperation } from "../src/shared/identifiers"
import {
  isCompiledClassMap,
  isCompiledMethodArray,
  isCompiledPackageData,
} from "../src/shared/compiledProtocol"
import { isSourceDefinition } from "../src/usesQuickFix"
import type { CompiledWorkerRequest } from "../src/shared/compiledProtocol"
import type { SourceParserRequest } from "../src/shared/sourceModels"
import type { SyntaxRequest } from "../src/syntaxWorker"
import { isNavigatorWorkerResponse } from "../src/shared/navigator"
import type { NavigatorWorkerRequest } from "../src/shared/navigator"

async function workerReply(entrypoint: string, request: unknown): Promise<unknown> {
  const worker = new Worker(artifactPath(entrypoint))
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${entrypoint} did not respond within five seconds.`)),
        5000,
      )
      worker.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      worker.once("exit", (code) => {
        clearTimeout(timeout)
        if (code !== 0) reject(new Error(`${entrypoint} exited with code ${code}.`))
      })
      worker.once("message", (message: unknown) => {
        clearTimeout(timeout)
        resolve(message)
      })
      worker.postMessage(request)
    })
  } finally {
    await worker.terminate()
  }
}

const source = `unit WorkerSample;
interface
uses System.SysUtils;
type
  TWorker = class
  public
    procedure Run;
  end;
implementation
procedure TWorker.Run;
begin
end;
end.`

test("compiled package worker preserves nested Maps and member metadata", async () => {
  const request = {
    id: 11,
    operation: WorkerOperation.PackageIndex,
    text: "EXPORT ord:0001='WorkerSample::TWorker::Run()'",
    bplPath: "WorkerSample.bpl",
  } satisfies CompiledWorkerRequest
  const response = await workerReply("compiledSymbolWorker.js", request)
  assert.ok(isRecord(response))
  assert.equal(response.id, request.id)
  assert.ok(isCompiledPackageData(response.value))
  const unit = response.value.packageIndex.units.get("workersample")
  assert.ok(unit)
  assert.ok(unit.classes instanceof Map)
  assert.equal(unit.classes.get("tworker")?.methods[0].name, "Run")
})

test("compiled worker supports mangled classes and RTTI operations", async () => {
  const mangledRequest = {
    id: 12,
    operation: WorkerOperation.MangledClasses,
    text: "_ZN12WorkerSample7TWorker3RunE",
    bplPath: "WorkerSample.bpl",
  } satisfies CompiledWorkerRequest
  const mangled = await workerReply("compiledSymbolWorker.js", mangledRequest)
  assert.ok(isRecord(mangled))
  assert.ok(isCompiledClassMap(mangled.value))
  assert.equal(mangled.value.get("tworker")?.methods[0].name, "Run")
  const rttiRequest = {
    id: 13,
    operation: WorkerOperation.RttiMembers,
    text: "1: TWorker\n2: Run\n3: TWorker\n4: Name\n5: TOther",
    classInfo: {
      symbol: "TWorker",
      namespace: "WorkerSample",
      methods: [{ name: "Run" }],
    },
  } satisfies CompiledWorkerRequest
  const rtti = await workerReply("compiledSymbolWorker.js", rttiRequest)
  assert.ok(isRecord(rtti))
  assert.ok(isCompiledMethodArray(rtti.value))
  assert.equal(rtti.value[0]?.name, "Name")
})

test("source-index worker transfers symbol Sets and source definition offsets", async () => {
  const request = {
    id: 21,
    text: source,
    filePath: "WorkerSample.pas",
  } satisfies SourceParserRequest
  const response = await workerReply("sourceIndexWorker.js", request)
  assert.ok(isRecord(response))
  assert.equal(response.id, request.id)
  assert.ok(isRecord(response.unit))
  assert.ok(response.unit.symbols instanceof Set)
  assert.ok(response.unit.symbols.has("TWorker"))
  assert.ok(Array.isArray(response.unit.members))
  assert.ok(response.unit.members.every(isSourceDefinition))
  assert.ok(
    response.unit.members.some(
      (member) =>
        member.symbol === "Run" &&
        member.owner === "TWorker" &&
        typeof member.implementationOffset === "number",
    ),
  )
})

test("navigator worker transfers the complete tree without loading VS Code", async () => {
  const request: NavigatorWorkerRequest = {
    text: source,
    filePath: "WorkerSample.pas",
    options: { showUses: true },
  }
  const response = await workerReply("classNavigatorWorker.js", request)
  assert.ok(isRecord(response))
  assert.ok(isNavigatorWorkerResponse(response) && response.model)
  assert.equal(response.model.filePath, request.filePath)
  assert.ok(Array.isArray(response.model.roots))
  assert.ok(Array.isArray(response.model.nodes))
  assert.ok(
    response.model.nodes.some((node) => isRecord(node) && node.label === "TWorker"),
  )
  assert.ok(response.model.nodes.some((node) => isRecord(node) && node.label === "Run"))
  assert.equal(typeof response.elapsedMs, "number")
})

test("syntax worker preserves document identity and reports diagnostic offsets", async () => {
  const request = {
    id: 31,
    uri: "file:///WorkerSample.pas",
    version: 7,
    text: "unit WorkerSample; interface implementation begin ( end.",
  } satisfies SyntaxRequest
  const response = await workerReply("syntaxWorker.js", request)
  assert.ok(isRecord(response))
  assert.equal(response.id, request.id)
  assert.equal(response.uri, request.uri)
  assert.equal(response.version, request.version)
  assert.ok(Array.isArray(response.diagnostics))
  assert.ok(response.diagnostics.length > 0)
  assert.ok(
    response.diagnostics.every(
      (diagnostic) =>
        isRecord(diagnostic) &&
        typeof diagnostic.offset === "number" &&
        typeof diagnostic.message === "string",
    ),
  )
})

for (const [entrypoint, request] of [
  ["compiledSymbolWorker.js", { id: 41, operation: "unsupported", text: "" }],
  ["sourceIndexWorker.js", { id: 42, text: 123, filePath: "Invalid.pas" }],
  ["classNavigatorWorker.js", { text: 123, filePath: "Invalid.pas" }],
  [
    "syntaxWorker.js",
    { id: 44, uri: "file:///Invalid.pas", version: 1, text: "", defines: 123 },
  ],
] as const) {
  test(`${entrypoint} responds with an error for malformed requests`, async () => {
    const response = await workerReply(entrypoint, request)
    assert.ok(isRecord(response))
    if (entrypoint === "classNavigatorWorker.js")
      assert.ok(isNavigatorWorkerResponse(response))
    assert.ok(typeof response.error === "string")
    assert.ok(response.error.length > 0)
  })
}
test("syntax worker rejects a null envelope without crashing", async () => {
  const response = await workerReply("syntaxWorker.js", null)
  assert.ok(isRecord(response))
  assert.equal(response.id, -1)
  assert.ok(typeof response.error === "string")
  assert.match(response.error, /Invalid syntax-worker request/)
})
