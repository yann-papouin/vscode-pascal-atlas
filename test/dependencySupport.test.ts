import * as assert from "node:assert/strict"
import { testModuleLoader as Module } from "./helpers"
import { test } from "node:test"

const originalLoad = Module._load
Module._load = function loadWithVscodeStub(
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
) {
  if (request === "vscode") return { extensions: { all: [] } }
  return originalLoad.call(this, request, parent, isMain)
}
import { REQUIRED_EXTENSIONS, REDUNDANT_EXTENSIONS } from "../src/dependencySupport"
Module._load = originalLoad

test("dependency checks retain Vallenta and C/C++ without Delphi Debugger", () => {
  assert.deepEqual(
    REQUIRED_EXTENSIONS.map((extension) => extension.id),
    ["VallentaStudio.vallenta-studio", "ms-vscode.cpptools"],
  )
  assert.equal(
    REQUIRED_EXTENSIONS.some((extension) => /delphi.?debugger/i.test(extension.id)),
    false,
  )
  assert.equal(
    REDUNDANT_EXTENSIONS.some((extension) => /delphi.?debugger/i.test(extension.id)),
    false,
  )
})
