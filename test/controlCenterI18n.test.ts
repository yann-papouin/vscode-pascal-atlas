import { test } from "node:test"
import * as assert from "node:assert/strict"
import {
  PAGE_GROUPS,
  languageCode,
  localizedPages,
  sectionsWithPages,
} from "../src/controlCenterI18n"

test("control center uses English and exposes seven consolidated pages", () => {
  assert.equal(languageCode(undefined), "en")
  assert.deepEqual(
    localizedPages().map((page) => page.title),
    [
      "General",
      "Editing",
      "Navigation & Symbols",
      "Formatting",
      "Projects & Files",
      "Build & Debug",
      "Diagnostics",
    ],
  )
  assert.equal(PAGE_GROUPS.length, 7)
})

test("settings sections retain English labels and receive their page IDs", () => {
  const source = [
    {
      title: "File encoding",
      description: "Encoding options for Pascal and other files.",
      settings: [
        {
          key: "encoding.enabled",
          label: "Enable file encoding policy",
          type: "boolean",
        },
      ],
      actions: [],
    },
  ]
  const [section] = sectionsWithPages(source, "en")
  assert.equal(section.pageId, "editing")
  assert.equal(section.title, "File encoding")
  assert.equal(section.settings[0].label, "Enable file encoding policy")
})
