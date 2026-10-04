import * as assert from "node:assert/strict"
import { testModuleLoader as Module } from "./helpers"
import { test } from "node:test"

const originalLoad = Module._load
Module._load = function loadWithVscodeStub(
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
) {
  if (request === "vscode") return {}
  return originalLoad.call(this, request, parent, isMain)
}
import {
  GROUPS,
  LEGACY_BUILD_ARTIFACT_PATTERN,
  LEGACY_PROJECT_METADATA_PATTERN,
} from "../src/explorerSupport"
Module._load = originalLoad

test("SKINCFG files have an independent configurable Explorer exclusion group", () => {
  assert.equal(GROUPS["explorer.hideSkinConfigFiles"], "**/*.skincfg")
  assert.notEqual(
    GROUPS["explorer.hideSkinConfigFiles"],
    GROUPS["explorer.hideProjectMetadata"],
  )
})

test("GROUPPROJ remains visible while stale managed metadata rules can be migrated", () => {
  assert.match(LEGACY_PROJECT_METADATA_PATTERN, /groupproj/)
  assert.doesNotMatch(GROUPS["explorer.hideProjectMetadata"], /groupproj/)
})

test("MES files are hidden with build artifacts and the previous rule remains migratable", () => {
  assert.match(GROUPS["explorer.hideBuildArtifacts"], /mes/)
  assert.doesNotMatch(LEGACY_BUILD_ARTIFACT_PATTERN, /mes/)
})
