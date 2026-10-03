'use strict';

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { maskPascalNonCode } = require('./binarySymbols');
const { parseSourceUnitSymbols } = require('./usesQuickFix');
const { ClassNavigatorWebview } = require('./classNavigatorWebview');
const {
  AI_STEP_CACHE_STATE_KEY,
  AI_STEP_CHUNK_CACHE_STATE_KEY,
  buildAiStepRepairPrompt,
  buildAiStepPrompt,
  createAiStepNodes,
  lineStartOffset,
  mergeAiStepResponseResults,
  offsetAtLine,
  parseAiStepResponseResult,
  plannedLabelsByHash,
  routineAnalysisKey
} = require('./aiSteps');

const PASCAL_LANGUAGE_IDS = new Set(['pascal', 'objectpascal']);
const STRUCTURE_KINDS = new Set(['class', 'interface', 'record', 'object']);
const EXPLORER_LAYOUT_STATE_KEY = 'pascalUnion.classNavigator.explorerLayoutVersion';
const NAVIGATOR_MODE_STATE_KEY = 'pascalUnion.navigator.mode';
const EXPLORER_LAYOUT_VERSION = 1;
const EXPANDED_ROUTINES_STATE_KEY = 'pascalUnion.classNavigator.expandedRoutines';
const SEARCH_OPTIONS_STATE_KEY = 'pascalUnion.classNavigator.searchOptions';
const WEBVIEW_CONTEXT_COMMANDS = [
  ['buildPackage', 'pascalUnion.build.buildPackage'],
  ['compilePackage', 'pascalUnion.build.compilePackage'],
  ['cleanPackage', 'pascalUnion.build.cleanPackage'],
  ['debugPackage', 'pascalUnion.debug.debugPackage'],
  ['attachPackage', 'pascalUnion.debug.attachPackage'],
  ['buildGroup', 'pascalUnion.build.buildGroup'],
  ['compileGroup', 'pascalUnion.build.compileGroup'],
  ['cleanGroup', 'pascalUnion.build.cleanGroup'],
  ['runGroup', 'pascalUnion.run.group'],
  ['debugGroup', 'pascalUnion.debug.buildAndDebugGroup'],
  ['selectStartupProject', 'pascalUnion.debug.selectStartupProject'],
  ['selectConfiguration', 'pascalUnion.build.selectConfiguration'],
  ['selectPlatform', 'pascalUnion.build.selectPlatform']
];
const MEMBER_ACCESS_ORDER = new Map([
  ['public', 0],
  ['published', 1],
  ['protected', 2],
  ['strict-protected', 3],
  ['private', 4],
  ['strict-private', 5],
  ['automated', 6]
]);

function lineEndOffset(text, offset) {
  const end = text.indexOf('\n', Math.max(0, offset));
  return end < 0 ? text.length : end;
}

function isClassNavigatorDocument(document) {
  if (!document) return false;
  if (PASCAL_LANGUAGE_IDS.has(document.languageId)) return true;
  return /\.(?:dpk|dproj)$/i.test(document.fileName || document.uri?.fsPath || '');
}

function sectionEndOffset(code, offset) {
  const end = code.indexOf(';', Math.max(0, offset));
  return end < 0 ? code.length : end + 1;
}

function dpkProjectReferenceNodes(code, settings) {
  const entries = [];
  const requires = /^\s*requires\b/im.exec(code);
  const contains = /^\s*contains\b/im.exec(code);
  const finalEnd = /^\s*end\s*\./im.exec(code);
  const fallbackOffset = finalEnd?.index ?? code.length;
  if (settings.showProjectPackageEntry) {
    const offset = requires?.index === undefined
      ? contains?.index ?? fallbackOffset
      : requires.index + requires[0].search(/requires/i);
    entries.push({
      id: 'project:packages:requires',
      kind: 'project-package-section',
      label: 'Package Includes',
      offset,
      ranges: requires ? [[offset, sectionEndOffset(code, offset)]] : [],
      targetKind: 'requires',
      children: []
    });
  }
  if (settings.showProjectFileEntry) {
    const offset = contains?.index === undefined
      ? fallbackOffset
      : contains.index + contains[0].search(/contains/i);
    entries.push({
      id: 'project:files:contains',
      kind: 'project-file-section',
      label: 'File Includes',
      offset,
      ranges: contains ? [[offset, sectionEndOffset(code, offset)]] : [],
      targetKind: 'contains',
      children: []
    });
  }
  return entries;
}

function unitLifecycleNodes(code, settings) {
  if (!/^\s*unit\b/im.test(code)) return [];
  const initialization = /^\s*initialization\b/im.exec(code);
  const finalization = /^\s*finalization\b/im.exec(code);
  const unitEndMatches = [...code.matchAll(/^\s*end\s*\.\s*$/gim)];
  const unitEnd = unitEndMatches.at(-1)?.index ?? code.length;
  const entries = [];
  if (settings.showUnitInitialization && initialization) {
    const offset = initialization.index + initialization[0].search(/initialization/i);
    entries.push({
      id: 'unit:lifecycle:initialization',
      kind: 'unit-initialization-section',
      label: 'initialization',
      offset,
      ranges: [[offset, finalization?.index ?? unitEnd]],
      children: []
    });
  }
  if (settings.showUnitFinalization && finalization) {
    const offset = finalization.index + finalization[0].search(/finalization/i);
    entries.push({
      id: 'unit:lifecycle:finalization',
      kind: 'unit-finalization-section',
      label: 'finalization',
      offset,
      ranges: [[offset, unitEnd]],
      children: []
    });
  }
  return entries;
}

function xmlElementRange(text, match) {
  const start = match.index;
  if (/\/\s*>$/.test(match[0])) return [start, start + match[0].length];
  const close = /<\/DCCReference\s*>/i.exec(text.slice(start + match[0].length));
  return [
    start,
    close
      ? start + match[0].length + close.index + close[0].length
      : start + match[0].length
  ];
}

function dprojInsertionOffset(text) {
  const firstReference = /<DCCReference\b/i.exec(text);
  if (firstReference) return firstReference.index;
  const mainSourceEnd = /<\/DelphiCompile\s*>/i.exec(text);
  if (mainSourceEnd) return mainSourceEnd.index + mainSourceEnd[0].length;
  const itemGroup = /<ItemGroup\b[^>]*>/i.exec(text);
  return itemGroup ? itemGroup.index + itemGroup[0].length : 0;
}

function buildDprojNavigatorModel(text, filePath = '', options = {}) {
  const settings = {
    showProjectPackageEntry: options.showProjectPackageEntry !== false,
    showProjectFileEntry: options.showProjectFileEntry !== false
  };
  const references = [...text.matchAll(/<DCCReference\b[^>]*\bInclude\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi)]
    .map(match => ({ match, include: match[1], range: xmlElementRange(text, match) }));
  const packageReferences = references.filter(reference => /\.(?:dcp|bpl|dpl)$/i.test(reference.include));
  const fileReferences = references.filter(reference => /\.(?:pas|pp|dpr|dpk|inc)$/i.test(reference.include));
  const usePackages = [...text.matchAll(/<DCC_UsePackage\b[^>]*>[\s\S]*?<\/DCC_UsePackage\s*>/gi)];
  const insertionOffset = dprojInsertionOffset(text);
  const roots = [];

  if (settings.showProjectPackageEntry) {
    // Package projects keep dependencies as .dcp DCCReference entries. Delphi
    // application projects commonly keep manually selected packages in the
    // last conditioned DCC_UsePackage element, so prefer that when no .dcp
    // reference exists.
    const target = packageReferences[0]?.range[0]
      ?? usePackages.at(-1)?.index
      ?? insertionOffset;
    roots.push({
      id: 'project:packages:dproj',
      kind: 'project-package-section',
      label: 'Package Includes',
      offset: target,
      ranges: packageReferences.length > 0
        ? packageReferences.map(reference => reference.range)
        : usePackages.map(match => [match.index, match.index + match[0].length]),
      targetKind: packageReferences.length > 0 ? 'DCCReference (.dcp)' : 'DCC_UsePackage',
      children: []
    });
  }
  if (settings.showProjectFileEntry) {
    roots.push({
      id: 'project:files:dproj',
      kind: 'project-file-section',
      label: 'File Includes',
      offset: fileReferences[0]?.range[0] ?? insertionOffset,
      ranges: fileReferences.map(reference => reference.range),
      targetKind: 'DCCReference (.pas/.dpr/.dpk)',
      children: []
    });
  }
  attachParents(roots, undefined);
  return {
    filePath,
    roots,
    routineNodes: [],
    implementationNodes: [],
    declarationNodes: [],
    propertyNodes: [],
    typeNodes: [],
    sectionNodes: roots,
    uses: [],
    nodes: roots
  };
}

function routineKeywordAt(text, offset) {
  const lineStart = Math.max(0, text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
  const prefix = text.slice(lineStart, offset);
  return /\b(constructor|destructor|operator|function|procedure)\s*$/i.exec(prefix)?.[1]?.toLowerCase()
    || 'procedure';
}

function routineHeaderEnd(code, start) {
  let parentheses = 0;
  let brackets = 0;
  for (let index = start; index < code.length; index += 1) {
    const current = code[index];
    if (current === '(') parentheses += 1;
    else if (current === ')') parentheses = Math.max(0, parentheses - 1);
    else if (current === '[') brackets += 1;
    else if (current === ']') brackets = Math.max(0, brackets - 1);
    else if (current === ';' && parentheses === 0 && brackets === 0) return index + 1;
  }
  return -1;
}

function routineFlavorAt(code, offset, owner) {
  if (!owner) return 'global';
  const lineStart = Math.max(0, code.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
  const headerEnd = routineHeaderEnd(code, lineStart);
  const prefix = code.slice(lineStart, offset);
  const afterHeader = headerEnd < 0 ? '' : code.slice(headerEnd, Math.min(code.length, headerEnd + 500));
  const nextDeclaration = /^\s*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\b/im.exec(afterHeader);
  const directives = nextDeclaration ? afterHeader.slice(0, nextDeclaration.index) : afterHeader;
  const isClassRoutine = /\bclass\s+(?:function|procedure|constructor|destructor|operator)\b/i.test(prefix);
  if (isClassRoutine && /\bstatic\s*;/i.test(directives)) return 'static';
  return isClassRoutine ? 'class' : 'instance';
}

function memberAccessAt(code, typeOffset, memberOffset, typeKind) {
  const segment = code.slice(typeOffset, memberOffset);
  const pattern = /^\s*(strict\s+private|strict\s+protected|private|protected|public|published|automated)\b/gim;
  let access = typeKind === 'record' || typeKind === 'object' || typeKind === 'interface'
    ? 'public'
    : 'published';
  for (const match of segment.matchAll(pattern)) access = match[1].toLowerCase().replace(/\s+/g, '-');
  return access;
}

function specialRoutineKind(name, routineKind) {
  const key = String(name || '').toLowerCase();
  if (routineKind === 'constructor') return 'constructor';
  if (routineKind === 'destructor') return 'destructor';
  if (key === 'initialize') return 'initialize';
  if (key === 'finalize') return 'finalize';
  if (routineKind === 'operator') return 'operator';
  return undefined;
}

function accessColorId(access) {
  return {
    public: 'charts.green',
    published: 'charts.green',
    protected: 'charts.yellow',
    'strict-protected': 'charts.purple',
    private: 'charts.red',
    'strict-private': 'charts.orange'
  }[access] || 'foreground';
}

function routineIconName(node) {
  if (['constructor', 'destructor', 'initialize', 'finalize'].includes(node.specialRoutineKind)) {
    return 'symbol-constructor';
  }
  if (node.specialRoutineKind === 'operator') return 'symbol-operator';
  if (['static', 'global', 'local'].includes(node.routineFlavor)) return 'symbol-function';
  return 'symbol-method';
}

function nodeSourceOffset(node) {
  return node?.implementationOffset ?? node?.declarationOffset ?? node?.offset;
}

function compareTypeMembers(left, right, memberOrder = 'visibility') {
  if (memberOrder === 'visibility') {
    const lifecycleRank = node => node.specialRoutineKind === 'constructor'
      ? 0
      : node.specialRoutineKind === 'destructor' ? 1 : 2;
    const lifecycleDifference = lifecycleRank(left) - lifecycleRank(right);
    if (lifecycleDifference !== 0) return lifecycleDifference;
    const accessDifference = (MEMBER_ACCESS_ORDER.get(left.access) ?? 99)
      - (MEMBER_ACCESS_ORDER.get(right.access) ?? 99);
    if (accessDifference !== 0) return accessDifference;
  }
  const offset = node => memberOrder === 'declaration'
    ? node?.declarationOffset ?? node?.offset
    : nodeSourceOffset(node);
  return (offset(left) ?? Number.POSITIVE_INFINITY)
    - (offset(right) ?? Number.POSITIVE_INFINITY);
}

function compareTypeNodes(left, right, typeOrder = 'declaration') {
  if (typeOrder === 'alphabetical') {
    const labelDifference = String(left?.label || '').localeCompare(
      String(right?.label || ''),
      undefined,
      { sensitivity: 'base', numeric: true }
    );
    if (labelDifference !== 0) return labelDifference;
  }
  return (left?.offset ?? Number.POSITIVE_INFINITY)
    - (right?.offset ?? Number.POSITIVE_INFINITY);
}

function parseUsesNodes(text, code) {
  const uses = [];
  const ranges = [];
  const sections = [];
  let firstOffset;
  const implementationOffset = /\bimplementation\b/i.exec(code)?.index ?? Number.POSITIVE_INFINITY;
  for (const clause of code.matchAll(/\buses\b([\s\S]*?);/gi)) {
    const clauseOffset = clause.index;
    if (firstOffset === undefined) firstOffset = clauseOffset;
    const range = [clauseOffset, clauseOffset + clause[0].length];
    ranges.push(range);
    sections.push({
      id: `uses-section:${clauseOffset}`,
      kind: 'uses-section',
      label: '',
      offset: clauseOffset,
      ranges: [range],
      section: clauseOffset < implementationOffset ? 'interface' : 'implementation',
      children: []
    });
    const body = clause[1];
    const bodyOffset = clauseOffset + clause[0].indexOf(body);
    let segmentStart = 0;
    for (let cursor = 0; cursor <= body.length; cursor += 1) {
      if (cursor < body.length && body[cursor] !== ',') continue;
      const segment = body.slice(segmentStart, cursor);
      const unitMatch = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\b/.exec(segment);
      if (unitMatch) {
        const name = unitMatch[1];
        const offset = bodyOffset + segmentStart + unitMatch.index;
        uses.push({
          id: `uses:${offset}:${name.toLowerCase()}`,
          kind: 'unit',
          label: name,
          name,
          offset,
          section: clauseOffset < implementationOffset ? 'interface' : 'implementation',
          children: []
        });
      }
      segmentStart = cursor + 1;
    }
  }
  return { uses, firstOffset, ranges, sections };
}

function deduplicateTypes(types, structureEnds = new Map()) {
  const result = [];
  const byName = new Map();
  for (const type of [...types].sort((left, right) => left.offset - right.offset)) {
    if (!STRUCTURE_KINDS.has(type.structureKind)) continue;
    const key = type.symbol.toLowerCase();
    const existing = byName.get(key);
    if (existing) {
      // A forward declaration (`TFoo = class;`) is useful to the symbol index,
      // but it has no lexical body and must not own later sibling types. When
      // the real declaration appears, use it as the navigator node and jump
      // target instead of retaining the earlier forward declaration.
      if (!structureEnds.has(existing.offset) && structureEnds.has(type.offset)) {
        const replacement = { ...type };
        result[result.indexOf(existing)] = replacement;
        byName.set(key, replacement);
      }
      continue;
    }
    const copy = { ...type };
    byName.set(key, copy);
    result.push(copy);
  }
  return result;
}

function isBodylessStructureDeclaration(code, afterKindOffset) {
  let cursor = afterKindOffset;
  while (/\s/.test(code[cursor] || '')) cursor += 1;
  if (code[cursor] === ';') return true;
  if (code[cursor] !== '(') return false;
  let depth = 0;
  for (; cursor < code.length; cursor += 1) {
    if (code[cursor] === '(') depth += 1;
    else if (code[cursor] === ')') {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        break;
      }
    }
  }
  while (/\s/.test(code[cursor] || '')) cursor += 1;
  return code[cursor] === ';';
}

function findStructureEnd(code, bodyStart) {
  let depth = 1;
  const tokenPattern = /^\s*(?:type\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?\s*=\s*(?:packed\s+)?(?:class(?!\s+of\b)|record|object|interface)\b|\bend\s*;/gim;
  tokenPattern.lastIndex = bodyStart;
  let token;
  while ((token = tokenPattern.exec(code))) {
    if (/^\s*end\s*;/i.test(token[0])) {
      depth -= 1;
      if (depth === 0) return tokenPattern.lastIndex;
    } else if (!isBodylessStructureDeclaration(code, tokenPattern.lastIndex)) {
      depth += 1;
    }
  }
  return -1;
}

function structureEndOffsets(code) {
  const result = new Map();
  const pattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>\r\n]*>)?\s*=\s*(?:packed\s+)?(class(?!\s+of\b)|record|object|interface)\b/gim;
  for (const match of code.matchAll(pattern)) {
    const ownerOffset = match.index + match[0].indexOf(match[1]);
    const bodyStart = match.index + match[0].length;
    // Forward declarations do not open a class/interface/record body. Letting
    // one enter findStructureEnd makes it consume the next unrelated `end;`
    // (and, in files with long forward lists, creates a false nesting chain).
    if (isBodylessStructureDeclaration(code, bodyStart)) continue;
    const end = findStructureEnd(code, bodyStart);
    if (end >= 0) result.set(ownerOffset, end);
  }
  return result;
}

function fallbackRoutineDefinitions(text, code) {
  const definitions = [];
  const pattern = /^\s*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)/gim;
  for (const match of code.matchAll(pattern)) {
    const parts = match[1].split('.').map(item => item.replace(/\s*<.*>\s*$/, '').trim());
    const symbol = parts.at(-1);
    const owner = parts.length > 1 ? parts.at(-2) : undefined;
    const offset = match.index + match[0].lastIndexOf(symbol);
    definitions.push({
      symbol,
      owner,
      offset,
      implementationOffset: offset,
      signature: text.slice(match.index, lineEndOffset(text, match.index)).trim(),
      kind: 'routine'
    });
  }
  return definitions;
}

function attachParents(nodes, parent, ancestors = new Set(), visited = new Set()) {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    // Incomplete or temporarily malformed source must never create a recursive
    // TreeDataProvider graph on the extension host's UI thread.
    if (!node || node === parent || ancestors.has(node) || visited.has(node)) {
      nodes.splice(index, 1);
      continue;
    }
    visited.add(node);
    node.parent = parent;
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(node);
    attachParents(node.children || [], node, nextAncestors, visited);
  }
}

function navigatorSearchPattern(query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return undefined;
  if (!needle.includes('*')) return value => value.startsWith(needle);
  const source = needle
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const pattern = new RegExp(`^${source}`, 'i');
  return value => pattern.test(value);
}

function findNavigatorEntries(nodes, query) {
  const matches = [];
  const accepts = navigatorSearchPattern(query);
  if (!accepts) return matches;
  const visit = entries => {
    for (const node of entries || []) {
      if ((node.kind === 'type' || node.kind === 'routine')
        && accepts(String(node.name || node.label || '').toLocaleLowerCase())) {
        matches.push(node);
      }
      visit(node.children);
    }
  };
  visit(nodes);
  return matches;
}

function findNavigatorEntry(nodes, query) {
  return findNavigatorEntries(nodes, query)[0];
}

function normalizeNavigatorSearchOptions(value = {}) {
  return {
    scope: value.scope === 'global' ? 'global' : 'current',
    types: value.types !== false,
    files: value.files === true,
    routines: value.routines !== false,
    navigation: ['all', 'current', 'confirm'].includes(value.navigation)
      ? value.navigation
      : 'all'
  };
}

function navigatorSearchResultId(kind, filePath, offset, name) {
  return ['search', kind, String(filePath || '').toLocaleLowerCase(), offset || 0, name || '']
    .join(':');
}

function navigatorSearchResultsForModel(model, filePath, query, rawOptions = {}) {
  const options = normalizeNavigatorSearchOptions(rawOptions);
  const accepts = navigatorSearchPattern(query);
  if (!accepts || !filePath) return [];
  const results = [];
  const fileName = path.basename(filePath);
  if (options.files && accepts(fileName.toLocaleLowerCase())) {
    results.push({
      id: navigatorSearchResultId('file', filePath, 0, fileName),
      kind: 'file',
      label: fileName,
      description: 'Current file',
      tooltip: filePath,
      icon: 'file',
      filePath,
      offset: 0,
      isCurrentFile: true
    });
  }
  const visit = nodes => {
    for (const node of nodes || []) {
      const acceptedKind = (node.kind === 'type' && options.types)
        || (node.kind === 'routine' && options.routines);
      const name = String(node.name || node.label || '');
      if (acceptedKind && accepts(name.toLocaleLowerCase())) {
        const offset = node.kind === 'routine'
          ? node.implementationOffset ?? node.declarationOffset
          : node.offset ?? node.declarationOffset;
        results.push({
          id: navigatorSearchResultId(node.kind, filePath, offset, node.id),
          kind: node.kind,
          label: node.label,
          description: node.parent?.kind === 'type'
            ? `${node.parent.label} · ${fileName}`
            : fileName,
          tooltip: node.signature || filePath,
          icon: navigatorIconName(node),
          access: node.access,
          filePath,
          offset: Number.isInteger(offset) ? offset : 0,
          isCurrentFile: true,
          name,
          node
        });
      }
      visit(node.children);
    }
  };
  visit(model?.roots);
  return results;
}

function navigatorSearchResultsForIndex(sourceIndex, query, rawOptions = {}, currentFilePath = '') {
  const options = normalizeNavigatorSearchOptions(rawOptions);
  const accepts = navigatorSearchPattern(query);
  if (!accepts || !sourceIndex) return [];
  const currentKey = path.resolve(currentFilePath || '.').toLocaleLowerCase();
  const results = [];
  const seen = new Set();
  const add = result => {
    if (!result.filePath) return;
    const key = `${result.kind}:${path.resolve(result.filePath).toLocaleLowerCase()}:${result.offset || 0}:${result.label.toLocaleLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.isCurrentFile = path.resolve(result.filePath).toLocaleLowerCase() === currentKey;
    results.push(result);
  };
  const definitions = [];
  for (const values of sourceIndex.definitions?.values?.() || []) definitions.push(...values);
  if (options.files) {
    const files = new Map();
    for (const definition of definitions) {
      if (definition?.filePath) files.set(path.resolve(definition.filePath).toLocaleLowerCase(), definition.filePath);
    }
    for (const filePath of sourceIndex.files || []) {
      const resolved = path.resolve(filePath);
      if (!files.has(resolved.toLocaleLowerCase())) files.set(resolved.toLocaleLowerCase(), resolved);
    }
    for (const filePath of files.values()) {
      const fileName = path.basename(filePath);
      if (!accepts(fileName.toLocaleLowerCase())) continue;
      add({
        id: navigatorSearchResultId('file', filePath, 0, fileName),
        kind: 'file', label: fileName, description: path.dirname(filePath), tooltip: filePath,
        icon: 'file', filePath, offset: 0
      });
    }
  }
  for (const definition of definitions) {
    const isType = definition.kind === 'type' && STRUCTURE_KINDS.has(definition.structureKind);
    const isRoutine = definition.kind === 'routine';
    if ((!isType || !options.types) && (!isRoutine || !options.routines)) continue;
    if (!accepts(String(definition.symbol || '').toLocaleLowerCase())) continue;
    const offset = isRoutine
      ? definition.implementationOffset ?? definition.offset
      : definition.offset;
    const fileName = path.basename(definition.filePath || '');
    add({
      id: navigatorSearchResultId(isType ? 'type' : 'routine', definition.filePath, offset, definition.symbol),
      kind: isType ? 'type' : 'routine',
      label: definition.symbol,
      description: definition.owner ? `${definition.owner} · ${fileName}` : fileName,
      tooltip: definition.signature || definition.filePath,
      icon: isType
        ? definition.structureKind === 'interface' ? 'interface'
          : ['record', 'object'].includes(definition.structureKind) ? 'struct' : 'class'
        : definition.owner ? 'symbol-method' : 'symbol-function',
      filePath: definition.filePath,
      offset: Number.isInteger(offset) ? offset : 0,
      definition,
      name: definition.symbol,
      owner: definition.owner
    });
  }
  return results
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
      || left.filePath.localeCompare(right.filePath, undefined, { sensitivity: 'base' })
      || left.offset - right.offset)
    .slice(0, 500);
}

function navigatorNodeForSearchResult(model, result) {
  if (!model || !result || !['type', 'routine'].includes(result.kind)) return undefined;
  const candidates = result.kind === 'type' ? model.typeNodes || [] : model.routineNodes || [];
  const name = String(result.name || result.label || '').toLocaleLowerCase();
  const owner = String(result.owner || '').toLocaleLowerCase();
  const matching = candidates.filter(node => {
    if (String(node.name || node.label || '').toLocaleLowerCase() !== name) return false;
    if (!owner) return true;
    return String(node.owner || node.parent?.name || node.parent?.label || '').toLocaleLowerCase() === owner;
  });
  const pool = matching.length > 0
    ? matching
    : candidates.filter(node => String(node.name || node.label || '').toLocaleLowerCase() === name);
  const targetOffset = Number.isInteger(result.offset) ? result.offset : 0;
  return pool.sort((left, right) => {
    const leftOffset = left.kind === 'routine'
      ? left.implementationOffset ?? left.declarationOffset ?? 0
      : left.offset ?? left.declarationOffset ?? 0;
    const rightOffset = right.kind === 'routine'
      ? right.implementationOffset ?? right.declarationOffset ?? 0
      : right.offset ?? right.declarationOffset ?? 0;
    return Math.abs(leftOffset - targetOffset) - Math.abs(rightOffset - targetOffset);
  })[0];
}

function addRoutineRanges(text, routineNodes) {
  const implementations = routineNodes
    .filter(node => Number.isInteger(node.implementationOffset))
    .sort((left, right) => left.implementationOffset - right.implementationOffset);
  for (let index = 0; index < implementations.length; index += 1) {
    const node = implementations[index];
    if (!Number.isInteger(node.implementationEndOffset)) {
      node.implementationEndOffset = implementations[index + 1]?.implementationOffset ?? text.length;
    }
  }
  for (const node of routineNodes) {
    node.declarationEndOffset = lineEndOffset(text, node.declarationOffset);
  }
}

function routineHeaders(code, startOffset) {
  const result = [];
  const pattern = /^\s*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)/gim;
  pattern.lastIndex = startOffset;
  for (let match; (match = pattern.exec(code));) {
    const parts = match[1].split('.').map(item => item.replace(/\s*<.*>\s*$/, '').trim());
    const name = parts.at(-1);
    const declarationOffset = match.index + match[0].search(/\b(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\b/i);
    result.push({
      // The multiline pattern deliberately accepts indentation and preceding
      // line breaks. Keep the structural start at the actual keyword so the
      // whitespace following a previous `end;` cannot make the next top-level
      // routine look like a nested declaration.
      start: declarationOffset,
      name,
      nameOffset: match.index + match[0].lastIndexOf(name),
      headerEnd: routineHeaderEnd(code, declarationOffset)
    });
  }
  return result;
}

function routineBodyEnd(code, beginOffset) {
  const tokens = /\b(begin|case|try|asm|end)\b/gi;
  tokens.lastIndex = beginOffset;
  let depth = 0;
  for (let token; (token = tokens.exec(code));) {
    if (/^(?:begin|case|try|asm)$/i.test(token[1])) depth += 1;
    else {
      depth -= 1;
      if (depth === 0) {
        let end = tokens.lastIndex;
        while (/[\s;]/.test(code[end] || '')) end += 1;
        return end;
      }
    }
  }
  return code.length;
}

function bodylessRoutineEnd(code, header, nextHeaderStart, nextBeginOffset) {
  // A Delphi external/forward routine has no executable body. Detect its
  // directive before treating a later routine header as a local declaration.
  // `external` commonly carries a library/name clause, so it is not necessarily
  // followed immediately by a semicolon.
  const boundary = Math.min(
    Number.isInteger(nextHeaderStart) ? nextHeaderStart : code.length,
    Number.isInteger(nextBeginOffset) ? nextBeginOffset : code.length
  );
  const tail = code.slice(header.headerEnd, boundary);
  const directive = /\b(?:external|forward|abstract)\b/i.exec(tail);
  if (!directive) return undefined;
  const directiveOffset = header.headerEnd + directive.index;
  const terminator = code.indexOf(';', directiveOffset);
  if (terminator < 0 || terminator >= boundary) return header.headerEnd;
  return terminator + 1;
}

function parseRoutineTree(code, headers, headerIndex) {
  const header = headers[headerIndex];
  if (!header || header.headerEnd < 0) {
    return { header, children: [], end: header?.headerEnd ?? code.length, next: headerIndex + 1 };
  }
  const children = [];
  let cursor = header.headerEnd;
  let childIndex = headerIndex + 1;
  const beginPattern = /\bbegin\b/gi;
  beginPattern.lastIndex = cursor;
  let begin = beginPattern.exec(code);

  const bodylessEnd = bodylessRoutineEnd(
    code,
    header,
    headers[childIndex]?.start,
    begin?.index
  );
  if (bodylessEnd !== undefined) {
    return { header, children, end: bodylessEnd, next: headerIndex + 1 };
  }

  // Routines declared between an outer signature and its executable `begin`
  // are local routines. Parse and skip their complete bodies before looking
  // for the outer routine's own begin token.
  while (childIndex < headers.length && headers[childIndex].start < (begin?.index ?? code.length)) {
    const child = parseRoutineTree(code, headers, childIndex);
    children.push(child);
    cursor = Math.max(cursor, child.end);
    childIndex = Math.max(child.next, childIndex + 1);
    beginPattern.lastIndex = cursor;
    begin = beginPattern.exec(code);
  }

  const declarationTail = code.slice(header.headerEnd, Math.min(begin?.index ?? code.length, header.headerEnd + 500));
  if (!begin || /\b(?:forward|abstract)\s*;|\bexternal\b/i.test(declarationTail)) {
    return { header, children, end: Math.max(header.headerEnd, cursor), next: childIndex };
  }
  const end = routineBodyEnd(code, begin.index);
  while (childIndex < headers.length && headers[childIndex].start < end) {
    const child = parseRoutineTree(code, headers, childIndex);
    children.push(child);
    childIndex = Math.max(child.next, childIndex + 1);
  }
  return { header, children, end, next: childIndex };
}

function implementationRoutineForest(code) {
  const implementation = /\bimplementation\b/i.exec(code);
  if (!implementation) return [];
  // Helper classes and records may be declared in the implementation section.
  // Their body-less method declarations must not be interpreted as nested local
  // functions; Josh.DB.pas previously turned hundreds of methods into one graph.
  const structureRanges = [...structureEndOffsets(code)];
  const headers = routineHeaders(code, implementation.index + implementation[0].length)
    .filter(header => !structureRanges.some(([start, end]) =>
      header.start >= start && header.start < end));
  const forest = [];
  for (let index = 0; index < headers.length;) {
    const routine = parseRoutineTree(code, headers, index);
    forest.push(routine);
    index = Math.max(routine.next, index + 1);
  }
  return forest;
}

function nestLocalRoutines(code, routineNodes, globalRoot) {
  const byOffset = new Map();
  for (const node of routineNodes) {
    if (Number.isInteger(node.implementationOffset)) byOffset.set(node.implementationOffset, node);
    if (Number.isInteger(node.declarationOffset)) byOffset.set(node.declarationOffset, node);
  }
  const nested = new Set();
  const attach = (routine, parentNode) => {
    const node = byOffset.get(routine.header?.nameOffset);
    if (!node) return;
    node.implementationOffset ??= routine.header.nameOffset;
    node.implementationEndOffset = routine.end;
    if (parentNode && node !== parentNode) {
      node.routineFlavor = 'local';
      node.access = parentNode.access;
      if (!parentNode.children.includes(node)) parentNode.children.push(node);
      nested.add(node);
    }
    for (const child of routine.children) attach(child, node);
    node.children.sort((left, right) =>
      (left.implementationOffset ?? left.declarationOffset)
      - (right.implementationOffset ?? right.declarationOffset));
  };
  for (const routine of implementationRoutineForest(code)) attach(routine, undefined);
  if (globalRoot) globalRoot.children = globalRoot.children.filter(node => !nested.has(node));
}

function buildClassNavigatorModel(text, filePath = '', options = {}) {
  const settings = {
    showUses: options.showUses !== false,
    showGlobalRoutines: options.showGlobalRoutines !== false,
    showInterfaces: options.showInterfaces !== false,
    showRecordsAndObjects: options.showRecordsAndObjects !== false,
    showProperties: options.showProperties !== false,
    showProjectPackageEntry: options.showProjectPackageEntry !== false,
    showProjectFileEntry: options.showProjectFileEntry !== false,
    showUnitInitialization: options.showUnitInitialization !== false,
    showUnitFinalization: options.showUnitFinalization !== false,
    memberOrder: ['declaration', 'implementation', 'source'].includes(options.memberOrder)
      ? (options.memberOrder === 'source' ? 'implementation' : options.memberOrder)
      : 'visibility',
    typeOrder: options.typeOrder === 'alphabetical' ? 'alphabetical' : 'declaration'
  };
  const code = maskPascalNonCode(text);
  const structureEnds = structureEndOffsets(code);
  const source = parseSourceUnitSymbols(text, filePath, code, {
    includeImplementationSymbols: true
  });
  const parsedUses = parseUsesNodes(text, code);
  const roots = [];
  const routineNodes = [];

  const projectReferenceRoots = /\.dpk$/i.test(filePath)
    ? dpkProjectReferenceNodes(code, settings)
    : [];

  if (settings.showUses && parsedUses.uses.length > 0) {
    const usesChildren = parsedUses.sections.length > 1
      ? parsedUses.sections.map((section, index) => ({
          ...section,
          label: `uses${index + 1}`
        }))
      : [];
    roots.push({
      id: 'root:uses',
      kind: 'uses-group',
      label: 'uses',
      offset: parsedUses.firstOffset,
      ranges: parsedUses.ranges,
      children: usesChildren
    });
  }
  // `uses` stays the first root item even if a package happens to contain one.
  roots.push(...projectReferenceRoots);

  const sourceMembers = source?.members || [];
  const members = sourceMembers.filter(item => item.kind === 'routine');
  const properties = sourceMembers.filter(item => item.kind === 'property');
  const memberDeclarationOffsets = new Set(members.map(item => item.offset));
  const definitions = source?.definitions || fallbackRoutineDefinitions(text, code);
  const globals = definitions.filter(item => item.kind === 'routine'
    && !item.owner
    && !memberDeclarationOffsets.has(item.offset));
  const uniqueGlobals = [];
  const seenGlobalOffsets = new Set();
  for (const definition of globals.sort((left, right) => left.offset - right.offset)) {
    const key = `${definition.offset}:${definition.symbol.toLowerCase()}`;
    if (seenGlobalOffsets.has(key)) continue;
    seenGlobalOffsets.add(key);
    const node = {
      id: `global:${key}`,
      kind: 'routine',
      label: definition.symbol,
      name: definition.symbol,
      owner: undefined,
      routineKind: routineKeywordAt(text, definition.offset),
      routineFlavor: 'global',
      access: 'public',
      declarationOffset: definition.offset,
      implementationOffset: definition.implementationOffset,
      signature: definition.signature,
      children: []
    };
    uniqueGlobals.push(node);
    routineNodes.push(node);
  }
  if (settings.showGlobalRoutines && uniqueGlobals.length > 0) {
    roots.push({
      id: 'root:global',
      kind: 'global-group',
      label: 'global',
      offset: uniqueGlobals[0].declarationOffset,
      children: uniqueGlobals
    });
  }

  const typeDefinitions = deduplicateTypes(source?.types || [], structureEnds);
  const allTypeNodes = [];
  for (const type of typeDefinitions) {
    if (type.structureKind === 'interface' && !settings.showInterfaces) continue;
    if ((type.structureKind === 'record' || type.structureKind === 'object')
      && !settings.showRecordsAndObjects) continue;
    const typeMembers = members
      .filter(member => member.owner?.toLowerCase() === type.symbol.toLowerCase())
      .sort((left, right) => left.offset - right.offset)
      .map(member => {
        const routineKind = routineKeywordAt(text, member.offset);
        const node = {
          id: `type:${type.symbol.toLowerCase()}:routine:${member.offset}:${member.symbol.toLowerCase()}`,
          kind: 'routine',
          label: member.symbol,
          name: member.symbol,
          owner: type.symbol,
          routineKind,
          routineFlavor: routineFlavorAt(code, member.offset, type.symbol),
          specialRoutineKind: specialRoutineKind(member.symbol, routineKind),
          access: memberAccessAt(code, type.offset, member.offset, type.structureKind),
          declarationOffset: member.offset,
          implementationOffset: member.implementationOffset,
          signature: member.signature,
          children: []
        };
        routineNodes.push(node);
        return node;
      })
      .sort((left, right) => compareTypeMembers(left, right, settings.memberOrder));
    const typeProperties = properties
      .filter(property => property.owner?.toLowerCase() === type.symbol.toLowerCase())
      .sort((left, right) => left.offset - right.offset)
      .map(property => ({
        id: `type:${type.symbol.toLowerCase()}:property:${property.offset}:${property.symbol.toLowerCase()}`,
        kind: 'property',
        label: property.symbol,
        name: property.symbol,
        owner: type.symbol,
        access: memberAccessAt(code, type.offset, property.offset, type.structureKind),
        offset: property.offset,
        rangeOffset: lineStartOffset(text, property.offset),
        declarationEndOffset: lineEndOffset(text, property.offset),
        typeName: property.typeName,
        children: []
      }));
    const typeChildren = settings.showProperties && typeProperties.length > 0
      ? [{
          id: `type:${type.symbol.toLowerCase()}:properties`,
          kind: 'properties-group',
          label: 'properties',
          children: typeProperties
        }, ...typeMembers]
      : typeMembers;
    allTypeNodes.push({
      id: `type:${type.offset}:${type.symbol.toLowerCase()}`,
      kind: 'type',
      typeKind: type.structureKind,
      label: type.symbol,
      name: type.symbol,
      offset: type.offset,
      declarationEndOffset: structureEnds.get(type.offset) ?? lineEndOffset(text, type.offset),
      children: typeChildren
    });
  }

  // Delphi permits declarations such as `TOuter = class ... type TNested =
  // record ... end; ... end;`. The source symbol index intentionally records
  // every structure, but does not encode lexical ownership. Reconstruct that
  // ownership from the already balanced structure ranges and choose the
  // nearest containing type. This keeps nested types navigable without
  // flattening them into unit-level siblings.
  const rootTypeNodes = [];
  const sortedTypeNodes = [...allTypeNodes].sort((left, right) => left.offset - right.offset);
  for (const node of sortedTypeNodes) {
    const parent = sortedTypeNodes
      .filter(candidate => candidate !== node
        && candidate.offset < node.offset
        && candidate.declarationEndOffset >= node.declarationEndOffset)
      .sort((left, right) =>
        (left.declarationEndOffset - left.offset)
        - (right.declarationEndOffset - right.offset))[0];
    if (!parent) {
      rootTypeNodes.push(node);
      continue;
    }
    node.owner = parent.name;
    // Nested types are always the first children of their declaring type,
    // before the properties group and routines, in declaration order.
    let insertAt = 0;
    while (insertAt < parent.children.length
      && parent.children[insertAt].kind === 'type'
      && parent.children[insertAt].offset < node.offset) insertAt += 1;
    parent.children.splice(insertAt, 0, node);
  }
  rootTypeNodes.sort((left, right) => compareTypeNodes(left, right, settings.typeOrder));
  roots.push(...rootTypeNodes);

  // Unit lifecycle sections are deliberately last and are not global routines.
  roots.push(...unitLifecycleNodes(code, settings));

  const globalRoot = roots.find(node => node.kind === 'global-group');
  nestLocalRoutines(code, routineNodes, globalRoot);
  if (globalRoot && globalRoot.children.length === 0) {
    roots.splice(roots.indexOf(globalRoot), 1);
  }
  addRoutineRanges(text, routineNodes);
  attachParents(roots, undefined);
  const nodes = [];
  const collectNodes = entries => {
    for (const entry of entries || []) {
      nodes.push(entry);
      collectNodes(entry.children);
    }
  };
  collectNodes(roots);
  const implementationNodes = routineNodes
    .filter(node => Number.isInteger(node.implementationOffset))
    .sort((left, right) => left.implementationOffset - right.implementationOffset);
  const declarationNodes = routineNodes
    .filter(node => Number.isInteger(node.declarationOffset))
    .sort((left, right) => left.declarationOffset - right.declarationOffset);
  const propertyNodes = nodes
    .filter(node => node.kind === 'property' && Number.isInteger(node.offset))
    .sort((left, right) => left.offset - right.offset);
  const typeNodes = allTypeNodes
    .sort((left, right) => left.offset - right.offset);
  const sectionNodes = roots.flatMap(node => {
    if (node.kind === 'uses-group') return node.children?.length ? node.children : [node];
    return /^(?:project-(?:package|file)|unit-(?:initialization|finalization))-section$/.test(node.kind)
      ? [node]
      : [];
  });
  return {
    filePath,
    roots,
    routineNodes,
    implementationNodes,
    declarationNodes,
    propertyNodes,
    typeNodes,
    sectionNodes,
    uses: parsedUses.uses,
    nodes
  };
}

function findLatestContainingNode(nodes, offset, startKey, endKey, followRoutineParent = false) {
  let low = 0;
  let high = nodes.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (nodes[middle][startKey] <= offset) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  let node = candidate >= 0 ? nodes[candidate] : undefined;
  while (node) {
    if (offset >= node[startKey] && offset < node[endKey]) return node;
    node = followRoutineParent && node.parent?.kind === 'routine' ? node.parent : undefined;
  }
  return undefined;
}

function activeNodeAt(model, offset) {
  if (!model) return undefined;
  const projectSection = (model.sectionNodes || model.projectSectionNodes || [])
    .find(node => node.ranges?.some(range => offset >= range[0] && offset < range[1]));
  if (projectSection) return projectSection;
  const implementation = findLatestContainingNode(
    model.implementationNodes || model.routineNodes || [],
    offset,
    'implementationOffset',
    'implementationEndOffset',
    true
  );
  if (implementation) return implementation;

  const declaration = findLatestContainingNode(
    model.declarationNodes || model.routineNodes || [],
    offset,
    'declarationOffset',
    'declarationEndOffset'
  );
  if (declaration) return declaration;

  const property = findLatestContainingNode(
    model.propertyNodes || [],
    offset,
    'rangeOffset',
    'declarationEndOffset'
  );
  if (property) return property;

  return findLatestContainingNode(
    model.typeNodes || [],
    offset,
    'offset',
    'declarationEndOffset'
  );
}

function nodeSourceRanges(text, node, focusOffset) {
  if (!node || node.kind === 'global-group' || node.kind === 'properties-group'
    || node.kind === 'navigator-loading' || node.kind === 'navigator-error') return [];
  let ranges = [];
  if (node.kind === 'ai-step' && Number.isInteger(node.startLine)) {
    ranges = [[
      offsetAtLine(text, node.startLine),
      offsetAtLine(text, Math.max(node.startLine, node.endLine || node.startLine) + 1)
    ]];
  } else if (Array.isArray(node.ranges) && node.ranges.length > 0) {
    ranges = node.ranges;
  } else if (node.kind === 'routine') {
    if (Number.isInteger(node.implementationOffset)) {
      ranges.push([
        lineStartOffset(text, node.implementationOffset),
        node.implementationEndOffset ?? lineEndOffset(text, node.implementationOffset)
      ]);
    }
    if (Number.isInteger(node.declarationOffset)) {
      ranges.push([
        lineStartOffset(text, node.declarationOffset),
        node.declarationEndOffset ?? lineEndOffset(text, node.declarationOffset)
      ]);
    }
  } else {
    const start = node.offset ?? node.declarationOffset;
    if (Number.isInteger(start)) {
      ranges = [[
        lineStartOffset(text, start),
        node.declarationEndOffset ?? lineEndOffset(text, start)
      ]];
    }
  }
  const normalized = ranges
    .map(([start, end]) => [
      Math.max(0, Math.min(text.length, start)),
      Math.max(0, Math.min(text.length, end))
    ])
    .filter(([start, end]) => end >= start);
  if (!Number.isInteger(focusOffset)) return normalized;
  const focused = normalized.find(([start, end]) => focusOffset >= start && focusOffset < end);
  return focused ? [focused] : normalized.slice(0, 1);
}

function highlightNodeForExpandedSteps(text, node, focusOffset, expandedRoutineIds) {
  if (!node || node.kind !== 'routine' || !expandedRoutineIds?.has(node.id)
    || !Number.isInteger(focusOffset)) return node;
  const implementationStart = node.implementationOffset;
  const implementationEnd = node.implementationEndOffset;
  if (!Number.isInteger(implementationStart) || !Number.isInteger(implementationEnd)
    || focusOffset < implementationStart || focusOffset >= implementationEnd) return node;
  const steps = (node.children || [])
    .filter(child => child.kind === 'ai-step' && Number.isInteger(child.startLine))
    .sort((left, right) => left.startLine - right.startLine);
  if (steps.length === 0) return node;
  for (const step of steps) {
    const range = nodeSourceRanges(text, step)[0];
    if (range && focusOffset >= range[0] && focusOffset < range[1]) {
      return highlightExpandedAiStepAt(text, step, focusOffset, expandedRoutineIds);
    }
  }
  // The routine header precedes the first functional step. When the steps are
  // visible, treat that header as entering step 1 instead of flashing the
  // whole-routine gutter range before the caret reaches the first body line.
  return focusOffset < offsetAtLine(text, steps[0].startLine) ? steps[0] : node;
}

function highlightExpandedAiStepAt(text, step, focusOffset, expandedNodeIds) {
  if (!step?.children?.length || !expandedNodeIds?.has(step.id)) return step;
  const children = step.children
    .filter(child => child.kind === 'ai-step' && Number.isInteger(child.startLine))
    .sort((left, right) => left.startLine - right.startLine);
  for (const child of children) {
    const range = nodeSourceRanges(text, child)[0];
    if (range && focusOffset >= range[0] && focusOffset < range[1]) {
      // Continue through every expanded level. Returning `child` here limited
      // editor-follow synchronization to two levels even though deeper step
      // nodes and their source ranges were already present.
      return highlightExpandedAiStepAt(text, child, focusOffset, expandedNodeIds);
    }
  }
  return step;
}

function activeFollowNodeAt(text, model, offset, expandedRoutineIds) {
  return highlightNodeForExpandedSteps(
    text,
    activeNodeAt(model, offset),
    offset,
    expandedRoutineIds
  );
}

function navigationRevealPlan(startLine, endLine, visibleLineCount, mode = 'smart', startPercent = 25) {
  const firstLine = Math.max(0, Number.isFinite(startLine) ? Math.floor(startLine) : 0);
  const lastLine = Math.max(firstLine, Number.isFinite(endLine) ? Math.floor(endLine) : firstLine);
  const viewportLines = Math.max(1, Number.isFinite(visibleLineCount)
    ? Math.floor(visibleLineCount)
    : 1);
  const normalizedMode = ['smart', 'center', 'top', 'default'].includes(mode) ? mode : 'smart';
  const normalizedPercent = Math.max(0, Math.min(100,
    Number.isFinite(startPercent) ? startPercent : 25));
  const blockLines = lastLine - firstLine + 1;

  if (normalizedMode === 'default') {
    return { kind: 'default', startLine: firstLine, endLine: lastLine };
  }
  if (normalizedMode === 'center' || (normalizedMode === 'smart' && blockLines <= viewportLines)) {
    return { kind: 'center', startLine: firstLine, endLine: lastLine };
  }
  if (normalizedMode === 'top') {
    return { kind: 'top', startLine: firstLine, endLine: lastLine, anchorLine: firstLine };
  }
  return {
    kind: 'anchor',
    startLine: firstLine,
    endLine: lastLine,
    anchorLine: Math.max(0, firstLine - Math.floor(viewportLines * normalizedPercent / 100))
  };
}

function viewportFollowLine(startLine, endLine, offsetLines = 1) {
  const first = Math.max(0, Number.isFinite(startLine) ? Math.floor(startLine) : 0);
  const last = Math.max(first, Number.isFinite(endLine) ? Math.floor(endLine) : first);
  const offset = Math.max(-20, Math.min(20,
    Number.isFinite(offsetLines) ? Math.round(offsetLines) : 1));
  return Math.max(first, Math.min(last, Math.floor((first + last) / 2) + offset));
}

// GLM 5.2 accepts `minimal`, but some OpenAI-compatible gateways sometimes
// complete that fast path without emitting a normal response body. Keep the
// fast default and pay for the more reliable effort only after a bad response.
function aiRetryReasoningEffort(reasoningEffort) {
  return reasoningEffort === 'minimal' ? 'low' : reasoningEffort;
}

function pendingNavigatorModel(filePath, label = 'Analyzing current file in the background…', kind = 'navigator-loading') {
  const loading = {
    id: `loading:${filePath}`,
    kind,
    label,
    children: []
  };
  return {
    filePath,
    roots: [loading],
    routineNodes: [],
    implementationNodes: [],
    declarationNodes: [],
    typeNodes: [],
    sectionNodes: [],
    uses: [],
    nodes: [loading]
  };
}

class ClassNavigatorProvider {
  constructor(vscode, output, context) {
    this.vscode = vscode;
    this.output = output;
    this.context = context;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.cache = undefined;
    this.activeState = undefined;
    const savedEntries = context?.workspaceState.get(AI_STEP_CACHE_STATE_KEY, {});
    this.aiCache = new Map(Object.entries(savedEntries && typeof savedEntries === 'object'
      ? savedEntries
      : {}));
    const savedChunkEntries = context?.workspaceState.get(AI_STEP_CHUNK_CACHE_STATE_KEY, {});
    this.aiChunkCache = new Map(Object.entries(savedChunkEntries && typeof savedChunkEntries === 'object'
      ? savedChunkEntries
      : {}));
    this.aiSessionKeys = new Set();
    this.aiPending = new Map();
    this.modelWorker = undefined;
    this.modelWorkerKey = undefined;
    this.onModelReady = undefined;
    this.nodeDocumentUris = new WeakMap();
    this.isNodeExpanded = undefined;
  }

  activeDocument() {
    const document = this.vscode.window.activeTextEditor?.document;
    return isClassNavigatorDocument(document) ? document : undefined;
  }

  configuration() {
    const config = this.vscode.workspace.getConfiguration('pascalUnion.classNavigator');
    return {
      showUses: config.get('showUses', true),
      showGlobalRoutines: config.get('showGlobalRoutines', true),
      showInterfaces: config.get('showInterfaces', true),
      showRecordsAndObjects: config.get('showRecordsAndObjects', true),
      showProperties: config.get('showProperties', true),
      showProjectPackageEntry: config.get('showProjectPackageEntry', true),
      showProjectFileEntry: config.get('showProjectFileEntry', true),
      showUnitInitialization: config.get('showUnitInitialization', true),
      showUnitFinalization: config.get('showUnitFinalization', true),
      memberOrder: config.get('memberOrder', 'visibility'),
      typeOrder: config.get('typeOrder', 'declaration'),
      backgroundParsingEnabled: config.get('backgroundParsing.enabled', true),
      backgroundParsingThresholdKb: config.get('backgroundParsing.thresholdKb', 256),
      aiStepsEnabled: config.get('aiSteps.enabled', true)
    };
  }

  aiConfiguration(document = this.activeDocument()) {
    const config = this.vscode.workspace.getConfiguration('pascalUnion', document?.uri);
    return {
      enabled: config.get('classNavigator.aiSteps.enabled', true),
      provider: config.get('classNavigator.aiSteps.provider', 'oaicopilot'),
      modelId: config.get('classNavigator.aiSteps.modelId', ''),
      reasoningEffort: config.get('classNavigator.aiSteps.reasoningEffort', 'low'),
      granularity: config.get('classNavigator.aiSteps.granularity', 'coarse'),
      normalTargetLines: config.get('classNavigator.aiSteps.normalTargetLines', 20),
      detailedTargetLines: config.get('classNavigator.aiSteps.detailedTargetLines', 10),
      maxSteps: config.get('classNavigator.aiSteps.maxSteps', 5),
      substepsEnabled: config.get('classNavigator.aiSteps.substeps.enabled', true),
      maxSubsteps: config.get('classNavigator.aiSteps.substeps.maxPerStep', 5),
      substepMinParentLines: config.get('classNavigator.aiSteps.substeps.minParentLines', 30),
      maxDepth: config.get('classNavigator.aiSteps.substeps.maxDepth', 3),
      maxSourceCharacters: config.get('classNavigator.aiSteps.maxSourceCharacters', 24000),
      requestTimeoutSeconds: config.get('classNavigator.aiSteps.requestTimeoutSeconds', 180),
      cacheEnabled: config.get('classNavigator.aiSteps.cacheEnabled', true),
      skipCached: true
    };
  }

  routineForNode(node) {
    for (let current = node; current; current = current.parent) {
      if (current.kind === 'routine') return current;
    }
    return undefined;
  }

  aiRequestFor(node, document = this.activeDocument(), text = document?.getText(), overrides = {}) {
    const routine = this.routineForNode(node);
    if (!document || !routine || !Number.isInteger(routine.implementationOffset)) return undefined;
    const settings = { ...this.aiConfiguration(document), ...overrides };
    const key = routineAnalysisKey(document.uri.toString(), text, routine, settings);
    const analysis = buildAiStepPrompt(text, routine, {
      ...settings,
      chunkLabelCache: this.aiChunkCache
    });
    if (!key || !analysis) return undefined;
    let reusedChunkCache = false;
    if (analysis.fixedPlan && analysis.unresolvedIds.length === 0 && !this.aiCache.has(key)) {
      const steps = parseAiStepResponseResult('', analysis, analysis).steps;
      this.aiCache.set(key, {
        documentUri: document.uri.toString(),
        routine: this.nodeIdentity(routine),
        generatedAt: Date.now(),
        model: 'chunk-cache',
        settings,
        steps
      });
      reusedChunkCache = true;
    }
    return { document, routine, text, key, settings, analysis, reusedChunkCache };
  }

  hasAiSteps(request) {
    const cached = request?.key ? this.aiCache.get(request.key) : undefined;
    return Boolean(cached?.steps?.length
      && (request.settings.cacheEnabled || this.aiSessionKeys.has(request.key)));
  }

  invalidateAiPresentation() {
    this.cache = undefined;
    this.changed.fire(undefined);
  }

  refreshAiRoutine(request) {
    const document = this.activeDocument();
    if (!document || !request
      || document.uri.toString() !== request.document.uri.toString()) return false;
    const model = this.model();
    const identity = this.nodeIdentity(request.routine);
    const routine = (model?.routineNodes || []).find(candidate =>
      this.nodeIdentity(candidate) === identity);
    if (!routine) return false;
    routine.children = (routine.children || []).filter(child =>
      child.kind !== 'ai-step' && child.kind !== 'ai-step-loading');
    const pending = this.aiPending.get(request.key);
    if (pending) {
      if (pending.partialSteps?.length) {
        const partialSteps = createAiStepNodes(
          document.getText(),
          routine,
          request.key,
          pending.partialSteps
        );
        for (const step of partialSteps) step.parent = routine;
        routine.children.push(...partialSteps);
      }
      routine.children.push({
        id: `ai-step-loading:${routine.id}`,
        kind: 'ai-step-loading',
        label: 'Generating steps…',
        children: [],
        parent: routine
      });
    } else {
      const cached = this.aiCache.get(request.key);
      if (cached?.steps?.length) {
        const steps = createAiStepNodes(document.getText(), routine, request.key, cached.steps);
        for (const step of steps) step.parent = routine;
        routine.children.push(...steps);
      }
    }
    // Fire the routine element, not undefined. The combined provider forwards
    // this exact element so VS Code only asks for this function's TreeItem and
    // children; all other expansion, selection and scroll state stays intact.
    this.changed.fire(routine);
    return true;
  }

  beginAiGeneration(request, options = {}) {
    this.aiPending.set(request.key, {
      startedAt: Date.now(),
      documentUri: request.document.uri.toString(),
      routineIdentity: this.nodeIdentity(request.routine),
      settings: request.settings
    });
    if (options.refresh !== false) this.refreshAiRoutine(request);
  }

  updateAiGeneration(request, steps) {
    const pending = request?.key ? this.aiPending.get(request.key) : undefined;
    if (!pending || !steps?.length) return;
    pending.partialSteps = steps;
    this.refreshAiRoutine(request);
  }

  async persistAiCache() {
    if (!this.context?.workspaceState) return;
    const entries = [...this.aiCache.entries()]
      .sort((left, right) => (right[1]?.generatedAt || 0) - (left[1]?.generatedAt || 0))
      .slice(0, 2000);
    await this.context.workspaceState.update(AI_STEP_CACHE_STATE_KEY, Object.fromEntries(entries));
    const chunkEntries = [...this.aiChunkCache.entries()]
      .slice(-6000);
    await this.context.workspaceState.update(
      AI_STEP_CHUNK_CACHE_STATE_KEY,
      Object.fromEntries(chunkEntries)
    );
  }

  async completeAiGeneration(request, steps, model, options = {}) {
    this.aiPending.delete(request.key);
    this.aiCache.set(request.key, {
      documentUri: request.document.uri.toString(),
      routine: this.nodeIdentity(request.routine),
      generatedAt: Date.now(),
      model: model?.id || model?.name || '',
      settings: request.settings,
      steps
    });
    this.aiSessionKeys.add(request.key);
    for (const [hash, title] of plannedLabelsByHash(request.analysis, steps)) {
      this.aiChunkCache.delete(hash);
      this.aiChunkCache.set(hash, title);
    }
    if (request.settings.cacheEnabled && options.persist !== false) await this.persistAiCache();
    if (options.refresh !== false) this.refreshAiRoutine(request);
  }

  failAiGeneration(request, options = {}) {
    if (!request?.key) return;
    this.aiPending.delete(request.key);
    if (options.refresh !== false) this.refreshAiRoutine(request);
  }

  applyAiSteps(model, document) {
    const settings = this.aiConfiguration(document);
    if (!settings.enabled) return;
    const text = document.getText();
    const documentUri = document.uri.toString();
    // Computing a content hash and line range for every routine in a very large
    // unit is unnecessary when almost none has AI data. First filter by the
    // persisted/session metadata, then hash only routines that can actually
    // gain step children or a loading child.
    const cachedByRoutine = new Map();
    for (const [key, cached] of this.aiCache) {
      if (cached?.documentUri === documentUri && cached.routine) {
        if (!cachedByRoutine.has(cached.routine)) cachedByRoutine.set(cached.routine, []);
        cachedByRoutine.get(cached.routine).push({ key, cached });
      }
    }
    const pendingByRoutine = new Map();
    for (const [key, pending] of this.aiPending) {
      if (pending?.documentUri === documentUri && pending.routineIdentity) {
        if (!pendingByRoutine.has(pending.routineIdentity)) pendingByRoutine.set(pending.routineIdentity, []);
        pendingByRoutine.get(pending.routineIdentity).push({ key, pending });
      }
    }
    if (cachedByRoutine.size === 0 && pendingByRoutine.size === 0) return;
    for (const routine of model.routineNodes || []) {
      const identity = this.nodeIdentity(routine);
      const pendingEntry = (pendingByRoutine.get(identity) || []).find(entry =>
        routineAnalysisKey(documentUri, text, routine, entry.pending.settings || settings) === entry.key);
      const cachedEntry = (cachedByRoutine.get(identity) || [])
        .filter(entry => routineAnalysisKey(
          documentUri,
          text,
          routine,
          entry.cached.settings || settings
        ) === entry.key)
        .sort((left, right) => (right.cached.generatedAt || 0) - (left.cached.generatedAt || 0))[0];
      if (!pendingEntry && !cachedEntry) continue;
      routine.children = (routine.children || []).filter(child =>
        child.kind !== 'ai-step' && child.kind !== 'ai-step-loading');
      if (pendingEntry) {
        if (pendingEntry.pending.partialSteps?.length) {
          const partialSteps = createAiStepNodes(
            text,
            routine,
            pendingEntry.key,
            pendingEntry.pending.partialSteps
          );
          for (const step of partialSteps) step.parent = routine;
          routine.children.push(...partialSteps);
        }
        const loading = {
          id: `ai-step-loading:${routine.id}`,
          kind: 'ai-step-loading',
          label: 'Generating steps…',
          children: [],
          parent: routine
        };
        routine.children.push(loading);
        continue;
      }
      const { key, cached } = cachedEntry;
      if (!cached?.steps?.length || (!settings.cacheEnabled && !this.aiSessionKeys.has(key))) continue;
      const steps = createAiStepNodes(text, routine, key, cached.steps);
      for (const step of steps) step.parent = routine;
      routine.children.push(...steps);
    }
  }

  modelKey(document) {
    return `${document.uri.toString()}@${document.version}@${JSON.stringify(this.configuration())}`;
  }

  cancelModelWorker() {
    if (this.modelWorker) void this.modelWorker.terminate();
    this.modelWorker = undefined;
    this.modelWorkerKey = undefined;
  }

  buildLargeModel(document, text, options, key) {
    if (this.modelWorkerKey === key) return;
    this.cancelModelWorker();
    const worker = new Worker(path.join(__dirname, 'classNavigatorWorker.js'));
    this.modelWorker = worker;
    this.modelWorkerKey = key;
    const finish = () => {
      if (this.modelWorker === worker) {
        this.modelWorker = undefined;
        this.modelWorkerKey = undefined;
      }
      void worker.terminate();
    };
    worker.once('message', message => {
      finish();
      const activeDocument = this.activeDocument();
      if (!activeDocument || this.modelKey(activeDocument) !== key) return;
      if (message?.error) {
        this.output?.appendLine(`Large-file class navigator failed: ${message.error}`);
        this.cache = {
          key,
          model: pendingNavigatorModel(document.fileName, 'Class navigator analysis failed. Click refresh to retry.', 'navigator-error')
        };
      } else {
        this.applyAiSteps(message.model, activeDocument);
        this.cache = { key, model: message.model };
        this.output?.appendLine(
          `Large-file class navigator ready: ${path.basename(document.fileName)} `
          + `(${text.length} characters, ${message.elapsedMs} ms in worker).`
        );
      }
      this.changed.fire(undefined);
      this.onModelReady?.();
    });
    worker.once('error', error => {
      finish();
      if (this.cache?.key !== key) return;
      this.output?.appendLine(`Large-file class navigator worker failed: ${error.stack || error.message}`);
      this.cache = {
        key,
        model: pendingNavigatorModel(document.fileName, 'Class navigator analysis failed. Click refresh to retry.', 'navigator-error')
      };
      this.changed.fire(undefined);
    });
    worker.postMessage({ text, filePath: document.fileName, options });
  }

  model() {
    const document = this.activeDocument();
    if (!document) return undefined;
    const options = this.configuration();
    const key = this.modelKey(document);
    if (this.cache?.key === key) return this.cache.model;
    const text = document.getText();
    const backgroundThreshold = Math.max(
      64 * 1024,
      Number(options.backgroundParsingThresholdKb || 256) * 1024
    );
    if (options.backgroundParsingEnabled !== false
      && !/\.dproj$/i.test(document.fileName)
      && text.length >= backgroundThreshold) {
      const model = pendingNavigatorModel(document.fileName);
      this.cache = { key, model };
      this.buildLargeModel(document, text, options, key);
      return model;
    }
    this.cancelModelWorker();
    const model = /\.dproj$/i.test(document.fileName)
      ? buildDprojNavigatorModel(text, document.fileName, options)
      : buildClassNavigatorModel(text, document.fileName, options);
    this.applyAiSteps(model, document);
    this.cache = { key, model };
    return model;
  }

  refresh() {
    // URI, version and all model options are already part of the cache key.
    // Keeping a still-valid model avoids parsing twice when a click/scroll lands
    // just before the debounced document refresh.
    this.changed.fire(undefined);
  }

  async readyModel(document = this.activeDocument()) {
    if (!document) return undefined;
    let model = this.model();
    if (!model?.roots?.some(node => node.kind === 'navigator-loading')) return model;
    return new Promise(resolve => {
      const disposable = this.onDidChangeTreeData(() => {
        if (this.activeDocument()?.uri.toString() !== document.uri.toString()) {
          disposable.dispose();
          resolve(undefined);
          return;
        }
        model = this.model();
        if (model?.roots?.some(node => node.kind === 'navigator-loading')) return;
        disposable.dispose();
        resolve(model);
      });
    });
  }

  nodeIdentity(node) {
    return [node.kind, node.owner || '', node.name || node.label || '', node.signature || node.typeName || '']
      .join('|').toLowerCase();
  }

  setActiveNode(node) {
    const document = this.activeDocument();
    if (!document || !node) return false;
    const next = {
      documentUri: document.uri.toString(),
      id: node.id,
      identity: this.nodeIdentity(node)
    };
    if (this.activeState?.id === node.id && this.activeState?.documentUri === next.documentUri) {
      this.activeState = next;
      return false;
    }
    this.activeState = next;
    return true;
  }

  getParent(node) {
    return node.parent;
  }

  getChildren(node) {
    if (node) return node.children || [];
    return this.model()?.roots || [];
  }

  getTreeItem(node) {
    const vscode = this.vscode;
    const documentUri = this.activeDocument()?.uri.toString();
    if (documentUri && node && typeof node === 'object') {
      this.nodeDocumentUris.set(node, documentUri);
    }
    const hasChildren = Boolean(node.children?.length);
    const collapsible = hasChildren
      ? (this.isNodeExpanded?.(node, documentUri)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    // Node ids are stable inside a file, but the same type/routine ids can
    // occur in another editor. Qualifying the TreeItem id prevents VS Code
    // from reusing the other document's expansion state during a jump.
    item.id = documentUri ? `${documentUri}::${node.id}` : node.id;
    item.contextValue = `pascalUnion.classNavigator.${node.kind}`;
    const accessColor = node.access
      ? new vscode.ThemeColor(accessColorId(node.access))
      : undefined;
    if (node.kind === 'uses-group' || node.kind === 'uses-section') {
      item.iconPath = new vscode.ThemeIcon('references');
    }
    else if (node.kind === 'navigator-loading') {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.tooltip = node.label;
    }
    else if (node.kind === 'navigator-error') {
      item.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
      item.tooltip = node.label;
    }
    else if (node.kind === 'unit') item.iconPath = new vscode.ThemeIcon('symbol-namespace');
    else if (node.kind === 'global-group') item.iconPath = new vscode.ThemeIcon('globe');
    else if (node.kind === 'project-package-section') {
      item.iconPath = new vscode.ThemeIcon('package');
      item.tooltip = `Go to package includes: ${node.targetKind}`;
    }
    else if (node.kind === 'project-file-section') {
      item.iconPath = new vscode.ThemeIcon('files');
      item.tooltip = `Go to file includes: ${node.targetKind}`;
    }
    else if (node.kind === 'unit-initialization-section') {
      item.iconPath = new vscode.ThemeIcon('symbol-function', new vscode.ThemeColor('charts.purple'));
      item.tooltip = 'Unit initialization section. Click to go to initialization.';
    }
    else if (node.kind === 'unit-finalization-section') {
      item.iconPath = new vscode.ThemeIcon('symbol-function', new vscode.ThemeColor('charts.purple'));
      item.tooltip = 'Unit finalization section. Click to go to finalization.';
    }
    else if (node.kind === 'properties-group') {
      item.iconPath = new vscode.ThemeIcon('list-tree');
      item.tooltip = 'Properties declared by this type';
    }
    else if (node.kind === 'property') {
      item.iconPath = new vscode.ThemeIcon('symbol-property', accessColor);
      item.tooltip = `${node.access || 'public'} property ${node.name}${node.typeName ? `: ${node.typeName}` : ''}`;
    }
    else if (node.kind === 'ai-step') {
      item.iconPath = new vscode.ThemeIcon('list-ordered', new vscode.ThemeColor('charts.purple'));
      item.tooltip = node.endLine > node.startLine
        ? `AI-generated routine steps · lines ${node.startLine}–${node.endLine}`
        : `AI-generated routine steps · line ${node.startLine}`;
    }
    else if (node.kind === 'ai-step-loading') {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.tooltip = 'Summarizing the current routine with the OAI Compatible model.';
    }
    else if (node.kind === 'type') {
      const icon = node.typeKind === 'interface'
        ? 'symbol-interface'
        : node.typeKind === 'record' || node.typeKind === 'object'
          ? 'symbol-object'
          : 'symbol-class';
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = `${node.typeKind} ${node.name}`;
    } else if (node.kind === 'routine') {
      const lifecycle = ['constructor', 'destructor', 'initialize', 'finalize']
        .includes(node.specialRoutineKind);
      const icon = routineIconName(node);
      const flavor = lifecycle
        ? 'Lifecycle method'
        : node.specialRoutineKind === 'operator'
          ? 'Operator'
          : node.routineFlavor === 'static'
            ? 'Static method'
            : node.routineFlavor === 'class'
              ? 'Class method'
              : node.routineFlavor === 'local'
                ? 'Local routine'
                : undefined;
      item.iconPath = new vscode.ThemeIcon(
        icon,
        lifecycle ? new vscode.ThemeColor('charts.purple') : accessColor
      );
      item.tooltip = `${flavor ? `${flavor} · ` : ''}${node.access ? `${node.access} · ` : ''}${node.signature || `${node.routineKind} ${node.name}`}`;
    }
    if (node.kind === 'uses-group') item.tooltip = 'Uses in the current file. Click to go to the uses clause; imported packages are not expanded.';
    if (node.kind === 'uses-section') {
      item.tooltip = `${node.section === 'interface' ? 'interface' : 'implementation'} uses. Click to navigate to and mark this uses block.`;
    }
    if (Number.isInteger(node.offset) || Number.isInteger(node.declarationOffset)) {
      item.command = {
        command: 'pascalUnion.classNavigator.open',
        title: 'Go to',
        arguments: [node]
      };
    }
    return item;
  }

  documentUriForNode(node) {
    return node && typeof node === 'object' ? this.nodeDocumentUris.get(node) : undefined;
  }

  dispose() {
    this.cancelModelWorker();
  }
}

function navigatorIconName(node) {
  if (node.kind === 'project') return 'project';
  if (node.kind === 'package') return 'package';
  if (node.kind === 'file') return ['.dpk', '.dpr', '.dproj']
    .includes(path.extname(node.filePath || '').toLowerCase())
    ? 'project-file'
    : 'file';
  if (node.kind === 'uses-group' || node.kind === 'uses-section') return 'references';
  if (node.kind === 'navigator-loading') return 'loading';
  if (node.kind === 'navigator-error') return 'error';
  if (node.kind === 'unit') return 'namespace';
  if (node.kind === 'global-group') return 'global';
  if (node.kind === 'project-package-section') return 'package';
  if (node.kind === 'project-file-section') return 'files';
  if (/^unit-(?:initialization|finalization)-section$/.test(node.kind)) return 'symbol-function';
  if (node.kind === 'properties-group') return 'properties';
  if (node.kind === 'property') return 'property';
  if (node.kind === 'ai-step') return 'list-ordered';
  if (node.kind === 'ai-step-loading') return 'loading';
  if (node.kind === 'type') return node.typeKind === 'interface'
    ? 'interface'
    : node.typeKind === 'record' || node.typeKind === 'object' ? 'object' : 'class';
  if (node.kind === 'routine') return routineIconName(node);
  return 'symbol';
}

function serializeNavigatorNode(node, options = {}) {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    access: node.access,
    icon: navigatorIconName(node),
    jumpable: Number.isInteger(node.offset) || Number.isInteger(node.declarationOffset),
    tooltip: node.signature || node.typeName || node.filePath || node.projectPath
      || node.groupPath || node.fsPath || '',
    contextValue: node.contextValue,
    initialExpanded: node.kind === 'project'
      || (node.kind === 'package' && options.projectDefaultExpansion === 'all'),
    children: (node.children || []).map(child => serializeNavigatorNode(child, options))
  };
}

function navigatorNodePath(node) {
  const result = [];
  for (let current = node?.parent; current; current = current.parent) result.unshift(current.id);
  return result;
}

function navigatorNodeById(model, id) {
  if (!id) return undefined;
  const pending = [...(model?.roots || [])];
  while (pending.length) {
    const node = pending.shift();
    if (node.id === id) return node;
    pending.unshift(...(node.children || []));
  }
  return undefined;
}

function classNavigatorHtml(webview) {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { width: 100%; min-height: 100%; margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-weight) var(--vscode-font-size)/22px var(--vscode-font-family); overflow-x: hidden; }
  #empty { padding: 8px 12px; color: var(--vscode-descriptionForeground); white-space: normal; }
  .row { display: flex; align-items: center; height: 22px; padding-right: 8px; border: 0; outline: 0; color: var(--vscode-foreground); background: transparent; cursor: default; user-select: none; white-space: nowrap; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.selected, .row.selected:hover { color: var(--vscode-list-inactiveSelectionForeground, var(--vscode-foreground)); background: var(--vscode-list-inactiveSelectionBackground, rgba(127,127,127,.24)); }
  .twisty { flex: 0 0 16px; width: 16px; height: 22px; padding: 0; border: 0; outline: 0; color: var(--vscode-icon-foreground); background: transparent; font: inherit; line-height: 22px; text-align: center; cursor: pointer; }
  .twisty.empty { visibility: hidden; }
  .icon { display: inline-flex; flex: 0 0 16px; width: 16px; height: 16px; margin-right: 4px; align-items: center; justify-content: center; }
  .icon svg { width: 16px; height: 16px; overflow: visible; }
  .label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .children.collapsed { display: none; }
</style></head><body><div id="tree"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const expanded = new Set(saved.expanded || []);
  let roots = [];
  let selectedId = saved.selectedId;

  const accessColor = access => ({
    public: 'var(--vscode-charts-green, #89d185)',
    published: 'var(--vscode-charts-green, #89d185)',
    protected: 'var(--vscode-charts-yellow, #cca700)',
    'strict-protected': 'var(--vscode-charts-purple, #b180d7)',
    private: 'var(--vscode-charts-red, #f14c4c)',
    'strict-private': 'var(--vscode-charts-orange, #d18616)'
  }[access] || 'var(--vscode-icon-foreground)');

  function iconSvg(name, access) {
    const color = accessColor(access);
    const common = 'fill="none" stroke="' + color + '" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"';
    const paths = {
      references: '<path d="M3 3h4v4H3zM9 9h4v4H9zM7 5h3a2 2 0 0 1 2 2v2"/>',
      namespace: '<path d="M2 4h5l1.5 2H14v7H2z"/>',
      global: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>',
      package: '<path d="M2 5 8 2l6 3-6 3zM2 5v6l6 3 6-3V5M8 8v6"/>',
      files: '<path d="M4 2h6l3 3v9H4zM10 2v3h3M2 5v8"/>',
      tools: '<path d="M9.8 2.4a3 3 0 0 0-3.5 3.8L2.4 10a1.7 1.7 0 1 0 2.4 2.4l3.8-3.8a3 3 0 0 0 3.8-3.5l-2 2-2-2z"/>',
      properties: '<path d="M3 3h10M3 8h10M3 13h10"/><circle cx="5" cy="3" r="1" fill="' + color + '"/><circle cx="10" cy="8" r="1" fill="' + color + '"/><circle cx="7" cy="13" r="1" fill="' + color + '"/>',
      property: '<path d="M2 4h7l4 4-5 5-6-6z"/><circle cx="5" cy="7" r="1"/>',
      interface: '<circle cx="8" cy="8" r="6"/><path d="M8 5v6M6 5h4M6 11h4"/>',
      struct: '<path d="M2 3h12v10H2zM6 3v10M10 3v10M2 8h12"/>',
      class: '<path d="M3 2h10v12H3zM5 5h6M5 8h6M5 11h4"/>',
      'symbol-method': '<path d="m8 2 5.5 3v6L8 14l-5.5-3V5zM2.5 5 8 8l5.5-3M8 8v6"/>',
      'symbol-function': '<circle cx="8" cy="8" r="6"/><path d="M6 11V5h4M6 8h3"/>',
      'symbol-operator': '<circle cx="8" cy="8" r="6"/><path d="M5 6h6M8 3v6M5 11h6"/>',
      zap: '<path d="m9 1-6 8h5l-1 6 6-9H8z"/>',
      symbol: '<circle cx="8" cy="8" r="5"/>'
    };
    return '<svg viewBox="0 0 16 16" aria-hidden="true"><g ' + common + '>' + (paths[name] || paths.symbol) + '</g></svg>';
  }

  function remember() { vscode.setState({ expanded: [...expanded], selectedId }); }
  function setSelected(id, scroll) {
    selectedId = id;
    document.querySelectorAll('.row.selected').forEach(row => row.classList.remove('selected'));
    const row = id ? document.querySelector('.row[data-id="' + CSS.escape(id) + '"]') : undefined;
    if (row) {
      row.classList.add('selected');
      if (scroll) row.scrollIntoView({ block: 'nearest' });
    }
    remember();
  }

  function renderNode(node, depth) {
    const wrapper = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = node.id;
    row.style.paddingLeft = (depth * 12) + 'px';
    row.title = node.tooltip || node.label;
    const twisty = document.createElement('button');
    twisty.className = 'twisty' + (node.children.length ? '' : ' empty');
    twisty.textContent = expanded.has(node.id) ? '⌄' : '›';
    row.appendChild(twisty);
    const icon = document.createElement('span');
    icon.className = 'icon';
    icon.innerHTML = iconSvg(node.icon, node.access);
    row.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.label;
    row.appendChild(label);
    wrapper.appendChild(row);
    const children = document.createElement('div');
    children.className = 'children' + (expanded.has(node.id) ? '' : ' collapsed');
    node.children.forEach(child => children.appendChild(renderNode(child, depth + 1)));
    wrapper.appendChild(children);
    twisty.addEventListener('click', event => {
      event.stopPropagation();
      if (expanded.has(node.id)) expanded.delete(node.id); else expanded.add(node.id);
      children.classList.toggle('collapsed', !expanded.has(node.id));
      twisty.textContent = expanded.has(node.id) ? '⌄' : '›';
      remember();
    });
    row.addEventListener('click', () => {
      setSelected(node.id, false);
      if (node.jumpable) vscode.postMessage({ type: 'open', id: node.id });
    });
    return wrapper;
  }

  function render() {
    const host = document.getElementById('tree');
    host.replaceChildren();
    if (!roots.length) {
      const empty = document.createElement('div');
      empty.id = 'empty';
      empty.textContent = 'Open a Pascal/Delphi, DPK, or DPROJ file to view its structure.';
      host.appendChild(empty);
      return;
    }
    roots.forEach(node => host.appendChild(renderNode(node, 0)));
    setSelected(selectedId, false);
  }

  window.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'model') {
      roots = message.roots || [];
      selectedId = message.selectedId;
      for (const id of message.selectedPath || []) expanded.add(id);
      render();
    } else if (message.type === 'select') {
      for (const id of message.path || []) expanded.add(id);
      render();
      setSelected(message.id, true);
    }
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

function registerClassNavigator(context, output, vscodeApi, projectProvider, projectSourceIndexPromise) {
  const vscode = vscodeApi || require('vscode');
  const provider = new ClassNavigatorProvider(vscode, output, context);
  const initialConfiguration = vscode.workspace.getConfiguration('pascalUnion');
  let navigatorMode = context.workspaceState.get(NAVIGATOR_MODE_STATE_KEY, 'class');
  if (!initialConfiguration.get('classNavigator.enabled', true)
    && initialConfiguration.get('projectNavigator.enabled', true)
    && projectProvider) navigatorMode = 'project';
  if (navigatorMode === 'project'
    && (!projectProvider || !initialConfiguration.get('projectNavigator.enabled', true))) navigatorMode = 'class';
  const combinedChanged = new vscode.EventEmitter();
  const activeProvider = () => navigatorMode === 'project' && projectProvider
    ? projectProvider
    : provider;
  const tree = new ClassNavigatorWebview(vscode, 'pascalUnion.classNavigator', {
    getRoots: () => activeProvider().getChildren(),
    serializeNode: node => serializeNavigatorNode(node, {
      projectDefaultExpansion: vscode.workspace.getConfiguration('pascalUnion')
        .get('projectNavigator.defaultExpansion', 'firstLevel')
    }),
    nodePath: navigatorNodePath,
    capabilities: () => ({
      aiSteps: vscode.workspace.getConfiguration('pascalUnion').get('classNavigator.aiSteps.enabled', true),
      aiGenerating: Boolean(activeAiCancellation),
      projectContextMenus: vscode.workspace.getConfiguration('pascalUnion')
        .get('projectNavigator.contextMenus.enabled', true)
    }),
    onOpen: node => navigatorMode === 'project' && node.kind === 'file'
      ? vscode.commands.executeCommand('vscode.open', vscode.Uri.file(node.filePath))
      : openNode(node),
    onSearch: message => performNavigatorSearch(message),
    onSearchOptions: options => saveNavigatorSearchOptions(options),
    onSearchActivate: message => activateNavigatorSearchResult(message),
    onSearchClosed: restoreState => closeNavigatorSearch(true, restoreState),
    onSortUpdate: async message => {
      const allowed = {
        memberOrder: ['visibility', 'declaration', 'implementation'],
        typeOrder: ['declaration', 'alphabetical']
      };
      if (!allowed[message.key]?.includes(message.value)) return;
      await vscode.workspace.getConfiguration('pascalUnion.classNavigator')
        .update(message.key, message.value, true);
    },
    onFocusChanged: focused => vscode.commands.executeCommand(
      'setContext',
      'pascalUnion.classNavigator.webviewFocused',
      Boolean(focused)
    )
  });
  const webviewRegistration = tree.register(context);
  void vscode.commands.executeCommand(
    'setContext',
    'pascalUnion.classNavigator.webviewFocused',
    false
  );
  const navigationRangeDecoration = vscode.window.createTextEditorDecorationType({
    // VS Code has no public per-line-number background decoration. A narrow
    // continuous marker in the glyph/line-number gutter is the closest native
    // rendering that never paints over the source text itself.
    gutterIconPath: vscode.Uri.file(context.asAbsolutePath('media/ai-step-range.svg')),
    gutterIconSize: 'contain'
  });
  let refreshTimer;
  let followTimer;
  let layoutTimer;
  let layoutPending = false;
  let navigationLock;
  let navigationHoldUntil = 0;
  let navigatorVisible = tree.visible;
  let activeNavigationHighlight;
  let activeAiCancellation;
  const setAiGeneratingContext = value => {
    void tree.updateCapabilities();
    return vscode.commands.executeCommand(
      'setContext',
      'pascalUnion.classNavigator.aiGenerating',
      Boolean(value)
    );
  };
  const beginAiOperation = () => {
    if (activeAiCancellation) return undefined;
    activeAiCancellation = new vscode.CancellationTokenSource();
    void setAiGeneratingContext(true);
    return activeAiCancellation;
  };
  const finishAiOperation = source => {
    if (activeAiCancellation !== source) return;
    activeAiCancellation = undefined;
    source.dispose();
    void setAiGeneratingContext(false);
  };
  const stopAiGeneration = () => {
    if (!activeAiCancellation) {
      void vscode.window.showInformationMessage('There is no AI step-generation task running.');
      return;
    }
    activeAiCancellation.cancel();
    void vscode.window.setStatusBarMessage('$(stop-circle) Stopping AI step generation…', 2000);
  };
  const savedExpandedRoutines = context.workspaceState.get(EXPANDED_ROUTINES_STATE_KEY, {});
  const expandedRoutineIdsByDocument = new Map(
    Object.entries(savedExpandedRoutines && typeof savedExpandedRoutines === 'object'
      ? savedExpandedRoutines
      : {}).map(([uri, ids]) => [uri, new Set(Array.isArray(ids) ? ids : [])])
  );
  const expandedRoutineIds = documentUri => {
    const uri = documentUri || provider.activeDocument()?.uri.toString();
    if (!uri) return new Set();
    if (!expandedRoutineIdsByDocument.has(uri)) expandedRoutineIdsByDocument.set(uri, new Set());
    return expandedRoutineIdsByDocument.get(uri);
  };
  const persistExpandedRoutines = () => {
    void context.workspaceState.update(
      EXPANDED_ROUTINES_STATE_KEY,
      Object.fromEntries([...expandedRoutineIdsByDocument]
        .map(([uri, ids]) => [uri, [...ids]]))
    );
  };
  // Returning the saved state through TreeItem.collapsibleState lets VS Code
  // reconstruct the previous shape without reveal(), selection changes, or
  // opening a navigator view that the user deliberately collapsed.
  provider.isNodeExpanded = (node, documentUri) =>
    Boolean(node?.children?.length && expandedRoutineIds(documentUri).has(node.id));

  const clearNavigationHighlight = () => {
    const editor = activeNavigationHighlight?.editor;
    if (editor && !editor.document.isClosed) editor.setDecorations(navigationRangeDecoration, []);
    activeNavigationHighlight = undefined;
  };
  const showNavigationHighlight = (editor, node, focusOffset) => {
    clearNavigationHighlight();
    if (!editor || !node) return;
    const config = vscode.workspace.getConfiguration('pascalUnion', editor.document.uri);
    if (!config.get('classNavigator.highlightRange.enabled', true)) return;
    const text = editor.document.getText();
    const highlightNode = highlightNodeForExpandedSteps(
      text,
      node,
      focusOffset,
      expandedRoutineIds()
    );
    if (highlightNode.kind === 'ai-step'
      && !config.get('classNavigator.aiSteps.highlightRange', true)) return;
    const offsetRanges = nodeSourceRanges(text, highlightNode, focusOffset);
    if (offsetRanges.length === 0) return;
    const lineRanges = offsetRanges.map(([startOffset, endOffset]) => {
      const startLine = editor.document.positionAt(startOffset).line;
      const endLine = editor.document.positionAt(
        Math.max(startOffset, Math.min(text.length, endOffset) - 1)
      ).line;
      return { startLine, endLine: Math.max(startLine, endLine) };
    });
    const decorations = [];
    for (const lineRange of lineRanges) {
      for (let line = lineRange.startLine; line <= lineRange.endLine; line += 1) {
        const position = new vscode.Position(line, 0);
        decorations.push(new vscode.Range(position, position));
      }
    }
    editor.setDecorations(navigationRangeDecoration, decorations);
    activeNavigationHighlight = {
      editor,
      documentUri: editor.document.uri.toString(),
      nodeId: highlightNode.id,
      focusOffset,
      lineRanges
    };
  };
  const refreshHighlightForRoutineExpansion = routine => {
    const highlight = activeNavigationHighlight;
    const editor = vscode.window.activeTextEditor;
    if (!routine || !highlight || !editor || highlight.documentUri !== editor.document.uri.toString()
      || !Number.isInteger(highlight.focusOffset)) return;
    const activeNode = activeNodeAt(provider.model(), highlight.focusOffset);
    if (provider.routineForNode(activeNode)?.id !== routine.id) return;
    showNavigationHighlight(editor, activeNode, highlight.focusOffset);
  };
  const clearNavigationHighlightOutsideCursor = editor => {
    const highlight = activeNavigationHighlight;
    if (!highlight) return;
    if (highlight.editor !== editor) {
      clearNavigationHighlight();
      return;
    }
    const line = editor.selection.active.line;
    if (!highlight.lineRanges.some(range => line >= range.startLine && line <= range.endLine)) {
      clearNavigationHighlight();
    }
  };
  const clearNavigationHighlightOutsideViewport = event => {
    const highlight = activeNavigationHighlight;
    if (!highlight) return;
    if (highlight.editor !== event.textEditor) return;
    const intersects = event.visibleRanges.some(visible => highlight.lineRanges.some(range =>
      visible.end.line >= range.startLine && visible.start.line <= range.endLine));
    if (!intersects) clearNavigationHighlight();
  };

  const updatePresentation = () => {
    if (navigatorMode === 'project') {
      tree.description = 'Project / Package';
      tree.message = projectProvider?.roots?.length
        ? undefined
        : 'No Delphi Project Group or project was detected in the current workspace.';
      return;
    }
    const document = provider.activeDocument();
    tree.description = document ? path.basename(document.fileName) : undefined;
    tree.message = document ? undefined : 'Open a Pascal/Delphi, DPK, or DPROJ file to view its structure.';
  };
  const followEnabled = () => {
    const config = vscode.workspace.getConfiguration('pascalUnion');
    return config.get('enabled', true)
      && config.get('classNavigator.enabled', true)
      && config.get('classNavigator.followCursor', true);
  };
  const pauseWhileCollapsed = () => vscode.workspace.getConfiguration('pascalUnion')
    .get('classNavigator.pauseWhenCollapsed', true);
  const navigatorCanTrack = () => navigatorMode === 'class' && followEnabled()
    && (!pauseWhileCollapsed() || navigatorVisible);
  const revealFollowNode = node => {
    if (!node) return;
    if (pauseWhileCollapsed() && !navigatorVisible) return;
    const changed = provider.setActiveNode(node);
    if (!changed) return;
    // The resolved follow node is already the nearest visible node according
    // to the user's expansion state. Selecting it must never expand the node:
    // a collapsed routine stays selected as a routine, and a collapsed parent
    // step stays selected instead of exposing its generated substeps.
    void tree.reveal(node, { select: true, focus: false, expand: false }).catch(() => undefined);
  };
  const visibleCenterOffset = (editor, visibleRanges) => {
    if (!visibleRanges?.length) return undefined;
    const range = visibleRanges.reduce((largest, candidate) =>
      candidate.end.line - candidate.start.line > largest.end.line - largest.start.line
        ? candidate
        : largest);
    const configuredOffset = vscode.workspace.getConfiguration('pascalUnion', editor.document.uri)
      .get('classNavigator.scrollFollowOffsetLines', 1);
    const line = Math.min(
      editor.document.lineCount - 1,
      viewportFollowLine(range.start.line, range.end.line, configuredOffset)
    );
    return editor.document.offsetAt(new vscode.Position(line, 0));
  };
  const applyFollow = (reason = 'cursor', event) => {
    if (!navigatorCanTrack()) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isClassNavigatorDocument(editor.document)) return;

    let offset;
    if (reason === 'scroll') {
      if (Date.now() < navigationHoldUntil) return;
      const ranges = event?.textEditor === editor ? event.visibleRanges : editor.visibleRanges;
      // Every real scroll follows the symbol at the viewport centre. A short
      // post-click guard filters only the scroll generated by the jump itself.
      offset = visibleCenterOffset(editor, ranges);
    } else {
      if (navigationLock && reason !== 'mouse') return;
      offset = editor.document.offsetAt(editor.selection.active);
    }
    if (!Number.isInteger(offset)) return;
    const node = activeFollowNodeAt(
      editor.document.getText(),
      provider.model(),
      offset,
      expandedRoutineIds()
    );
    // Blank sections and declarations intentionally retain the previous item.
    if (!node) {
      clearNavigationHighlight();
      return;
    }
    if (reason === 'mouse' || reason === 'scroll') navigationLock = undefined;
    revealFollowNode(node);
    showNavigationHighlight(editor, node, offset);
  };
  const scheduleFollow = (reason = 'cursor', event) => {
    if (followTimer) clearTimeout(followTimer);
    followTimer = undefined;
    if (!navigatorCanTrack()) return;
    const config = vscode.workspace.getConfiguration('pascalUnion');
    const delay = reason === 'scroll'
      ? config.get('classNavigator.scrollFollowDelayMs', 0)
      : 0;
    if (delay <= 0) {
      // Opening a file and the default zero-delay scroll path should update in
      // this event turn instead of waiting behind another timer queue.
      applyFollow(reason, event);
      return;
    }
    followTimer = setTimeout(() => {
      followTimer = undefined;
      applyFollow(reason, event);
    }, Math.max(0, delay));
  };
  const refresh = (followReason = 'cursor', immediate = false) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    const applyRefresh = () => {
      refreshTimer = undefined;
      updatePresentation();
      if (navigatorMode === 'project') {
        projectProvider?.refresh();
        combinedChanged.fire(undefined);
        return;
      }
      scheduleDefaultLayout();
      if (pauseWhileCollapsed() && !navigatorVisible) return;
      provider.model();
      provider.refresh();
      scheduleFollow(followReason);
    };
    if (immediate) {
      applyRefresh();
      return;
    }
    refreshTimer = setTimeout(applyRefresh, 80);
  };
  const initializeDefaultLayout = async () => {
    if (layoutPending
      || navigatorMode !== 'class'
      || context.workspaceState.get(EXPLORER_LAYOUT_STATE_KEY, 0) >= EXPLORER_LAYOUT_VERSION) return;
    const config = vscode.workspace.getConfiguration('pascalUnion');
    const editor = vscode.window.activeTextEditor;
    if (!config.get('enabled', true)
      || !config.get('classNavigator.enabled', true)
      || !config.get('classNavigator.defaultOpenBelowExplorer', true)
      || !editor
      || !isClassNavigatorDocument(editor.document)) return;

    layoutPending = true;
    try {
      const commands = new Set(await vscode.commands.getCommands(true));
      const selection = editor.selection;
      const viewColumn = editor.viewColumn;
      output?.appendLine('Opening Delphi class navigator for initial Explorer layout.');
      const firstNode = provider.model()?.roots?.[0];
      if (!firstNode) return;
      await tree.reveal(firstNode, { select: false, focus: true, expand: false });
      // VS Code 1.134 always initializes contributed Explorer views collapsed
      // and provides no manifest order for the built-in Explorer container.
      // On the user's normal Explorer/Outline/Timeline layout, two moves place
      // this view immediately after the file tree and before Outline.
      if (commands.has('views.moveViewUp')) {
        await vscode.commands.executeCommand('views.moveViewUp');
        await vscode.commands.executeCommand('views.moveViewUp');
      }
      await context.workspaceState.update(EXPLORER_LAYOUT_STATE_KEY, EXPLORER_LAYOUT_VERSION);
      await vscode.window.showTextDocument(editor.document, {
        viewColumn,
        preview: false,
        preserveFocus: false,
        selection
      });
      output?.appendLine('Initialized Delphi class navigator below the Explorer file tree.');
    } catch (error) {
      output?.appendLine(`Explorer class navigator layout initialization skipped: ${error.message}`);
    } finally {
      layoutPending = false;
    }
  };
  const scheduleDefaultLayout = () => {
    if (layoutTimer
      || context.workspaceState.get(EXPLORER_LAYOUT_STATE_KEY, 0) >= EXPLORER_LAYOUT_VERSION) return;
    layoutTimer = setTimeout(() => {
      layoutTimer = undefined;
      void initializeDefaultLayout();
    }, 700);
  };

  const setNavigatorMode = async mode => {
    const configuration = vscode.workspace.getConfiguration('pascalUnion');
    const next = mode === 'project'
      && projectProvider
      && configuration.get('projectNavigator.enabled', true)
      ? 'project'
      : 'class';
    if (navigatorMode === next) return;
    navigatorMode = next;
    clearNavigationHighlight();
    if (followTimer) clearTimeout(followTimer);
    followTimer = undefined;
    await context.workspaceState.update(NAVIGATOR_MODE_STATE_KEY, navigatorMode);
    await vscode.commands.executeCommand('setContext', 'pascalUnion.navigator.mode', navigatorMode);
    updatePresentation();
    activeProvider().refresh?.();
    tree.setMode(navigatorMode);
    combinedChanged.fire(undefined);
    if (navigatorMode === 'class') scheduleFollow('cursor');
  };

  const openNode = async (node, options = {}) => {
    const document = provider.activeDocument();
    if (!document || !node) return;
    const offset = node.kind === 'routine'
      ? node.implementationOffset ?? node.declarationOffset
      : node.offset ?? node.declarationOffset;
    if (!Number.isInteger(offset)) return;
    provider.setActiveNode(node);
    navigationLock = {
      documentUri: document.uri.toString(),
      nodeId: node.id
    };
    const holdMs = vscode.workspace.getConfiguration('pascalUnion')
      .get('classNavigator.navigationClickHoldMs', 120);
    navigationHoldUntil = Date.now() + Math.max(0, holdMs);
    const position = document.positionAt(Math.min(offset, document.getText().length));
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      // Match Explorer's single-click navigation: reveal the destination while
      // keeping focus on the tree. The native active selection therefore stays
      // blue instead of flashing blue and immediately turning inactive gray.
      preserveFocus: options.preserveFocus ?? vscode.workspace.getConfiguration('pascalUnion')
        .get('classNavigator.keepFocusOnNavigationClick', true),
      selection: new vscode.Range(position, position)
    });
    const revealConfig = vscode.workspace.getConfiguration('pascalUnion');
    const revealMode = revealConfig.get('classNavigator.navigationReveal.mode', 'smart');
    const sourceRange = nodeSourceRanges(document.getText(), node, offset)[0];
    if (sourceRange) {
      const startPosition = document.positionAt(sourceRange[0]);
      const inclusiveEndOffset = Math.max(sourceRange[0], Math.min(
        document.getText().length,
        sourceRange[1]
      ) - 1);
      const endPosition = document.positionAt(inclusiveEndOffset);
      const largestVisibleRange = editor.visibleRanges.reduce((largest, range) => {
        const lineCount = range.end.line - range.start.line + 1;
        const largestCount = largest ? largest.end.line - largest.start.line + 1 : 0;
        return lineCount > largestCount ? range : largest;
      }, undefined);
      const visibleLineCount = largestVisibleRange
        ? largestVisibleRange.end.line - largestVisibleRange.start.line + 1
        : 1;
      const plan = navigationRevealPlan(
        startPosition.line,
        endPosition.line,
        visibleLineCount,
        revealMode,
        revealConfig.get('classNavigator.navigationReveal.largeBlockStartPercent', 25)
      );
      const fullSourceRange = new vscode.Range(startPosition, document.positionAt(sourceRange[1]));
      if (plan.kind === 'center') {
        editor.revealRange(fullSourceRange, vscode.TextEditorRevealType.InCenter);
      } else if (plan.kind === 'top') {
        editor.revealRange(fullSourceRange, vscode.TextEditorRevealType.AtTop);
      } else if (plan.kind === 'anchor') {
        const anchor = new vscode.Position(plan.anchorLine, 0);
        editor.revealRange(new vscode.Range(anchor, anchor), vscode.TextEditorRevealType.AtTop);
      } else {
        editor.revealRange(fullSourceRange, vscode.TextEditorRevealType.Default);
      }
    }
    showNavigationHighlight(editor, node, offset);
  };

  let navigatorSearchOptions = normalizeNavigatorSearchOptions(
    context.workspaceState.get(SEARCH_OPTIONS_STATE_KEY, {})
  );
  let navigatorSearchSession;
  let navigatorSearchRequest = 0;
  let navigatorSearchActivation = 0;
  let navigatorSearchResults = new Map();

  const saveNavigatorSearchOptions = options => {
    navigatorSearchOptions = normalizeNavigatorSearchOptions(options);
    void context.workspaceState.update(SEARCH_OPTIONS_STATE_KEY, navigatorSearchOptions);
  };

  const restoreNavigatorSearchSession = async (session, restoreState, activation) => {
    try {
      const editor = await vscode.window.showTextDocument(session.document, {
        viewColumn: session.viewColumn,
        preview: false,
        preserveFocus: true,
        selection: session.selection
      });
      if (activation !== navigatorSearchActivation) return;
      const model = await provider.readyModel(session.document);
      if (activation !== navigatorSearchActivation) return;

      const selectedNode = navigatorNodeById(model, session.selectedNodeId);
      provider.activeState = session.activeState ? { ...session.activeState } : undefined;
      navigationLock = session.navigationLock ? { ...session.navigationLock } : undefined;
      navigationHoldUntil = session.navigationHoldUntil;

      if (session.viewportStart) {
        const viewportAnchor = new vscode.Range(session.viewportStart, session.viewportStart);
        editor.revealRange(viewportAnchor, vscode.TextEditorRevealType.AtTop);
      }
      await tree.restoreSearchState(selectedNode, restoreState);
      if (activation !== navigatorSearchActivation) return;

      const highlightedNode = navigatorNodeById(model, session.highlight?.nodeId);
      if (highlightedNode && Number.isInteger(session.highlight?.focusOffset)) {
        showNavigationHighlight(editor, highlightedNode, session.highlight.focusOffset);
      } else {
        clearNavigationHighlight();
      }
    } catch (error) {
      output?.appendLine(`Delphi navigator search restore failed: ${error.stack || error.message}`);
    }
  };

  const closeNavigatorSearch = (restore = false, restoreState) => {
    const session = navigatorSearchSession;
    navigatorSearchRequest += 1;
    const activation = ++navigatorSearchActivation;
    navigatorSearchSession = undefined;
    navigatorSearchResults.clear();
    tree.searchClosed();
    if (restore && session) void restoreNavigatorSearchSession(session, restoreState, activation);
  };

  const serializeSearchResult = result => ({
    id: result.id,
    kind: result.kind,
    label: result.label,
    description: result.description,
    tooltip: result.tooltip,
    icon: result.icon,
    access: result.access,
    isCurrentFile: result.isCurrentFile
  });

  const performNavigatorSearch = async message => {
    const session = navigatorSearchSession;
    if (!session) return;
    const generation = ++navigatorSearchRequest;
    const options = normalizeNavigatorSearchOptions(message.options);
    saveNavigatorSearchOptions(options);
    try {
      let results = navigatorSearchResultsForModel(
        session.model,
        session.filePath,
        message.query,
        options
      );
      if (options.scope === 'global') {
        if (!projectSourceIndexPromise) {
          navigatorSearchResults = new Map(results.map(result => [result.id, result]));
          await tree.postSearchResults(
            message.requestId,
            results.map(serializeSearchResult),
            'The global source index is not available yet; showing results from this file only.'
          );
          return;
        }
        const sourceIndex = await projectSourceIndexPromise;
        if (generation !== navigatorSearchRequest || navigatorSearchSession !== session) return;
        const globalResults = navigatorSearchResultsForIndex(
          sourceIndex,
          message.query,
          options,
          session.filePath
        ).filter(result => !result.isCurrentFile);
        if (options.files) {
          const accepts = navigatorSearchPattern(message.query);
          const workspaceFiles = await vscode.workspace.findFiles(
            '**/*.{pas,pp,dpr,dpk,inc,dproj,groupproj}',
            '**/{.git,.hg,.svn,node_modules}/**',
            20000
          );
          if (generation !== navigatorSearchRequest || navigatorSearchSession !== session) return;
          for (const uri of workspaceFiles) {
            const filePath = uri.fsPath;
            const fileName = path.basename(filePath);
            const isCurrentFile = path.resolve(filePath).toLocaleLowerCase()
              === path.resolve(session.filePath).toLocaleLowerCase();
            if (isCurrentFile || !accepts?.(fileName.toLocaleLowerCase())) continue;
            globalResults.push({
              id: navigatorSearchResultId('file', filePath, 0, fileName),
              kind: 'file', label: fileName, description: path.dirname(filePath),
              tooltip: filePath, icon: 'file', filePath, offset: 0, isCurrentFile: false
            });
          }
        }
        results = [...new Map([...results, ...globalResults]
          .map(result => [result.id, result])).values()].slice(0, 500);
      }
      if (generation !== navigatorSearchRequest || navigatorSearchSession !== session) return;
      navigatorSearchResults = new Map(results.map(result => [result.id, result]));
      const status = results.length >= 500 ? 'Showing the first 500 matches' : undefined;
      await tree.postSearchResults(message.requestId, results.map(serializeSearchResult), status);
    } catch (error) {
      if (generation !== navigatorSearchRequest || navigatorSearchSession !== session) return;
      output?.appendLine(`Delphi navigator global search failed: ${error.stack || error.message}`);
      await tree.postSearchResults(message.requestId, [], `Global search failed: ${error.message}`);
    }
  };

  const activateNavigatorSearchResult = async message => {
    const result = navigatorSearchResults.get(message.id);
    const session = navigatorSearchSession;
    if (!result || !session) return;
    const activation = ++navigatorSearchActivation;
    try {
      const sameAsOrigin = path.resolve(result.filePath).toLocaleLowerCase()
        === path.resolve(session.filePath).toLocaleLowerCase();
      const document = sameAsOrigin
        ? session.document
        : await vscode.workspace.openTextDocument(vscode.Uri.file(result.filePath));
      if (activation !== navigatorSearchActivation) return;
      const offset = Math.max(0, Math.min(document.getText().length, result.offset || 0));
      const position = document.positionAt(offset);
      navigationLock = { documentUri: document.uri.toString(), nodeId: result.node?.id || result.id };
      const holdMs = vscode.workspace.getConfiguration('pascalUnion')
        .get('classNavigator.navigationClickHoldMs', 120);
      navigationHoldUntil = Date.now() + Math.max(0, holdMs);
      const editor = await vscode.window.showTextDocument(document, {
        preview: false,
        preserveFocus: Boolean(message.preview),
        selection: new vscode.Range(position, position)
      });
      if (activation !== navigatorSearchActivation) return;
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      let targetNode = result.node;
      if (!targetNode && isClassNavigatorDocument(document)
        && ['type', 'routine'].includes(result.kind)) {
        const targetModel = await provider.readyModel(document);
        if (activation !== navigatorSearchActivation) return;
        targetNode = navigatorNodeForSearchResult(targetModel, result);
      }
      if (targetNode) {
        provider.setActiveNode(targetNode);
        await tree.reveal(targetNode, { select: true, focus: false, expand: false });
        showNavigationHighlight(editor, targetNode, offset);
      } else if (isClassNavigatorDocument(document)) {
        refresh('cursor', true);
      }
      if (!message.preview) {
        await tree.finishSearch();
        closeNavigatorSearch();
      }
    } catch (error) {
      output?.appendLine(`Delphi navigator search navigation failed: ${error.stack || error.message}`);
      void vscode.window.showErrorMessage(`Could not open search result: ${error.message}`);
    }
  };

  const showNavigatorSearch = async () => {
    await setNavigatorMode('class');
    if (navigatorSearchSession) {
      await tree.hideSearch();
      return;
    }
    const document = provider.activeDocument();
    if (!document) {
      void vscode.window.showInformationMessage('Open a Pascal/Delphi source file first.');
      return;
    }
    const model = await provider.readyModel(document);
    if (!model) return;
    navigatorSearchRequest += 1;
    navigatorSearchActivation += 1;
    const editor = vscode.window.activeTextEditor;
    navigatorSearchSession = {
      document,
      filePath: document.fileName,
      model,
      viewColumn: editor?.viewColumn,
      selection: editor?.selection,
      viewportStart: editor?.visibleRanges?.[0]?.start,
      selectedNodeId: tree.selection?.[0]?.id,
      activeState: provider.activeState ? { ...provider.activeState } : undefined,
      navigationLock: navigationLock ? { ...navigationLock } : undefined,
      navigationHoldUntil,
      highlight: activeNavigationHighlight
        ? { nodeId: activeNavigationHighlight.nodeId, focusOffset: activeNavigationHighlight.focusOffset }
        : undefined
    };
    navigatorSearchResults.clear();
    try {
      await vscode.commands.executeCommand('pascalUnion.classNavigator.focus');
    } catch {}
    tree.showSearch(navigatorSearchOptions);
  };

  const selectAiChatModel = async settings => {
    if (!vscode.lm?.selectChatModels || !vscode.LanguageModelChatMessage?.User) {
      throw new Error('This version of VS Code does not support the Language Model API.');
    }
    const models = await vscode.lm.selectChatModels({ vendor: settings.provider });
    if (!models.length) {
      throw new Error(
        `No ${settings.provider} models were found. Make sure OAI Compatible Copilot is enabled and a model is configured.`
      );
    }
    const chatModel = settings.modelId
      ? models.find(candidate => candidate.id === settings.modelId
        || candidate.name === settings.modelId)
      : models[0];
    if (!chatModel) {
      throw new Error(`Configured model "${settings.modelId}" was not found. Change the model ID in AI Routine Steps settings.`);
    }
    return chatModel;
  };

  const sendAiStepRequest = async (request, chatModel, token, justification) => {
    const messages = [vscode.LanguageModelChatMessage.User(request.analysis.prompt)];
    const requestOptions = { justification };
    if (request.settings.reasoningEffort && request.settings.reasoningEffort !== 'auto') {
      requestOptions.modelConfiguration = {
        reasoningEffort: request.settings.reasoningEffort
      };
    }
    const timeoutSeconds = Math.max(15, Math.min(
      600,
      Number(request.settings.requestTimeoutSeconds) || 180
    ));
    const requestCancellation = new vscode.CancellationTokenSource();
    let timedOut = false;
    const outerCancellation = token.onCancellationRequested(() => requestCancellation.cancel());
    const timeout = setTimeout(() => {
      timedOut = true;
      requestCancellation.cancel();
    }, timeoutSeconds * 1000);
    let responseText = '';
    let reportedLabels = 0;
    try {
      const response = await chatModel.sendRequest(
        messages,
        requestOptions,
        requestCancellation.token
      );
      for await (const fragment of response.text) {
        if (requestCancellation.token.isCancellationRequested) break;
        responseText += fragment;
        if (request.analysis.fixedPlan && responseText.includes('}')) {
          const partial = parseAiStepResponseResult(
            responseText,
            request.analysis,
            request.analysis
          );
          if (partial.validLabelCount > reportedLabels) {
            reportedLabels = partial.validLabelCount;
            request.onPartial?.(partial.steps, partial);
          }
        }
      }
      if (timedOut) throw new Error(`The model request exceeded ${timeoutSeconds} seconds. Waiting has stopped.`);
      if (token.isCancellationRequested) return { steps: [], responseLength: responseText.length };
      return {
        ...parseAiStepResponseResult(responseText, request.analysis, request.analysis),
        responseLength: responseText.length
      };
    } catch (error) {
      if (timedOut) throw new Error(`The model request exceeded ${timeoutSeconds} seconds. Waiting has stopped.`);
      throw error;
    } finally {
      clearTimeout(timeout);
      outerCancellation.dispose();
      requestCancellation.dispose();
    }
  };

  const requestAiStepResponse = async (request, chatModel, token, justification) => {
    const first = await sendAiStepRequest(request, chatModel, token, justification);
    if (first.planned) {
      if (token.isCancellationRequested || first.validLabelCount === 0) return [];
      if (!first.missingIds.length) return first.steps;
      const repairPrompt = buildAiStepRepairPrompt(request.analysis, first.missingIds);
      if (!repairPrompt) return first.steps;
      output?.appendLine(
        `AI response for ${request.routine.label} omitted ${first.missingIds.length} fixed block label(s); `
        + 'requesting only the missing labels.'
      );
      const repairAnalysis = { ...request.analysis, prompt: repairPrompt };
      const repair = await sendAiStepRequest(
        { ...request, analysis: repairAnalysis, onPartial: undefined },
        chatModel,
        token,
        `${justification} Fill in only the fixed code-block titles omitted from the previous response.`
      );
      if (token.isCancellationRequested) return [];
      const merged = mergeAiStepResponseResults(request.analysis, first, repair);
      if (merged.missingIds.length) {
        output?.appendLine(
          `AI repair for ${request.routine.label} still omitted ${merged.missingIds.length} label(s); `
          + 'kept deterministic local labels for those blocks.'
        );
      }
      return merged.steps;
    }
    const needsJsonRetry = first.steps.length === 0;
    if (token.isCancellationRequested || !needsJsonRetry) return first.steps;

    const minimalFallback = request.settings.reasoningEffort === 'minimal';
    if (!minimalFallback && request.analysis.granularity !== 'detailed') return first.steps;

    // A few OpenAI-compatible GLM gateways accept `minimal` but occasionally
    // return no normal text. Retry that fast-path failure once with `low` for
    // both normal and detailed generation. Other detailed parse failures keep
    // the existing single bounded-schema retry.
    const retryEffort = aiRetryReasoningEffort(request.settings.reasoningEffort);
    output?.appendLine(
      `AI response for ${request.routine.label} contained no usable steps `
      + `(${first.responseLength} characters); retrying once`
      + (minimalFallback ? ` with reasoning effort ${retryEffort}.` : ' with a bounded detailed schema.')
    );
    const retrySettings = {
      ...request.settings,
      reasoningEffort: retryEffort,
      ...(request.analysis.granularity === 'detailed' ? {
        granularity: 'detailed',
        maxSteps: Math.min(10, Number(request.settings.maxSteps) || 10),
        maxSubsteps: Math.min(6, Number(request.settings.maxSubsteps) || 6),
        maxDepth: Math.min(3, Number(request.settings.maxDepth) || 3),
        substepMinParentLines: Math.max(20, Number(request.settings.substepMinParentLines) || 20)
      } : {})
    };
    const retryAnalysis = request.analysis.granularity === 'detailed'
      ? buildAiStepPrompt(request.text, request.routine, retrySettings)
      : { ...request.analysis };
    if (!retryAnalysis) return [];
    retryAnalysis.prompt += '\nThe previous response was not valid JSON. Return exactly one complete JSON object and use the actual line numbers in brackets.';
    const retry = await sendAiStepRequest(
      { ...request, settings: retrySettings, analysis: retryAnalysis },
      chatModel,
      token,
      `${justification} The previous response could not be parsed. Retrying once with a compatibility prompt.`
    );
    if (!retry.steps.length && !token.isCancellationRequested) {
      output?.appendLine(
        `AI retry for ${request.routine.label} still contained no usable steps `
        + `(${retry.responseLength} characters, reasoning effort ${retryEffort}).`
      );
    }
    return retry.steps;
  };

  const aiSettingsForMode = (document, generationMode = 'normal') => {
    const baseSettings = provider.aiConfiguration(document);
    const detailed = generationMode === 'detailed';
    return {
      ...baseSettings,
      // Both context-menu actions support recursive functional blocks. The
      // detailed action raises the depth/density budget without changing the
      // user's normal-generation defaults.
      substepsEnabled: baseSettings.substepsEnabled !== false,
      maxDepth: detailed ? Math.max(3, baseSettings.maxDepth) : Math.max(3, baseSettings.maxDepth),
      granularity: detailed ? 'detailed' : baseSettings.granularity,
      targetLinesPerStep: detailed
        ? baseSettings.detailedTargetLines
        : baseSettings.normalTargetLines,
      maxSteps: detailed ? Math.max(8, baseSettings.maxSteps) : baseSettings.maxSteps,
      maxSubsteps: detailed ? Math.max(6, baseSettings.maxSubsteps) : baseSettings.maxSubsteps,
      substepMinParentLines: detailed
        ? Math.max(12, baseSettings.detailedTargetLines * 2)
        : baseSettings.substepMinParentLines
    };
  };

  const generateAiSteps = async (requestedNode, generationMode = 'normal') => {
    const document = provider.activeDocument();
    if (!document) {
      void vscode.window.showInformationMessage('Open a Pascal/Delphi source file first.');
      return;
    }
    const detailed = generationMode === 'detailed';
    const settings = aiSettingsForMode(document, generationMode);
    if (!settings.enabled) {
      void vscode.window.showInformationMessage('Enable "AI Routine Steps" in Pascal Union settings first.');
      return;
    }
    const model = provider.model();
    const selected = tree.selection?.[0];
    const caretOffset = document.offsetAt(vscode.window.activeTextEditor?.selection.active
      || new vscode.Position(0, 0));
    const routine = provider.routineForNode(requestedNode)
      || provider.routineForNode(selected)
      || provider.routineForNode(activeNodeAt(model, caretOffset));
    const request = provider.aiRequestFor(routine, document, document.getText(), settings);
    if (!request) {
      void vscode.window.showInformationMessage('Place the cursor in a routine with an implementation, or select the routine in the navigator.');
      return;
    }
    if (request.reusedChunkCache) {
      provider.refreshAiRoutine(request);
      void vscode.window.showInformationMessage('AI steps were restored from the unchanged code-block cache.');
      return;
    }
    if (!vscode.lm?.selectChatModels || !vscode.LanguageModelChatMessage?.User) {
      void vscode.window.showErrorMessage('This version of VS Code does not support the Language Model API.');
      return;
    }
    const operation = beginAiOperation();
    if (!operation) {
      void vscode.window.showInformationMessage('An AI step-generation task is already running. Click Stop first.');
      return;
    }
    let completed = false;
    try {
      // The toolbar click is an explicit user action, so VS Code can safely show
      // the provider consent/authentication UI on the first model request.
      const chatModel = await selectAiChatModel(settings);
      if (operation.token.isCancellationRequested) return;
      try {
        await tree.reveal(request.routine, { select: false, focus: false, expand: true });
      } catch {
        // A simultaneous document refresh can replace the node instance. The
        // stable TreeItem id still preserves expansion when the result arrives.
      }
      provider.beginAiGeneration(request, { refresh: false });
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Generating ${detailed ? 'detailed ' : ''}steps for ${request.routine.label}`,
        cancellable: true
      }, async (_progress, progressToken) => {
        const cancellation = progressToken.onCancellationRequested(() => operation.cancel());
        try {
          const steps = await requestAiStepResponse(
            {
              ...request,
              onPartial: partialSteps => provider.updateAiGeneration(request, partialSteps)
            },
            chatModel,
            operation.token,
            detailed
              ? 'Generate fine-grained, recursively expandable, clickable English navigation steps for the Delphi routine selected by the user.'
              : 'Generate recursively expandable, clickable English navigation steps for the Delphi routine selected by the user.'
          );
          if (operation.token.isCancellationRequested) return;
          if (!steps.length) throw new Error('The model returned no navigable steps. Retry or choose another model.');
          await provider.completeAiGeneration(request, steps, chatModel);
          completed = true;
          output?.appendLine(
            `Generated ${steps.length} AI navigation step(s) for ${request.routine.label} `
            + `with ${settings.provider}/${chatModel.id} (${generationMode}).`
          );
        } finally {
          cancellation.dispose();
        }
      });
    } catch (error) {
      const cancelled = operation.token.isCancellationRequested
        || /cancel/i.test(error?.code || '') || /cancel/i.test(error?.message || '');
      if (!cancelled) {
        output?.appendLine(`AI function step generation failed: ${error.stack || error.message}`);
        void vscode.window.showErrorMessage(`AI routine step generation failed: ${error.message}`);
      }
    } finally {
      if (!completed) provider.failAiGeneration(request);
      finishAiOperation(operation);
    }
  };

  const generateClassAiSteps = async (requestedNode, generationMode = 'normal') => {
    const document = provider.activeDocument();
    if (!document || !/\.(?:pas|pp)$/i.test(document.fileName)) {
      void vscode.window.showInformationMessage('Open a .pas or .pp source file first.');
      return;
    }
    const settings = aiSettingsForMode(document, generationMode);
    if (!settings.enabled) {
      void vscode.window.showInformationMessage('Enable "AI Routine Steps" in Pascal Union settings first.');
      return;
    }
    if (requestedNode?.kind !== 'type') return;
    if (activeAiCancellation) {
      void vscode.window.showInformationMessage('An AI step-generation task is already running. Click Stop first.');
      return;
    }

    if (!await provider.readyModel(document)) return;
    const text = document.getText();
    const startingVersion = document.version;
    const descendants = [];
    const visit = node => {
      for (const child of node?.children || []) {
        if (child.kind === 'routine') descendants.push(child);
        visit(child);
      }
    };
    visit(requestedNode);
    const routines = [...new Map(descendants
      .filter(node => Number.isInteger(node.implementationOffset))
      .map(node => [node.id, node])).values()];
    if (!routines.length) {
      void vscode.window.showInformationMessage(`Class ${requestedNode.label} has no routine implementations for step generation.`);
      return;
    }

    const counts = { generated: 0, skipped: 0, failed: 0 };
    const requests = [];
    for (const routine of routines) {
      const request = provider.aiRequestFor(routine, document, text, settings);
      if (!request) {
        counts.failed += 1;
      } else if (settings.skipCached && provider.hasAiSteps(request)) {
        counts.skipped += 1;
        if (request.reusedChunkCache) provider.refreshAiRoutine(request);
      } else {
        requests.push(request);
      }
    }
    if (!requests.length) {
      void vscode.window.showInformationMessage(
        `AI routine steps: no model request needed; used ${counts.skipped} cached result(s), ${counts.failed} failed.`
      );
      return;
    }
    const operation = beginAiOperation();
    if (!operation) return;
    let cancelled = false;
    let stoppedForEdit = false;
    const startedKeys = new Set();
    const completedKeys = new Set();
    try {
      const chatModel = await selectAiChatModel(settings);
      if (operation.token.isCancellationRequested) return;
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Window,
        title: `Generating ${generationMode === 'detailed' ? 'detailed ' : ''}steps for all routines in ${requestedNode.label} (${requests.length})`,
        cancellable: true
      }, async (progress, progressToken) => {
        const cancellation = progressToken.onCancellationRequested(() => operation.cancel());
        try {
          let nextIndex = 0;
          let finished = 0;
          const runWorker = async () => {
            while (!operation.token.isCancellationRequested) {
              const index = nextIndex;
              nextIndex += 1;
              if (index >= requests.length) return;
              if (document.version !== startingVersion) {
                stoppedForEdit = true;
                operation.cancel();
                return;
              }
              const request = requests[index];
              startedKeys.add(request.key);
              provider.beginAiGeneration(request, { refresh: false });
              try {
                const steps = await requestAiStepResponse(
                  {
                    ...request,
                    onPartial: partialSteps => provider.updateAiGeneration(request, partialSteps)
                  },
                  chatModel,
                  operation.token,
                  generationMode === 'detailed'
                    ? 'Generate detailed, recursive English navigation steps for the routines in the Delphi class selected by the user.'
                    : 'Generate recursive English navigation steps for the routines in the Delphi class selected by the user.'
                );
                if (operation.token.isCancellationRequested) return;
                if (!steps.length) throw new Error('The model returned no navigable steps.');
                // completeAiGeneration fires only this routine element. Its
                // arrow and all recursively generated child arrows therefore
                // appear as soon as this request completes.
                await provider.completeAiGeneration(request, steps, chatModel, { persist: false });
                completedKeys.add(request.key);
                counts.generated += 1;
              } catch (error) {
                if (!operation.token.isCancellationRequested) {
                  counts.failed += 1;
                  output?.appendLine(
                    `AI steps failed for ${request.routine.label}: ${error.stack || error.message}`
                  );
                }
              } finally {
                if (!completedKeys.has(request.key)) {
                  provider.failAiGeneration(request, { refresh: false });
                }
                finished += 1;
                progress.report({
                  increment: 100 / requests.length,
                  message: `${finished}/${requests.length} · ${request.routine.label}`
                });
              }
            }
          };
          // A small pool gives visible per-function progress without flooding
          // the configured model provider or blocking the extension host.
          const concurrency = Math.min(generationMode === 'detailed' ? 1 : 3, requests.length);
          await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
          if (settings.cacheEnabled && counts.generated > 0) await provider.persistAiCache();
          output?.appendLine(
            `Generated AI navigation steps for ${counts.generated}/${requests.length} routines `
            + `in class ${requestedNode.label} with ${settings.provider}/${chatModel.id} (${generationMode}).`
          );
        } finally {
          cancellation.dispose();
        }
      });
    } catch (error) {
      cancelled = operation.token.isCancellationRequested
        || /cancel/i.test(error?.code || '') || /cancel/i.test(error?.message || '');
      if (!cancelled) {
        output?.appendLine(`Class AI function step generation failed: ${error.stack || error.message}`);
        void vscode.window.showErrorMessage(`AI routine step generation failed for class ${requestedNode.label}: ${error.message}`);
      }
    } finally {
      cancelled ||= operation.token.isCancellationRequested;
      for (const request of requests) {
        if (startedKeys.has(request.key) && !completedKeys.has(request.key)) {
          provider.failAiGeneration(request, { refresh: false });
        }
      }
      finishAiOperation(operation);
    }

    const suffix = stoppedForEdit
      ? '; stopped safely because the file changed during processing'
      : cancelled ? '; cancelled' : '';
    void vscode.window.showInformationMessage(
      `AI routine steps: generated ${counts.generated}, used ${counts.skipped} cached result(s), failed ${counts.failed}${suffix}.`
    );
  };

  provider.onModelReady = () => {
    if (navigatorMode === 'class') scheduleFollow('cursor');
  };

  void vscode.commands.executeCommand('setContext', 'pascalUnion.navigator.mode', navigatorMode);
  void setAiGeneratingContext(false);
  tree.setMode(navigatorMode);
  const combinedChangeSubscription = combinedChanged.event(() => tree.refresh());
  const classChangeSubscription = provider.onDidChangeTreeData(element => {
    if (navigatorMode === 'class') combinedChanged.fire(element);
  });
  const projectChangeSubscription = projectProvider?.onDidChangeTreeData(element => {
    if (navigatorMode !== 'project') return;
    updatePresentation();
    combinedChanged.fire(element);
  });

  context.subscriptions.push(
    webviewRegistration,
    tree,
    provider,
    provider.changed,
    combinedChanged,
    combinedChangeSubscription,
    classChangeSubscription,
    ...(projectChangeSubscription ? [projectChangeSubscription] : []),
    navigationRangeDecoration,
    ...WEBVIEW_CONTEXT_COMMANDS.map(([name, command]) => vscode.commands.registerCommand(
      `pascalUnion.classNavigator.context.${name}`,
      () => {
        const target = tree.selection[0];
        if (target) return vscode.commands.executeCommand(command, target);
        return undefined;
      }
    )),
    tree.onDidExpandElement(event => {
      if (navigatorMode !== 'class') return;
      if (!event.element?.children?.length) return;
      const documentUri = provider.documentUriForNode(event.element)
        || provider.activeDocument()?.uri.toString();
      expandedRoutineIds(documentUri).add(event.element.id);
      persistExpandedRoutines();
      refreshHighlightForRoutineExpansion(provider.routineForNode(event.element));
    }),
    tree.onDidCollapseElement(event => {
      if (navigatorMode !== 'class') return;
      if (!event.element?.children?.length) return;
      const documentUri = provider.documentUriForNode(event.element)
        || provider.activeDocument()?.uri.toString();
      expandedRoutineIds(documentUri).delete(event.element.id);
      persistExpandedRoutines();
      refreshHighlightForRoutineExpansion(provider.routineForNode(event.element));
    }),
    vscode.commands.registerCommand('pascalUnion.classNavigator.refresh', () => {
      activeProvider().refresh?.();
      combinedChanged.fire(undefined);
      updatePresentation();
      scheduleFollow('cursor');
    }),
    vscode.commands.registerCommand('pascalUnion.classNavigator.selectSort', () => {
      if (navigatorMode !== 'class') return;
      if (tree.sortPanelOpen) return tree.hideSort();
      const config = vscode.workspace.getConfiguration('pascalUnion.classNavigator');
      const memberOrder = config.get('memberOrder', 'visibility');
      tree.showSort({
        memberOrder: memberOrder === 'source' ? 'implementation' : memberOrder,
        typeOrder: config.get('typeOrder', 'declaration')
      });
    }),
    vscode.commands.registerCommand('pascalUnion.classNavigator.find', showNavigatorSearch),
    vscode.commands.registerCommand('pascalUnion.navigator.showProjects', () => setNavigatorMode('project')),
    vscode.commands.registerCommand('pascalUnion.navigator.showClasses', () => setNavigatorMode('class')),
    vscode.commands.registerCommand(
      'pascalUnion.navigator.toggleMode',
      () => setNavigatorMode(navigatorMode === 'project' ? 'class' : 'project')
    ),
    vscode.commands.registerCommand('pascalUnion.classNavigator.show', async () => {
      await setNavigatorMode('class');
      const firstNode = provider.model()?.roots?.[0];
      if (!firstNode) {
        void vscode.window.showInformationMessage('Open a Pascal/Delphi source file first.');
        return;
      }
      await tree.reveal(firstNode, { select: false, focus: true, expand: false });
    }),
    vscode.commands.registerCommand(
      'pascalUnion.classNavigator.generateAiSteps',
      node => {
        const target = node?.kind ? node : tree.selection[0];
        return target?.kind === 'type'
          ? generateClassAiSteps(target, 'normal')
          : generateAiSteps(target, 'normal');
      }
    ),
    vscode.commands.registerCommand(
      'pascalUnion.classNavigator.generateDetailedAiSteps',
      node => {
        const target = node?.kind ? node : tree.selection[0];
        return target?.kind === 'type'
          ? generateClassAiSteps(target, 'detailed')
          : generateAiSteps(target, 'detailed');
      }
    ),
    vscode.commands.registerCommand(
      'pascalUnion.classNavigator.stopAiGeneration',
      stopAiGeneration
    ),
    vscode.commands.registerCommand('pascalUnion.classNavigator.open', openNode),
    vscode.window.onDidChangeActiveTextEditor(() => {
      clearNavigationHighlight();
      navigationLock = undefined;
      navigationHoldUntil = 0;
      refresh('cursor', true);
    }),
    vscode.window.onDidChangeTextEditorSelection(event => {
      if (event.textEditor !== vscode.window.activeTextEditor) return;
      clearNavigationHighlightOutsideCursor(event.textEditor);
      if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
        navigationLock = undefined;
        navigationHoldUntil = 0;
        scheduleFollow('mouse', event);
      } else if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {
        scheduleFollow('cursor', event);
      }
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges(event => {
      clearNavigationHighlightOutsideViewport(event);
      if (event.textEditor === vscode.window.activeTextEditor) scheduleFollow('scroll', event);
    }),
    tree.onDidChangeVisibility(event => {
      navigatorVisible = event.visible;
      if (!event.visible) {
        if (followTimer) clearTimeout(followTimer);
        followTimer = undefined;
        return;
      }
      activeProvider().refresh?.();
      combinedChanged.fire(undefined);
      updatePresentation();
      scheduleFollow('cursor');
    }),
    vscode.workspace.onDidChangeTextDocument(event => {
      if (activeNavigationHighlight?.documentUri === event.document.uri.toString()) {
        clearNavigationHighlight();
      }
      if (navigatorMode === 'class' && event.document === provider.activeDocument()) refresh();
    }),
    vscode.workspace.onDidSaveTextDocument(document => {
      if (navigatorMode === 'class' && document === provider.activeDocument()) refresh();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('pascalUnion.classNavigator.highlightRange.enabled')
        || event.affectsConfiguration('pascalUnion.classNavigator.aiSteps.highlightRange')) {
        clearNavigationHighlight();
      }
      if (event.affectsConfiguration('pascalUnion.classNavigator')) {
        const config = vscode.workspace.getConfiguration('pascalUnion.classNavigator');
        const memberOrder = config.get('memberOrder', 'visibility');
        void tree.updateSortSettings({
          memberOrder: memberOrder === 'source' ? 'implementation' : memberOrder,
          typeOrder: config.get('typeOrder', 'declaration')
        });
        refresh();
      } else if (event.affectsConfiguration('pascalUnion.enabled')) refresh();
    }),
    {
      dispose() {
        activeAiCancellation?.cancel();
        activeAiCancellation?.dispose();
        activeAiCancellation = undefined;
        void setAiGeneratingContext(false);
        void vscode.commands.executeCommand(
          'setContext',
          'pascalUnion.classNavigator.webviewFocused',
          false
        );
        if (refreshTimer) clearTimeout(refreshTimer);
        if (followTimer) clearTimeout(followTimer);
        if (layoutTimer) clearTimeout(layoutTimer);
      }
    }
  );
  updatePresentation();
  scheduleFollow('cursor');
  scheduleDefaultLayout();
  output?.appendLine('Explorer class navigator registered for the active Pascal document.');
  return { provider, tree };
}

module.exports = {
  EXPLORER_LAYOUT_STATE_KEY,
  EXPLORER_LAYOUT_VERSION,
  accessColorId,
  aiRetryReasoningEffort,
  activeFollowNodeAt,
  activeNodeAt,
  buildClassNavigatorModel,
  buildDprojNavigatorModel,
  dpkProjectReferenceNodes,
  findNavigatorEntries,
  findNavigatorEntry,
  implementationRoutineForest,
  isClassNavigatorDocument,
  highlightNodeForExpandedSteps,
  navigationRevealPlan,
  navigatorSearchResultsForIndex,
  navigatorSearchResultsForModel,
  navigatorNodeById,
  navigatorIconName,
  navigatorNodeForSearchResult,
  normalizeNavigatorSearchOptions,
  nodeSourceRanges,
  registerClassNavigator,
  routineIconName,
  unitLifecycleNodes,
  viewportFollowLine
};
