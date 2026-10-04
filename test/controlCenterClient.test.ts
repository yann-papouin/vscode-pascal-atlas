import * as assert from "node:assert/strict"
import * as vm from "node:vm"
import { test } from "node:test"
import { readBrowserScript, required } from "./helpers"
import { SettingKey } from "../src/shared/identifiers"
import {
  WebviewMessageKind,
  type ControlCenterClientMessage,
  type ControlCenterState,
} from "../src/shared/webviewProtocols"

class TestElement {
  dataset: Record<string, string> = {}
  textContent = ""
  value = ""
  disabled = false
  parentElement: TestElement | undefined
  colorLabel: TestElement | undefined
  setting: TestElement | undefined
  listeners = new Map<string, () => void>()
  classes = new Set<string>()
  classList = {
    toggle: (name: string, enabled: boolean) => {
      if (enabled) this.classes.add(name)
      else this.classes.delete(name)
    },
  }
  querySelector(selector: string) {
    return selector === "[data-color-value]" ? this.colorLabel : undefined
  }
  closest(selector: string) {
    return selector === ".setting" ? this.setting : undefined
  }
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener)
  }
  dispatch(name: string) {
    required(this.listeners.get(name))()
  }
}
class TestInput extends TestElement {
  type = "text"
  checked = false
}
function harness(initial: unknown) {
  const controls = new Map<string, TestInput>()
  for (const [key, type] of [
    [SettingKey.Enabled, "checkbox"],
    [SettingKey.ColoringColorsType, "color"],
    [SettingKey.ColoringTypingDelayMs, "number"],
    [SettingKey.FormatterStyleUseDefault, "checkbox"],
  ]) {
    const input = new TestInput()
    input.dataset.key = key
    input.type = type
    input.setting = new TestElement()
    controls.set(key, input)
  }
  const color = required(controls.get(SettingKey.ColoringColorsType))
  color.dataset.colorRule = ""
  color.parentElement = new TestElement()
  color.parentElement.colorLabel = new TestElement()
  const style = new TestInput()
  style.dataset.key = "formatter.style.indentation.tabSize"
  style.dataset.styleRule = ""
  style.setting = new TestElement()
  controls.set(style.dataset.key, style)
  const command = new TestElement()
  command.dataset.command = "pascalAtlas.dependencies.check"
  const tab = new TestElement()
  tab.dataset.tab = "1"
  const page = new TestElement()
  page.dataset.page = "1"
  const elements = new Map<string, TestElement>()
  for (const id of [
    "initial-state",
    "projectCount",
    "pathCount",
    "workspaceCount",
    "openSettings",
    "openNativeSettings",
  ])
    elements.set(id, new TestElement())
  required(elements.get("initial-state")).textContent = JSON.stringify(initial)
  const sent: ControlCenterClientMessage[] = []
  let receive: ((event: { data: unknown }) => void) | undefined
  vm.runInNewContext(readBrowserScript("controlCenterClient"), {
    acquireVsCodeApi: () => ({
      postMessage: (message: ControlCenterClientMessage) => sent.push(message),
    }),
    HTMLInputElement: TestInput,
    CSS: { escape: (value: string) => value },
    window: {
      addEventListener: (
        name: string,
        callback: (event: { data: unknown }) => void,
      ) => {
        if (name === "message") receive = callback
      },
    },
    document: {
      getElementById: (id: string) => elements.get(id),
      querySelector: (selector: string) =>
        controls.get(/data-key="([^"]+)"/.exec(selector)?.[1] || ""),
      querySelectorAll: (selector: string) => {
        if (selector === "[data-key]") return [...controls.values()]
        if (selector === "[data-style-rule]")
          return [...controls.values()].filter((input) =>
            Object.hasOwn(input.dataset, "styleRule"),
          )
        if (selector === "[data-color-rule]") return [color]
        if (selector === "[data-command]") return [command]
        if (selector === "[data-tab]") return [tab]
        if (selector === "[data-page]") return [page]
        return []
      },
    },
  })
  return {
    controls,
    color,
    style,
    command,
    tab,
    page,
    elements,
    sent,
    receive: (data: unknown) => required(receive)({ data }),
  }
}
const state: ControlCenterState = {
  values: {
    [SettingKey.Enabled]: true,
    [SettingKey.ColoringColorsType]: "#abcdef",
    [SettingKey.ColoringTypingDelayMs]: 75,
    [SettingKey.ColoringColorsUseDefault]: true,
    [SettingKey.FormatterStyleUseDefault]: true,
  },
  status: { projects: 2, paths: 3, workspaces: 1 },
}
test("shipped Control Center bundle applies validated bootstrap, palette and live state", () => {
  const client = harness(state)
  assert.equal(required(client.controls.get(SettingKey.Enabled)).checked, true)
  assert.equal(client.color.value, "#abcdef")
  assert.equal(client.color.parentElement?.colorLabel?.textContent, "#ABCDEF")
  assert.equal(client.color.disabled, true)
  assert.equal(client.style.disabled, true)
  assert.equal(required(client.elements.get("projectCount")).textContent, "2")
  client.receive({
    type: WebviewMessageKind.State,
    values: {
      [SettingKey.ColoringColorsUseDefault]: false,
      [SettingKey.FormatterStyleUseDefault]: false,
    },
    status: { projects: 4, paths: 5, workspaces: 2 },
  })
  assert.equal(client.color.disabled, false)
  assert.equal(client.style.disabled, false)
  assert.equal(required(client.elements.get("projectCount")).textContent, "4")
  client.receive({ type: WebviewMessageKind.State, values: null, status: "malformed" })
  assert.equal(required(client.elements.get("projectCount")).textContent, "4")
})
test("shipped Control Center bundle posts typed changes, commands and settings actions", () => {
  const client = harness({})
  const checkbox = required(client.controls.get(SettingKey.Enabled))
  checkbox.checked = true
  checkbox.dispatch("change")
  const number = required(client.controls.get(SettingKey.ColoringTypingDelayMs))
  number.value = "125"
  number.dispatch("change")
  client.command.dispatch("click")
  required(client.elements.get("openSettings")).dispatch("click")
  required(client.elements.get("openNativeSettings")).dispatch("click")
  assert.deepEqual(JSON.parse(JSON.stringify(client.sent)), [
    { type: WebviewMessageKind.Update, key: SettingKey.Enabled, value: true },
    {
      type: WebviewMessageKind.Update,
      key: SettingKey.ColoringTypingDelayMs,
      value: 125,
    },
    { type: WebviewMessageKind.Command, command: "pascalAtlas.dependencies.check" },
    { type: WebviewMessageKind.OpenSettings },
    { type: WebviewMessageKind.OpenNativeSettings },
  ])
  client.tab.dispatch("click")
  assert.equal(client.tab.classes.has("active"), true)
  assert.equal(client.page.classes.has("active"), true)
})
