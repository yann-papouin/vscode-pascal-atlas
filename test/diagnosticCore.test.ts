import { sourcePath } from "./helpers"
import * as assert from "node:assert/strict"
import { test } from "node:test"
import {
  compilerEnvironmentWithSearchPath,
  excludeManagedSourcePaths,
} from "../src/diagnosticCore"

test("background compiler excludes navigation source paths but keeps compiler libraries", () => {
  const inherited = [
    "C:\\Program Files (x86)\\Embarcadero\\Studio\\22.0\\lib\\Win64\\release",
    "C:\\Program Files (x86)\\DevExpress\\VCL\\Library\\RS28\\Win64",
    "D:\\Projects\\Tubest\\CAD\\GksExt",
    "D:\\Projects\\Tubest\\CAD\\graphics",
    "D:\\Projects\\Tubest\\lib",
  ]
  const managed = [
    "d:\\projects\\tubest\\cad\\GksExt\\",
    "D:\\Projects\\Tubest\\CAD\\graphics",
  ]
  assert.deepEqual(excludeManagedSourcePaths(inherited, managed), [
    inherited[0],
    inherited[1],
    inherited[4],
  ])
})

test("isolated compiler environment replaces every case variant of DCC_UnitSearchPath", () => {
  const original = {
    Path: "C:\\Windows",
    DCC_UnitSearchPath: "D:\\NavigationSource",
    dcc_unitsearchpath: "D:\\DuplicateNavigationSource",
  }
  const result = compilerEnvironmentWithSearchPath(original, [
    "C:\\Delphi\\lib\\Win64\\release",
    "D:\\ThirdParty\\lib",
  ])
  assert.deepEqual(result, {
    Path: "C:\\Windows",
    DCC_UnitSearchPath: "C:\\Delphi\\lib\\Win64\\release;D:\\ThirdParty\\lib",
  })
  assert.equal(original.DCC_UnitSearchPath, "D:\\NavigationSource")
})

test("background diagnostics never consumes the injected process path directly", () => {
  const source = require("node:fs").readFileSync(
    sourcePath("backgroundDiagnostics.js"),
    "utf8",
  )
  assert.doesNotMatch(source, /process\.env\.DCC_UnitSearchPath/)
  assert.match(
    source,
    /excludeManagedSourcePaths\(inherited, this\.managedNavigationPaths\(\)\)/,
  )
  assert.match(source, /env: isolatedCompiler\.environment/)
})

test("background diagnostics decodes compiler bytes before parsing Problems", () => {
  const source = require("node:fs").readFileSync(
    sourcePath("backgroundDiagnostics.js"),
    "utf8",
  )
  assert.match(source, /encoding:\s*["']buffer["']/)
  assert.match(source, /decodeProcessOutput\(result\.stdout\)/)
  assert.match(source, /decodeProcessOutput\(result\.stderr\)/)
})
