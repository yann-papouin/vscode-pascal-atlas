import * as assert from "node:assert/strict"
import { test } from "node:test"

// The production module imports vscode, which is unavailable under node:test.
// Exercise its pure policy by loading a tiny vscode shim for this module only.
import { testModuleLoader as Module } from "./helpers"
const originalLoad = Module._load
Module._load = function load(
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
) {
  if (request === "vscode") return {}
  return originalLoad.call(this, request, parent, isMain)
}
import {
  mergedAssociations,
  platformSourceAssociationPatterns,
} from "../src/platformSourceIsolation"
Module._load = originalLoad

test("platform source isolation creates version-specific RTL and VCL associations", () => {
  assert.deepEqual(
    platformSourceAssociationPatterns(
      "C:\\Program Files (x86)\\Embarcadero\\Studio\\22.0\\",
    ),
    [
      "**/Embarcadero/Studio/22.0/source/rtl/**/*.pas",
      "**/Embarcadero/Studio/22.0/source/vcl/**/*.pas",
    ],
  )
})

test("platform source isolation preserves normal Pascal associations and removes only its own entries", () => {
  const patterns = platformSourceAssociationPatterns("C:\\Embarcadero\\Studio\\22.0")
  const enabled = mergedAssociations({ "*.pas": "pascal" }, patterns, true)
  assert.equal(enabled.associations["*.pas"], "pascal")
  assert.equal(enabled.associations[patterns[0]], "pascal-atlas-platform")
  assert.equal(enabled.associations[patterns[1]], "pascal-atlas-platform")

  enabled.associations[patterns[1]] = "plaintext"
  const disabled = mergedAssociations(enabled.associations, patterns, false)
  assert.equal(disabled.associations[patterns[0]], undefined)
  assert.equal(disabled.associations[patterns[1]], "plaintext")
})
