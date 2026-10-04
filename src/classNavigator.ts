import { NavigatorMode, NavigatorItemKind } from './shared/navConstants';
import { NavigatorConfigurationSection, NavigatorViewId, NavigatorCommandId, NavigatorContextKey, NavigatorStateKey, NavigatorResource } from './shared/navConstants';
import { inList } from './shared/guards';
import type { NavigatorApi, NavigatorDocument, NavigatorContext, AiSettings, AiRequest, AiCacheEntry, ModelCache, NavigatorActiveState, PendingAiSteps } from './shared/navigator';
import type { AiStep, AiStepPrompt, AiStepResponseResult, AiStepOptions } from './shared/ai';
import type { NavigatorSearchOptions, NavigatorTreePresentation, NavigatorSearchResult, NavigatorTreeState } from './shared/webviewProtocols';
import type { RoutineDeclarationIndex } from './shared/implementation';
import type * as VSCode from 'vscode';
import type { NavigatorOptions, NavigatorModel, RoutineHeader, RoutineBody, StructureLayout, NavigatorNode, NavigatorTarget, SourceDefinition, SourceIndex } from './shared/models';
import { isAiCacheEntry, isNavigatorWorkerResponse } from './shared/navigator';
import { isInteger, isRecord, errorMessage, errorStack } from './shared/guards';
import { PascalKeyword } from './shared/pascal';
import { CommandId, ConfigurationSection, FileExtension, LanguageId, SettingKey } from './shared/identifiers';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { maskPascalNonCode } from './binarySymbols';
import { parseSourceUnitSymbols } from './usesQuickFix';
import { ClassNavigatorWebview } from './classNavigatorWebview';
import { compactRoutineHeading, createImplementationCommand, findRoutineCounterpart, indexRoutineDeclarations, methodDeclarationDirectives, readClassLayout, routineCounterpartKey, routineDeclarationRange, routineDirectiveStatements, routineHeaderEnd } from './implementationCore';
import { AI_STEP_CACHE_STATE_KEY, AI_STEP_CHUNK_CACHE_STATE_KEY, buildAiStepRepairPrompt, buildAiStepPrompt, createAiStepNodes, lineStartOffset, mergeAiStepResponseResults, offsetAtLine, parseAiStepResponseResult, plannedLabelsByHash, routineAnalysisKey } from './aiSteps';
import type { OutputChannel } from 'vscode';
import type { ProjectNavigatorProvider } from './projectNavigator';

const PASCAL_LANGUAGE_IDS = new Set<string>([LanguageId.Pascal, LanguageId.ObjectPascal]);
const STRUCTURE_KINDS = new Set<string>([PascalKeyword.Class, PascalKeyword.Interface, PascalKeyword.Record, PascalKeyword.Object]);
const EXPLORER_LAYOUT_STATE_KEY = NavigatorStateKey.ExplorerLayout;
const NAVIGATOR_MODE_STATE_KEY = NavigatorStateKey.Mode;
const EXPLORER_LAYOUT_VERSION = 1;
const EXPANDED_ROUTINES_STATE_KEY = NavigatorStateKey.ExpandedRoutines;
const SEARCH_OPTIONS_STATE_KEY = NavigatorStateKey.SearchOptions;
const DOCUMENT_EDIT_DELAY_MS = 350;
const WEBVIEW_CONTEXT_COMMANDS = [
  ['buildPackage', CommandId.BuildBuildPackage],
  ['compilePackage', CommandId.BuildCompilePackage],
  ['cleanPackage', CommandId.BuildCleanPackage],
  ['buildGroup', CommandId.BuildBuildGroup],
  ['compileGroup', CommandId.BuildCompileGroup],
  ['cleanGroup', CommandId.BuildCleanGroup],
  ['runGroup', CommandId.RunGroup],
  ['selectStartupProject', CommandId.RunSelectStartupProject],
  ['selectConfiguration', CommandId.BuildSelectConfiguration],
  ['selectPlatform', CommandId.BuildSelectPlatform]
];
const MEMBER_ACCESS_ORDER = new Map([
  [PascalKeyword.Public, 0],
  [PascalKeyword.Published, 1],
  [PascalKeyword.Protected, 2],
  ['strict-protected', 3],
  [PascalKeyword.Private, 4],
  ['strict-private', 5],
  [PascalKeyword.Automated, 6]
]);

interface SearchSession { document: VSCode.TextDocument; filePath: string; model: NavigatorModel | undefined; viewColumn?: VSCode.ViewColumn; selection: VSCode.Selection; viewportStart?: VSCode.Position; selectedNodeId?: string; activeState?: NavigatorActiveState; navigationLock?: { documentUri: string; nodeId: string }; navigationHoldUntil: number; highlight?: { nodeId: string; focusOffset: number }; }

function isNavigatorRoutine(node: NavigatorTarget): node is NavigatorNode {
  return node.kind === 'routine' && typeof node.id === 'string' && typeof node.label === 'string' && Array.isArray(node.children);
}

interface SearchResult extends NavigatorSearchResult { filePath: string; offset: number; name?: string; owner?: string; node?: NavigatorTarget; definition?: SourceDefinition; }

function lineEndOffset(text: string, offset: number) {
  const end = text.indexOf('\n', Math.max(0, offset));
  return end < 0 ? text.length : end;
}

function isClassNavigatorDocument(document: { languageId: string; fileName?: string; uri?: { fsPath?: string } } | undefined) {
  if (!document) return false;
  if (PASCAL_LANGUAGE_IDS.has(document.languageId)) return true;
  return /\.(?:dpk|dproj)$/i.test(document.fileName || document.uri?.fsPath || '');
}

function sectionEndOffset(code: string, offset: number) {
  const end = code.indexOf(';', Math.max(0, offset));
  return end < 0 ? code.length : end + 1;
}

function dpkProjectReferenceNodes(code: string, settings: NavigatorOptions): NavigatorNode[] {
  const entries: NavigatorNode[] = [];
  const requires = /^\s*requires\b/im.exec(code);
  const contains = new RegExp(String.raw`^\s*${PascalKeyword.Contains}\b`, 'im').exec(code);
  const finalEnd = new RegExp(String.raw`^\s*${PascalKeyword.End}\s*\.`, 'im').exec(code);
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
      : contains.index + contains[0].search(new RegExp(String.raw`${PascalKeyword.Contains}`, 'i'));
    entries.push({
      id: 'project:files:contains',
      kind: 'project-file-section',
      label: 'File Includes',
      offset,
      ranges: contains ? [[offset, sectionEndOffset(code, offset)]] : [],
      targetKind: PascalKeyword.Contains,
      children: []
    });
  }
  return entries;
}

function unitLifecycleNodes(code: string, settings: NavigatorOptions): NavigatorNode[] {
  if (!new RegExp(String.raw`^\s*${PascalKeyword.Unit}\b`, 'im').test(code)) return [];
  const initialization = new RegExp(String.raw`^\s*${PascalKeyword.Initialization}\b`, 'im').exec(code);
  const finalization = new RegExp(String.raw`^\s*${PascalKeyword.Finalization}\b`, 'im').exec(code);
  const unitEndMatches = [...code.matchAll(new RegExp(String.raw`^\s*${PascalKeyword.End}\s*\.\s*$`, 'gim'))];
  const unitEnd = unitEndMatches.at(-1)?.index ?? code.length;
  const entries: NavigatorNode[] = [];
  if (settings.showUnitInitialization && initialization) {
    const offset = initialization.index + initialization[0].search(new RegExp(String.raw`${PascalKeyword.Initialization}`, 'i'));
    entries.push({
      id: 'unit:lifecycle:initialization',
      kind: 'unit-initialization-section',
      label: PascalKeyword.Initialization,
      offset,
      ranges: [[offset, finalization?.index ?? unitEnd]],
      children: []
    });
  }
  if (settings.showUnitFinalization && finalization) {
    const offset = finalization.index + finalization[0].search(new RegExp(String.raw`${PascalKeyword.Finalization}`, 'i'));
    entries.push({
      id: 'unit:lifecycle:finalization',
      kind: 'unit-finalization-section',
      label: PascalKeyword.Finalization,
      offset,
      ranges: [[offset, unitEnd]],
      children: []
    });
  }
  return entries;
}

function xmlElementRange(text: string, match: RegExpMatchArray): [number, number] {
  const start = match.index ?? 0;
  if (/\/\s*>$/.test(match[0])) return [start, start + match[0].length];
  const close = /<\/DCCReference\s*>/i.exec(text.slice(start + match[0].length));
  return [
    start,
    close
      ? start + match[0].length + close.index + close[0].length
      : start + match[0].length
  ];
}

function dprojInsertionOffset(text: string) {
  const firstReference = /<DCCReference\b/i.exec(text);
  if (firstReference) return firstReference.index;
  const mainSourceEnd = /<\/DelphiCompile\s*>/i.exec(text);
  if (mainSourceEnd) return mainSourceEnd.index + mainSourceEnd[0].length;
  const itemGroup = /<ItemGroup\b[^>]*>/i.exec(text);
  return itemGroup ? itemGroup.index + itemGroup[0].length : 0;
}

function buildDprojNavigatorModel(text: string, filePath = "", options: NavigatorOptions = {}): NavigatorModel {
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
  const roots: NavigatorNode[] = [];

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
  assignNavigatorNodeIds(roots, filePath);
  attachParents(roots, undefined);
  return {
    implementationRoutines: [],
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

function routineKeywordAt(text: string, offset: number) {
  const lineStart = Math.max(0, text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
  const prefix = text.slice(lineStart, offset);
  return new RegExp(String.raw`\b(${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator}|${PascalKeyword.Function}|${PascalKeyword.Procedure})\s*$`, 'i').exec(prefix)?.[1]?.toLowerCase()
    || PascalKeyword.Procedure;
}

function routineFlavorAt(code: string, offset: number, owner: string | undefined) {
  if (!owner) return 'global';
  const range = routineDeclarationRange(code, offset);
  const headerStart = range?.start ?? Math.max(0, code.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
  const headerEnd = range?.end ?? routineHeaderEnd(code, headerStart);
  const prefix = code.slice(headerStart, offset);
  const afterHeader = headerEnd < 0 ? '' : code.slice(headerEnd, Math.min(code.length, headerEnd + 500));
  const nextDeclaration = new RegExp(String.raw`^\s*(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\b`, 'im').exec(afterHeader);
  const directives = nextDeclaration ? afterHeader.slice(0, nextDeclaration.index) : afterHeader;
  const isClassRoutine = new RegExp(String.raw`\bclass\s+(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\b`, 'i').test(prefix);
  if (isClassRoutine && /\bstatic\s*;/i.test(directives)) return PascalKeyword.Static;
  return isClassRoutine ? PascalKeyword.Class : 'instance';
}

function memberAccessAt(code: string, typeOffset: number, memberOffset: number, typeKind: string, layout: StructureLayout | undefined) {
  if (layout) {
    return layout.sections.find((section) => memberOffset >= section.bodyStart && memberOffset < (section.end ?? Infinity))?.access
      || (typeKind === PascalKeyword.Class ? PascalKeyword.Published : PascalKeyword.Public);
  }
  const segment = code.slice(typeOffset, memberOffset);
  const pattern = new RegExp(String.raw`^\s*(${PascalKeyword.Strict}\s+${PascalKeyword.Private}|${PascalKeyword.Strict}\s+${PascalKeyword.Protected}|${PascalKeyword.Private}|${PascalKeyword.Protected}|${PascalKeyword.Public}|${PascalKeyword.Published}|${PascalKeyword.Automated})\b`, 'gim');
  let access: string = typeKind === PascalKeyword.Record || typeKind === PascalKeyword.Object || typeKind === PascalKeyword.Interface
    ? PascalKeyword.Public
    : PascalKeyword.Published;
  for (const match of segment.matchAll(pattern)) access = match[1].toLowerCase().replace(/\s+/g, '-');
  return access;
}

function specialRoutineKind(name: string | undefined, routineKind: string) {
  const key = String(name || '').toLowerCase();
  if (routineKind === PascalKeyword.Constructor) return PascalKeyword.Constructor;
  if (routineKind === PascalKeyword.Destructor) return PascalKeyword.Destructor;
  if (key === 'initialize') return 'initialize';
  if (key === 'finalize') return 'finalize';
  if (routineKind === PascalKeyword.Operator) return PascalKeyword.Operator;
  return undefined;
}

function accessColorId(access: string | undefined) {
  return {
    public: 'charts.green',
    published: 'charts.green',
    protected: 'charts.yellow',
    'strict-protected': 'charts.purple',
    private: 'charts.red',
    'strict-private': 'charts.orange'
  }[access || ''] || 'foreground';
}

function routineIconName(node: NavigatorTarget | undefined) {
  if (inList(node?.specialRoutineKind, [PascalKeyword.Constructor, PascalKeyword.Destructor, 'initialize', 'finalize'])) {
    return 'symbol-constructor';
  }
  if (node?.specialRoutineKind === PascalKeyword.Operator) return 'symbol-operator';
  if (inList(node?.routineFlavor, [PascalKeyword.Static, 'global', 'local'])) return 'symbol-function';
  return 'symbol-method';
}

function nodeSourceOffset(node: NavigatorTarget) {
  return node?.implementationOffset ?? node?.declarationOffset ?? node?.offset;
}

function compareTypeMembers(left: NavigatorTarget|NavigatorTarget, right: NavigatorTarget|NavigatorTarget, memberOrder = 'visibility') {
  if (memberOrder === 'visibility') {
    const lifecycleRank = (node: NavigatorTarget) => node?.specialRoutineKind === PascalKeyword.Constructor
      ? 0
      : node.specialRoutineKind === PascalKeyword.Destructor ? 1 : 2;
    const lifecycleDifference = lifecycleRank(left) - lifecycleRank(right);
    if (lifecycleDifference !== 0) return lifecycleDifference;
    const accessDifference = (MEMBER_ACCESS_ORDER.get(left.access || '') ?? 99)
      - (MEMBER_ACCESS_ORDER.get(right.access || '') ?? 99);
    if (accessDifference !== 0) return accessDifference;
  }
  const offset = (node: NavigatorTarget) => memberOrder === 'declaration'
    ? node?.declarationOffset ?? node?.offset
    : nodeSourceOffset(node);
  return (offset(left) ?? Number.POSITIVE_INFINITY)
    - (offset(right) ?? Number.POSITIVE_INFINITY);
}

function compareTypeNodes(left: NavigatorTarget, right: NavigatorTarget, typeOrder = 'declaration') {
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

function parseUsesNodes(text: string, code: string) {
  const uses: NavigatorNode[] = [];
  const ranges: Array<[number, number]> = [];
  const sections: NavigatorNode[] = [];
  let firstOffset;
  const implementationOffset = /\bimplementation\b/i.exec(code)?.index ?? Number.POSITIVE_INFINITY;
  for (const clause of code.matchAll(/\buses\b([\s\S]*?);/gi)) {
    const clauseOffset = clause.index;
    if (firstOffset === undefined) firstOffset = clauseOffset;
    const range: [number, number] = [clauseOffset, clauseOffset + clause[0].length];
    ranges.push(range);
    sections.push({
      id: `uses-section:${clauseOffset}`,
      kind: 'uses-section',
      label: '',
      offset: clauseOffset,
      ranges: [range],
      section: clauseOffset < implementationOffset ? PascalKeyword.Interface : PascalKeyword.Implementation,
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
          kind: PascalKeyword.Unit,
          label: name,
          name,
          offset,
          section: clauseOffset < implementationOffset ? PascalKeyword.Interface : PascalKeyword.Implementation,
          children: []
        });
      }
      segmentStart = cursor + 1;
    }
  }
  return { uses, firstOffset, ranges, sections };
}

function deduplicateTypes(types: SourceDefinition[], structureEnds: Map<number, number> = new Map()) {
  const result: SourceDefinition[] = [];
  const byName = new Map<string, SourceDefinition>();
  for (const type of [...types].sort((left, right) => left.offset! - right.offset!)) {
    if (!STRUCTURE_KINDS.has(type.structureKind || '')) continue;
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

function isBodylessStructureDeclaration(code: string, afterKindOffset: number) {
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

function findStructureEnd(code: string, bodyStart: number) {
  let depth = 1;
  const tokenPattern = new RegExp(String.raw`^\s*(?:${PascalKeyword.Type}\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?\s*=\s*(?:${PascalKeyword.Packed}\s+)?(?:${PascalKeyword.Class}(?!\s+${PascalKeyword.Of}\b)|${PascalKeyword.Record}|${PascalKeyword.Object}|${PascalKeyword.Interface})\b|\bend\s*;`, 'gim');
  tokenPattern.lastIndex = bodyStart;
  let token;
  while ((token = tokenPattern.exec(code))) {
    if (new RegExp(String.raw`^\s*${PascalKeyword.End}\s*;`, 'i').test(token[0])) {
      depth -= 1;
      if (depth === 0) return tokenPattern.lastIndex;
    } else if (!isBodylessStructureDeclaration(code, tokenPattern.lastIndex)) {
      depth += 1;
    }
  }
  return -1;
}

function structureEndOffsets(code: string) {
  const result = new Map<number, number>();
  const pattern = new RegExp(String.raw`^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>\r\n]*>)?\s*=\s*(?:${PascalKeyword.Packed}\s+)?(${PascalKeyword.Class}(?!\s+${PascalKeyword.Of}\b)|${PascalKeyword.Record}|${PascalKeyword.Object}|${PascalKeyword.Interface})\b`, 'gim');
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

function fallbackRoutineDefinitions(text: string, code: string) {
  const definitions = [];
  const pattern = new RegExp(String.raw`^\s*(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)`, 'gim');
  for (const match of code.matchAll(pattern)) {
    const parts = match[1].split('.').map((item: string) => item.replace(/\s*<.*>\s*$/, '').trim());
    const symbol = parts.at(-1) || '';
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

function attachParents(nodes: NavigatorNode[], parent?: NavigatorNode, ancestors = new Set<NavigatorNode>(), visited = new Set<NavigatorNode>()) {
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

/**
 * Give a symbol a file-scoped identity independent of its source offsets.
 * Parent identities distinguish nested symbols; signatures distinguish overloads.
 */
function assignNavigatorNodeIds(nodes: NavigatorNode[], filePath: string, parentId = `document:${filePath}`) {
  const occurrences = new Map();
  for (const node of nodes) {
    let signature = '';
    if (node.routineSignatureKey && node.owner) {
      signature = node.routineSignatureKey;
    } else if (node.kind === 'routine' && node.signature) {
      // Fallback signatures can include a one-line body. Only the header is
      // identity: editing the body must retain its row, selection and expansion.
      const headerEnd = routineHeaderEnd(maskPascalNonCode(node.signature), 0);
      signature = node.signature.slice(0, headerEnd < 0 ? undefined : headerEnd)
        .replace(/\s+/g, '').toLowerCase();
    }
    const identity = JSON.stringify([
      node.kind, node.section || '',
      node.kind === 'uses-section' ? '' : String(node.name || node.label || '').toLowerCase(),
      signature
    ]);
    const occurrence = occurrences.get(identity) || 0;
    occurrences.set(identity, occurrence + 1);
    node.id = `symbol:${createHash('sha1')
      .update(`${parentId}:${identity}:${occurrence}`).digest('hex')}`;
    assignNavigatorNodeIds(node.children || [], filePath, node.id);
  }
}

function navigatorSearchPattern(query: string) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return undefined;
  if (!needle.includes('*')) return (value: string) => value.startsWith(needle);
  const source = needle
    .split('*')
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  const pattern = new RegExp(`^${source}`, 'i');
  return (value: string) => pattern.test(value);
}

function findNavigatorEntries(nodes: NavigatorTarget[], query: string): NavigatorTarget[] {
  const matches: NavigatorTarget[] = [];
  const accepts = navigatorSearchPattern(query);
  if (!accepts) return matches;
  const visit = (entries: NavigatorTarget[] = []) => {
    for (const node of entries || []) {
      if ((node.kind === PascalKeyword.Type || node.kind === 'routine')
        && accepts(String(node.name || node.label || '').toLocaleLowerCase())) {
        matches.push(node);
      }
      visit(node.children);
    }
  };
  visit(nodes);
  return matches;
}

function findNavigatorEntry(nodes: NavigatorTarget[], query: string) {
  return findNavigatorEntries(nodes, query)[0];
}

function normalizeNavigatorSearchOptions(value: Partial<NavigatorSearchOptions> | undefined = {}): NavigatorSearchOptions {
  return {
    scope: value?.scope === 'global' ? 'global' : 'current',
    types: value?.types !== false,
    files: value?.files === true,
    routines: value?.routines !== false,
    navigation: inList(value?.navigation, ['all', 'current', 'confirm'])
      ? value?.navigation || 'all'
      : 'all'
  };
}

function navigatorSearchResultId(kind: string, filePath: string, offset: number, name: string) {
  return ['search', kind, String(filePath || '').toLocaleLowerCase(), offset || 0, name || '']
    .join(':');
}

function navigatorSearchResultsForModel(model: Pick<NavigatorModel, "roots"> | undefined, filePath: string, query: string, rawOptions: Partial<NavigatorSearchOptions> = {}): SearchResult[] {
  const options = normalizeNavigatorSearchOptions(rawOptions);
  const accepts = navigatorSearchPattern(query);
  if (!accepts || !filePath) return [];
  const results: SearchResult[] = [];
  const fileName = path.basename(filePath);
  if (options.files && accepts(fileName.toLocaleLowerCase())) {
    results.push({
      id: navigatorSearchResultId(NavigatorItemKind.File, filePath, 0, fileName),
      kind: NavigatorItemKind.File,
      label: fileName,
      description: 'Current file',
      tooltip: filePath,
      icon: NavigatorItemKind.File,
      filePath,
      offset: 0,
      isCurrentFile: true
    });
  }
  const visit = (nodes: NavigatorTarget[] = []) => {
    for (const node of nodes || []) {
      const acceptedKind = (node.kind === PascalKeyword.Type && options.types)
        || (node.kind === 'routine' && options.routines);
      const name = String(node.name || node.label || '');
      if (acceptedKind && accepts(name.toLocaleLowerCase())) {
        const offset = node.kind === 'routine'
          ? node.implementationOffset ?? node.declarationOffset
          : node.offset ?? node.declarationOffset;
        results.push({
          id: navigatorSearchResultId(node.kind || '', filePath, offset ?? 0, node.id || ''),
          kind: node.kind,
          label: node.label || '',
          description: node.parent?.kind === PascalKeyword.Type
            ? `${node.parent.label} · ${fileName}`
            : fileName,
          tooltip: navigatorNodeTooltip(node) || filePath,
          icon: navigatorIconName(node),
          access: node.access,
          missingCounterpart: node.missingCounterpart,
          filePath,
          offset: isInteger(offset) ? offset : 0,
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

function navigatorSearchResultsForIndex(sourceIndex: Pick<SourceIndex, "definitions"> & { files?: Set<string> }, query: string, rawOptions: Partial<NavigatorSearchOptions> = {}, currentFilePath = ""): SearchResult[] {
  const options = normalizeNavigatorSearchOptions(rawOptions);
  const accepts = navigatorSearchPattern(query);
  if (!accepts || !sourceIndex) return [];
  const currentKey = path.resolve(currentFilePath || '.').toLocaleLowerCase();
  const results: SearchResult[] = [];
  const seen = new Set();
  const add = (result: SearchResult) => {
    if (!result.filePath) return;
    const key = `${result.kind}:${path.resolve(result.filePath).toLocaleLowerCase()}:${result.offset || 0}:${result.label.toLocaleLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.isCurrentFile = path.resolve(result.filePath).toLocaleLowerCase() === currentKey;
    results.push(result);
  };
  const definitions: SourceDefinition[] = [];
  for (const values of sourceIndex.definitions?.values?.() || []) definitions.push(...values);
  if (options.files) {
    const files = new Map<string, string>();
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
        id: navigatorSearchResultId(NavigatorItemKind.File, filePath, 0, fileName),
        kind: NavigatorItemKind.File, label: fileName, description: path.dirname(filePath), tooltip: filePath,
        icon: NavigatorItemKind.File, filePath, offset: 0
      });
    }
  }
  for (const definition of definitions) {
    const isType = definition.kind === PascalKeyword.Type && STRUCTURE_KINDS.has(definition.structureKind || '');
    const isRoutine = definition.kind === 'routine';
    if ((!isType || !options.types) && (!isRoutine || !options.routines)) continue;
    if (!accepts(String(definition.symbol || '').toLocaleLowerCase())) continue;
    const offset = isRoutine
      ? definition.implementationOffset ?? definition.offset
      : definition.offset;
    const fileName = path.basename(definition.filePath || '');
    add({
      id: navigatorSearchResultId(isType ? PascalKeyword.Type : 'routine', definition.filePath, offset, definition.symbol),
      kind: isType ? PascalKeyword.Type : 'routine',
      label: definition.symbol,
      description: definition.owner ? `${definition.owner} · ${fileName}` : fileName,
      tooltip: definition.signature || definition.filePath,
      icon: isType
        ? definition.structureKind === PascalKeyword.Interface ? PascalKeyword.Interface
          : inList(definition.structureKind, [PascalKeyword.Record, PascalKeyword.Object]) ? 'struct' : PascalKeyword.Class
        : definition.owner ? 'symbol-method' : 'symbol-function',
      filePath: definition.filePath,
      offset: isInteger(offset) ? offset : 0,
      definition,
      name: definition.symbol,
      owner: definition.owner
    });
  }
  return results
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
      || left.filePath.localeCompare(right.filePath, undefined, { sensitivity: 'base' })
      || left.offset! - right.offset!)
    .slice(0, 500);
}

function navigatorNodeForSearchResult(model: Pick<NavigatorModel, "typeNodes" | "routineNodes"> | undefined, result: NavigatorTarget) {
  if (!model || !result || !inList(result.kind, [PascalKeyword.Type, 'routine'])) return undefined;
  const candidates = result.kind === PascalKeyword.Type ? model.typeNodes || [] : model.routineNodes || [];
  const name = String(result.name || result.label || '').toLocaleLowerCase();
  const owner = String(result.owner || '').toLocaleLowerCase();
  const matching = candidates.filter((node) => {
    if (String(node.name || node.label || '').toLocaleLowerCase() !== name) return false;
    if (!owner) return true;
    return String(node.owner || node.parent?.name || node.parent?.label || '').toLocaleLowerCase() === owner;
  });
  const pool = matching.length > 0
    ? matching
    : candidates.filter((node) => String(node.name || node.label || '').toLocaleLowerCase() === name);
  const targetOffset = isInteger(result.offset) ? result.offset : 0;
  return pool.sort((left: NavigatorTarget, right: NavigatorTarget) => {
    const leftOffset = left.kind === 'routine'
      ? left.implementationOffset ?? left.declarationOffset ?? 0
      : left.offset ?? left.declarationOffset ?? 0;
    const rightOffset = right.kind === 'routine'
      ? right.implementationOffset ?? right.declarationOffset ?? 0
      : right.offset ?? right.declarationOffset ?? 0;
    return Math.abs(leftOffset - targetOffset) - Math.abs(rightOffset - targetOffset);
  })[0];
}

function addRoutineRanges(text: string, routineNodes: NavigatorNode[]) {
  const implementations = routineNodes
    .filter((node: NavigatorTarget) => isInteger(node.implementationOffset))
    .sort((left: NavigatorTarget, right: NavigatorTarget) => left.implementationOffset! - right.implementationOffset!);
  for (let index = 0; index < implementations.length; index += 1) {
    const node = implementations[index];
    if (!isInteger(node.implementationEndOffset)) {
      node.implementationEndOffset = implementations[index + 1]?.implementationOffset ?? text.length;
    }
  }
  for (const node of routineNodes) {
    if (isInteger(node.declarationOffset)) {
      node.declarationEndOffset = lineEndOffset(text, node.declarationOffset);
    }
  }
}

/** Store full headings separately from the existing line ranges used for editor highlighting. */
function addDeclarationHeaders(text: string, code: string, nodes: NavigatorTarget[]) {
  for (const node of nodes) {
    if (!isInteger(node.declarationOffset)) continue;
    const range = routineDeclarationRange(code, node.declarationOffset);
    if (!range) continue;
    node.declarationStartOffset = range.start;
    node.declarationHeaderEndOffset = range.end;
    node.declarationTerminatorEndOffset = range.end
      ? routineDirectiveStatements(code, range.end).at(-1)?.end ?? range.end : undefined;
    const kind = new RegExp(String.raw`^(?:${PascalKeyword.Class}\s+)?(${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\b`, 'i')
      .exec(code.slice(range.start));
    if (kind) {
      node.routineKind = kind[1].toLowerCase();
      node.specialRoutineKind = specialRoutineKind(node.name, node.routineKind);
      if (node.owner) node.routineFlavor = routineFlavorAt(code, node.declarationOffset, node.owner);
    }
    if (range.end) node.signature = compactRoutineHeading(text.slice(range.start, range.end));
  }
}

function routineHeaders(code: string, startOffset: number): RoutineHeader[] {
  const result = [];
  const pattern = new RegExp(String.raw`^\s*(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)`, 'gim');
  pattern.lastIndex = startOffset;
  for (let match; (match = pattern.exec(code));) {
    const parts = match[1].replace(/<[^>]*>/g, '').split('.').map(item => item.trim());
    const name = parts.at(-1) || '';
    let segmentStart = 0;
    let angles = 0;
    for (let index = 0; index < match[1].length; index += 1) {
      if (match[1][index] === '<') angles += 1;
      else if (match[1][index] === '>') angles -= 1;
      else if (match[1][index] === '.' && angles === 0) segmentStart = index + 1;
    }
    const nameStart = segmentStart + (match[1].slice(segmentStart).match(/^\s*/)?.[0].length || 0);
    const declarationOffset = match.index + match[0].search(new RegExp(String.raw`\b(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\b`, 'i'));
    result.push({
      // The multiline pattern deliberately accepts indentation and preceding
      // line breaks. Keep the structural start at the actual keyword so the
      // whitespace following a previous `end;` cannot make the next top-level
      // routine look like a nested declaration.
      start: declarationOffset,
      name,
      owner: parts.length > 1 ? parts.slice(0, -1).join('.') : undefined,
      nameOffset: match.index + match[0].indexOf(match[1]) + nameStart,
      headerEnd: routineHeaderEnd(code, declarationOffset)
    });
  }
  return result;
}

function routineBodyEnd(code: string, beginOffset: number) {
  const tokens = new RegExp(String.raw`\b(${PascalKeyword.Begin}|${PascalKeyword.Case}|${PascalKeyword.Try}|${PascalKeyword.Asm}|${PascalKeyword.End})\b`, 'gi');
  tokens.lastIndex = beginOffset;
  let depth = 0;
  for (let token; (token = tokens.exec(code));) {
    if (new RegExp(String.raw`^(?:${PascalKeyword.Begin}|${PascalKeyword.Case}|${PascalKeyword.Try}|${PascalKeyword.Asm})$`, 'i').test(token[1])) depth += 1;
    else {
      depth -= 1;
      if (depth === 0) {
        let terminator = tokens.lastIndex;
        while (/\s/.test(code[terminator] || '')) terminator += 1;
        if (code[terminator] !== ';') return { end: code.length, complete: false };
        const terminatorEndOffset = terminator + 1;
        let end = terminatorEndOffset;
        while (/[\s;]/.test(code[end] || '')) end += 1;
        return { end, terminatorEndOffset, complete: true };
      }
    }
  }
  return { end: code.length, complete: false };
}

function bodylessRoutineEnd(code: string, header: RoutineHeader, nextHeaderStart: unknown, nextBeginOffset: unknown) {
  // A Delphi external/forward routine has no executable body. Detect its
  // directive before treating a later routine header as a local declaration.
  // `external` commonly carries a library/name clause, so it is not necessarily
  // followed immediately by a semicolon.
  const boundary = Math.min(
    isInteger(nextHeaderStart) ? nextHeaderStart : code.length,
    isInteger(nextBeginOffset) ? nextBeginOffset : code.length
  );
  const tail = code.slice(header.headerEnd, boundary);
  const directive = new RegExp(String.raw`\b(?:${PascalKeyword.External}|${PascalKeyword.Forward}|${PascalKeyword.Abstract})\b`, 'i').exec(tail);
  if (!directive) return undefined;
  const directiveOffset = header.headerEnd + directive.index;
  const terminator = code.indexOf(';', directiveOffset);
  if (terminator < 0 || terminator >= boundary) return header.headerEnd;
  return terminator + 1;
}

function parseRoutineTree(code: string, headers: RoutineHeader[], headerIndex: number): RoutineBody {
  const header = headers[headerIndex];
  if (!header || header.headerEnd < 0) {
    return { header, children: [], end: code.length, complete: false, next: headerIndex + 1 };
  }
  const children: RoutineBody[] = [];
  let cursor = header.headerEnd;
  let childIndex = headerIndex + 1;
  const beginPattern = new RegExp(String.raw`\b(?:${PascalKeyword.Begin}|${PascalKeyword.Asm})\b`, 'gi');
  beginPattern.lastIndex = cursor;
  let begin = beginPattern.exec(code);

  const bodylessEnd = bodylessRoutineEnd(
    code,
    header,
    headers[childIndex]?.start,
    begin?.index
  );
  if (bodylessEnd !== undefined) {
    return { header, children, end: bodylessEnd, terminatorEndOffset: bodylessEnd,
      complete: code[bodylessEnd - 1] === ';', next: headerIndex + 1 };
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
  if (!begin || new RegExp(String.raw`\b(?:${PascalKeyword.Forward}|${PascalKeyword.Abstract})\s*;|\bexternal\b`, 'i').test(declarationTail)) {
    return { header, children, end: Math.max(header.headerEnd, cursor), complete: false, next: childIndex };
  }
  const body = routineBodyEnd(code, begin.index);
  const end = body.end;
  while (childIndex < headers.length && headers[childIndex].start < end) {
    const child = parseRoutineTree(code, headers, childIndex);
    children.push(child);
    childIndex = Math.max(child.next, childIndex + 1);
  }
  return { header, children, ...body, next: childIndex };
}

function implementationRoutineForest(code: string) {
  const implementation = /\bimplementation\b/i.exec(code);
  if (!implementation) return [];
  // Helper classes and records may be declared in the implementation section.
  // Their body-less method declarations must not be interpreted as nested local
  // functions; Josh.DB.pas previously turned hundreds of methods into one graph.
  const structureRanges = [...structureEndOffsets(code)].map(([start, end]) =>
    [start, readClassLayout(code, start, code)?.endOffset ?? end]);
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

function nestLocalRoutines(code: string, routineNodes: NavigatorNode[], globalRoot: NavigatorNode | undefined, forest = implementationRoutineForest(code)) {
  const byOffset = new Map<number, NavigatorNode>();
  for (const node of routineNodes) {
    if (isInteger(node.implementationOffset)) byOffset.set(node.implementationOffset, node);
    if (isInteger(node.declarationOffset)) byOffset.set(node.declarationOffset, node);
  }
  const nested = new Set();
  const attach = (routine: RoutineBody, parentNode: NavigatorNode | undefined) => {
    const node = byOffset.get(routine.header?.nameOffset);
    if (!node) return;
    node.implementationOffset ??= routine.header.nameOffset;
    node.implementationEndOffset = routine.end;
    node.implementationStartOffset = routine.header.start;
    node.implementationTerminatorEndOffset = routine.terminatorEndOffset;
    if (parentNode && node !== parentNode) {
      node.routineFlavor = 'local';
      node.access = parentNode.access;
      if (!parentNode.children.includes(node)) parentNode.children.push(node);
      nested.add(node);
    }
    for (const child of routine.children) attach(child, node);
    node.children.sort((left, right) =>
      (left.implementationOffset ?? left.declarationOffset ?? 0)
      - (right.implementationOffset ?? right.declarationOffset ?? 0));
  };
  for (const routine of forest) attach(routine, undefined);
  if (globalRoot) globalRoot.children = globalRoot.children.filter((node: unknown) => !nested.has(node));
}

/** Reconcile class declarations and bodies without the source index's name-only fallback. */
function reconcileClassRoutineCounterparts(text: string, code: string, types: NavigatorNode[], rootTypes: NavigatorNode[], routines: NavigatorNode[], forest: RoutineBody[], unitName: string, hiddenOwners: Set<string>) {
  const byOwner = new Map(types.map(type => [(type.qualifiedName || type.name || '').toLowerCase(), type]));
  const implementations = forest.filter((routine) => routine.header?.owner);
  const ownedOffsets = new Set(implementations.map((routine) => routine.header.nameOffset));
  const declarations = new Map<NavigatorNode, RoutineDeclarationIndex<NavigatorNode>>();
  for (const type of types) {
    if (type.typeKind !== PascalKeyword.Class) continue;
    const methods = type.children.filter((node: NavigatorTarget) => node.kind === 'routine');
    for (const node of methods) {
      // Clear potentially incorrect name/ordinal matches supplied by the index.
      node.implementationOffset = undefined;
      node.routineSignatureKey = routineCounterpartKey(node.signature, node.name);
      const directives = methodDeclarationDirectives(code, node);
      node.missingCounterpart = directives.has(PascalKeyword.Abstract) || directives.has(PascalKeyword.External) ? undefined : PascalKeyword.Implementation;
      node.routineOverloaded = directives.has(PascalKeyword.Overload);
    }
    declarations.set(type, indexRoutineDeclarations(methods));
  }
  for (const node of routines) {
    if (!node.owner && ownedOffsets.has(node.implementationOffset ?? -1)) node.implementationOffset = undefined;
  }
  for (const implementation of implementations) {
    const header = implementation.header;
    const headerOwner = header.owner || '';
    let owner = headerOwner.toLowerCase();
    if (unitName && owner.startsWith(`${unitName.toLowerCase()}.`)) owner = owner.slice(unitName.length + 1);
    let type = byOwner.get(owner);
    if (!type) {
      const candidates = types.filter((candidate) => (candidate.name || '').toLowerCase() === owner);
      if (candidates.length === 1) type = candidates[0];
    }
    if (!type && hiddenOwners.has(owner.split('.').at(-1) || '')) continue;
    if (!type) {
      // Keep an orphan visible even when its owner has no local type declaration.
      type = { id: '', kind: PascalKeyword.Type, typeKind: PascalKeyword.Class, name: header.owner, label: headerOwner,
        qualifiedName: header.owner, offset: header.start, declarationEndOffset: implementation.end, children: [] };
      types.push(type); rootTypes.push(type); byOwner.set(owner, type);
    }
    if (type.typeKind !== PascalKeyword.Class) continue;
    const signature = compactRoutineHeading(text.slice(header.start, header.headerEnd < 0 ? lineEndOffset(text, header.start) : header.headerEnd));
    const key = routineCounterpartKey(signature, header.name);
    const declarationIndex = declarations.get(type);
    const node = declarationIndex ? findRoutineCounterpart(declarationIndex, signature, header.name) : undefined;
    if (node) {
      node.implementationOffset = header.nameOffset;
      node.implementationEndOffset = implementation.end;
      node.missingCounterpart = undefined;
    } else {
      const routineKind = new RegExp(String.raw`^(?:${PascalKeyword.Class}\s+)?(${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\b`, 'i')
        .exec(code.slice(header.start))?.[1]?.toLowerCase() || PascalKeyword.Procedure;
      const orphan: NavigatorNode = { id: '', kind: 'routine', name: header.name, label: header.name, owner: type.name,
        offset: header.nameOffset, implementationOffset: header.nameOffset, implementationEndOffset: implementation.end,
        routineKind, routineFlavor: routineFlavorAt(code, header.nameOffset, type.name),
        specialRoutineKind: specialRoutineKind(header.name, routineKind), signature, routineSignatureKey: key,
        missingCounterpart: 'declaration', children: [] };
      type.children.push(orphan); routines.push(orphan);
    }
  }
}

/** Give globals the same overload-safe counterpart matching used for class methods. */
function reconcileGlobalRoutineCounterparts(text: string, code: string, globals: NavigatorNode[], routines: NavigatorNode[], forest: RoutineBody[]) {
  const implementation = /\bimplementation\b/i.exec(code);
  if (!implementation) return;
  const declarations = globals.filter((node) => node.declarationOffset! < implementation.index);
  for (const node of declarations) {
    node.implementationOffset = undefined;
    node.routineSignatureKey = routineCounterpartKey(node.signature, node.name);
    node.routineOverloaded = methodDeclarationDirectives(code, node).has(PascalKeyword.Overload);
  }
  const index = indexRoutineDeclarations(declarations);
  const privateByOffset = new Map<number, NavigatorNode>(globals.filter((node) => node.declarationOffset! >= implementation.index)
    .map(node => [node.declarationOffset ?? 0, node]));
  for (const body of forest) {
    const header = body.header;
    if (header.owner) continue;
    const signature = compactRoutineHeading(text.slice(header.start, header.headerEnd < 0 ? lineEndOffset(text, header.start) : header.headerEnd));
    let node = findRoutineCounterpart(index, signature, header.name);
    const privateNode = privateByOffset.get(header.nameOffset);
    if (node && privateNode && node !== privateNode) {
      globals.splice(globals.indexOf(privateNode), 1);
      routines.splice(routines.indexOf(privateNode), 1);
    }
    if (!node) node = privateNode;
    if (!node) {
      node = { id: '', kind: 'routine', name: header.name, label: header.name, access: PascalKeyword.Public,
        routineFlavor: 'global', routineKind: routineKeywordAt(text, header.nameOffset),
        declarationOffset: header.nameOffset, signature, children: [] };
      globals.push(node); routines.push(node);
    }
    node.routineSignatureKey = routineCounterpartKey(node.signature, node.name);
    node.implementationOffset = header.nameOffset;
    node.implementationEndOffset = body.end;
  }
  globals.sort((left: NavigatorTarget, right: NavigatorTarget) => left.declarationOffset! - right.declarationOffset!);
}

function buildClassNavigatorModel(text: string, filePath = "", options: NavigatorOptions = {}): NavigatorModel {
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
    memberOrder: inList(options.memberOrder, ['declaration', PascalKeyword.Implementation, 'source'])
      ? (options.memberOrder === 'source' ? PascalKeyword.Implementation : options.memberOrder)
      : 'visibility',
    typeOrder: options.typeOrder === 'alphabetical' ? 'alphabetical' : 'declaration'
  };
  const code = maskPascalNonCode(text);
  const structureEnds = structureEndOffsets(code);
  const source = parseSourceUnitSymbols(text, filePath, code, {
    includeImplementationSymbols: true
  });
  const classLayouts = new Map<number, StructureLayout>();
  for (const type of source?.types || []) {
    if (type.structureKind !== PascalKeyword.Class) continue;
    const layout = readClassLayout(text, type.offset, code);
    if (!layout) continue;
    classLayouts.set(type.offset, layout);
    if (!layout.forward) structureEnds.set(type.offset, layout.endOffset);
  }
  const parsedUses = parseUsesNodes(text, code);
  const roots: NavigatorNode[] = [];
  const routineNodes: NavigatorNode[] = [];

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
      label: PascalKeyword.Uses,
      offset: parsedUses.firstOffset,
      ranges: parsedUses.ranges,
      children: usesChildren
    });
  }
  // `uses` stays the first root item even if a package happens to contain one.
  roots.push(...projectReferenceRoots);

  const sourceMembers = source?.members || [];
  // The lexical layout also recovers direct methods after anonymous record
  // fields and inline visibility labels that the general symbol index omits.
  const layoutMembers: Array<Pick<SourceDefinition, "kind" | "owner" | "symbol" | "offset" | "signature" | "implementationOffset"> & { attributeStart?: number }> = [...classLayouts.values()].flatMap(layout => layout.members
    .filter((member) => member.kind === 'routine').map((member) => ({
      kind: 'routine', owner: layout.name, symbol: member.name, offset: member.nameOffset ?? member.start,
      signature: compactRoutineHeading(text.slice(member.start, member.headerEnd)),
      implementationOffset: undefined, attributeStart: member.attributeStart
    })));
  const members = [...new Map([...sourceMembers.filter(item => item.kind === 'routine'), ...layoutMembers]
    .map(member => [member.offset, member])).values()];
  const properties = sourceMembers.filter(item => item.kind === PascalKeyword.Property);
  const memberDeclarationOffsets = new Set(members.map(item => item.offset));
  const definitions = source?.definitions || fallbackRoutineDefinitions(text, code);
  const globals = definitions.filter(item => item.kind === 'routine'
    && !item.owner
    && !memberDeclarationOffsets.has(item.offset));
  const uniqueGlobals = [];
  const seenGlobalOffsets = new Set();
  for (const definition of globals.sort((left, right) => left.offset! - right.offset!)) {
    const key = `${definition.offset}:${definition.symbol.toLowerCase()}`;
    if (seenGlobalOffsets.has(key)) continue;
    seenGlobalOffsets.add(key);
    const node: NavigatorNode = {
      id: `global:${key}`,
      kind: 'routine',
      label: definition.symbol,
      name: definition.symbol,
      owner: undefined,
      routineKind: routineKeywordAt(text, definition.offset),
      routineFlavor: 'global',
      access: PascalKeyword.Public,
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
  const allTypeNodes: NavigatorNode[] = [];
  for (const type of typeDefinitions) {
    if (type.structureKind === PascalKeyword.Interface && !settings.showInterfaces) continue;
    if ((type.structureKind === PascalKeyword.Record || type.structureKind === PascalKeyword.Object)
      && !settings.showRecordsAndObjects) continue;
    const layout = classLayouts.get(type.offset);
    const typeMembers = members
      .filter(member => member.owner?.toLowerCase() === type.symbol.toLowerCase()
        && member.offset >= type.offset && member.offset < (structureEnds.get(type.offset) ?? text.length))
      .sort((left, right) => left.offset! - right.offset!)
      .map(member => {
        const routineKind = routineKeywordAt(text, member.offset);
        const node: NavigatorNode = {
          id: `type:${type.symbol.toLowerCase()}:routine:${member.offset}:${member.symbol.toLowerCase()}`,
          kind: 'routine',
          label: member.symbol,
          name: member.symbol,
          owner: type.symbol,
          routineKind,
          routineFlavor: routineFlavorAt(code, member.offset, type.symbol),
          specialRoutineKind: specialRoutineKind(member.symbol, routineKind),
          access: memberAccessAt(code, type.offset, member.offset, type.structureKind || '', layout),
          declarationOffset: member.offset,
          declarationAttributesStartOffset: 'attributeStart' in member ? member.attributeStart : undefined,
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
      .sort((left, right) => left.offset! - right.offset!)
      .map(property => ({
        id: `type:${type.symbol.toLowerCase()}:property:${property.offset}:${property.symbol.toLowerCase()}`,
        kind: PascalKeyword.Property,
        label: property.symbol,
        name: property.symbol,
        owner: type.symbol,
        access: memberAccessAt(code, type.offset, property.offset, type.structureKind || '', layout),
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
      kind: PascalKeyword.Type,
      typeKind: type.structureKind,
      label: type.symbol,
      name: type.symbol,
      offset: type.offset,
      declarationEndOffset: structureEnds.get(type.offset) ?? lineEndOffset(text, type.offset),
      classLayout: layout,
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
  const sortedTypeNodes = [...allTypeNodes].sort((left, right) => left.offset! - right.offset!);
  for (const node of sortedTypeNodes) {
    const parent = sortedTypeNodes
      .filter(candidate => candidate !== node
        && candidate.offset! < node.offset!
        && candidate.declarationEndOffset! >= node.declarationEndOffset!)
      .sort((left, right) =>
        (left.declarationEndOffset! - left.offset!)
        - (right.declarationEndOffset! - right.offset!))[0];
    if (!parent) {
      node.qualifiedName = node.name;
      rootTypeNodes.push(node);
      continue;
    }
    node.owner = parent.name;
    node.qualifiedName = `${parent.qualifiedName}.${node.name}`;
    // Nested types are always the first children of their declaring type,
    // before the properties group and routines, in declaration order.
    let insertAt = 0;
    while (insertAt < parent.children.length
      && parent.children[insertAt].kind === PascalKeyword.Type
      && parent.children[insertAt].offset! < node.offset!) insertAt += 1;
    parent.children.splice(insertAt, 0, node);
  }
  const implementationForest = implementationRoutineForest(code);
  addDeclarationHeaders(text, code, routineNodes);
  const visibleTypeOffsets = new Set(allTypeNodes.map(type => type.offset));
  const hiddenOwners = new Set(typeDefinitions.filter(type => !visibleTypeOffsets.has(type.offset))
    .map(type => type.symbol.toLowerCase()));
  reconcileClassRoutineCounterparts(text, code, allTypeNodes, rootTypeNodes, routineNodes,
    implementationForest, source?.unitName || '', hiddenOwners);
  reconcileGlobalRoutineCounterparts(text, code, uniqueGlobals, routineNodes, implementationForest);
  if (settings.showGlobalRoutines && uniqueGlobals.length && !roots.some(node => node.kind === 'global-group')) {
    roots.push({ id: 'root:global', kind: 'global-group', label: 'global', children: uniqueGlobals });
  }
  for (const type of allTypeNodes) {
    // Nested types and the properties group retain their leading positions.
    const methods = type.children.filter(node => node.kind === 'routine')
      .sort((left, right) => compareTypeMembers(left, right, settings.memberOrder));
    type.children = [...type.children.filter(node => node.kind !== 'routine'), ...methods];
  }
  rootTypeNodes.sort((left, right) => compareTypeNodes(left, right, settings.typeOrder));
  roots.push(...rootTypeNodes);

  // Unit lifecycle sections are deliberately last and are not global routines.
  roots.push(...unitLifecycleNodes(code, settings));

  const globalRoot = roots.find(node => node.kind === 'global-group');
  nestLocalRoutines(code, routineNodes, globalRoot, implementationForest);
  addDeclarationHeaders(text, code, routineNodes);
  if (globalRoot && globalRoot.children.length === 0) {
    roots.splice(roots.indexOf(globalRoot), 1);
  }
  addRoutineRanges(text, routineNodes);
  attachParents(roots, undefined);
  assignNavigatorNodeIds(roots, filePath);
  const nodes: NavigatorNode[] = [];
  const collectNodes = (entries: NavigatorNode[]) => {
    for (const entry of entries || []) {
      nodes.push(entry);
      collectNodes(entry.children);
    }
  };
  collectNodes(roots);
  const implementationNodes = routineNodes
    .filter(node => isInteger(node.implementationOffset))
    .sort((left, right) => left.implementationOffset! - right.implementationOffset!);
  const declarationNodes = routineNodes
    .filter(node => isInteger(node.declarationOffset))
    .sort((left, right) => left.declarationOffset! - right.declarationOffset!);
  const propertyNodes = nodes
    .filter(node => node.kind === PascalKeyword.Property && isInteger(node.offset))
    .sort((left, right) => left.offset! - right.offset!);
  const typeNodes = allTypeNodes
    .sort((left, right) => left.offset! - right.offset!);
  const sectionNodes = roots.flatMap(node => {
    if (node.kind === 'uses-group') return node.children?.length ? node.children : [node];
    return new RegExp(String.raw`^(?:project-(?:${PascalKeyword.Package}|${NavigatorItemKind.File})|${PascalKeyword.Unit}-(?:${PascalKeyword.Initialization}|${PascalKeyword.Finalization}))-section$`).test(node.kind)
      ? [node]
      : [];
  });
  return {
    filePath,
    roots,
    routineNodes,
    implementationNodes,
    implementationRoutines: implementationForest,
    declarationNodes,
    propertyNodes,
    typeNodes,
    sectionNodes,
    uses: parsedUses.uses,
    nodes
  };
}

function findLatestContainingNode(nodes: NavigatorTarget[], offset: number, startKey: "implementationOffset" | "declarationOffset" | "offset" | "rangeOffset", endKey: "implementationEndOffset" | "declarationEndOffset", followRoutineParent = false) {
  let low = 0;
  let high = nodes.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if ((nodes[middle][startKey] ?? Infinity) <= offset) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  let node = candidate >= 0 ? nodes[candidate] : undefined;
  while (node) {
    if (offset >= (node[startKey] ?? Infinity) && offset < (node[endKey] ?? -1)) return node;
    node = followRoutineParent && node.parent?.kind === 'routine' ? node.parent : undefined;
  }
  return undefined;
}

function activeNodeAt(model: Partial<NavigatorModel> & { projectSectionNodes?: NavigatorTarget[] } | undefined, offset: number) {
  if (!model) return undefined;
  const projectSection = (model.sectionNodes || model.projectSectionNodes || [])
    .find((node) => node.ranges?.some((range: number[]) => offset >= range[0] && offset < range[1]));
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

function nodeSourceRanges(text: string, node: NavigatorTarget | undefined, focusOffset?: number): Array<[number, number]> {
  if (!node || node.kind === 'global-group' || node.kind === 'properties-group'
    || node.kind === 'navigator-loading' || node.kind === 'navigator-error') return [];
  let ranges: Array<[number, number]> = [];
  if (node.kind === 'ai-step' && isInteger(node.startLine)) {
    ranges = [[
      offsetAtLine(text, node.startLine),
      offsetAtLine(text, Math.max(node.startLine, node.endLine || node.startLine) + 1)
    ]];
  } else if (Array.isArray(node.ranges) && node.ranges.length > 0) {
    ranges = node.ranges;
  } else if (node.kind === 'routine') {
    if (isInteger(node.implementationOffset)) {
      ranges.push([
        lineStartOffset(text, node.implementationOffset),
        node.implementationEndOffset ?? lineEndOffset(text, node.implementationOffset)
      ]);
    }
    if (isInteger(node.declarationOffset)) {
      ranges.push([
        lineStartOffset(text, node.declarationOffset),
        node.declarationEndOffset ?? lineEndOffset(text, node.declarationOffset)
      ]);
    }
  } else {
    const start = node.offset ?? node.declarationOffset;
    if (isInteger(start)) {
      ranges = [[
        lineStartOffset(text, start),
        node.declarationEndOffset ?? lineEndOffset(text, start)
      ]];
    }
  }
  const normalized = ranges
    .map(([start, end]): [number, number] => [
      Math.max(0, Math.min(text.length, start)),
      Math.max(0, Math.min(text.length, end))
    ])
    .filter(([start, end]) => end >= start);
  if (!isInteger(focusOffset)) return normalized;
  const focused = normalized.find(([start, end]) => focusOffset >= start && focusOffset < end);
  return focused ? [focused] : normalized.slice(0, 1);
}

function highlightNodeForExpandedSteps(text: string, node: NavigatorTarget | undefined, focusOffset: number, expandedRoutineIds?: Set<string>): NavigatorTarget | undefined {
  if (!node || node.kind !== 'routine' || !expandedRoutineIds?.has(node.id || '')
    || !isInteger(focusOffset)) return node;
  const implementationStart = node.implementationOffset;
  const implementationEnd = node.implementationEndOffset;
  if (!isInteger(implementationStart) || !isInteger(implementationEnd)
    || focusOffset < implementationStart || focusOffset >= implementationEnd) return node;
  const steps = (node.children || [])
    .filter((child) => child.kind === 'ai-step' && isInteger(child.startLine))
    .sort((left, right) => left.startLine! - right.startLine!);
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
  return focusOffset < offsetAtLine(text, steps[0].startLine!) ? steps[0] : node;
}

function highlightExpandedAiStepAt(text: string, step: NavigatorTarget, focusOffset: number, expandedNodeIds?: Set<string>): NavigatorTarget {
  if (!step?.children?.length || !expandedNodeIds?.has(step.id || '')) return step;
  const children = step.children
    .filter((child) => child.kind === 'ai-step' && isInteger(child.startLine))
    .sort((left, right) => left.startLine! - right.startLine!);
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

/** Resolve the tree row that should track an editor location. */
function activeFollowNodeAt(text: string, model: Partial<NavigatorModel> | undefined, offset: number, expandedRoutineIds?: Set<string>) {
  return highlightNodeForExpandedSteps(
    text,
    activeNodeAt(model, offset),
    offset,
    expandedRoutineIds
  );
}

function navigationRevealPlan(startLine: number, endLine: number, visibleLineCount: number, mode = 'smart', startPercent = 25) {
  const firstLine = Math.max(0, Number.isFinite(startLine) ? Math.floor(startLine) : 0);
  const lastLine = Math.max(firstLine, Number.isFinite(endLine) ? Math.floor(endLine) : firstLine);
  const viewportLines = Math.max(1, Number.isFinite(visibleLineCount)
    ? Math.floor(visibleLineCount)
    : 1);
  const normalizedMode = inList(mode, ['smart', 'center', 'top', PascalKeyword.Default]) ? mode : 'smart';
  const normalizedPercent = Math.max(0, Math.min(100,
    Number.isFinite(startPercent) ? startPercent : 25));
  const blockLines = lastLine - firstLine + 1;

  if (normalizedMode === PascalKeyword.Default) {
    return { kind: PascalKeyword.Default, startLine: firstLine, endLine: lastLine };
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

function viewportFollowLine(startLine: number, endLine: number, offsetLines = 1) {
  const first = Math.max(0, Number.isFinite(startLine) ? Math.floor(startLine) : 0);
  const last = Math.max(first, Number.isFinite(endLine) ? Math.floor(endLine) : first);
  const offset = Math.max(-20, Math.min(20,
    Number.isFinite(offsetLines) ? Math.round(offsetLines) : 1));
  return Math.max(first, Math.min(last, Math.floor((first + last) / 2) + offset));
}

// GLM 5.2 accepts `minimal`, but some OpenAI-compatible gateways sometimes
// complete that fast path without emitting a normal response body. Keep the
// fast default and pay for the more reliable effort only after a bad response.
function aiRetryReasoningEffort(reasoningEffort: string) {
  return reasoningEffort === 'minimal' ? 'low' : reasoningEffort;
}

function pendingNavigatorModel(filePath: string, label = 'Analyzing current file in the background…', kind = 'navigator-loading'): NavigatorModel {
  const loading: NavigatorNode = {
    id: `loading:${filePath}`,
    kind,
    label,
    children: []
  };
  return {
    implementationRoutines: [], propertyNodes: [],
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
  vscode: NavigatorApi;
  output: OutputChannel | undefined;
  context: NavigatorContext | undefined;
  changed;
  onDidChangeTreeData;
  cache: ModelCache | undefined;
  activeState: NavigatorActiveState | undefined;
  aiCache: Map<string, AiCacheEntry>;
  aiChunkCache: Map<string, string>;
  aiSessionKeys: Set<string>;
  aiPending: Map<string, PendingAiSteps>;
  modelWorker: Worker | undefined;
  modelWorkerKey: string | undefined;
  onModelReady: (() => void) | undefined;
  nodeDocumentUris: WeakMap<NavigatorTarget, string>;
  isNodeExpanded: ((node: NavigatorTarget, documentUri?: string) => boolean) | undefined;

  constructor(vscode: NavigatorApi, output?: OutputChannel, context?: NavigatorContext) {
    this.vscode = vscode;
    this.output = output;
    this.context = context;
    this.changed = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changed.event;
    this.cache = undefined;
    this.activeState = undefined;
    const savedEntries = context?.workspaceState.get<unknown>(AI_STEP_CACHE_STATE_KEY, {});
    this.aiCache = new Map();
    if (isRecord(savedEntries)) {
      for (const [key, value] of Object.entries(savedEntries)) if (isAiCacheEntry(value)) this.aiCache.set(key, value);
    }
    const savedChunkEntries = context?.workspaceState.get<unknown>(AI_STEP_CHUNK_CACHE_STATE_KEY, {});
    this.aiChunkCache = new Map();
    if (isRecord(savedChunkEntries)) {
      for (const [key, value] of Object.entries(savedChunkEntries)) if (typeof value === 'string') this.aiChunkCache.set(key, value);
    }
    this.aiSessionKeys = new Set();
    this.aiPending = new Map();
    this.modelWorker = undefined;
    this.modelWorkerKey = undefined;
    this.onModelReady = undefined;
    this.nodeDocumentUris = new WeakMap();
    this.isNodeExpanded = undefined;
  }

  activeDocument() {
    const document = this.vscode.window?.activeTextEditor?.document;
    return isClassNavigatorDocument(document) ? document : undefined;
  }

  configuration() {
    const config = this.vscode.workspace?.getConfiguration(NavigatorConfigurationSection);
    return {
      showUses: (config?.get('showUses', true) ?? true),
      showGlobalRoutines: (config?.get('showGlobalRoutines', true) ?? true),
      showInterfaces: (config?.get('showInterfaces', true) ?? true),
      showRecordsAndObjects: (config?.get('showRecordsAndObjects', true) ?? true),
      showProperties: (config?.get('showProperties', true) ?? true),
      showProjectPackageEntry: (config?.get('showProjectPackageEntry', true) ?? true),
      showProjectFileEntry: (config?.get('showProjectFileEntry', true) ?? true),
      showUnitInitialization: (config?.get('showUnitInitialization', true) ?? true),
      showUnitFinalization: (config?.get('showUnitFinalization', true) ?? true),
      memberOrder: (config?.get<string>('memberOrder', 'visibility') ?? 'visibility'),
      typeOrder: (config?.get('typeOrder', 'declaration') ?? 'declaration'),
      backgroundParsingEnabled: (config?.get('backgroundParsing.enabled', true) ?? true),
      backgroundParsingThresholdKb: (config?.get('backgroundParsing.thresholdKb', 256) ?? 256),
      aiStepsEnabled: (config?.get('aiSteps.enabled', true) ?? true)
    };
  }

  aiConfiguration(document = this.activeDocument()): AiSettings {
    const config = this.vscode.workspace?.getConfiguration(ConfigurationSection, document?.uri);
    return {
      enabled: (config?.get(SettingKey.ClassNavigatorAiStepsEnabled, true) ?? true),
      provider: (config?.get(SettingKey.ClassNavigatorAiStepsProvider, 'oaicopilot') ?? 'oaicopilot'),
      modelId: (config?.get(SettingKey.ClassNavigatorAiStepsModelId, '') ?? ''),
      reasoningEffort: (config?.get(SettingKey.ClassNavigatorAiStepsReasoningEffort, 'low') ?? 'low'),
      granularity: (config?.get(SettingKey.ClassNavigatorAiStepsGranularity, 'coarse') ?? 'coarse'),
      normalTargetLines: (config?.get(SettingKey.ClassNavigatorAiStepsNormalTargetLines, 20) ?? 20),
      detailedTargetLines: (config?.get(SettingKey.ClassNavigatorAiStepsDetailedTargetLines, 10) ?? 10),
      maxSteps: (config?.get(SettingKey.ClassNavigatorAiStepsMaxSteps, 5) ?? 5),
      substepsEnabled: (config?.get(SettingKey.ClassNavigatorAiStepsSubstepsEnabled, true) ?? true),
      maxSubsteps: (config?.get(SettingKey.ClassNavigatorAiStepsSubstepsMaxPerStep, 5) ?? 5),
      substepMinParentLines: (config?.get(SettingKey.ClassNavigatorAiStepsSubstepsMinParentLines, 30) ?? 30),
      maxDepth: (config?.get(SettingKey.ClassNavigatorAiStepsSubstepsMaxDepth, 3) ?? 3),
      maxSourceCharacters: (config?.get(SettingKey.ClassNavigatorAiStepsMaxSourceCharacters, 24000) ?? 24000),
      requestTimeoutSeconds: (config?.get(SettingKey.ClassNavigatorAiStepsRequestTimeoutSeconds, 180) ?? 180),
      cacheEnabled: (config?.get(SettingKey.ClassNavigatorAiStepsCacheEnabled, true) ?? true),
      skipCached: true
    };
  }

  routineForNode(node: NavigatorTarget | undefined): NavigatorNode | undefined {
    for (let current = node; current; current = current.parent) {
      if (isNavigatorRoutine(current)) return current;
    }
    return undefined;
  }

  aiRequestFor(node: NavigatorNode | undefined, document = this.activeDocument(), text = document?.getText(), overrides: Partial<AiSettings> = {}): AiRequest | undefined {
    const routine = this.routineForNode(node);
    if (!document || text === undefined || !routine || !isInteger(routine.implementationOffset)) return undefined;
    const settings = { ...this.aiConfiguration(document), ...overrides };
    const key = routineAnalysisKey(document.uri.toString(), text, routine, settings);
    const analysis = buildAiStepPrompt(text, routine, {
      ...settings,
      chunkLabelCache: this.aiChunkCache
    });
    if (!key || !analysis) return undefined;
    let reusedChunkCache = false;
    if (analysis.fixedPlan && (analysis.unresolvedIds || []).length === 0 && !this.aiCache.has(key)) {
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

  hasAiSteps(request: AiRequest) {
    const cached = request?.key ? this.aiCache.get(request.key) : undefined;
    return Boolean(cached?.steps?.length
      && (request.settings.cacheEnabled || this.aiSessionKeys.has(request.key)));
  }

  invalidateAiPresentation() {
    this.cache = undefined;
    this.changed.fire(undefined);
  }

  refreshAiRoutine(request: AiRequest) {
    const document = this.activeDocument();
    if (!document || !request
      || document.uri.toString() !== request.document.uri.toString()) return false;
    const model = this.model();
    const identity = this.nodeIdentity(request.routine);
    const routine = (model?.routineNodes || []).find((candidate) =>
      this.nodeIdentity(candidate) === identity);
    if (!routine) return false;
    routine.children = (routine.children || []).filter((child) =>
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
    // The webview diffs this routine's presentation against its last snapshot;
    // unchanged rows retain their DOM elements and navigation state.
    this.changed.fire(routine);
    return true;
  }

  beginAiGeneration(request: AiRequest, options: { refresh?: boolean } = {}) {
    this.aiPending.set(request.key, {
      startedAt: Date.now(),
      documentUri: request.document.uri.toString(),
      routineIdentity: this.nodeIdentity(request.routine),
      settings: request.settings
    });
    if (options.refresh !== false) this.refreshAiRoutine(request);
  }

  updateAiGeneration(request: AiRequest, steps: AiStep[]) {
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

  async completeAiGeneration(request: AiRequest, steps: AiStep[], model: { id: string; name: string }, options: { persist?: boolean; refresh?: boolean } = {}) {
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

  failAiGeneration(request: AiRequest, options: { refresh?: boolean } = {}) {
    if (!request?.key) return;
    this.aiPending.delete(request.key);
    if (options.refresh !== false) this.refreshAiRoutine(request);
  }

  applyAiSteps(model: NavigatorModel, document: NavigatorDocument): void {
    const settings = this.aiConfiguration(document);
    if (!settings.enabled) return;
    const text = document.getText();
    const documentUri = document.uri.toString();
    // Computing a content hash and line range for every routine in a very large
    // unit is unnecessary when almost none has AI data. First filter by the
    // persisted/session metadata, then hash only routines that can actually
    // gain step children or a loading child.
    const cachedByRoutine = new Map<string, Array<{ key: string; cached: AiCacheEntry }>>();
    for (const [key, cached] of this.aiCache) {
      if (cached?.documentUri === documentUri && cached.routine) {
        if (!cachedByRoutine.has(cached.routine)) cachedByRoutine.set(cached.routine, []);
        cachedByRoutine.get(cached.routine)!.push({ key, cached });
      }
    }
    const pendingByRoutine = new Map<string, Array<{ key: string; pending: PendingAiSteps }>>();
    for (const [key, pending] of this.aiPending) {
      if (pending?.documentUri === documentUri && pending.routineIdentity) {
        if (!pendingByRoutine.has(pending.routineIdentity)) pendingByRoutine.set(pending.routineIdentity, []);
        pendingByRoutine.get(pending.routineIdentity)!.push({ key, pending });
      }
    }
    if (cachedByRoutine.size === 0 && pendingByRoutine.size === 0) return;
    for (const routine of model.routineNodes || []) {
      const identity = this.nodeIdentity(routine);
      const pendingEntry = (pendingByRoutine.get(identity) || []).find((entry) =>
        routineAnalysisKey(documentUri, text, routine, entry.pending.settings || settings) === entry.key);
      const cachedEntry = (cachedByRoutine.get(identity) || [])
        .filter((entry) => routineAnalysisKey(
          documentUri,
          text,
          routine,
          entry.cached.settings || settings
        ) === entry.key)
        .sort((left, right) => (right.cached.generatedAt || 0) - (left.cached.generatedAt || 0))[0];
      if (!pendingEntry && !cachedEntry) continue;
      routine.children = (routine.children || []).filter((child) =>
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
        const loading: NavigatorNode = {
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

  modelKey(document: NavigatorDocument) {
    return `${document.uri.toString()}@${document.version}@${JSON.stringify(this.configuration())}`;
  }

  cancelModelWorker() {
    if (this.modelWorker) void this.modelWorker.terminate();
    this.modelWorker = undefined;
    this.modelWorkerKey = undefined;
  }

  buildLargeModel(document: NavigatorDocument, text: string, options: NavigatorOptions, key: string) {
    if (this.modelWorkerKey === key) return;
    this.cancelModelWorker();
    const worker = new Worker(path.join(__dirname, NavigatorResource.Worker));
    this.modelWorker = worker;
    this.modelWorkerKey = key;
    const finish = () => {
      if (this.modelWorker === worker) {
        this.modelWorker = undefined;
        this.modelWorkerKey = undefined;
      }
      void worker.terminate();
    };
    worker.once('message', (value: unknown) => {
      const message = isNavigatorWorkerResponse(value) ? value : { error: 'Invalid class navigator worker response.' };
      const current = this.modelWorker === worker;
      finish();
      const activeDocument = this.activeDocument();
      if (!current || !activeDocument || this.modelKey(activeDocument) !== key) return;
      if (message.error !== undefined) {
        this.output?.appendLine(`Large-file class navigator failed: ${message.error}`);
        this.cache = {
          key, documentUri: document.uri.toString(),
          stale: Boolean(this.cache?.retainedModel),
          model: this.cache?.retainedModel
            || pendingNavigatorModel(document.fileName, 'Class navigator analysis failed. Click refresh to retry.', 'navigator-error')
        };
      } else {
        this.applyAiSteps(message.model, activeDocument);
        this.cache = { key, documentUri: document.uri.toString(), model: message.model };
        this.output?.appendLine(
          `Large-file class navigator ready: ${path.basename(document.fileName)} `
          + `(${text.length} characters, ${message.elapsedMs} ms in worker).`
        );
      }
      this.changed.fire(undefined);
      this.onModelReady?.();
    });
    worker.once('error', error => {
      const current = this.modelWorker === worker;
      finish();
      if (!current || this.cache?.key !== key) return;
      this.output?.appendLine(`Large-file class navigator worker failed: ${error.stack || error.message}`);
      this.cache = {
        key, documentUri: document.uri.toString(),
        stale: Boolean(this.cache.retainedModel),
        model: this.cache.retainedModel
          || pendingNavigatorModel(document.fileName, 'Class navigator analysis failed. Click refresh to retry.', 'navigator-error')
      };
      this.changed.fire(undefined);
    });
    worker.postMessage({ text, filePath: document.fileName, options });
  }

  /** Update source data while retaining the visible tree during background parsing. */
  model(): NavigatorModel | undefined {
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
      // A loading placeholder is only needed for the first parse of a file.
      // Replacing an existing tree here would discard its rows on every edit.
      const retainedModel = this.cache?.documentUri === document.uri.toString()
        && !this.cache.model.roots.some((node) => /^navigator-(?:loading|error)$/.test(node.kind))
        ? this.cache.model : undefined;
      const model = retainedModel || pendingNavigatorModel(document.fileName);
      this.cache = { key, documentUri: document.uri.toString(), model, retainedModel, pending: true };
      this.buildLargeModel(document, text, options, key);
      return model;
    }
    this.cancelModelWorker();
    const model = /\.dproj$/i.test(document.fileName)
      ? buildDprojNavigatorModel(text, document.fileName, options)
      : buildClassNavigatorModel(text, document.fileName, options);
    this.applyAiSteps(model, document);
    this.cache = { key, documentUri: document.uri.toString(), model };
    return model;
  }

  /** Notify data consumers; the webview emits only differences in visible data. */
  refresh({ force = false } = {}) {
    if (force && this.cache) this.cache.key = undefined;
    // URI, version and all model options are already part of the cache key.
    // Keeping a still-valid model avoids parsing twice when a click/scroll lands
    // just before the debounced document refresh.
    this.changed.fire(undefined);
  }

  async readyModel(document = this.activeDocument()): Promise<NavigatorModel | undefined> {
    if (!document) return undefined;
    let model = this.model();
    if (!this.cache?.pending) return this.cache?.stale ? undefined : model;
    return new Promise(resolve => {
      const disposable = this.onDidChangeTreeData(() => {
        if (this.activeDocument()?.uri.toString() !== document.uri.toString()) {
          disposable.dispose();
          resolve(undefined);
          return;
        }
        model = this.model();
        if (this.cache?.pending) return;
        disposable.dispose();
        resolve(this.cache?.stale ? undefined : model);
      });
    });
  }

  nodeIdentity(node: NavigatorTarget) {
    return [node.kind, node.owner || '', node.name || node.label || '', node.signature || node.typeName || '']
      .join('|').toLowerCase();
  }

  setActiveNode(node: NavigatorTarget | undefined) {
    const document = this.activeDocument();
    if (!document || !node) return false;
    const next = {
      documentUri: document.uri.toString(),
      id: node.id || '',
      identity: this.nodeIdentity(node)
    };
    if (this.activeState?.id === node.id && this.activeState?.documentUri === next.documentUri) {
      this.activeState = next;
      return false;
    }
    this.activeState = next;
    return true;
  }

  getParent(node: NavigatorTarget) {
    return node.parent;
  }

  getChildren(node?: NavigatorTarget) {
    if (node) return node.children || [];
    return this.model()?.roots || [];
  }

  getTreeItem(node: NavigatorTarget) {
    const vscode = this.vscode;
    if (!vscode.TreeItem || !vscode.TreeItemCollapsibleState || !vscode.ThemeColor || !vscode.ThemeIcon) return undefined;
    const documentUri = this.activeDocument()?.uri.toString();
    if (documentUri && node && typeof node === "object") {
      this.nodeDocumentUris.set(node, documentUri);
    }
    const hasChildren = Boolean(node.children?.length);
    const collapsible = hasChildren
      ? (this.isNodeExpanded?.(node, documentUri)
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed)
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label || '', collapsible);
    // Semantic IDs survive source edits. Add the URI for native tree consumers
    // so virtual documents with the same file name also have separate state.
    item.id = documentUri ? `${documentUri}::${node.id}` : node.id;
    item.contextValue = `${NavigatorContextKey.NodePrefix}${node.kind}`;
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
    else if (node.kind === PascalKeyword.Unit) item.iconPath = new vscode.ThemeIcon('symbol-namespace');
    else if (node.kind === 'global-group') item.iconPath = new vscode.ThemeIcon('globe');
    else if (node.kind === 'project-package-section') {
      item.iconPath = new vscode.ThemeIcon(PascalKeyword.Package);
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
    else if (node.kind === PascalKeyword.Property) {
      item.iconPath = new vscode.ThemeIcon('symbol-property', accessColor);
      item.tooltip = `${node.access || PascalKeyword.Public} property ${node.name}${node.typeName ? `: ${node.typeName}` : ''}`;
    }
    else if (node.kind === 'ai-step') {
      item.iconPath = new vscode.ThemeIcon('list-ordered', new vscode.ThemeColor('charts.purple'));
      item.tooltip = (node.endLine || 0) > (node.startLine || 0)
        ? `AI-generated routine steps · lines ${node.startLine}–${node.endLine}`
        : `AI-generated routine steps · line ${node.startLine}`;
    }
    else if (node.kind === 'ai-step-loading') {
      item.iconPath = new vscode.ThemeIcon('loading~spin');
      item.tooltip = 'Summarizing the current routine with the OAI Compatible model.';
    }
    else if (node.kind === PascalKeyword.Type) {
      const icon = node.typeKind === PascalKeyword.Interface
        ? 'symbol-interface'
        : node.typeKind === PascalKeyword.Record || node.typeKind === PascalKeyword.Object
          ? 'symbol-object'
          : 'symbol-class';
      item.iconPath = new vscode.ThemeIcon(icon);
      item.tooltip = `${node.typeKind} ${node.name}`;
    } else if (node.kind === 'routine') {
      const lifecycle = inList(node.specialRoutineKind, [PascalKeyword.Constructor, PascalKeyword.Destructor, 'initialize', 'finalize']);
      const icon = routineIconName(node);
      const flavor = lifecycle
        ? 'Lifecycle method'
        : node.specialRoutineKind === PascalKeyword.Operator
          ? 'Operator'
          : node.routineFlavor === PascalKeyword.Static
            ? 'Static method'
            : node.routineFlavor === PascalKeyword.Class
              ? 'Class method'
              : node.routineFlavor === 'local'
                ? 'Local routine'
                : undefined;
      item.iconPath = new vscode.ThemeIcon(
        icon,
        node.missingCounterpart ? new vscode.ThemeColor('errorForeground')
          : lifecycle ? new vscode.ThemeColor('charts.purple') : accessColor
      );
      item.tooltip = `${flavor ? `${flavor} · ` : ''}${node.access ? `${node.access} · ` : ''}${node.signature || `${node.routineKind} ${node.name}`}`;
      const missing = missingCounterpartMessage(node);
      if (missing) item.tooltip += `\n${missing}`;
    }
    if (node.kind === 'uses-group') item.tooltip = 'Uses in the current file. Click to go to the uses clause; imported packages are not expanded.';
    if (node.kind === 'uses-section') {
      item.tooltip = `${node.section === PascalKeyword.Interface ? PascalKeyword.Interface : PascalKeyword.Implementation} uses. Click to navigate to and mark this uses block.`;
    }
    if (isInteger(node.offset) || isInteger(node.declarationOffset)) {
      item.command = {
        command: NavigatorCommandId.Open,
        title: 'Go to',
        arguments: [node]
      };
    }
    return item;
  }

  documentUriForNode(node: NavigatorTarget) {
    return node && typeof node === "object" ? this.nodeDocumentUris.get(node) : undefined;
  }

  dispose() {
    this.cancelModelWorker();
  }
}

function navigatorIconName(node: NavigatorTarget) {
  if (node.kind === 'project') return 'project';
  if (node.kind === PascalKeyword.Package) return PascalKeyword.Package;
  if (node.kind === NavigatorItemKind.File) return inList(path.extname(node.filePath || '').toLowerCase(), [FileExtension.Package, FileExtension.Program, FileExtension.Project])
    ? 'project-file'
    : NavigatorItemKind.File;
  if (node.kind === 'uses-group' || node.kind === 'uses-section') return 'references';
  if (node.kind === 'navigator-loading') return 'loading';
  if (node.kind === 'navigator-error') return 'error';
  if (node.kind === PascalKeyword.Unit) return 'namespace';
  if (node.kind === 'global-group') return 'global';
  if (node.kind === 'project-package-section') return PascalKeyword.Package;
  if (node.kind === 'project-file-section') return 'files';
  if (new RegExp(String.raw`^${PascalKeyword.Unit}-(?:${PascalKeyword.Initialization}|${PascalKeyword.Finalization})-section$`).test(node.kind || '')) return 'symbol-function';
  if (node.kind === 'properties-group') return 'properties';
  if (node.kind === PascalKeyword.Property) return PascalKeyword.Property;
  if (node.kind === 'ai-step') return 'list-ordered';
  if (node.kind === 'ai-step-loading') return 'loading';
  if (node.kind === PascalKeyword.Type) return node.typeKind === PascalKeyword.Interface
    ? PascalKeyword.Interface
    : node.typeKind === PascalKeyword.Record || node.typeKind === PascalKeyword.Object ? PascalKeyword.Object : PascalKeyword.Class;
  if (node.kind === 'routine') return routineIconName(node);
  return 'symbol';
}

/** Explain the red method state in both the tree and search tooltips. */
function missingCounterpartMessage(node: NavigatorTarget) {
  if (node.missingCounterpart === PascalKeyword.Implementation) return 'Missing implementation for this class method.';
  if (node.missingCounterpart === 'declaration') return 'Missing declaration for this class method.';
  return '';
}

function navigatorNodeTooltip(node: NavigatorTarget) {
  const tooltip = node.signature || node.typeName || node.filePath || node.projectPath
    || node.groupPath || node.fsPath || '';
  const missing = missingCounterpartMessage(node);
  return missing ? `${tooltip}\n${missing}`.trim() : tooltip;
}

function serializeNavigatorNode(node: NavigatorTarget, options: { projectDefaultExpansion?: string } = {}): NavigatorTreePresentation {
  return {
    id: node.id || '',
    kind: node.kind,
    label: node.label || '',
    access: node.access,
    missingCounterpart: node.missingCounterpart,
    icon: navigatorIconName(node),
    jumpable: isInteger(node.offset) || isInteger(node.declarationOffset),
    tooltip: navigatorNodeTooltip(node),
    contextValue: node.contextValue,
    initialExpanded: node.kind === 'project'
      || (node.kind === PascalKeyword.Package && options.projectDefaultExpansion === 'all'),
    children: (node.children || []).map((child) => serializeNavigatorNode(child, options))
  };
}

function navigatorNodePath(node: NavigatorTarget | undefined): string[] {
  const result = [];
  for (let current = node?.parent; current; current = current.parent) result.unshift(current.id);
  return result;
}

function navigatorNodeById(model: Pick<NavigatorModel, "roots"> | undefined, id: string) {
  if (!id) return undefined;
  const pending = [...(model?.roots || [])];
  while (pending.length) {
    const node = pending.shift()!;
    if (node.id === id) return node;
    pending.unshift(...(node.children || []));
  }
  return undefined;
}

function registerClassNavigator(context: VSCode.ExtensionContext, output: OutputChannel, vscodeApi?: typeof VSCode, projectProvider?: ProjectNavigatorProvider, projectSourceIndexPromise?: Promise<Pick<SourceIndex, "files" | "definitions">>) {
  const vscode: typeof VSCode = vscodeApi || require('vscode');
  const provider = new ClassNavigatorProvider(vscode, output, context);
  const initialConfiguration = vscode.workspace.getConfiguration(ConfigurationSection);
  let navigatorMode: string = context.workspaceState.get<string>(NAVIGATOR_MODE_STATE_KEY, NavigatorMode.Class);
  if (!initialConfiguration.get(SettingKey.ClassNavigatorEnabled, true)
    && initialConfiguration.get(SettingKey.ProjectNavigatorEnabled, true)
    && projectProvider) navigatorMode = 'project';
  if (navigatorMode === 'project'
    && (!projectProvider || !initialConfiguration.get(SettingKey.ProjectNavigatorEnabled, true))) navigatorMode = NavigatorMode.Class;
  const combinedChanged = new vscode.EventEmitter();
  const activeProvider = () => navigatorMode === 'project' && projectProvider
    ? projectProvider
    : provider;
  const tree = new ClassNavigatorWebview(vscode, NavigatorViewId, {
    getRoots: () => activeProvider().getChildren(),
    serializeNode: (node) => serializeNavigatorNode(node, {
      projectDefaultExpansion: vscode.workspace.getConfiguration(ConfigurationSection)
        .get(SettingKey.ProjectNavigatorDefaultExpansion, 'firstLevel')
    }),
    nodePath: navigatorNodePath,
    capabilities: () => ({
      aiSteps: vscode.workspace.getConfiguration(ConfigurationSection).get(SettingKey.ClassNavigatorAiStepsEnabled, true),
      aiGenerating: Boolean(activeAiCancellation),
      projectContextMenus: vscode.workspace.getConfiguration(ConfigurationSection)
        .get(SettingKey.ProjectNavigatorContextMenusEnabled, true)
    }),
    onOpen: (node) => navigatorMode === 'project' && node.kind === NavigatorItemKind.File
      ? vscode.commands.executeCommand('vscode.open', vscode.Uri.file(node.filePath || ''))
      : openNode(node),
    onSearch: (message) => performNavigatorSearch(message),
    onSearchOptions: (options) => saveNavigatorSearchOptions(options),
    onSearchActivate: (message) => activateNavigatorSearchResult(message),
    onSearchClosed: (restoreState) => closeNavigatorSearch(true, restoreState),
    onSortUpdate: async (message) => {
      const allowed: Record<string, string[]> = {
        memberOrder: ['visibility', 'declaration', PascalKeyword.Implementation],
        typeOrder: ['declaration', 'alphabetical']
      };
      if (!allowed[message.key]?.includes(message.value)) return;
      await vscode.workspace.getConfiguration(NavigatorConfigurationSection)
        .update(message.key, message.value, true);
    },
    onFocusChanged: (focused) => vscode.commands.executeCommand(
      'setContext',
      NavigatorContextKey.WebviewFocused,
      Boolean(focused)
    )
  });
  const webviewRegistration = tree.register(context);
  void vscode.commands.executeCommand(
    'setContext',
    NavigatorContextKey.WebviewFocused,
    false
  );
  const navigationRangeDecoration = vscode.window.createTextEditorDecorationType({
    // VS Code has no public per-line-number background decoration. A narrow
    // continuous marker in the glyph/line-number gutter is the closest native
    // rendering that never paints over the source text itself.
    gutterIconPath: vscode.Uri.file(context.asAbsolutePath(NavigatorResource.RangeMarker)),
    gutterIconSize: 'contain'
  });
  let refreshTimer: string|number|NodeJS.Timeout|undefined;
  let lastDocumentEditAt = 0;
  let lastDocumentEditUri: string | undefined;
  let followTimer: string|number|NodeJS.Timeout|undefined;
  let layoutTimer: string|number|NodeJS.Timeout|undefined;
  let layoutPending = false;
  let navigationLock: { documentUri: string; nodeId: string } | undefined;
  let navigationHoldUntil = 0;
  let navigatorVisible = tree.visible;
  let activeNavigationHighlight: { editor: VSCode.TextEditor; nodeId: string; focusOffset: number; documentUri: string; lineRanges: Array<{ startLine: number; endLine: number }> } | undefined;
  let activeAiCancellation: VSCode.CancellationTokenSource | undefined;
  const setAiGeneratingContext = (value: boolean) => {
    void tree.updateCapabilities();
    return vscode.commands.executeCommand(
      'setContext',
      NavigatorContextKey.AiGenerating,
      Boolean(value)
    );
  };
  const beginAiOperation = () => {
    if (activeAiCancellation) return undefined;
    activeAiCancellation = new vscode.CancellationTokenSource();
    void setAiGeneratingContext(true);
    return activeAiCancellation;
  };
  const finishAiOperation = (source: VSCode.CancellationTokenSource) => {
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
  const savedExpandedRoutines = context.workspaceState.get<Record<string, string[]>>(EXPANDED_ROUTINES_STATE_KEY, {});
  const expandedRoutineIdsByDocument = new Map(
    Object.entries(savedExpandedRoutines && typeof savedExpandedRoutines === "object"
      ? savedExpandedRoutines
      : {}).map(([uri, ids]) => [uri, new Set(Array.isArray(ids) ? ids : [])])
  );
  const expandedRoutineIds = (documentUri?: string): Set<string> => {
    const uri = documentUri || provider.activeDocument()?.uri.toString();
    if (!uri) return new Set();
    if (!expandedRoutineIdsByDocument.has(uri)) expandedRoutineIdsByDocument.set(uri, new Set());
    return expandedRoutineIdsByDocument.get(uri)!;
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
    Boolean(node?.children?.length && expandedRoutineIds(documentUri).has(node.id || ''));

  const clearNavigationHighlight = () => {
    const editor = activeNavigationHighlight?.editor;
    if (editor && !editor.document.isClosed) editor.setDecorations(navigationRangeDecoration, []);
    activeNavigationHighlight = undefined;
  };
  const showNavigationHighlight = (editor: VSCode.TextEditor, node: NavigatorTarget | undefined, focusOffset: number) => {
    clearNavigationHighlight();
    if (!editor || !node) return;
    const config = vscode.workspace.getConfiguration(ConfigurationSection, editor.document.uri);
    if (!(config?.get(SettingKey.ClassNavigatorHighlightRangeEnabled, true) ?? true)) return;
    const text = editor.document.getText();
    const highlightNode = highlightNodeForExpandedSteps(
      text,
      node,
      focusOffset,
      expandedRoutineIds()
    );
    if (highlightNode?.kind === 'ai-step'
      && !(config?.get(SettingKey.ClassNavigatorAiStepsHighlightRange, true) ?? true)) return;
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
      nodeId: highlightNode?.id || '',
      focusOffset,
      lineRanges
    };
  };
  const refreshHighlightForRoutineExpansion = (routine: NavigatorTarget | undefined) => {
    const highlight = activeNavigationHighlight;
    const editor = vscode.window.activeTextEditor;
    if (!routine || !highlight || !editor || highlight.documentUri !== editor.document.uri.toString()
      || !isInteger(highlight.focusOffset)) return;
    const model = provider.model();
    if (provider.cache?.pending || provider.cache?.stale) return;
    const activeNode = activeNodeAt(model, highlight.focusOffset);
    if (provider.routineForNode(activeNode)?.id !== routine.id) return;
    showNavigationHighlight(editor, activeNode, highlight.focusOffset);
  };
  const clearNavigationHighlightOutsideCursor = (editor: VSCode.TextEditor) => {
    const highlight = activeNavigationHighlight;
    if (!highlight) return;
    if (highlight.editor !== editor) {
      clearNavigationHighlight();
      return;
    }
    const line = editor.selection.active.line;
    if (!highlight.lineRanges.some((range) => line >= range.startLine && line <= range.endLine)) {
      clearNavigationHighlight();
    }
  };
  const clearNavigationHighlightOutsideViewport = (event: VSCode.TextEditorVisibleRangesChangeEvent) => {
    const highlight = activeNavigationHighlight;
    if (!highlight) return;
    if (highlight.editor !== event.textEditor) return;
    const intersects = event.visibleRanges.some((visible) => highlight.lineRanges.some((range) =>
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
    const config = vscode.workspace.getConfiguration(ConfigurationSection);
    return (config?.get(SettingKey.Enabled, true) ?? true)
      && (config?.get(SettingKey.ClassNavigatorEnabled, true) ?? true)
      && (config?.get(SettingKey.ClassNavigatorFollowCursor, true) ?? true);
  };
  const pauseWhileCollapsed = () => vscode.workspace.getConfiguration(ConfigurationSection)
    .get(SettingKey.ClassNavigatorPauseWhenCollapsed, true);
  const navigatorCanTrack = () => navigatorMode === NavigatorMode.Class && followEnabled()
    && (!pauseWhileCollapsed() || navigatorVisible);
  const revealFollowNode = (node: NavigatorTarget | undefined) => {
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
  const visibleCenterOffset = (editor: VSCode.TextEditor, visibleRanges: readonly VSCode.Range[]) => {
    if (!visibleRanges?.length) return undefined;
    const range = visibleRanges.reduce((largest, candidate) =>
      candidate.end.line - candidate.start.line > largest.end.line - largest.start.line
        ? candidate
        : largest);
    const configuredOffset = vscode.workspace.getConfiguration(ConfigurationSection, editor.document.uri)
      .get(SettingKey.ClassNavigatorScrollFollowOffsetLines, 1);
    const line = Math.min(
      editor.document.lineCount - 1,
      viewportFollowLine(range.start.line, range.end.line, configuredOffset)
    );
    return editor.document.offsetAt(new vscode.Position(line, 0));
  };
  const applyFollow = (reason = 'cursor', event?: VSCode.TextEditorVisibleRangesChangeEvent | VSCode.TextEditorSelectionChangeEvent) => {
    if (!navigatorCanTrack()) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isClassNavigatorDocument(editor.document)) return;
    // Typing also scrolls the editor. Defer both cursor and viewport following
    // so these events cannot bypass the document refresh debounce.
    if (reason !== 'mouse' && lastDocumentEditUri === editor.document.uri.toString()
      && Date.now() - lastDocumentEditAt < DOCUMENT_EDIT_DELAY_MS) return;

    let offset;
    if (reason === 'scroll') {
      if (Date.now() < navigationHoldUntil) return;
      const ranges = event?.textEditor === editor && 'visibleRanges' in event ? event.visibleRanges : editor.visibleRanges;
      // Every real scroll follows the symbol at the viewport centre. A short
      // post-click guard filters only the scroll generated by the jump itself.
      offset = visibleCenterOffset(editor, ranges);
    } else {
      if (navigationLock && reason !== 'mouse') return;
      offset = editor.document.offsetAt(editor.selection.active);
    }
    if (!isInteger(offset)) return;
    const model = provider.model();
    if (provider.cache?.pending || provider.cache?.stale) return; // Retained rows still have the old source ranges.
    const node = activeFollowNodeAt(
      editor.document.getText(),
      model,
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
  const scheduleFollow = (reason = 'cursor', event?: VSCode.TextEditorVisibleRangesChangeEvent | VSCode.TextEditorSelectionChangeEvent) => {
    if (followTimer) clearTimeout(followTimer);
    followTimer = undefined;
    if (!navigatorCanTrack()) return;
    const config = vscode.workspace.getConfiguration(ConfigurationSection);
    const delay = reason === 'scroll'
      ? (config?.get(SettingKey.ClassNavigatorScrollFollowDelayMs, 0) ?? 0)
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
  /** Refresh the view after a caller-selected quiet period. */
  const refresh = (followReason = 'cursor', immediate = false, delayMs = 80) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = undefined;
    const applyRefresh = () => {
      refreshTimer = undefined;
      updatePresentation();
      if (navigatorMode === 'project') {
        projectProvider?.refresh();
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
    refreshTimer = setTimeout(applyRefresh, delayMs);
  };
  const initializeDefaultLayout = async () => {
    if (layoutPending
      || navigatorMode !== NavigatorMode.Class
      || context.workspaceState.get(EXPLORER_LAYOUT_STATE_KEY, 0) >= EXPLORER_LAYOUT_VERSION) return;
    const config = vscode.workspace.getConfiguration(ConfigurationSection);
    const editor = vscode.window.activeTextEditor;
    if (!(config?.get(SettingKey.Enabled, true) ?? true)
      || !(config?.get(SettingKey.ClassNavigatorEnabled, true) ?? true)
      || !(config?.get(SettingKey.ClassNavigatorDefaultOpenBelowExplorer, true) ?? true)
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
      await tree.reveal(firstNode, { select: false, focus: false, expand: false });
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
      output?.appendLine(`Explorer class navigator layout initialization skipped: ${errorMessage(error)}`);
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

  const setNavigatorMode = async (mode: string) => {
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection);
    const next = mode === 'project'
      && projectProvider
      && configuration.get(SettingKey.ProjectNavigatorEnabled, true)
      ? 'project'
      : NavigatorMode.Class;
    if (navigatorMode === next) return;
    navigatorMode = next;
    clearNavigationHighlight();
    if (followTimer) clearTimeout(followTimer);
    followTimer = undefined;
    await context.workspaceState.update(NAVIGATOR_MODE_STATE_KEY, navigatorMode);
    await vscode.commands.executeCommand('setContext', NavigatorContextKey.Mode, navigatorMode);
    updatePresentation();
    activeProvider().refresh?.();
    tree.setMode(navigatorMode);
    if (navigatorMode === NavigatorMode.Class) scheduleFollow('cursor');
  };

  /** Resolve a clicked row against current source data before navigating. */
  const openNode = async (node: NavigatorTarget | undefined, options: { preserveFocus?: boolean } = {}) => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !node) return;
    // A click may arrive during the edit debounce or a background parse. The
    // stable row ID survives the edit, but its stored offsets may have moved.
    const model = await provider.readyModel(document);
    if (!model || provider.activeDocument() !== document) return;
    node = navigatorNodeById(model, node.id || '');
    if (!node) return;
    tree.refresh();
    const offset = node.kind === 'routine'
      ? node.implementationOffset ?? node.declarationOffset
      : node.offset ?? node.declarationOffset;
    if (!isInteger(offset)) return;
    provider.setActiveNode(node);
    navigationLock = {
      documentUri: document.uri.toString(),
      nodeId: node.id || ''
    };
    const holdMs = vscode.workspace.getConfiguration(ConfigurationSection)
      .get(SettingKey.ClassNavigatorNavigationClickHoldMs, 120);
    navigationHoldUntil = Date.now() + Math.max(0, holdMs);
    const position = document.positionAt(Math.min(offset, document.getText().length));
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      // Match Explorer's single-click navigation: reveal the destination while
      // keeping focus on the tree. The native active selection therefore stays
      // blue instead of flashing blue and immediately turning inactive gray.
      preserveFocus: options.preserveFocus ?? vscode.workspace.getConfiguration(ConfigurationSection)
        .get(SettingKey.ClassNavigatorKeepFocusOnNavigationClick, true),
      selection: new vscode.Range(position, position)
    });
    const revealConfig = vscode.workspace.getConfiguration(ConfigurationSection);
    const revealMode = revealConfig.get(SettingKey.ClassNavigatorNavigationRevealMode, 'smart');
    const sourceRange = nodeSourceRanges(document.getText(), node, offset)[0];
    if (sourceRange) {
      const startPosition = document.positionAt(sourceRange[0]);
      const inclusiveEndOffset = Math.max(sourceRange[0], Math.min(
        document.getText().length,
        sourceRange[1]
      ) - 1);
      const endPosition = document.positionAt(inclusiveEndOffset);
      const largestVisibleRange = editor.visibleRanges.reduce<VSCode.Range | undefined>((largest, range) => {
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
        revealConfig.get(SettingKey.ClassNavigatorNavigationRevealLargeBlockStartPercent, 25)
      );
      const fullSourceRange = new vscode.Range(startPosition, document.positionAt(sourceRange[1]));
      if (plan.kind === 'center') {
        editor.revealRange(fullSourceRange, vscode.TextEditorRevealType.InCenter);
      } else if (plan.kind === 'top') {
        editor.revealRange(fullSourceRange, vscode.TextEditorRevealType.AtTop);
      } else if (plan.kind === 'anchor') {
        const anchor = new vscode.Position(plan.anchorLine ?? 0, 0);
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
  let navigatorSearchSession: SearchSession | undefined;
  let navigatorSearchRequest = 0;
  let navigatorSearchActivation = 0;
  let navigatorSearchResults = new Map<string, SearchResult>();

  const saveNavigatorSearchOptions = (options: Partial<NavigatorSearchOptions> | undefined) => {
    navigatorSearchOptions = normalizeNavigatorSearchOptions(options);
    void context.workspaceState.update(SEARCH_OPTIONS_STATE_KEY, navigatorSearchOptions);
  };

  const restoreNavigatorSearchSession = async (session: SearchSession, restoreState: NavigatorTreeState | undefined, activation: number) => {
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

      const selectedNode = navigatorNodeById(model, session.selectedNodeId || '');
      provider.activeState = session.activeState ? { ...session.activeState } : undefined;
      navigationLock = session.navigationLock ? { ...session.navigationLock } : undefined;
      navigationHoldUntil = session.navigationHoldUntil;

      if (session.viewportStart) {
        const viewportAnchor = new vscode.Range(session.viewportStart, session.viewportStart);
        editor.revealRange(viewportAnchor, vscode.TextEditorRevealType.AtTop);
      }
      await tree.restoreSearchState(selectedNode, restoreState);
      if (activation !== navigatorSearchActivation) return;

      const highlightedNode = navigatorNodeById(model, session.highlight?.nodeId || '');
      if (highlightedNode && isInteger(session.highlight?.focusOffset)) {
        showNavigationHighlight(editor, highlightedNode, session.highlight.focusOffset);
      } else {
        clearNavigationHighlight();
      }
    } catch (error) {
      output?.appendLine(`Delphi navigator search restore failed: ${errorStack(error) || errorMessage(error)}`);
    }
  };

  const closeNavigatorSearch = (restore = false, restoreState?: NavigatorTreeState) => {
    const session = navigatorSearchSession;
    navigatorSearchRequest += 1;
    const activation = ++navigatorSearchActivation;
    navigatorSearchSession = undefined;
    navigatorSearchResults.clear();
    tree.searchClosed();
    if (restore && session) void restoreNavigatorSearchSession(session, restoreState, activation);
  };

  const serializeSearchResult = (result: SearchResult) => ({
    id: result.id,
    kind: result.kind,
    label: result.label,
    description: result.description,
    tooltip: result.tooltip,
    icon: result.icon,
    access: result.access,
    missingCounterpart: result.missingCounterpart,
    isCurrentFile: result.isCurrentFile
  });

  const performNavigatorSearch = async (message: { options?: Partial<NavigatorSearchOptions>; query: string; requestId: number; }) => {
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
              id: navigatorSearchResultId(NavigatorItemKind.File, filePath, 0, fileName),
              kind: NavigatorItemKind.File, label: fileName, description: path.dirname(filePath),
              tooltip: filePath, icon: NavigatorItemKind.File, filePath, offset: 0, isCurrentFile: false
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
      output?.appendLine(`Delphi navigator global search failed: ${errorStack(error) || errorMessage(error)}`);
      await tree.postSearchResults(message.requestId, [], `Global search failed: ${errorMessage(error)}`);
    }
  };

  const activateNavigatorSearchResult = async (message: { id: string; preview: boolean }) => {
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
      const holdMs = vscode.workspace.getConfiguration(ConfigurationSection)
        .get(SettingKey.ClassNavigatorNavigationClickHoldMs, 120);
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
        && inList(result.kind, [PascalKeyword.Type, 'routine'])) {
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
      output?.appendLine(`Delphi navigator search navigation failed: ${errorStack(error) || errorMessage(error)}`);
      void vscode.window.showErrorMessage(`Could not open search result: ${errorMessage(error)}`);
    }
  };

  const showNavigatorSearch = async () => {
    await setNavigatorMode(NavigatorMode.Class);
    if (navigatorSearchSession) {
      await tree.hideSearch();
      return;
    }
    const document = vscode.window.activeTextEditor?.document;
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
      selection: editor?.selection || new vscode.Selection(0, 0, 0, 0),
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
      await vscode.commands.executeCommand(NavigatorCommandId.Focus);
    } catch {}
    tree.showSearch(navigatorSearchOptions);
  };

  const selectAiChatModel = async (settings: AiSettings) => {
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
      ? models.find((candidate) => candidate.id === settings.modelId
        || candidate.name === settings.modelId)
      : models[0];
    if (!chatModel) {
      throw new Error(`Configured model "${settings.modelId}" was not found. Change the model ID in AI Routine Steps settings.`);
    }
    return chatModel;
  };

  const sendAiStepRequest = async (request: AiRequest, chatModel: VSCode.LanguageModelChat, token: VSCode.CancellationToken, justification: string): Promise<AiStepResponseResult> => {
    const messages = [vscode.LanguageModelChatMessage.User(request.analysis.prompt)];
    const requestOptions: VSCode.LanguageModelChatRequestOptions & { modelConfiguration?: { reasoningEffort: string } } = { justification };
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
          if ((partial.validLabelCount || 0) > reportedLabels) {
            reportedLabels = partial.validLabelCount || 0;
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

  const requestAiStepResponse = async (request: AiRequest, chatModel: VSCode.LanguageModelChat, token: VSCode.CancellationToken, justification: string) => {
    const first = await sendAiStepRequest(request, chatModel, token, justification);
    if (first.planned) {
      if (token.isCancellationRequested || first.validLabelCount === 0) return [];
      if (!(first.missingIds || []).length) return first.steps;
      const repairPrompt = buildAiStepRepairPrompt(request.analysis, first.missingIds);
      if (!repairPrompt) return first.steps;
      output?.appendLine(
        `AI response for ${request.routine.label} omitted ${(first.missingIds || []).length} fixed block label(s); `
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
      if ((merged.missingIds || []).length) {
        output?.appendLine(
          `AI repair for ${request.routine.label} still omitted ${(merged.missingIds || []).length} label(s); `
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

  const aiSettingsForMode = (document: NavigatorDocument, generationMode = 'normal') => {
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

  const generateAiSteps = async (requestedNode: NavigatorTarget | undefined, generationMode = 'normal') => {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      void vscode.window.showInformationMessage('Open a Pascal/Delphi source file first.');
      return;
    }
    const detailed = generationMode === 'detailed';
    const settings = aiSettingsForMode(document, generationMode);
    if (!settings.enabled) {
      void vscode.window.showInformationMessage('Enable "AI Routine Steps" in Pascal Atlas settings first.');
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
              onPartial: (partialSteps) => provider.updateAiGeneration(request, partialSteps)
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
        || /cancel/i.test(String(typeof error === 'object' && error !== null && 'code' in error ? error.code : '')) || /cancel/i.test(errorMessage(error) || '');
      if (!cancelled) {
        output?.appendLine(`AI function step generation failed: ${errorStack(error) || errorMessage(error)}`);
        void vscode.window.showErrorMessage(`AI routine step generation failed: ${errorMessage(error)}`);
      }
    } finally {
      if (!completed) provider.failAiGeneration(request);
      finishAiOperation(operation);
    }
  };

  const generateClassAiSteps = async (requestedNode: NavigatorTarget, generationMode = 'normal') => {
    const document = provider.activeDocument();
    if (!document || !/\.(?:pas|pp)$/i.test(document.fileName)) {
      void vscode.window.showInformationMessage('Open a .pas or .pp source file first.');
      return;
    }
    const settings = aiSettingsForMode(document, generationMode);
    if (!settings.enabled) {
      void vscode.window.showInformationMessage('Enable "AI Routine Steps" in Pascal Atlas settings first.');
      return;
    }
    if (requestedNode?.kind !== PascalKeyword.Type) return;
    if (activeAiCancellation) {
      void vscode.window.showInformationMessage('An AI step-generation task is already running. Click Stop first.');
      return;
    }

    if (!await provider.readyModel(document)) return;
    const text = document.getText();
    const startingVersion = document.version;
    const descendants: NavigatorNode[] = [];
    const visit = (node: NavigatorTarget) => {
      for (const child of node?.children || []) {
        if (child.kind === 'routine') descendants.push(child);
        visit(child);
      }
    };
    visit(requestedNode);
    const routines = [...new Map(descendants
      .filter(node => isInteger(node.implementationOffset))
      .map(node => [node.id, node])).values()];
    if (!routines.length) {
      void vscode.window.showInformationMessage(`Class ${requestedNode.label} has no routine implementations for step generation.`);
      return;
    }

    const counts = { generated: 0, skipped: 0, failed: 0 };
    const requests: AiRequest[] = [];
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
                    onPartial: (partialSteps) => provider.updateAiGeneration(request, partialSteps)
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
                    `AI steps failed for ${request.routine.label}: ${errorStack(error) || errorMessage(error)}`
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
        || /cancel/i.test(String(typeof error === 'object' && error !== null && 'code' in error ? error.code : '')) || /cancel/i.test(errorMessage(error) || '');
      if (!cancelled) {
        output?.appendLine(`Class AI function step generation failed: ${errorStack(error) || errorMessage(error)}`);
        void vscode.window.showErrorMessage(`AI routine step generation failed for class ${requestedNode.label}: ${errorMessage(error)}`);
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
    if (navigatorMode === NavigatorMode.Class) scheduleFollow('cursor');
  };

  void vscode.commands.executeCommand('setContext', NavigatorContextKey.Mode, navigatorMode);
  void setAiGeneratingContext(false);
  tree.setMode(navigatorMode);
  const combinedChangeSubscription = combinedChanged.event(() => tree.refresh());
  const classChangeSubscription = provider.onDidChangeTreeData((element) => {
    if (navigatorMode === NavigatorMode.Class) combinedChanged.fire(element);
  });
  const projectChangeSubscription = projectProvider?.onDidChangeTreeData((element) => {
    if (navigatorMode !== 'project') return;
    updatePresentation();
    combinedChanged.fire(element);
  });

  context.subscriptions.push(
    ...(webviewRegistration ? [webviewRegistration] : []),
    tree,
    provider,
    provider.changed,
    combinedChanged,
    combinedChangeSubscription,
    classChangeSubscription,
    ...(projectChangeSubscription ? [projectChangeSubscription] : []),
    navigationRangeDecoration,
    ...WEBVIEW_CONTEXT_COMMANDS.map(([name, command]) => vscode.commands.registerCommand(
      `${NavigatorCommandId.ContextPrefix}${name}`,
      () => {
        const target = tree.selection[0];
        if (target) return vscode.commands.executeCommand(command, target);
        return undefined;
      }
    )),
    tree.onDidExpandElement((event) => {
      if (navigatorMode !== NavigatorMode.Class) return;
      if (!event.element?.children?.length) return;
      const documentUri = provider.documentUriForNode(event.element)
        || provider.activeDocument()?.uri.toString();
      expandedRoutineIds(documentUri).add(event.element.id || '');
      persistExpandedRoutines();
      refreshHighlightForRoutineExpansion(provider.routineForNode(event.element));
    }),
    tree.onDidCollapseElement((event) => {
      if (navigatorMode !== NavigatorMode.Class) return;
      if (!event.element?.children?.length) return;
      const documentUri = provider.documentUriForNode(event.element)
        || provider.activeDocument()?.uri.toString();
      expandedRoutineIds(documentUri).delete(event.element.id || '');
      persistExpandedRoutines();
      refreshHighlightForRoutineExpansion(provider.routineForNode(event.element));
    }),
    vscode.commands.registerCommand(CommandId.ClassNavigatorRefresh, () => {
      activeProvider().refresh?.({ force: true });
      updatePresentation();
      scheduleFollow('cursor');
    }),
    vscode.commands.registerCommand(CommandId.CreateImplementation, createImplementationCommand<VSCode.Position, VSCode.Range, VSCode.Selection, VSCode.Uri>(vscode, {
      readyModel: () => provider.readyModel(vscode.window.activeTextEditor?.document),
      onCreated: () => {
        // This explicit editor operation commits immediately through the same
        // data-diff path as ordinary edits, without opening or rebuilding the view.
        lastDocumentEditAt = 0;
        navigationLock = undefined;
        navigationHoldUntil = 0;
        refresh('cursor', true);
      }
    })),
    vscode.commands.registerCommand(CommandId.ClassNavigatorSelectSort, () => {
      if (navigatorMode !== NavigatorMode.Class) return;
      if (tree.sortPanelOpen) return tree.hideSort();
      const config = vscode.workspace.getConfiguration(NavigatorConfigurationSection);
      const memberOrder = (config?.get<string>('memberOrder', 'visibility') ?? 'visibility');
      tree.showSort({
        memberOrder: memberOrder === 'source' ? PascalKeyword.Implementation : memberOrder,
        typeOrder: (config?.get('typeOrder', 'declaration') ?? 'declaration')
      });
    }),
    vscode.commands.registerCommand(CommandId.ClassNavigatorFind, showNavigatorSearch),
    vscode.commands.registerCommand(CommandId.NavigatorShowProjects, () => setNavigatorMode('project')),
    vscode.commands.registerCommand(CommandId.NavigatorShowClasses, () => setNavigatorMode(NavigatorMode.Class)),
    vscode.commands.registerCommand(
      CommandId.NavigatorToggleMode,
      () => setNavigatorMode(navigatorMode === 'project' ? NavigatorMode.Class : 'project')
    ),
    vscode.commands.registerCommand(CommandId.ClassNavigatorShow, async () => {
      await setNavigatorMode(NavigatorMode.Class);
      const firstNode = provider.model()?.roots?.[0];
      if (!firstNode) {
        void vscode.window.showInformationMessage('Open a Pascal/Delphi source file first.');
        return;
      }
      await tree.reveal(firstNode, { select: false, focus: true, expand: false });
    }),
    vscode.commands.registerCommand(
      CommandId.ClassNavigatorGenerateAiSteps,
(      node) => {
        const target = node?.kind ? node : tree.selection[0];
        return target?.kind === PascalKeyword.Type
          ? generateClassAiSteps(target, 'normal')
          : generateAiSteps(target, 'normal');
      }
    ),
    vscode.commands.registerCommand(
      CommandId.ClassNavigatorGenerateDetailedAiSteps,
(      node) => {
        const target = node?.kind ? node : tree.selection[0];
        return target?.kind === PascalKeyword.Type
          ? generateClassAiSteps(target, 'detailed')
          : generateAiSteps(target, 'detailed');
      }
    ),
    vscode.commands.registerCommand(
      CommandId.ClassNavigatorStopAiGeneration,
      stopAiGeneration
    ),
    vscode.commands.registerCommand(NavigatorCommandId.Open, openNode),
    vscode.window.onDidChangeActiveTextEditor(() => {
      clearNavigationHighlight();
      navigationLock = undefined;
      navigationHoldUntil = 0;
      lastDocumentEditAt = 0;
      refresh('cursor', true);
    }),
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor !== vscode.window.activeTextEditor) return;
      clearNavigationHighlightOutsideCursor(event.textEditor);
      if (event.kind === vscode.TextEditorSelectionChangeKind.Mouse) {
        navigationLock = undefined;
        navigationHoldUntil = 0;
        scheduleFollow('mouse', event);
      } else if (event.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {
        // Keyboard selection events also fire for each typed character. The
        // pending document refresh will follow the caret once typing settles.
        if (lastDocumentEditUri === event.textEditor.document.uri.toString()
          && Date.now() - lastDocumentEditAt < DOCUMENT_EDIT_DELAY_MS) return;
        scheduleFollow('cursor', event);
      }
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
      clearNavigationHighlightOutsideViewport(event);
      if (event.textEditor === vscode.window.activeTextEditor) scheduleFollow('scroll', event);
    }),
    tree.onDidChangeVisibility((event) => {
      navigatorVisible = event.visible;
      if (!event.visible) {
        if (followTimer) clearTimeout(followTimer);
        followTimer = undefined;
        return;
      }
      activeProvider().refresh?.();
      updatePresentation();
      scheduleFollow('cursor');
    }),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.contentChanges.length === 0) return;
      if (activeNavigationHighlight?.documentUri === event.document.uri.toString()) {
        clearNavigationHighlight();
      }
      if (navigatorMode === NavigatorMode.Class && event.document === provider.activeDocument()) {
        // Keep the existing tree stable while a user is actively typing. The
        // trailing refresh still picks up new declarations as soon as editing pauses.
        lastDocumentEditAt = Date.now();
        lastDocumentEditUri = event.document.uri.toString();
        refresh('cursor', false, DOCUMENT_EDIT_DELAY_MS);
      }
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (navigatorMode === NavigatorMode.Class && document === provider.activeDocument()) {
        lastDocumentEditAt = 0;
        refresh('cursor', true);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('pascalAtlas.classNavigator.highlightRange.enabled')
        || event.affectsConfiguration('pascalAtlas.classNavigator.aiSteps.highlightRange')) {
        clearNavigationHighlight();
      }
      if (event.affectsConfiguration(NavigatorConfigurationSection)) {
        const config = vscode.workspace.getConfiguration(NavigatorConfigurationSection);
        const memberOrder = (config?.get<string>('memberOrder', 'visibility') ?? 'visibility');
        void tree.updateSortSettings({
          memberOrder: memberOrder === 'source' ? PascalKeyword.Implementation : memberOrder,
          typeOrder: (config?.get('typeOrder', 'declaration') ?? 'declaration')
        });
        refresh();
      } else if (event.affectsConfiguration('pascalAtlas.enabled')) refresh();
    }),
    {
      dispose() {
        activeAiCancellation?.cancel();
        activeAiCancellation?.dispose();
        activeAiCancellation = undefined;
        void setAiGeneratingContext(false);
        void vscode.commands.executeCommand(
          'setContext',
          NavigatorContextKey.WebviewFocused,
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

export {
  ClassNavigatorProvider,
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
  serializeNavigatorNode,
  unitLifecycleNodes,
  viewportFollowLine
};
