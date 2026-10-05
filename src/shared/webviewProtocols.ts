export const WebviewResource = Object.freeze({
  MediaDirectory: "media",
  ScriptDirectory: "out/webview",
  NavigatorScript: "out/webview/classNavigatorClient.js",
  ControlCenterScript: "out/webview/controlCenterClient.js",
  CodiconFont: "media/codicon.ttf",
} as const)
export const WebviewMessageKind = Object.freeze({
  Model: "model",
  Patch: "patch",
  Select: "select",
  ShowSearch: "showSearch",
  HideSearch: "hideSearch",
  FinishSearch: "finishSearch",
  ShowSort: "showSort",
  HideSort: "hideSort",
  SortSettings: "sortSettings",
  SearchResults: "searchResults",
  RestoreSearchState: "restoreSearchState",
  Capabilities: "capabilities",
  Ready: "ready",
  SortClosed: "sortClosed",
  FocusChanged: "focusChanged",
  Open: "open",
  SelectNode: "selectNode",
  Expand: "expand",
  Collapse: "collapse",
  Search: "search",
  SearchOptions: "searchOptions",
  SearchActivate: "searchActivate",
  SearchClosed: "searchClosed",
  SortUpdate: "sortUpdate",
  State: "state",
  Update: "update",
  Command: "command",
  OpenSettings: "openSettings",
  OpenNativeSettings: "openNativeSettings",
} as const)
export const WebviewEvent = Object.freeze({ Message: "message" } as const)
/** Serializable protocols shared by extension hosts and isolated browser clients. */
export interface NavigatorPresentation {
  id: string
  kind?: string
  label: string
  icon?: string
  access?: string
  tooltip?: string
  description?: string
  missingCounterpart?: string
  contextValue?: string
  jumpable?: boolean
  initialExpanded?: boolean
}
export interface NavigatorTreePresentation extends NavigatorPresentation {
  children: NavigatorTreePresentation[]
}
export interface NavigatorFlatPresentation extends NavigatorPresentation {
  children: string[]
}
export interface NavigatorSearchResult extends NavigatorPresentation {
  isCurrentFile?: boolean
}
export interface NavigatorSearchOptions {
  scope: string
  types: boolean
  files: boolean
  routines: boolean
  navigation: string
}
export interface NavigatorSortSettings {
  memberOrder: string
  typeOrder: string
}
export interface NavigatorTreeState {
  selectedId?: string | null
  expanded?: string[]
  initialized?: string[]
  scrollTop?: number
}
export interface NavigatorSavedState extends NavigatorTreeState {
  searchOptions?: NavigatorSearchOptions
}
export interface NavigatorCapabilities {
  aiSteps?: boolean
  aiGenerating?: boolean
  projectContextMenus?: boolean
}
export interface NavigatorMetadata {
  mode?: string
  message?: string
  capabilities?: NavigatorCapabilities
  selectedId?: string | null
  selectedPath?: string[]
}
export type NavigatorHostMessage =
  | ({
      type: typeof WebviewMessageKind.Model
      nodes: NavigatorFlatPresentation[]
      rootIds: string[]
    } & NavigatorMetadata)
  | ({
      type: typeof WebviewMessageKind.Patch
      upsert: NavigatorFlatPresentation[]
      removed: string[]
      rootIds?: string[]
    } & NavigatorMetadata)
  | {
      type: typeof WebviewMessageKind.Select
      id: string
      select: boolean
      focus: boolean
      path: string[]
      expandId?: string
    }
  | { type: typeof WebviewMessageKind.ShowSearch; options: NavigatorSearchOptions }
  | {
      type:
        | typeof WebviewMessageKind.HideSearch
        | typeof WebviewMessageKind.HideSort
        | typeof WebviewMessageKind.FinishSearch
    }
  | {
      type: typeof WebviewMessageKind.ShowSort | typeof WebviewMessageKind.SortSettings
      settings: NavigatorSortSettings
    }
  | {
      type: typeof WebviewMessageKind.SearchResults
      requestId: number
      results: NavigatorSearchResult[]
      status?: string
    }
  | { type: typeof WebviewMessageKind.RestoreSearchState; state: NavigatorTreeState }
  | {
      type: typeof WebviewMessageKind.Capabilities
      capabilities: NavigatorCapabilities
    }
export type NavigatorClientMessage =
  | { type: typeof WebviewMessageKind.Ready | typeof WebviewMessageKind.SortClosed }
  | { type: typeof WebviewMessageKind.FocusChanged; focused: boolean }
  | {
      type:
        | typeof WebviewMessageKind.Open
        | typeof WebviewMessageKind.SelectNode
        | typeof WebviewMessageKind.Expand
        | typeof WebviewMessageKind.Collapse
      id: string
    }
  | {
      type: typeof WebviewMessageKind.Search
      requestId: number
      query: string
      options: NavigatorSearchOptions
    }
  | { type: typeof WebviewMessageKind.SearchOptions; options: NavigatorSearchOptions }
  | { type: typeof WebviewMessageKind.SearchActivate; id: string; preview: boolean }
  | { type: typeof WebviewMessageKind.SearchClosed; restoreState?: NavigatorTreeState }
  | { type: typeof WebviewMessageKind.SortUpdate; key: string; value: string }
export type SettingValue = string | number | boolean | string[] | null
export interface ControlCenterState {
  type?: typeof WebviewMessageKind.State
  values: Record<string, SettingValue | undefined>
  status: { workspaces: number; projects: number; paths: number }
}
export type ControlCenterClientMessage =
  | { type: typeof WebviewMessageKind.Update; key: string; value: SettingValue }
  | { type: typeof WebviewMessageKind.Command; command: string }
  | {
      type:
        | typeof WebviewMessageKind.OpenSettings
        | typeof WebviewMessageKind.OpenNativeSettings
    }
/**
 * Narrow a webview payload to a non-null object record, excluding arrays before
 * reading message fields.
 */
export function isMessageRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
/**
 * Validate saved or transmitted navigator search scope, navigation mode, and
 * kind-filter switches.
 */
export function isSearchOptions(value: unknown): value is NavigatorSearchOptions {
  return (
    isMessageRecord(value) &&
    typeof value.scope === "string" &&
    typeof value.navigation === "string" &&
    ["types", "files", "routines"].every(
      /** Require each search-category option to be a boolean. */ (key) =>
        typeof value[key] === "boolean",
    )
  )
}
/**
 * Validate optional tree selection, expansion IDs, initialization IDs, and scroll
 * position before restoring browser state.
 */
export function isTreeState(value: unknown): value is NavigatorTreeState {
  return (
    isMessageRecord(value) &&
    (value.selectedId == null || typeof value.selectedId === "string") &&
    ["expanded", "initialized"].every(
      /** Validate optional expanded and initialized node-id arrays. */ (key) =>
        value[key] === undefined ||
        (Array.isArray(value[key]) &&
          value[key].every(
            /** Require each restored tree-state node identifier to be text. */ (
              id: unknown,
            ) => typeof id === "string",
          )),
    ) &&
    (value.scrollTop === undefined || typeof value.scrollTop === "number")
  )
}
/**
 * Validate each browser-to-host navigator message by its discriminator and required
 * payload fields.
 */
export function isNavigatorClientMessage(
  value: unknown,
): value is NavigatorClientMessage {
  if (!isMessageRecord(value)) return false
  switch (value.type) {
    case WebviewMessageKind.Ready:
    case WebviewMessageKind.SortClosed:
      return true
    case WebviewMessageKind.FocusChanged:
      return typeof value.focused === "boolean"
    case WebviewMessageKind.Open:
    case WebviewMessageKind.SelectNode:
    case WebviewMessageKind.Expand:
    case WebviewMessageKind.Collapse:
      return typeof value.id === "string"
    case WebviewMessageKind.Search:
      return (
        typeof value.requestId === "number" &&
        typeof value.query === "string" &&
        isSearchOptions(value.options)
      )
    case WebviewMessageKind.SearchOptions:
      return isSearchOptions(value.options)
    case WebviewMessageKind.SearchActivate:
      return typeof value.id === "string" && typeof value.preview === "boolean"
    case WebviewMessageKind.SearchClosed:
      return value.restoreState === undefined || isTreeState(value.restoreState)
    case WebviewMessageKind.SortUpdate:
      return typeof value.key === "string" && typeof value.value === "string"
    default:
      return false
  }
}
/**
 * Validate setting updates and command/open-settings messages before the host changes
 * configuration or dispatches actions.
 */
export function isControlCenterClientMessage(
  value: unknown,
): value is ControlCenterClientMessage {
  if (!isMessageRecord(value)) return false
  if (value.type === WebviewMessageKind.Command)
    return typeof value.command === "string"
  if (
    value.type === WebviewMessageKind.OpenSettings ||
    value.type === WebviewMessageKind.OpenNativeSettings
  )
    return true
  return (
    value.type === WebviewMessageKind.Update &&
    typeof value.key === "string" &&
    (value.value === null ||
      ["string", "number", "boolean"].includes(typeof value.value) ||
      (Array.isArray(value.value) &&
        value.value.every(
          /** Require each posted string-list item to be text. */ (item: unknown) =>
            typeof item === "string",
        )))
  )
}

/**
 * Accept the scalar, nullable, or string-array setting values supported by the
 * settings webview protocol.
 */
export function isSettingValue(value: unknown): value is SettingValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) &&
      value.every(
        /** Require each posted path-list item to be text. */ (item: unknown) =>
          typeof item === "string",
      ))
  )
}
/**
 * Validate bootstrap or state-update settings and numeric project/path counters before
 * applying them in the browser.
 */
export function isControlCenterState(value: unknown): value is ControlCenterState {
  return (
    isMessageRecord(value) &&
    (value.type === undefined || value.type === WebviewMessageKind.State) &&
    isMessageRecord(value.values) &&
    Object.values(value.values).every(
      /**
       * Accept absent setting values and validate supplied values against the setting
       * protocol.
       */ (item) => item === undefined || isSettingValue(item),
    ) &&
    isMessageRecord(value.status) &&
    ["workspaces", "projects", "paths"].every(
      /** Require numeric workspace, project, and path counts in the status payload. */ (
        key,
      ) => isMessageRecord(value.status) && typeof value.status[key] === "number",
    )
  )
}
/**
 * Validate persisted tree state and any search options before using VS Code webview
 * storage.
 */
export function isNavigatorSavedState(value: unknown): value is NavigatorSavedState {
  return (
    isTreeState(value) &&
    (!("searchOptions" in value) ||
      value.searchOptions === undefined ||
      isSearchOptions(value.searchOptions))
  )
}
