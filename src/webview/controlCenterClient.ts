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
/**
 * Send a typed settings update or command request from the browser to the extension
 * host.
 */
function post(message: ControlCenterClientMessage) {
  vscode.postMessage(message)
}
/** Synchronize a color picker's hexadecimal display label when its value changes. */
function updateColorValue(input: SettingInput) {
  if (input instanceof HTMLInputElement && input.type === "color") {
    const label = input.parentElement?.querySelector<HTMLElement>("[data-color-value]")
    if (label) label.textContent = input.value.toUpperCase()
  }
}
/**
 * Apply host settings/counters to existing controls and disable custom style/color
 * inputs while their default profiles are active.
 */
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
  // Show custom controls as unavailable while a default profile controls the effective style or colors.
  const useDefaultStyle = Boolean(state.values?.[SettingKey.FormatterStyleUseDefault])
  document.querySelectorAll<SettingInput>("[data-style-rule]").forEach(
    /** Disable custom style controls while the default formatting profile is active. */ (
      input,
    ) => {
      input.disabled = useDefaultStyle
      input.closest(".setting")?.classList.toggle("disabled", useDefaultStyle)
    },
  )
  const useDefaultColors = Boolean(state.values?.[SettingKey.ColoringColorsUseDefault])
  document.querySelectorAll<SettingInput>("[data-color-rule]").forEach(
    /** Disable custom color controls while theme colors are selected. */ (input) => {
      input.disabled = useDefaultColors
      input.closest(".setting")?.classList.toggle("disabled", useDefaultColors)
    },
  )
  for (const [id, count] of Object.entries({
    projectCount: state.status?.projects,
    pathCount: state.status?.paths,
    workspaceCount: state.status?.workspaces,
  })) {
    const element = document.getElementById(id)
    if (element) element.textContent = String(count ?? 0)
  }
}
document.querySelectorAll<SettingInput>("[data-key]").forEach(
  /** Connect each setting control to host configuration updates. */ (input) =>
    input.addEventListener(
      "change",
      /** Read the control value in its setting type and send it to the host. */ () => {
        const value =
          input instanceof HTMLInputElement && input.type === "checkbox"
            ? input.checked
            : input instanceof HTMLInputElement && input.type === "number"
              ? Number(input.value)
              : input.value
        updateColorValue(input)
        if (input.dataset.key)
          post({ type: WebviewMessageKind.Update, key: input.dataset.key, value })
      },
    ),
)
document.querySelectorAll<HTMLElement>("[data-command]").forEach(
  /** Connect each action button to its declared host command. */ (button) =>
    button.addEventListener(
      "click",
      /** Request the command declared by this action button. */ () => {
        if (button.dataset.command)
          post({ type: WebviewMessageKind.Command, command: button.dataset.command })
      },
    ),
)
document.querySelectorAll<HTMLElement>("[data-tab]").forEach(
  /** Connect each tab to its corresponding settings page. */ (tab) =>
    tab.addEventListener(
      "click",
      /** Switch the active tab and displayed settings page together. */ () => {
        document
          .querySelectorAll<HTMLElement>("[data-tab]")
          .forEach(
            /** Mark the clicked tab as the active tab. */ (item) =>
              item.classList.toggle("active", item === tab),
          )
        document
          .querySelectorAll<HTMLElement>("[data-page]")
          .forEach(
            /** Display only the page associated with the clicked tab. */ (page) =>
              page.classList.toggle("active", page.dataset.page === tab.dataset.tab),
          )
      },
    ),
)
document
  .getElementById("openSettings")
  ?.addEventListener(
    "click",
    /** Open the full settings webview in the editor. */ () =>
      post({ type: WebviewMessageKind.OpenSettings }),
  )
document
  .getElementById("openNativeSettings")
  ?.addEventListener(
    "click",
    /** Open the extension settings in the native VS Code settings editor. */ () =>
      post({ type: WebviewMessageKind.OpenNativeSettings }),
  )
window.addEventListener(
  WebviewEvent.Message,
  /** Apply live host settings only after their state payload passes validation. */ (
    event: MessageEvent<unknown>,
  ) => {
    if (
      isControlCenterState(event.data) &&
      event.data.type === WebviewMessageKind.State
    )
      apply(event.data)
  },
)
apply(initial)
