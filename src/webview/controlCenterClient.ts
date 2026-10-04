import { WebviewMessageKind, WebviewEvent } from "../shared/webviewProtocols"
import { SettingKey } from "../shared/identifiers"
import type {
  ControlCenterState,
  ControlCenterClientMessage,
} from "../shared/webviewProtocols"
const vscode = acquireVsCodeApi<never>()
const initialValue: unknown = JSON.parse(
  document.getElementById("initial-state")?.textContent || "{}",
)
import { isControlCenterState } from "../shared/webviewProtocols"
const initial: ControlCenterState = isControlCenterState(initialValue)
  ? initialValue
  : { values: {}, status: { workspaces: 0, projects: 0, paths: 0 } }
type SettingInput = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
function post(message: ControlCenterClientMessage) {
  vscode.postMessage(message)
}
function updateColorValue(input: SettingInput) {
  if (input instanceof HTMLInputElement && input.type === "color") {
    const label = input.parentElement?.querySelector<HTMLElement>("[data-color-value]")
    if (label) label.textContent = input.value.toUpperCase()
  }
}
function apply(state: ControlCenterState) {
  for (const [key, value] of Object.entries(state.values || {})) {
    const input = document.querySelector<SettingInput>(
      '[data-key="' + CSS.escape(key) + '"]',
    )
    if (!input) continue
    if (input instanceof HTMLInputElement && input.type === "checkbox")
      input.checked = Boolean(value)
    else input.value = Array.isArray(value) ? value.join(", ") : String(value ?? "")
    updateColorValue(input)
  }
  const useDefaultStyle = Boolean(state.values?.[SettingKey.FormatterStyleUseDefault])
  document.querySelectorAll<SettingInput>("[data-style-rule]").forEach((input) => {
    input.disabled = useDefaultStyle
    input.closest(".setting")?.classList.toggle("disabled", useDefaultStyle)
  })
  const useDefaultColors = Boolean(state.values?.[SettingKey.ColoringColorsUseDefault])
  document.querySelectorAll<SettingInput>("[data-color-rule]").forEach((input) => {
    input.disabled = useDefaultColors
    input.closest(".setting")?.classList.toggle("disabled", useDefaultColors)
  })
  for (const [id, count] of Object.entries({
    projectCount: state.status?.projects,
    pathCount: state.status?.paths,
    workspaceCount: state.status?.workspaces,
  })) {
    const element = document.getElementById(id)
    if (element) element.textContent = String(count ?? 0)
  }
}
document.querySelectorAll<SettingInput>("[data-key]").forEach((input) =>
  input.addEventListener("change", () => {
    const value =
      input instanceof HTMLInputElement && input.type === "checkbox"
        ? input.checked
        : input instanceof HTMLInputElement && input.type === "number"
          ? Number(input.value)
          : input.value
    updateColorValue(input)
    if (input.dataset.key)
      post({ type: WebviewMessageKind.Update, key: input.dataset.key, value })
  }),
)
document.querySelectorAll<HTMLElement>("[data-command]").forEach((button) =>
  button.addEventListener("click", () => {
    if (button.dataset.command)
      post({ type: WebviewMessageKind.Command, command: button.dataset.command })
  }),
)
document.querySelectorAll<HTMLElement>("[data-tab]").forEach((tab) =>
  tab.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLElement>("[data-tab]")
      .forEach((item) => item.classList.toggle("active", item === tab))
    document
      .querySelectorAll<HTMLElement>("[data-page]")
      .forEach((page) =>
        page.classList.toggle("active", page.dataset.page === tab.dataset.tab),
      )
  }),
)
document
  .getElementById("openSettings")
  ?.addEventListener("click", () => post({ type: WebviewMessageKind.OpenSettings }))
document
  .getElementById("openNativeSettings")
  ?.addEventListener("click", () =>
    post({ type: WebviewMessageKind.OpenNativeSettings }),
  )
window.addEventListener(WebviewEvent.Message, (event: MessageEvent<unknown>) => {
  if (isControlCenterState(event.data) && event.data.type === WebviewMessageKind.State)
    apply(event.data)
})
apply(initial)
