'use strict';

function navigatorWebviewHtml(webview, codiconFontUri = '') {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const safeCodiconFontUri = String(codiconFontUri).replace(/["'()\\\r\n]/g, character => `\\${character}`);
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
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const expanded = new Set(saved.expanded || []);
  const initialized = new Set(saved.initialized || []);
  let rootIds = [];
  const nodesById = new Map();
  const renderedNodes = new Map();
  let selectedId = saved.selectedId;
  let mode = 'class';
  let messageText = '';
  let capabilities = {};
  let searchOpen = false;
  let searchRequest = 0;
  let searchTimer;
  let results = [];
  let activeResult = -1;
  let searchStartTreeState;
  let sortOpen = false;
  let searchOptions = saved.searchOptions || { scope:'current', types:true, files:false, routines:true, navigation:'all' };

  const treeHost = document.getElementById('tree');
  const resultsHost = document.getElementById('results');
  const searchHost = document.getElementById('search');
  const sortHost = document.getElementById('sort-panel');
  const queryInput = document.getElementById('query');
  const status = document.getElementById('search-status');
  const scope = document.getElementById('scope');
  const kindTypes = document.getElementById('kind-types');
  const kindFiles = document.getElementById('kind-files');
  const kindRoutines = document.getElementById('kind-routines');
  const navigation = document.getElementById('navigation');
  const memberOrder = document.getElementById('member-order');
  const typeOrder = document.getElementById('type-order');

  const accessColor = access => ({
    public:'var(--vscode-charts-green, #89d185)', published:'var(--vscode-charts-green, #89d185)',
    protected:'var(--vscode-charts-yellow, #cca700)', 'strict-protected':'var(--vscode-charts-purple, #b180d7)',
    private:'var(--vscode-charts-red, #f14c4c)', 'strict-private':'var(--vscode-charts-orange, #d18616)'
  }[access] || 'var(--vscode-icon-foreground)');

  const codiconGlyphs = {
    references:0xeb36, namespace:0xea8b, global:0xeb01, package:0xeb29, 'project-file':0xea7b, project:0xeb30,
    files:0xeaf0, file:0xea7b, tools:0xeb6d, properties:0xeb86, property:0xeb65,
    interface:0xeb61, object:0xea8b, class:0xeb5b, 'symbol-constructor':0xea8c, 'symbol-method':0xea8c,
    'symbol-function':0xea8c, 'symbol-operator':0xeb64, zap:0xea86, 'list-ordered':0xeb16,
    loading:0xeb19, error:0xea87, symbol:0xeb63
  };

  function configureIcon(element, name, access) {
    const iconName = Object.hasOwn(codiconGlyphs, name) ? name : 'symbol';
    element.className = 'icon codicon icon-' + iconName + (iconName === 'loading' ? ' loading' : '');
    element.textContent = String.fromCodePoint(codiconGlyphs[iconName]);
    if (name === 'error') element.style.color = 'var(--vscode-errorForeground, #f14c4c)';
    else if (name === 'symbol-constructor') element.style.color = 'var(--vscode-charts-purple, #b180d7)';
    else if (access) element.style.color = accessColor(access);
    else element.style.color = '';
  }

  function remember() { vscode.setState({ expanded:[...expanded], initialized:[...initialized], selectedId, searchOptions }); }
  function captureTreeState() {
    return { selectedId, expanded:[...expanded], initialized:[...initialized], scrollTop:treeHost.scrollTop };
  }
  function restoreTreeState(state, focusSelected = false) {
    if (!state) return;
    expanded.clear(); for (const id of state.expanded || []) expanded.add(id);
    initialized.clear(); for (const id of state.initialized || []) initialized.add(id);
    setSelected(state.selectedId || undefined, false, false);
    renderTree();
    requestAnimationFrame(() => {
      treeHost.scrollTop = Number.isFinite(state.scrollTop) ? Math.max(0, state.scrollTop) : 0;
      if (focusSelected && selectedId) {
        document.querySelector('#tree .row[data-id="' + CSS.escape(selectedId) + '"]')?.focus();
      }
    });
  }
  function applyOptions(options) {
    searchOptions = Object.assign({}, searchOptions, options || {});
    scope.value = searchOptions.scope;
    kindTypes.checked = !!searchOptions.types;
    kindFiles.checked = !!searchOptions.files;
    kindRoutines.checked = !!searchOptions.routines;
    navigation.value = searchOptions.navigation;
    remember();
  }
  function readOptions() {
    searchOptions = { scope:scope.value, types:kindTypes.checked, files:kindFiles.checked, routines:kindRoutines.checked, navigation:navigation.value };
    remember();
    return searchOptions;
  }
  function setSelected(id, scroll, notify) {
    const previous = renderedNodes.get(selectedId)?.row;
    if (previous && selectedId !== id) {
      previous.classList.remove('selected'); previous.tabIndex = -1;
      previous.setAttribute('aria-selected', 'false');
    }
    selectedId = id;
    const row = renderedNodes.get(id)?.row;
    if (row) {
      row.classList.add('selected'); row.tabIndex = 0;
      if (row.getAttribute('aria-selected') !== 'true') row.setAttribute('aria-selected', 'true');
      if (scroll) row.scrollIntoView({ block:'nearest' });
    }
    if (notify && id) vscode.postMessage({ type:'selectNode', id });
    remember();
  }
  function flattenVisibleRows() { return [...treeHost.querySelectorAll('.row')].filter(row => row.offsetParent !== null); }

  function contextSection(node) {
    if (mode === 'class' && (node.kind === 'type' || node.kind === 'routine')) return 'classSymbol';
    if (mode !== 'project') return undefined;
    if (node.kind === 'package') return 'projectPackage';
    if (node.kind === 'project') return node.contextValue === 'pascalAtlas.projectNavigator.project'
      ? 'projectGroup'
      : 'looseProjectGroup';
    return undefined;
  }

  /** Create a row once; event handlers read its latest data after each patch. */
  function renderNode(node) {
    const wrapper = document.createElement('div');
    wrapper.dataset.nodeId = node.id;
    const row = document.createElement('div');
    row.className = 'row'; row.dataset.id = node.id;
    row.setAttribute('role', 'treeitem'); row.tabIndex = -1;
    const twisty = document.createElement('button');
    twisty.className = 'twisty codicon'; twisty.tabIndex = -1;
    row.appendChild(twisty);
    const icon = document.createElement('span'); row.appendChild(icon);
    const label = document.createElement('span'); label.className = 'label'; row.appendChild(label);
    wrapper.appendChild(row);
    const children = document.createElement('div'); children.className = 'children'; wrapper.appendChild(children);
    let previous;
    let previousDepth;
    let previousMode;
    let previousExpanded;
    let previousHasChildren;
    const syncExpansion = () => {
      const hasChildren = node.children.length > 0;
      const isExpanded = expanded.has(node.id);
      if (hasChildren === previousHasChildren && isExpanded === previousExpanded) return;
      twisty.classList.toggle('empty', !hasChildren);
      twisty.classList.toggle('expanded', isExpanded);
      children.classList.toggle('collapsed', !isExpanded);
      if (hasChildren) row.setAttribute('aria-expanded', String(isExpanded));
      else row.removeAttribute('aria-expanded');
      previousHasChildren = hasChildren; previousExpanded = isExpanded;
    };
    const update = (next, depth) => {
      node = next;
      if (depth !== previousDepth) row.style.paddingLeft = (depth * 8) + 'px';
      if (node !== previous || mode !== previousMode) {
        if (!previous || previous.label !== node.label) label.textContent = node.label;
        if (!previous || previous.tooltip !== node.tooltip || previous.label !== node.label) row.title = node.tooltip || node.label;
        if (!previous || previous.icon !== node.icon || previous.access !== node.access) configureIcon(icon, node.icon, node.access);
        const section = contextSection(node);
        const context = section ? JSON.stringify({ webviewSection:section, preventDefaultContextMenuItems:true }) : undefined;
        if (row.dataset.vscodeContext !== context) {
          if (context) row.dataset.vscodeContext = context;
          else delete row.dataset.vscodeContext;
        }
      }
      syncExpansion(); previous = node; previousDepth = depth; previousMode = mode;
    };
    const toggle = expand => {
      if (!node.children.length) return;
      const next = expand === undefined ? !expanded.has(node.id) : expand;
      if (next) expanded.add(node.id); else expanded.delete(node.id);
      syncExpansion(); remember();
      vscode.postMessage({ type:next ? 'expand' : 'collapse', id:node.id });
    };
    twisty.addEventListener('click', event => { event.stopPropagation(); toggle(); });
    row.addEventListener('click', () => { setSelected(node.id, false, true); if (node.jumpable) vscode.postMessage({ type:'open', id:node.id }); });
    row.addEventListener('contextmenu', () => setSelected(node.id, false, true));
    row.addEventListener('keydown', event => {
      const visible = flattenVisibleRows(); const index = visible.indexOf(row);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); const next = visible[Math.max(0, Math.min(visible.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
        if (next) { setSelected(next.dataset.id, true, true); next.focus(); }
      } else if (event.key === 'ArrowRight') { event.preventDefault(); if (!expanded.has(node.id)) toggle(true); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); if (expanded.has(node.id)) toggle(false); else row.parentElement.parentElement?.previousElementSibling?.focus(); }
      else if (event.key === 'Enter') { event.preventDefault(); if (node.jumpable) vscode.postMessage({ type:'open', id:node.id }); else toggle(); }
      else if (event.key === ' ' && node.children.length) { event.preventDefault(); toggle(); }
      else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault(); setSelected(node.id, false, true); const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, clientX:rect.left + 20, clientY:rect.bottom }));
      }
    });
    return { wrapper, row, children, update, syncExpansion };
  }

  /** Reconcile sibling order by ID, moving only rows whose position changed. */
  function reconcileChildren(host, ids, depth) {
    const wanted = new Set(ids);
    for (const child of [...host.children]) {
      if (child.id === 'empty' && ids.length === 0) continue;
      if (!wanted.has(child.dataset.nodeId)) child.remove();
    }
    ids.forEach((id, index) => {
      const node = nodesById.get(id);
      if (!node) return;
      let entry = renderedNodes.get(id);
      if (!entry) { entry = renderNode(node); renderedNodes.set(id, entry); }
      entry.update(node, depth);
      // appendChild for every entry would move unchanged rows and put new
      // declarations at the end. Insert only at their actual model position.
      const before = host.children[index] || null;
      if (before !== entry.wrapper) host.insertBefore(entry.wrapper, before);
      reconcileChildren(entry.children, node.children, depth + 1);
    });
  }

  /** Apply changed data without replacing the tree or losing its viewport. */
  function renderTree() {
    const scrollTop = treeHost.scrollTop;
    const top = treeHost.getBoundingClientRect().top;
    const anchor = flattenVisibleRows().find(row => row.getBoundingClientRect().bottom > top);
    const anchorTop = anchor?.getBoundingClientRect().top;
    const focused = treeHost.contains(document.activeElement) ? document.activeElement : undefined;
    reconcileChildren(treeHost, rootIds, 0);
    for (const [id, entry] of renderedNodes) {
      if (!nodesById.has(id)) { entry.wrapper.remove(); renderedNodes.delete(id); }
    }
    if (!rootIds.length) {
      let empty = document.getElementById('empty');
      if (!empty) { empty = document.createElement('div'); empty.id = 'empty'; treeHost.appendChild(empty); }
      const text = messageText || 'Open a Pascal/Delphi, DPK, or DPROJ file to view its structure.';
      if (empty.textContent !== text) empty.textContent = text;
    }
    setSelected(selectedId, false, false);
    if (focused && document.activeElement !== focused) {
      const target = focused.isConnected ? focused : renderedNodes.get(selectedId)?.row || treeHost;
      target.focus({ preventScroll:true });
    }
    // Preserve the visible row even when rows are inserted above it. Fall back
    // to the previous scroll offset if that row was removed by the edit.
    if (anchor?.isConnected && anchor.offsetParent !== null) {
      treeHost.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    } else treeHost.scrollTop = scrollTop;
  }

  function sendSearch(persistOptions = false) {
    clearTimeout(searchTimer); const requestId = ++searchRequest; const options = readOptions(); const query = queryInput.value.trim();
    if (persistOptions) vscode.postMessage({ type:'searchOptions', options });
    if (!query) { results = []; activeResult = -1; resultsHost.hidden = true; treeHost.hidden = false; status.textContent = ''; return; }
    resultsHost.hidden = false; treeHost.hidden = true; status.textContent = options.scope === 'global' ? 'Searching the global index…' : 'Searching…';
    searchTimer = setTimeout(() => vscode.postMessage({ type:'search', requestId, query, options }), 35);
  }
  function shouldPreview(item) { return searchOptions.navigation === 'all' || (searchOptions.navigation === 'current' && item.isCurrentFile); }
  function activateResult(index, preview) {
    if (!results.length) { activeResult = -1; return; }
    activeResult = Math.max(0, Math.min(results.length - 1, index));
    resultsHost.querySelectorAll('.result').forEach((row, rowIndex) => row.classList.toggle('active', rowIndex === activeResult));
    const row = resultsHost.children[activeResult]; row?.scrollIntoView({ block:'nearest' });
    if (preview && shouldPreview(results[activeResult])) vscode.postMessage({ type:'searchActivate', id:results[activeResult].id, preview:true });
  }
  function confirmResult() {
    const item = results[activeResult]; if (!item) return;
    status.textContent = 'Navigating to and selecting item…';
    vscode.postMessage({ type:'searchActivate', id:item.id, preview:false });
  }
  function renderResults(items, responseStatus) {
    results = items || []; resultsHost.replaceChildren();
    for (const [index, item] of results.entries()) {
      const row = document.createElement('div'); row.className = 'result'; row.setAttribute('role', 'option'); row.title = item.tooltip || item.description || item.label;
      const icon = document.createElement('span'); configureIcon(icon, item.icon, item.access); row.appendChild(icon);
      const main = document.createElement('div'); main.className = 'result-main';
      const label = document.createElement('span'); label.className = 'result-label'; label.textContent = item.label; main.appendChild(label);
      if (item.description) { const detail = document.createElement('span'); detail.className = 'result-detail'; detail.textContent = item.description; main.appendChild(detail); }
      row.appendChild(main); row.addEventListener('mousedown', () => activateResult(index, true)); row.addEventListener('click', confirmResult); resultsHost.appendChild(row);
    }
    status.textContent = responseStatus || (results.length ? results.length + ' matches' : 'No matches');
    activateResult(results.length ? 0 : -1, true);
  }
  function showSearch(options) {
    if (sortOpen) hideSort(false);
    if (!searchOpen) searchStartTreeState = captureTreeState();
    searchOpen = true; searchHost.hidden = false; applyOptions(options); queryInput.focus(); queryInput.select(); sendSearch();
  }
  function hideSearch(notify = true) {
    const restoreState = notify ? searchStartTreeState : undefined;
    searchStartTreeState = undefined;
    searchOpen = false; clearTimeout(searchTimer); searchRequest += 1; searchHost.hidden = true; resultsHost.hidden = true; treeHost.hidden = false; status.textContent = '';
    if (restoreState) restoreTreeState(restoreState, true);
    if (notify) vscode.postMessage({ type:'searchClosed', restoreState });
  }
  function applySortSettings(settings) {
    const normalizedMemberOrder = settings?.memberOrder === 'source' ? 'implementation' : settings?.memberOrder;
    if (['visibility', 'declaration', 'implementation'].includes(normalizedMemberOrder)) memberOrder.value = normalizedMemberOrder;
    if (['declaration', 'alphabetical'].includes(settings?.typeOrder)) typeOrder.value = settings.typeOrder;
  }
  function showSort(settings) {
    if (searchOpen) hideSearch();
    sortOpen = true; applySortSettings(settings); sortHost.hidden = false; memberOrder.focus();
  }
  function hideSort(focusTree = true, notify = true) {
    sortOpen = false; sortHost.hidden = true;
    if (focusTree) treeHost.focus();
    if (notify) vscode.postMessage({ type:'sortClosed' });
  }
  function updateSort(key, value) { vscode.postMessage({ type:'sortUpdate', key, value }); }

  queryInput.addEventListener('input', () => sendSearch(false));
  queryInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); hideSearch(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); activateResult(activeResult + 1, true); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); activateResult(activeResult - 1, true); }
    else if (event.key === 'Enter') { event.preventDefault(); confirmResult(); }
  });
  for (const control of [scope, kindTypes, kindFiles, kindRoutines, navigation]) control.addEventListener('change', () => sendSearch(true));
  document.getElementById('close-search').addEventListener('click', () => hideSearch());
  document.getElementById('close-sort').addEventListener('click', () => hideSort());
  memberOrder.addEventListener('change', () => updateSort('memberOrder', memberOrder.value));
  typeOrder.addEventListener('change', () => updateSort('typeOrder', typeOrder.value));
  for (const control of [memberOrder, typeOrder]) control.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); hideSort(); }
  });
  treeHost.addEventListener('focusin', () => document.body.classList.add('tree-focus'));
  treeHost.addEventListener('focusout', () => document.body.classList.remove('tree-focus'));

  let reportedFocus = false;
  function reportWebviewFocus(focused) {
    focused = Boolean(focused);
    if (reportedFocus === focused) return;
    reportedFocus = focused;
    vscode.postMessage({ type:'focusChanged', focused });
  }
  document.addEventListener('focusin', () => reportWebviewFocus(true));
  window.addEventListener('focus', () => reportWebviewFocus(true));
  window.addEventListener('blur', () => reportWebviewFocus(false));
  document.addEventListener('focusout', () => setTimeout(() => {
    if (!document.hasFocus()) reportWebviewFocus(false);
  }, 0));

  window.addEventListener('message', event => {
    const data = event.data || {};
    if (data.type === 'model' || data.type === 'patch') {
      if (data.type === 'model') nodesById.clear();
      for (const id of data.removed || []) nodesById.delete(id);
      for (const node of data.nodes || data.upsert || []) {
        nodesById.set(node.id, node);
        if (!initialized.has(node.id)) { initialized.add(node.id); if (node.initialExpanded) expanded.add(node.id); }
      }
      if (data.rootIds) rootIds = data.rootIds;
      mode = data.mode || mode;
      if (Object.hasOwn(data, 'message')) messageText = data.message || '';
      capabilities = data.capabilities || capabilities;
      if (Object.hasOwn(data, 'selectedId')) setSelected(data.selectedId, false, false);
      for (const id of data.selectedPath || []) expanded.add(id);
      renderTree();
    } else if (data.type === 'select') {
      for (const id of [...(data.path || []), ...(data.expandId ? [data.expandId] : [])]) {
        expanded.add(id); renderedNodes.get(id)?.syncExpansion();
      }
      if (data.select !== false) setSelected(data.id, false, false);
      const row = renderedNodes.get(data.id)?.row;
      row?.scrollIntoView({ block:'nearest' });
      if (data.focus) row?.focus({ preventScroll:true });
      remember();
    } else if (data.type === 'showSearch') showSearch(data.options);
    else if (data.type === 'hideSearch') hideSearch();
    else if (data.type === 'showSort') showSort(data.settings);
    else if (data.type === 'hideSort') hideSort();
    else if (data.type === 'sortSettings') applySortSettings(data.settings);
    else if (data.type === 'searchResults' && data.requestId === searchRequest) renderResults(data.results, data.status);
    else if (data.type === 'finishSearch') hideSearch(false);
    else if (data.type === 'restoreSearchState') restoreTreeState(data.state, true);
    else if (data.type === 'capabilities') { capabilities = data.capabilities || {}; }
  });
  applyOptions(searchOptions); renderTree(); vscode.postMessage({ type:'ready' });
  if (document.hasFocus()) reportWebviewFocus(true);
</script></body></html>`;
}

class ClassNavigatorWebview {
  constructor(vscode, viewId, options = {}) {
    this.vscode = vscode;
    this.viewId = viewId;
    this.options = options;
    this.view = undefined;
    this.webview = undefined;
    this.nodeById = new Map();
    this.snapshot = undefined;
    this.webviewReady = false;
    this.selection = [];
    this.mode = 'class';
    this._description = undefined;
    this._message = undefined;
    this.pendingSearchOptions = undefined;
    this.pendingSortSettings = undefined;
    this.expandEmitter = new vscode.EventEmitter();
    this.collapseEmitter = new vscode.EventEmitter();
    this.visibilityEmitter = new vscode.EventEmitter();
  }

  get visible() { return Boolean(this.view?.visible); }
  get description() { return this._description; }
  set description(value) { this._description = value; if (this.view) this.view.description = value; }
  get message() { return this._message; }
  set message(value) {
    if (this._message === value) return;
    this._message = value;
    this.refresh();
  }
  onDidExpandElement(listener) { return this.expandEmitter.event(listener); }
  onDidCollapseElement(listener) { return this.collapseEmitter.event(listener); }
  onDidChangeVisibility(listener) { return this.visibilityEmitter.event(listener); }

  register(context) {
    this.extensionUri = context.extensionUri;
    return this.vscode.window.registerWebviewViewProvider(this.viewId, this, {
      webviewOptions: { retainContextWhenHidden: true }
    });
  }

  resolveWebviewView(view) {
    this.webviewReady = false;
    this.snapshot = undefined;
    this.view = view;
    this.webview = view.webview;
    view.description = this._description;
    const mediaRoot = this.vscode.Uri.joinPath(this.extensionUri, 'media');
    const codiconFontUri = view.webview.asWebviewUri(
      this.vscode.Uri.joinPath(mediaRoot, 'codicon.ttf')
    );
    view.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot] };
    view.webview.html = navigatorWebviewHtml(view.webview, codiconFontUri);
    view.onDidChangeVisibility(() => {
      if (!view.visible) void this.options.onFocusChanged?.(false);
      this.visibilityEmitter.fire({ visible: view.visible });
    });
    view.onDidDispose(() => {
      void this.options.onFocusChanged?.(false);
      this.view = undefined;
      this.webview = undefined;
      this.webviewReady = false;
      this.snapshot = undefined;
    });
    view.webview.onDidReceiveMessage(message => this.handleMessage(message));
    queueMicrotask(() => this.visibilityEmitter.fire({ visible: view.visible }));
  }

  handleMessage(message) {
    const node = message?.id ? this.nodeById.get(message.id) : undefined;
    if (message?.type === 'ready') {
      // A recreated webview needs one initial snapshot before receiving deltas.
      this.webviewReady = true;
      this.snapshot = undefined;
      this.refresh();
      if (this.pendingSearchOptions) void this.postMessage({ type: 'showSearch', options: this.pendingSearchOptions });
      else if (this.pendingSortSettings) void this.postMessage({ type: 'showSort', settings: this.pendingSortSettings });
    } else if (message?.type === 'focusChanged') {
      void this.options.onFocusChanged?.(Boolean(message.focused));
    } else if (message?.type === 'open' && node) {
      this.selection = [node];
      this.lastSelectedId = node.id;
      void this.options.onOpen?.(node);
    } else if (message?.type === 'selectNode' && node) {
      this.selection = [node];
      this.lastSelectedId = node.id;
    } else if (message?.type === 'expand' && node) {
      this.expandEmitter.fire({ element: node });
    } else if (message?.type === 'collapse' && node) {
      this.collapseEmitter.fire({ element: node });
    } else if (message?.type === 'search') {
      void this.options.onSearch?.(message);
    } else if (message?.type === 'searchOptions') {
      void this.options.onSearchOptions?.(message.options);
    } else if (message?.type === 'searchActivate') {
      void this.options.onSearchActivate?.(message);
    } else if (message?.type === 'searchClosed') {
      this.pendingSearchOptions = undefined;
      void this.options.onSearchClosed?.(message.restoreState);
    } else if (message?.type === 'sortUpdate') {
      void this.options.onSortUpdate?.(message);
    } else if (message?.type === 'sortClosed') {
      this.pendingSortSettings = undefined;
    }
  }

  collectNodes(nodes) {
    this.nodeById.clear();
    const visit = entries => {
      for (const node of entries || []) {
        this.nodeById.set(node.id, node);
        visit(node.children);
      }
    };
    visit(nodes);
  }

  /**
   * Rebind navigation targets to current source data and send presentation deltas.
   * Offsets stay on the host: a body edit can update every target without sending
   * any tree message when labels, icons and sibling order are unchanged.
   */
  refresh() {
    if (!this.webviewReady) return;
    const roots = this.options.getRoots?.() || [];
    this.collectNodes(roots);
    let selected = this.selection[0];
    // Rebuilt models contain new objects. Never keep stale offsets in selection;
    // if a selected item was deleted, retain its nearest surviving ancestor.
    while (selected && !this.nodeById.has(selected.id)) selected = selected.parent;
    selected = selected && this.nodeById.get(selected.id);
    this.selection = selected ? [selected] : [];
    const selectedId = selected?.id || null;
    const nodes = new Map();
    const collect = node => {
      nodes.set(node.id, { ...node, children: (node.children || []).map(child => child.id) });
      for (const child of node.children || []) collect(child);
    };
    roots.map(node => this.options.serializeNode(node)).forEach(collect);
    const rootIds = roots.map(node => node.id);
    const metadata = {
      mode: this.mode,
      message: this._message || '',
      capabilities: this.options.capabilities?.() || {}
    };
    const metadataKey = JSON.stringify(metadata);
    const previous = this.snapshot;
    this.snapshot = nodes;
    let message;
    if (!previous) {
      message = { type: 'model', nodes: [...nodes.values()], rootIds, selectedId,
        selectedPath: this.options.nodePath?.(selected) || [], ...metadata };
    } else {
      const upsert = [...nodes.values()].filter(node =>
        JSON.stringify(node) !== JSON.stringify(previous.get(node.id)));
      const removed = [...previous.keys()].filter(id => !nodes.has(id));
      const rootsChanged = JSON.stringify(rootIds) !== JSON.stringify(this.rootIds);
      if (upsert.length || removed.length || rootsChanged
        || selectedId !== this.lastSelectedId || metadataKey !== this.metadataKey) {
        message = { type: 'patch', upsert, removed };
        if (rootsChanged) message.rootIds = rootIds;
        if (selectedId !== this.lastSelectedId) message.selectedId = selectedId;
        if (metadataKey !== this.metadataKey) Object.assign(message, metadata);
      }
    }
    this.rootIds = rootIds;
    this.metadataKey = metadataKey;
    this.lastSelectedId = selectedId;
    if (message) void this.postMessage(message);
  }

  setMode(mode) {
    if (this.mode === mode) return;
    this.mode = mode;
    this.refresh();
  }

  async reveal(node, options = {}) {
    if (!node) return;
    // A cursor event can parse a new model before the edit timer fires. Commit
    // its data before selecting a row that the client has not received yet.
    if (this.nodeById.get(node.id) !== node) this.refresh();
    node = this.nodeById.get(node.id) || node;
    if (options.select) this.selection = [node];
    this.lastSelectedId = this.selection[0]?.id || null;
    if (options.focus) {
      if (this.view) this.view.show(false);
      else {
        try { await this.vscode.commands.executeCommand(`${this.viewId}.focus`); } catch {}
      }
    }
    await this.postMessage({
      type: 'select',
      id: node.id,
      select: Boolean(options.select),
      focus: Boolean(options.focus),
      path: this.options.nodePath?.(node) || [],
      expandId: options.expand ? node.id : undefined
    });
  }

  showSearch(options) {
    this.pendingSearchOptions = options;
    this.pendingSortSettings = undefined;
    this.view?.show(false);
    void this.postMessage({ type: 'showSearch', options });
  }

  hideSearch() {
    return this.postMessage({ type: 'hideSearch' });
  }

  showSort(settings) {
    this.pendingSortSettings = settings;
    this.pendingSearchOptions = undefined;
    this.view?.show(false);
    void this.postMessage({ type: 'showSort', settings });
  }

  get sortPanelOpen() {
    return this.pendingSortSettings !== undefined;
  }

  hideSort() {
    return this.postMessage({ type: 'hideSort' });
  }

  updateSortSettings(settings) {
    if (this.pendingSortSettings) this.pendingSortSettings = settings;
    return this.postMessage({ type: 'sortSettings', settings });
  }

  searchClosed() {
    this.pendingSearchOptions = undefined;
  }

  restoreSearchState(node, state) {
    this.selection = node ? [node] : [];
    return this.postMessage({
      type: 'restoreSearchState',
      state: { ...(state || {}), selectedId: node?.id || null }
    });
  }

  postSearchResults(requestId, results, status) {
    return this.postMessage({ type: 'searchResults', requestId, results, status });
  }

  finishSearch() {
    this.pendingSearchOptions = undefined;
    return this.postMessage({ type: 'finishSearch' });
  }

  updateCapabilities() {
    return this.postMessage({ type: 'capabilities', capabilities: this.options.capabilities?.() || {} });
  }

  postMessage(message) {
    return this.webview?.postMessage(message) || Promise.resolve(false);
  }

  dispose() {
    this.expandEmitter.dispose();
    this.collapseEmitter.dispose();
    this.visibilityEmitter.dispose();
  }
}

module.exports = { ClassNavigatorWebview, navigatorWebviewHtml };
