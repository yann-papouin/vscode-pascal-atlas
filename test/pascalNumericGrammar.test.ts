import { isRecord } from "../src/shared/guards"
import { required } from "./helpers"
import { resourcePath } from "./helpers"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import { test } from "node:test"

const grammarPath = resourcePath("pascal-numeric.injection.tmLanguage.json")
const grammar: unknown = JSON.parse(fs.readFileSync(grammarPath, "utf8"))
assert.ok(isRecord(grammar))
assert.ok(typeof grammar.injectionSelector === "string")
const injectionSelector = grammar.injectionSelector
assert.ok(Array.isArray(grammar.patterns))
const patterns = grammar.patterns.map((pattern: unknown) => {
  assert.ok(isRecord(pattern))
  assert.ok(typeof pattern.name === "string")
  assert.ok(typeof pattern.match === "string")
  return { name: pattern.name, regex: new RegExp(pattern.match, "g") }
})

function tokenize(source: string) {
  const tokens = []
  let offset = 0

  while (offset < source.length) {
    let bestMatch = null
    let bestPattern = null

    for (const pattern of patterns) {
      pattern.regex.lastIndex = offset
      const match = pattern.regex.exec(source)
      if (!match) {
        continue
      }
      if (!bestMatch || match.index < bestMatch.index) {
        bestMatch = match
        bestPattern = pattern
      }
    }

    if (!bestMatch) {
      break
    }

    tokens.push({ text: bestMatch[0], scope: required(bestPattern).name })
    offset = bestMatch.index + bestMatch[0].length
  }

  return tokens
}

test("numeric injection excludes comments, strings, and compiler directives", () => {
  assert.match(injectionSelector, /-comment/)
  assert.match(injectionSelector, /-string/)
  assert.match(injectionSelector, /-meta\.preprocessor/)
})

test("recognizes Delphi decimal, real, scientific, and hexadecimal literals", () => {
  assert.deepEqual(tokenize("0 42 1.0 1E-7 12.25e+6 $8F $DEAD_BEEF 1_000_000"), [
    { text: "0", scope: "constant.numeric.integer.pascal" },
    { text: "42", scope: "constant.numeric.integer.pascal" },
    { text: "1.0", scope: "constant.numeric.float.pascal" },
    { text: "1E-7", scope: "constant.numeric.float.pascal" },
    { text: "12.25e+6", scope: "constant.numeric.float.pascal" },
    { text: "$8F", scope: "constant.numeric.hex.pascal" },
    { text: "$DEAD_BEEF", scope: "constant.numeric.hex.pascal" },
    { text: "1_000_000", scope: "constant.numeric.integer.pascal" },
  ])
})

test("recognizes Pascal binary and octal literals without confusing escaped identifiers", () => {
  assert.deepEqual(tokenize("%1010_0011 &755 &Integer"), [
    { text: "%1010_0011", scope: "constant.numeric.binary.pascal" },
    { text: "&755", scope: "constant.numeric.octal.pascal" },
  ])
})

test("does not color numeric-looking fragments inside identifiers or malformed literals", () => {
  assert.deepEqual(tokenize("Version1E7 Value$8F $G1 1E 1__0"), [])
})

test("keeps a Pascal range as two integers instead of a real literal", () => {
  assert.deepEqual(tokenize("1..10"), [
    { text: "1", scope: "constant.numeric.integer.pascal" },
    { text: "10", scope: "constant.numeric.integer.pascal" },
  ])
})
