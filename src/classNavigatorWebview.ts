import { WebviewMessageKind, WebviewResource } from "./shared/webviewProtocols"
import type * as vscode from "vscode"
import type { NavigatorTarget } from "./shared/models"
import type {
  NavigatorTreePresentation,
  NavigatorFlatPresentation,
  NavigatorHostMessage,
  NavigatorClientMessage,
  NavigatorSearchOptions,
  NavigatorSortSettings,
  NavigatorTreeState,
  NavigatorSearchResult,
  NavigatorCapabilities,
} from "./shared/webviewProtocols"
import { isNavigatorClientMessage } from "./shared/webviewProtocols"
interface Emitter<T> {
  event(listener: (event: T) => unknown): vscode.Disposable
  fire(event: T): void
  dispose(): void
}
interface NavigatorVscodeApi {
  EventEmitter: new <T>() => Emitter<T>
  window?: Pick<typeof vscode.window, "registerWebviewViewProvider">
  Uri?: Pick<typeof vscode.Uri, "joinPath">
  commands?: Pick<typeof vscode.commands, "executeCommand">
}
interface NavigatorWebviewOptions {
  getRoots?: () => NavigatorTarget[]
  serializeNode?: (node: NavigatorTarget) => NavigatorTreePresentation
  nodePath?: (node: NavigatorTarget | undefined) => string[]
  capabilities?: () => NavigatorCapabilities
  onOpen?: (node: NavigatorTarget) => unknown
  onSearch?: (
    message: Extract<
      NavigatorClientMessage,
      { type: typeof WebviewMessageKind.Search }
    >,
  ) => unknown
  onSearchOptions?: (options: NavigatorSearchOptions) => unknown
  onSearchActivate?: (
    message: Extract<
      NavigatorClientMessage,
      { type: typeof WebviewMessageKind.SearchActivate }
    >,
  ) => unknown
  onSearchClosed?: (state: NavigatorTreeState | undefined) => unknown
  onSortUpdate?: (
    message: Extract<
      NavigatorClientMessage,
      { type: typeof WebviewMessageKind.SortUpdate }
    >,
  ) => unknown
  onFocusChanged?: (focused: boolean) => unknown
}
function navigatorWebviewHtml(
  webview: Pick<vscode.Webview, "cspSource">,
  codiconFontUri: string | vscode.Uri = "",
  scriptUri: string | vscode.Uri = "",
) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
  const safeCodiconFontUri = String(codiconFontUri).replace(
    /["'()\\\r\n]/g,
    (character) => `\\${character}`,
  )
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  @font-face { font-family:'pascal-atlas-codicon'; font-display:block; src:url("${safeCodiconFontUri}") format('truetype'); }
  :root { color-scheme: light dark; }
  html, body { width:100%; height:100%; min-height:0; margin:0; padding:0; color:var(--vscode-foreground); background:var(--vscode-sideBar-background); font:var(--vscode-font-weight) var(--vscode-font-size)/22px var(--vscode-font-family); overflow:hidden; }
  body { display:flex; flex-direction:column; }
  button, input, select { font:inherit; }
  #search, #sort-panel { flex:0 0 auto; padding:4px 6px 5px; border-bottom:1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-widget-border)); background:var(--vscode-sideBar-background); }
  #search[hidden], #sort-panel[hidden], #results[hidden], #tree[hidden] { display:none; }
  .query-line { display:flex; gap:3px; align-items:center; }
  #query { box-sizing:border-box; min-width:0; width:100%; height:24px; padding:1px 6px; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-input-border, transparent); outline:none; }
  #query:focus { border-color:var(--vscode-focusBorder); }
  .icon-button { box-sizing:border-box; flex:0 0 24px; width:24px; height:24px; padding:0; color:var(--vscode-icon-foreground); background:transparent; border:1px solid transparent; border-radius:2px; cursor:pointer; }
  .icon-button:hover { background:var(--vscode-toolbar-hoverBackground); }
  .filter-line { display:flex; flex-wrap:wrap; align-items:center; gap:2px 7px; margin-top:4px; color:var(--vscode-descriptionForeground); font-size:11px; line-height:18px; }
  .filter-line label { display:inline-flex; align-items:center; gap:2px; white-space:nowrap; }
  .filter-line input { width:12px; height:12px; margin:0; accent-color:var(--vscode-checkbox-selectBackground, var(--vscode-focusBorder)); }
  .filter-line select { height:20px; max-width:116px; padding:0 2px; color:var(--vscode-dropdown-foreground); background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border); outline:none; font-size:11px; }
  .panel-header { display:flex; height:24px; align-items:center; justify-content:space-between; color:var(--vscode-foreground); }
  .panel-header strong { padding-left:2px; font-size:12px; font-weight:600; }
  .sort-options { display:grid; gap:4px; margin-top:3px; }
  .sort-options label { display:grid; grid-template-columns:auto minmax(0, 1fr); align-items:center; gap:7px; color:var(--vscode-descriptionForeground); font-size:11px; white-space:nowrap; }
  .sort-options select { min-width:0; width:100%; height:22px; padding:0 3px; color:var(--vscode-dropdown-foreground); background:var(--vscode-dropdown-background); border:1px solid var(--vscode-dropdown-border); outline:none; font-size:11px; }
  .sort-options select:focus { border-color:var(--vscode-focusBorder); }
  #search-status { min-height:0; margin-top:2px; color:var(--vscode-descriptionForeground); font-size:11px; line-height:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #tree, #results { flex:1 1 auto; min-height:0; overflow:auto; outline:none; }
  #empty { padding:8px 12px; color:var(--vscode-descriptionForeground); white-space:normal; }
  .row { box-sizing:border-box; display:flex; align-items:center; width:100%; height:22px; padding-right:8px; border:0; outline:0; color:var(--vscode-foreground); background:transparent; cursor:default; user-select:none; white-space:nowrap; }
  .row:hover { background:var(--vscode-list-hoverBackground); }
  .row.selected, .row.selected:hover { color:var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); background:var(--vscode-list-inactiveSelectionBackground, rgba(127,127,127,.24)); }
  body.tree-focus .row.selected, .result.active { color:var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); background:var(--vscode-list-activeSelectionBackground, rgba(0,122,204,.55)); }
  .codicon { display:inline-block; font-family:'pascal-atlas-codicon' !important; font-size:16px; font-style:normal; font-weight:normal !important; line-height:1; text-align:center; text-rendering:auto; -webkit-font-smoothing:antialiased; }
  .twisty { display:flex; flex:0 0 16px; width:16px; height:22px; padding:0; border:0; outline:0; align-items:center; justify-content:center; color:var(--vscode-icon-foreground); background:transparent; cursor:pointer; }
  .twisty.empty { visibility:hidden; }
  .twisty::before { content:'\\eab6'; }
  .twisty.expanded::before { content:'\\eab4'; }
  .icon { display:inline-flex; flex:0 0 16px; width:16px; height:16px; margin-right:4px; align-items:center; justify-content:center; color:var(--vscode-icon-foreground); }
  .icon-references { color:var(--vscode-charts-blue, #75beff); }
  .icon-namespace, .icon-global { color:var(--vscode-charts-blue, #75beff); }
  .icon-package { color:#ffb454; }
  .icon-project-file { color:#d2a8ff; }
  .icon-project, .icon-files, .icon-file { color:var(--vscode-charts-blue, #75beff); }
  .icon-tools { color:var(--vscode-charts-orange, #d18616); }
  .icon-properties { color:var(--vscode-charts-blue, #75beff); }
  .icon-property { color:var(--vscode-symbolIcon-propertyForeground, var(--vscode-charts-blue, #75beff)); }
  .icon-class { color:var(--vscode-symbolIcon-classForeground, var(--vscode-charts-orange, #d18616)); }
  .icon-object { color:var(--vscode-charts-yellow, #cca700); }
  .icon-interface { color:var(--vscode-symbolIcon-interfaceForeground, var(--vscode-charts-blue, #75beff)); }
  .icon-symbol-constructor { color:var(--vscode-symbolIcon-constructorForeground, var(--vscode-charts-purple, #b180d7)); }
  .icon-symbol-method { color:var(--vscode-symbolIcon-methodForeground, var(--vscode-charts-purple, #b180d7)); }
  .icon-symbol-function { color:var(--vscode-symbolIcon-functionForeground, var(--vscode-charts-purple, #b180d7)); }
  .icon-symbol-operator { color:var(--vscode-symbolIcon-operatorForeground, var(--vscode-charts-yellow, #cca700)); }
  .icon-zap { color:var(--vscode-charts-yellow, #cca700); }
  .icon-list-ordered { color:var(--vscode-charts-purple, #b180d7); }
  .icon-loading { color:var(--vscode-progressBar-background, #0e70c0); }
  .icon-error { color:var(--vscode-errorForeground, #f14c4c); }
  .icon-symbol { color:var(--vscode-charts-foreground, var(--vscode-charts-blue, #75beff)); }
  .icon.loading { animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .label { min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .row.missing-counterpart .label, .result.missing-counterpart .result-label { color:var(--vscode-errorForeground, #f14c4c); }
  .children.collapsed { display:none; }
  .result { display:flex; align-items:center; height:25px; padding:0 7px; cursor:pointer; white-space:nowrap; }
  .result:hover { background:var(--vscode-list-hoverBackground); }
  .result-main { min-width:0; flex:1 1 auto; display:flex; align-items:baseline; gap:6px; }
  .result-label { overflow:hidden; text-overflow:ellipsis; color:inherit; }
  .result-detail { overflow:hidden; text-overflow:ellipsis; color:var(--vscode-descriptionForeground); font-size:11px; }
  .result.active .result-detail { color:inherit; opacity:.78; }
</style></head><body>
<section id="search" hidden>
  <div class="query-line">
    <input id="query" type="text" spellcheck="false" autocomplete="off" aria-label="Find Delphi navigator items" placeholder="Name prefix; * matches any characters">
    <button id="close-search" class="icon-button codicon" title="Close search (Esc)" aria-label="Close search">&#xea76;</button>
  </div>
  <div class="filter-line">
    <label>Scope<select id="scope"><option value="current">Current file</option><option value="global">Global</option></select></label>
    <label><input id="kind-types" type="checkbox">Types</label>
    <label><input id="kind-files" type="checkbox">File names</label>
    <label><input id="kind-routines" type="checkbox">Routines</label>
    <label>Navigation<select id="navigation"><option value="all">Always live</option><option value="current">Current file only</option><option value="confirm">On confirmation</option></select></label>
  </div>
  <div id="search-status"></div>
</section>
<section id="sort-panel" hidden>
  <div class="panel-header">
    <strong>Delphi Navigator Sorting</strong>
    <button id="close-sort" class="icon-button codicon" title="Close sorting settings (Esc)" aria-label="Close sorting settings">&#xea76;</button>
  </div>
  <div class="sort-options">
    <label>Members in types<select id="member-order"><option value="visibility">By visibility</option><option value="declaration">Declaration order</option><option value="implementation">Implementation order</option></select></label>
    <label>Top-level types<select id="type-order"><option value="declaration">Declaration order</option><option value="alphabetical">Alphabetical order</option></select></label>
  </div>
</section>
<div id="tree" role="tree" tabindex="0"></div>
<div id="results" role="listbox" tabindex="-1" hidden></div>
<script nonce="${nonce}" src="${scriptUri}"></script></body></html>`
}

class ClassNavigatorWebview {
  view: vscode.WebviewView | undefined
  webview: Pick<vscode.Webview, "postMessage"> | undefined
  nodeById = new Map<string, NavigatorTarget>()
  snapshot: Map<string, NavigatorFlatPresentation> | undefined
  webviewReady = false
  selection: NavigatorTarget[] = []
  mode: string = "class"
  _description: string | undefined
  _message: string | undefined
  pendingSearchOptions: NavigatorSearchOptions | undefined
  pendingSortSettings: NavigatorSortSettings | undefined
  extensionUri: vscode.Uri | undefined
  lastSelectedId: string | null | undefined
  rootIds: string[] = []
  metadataKey = ""
  expandEmitter: Emitter<{ element: NavigatorTarget }>
  collapseEmitter: Emitter<{ element: NavigatorTarget }>
  visibilityEmitter: Emitter<{ visible: boolean }>
  constructor(
    readonly vscode: NavigatorVscodeApi,
    readonly viewId: string,
    readonly options: NavigatorWebviewOptions = {},
  ) {
    this.expandEmitter = new vscode.EventEmitter()
    this.collapseEmitter = new vscode.EventEmitter()
    this.visibilityEmitter = new vscode.EventEmitter()
  }
  get visible() {
    return Boolean(this.view?.visible)
  }
  get description() {
    return this._description
  }
  set description(value: string | undefined) {
    this._description = value
    if (this.view) this.view.description = value
  }
  get message() {
    return this._message
  }
  set message(value: string | undefined) {
    if (this._message === value) return
    this._message = value
    this.refresh()
  }
  onDidExpandElement(listener: (event: { element: NavigatorTarget }) => unknown) {
    return this.expandEmitter.event(listener)
  }
  onDidCollapseElement(listener: (event: { element: NavigatorTarget }) => unknown) {
    return this.collapseEmitter.event(listener)
  }
  onDidChangeVisibility(listener: (event: { visible: boolean }) => unknown) {
    return this.visibilityEmitter.event(listener)
  }
  register(context: Pick<vscode.ExtensionContext, "extensionUri">) {
    this.extensionUri = context.extensionUri
    return this.vscode.window?.registerWebviewViewProvider(this.viewId, this, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.webviewReady = false
    this.snapshot = undefined
    this.view = view
    this.webview = view.webview
    view.description = this._description
    if (!this.extensionUri || !this.vscode.Uri)
      throw new Error("Navigator must be registered before resolving its view")
    const mediaRoot = this.vscode.Uri.joinPath(
      this.extensionUri,
      WebviewResource.MediaDirectory,
    )
    const scriptRoot = this.vscode.Uri.joinPath(
      this.extensionUri,
      WebviewResource.ScriptDirectory,
    )
    const codiconFontUri = view.webview.asWebviewUri(
      this.vscode.Uri.joinPath(this.extensionUri, WebviewResource.CodiconFont),
    )
    const scriptUri = view.webview.asWebviewUri(
      this.vscode.Uri.joinPath(this.extensionUri, WebviewResource.NavigatorScript),
    )
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot, scriptRoot],
    }
    view.webview.html = navigatorWebviewHtml(view.webview, codiconFontUri, scriptUri)
    view.onDidChangeVisibility(() => {
      if (!view.visible) void this.options.onFocusChanged?.(false)
      this.visibilityEmitter.fire({ visible: view.visible })
    })
    view.onDidDispose(() => {
      void this.options.onFocusChanged?.(false)
      this.view = undefined
      this.webview = undefined
      this.webviewReady = false
      this.snapshot = undefined
    })
    view.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message))
    queueMicrotask(() => this.visibilityEmitter.fire({ visible: view.visible }))
  }
  handleMessage(value: unknown) {
    if (!isNavigatorClientMessage(value)) return
    const message = value
    const node = "id" in message ? this.nodeById.get(message.id) : undefined
    switch (message.type) {
      case WebviewMessageKind.Ready:
        this.webviewReady = true
        this.snapshot = undefined
        this.refresh()
        if (this.pendingSearchOptions)
          void this.postMessage({
            type: WebviewMessageKind.ShowSearch,
            options: this.pendingSearchOptions,
          })
        else if (this.pendingSortSettings)
          void this.postMessage({
            type: WebviewMessageKind.ShowSort,
            settings: this.pendingSortSettings,
          })
        break
      case WebviewMessageKind.FocusChanged:
        void this.options.onFocusChanged?.(message.focused)
        break
      case WebviewMessageKind.Open:
        if (node) {
          this.selection = [node]
          this.lastSelectedId = node.id
          void this.options.onOpen?.(node)
        }
        break
      case WebviewMessageKind.SelectNode:
        if (node) {
          this.selection = [node]
          this.lastSelectedId = node.id
        }
        break
      case WebviewMessageKind.Expand:
        if (node) this.expandEmitter.fire({ element: node })
        break
      case WebviewMessageKind.Collapse:
        if (node) this.collapseEmitter.fire({ element: node })
        break
      case WebviewMessageKind.Search:
        void this.options.onSearch?.(message)
        break
      case WebviewMessageKind.SearchOptions:
        void this.options.onSearchOptions?.(message.options)
        break
      case WebviewMessageKind.SearchActivate:
        void this.options.onSearchActivate?.(message)
        break
      case WebviewMessageKind.SearchClosed:
        this.pendingSearchOptions = undefined
        void this.options.onSearchClosed?.(message.restoreState)
        break
      case WebviewMessageKind.SortUpdate:
        void this.options.onSortUpdate?.(message)
        break
      case WebviewMessageKind.SortClosed:
        this.pendingSortSettings = undefined
        break
    }
  }
  collectNodes(nodes: NavigatorTarget[]) {
    this.nodeById.clear()
    const visit = (entries: NavigatorTarget[]) => {
      for (const node of entries) {
        if (node.id) this.nodeById.set(node.id, node)
        visit(node.children || [])
      }
    }
    visit(nodes)
  }
  /** Rebind targets after edits while transmitting only changed presentation data. */
  refresh() {
    if (!this.webviewReady) return
    const roots = this.options.getRoots?.() || []
    this.collectNodes(roots)
    let selected: NavigatorTarget | undefined = this.selection[0]
    while (selected && (!selected.id || !this.nodeById.has(selected.id)))
      selected = selected.parent
    selected = selected?.id ? this.nodeById.get(selected.id) : undefined
    this.selection = selected ? [selected] : []
    const selectedId = selected?.id || null
    const nodes = new Map<string, NavigatorFlatPresentation>()
    const collect = (node: NavigatorTreePresentation) => {
      nodes.set(node.id, { ...node, children: node.children.map((child) => child.id) })
      node.children.forEach(collect)
    }
    const serialize = this.options.serializeNode
    if (serialize) roots.map((node) => serialize(node)).forEach(collect)
    const rootIds = roots.flatMap((node) => (node.id ? [node.id] : []))
    const metadata = {
      mode: this.mode,
      message: this._message || "",
      capabilities: this.options.capabilities?.() || {},
    }
    const metadataKey = JSON.stringify(metadata)
    const previous = this.snapshot
    this.snapshot = nodes
    let message: NavigatorHostMessage | undefined
    if (!previous)
      message = {
        type: WebviewMessageKind.Model,
        nodes: [...nodes.values()],
        rootIds,
        selectedId,
        selectedPath: this.options.nodePath?.(selected) || [],
        ...metadata,
      }
    else {
      const upsert = [...nodes.values()].filter(
        (node) => JSON.stringify(node) !== JSON.stringify(previous.get(node.id)),
      )
      const removed = [...previous.keys()].filter((id) => !nodes.has(id))
      const rootsChanged = JSON.stringify(rootIds) !== JSON.stringify(this.rootIds)
      if (
        upsert.length ||
        removed.length ||
        rootsChanged ||
        selectedId !== this.lastSelectedId ||
        metadataKey !== this.metadataKey
      ) {
        message = { type: WebviewMessageKind.Patch, upsert, removed }
        if (rootsChanged) message.rootIds = rootIds
        if (selectedId !== this.lastSelectedId) message.selectedId = selectedId
        if (metadataKey !== this.metadataKey) Object.assign(message, metadata)
      }
    }
    this.rootIds = rootIds
    this.metadataKey = metadataKey
    this.lastSelectedId = selectedId
    if (message) void this.postMessage(message)
  }
  setMode(mode: string) {
    if (this.mode === mode) return
    this.mode = mode
    this.refresh()
  }
  async reveal(
    node: NavigatorTarget | undefined,
    options: { select?: boolean; focus?: boolean; expand?: boolean | number } = {},
  ) {
    if (!node?.id) return
    if (this.nodeById.get(node.id) !== node) this.refresh()
    node = this.nodeById.get(node.id) || node
    if (!node.id) return
    if (options.select) this.selection = [node]
    this.lastSelectedId = this.selection[0]?.id || null
    if (options.focus) {
      if (this.view) this.view.show(false)
      else {
        try {
          await this.vscode.commands?.executeCommand(`${this.viewId}.focus`)
        } catch {}
      }
    }
    await this.postMessage({
      type: WebviewMessageKind.Select,
      id: node.id,
      select: Boolean(options.select),
      focus: Boolean(options.focus),
      path: this.options.nodePath?.(node) || [],
      expandId: options.expand ? node.id : undefined,
    })
  }
  showSearch(options: NavigatorSearchOptions) {
    this.pendingSearchOptions = options
    this.pendingSortSettings = undefined
    this.view?.show(false)
    void this.postMessage({ type: WebviewMessageKind.ShowSearch, options })
  }
  hideSearch() {
    return this.postMessage({ type: WebviewMessageKind.HideSearch })
  }
  showSort(settings: NavigatorSortSettings) {
    this.pendingSortSettings = settings
    this.pendingSearchOptions = undefined
    this.view?.show(false)
    void this.postMessage({ type: WebviewMessageKind.ShowSort, settings })
  }
  get sortPanelOpen() {
    return this.pendingSortSettings !== undefined
  }
  hideSort() {
    return this.postMessage({ type: WebviewMessageKind.HideSort })
  }
  updateSortSettings(settings: NavigatorSortSettings) {
    if (this.pendingSortSettings) this.pendingSortSettings = settings
    return this.postMessage({ type: WebviewMessageKind.SortSettings, settings })
  }
  searchClosed() {
    this.pendingSearchOptions = undefined
  }
  restoreSearchState(
    node: NavigatorTarget | undefined,
    state: NavigatorTreeState | undefined,
  ) {
    this.selection = node ? [node] : []
    return this.postMessage({
      type: WebviewMessageKind.RestoreSearchState,
      state: { ...state, selectedId: node?.id || null },
    })
  }
  postSearchResults(
    requestId: number,
    results: NavigatorSearchResult[],
    status?: string,
  ) {
    return this.postMessage({
      type: WebviewMessageKind.SearchResults,
      requestId,
      results,
      status,
    })
  }
  finishSearch() {
    this.pendingSearchOptions = undefined
    return this.postMessage({ type: WebviewMessageKind.FinishSearch })
  }
  updateCapabilities() {
    return this.postMessage({
      type: WebviewMessageKind.Capabilities,
      capabilities: this.options.capabilities?.() || {},
    })
  }
  postMessage(message: NavigatorHostMessage) {
    return this.webview?.postMessage(message) || Promise.resolve(false)
  }
  dispose() {
    this.expandEmitter.dispose()
    this.collapseEmitter.dispose()
    this.visibilityEmitter.dispose()
  }
}
export { ClassNavigatorWebview, navigatorWebviewHtml }
