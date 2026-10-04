import { NavigatorMode } from "../shared/navConstants"
import {
  WebviewMessageKind,
  WebviewEvent,
  isNavigatorSavedState,
} from "../shared/webviewProtocols"
import type {
  NavigatorSavedState,
  NavigatorTreeState,
  NavigatorSearchOptions,
  NavigatorSortSettings,
  NavigatorFlatPresentation,
  NavigatorSearchResult,
  NavigatorCapabilities,
  NavigatorHostMessage,
  NavigatorClientMessage,
} from "../shared/webviewProtocols"
import { PascalKeyword } from "../shared/pascal"
const vscode = acquireVsCodeApi<NavigatorSavedState>()
const savedValue: unknown = vscode.getState()
const saved = isNavigatorSavedState(savedValue) ? savedValue : {}
const expanded = new Set(saved.expanded || [])
const initialized = new Set(saved.initialized || [])
let rootIds: string[] = []
const nodesById = new Map<string, NavigatorFlatPresentation>()
const renderedNodes = new Map<string, ReturnType<typeof renderNode>>()
let selectedId: string | null | undefined = saved.selectedId
let mode: string = NavigatorMode.Class
let messageText = ""
let capabilities: NavigatorCapabilities = {}
let searchOpen = false
let searchRequest = 0
let searchTimer: ReturnType<typeof setTimeout> | undefined
let results: NavigatorSearchResult[] = []
let activeResult = -1
let searchStartTreeState: NavigatorTreeState | undefined
let sortOpen = false
let searchOptions: NavigatorSearchOptions = saved.searchOptions || {
  scope: "current",
  types: true,
  files: false,
  routines: true,
  navigation: "all",
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>("#" + id)
  if (!element) throw new Error("Missing navigator element: " + id)
  return element
}
function post(message: NavigatorClientMessage) {
  vscode.postMessage(message)
}
const treeHost = requiredElement<HTMLElement>("tree")
const resultsHost = requiredElement<HTMLElement>("results")
const searchHost = requiredElement<HTMLElement>("search")
const sortHost = requiredElement<HTMLElement>("sort-panel")
const queryInput = requiredElement<HTMLInputElement>("query")
const status = requiredElement<HTMLElement>("search-status")
const scope = requiredElement<HTMLSelectElement>("scope")
const kindTypes = requiredElement<HTMLInputElement>("kind-types")
const kindFiles = requiredElement<HTMLInputElement>("kind-files")
const kindRoutines = requiredElement<HTMLInputElement>("kind-routines")
const navigation = requiredElement<HTMLSelectElement>("navigation")
const memberOrder = requiredElement<HTMLSelectElement>("member-order")
const typeOrder = requiredElement<HTMLSelectElement>("type-order")

const accessColors: Record<string, string> = {
  public: "var(--vscode-charts-green, #89d185)",
  published: "var(--vscode-charts-green, #89d185)",
  protected: "var(--vscode-charts-yellow, #cca700)",
  "strict-protected": "var(--vscode-charts-purple, #b180d7)",
  private: "var(--vscode-charts-red, #f14c4c)",
  "strict-private": "var(--vscode-charts-orange, #d18616)",
}
const accessColor = (access: string) =>
  accessColors[access] || "var(--vscode-icon-foreground)"

const codiconGlyphs: Record<string, number> = {
  references: 0xeb36,
  namespace: 0xea8b,
  global: 0xeb01,
  package: 0xeb29,
  "project-file": 0xea7b,
  project: 0xeb30,
  files: 0xeaf0,
  file: 0xea7b,
  tools: 0xeb6d,
  properties: 0xeb86,
  property: 0xeb65,
  interface: 0xeb61,
  object: 0xea8b,
  class: 0xeb5b,
  "symbol-constructor": 0xea8c,
  "symbol-method": 0xea8c,
  "symbol-function": 0xea8c,
  "symbol-operator": 0xeb64,
  zap: 0xea86,
  "list-ordered": 0xeb16,
  loading: 0xeb19,
  error: 0xea87,
  symbol: 0xeb63,
}

function configureIcon(
  element: HTMLElement,
  name?: string,
  access?: string,
  missingCounterpart?: string,
) {
  const iconName = name && Object.hasOwn(codiconGlyphs, name) ? name : "symbol"
  element.className =
    "icon codicon icon-" + iconName + (iconName === "loading" ? " loading" : "")
  element.textContent = String.fromCodePoint(codiconGlyphs[iconName])
  if (name === "error" || missingCounterpart)
    element.style.color = "var(--vscode-errorForeground, #f14c4c)"
  else if (name === "symbol-constructor")
    element.style.color = "var(--vscode-charts-purple, #b180d7)"
  else if (access) element.style.color = accessColor(access)
  else element.style.color = ""
}

function remember() {
  vscode.setState({
    expanded: [...expanded],
    initialized: [...initialized],
    selectedId,
    searchOptions,
  })
}
function captureTreeState() {
  return {
    selectedId,
    expanded: [...expanded],
    initialized: [...initialized],
    scrollTop: treeHost.scrollTop,
  }
}
function restoreTreeState(
  state: NavigatorTreeState | undefined,
  focusSelected = false,
) {
  if (!state) return
  expanded.clear()
  for (const id of state.expanded || []) expanded.add(id)
  initialized.clear()
  for (const id of state.initialized || []) initialized.add(id)
  setSelected(state.selectedId || undefined, false, false)
  renderTree()
  requestAnimationFrame(() => {
    treeHost.scrollTop = Number.isFinite(state.scrollTop)
      ? Math.max(0, state.scrollTop ?? 0)
      : 0
    if (focusSelected && selectedId) {
      document
        .querySelector<HTMLElement>(
          '#tree .row[data-id="' + CSS.escape(selectedId) + '"]',
        )
        ?.focus()
    }
  })
}
function applyOptions(options: Partial<NavigatorSearchOptions> | undefined) {
  searchOptions = Object.assign({}, searchOptions, options || {})
  scope.value = searchOptions.scope
  kindTypes.checked = !!searchOptions.types
  kindFiles.checked = !!searchOptions.files
  kindRoutines.checked = !!searchOptions.routines
  navigation.value = searchOptions.navigation
  remember()
}
function readOptions() {
  searchOptions = {
    scope: scope.value,
    types: kindTypes.checked,
    files: kindFiles.checked,
    routines: kindRoutines.checked,
    navigation: navigation.value,
  }
  remember()
  return searchOptions
}
function setSelected(id: string | null | undefined, scroll: boolean, notify: boolean) {
  const previous = renderedNodes.get(selectedId || "")?.row
  if (previous && selectedId !== id) {
    previous.classList.remove("selected")
    previous.tabIndex = -1
    previous.setAttribute("aria-selected", String(false))
  }
  selectedId = id
  const row = renderedNodes.get(id || "")?.row
  if (row) {
    row.classList.add("selected")
    row.tabIndex = 0
    if (row.getAttribute("aria-selected") !== String(true))
      row.setAttribute("aria-selected", String(true))
    if (scroll) row.scrollIntoView({ block: "nearest" })
  }
  if (notify && id) post({ type: WebviewMessageKind.SelectNode, id })
  remember()
}
function flattenVisibleRows() {
  return [...treeHost.querySelectorAll<HTMLElement>(".row")].filter(
    (row) => row.offsetParent !== null,
  )
}

function contextSection(node: NavigatorFlatPresentation) {
  if (
    mode === NavigatorMode.Class &&
    (node.kind === PascalKeyword.Type || node.kind === "routine")
  )
    return "classSymbol"
  if (mode !== "project") return undefined
  if (node.kind === PascalKeyword.Package) return "projectPackage"
  if (node.kind === "project")
    return node.contextValue === "pascalAtlas.projectNavigator.project"
      ? "projectGroup"
      : "looseProjectGroup"
  return undefined
}

/** Create a row once; event handlers read its latest data after each patch. */
function renderNode(node: NavigatorFlatPresentation) {
  const wrapper = document.createElement("div")
  wrapper.dataset.nodeId = node.id
  const row = document.createElement("div")
  row.className = "row"
  row.dataset.id = node.id
  row.setAttribute("role", "treeitem")
  row.tabIndex = -1
  const twisty = document.createElement("button")
  twisty.className = "twisty codicon"
  twisty.tabIndex = -1
  row.appendChild(twisty)
  const icon = document.createElement("span")
  row.appendChild(icon)
  const label = document.createElement("span")
  label.className = "label"
  row.appendChild(label)
  wrapper.appendChild(row)
  const children = document.createElement("div")
  children.className = "children"
  wrapper.appendChild(children)
  let previous: NavigatorFlatPresentation | undefined
  let previousDepth: number | undefined
  let previousMode: string | undefined
  let previousExpanded: boolean | undefined
  let previousHasChildren: boolean | undefined
  const syncExpansion = () => {
    const hasChildren = node.children.length > 0
    const isExpanded = expanded.has(node.id)
    if (hasChildren === previousHasChildren && isExpanded === previousExpanded) return
    twisty.classList.toggle("empty", !hasChildren)
    twisty.classList.toggle("expanded", isExpanded)
    children.classList.toggle("collapsed", !isExpanded)
    if (hasChildren) row.setAttribute("aria-expanded", String(isExpanded))
    else row.removeAttribute("aria-expanded")
    previousHasChildren = hasChildren
    previousExpanded = isExpanded
  }
  const update = (next: NavigatorFlatPresentation, depth: number) => {
    node = next
    if (depth !== previousDepth) row.style.paddingLeft = depth * 8 + "px"
    if (node !== previous || mode !== previousMode) {
      if (!previous || previous.label !== node.label) label.textContent = node.label
      if (
        !previous ||
        previous.tooltip !== node.tooltip ||
        previous.label !== node.label
      )
        row.title = node.tooltip || node.label
      if (
        !previous ||
        previous.icon !== node.icon ||
        previous.access !== node.access ||
        previous.missingCounterpart !== node.missingCounterpart
      ) {
        // Counterpart changes arrive as data patches; retain the row and clear
        // the red styling as soon as the missing declaration/body is added.
        configureIcon(icon, node.icon, node.access, node.missingCounterpart)
        row.classList.toggle("missing-counterpart", Boolean(node.missingCounterpart))
      }
      const section = contextSection(node)
      const context = section
        ? JSON.stringify({
            webviewSection: section,
            preventDefaultContextMenuItems: true,
          })
        : undefined
      if (row.dataset.vscodeContext !== context) {
        if (context) row.dataset.vscodeContext = context
        else delete row.dataset.vscodeContext
      }
    }
    syncExpansion()
    previous = node
    previousDepth = depth
    previousMode = mode
  }
  const toggle = (expand?: boolean) => {
    if (!node.children.length) return
    const next = expand === undefined ? !expanded.has(node.id) : expand
    if (next) expanded.add(node.id)
    else expanded.delete(node.id)
    syncExpansion()
    remember()
    post({ type: next ? "expand" : "collapse", id: node.id })
  }
  twisty.addEventListener("click", (event) => {
    event.stopPropagation()
    toggle()
  })
  row.addEventListener("click", () => {
    setSelected(node.id, false, true)
    if (node.jumpable) post({ type: WebviewMessageKind.Open, id: node.id })
  })
  row.addEventListener("contextmenu", () => setSelected(node.id, false, true))
  row.addEventListener("keydown", (event) => {
    const visible = flattenVisibleRows()
    const index = visible.indexOf(row)
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault()
      const next =
        visible[
          Math.max(
            0,
            Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
          )
        ]
      if (next) {
        setSelected(next.dataset.id, true, true)
        next.focus()
      }
    } else if (event.key === "ArrowRight") {
      event.preventDefault()
      if (!expanded.has(node.id)) toggle(true)
    } else if (event.key === "ArrowLeft") {
      event.preventDefault()
      if (expanded.has(node.id)) toggle(false)
      else {
        const previous = row.parentElement?.parentElement?.previousElementSibling
        if (previous && "focus" in previous && typeof previous.focus === "function")
          previous.focus()
      }
    } else if (event.key === "Enter") {
      event.preventDefault()
      if (node.jumpable) post({ type: WebviewMessageKind.Open, id: node.id })
      else toggle()
    } else if (event.key === " " && node.children.length) {
      event.preventDefault()
      toggle()
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault()
      setSelected(node.id, false, true)
      const rect = row.getBoundingClientRect()
      row.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          clientX: rect.left + 20,
          clientY: rect.bottom,
        }),
      )
    }
  })
  return { wrapper, row, children, update, syncExpansion }
}

/** Reconcile sibling order by ID, moving only rows whose position changed. */
function reconcileChildren(host: HTMLElement, ids: string[], depth: number) {
  const wanted = new Set(ids)
  for (const child of [...host.children]) {
    if (child.id === "empty" && ids.length === 0) continue
    if (!wanted.has(child.getAttribute("data-node-id") || "")) child.remove()
  }
  ids.forEach((id, index) => {
    const node = nodesById.get(id)
    if (!node) return
    let entry = renderedNodes.get(id)
    if (!entry) {
      entry = renderNode(node)
      renderedNodes.set(id, entry)
    }
    entry.update(node, depth)
    // appendChild for every entry would move unchanged rows and put new
    // declarations at the end. Insert only at their actual model position.
    const before = host.children[index] || null
    if (before !== entry.wrapper) host.insertBefore(entry.wrapper, before)
    reconcileChildren(entry.children, node.children, depth + 1)
  })
}

/** Apply changed data without replacing the tree or losing its viewport. */
function renderTree() {
  const scrollTop = treeHost.scrollTop
  const top = treeHost.getBoundingClientRect().top
  const anchor = flattenVisibleRows().find(
    (row) => row.getBoundingClientRect().bottom > top,
  )
  const anchorTop = anchor?.getBoundingClientRect().top
  const focused = treeHost.contains(document.activeElement)
    ? document.activeElement
    : undefined
  reconcileChildren(treeHost, rootIds, 0)
  for (const [id, entry] of renderedNodes) {
    if (!nodesById.has(id)) {
      entry.wrapper.remove()
      renderedNodes.delete(id)
    }
  }
  if (!rootIds.length) {
    let empty = document.getElementById("empty")
    if (!empty) {
      empty = document.createElement("div")
      empty.id = "empty"
      treeHost.appendChild(empty)
    }
    const text =
      messageText || "Open a Pascal/Delphi, DPK, or DPROJ file to view its structure."
    if (empty.textContent !== text) empty.textContent = text
  }
  setSelected(selectedId, false, false)
  if (
    focused &&
    "focus" in focused &&
    typeof focused.focus === "function" &&
    document.activeElement !== focused
  ) {
    const target = focused.isConnected
      ? focused
      : renderedNodes.get(selectedId || "")?.row || treeHost
    if ("focus" in target && typeof target.focus === "function")
      target.focus({ preventScroll: true })
  }
  // Preserve the visible row even when rows are inserted above it. Fall back
  // to the previous scroll offset if that row was removed by the edit.
  if (anchor?.isConnected && anchor.offsetParent !== null) {
    treeHost.scrollTop += anchor.getBoundingClientRect().top - (anchorTop ?? 0)
  } else treeHost.scrollTop = scrollTop
}

function sendSearch(persistOptions = false) {
  clearTimeout(searchTimer)
  const requestId = ++searchRequest
  const options = readOptions()
  const query = queryInput.value.trim()
  if (persistOptions) post({ type: WebviewMessageKind.SearchOptions, options })
  if (!query) {
    results = []
    activeResult = -1
    resultsHost.hidden = true
    treeHost.hidden = false
    status.textContent = ""
    return
  }
  resultsHost.hidden = false
  treeHost.hidden = true
  status.textContent =
    options.scope === "global" ? "Searching the global indexâ€¦" : "Searchingâ€¦"
  searchTimer = setTimeout(
    () => post({ type: WebviewMessageKind.Search, requestId, query, options }),
    35,
  )
}
function shouldPreview(item: NavigatorSearchResult) {
  return (
    searchOptions.navigation === "all" ||
    (searchOptions.navigation === "current" && item.isCurrentFile)
  )
}
function activateResult(index: number, preview: boolean) {
  if (!results.length) {
    activeResult = -1
    return
  }
  activeResult = Math.max(0, Math.min(results.length - 1, index))
  resultsHost
    .querySelectorAll(".result")
    .forEach((row, rowIndex) =>
      row.classList.toggle("active", rowIndex === activeResult),
    )
  const row = resultsHost.children[activeResult]
  row?.scrollIntoView({ block: "nearest" })
  if (preview && shouldPreview(results[activeResult]))
    post({
      type: WebviewMessageKind.SearchActivate,
      id: results[activeResult].id,
      preview: true,
    })
}
function confirmResult() {
  const item = results[activeResult]
  if (!item) return
  status.textContent = "Navigating to and selecting itemâ€¦"
  post({ type: WebviewMessageKind.SearchActivate, id: item.id, preview: false })
}
function renderResults(items: NavigatorSearchResult[], responseStatus?: string) {
  results = items || []
  resultsHost.replaceChildren()
  for (const [index, item] of results.entries()) {
    const row = document.createElement("div")
    row.className = "result" + (item.missingCounterpart ? " missing-counterpart" : "")
    row.setAttribute("role", "option")
    row.title = item.tooltip || item.description || item.label
    const icon = document.createElement("span")
    configureIcon(icon, item.icon, item.access, item.missingCounterpart)
    row.appendChild(icon)
    const main = document.createElement("div")
    main.className = "result-main"
    const label = document.createElement("span")
    label.className = "result-label"
    label.textContent = item.label
    main.appendChild(label)
    if (item.description) {
      const detail = document.createElement("span")
      detail.className = "result-detail"
      detail.textContent = item.description
      main.appendChild(detail)
    }
    row.appendChild(main)
    row.addEventListener("mousedown", () => activateResult(index, true))
    row.addEventListener("click", confirmResult)
    resultsHost.appendChild(row)
  }
  status.textContent =
    responseStatus || (results.length ? results.length + " matches" : "No matches")
  activateResult(results.length ? 0 : -1, true)
}
function showSearch(options: NavigatorSearchOptions) {
  if (sortOpen) hideSort(false)
  if (!searchOpen) searchStartTreeState = captureTreeState()
  searchOpen = true
  searchHost.hidden = false
  applyOptions(options)
  queryInput.focus()
  queryInput.select()
  sendSearch()
}
function hideSearch(notify = true) {
  const restoreState = notify ? searchStartTreeState : undefined
  searchStartTreeState = undefined
  searchOpen = false
  clearTimeout(searchTimer)
  searchRequest += 1
  searchHost.hidden = true
  resultsHost.hidden = true
  treeHost.hidden = false
  status.textContent = ""
  if (restoreState) restoreTreeState(restoreState, true)
  if (notify) post({ type: WebviewMessageKind.SearchClosed, restoreState })
}
function applySortSettings(settings: NavigatorSortSettings) {
  const normalizedMemberOrder =
    settings?.memberOrder === "source"
      ? PascalKeyword.Implementation
      : settings?.memberOrder
  if (
    ["visibility", "declaration", PascalKeyword.Implementation].includes(
      normalizedMemberOrder,
    )
  )
    memberOrder.value = normalizedMemberOrder
  if (["declaration", "alphabetical"].includes(settings?.typeOrder))
    typeOrder.value = settings.typeOrder
}
function showSort(settings: NavigatorSortSettings) {
  if (searchOpen) hideSearch()
  sortOpen = true
  applySortSettings(settings)
  sortHost.hidden = false
  memberOrder.focus()
}
function hideSort(focusTree = true, notify = true) {
  sortOpen = false
  sortHost.hidden = true
  if (focusTree) treeHost.focus()
  if (notify) post({ type: WebviewMessageKind.SortClosed })
}
function updateSort(key: string, value: string) {
  post({ type: WebviewMessageKind.SortUpdate, key, value })
}

queryInput.addEventListener("input", () => sendSearch(false))
queryInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault()
    hideSearch()
  } else if (event.key === "ArrowDown") {
    event.preventDefault()
    activateResult(activeResult + 1, true)
  } else if (event.key === "ArrowUp") {
    event.preventDefault()
    activateResult(activeResult - 1, true)
  } else if (event.key === "Enter") {
    event.preventDefault()
    confirmResult()
  }
})
for (const control of [scope, kindTypes, kindFiles, kindRoutines, navigation])
  control.addEventListener("change", () => sendSearch(true))
requiredElement<HTMLElement>("close-search").addEventListener("click", () =>
  hideSearch(),
)
requiredElement<HTMLElement>("close-sort").addEventListener("click", () => hideSort())
memberOrder.addEventListener("change", () =>
  updateSort("memberOrder", memberOrder.value),
)
typeOrder.addEventListener("change", () => updateSort("typeOrder", typeOrder.value))
for (const control of [memberOrder, typeOrder])
  control.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault()
      hideSort()
    }
  })
treeHost.addEventListener("focusin", () => document.body.classList.add("tree-focus"))
treeHost.addEventListener("focusout", () =>
  document.body.classList.remove("tree-focus"),
)

let reportedFocus = false
function reportWebviewFocus(focused: boolean) {
  focused = Boolean(focused)
  if (reportedFocus === focused) return
  reportedFocus = focused
  post({ type: WebviewMessageKind.FocusChanged, focused })
}
document.addEventListener("focusin", () => reportWebviewFocus(true))
window.addEventListener("focus", () => reportWebviewFocus(true))
window.addEventListener("blur", () => reportWebviewFocus(false))
document.addEventListener("focusout", () =>
  setTimeout(() => {
    if (!document.hasFocus()) reportWebviewFocus(false)
  }, 0),
)

window.addEventListener(
  WebviewEvent.Message,
  (event: MessageEvent<NavigatorHostMessage>) => {
    const data = event.data
    if (!data) return
    if (
      data.type === WebviewMessageKind.Model ||
      data.type === WebviewMessageKind.Patch
    ) {
      if (data.type === WebviewMessageKind.Model) nodesById.clear()
      for (const id of data.type === WebviewMessageKind.Patch ? data.removed : [])
        nodesById.delete(id)
      for (const node of data.type === WebviewMessageKind.Model
        ? data.nodes
        : data.upsert) {
        nodesById.set(node.id, node)
        if (!initialized.has(node.id)) {
          initialized.add(node.id)
          if (node.initialExpanded) expanded.add(node.id)
        }
      }
      if (data.rootIds) rootIds = data.rootIds
      mode = data.mode || mode
      if (Object.hasOwn(data, "message")) messageText = data.message || ""
      capabilities = data.capabilities || capabilities
      if (Object.hasOwn(data, "selectedId")) setSelected(data.selectedId, false, false)
      for (const id of data.selectedPath || []) expanded.add(id)
      renderTree()
    } else if (data.type === WebviewMessageKind.Select) {
      for (const id of [
        ...(data.path || []),
        ...(data.expandId ? [data.expandId] : []),
      ]) {
        expanded.add(id)
        renderedNodes.get(id)?.syncExpansion()
      }
      if (data.select !== false) setSelected(data.id, false, false)
      const row = renderedNodes.get(data.id)?.row
      row?.scrollIntoView({ block: "nearest" })
      if (data.focus) row?.focus({ preventScroll: true })
      remember()
    } else if (data.type === WebviewMessageKind.ShowSearch) showSearch(data.options)
    else if (data.type === WebviewMessageKind.HideSearch) hideSearch()
    else if (data.type === WebviewMessageKind.ShowSort) showSort(data.settings)
    else if (data.type === WebviewMessageKind.HideSort) hideSort()
    else if (data.type === WebviewMessageKind.SortSettings)
      applySortSettings(data.settings)
    else if (
      data.type === WebviewMessageKind.SearchResults &&
      data.requestId === searchRequest
    )
      renderResults(data.results, data.status)
    else if (data.type === WebviewMessageKind.FinishSearch) hideSearch(false)
    else if (data.type === WebviewMessageKind.RestoreSearchState)
      restoreTreeState(data.state, true)
    else if (data.type === WebviewMessageKind.Capabilities) {
      capabilities = data.capabilities || {}
    }
  },
)
applyOptions(searchOptions)
renderTree()
post({ type: WebviewMessageKind.Ready })
if (document.hasFocus()) reportWebviewFocus(true)
