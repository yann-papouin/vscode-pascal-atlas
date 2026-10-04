import { CompiledSymbolKind, SourceSymbolKind } from './shared/symbols';
import type { SourceDefinition, SourceIndex, SourceUnit } from './shared/sourceModels';
import type { CompiledClass, CompiledGlobal, CompiledRoutine, CompiledUnit, CompiledInfo, CompiledPackageIndex, CompiledPackageData, CompiledMethod, CompiledProperty, ObservedMemberIndex, PascalTypeInferenceIndex, PascalUsesRange } from './shared/compiledModels';
import { isCompiledPackageData } from './shared/compiledProtocol';
import { inList, isRecord, errorMessage, isInteger } from './shared/guards';
import { CommandId, ConfigurationSection, LanguageId, SettingKey, UriScheme } from './shared/identifiers';
import { PascalKeyword } from './shared/pascal';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { deserialize as v8Deserialize, serialize as v8Serialize } from 'node:v8';
import { BackgroundDiagnostics } from './backgroundDiagnostics';
import { hasNativePascalCompletion, registerImmediateSpaceExpansion, registerSpaceTriggeredSnippetExpansion } from './basicSnippets';
import { registerDependencySupport } from './dependencySupport';
import { initializeFirstRunSettings } from './defaultSettings';
import { registerEncodingSupport } from './encodingSupport';
import { registerClassNavigator } from './classNavigator';
import { CompiledSymbolWorkerClient } from './compiledSymbolWorkerClient';
import { PascalAtlasControlCenterProvider } from './controlCenter';
import { migrateLegacyFormatterSettings, registerFormatter } from './formatter/formatterSupport';
import { registerExplorerSupport } from './explorerSupport';
import { editorUri, findVisibleEditor, shouldRetireEditor } from './editorDecorationLifecycle';
import { BuildDebugSupport } from './buildDebugSupport';
import { registerPascalLanguageConfiguration } from './pascalLanguageConfiguration';
import { PascalReferenceSupport } from './referenceSupport';
import { registerPlatformSourceIsolation } from './platformSourceIsolation';
import { collectPascalSyntacticColoring, isPascalIntrinsicIdentifier, isPascalNonNavigableIdentifierAt, isPascalVisibilityDirectiveAt } from './syntacticColoring';
import { collectPascalAtlasPaths, discoverLoadedProjects, ensureVallentaProjectGroups, normalizeKey } from './projectDiscovery';
import { mergeManagedSearchPath, splitSearchPath } from './unitSearchPath';
import { isSourceDefinition, buildSourceUnitIndex, buildSourceUnitIndexForUnits, buildDcpSymbolIndex, filterAddUnitCandidates, findKnownUnitReferences, findSourceMemberDefinitions, isPascalRoutineDeclarationIdentifier, mergeSourceUnitIndexes, mergeSourceUnitIndexesAsync, parseSourceUnitSymbols, planUsesInsertion, selectBestPascalDefinitions, sourceTypeUnitIndex, unknownSymbolFromDiagnostic } from './usesQuickFix';
import { PASCAL_INDEX_DEREFERENCE, bplCandidatesForDocument, buildPascalTypeInferenceIndex, collectPascalInlineVariableNames, collectPascalUnitIdentifierOffsets, collectPascalUsesUnitRanges, extractPascalRoutineSignature, findBplFiles, findDcpFiles, findPascalUsesUnitAt, findPascalCallAt, findPascalDeclaration, inferPascalInitializerRoutine, inferPascalCollectionElementType, inferPascalTypeFromIndex, isPascalMemberReference, inferRoutineReturnClass, knownCompiledMembers, uniqueCompiledInterfaceMember, maskPascalNonCode, pascalMemberChainBefore, pascalForInCollectionFromIndex, pascalTypeBaseName, substitutePascalTypeParameters, parseObservedMemberReferences, parseUsesUnits, parseTdumpExports, rankBplCandidates, renderVirtualUnit, resolvePascalReceiverTypeChain, splitSignatureParameters } from './binarySymbols';


type SymbolUnitIndex = Map<string, Set<string>>;
type SemanticTokenType = 'unit' | 'class' | 'variable' | 'constant' | 'enumMember' | 'property' | 'method';
interface DocumentUsesAnalysis { version: number; text: string; code: string; usedUnitNames: string[]; usesUnitRanges: PascalUsesRange[]; }
interface DocumentAnalysis extends DocumentUsesAnalysis {
  usedUnits: Set<string>; visibleUnits: Set<string>; ownUnit?: string; sourceUnit?: SourceUnit;
  localDefinitions: Map<string, SourceDefinition[]>; localMembers: SourceIndex['members'];
  localSourceIndex: Pick<SourceIndex, 'types' | 'members'>;
  typeInferenceIndex: PascalTypeInferenceIndex; unitIdentifierOffsets: Set<number>;
}
interface PackageDocumentData { directIndexes: CompiledPackageData[]; usedUnitIndexes: CompiledUnit[]; }
interface WordToken { range: vscode.Range; word: string; }
interface CompiledReference { info: CompiledInfo; token: WordToken; target: { kind: string; name: string; className?: string }; member?: CompiledMethod | CompiledProperty | CompiledInfo; }
type RangeKind = 'classRanges' | 'unitRanges' | 'globalRanges' | 'memberRanges' | 'propertyRanges' | 'constantRanges' | 'enumMemberRanges';
const RANGE_KINDS: readonly RangeKind[] = ['classRanges', 'unitRanges', 'globalRanges', 'memberRanges', 'propertyRanges', 'constantRanges', 'enumMemberRanges'];
type DecorationRanges = Record<RangeKind, vscode.Range[]>;
interface FastDecorationRanges extends DecorationRanges {
  text: string; code: string; sourceIndex: Pick<SourceIndex, 'definitions' | 'types' | 'members' | 'units'>;
  usedUnits: Set<string>; visibleUnits: Set<string>; ownUnit?: string; unitIdentifierOffsets: Set<number>;
  declaredTypes: Map<string, string>; typeInferenceIndex: PascalTypeInferenceIndex;
}
interface DecorationSnapshot { version: number; contentIdentity: string; ranges: DecorationRanges; }
interface CompactDecorationSnapshot { contentIdentity: string; ranges: Record<RangeKind, Array<[number, number, number, number]>>; }
interface DecorationState { generation: number; running: boolean; pending?: boolean; editor?: vscode.TextEditor; timer?: NodeJS.Timeout; replayRequested?: boolean; hasApplied?: boolean; lastApplied?: DecorationSnapshot; }
interface DocumentVisit { uri: string; languageId: string; isPlatformSource: boolean; isWorkspaceDocument: boolean; }
interface LookupOptions { cachedOnly?: boolean; }
interface EnrichmentOptions extends LookupOptions { workspaceMembers?: boolean; }


function isCompactDecorationSnapshot(value: unknown): value is CompactDecorationSnapshot {
  return isRecord(value) && typeof value.contentIdentity === 'string' && isRecord(value.ranges)
    && RANGE_KINDS.every(kind => isRecord(value.ranges) && Array.isArray(value.ranges[kind])
      && value.ranges[kind].every(range => Array.isArray(range) && range.length === 4 && range.every(isInteger)));
}

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const MANAGED_PATHS_KEY = 'pascalAtlas.managedPaths';
const GLOBAL_MANAGED_PATHS_KEY = 'pascalAtlas.globalManagedPaths';
const DECORATION_SNAPSHOT_STATE_KEY = 'pascalAtlas.decorationSnapshotsV4';
const SOURCE_UNIT_LOCATION_STATE_KEY = 'pascalAtlas.sourceUnitLocationsV1';
const output = vscode.window.createOutputChannel('Pascal Atlas');
const INTERACTIVE_LOOKUP_TIMEOUT = Symbol('interactiveLookupTimeout');
let syncPromise: Promise<unknown> = Promise.resolve();
let debounceTimer: NodeJS.Timeout | undefined;
let compiledSymbols: CompiledSymbolSupport;
let backgroundDiagnostics: BackgroundDiagnostics;

const PASCAL_ATLAS_COLOR_KEYS: Record<SemanticTokenType, string> = {
  unit: PascalKeyword.Unit,
  class: PascalKeyword.Type,
  variable: 'variable',
  constant: 'constant',
  enumMember: 'enumMember',
  property: PascalKeyword.Property,
  method: 'method'
};

function semanticEditorColor(tokenType: SemanticTokenType, uri: vscode.ConfigurationScope|null|undefined) {
  const paConfiguration = vscode.workspace.getConfiguration(ConfigurationSection, uri);
  if (!paConfiguration.get(SettingKey.ColoringColorsUseDefault, true)) {
    const configuredColor = paConfiguration.get(
      `coloring.colors.${PASCAL_ATLAS_COLOR_KEYS[tokenType]}`,
      ''
    );
    if (typeof configuredColor === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(configuredColor)) {
      return configuredColor;
    }
  }
  const isLight = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light
    || vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight;
  const palette = isLight
    ? {
        unit: '#267F99',
        class: '#267F99',
        variable: '#001080',
        constant: '#001080',
        enumMember: '#0070C1',
        property: '#001080',
        method: '#795E26'
      }
    : {
        unit: '#4EC9B0',
        class: '#4EC9B0',
        variable: '#9CDCFE',
        constant: '#4FC1FF',
        enumMember: '#4FC1FF',
        property: '#9CDCFE',
        method: '#DCDCAA'
      };
  const customization = vscode.workspace.getConfiguration('editor').get<{ rules?: Partial<Record<SemanticTokenType, string | { foreground?: string }>> }>('semanticTokenColorCustomizations', {});
  const configured = customization?.rules?.[tokenType];
  return (typeof configured === "string" ? configured : configured?.foreground) || palette[tokenType];
}

function semanticDecoration(tokenType: SemanticTokenType, uri?: vscode.ConfigurationScope | null) {
  const options = {
    color: semanticEditorColor(tokenType, uri),
    opacity: '1'
  };
  return vscode.window.createTextEditorDecorationType(options);
}

function visibleUnitKeys(usedUnits: unknown[], ownUnit?: string) {
  // System is implicitly visible in every Delphi compilation unit even when it
  // is absent from both interface and implementation uses clauses.
  const result = new Set<string>(['system']);
  for (const unitName of usedUnits || []) {
    const key = String(unitName || '').toLowerCase();
    if (!key) continue;
    result.add(key);
    result.add(key.split('.').at(-1)!);
  }
  const ownKey = String(ownUnit || '').toLowerCase();
  if (ownKey) {
    result.add(ownKey);
    result.add(ownKey.split('.').at(-1)!);
  }
  return result;
}

function unitIsVisible(unitName: string, visibleUnits: Set<string>) {
  const key = String(unitName || '').toLowerCase();
  const leaf = key.split('.').at(-1)!;
  return visibleUnits.has(key) || visibleUnits.has(leaf);
}

// Delphi accepts both modern scoped names (`System.SysUtils`) and legacy
// aliases (`SysUtils`). Old projects commonly use the latter; sending those
// aliases through DCP ownership discovery turns a trivial lookup into a scan
// of every compiled package.
const LEGACY_DELPHI_PLATFORM_UNITS = new Set<string>([
  'system', 'windows', 'messages', 'sysutils', 'classes', 'variants', 'types',
  'typinfo', 'math', 'strutils', 'dateutils', 'contnrs', 'syncobjs', 'inifiles',
  'graphics', 'controls', 'forms', 'dialogs', 'menus', 'actnlist', 'imglist',
  'stdctrls', 'extctrls', 'comctrls', 'buttons', 'grids', 'db', 'dbctrls'
]);

function isDelphiPlatformUnit(unitName: string) {
  const key = String(unitName || '').toLowerCase();
  return LEGACY_DELPHI_PLATFORM_UNITS.has(key)
    || /^(?:system|winapi|vcl|fmx|data|datasnap|soap|web)\./.test(key);
}

function yieldToExtensionHost() {
  return new Promise<void>(resolve => setImmediate(resolve));
}

function waitForPascalEditorIdle(context: vscode.ExtensionContext, delayMs: number|undefined) {
  return new Promise<void>(resolve => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const complete = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      documentSubscription.dispose();
      editorSubscription.dispose();
      resolve();
    };
    const schedule = () => {
      if (settled) return;
      clearTimeout(timer);
      timer = setTimeout(complete, delayMs);
    };
    const documentSubscription = vscode.workspace.onDidChangeTextDocument(event => {
      if (inList(event.document.languageId, [LanguageId.Pascal, LanguageId.ObjectPascal])) schedule();
    });
    const editorSubscription = vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && inList(editor.document.languageId, [LanguageId.Pascal, LanguageId.ObjectPascal])) schedule();
    });
    context.subscriptions.push(documentSubscription, editorSubscription, {
      dispose() {
        settled = true;
        clearTimeout(timer);
      }
    });
    schedule();
  });
}

class CompiledSymbolSupport {
  context;
  sourceIndexPromise;
  platformSourceRoots;
  projectSourceRoots;
  prioritySourcePromises: Map<string, Promise<void>>;
  sourceIndex: SourceIndex | undefined;
  fastSourceUnits: Map<string, SourceDefinition[]>;
  fastSourceUnitsPersistTimer: NodeJS.Timeout | undefined;
  cache: Map<string, Promise<CompiledClass | undefined>>;
  packageClassCache: Map<string, Promise<CompiledPackageData>>;
  packageIndexReady: Set<string>;
  packageStringCache: Map<string, Promise<string>>;
  packageMangledClassCache: Map<string, Promise<Map<string, CompiledClass>>>;
  dcpHintCache: Map<string, Promise<string[]>>;
  dcpPathsByBase: Map<string, string>;
  unitPackageIndex: Map<string, Set<string>>;
  unitOwnerPackage: Map<string, string>;
  compiledUnitsByName: Map<string, CompiledUnit[]>;
  compiledUnitsByLeaf: Map<string, CompiledUnit[]>;
  decorationStates: Map<string, DecorationState>;
  closedDecorationSnapshots: Map<string, CompactDecorationSnapshot>;
  decorationSnapshotPersistTimer: NodeJS.Timeout | undefined;
  backgroundWarmPromise: Promise<void>|undefined;
  allUnitIndexPromise: Promise<SymbolUnitIndex> | undefined;
  workspaceMemberIndexPromise: Promise<ObservedMemberIndex> | undefined;
  documentWarmPromises: Map<string, { version: number; promise: Promise<void> }>;
  documentPackagePromises: Map<string, { version: number; promise: Promise<PackageDocumentData>; pending: boolean }>;
  documentAnalysisCache: Map<string, DocumentAnalysis>;
  documentUsesCache: Map<string, DocumentUsesAnalysis>;
  pendingPackageRefreshes: Map<string, NodeJS.Timeout>;
  definitionPromises: Map<string, Promise<vscode.DefinitionLink | undefined>>;
  sourceSignatureCache: Map<string, Promise<string | undefined>>;
  signatureHelpCache: Map<string, { labels: string[]; sourceReady: boolean; createdAt: number }>;
  virtualDocuments: Map<string, string>;
  bplPaths: string[];
  compiledDiscoveryReady;
  decorationTypes: vscode.TextEditorDecorationType[];
  compiledParser;
  activeEditor;
  activeDocumentVisit;
  platformReturnPendingUntil;
  decoration!: vscode.TextEditorDecorationType;
  unitDecoration!: vscode.TextEditorDecorationType;
  globalDecoration!: vscode.TextEditorDecorationType;
  memberDecoration!: vscode.TextEditorDecorationType;
  propertyDecoration!: vscode.TextEditorDecorationType;
  constantDecoration!: vscode.TextEditorDecorationType;
  enumMemberDecoration!: vscode.TextEditorDecorationType;
  tdumpPath = '';
  dcpFingerprint = '';
  allTypeUnitIndexPromise: Promise<SymbolUnitIndex> | undefined;

  constructor(context: vscode.ExtensionContext, sourceIndexPromise: Promise<SourceIndex>, platformSourceRoots: string[] = [], projectSourceRoots: string[] = []) {
    this.context = context;
    this.sourceIndexPromise = sourceIndexPromise;
    this.platformSourceRoots = platformSourceRoots;
    this.projectSourceRoots = projectSourceRoots;
    this.prioritySourcePromises = new Map();
    this.sourceIndex = undefined;
    this.fastSourceUnits = new Map();
    const sourceUnitLocations = context.workspaceState.get<unknown>(SOURCE_UNIT_LOCATION_STATE_KEY, []);
    for (const entry of Array.isArray(sourceUnitLocations) ? sourceUnitLocations : []) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
        || !Array.isArray(entry[1]) || !entry[1].every(isSourceDefinition)) continue;
      this.fastSourceUnits.set(entry[0], entry[1]);
    }
    this.fastSourceUnitsPersistTimer = undefined;
    this.cache = new Map();
    this.packageClassCache = new Map();
    this.packageIndexReady = new Set();
    this.packageStringCache = new Map();
    this.packageMangledClassCache = new Map();
    this.dcpHintCache = new Map();
    this.dcpPathsByBase = new Map();
    this.unitPackageIndex = new Map();
    this.unitOwnerPackage = new Map();
    // Hot path for Ctrl-hover over a uses item. Looking up a known Unit must
    // not rank and walk every loaded BPL on every mouse movement.
    this.compiledUnitsByName = new Map();
    this.compiledUnitsByLeaf = new Map();
    this.decorationStates = new Map();
    const savedDecorationSnapshots = context.workspaceState.get<unknown>(
      DECORATION_SNAPSHOT_STATE_KEY,
      []
    );
    this.closedDecorationSnapshots = new Map(Array.isArray(savedDecorationSnapshots)
      ? savedDecorationSnapshots.filter((entry): entry is [string, CompactDecorationSnapshot] => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && isCompactDecorationSnapshot(entry[1]))
      : []);
    this.decorationSnapshotPersistTimer = undefined;
    this.backgroundWarmPromise = undefined;
    this.allUnitIndexPromise = undefined;
    this.workspaceMemberIndexPromise = undefined;
    this.documentWarmPromises = new Map();
    this.documentPackagePromises = new Map();
    this.documentAnalysisCache = new Map();
    this.documentUsesCache = new Map();
    this.pendingPackageRefreshes = new Map();
    this.definitionPromises = new Map();
    this.sourceSignatureCache = new Map();
    this.signatureHelpCache = new Map();
    this.virtualDocuments = new Map();
    this.bplPaths = [];
    this.compiledDiscoveryReady = false;
    this.decorationTypes = [];
    this.compiledParser = new CompiledSymbolWorkerClient(context, output);
    this.activeEditor = vscode.window.activeTextEditor;
    this.activeDocumentVisit = this.documentVisit(vscode.window.activeTextEditor?.document);
    this.platformReturnPendingUntil = 0;
    this.rebuildDecorationTypes(vscode.window.activeTextEditor?.document?.uri);
    context.subscriptions.push({
      dispose: () => {
        clearTimeout(this.decorationSnapshotPersistTimer);
        clearTimeout(this.fastSourceUnitsPersistTimer);
        void this.persistDecorationSnapshots().catch(() => undefined);
        this.disposeDecorationTypes();
        this.compiledParser.dispose();
      }
    });
    sourceIndexPromise.then((index: SourceIndex) => this.sourceIndexExpanded(index)).catch(() => undefined);
  }

  typingDecorationDelay(document: vscode.TextDocument) {
    return vscode.workspace.getConfiguration(ConfigurationSection, document?.uri)
      .get(SettingKey.ColoringTypingDelayMs, 750);
  }

  sourceIndexExpanded(index: SourceIndex) {
    this.sourceIndex = index;
    this.rememberSourceUnitLocations(index);
    this.definitionPromises.clear();
    this.signatureHelpCache.clear();
    const active = vscode.window.activeTextEditor;
    if (active) this.scheduleDecorate(active, 0);
  }

  disposeDecorationTypes() {
    for (const decoration of this.decorationTypes || []) decoration.dispose();
    this.decorationTypes = [];
  }

  rebuildDecorationTypes(uri: vscode.Uri|undefined) {
    this.disposeDecorationTypes();
    this.decoration = semanticDecoration(PascalKeyword.Class, uri);
    this.unitDecoration = semanticDecoration(PascalKeyword.Unit, uri);
    this.globalDecoration = semanticDecoration('variable', uri);
    this.memberDecoration = semanticDecoration('method', uri);
    this.propertyDecoration = semanticDecoration(PascalKeyword.Property, uri);
    this.constantDecoration = semanticDecoration('constant', uri);
    this.enumMemberDecoration = semanticDecoration('enumMember', uri);
    this.decorationTypes = [
      this.decoration,
      this.unitDecoration,
      this.globalDecoration,
      this.memberDecoration,
      this.propertyDecoration,
      this.constantDecoration,
      this.enumMemberDecoration
    ];
  }

  appendSourceIndex(index: SourceIndex) {
    if (!index) return;
    if (!this.sourceIndex) this.sourceIndex = index;
    else mergeSourceUnitIndexes(this.sourceIndex, index);
    this.rememberSourceUnitLocations(index);
    this.definitionPromises.clear();
    this.signatureHelpCache.clear();
    const active = vscode.window.activeTextEditor;
    if (active) this.scheduleDecorate(active, 0);
  }

  rememberSourceUnitLocations(index: Pick<SourceIndex, 'units'>) {
    for (const [unitName, definitions] of index?.units || []) {
      const compact = definitions.filter((item: SourceDefinition) => item?.filePath).map((item: SourceDefinition) => ({
        filePath: item.filePath,
        offset: item.offset,
        line: item.line,
        character: item.character,
        length: item.length,
        kind: PascalKeyword.Unit,
        symbol: item.symbol,
        unitName: item.unitName
      }));
      if (compact.length > 0) this.fastSourceUnits.set(unitName, compact);
    }
    clearTimeout(this.fastSourceUnitsPersistTimer);
    this.fastSourceUnitsPersistTimer = setTimeout(() => {
      const entries = [...this.fastSourceUnits].filter(([, definitions]) =>
        definitions.some((item: SourceDefinition) => fs.existsSync(item.filePath)));
      void this.context.workspaceState.update(SOURCE_UNIT_LOCATION_STATE_KEY, entries);
    }, 250);
  }

  prioritizeSourceUnits(document: vscode.TextDocument) {
    if (!document || document.languageId !== LanguageId.Pascal || this.projectSourceRoots.length === 0) {
      return Promise.resolve();
    }
    const unitNames = parseUsesUnits(document.getText());
    const signature = [...new Set(unitNames)].sort().join(';');
    if (this.prioritySourcePromises.has(signature)) return this.prioritySourcePromises.get(signature);
    const promise = (async () => {
      const startedAt = Date.now();
      const priorityIndex = await buildSourceUnitIndexForUnits(this.projectSourceRoots, unitNames);
      if (priorityIndex.fileCount === 0) return;
      this.appendSourceIndex(priorityIndex);
      output.appendLine(
        `Active-file uses index: ${priorityIndex.fileCount} project file(s) for `
        + `${path.basename(document.fileName)} after ${Date.now() - startedAt}ms.`
      );
    })().catch(error => {
      output.appendLine(`Active-file RAD/VCL priority index failed: ${error.message}`);
    });
    this.prioritySourcePromises.set(signature, promise);
    return promise;
  }

  documentAnalysis(document: vscode.TextDocument, prepared?: { text: string; code: string }): DocumentAnalysis {
    const key = document.uri.toString();
    const cached = this.documentAnalysisCache.get(key);
    if (cached?.version === document.version) return cached;
    const text = prepared?.text ?? document.getText();
    const code = prepared?.code ?? maskPascalNonCode(text);
    const usedUnitNames = parseUsesUnits(text, code);
    const sourceUnit = parseSourceUnitSymbols(text, document.fileName, code, {
      includeImplementationSymbols: true
    });
    const ownUnit = sourceUnit?.unitName?.toLowerCase();
    const localDefinitions: SourceIndex['definitions'] = new Map();
    const localMembers: SourceIndex['members'] = new Map();
    const localTypes: SourceIndex['types'] = new Map();
    for (const definition of sourceUnit?.definitions || []) {
      const definitionKey = definition.symbol.toLowerCase();
      if (!localDefinitions.has(definitionKey)) localDefinitions.set(definitionKey, []);
      localDefinitions.get(definitionKey)!.push(definition);
      if (definition.owner) {
        const ownerKey = definition.owner.toLowerCase();
        if (!localMembers.has(ownerKey)) localMembers.set(ownerKey, new Map());
        if (!localMembers.get(ownerKey)!.has(definitionKey)) localMembers.get(ownerKey)!.set(definitionKey, []);
        localMembers.get(ownerKey)!.get(definitionKey)!.push(definition);
      }
    }
    for (const definition of sourceUnit?.types || []) {
      const typeKey = pascalTypeBaseName(definition.symbol).toLowerCase();
      if (!localTypes.has(typeKey)) localTypes.set(typeKey, []);
      localTypes.get(typeKey)!.push(definition);
    }
    const analysis = {
      version: document.version,
      text,
      code,
      usedUnitNames,
      usedUnits: new Set(usedUnitNames),
      visibleUnits: visibleUnitKeys(usedUnitNames, ownUnit),
      ownUnit,
      sourceUnit,
      localDefinitions,
      localMembers,
      localSourceIndex: { types: localTypes, members: localMembers },
      typeInferenceIndex: buildPascalTypeInferenceIndex(text, code),
      usesUnitRanges: collectPascalUsesUnitRanges(text, usedUnitNames, code),
      unitIdentifierOffsets: collectPascalUnitIdentifierOffsets(text, usedUnitNames, code)
    };
    this.documentAnalysisCache.set(key, analysis);
    return analysis;
  }

  documentUsesAnalysis(document: vscode.TextDocument): DocumentUsesAnalysis {
    const key = document.uri.toString();
    const full = this.documentAnalysisCache.get(key);
    if (full?.version === document.version) return full;
    const cached = this.documentUsesCache.get(key);
    if (cached?.version === document.version) return cached;
    const text = document.getText();
    const code = maskPascalNonCode(text);
    const usedUnitNames = parseUsesUnits(text, code);
    const analysis = {
      version: document.version,
      text,
      code,
      usedUnitNames,
      usesUnitRanges: collectPascalUsesUnitRanges(text, usedUnitNames, code)
    };
    this.documentUsesCache.set(key, analysis);
    return analysis;
  }

  refreshDocumentsForPackage(packageIndex: CompiledPackageData) {
    const packageUnits = new Set(packageIndex?.packageIndex?.units?.keys() || []);
    if (packageUnits.size === 0) return;
    const packagePath = packageIndex?.bplPath
      || packageIndex?.packageIndex?.units?.values()?.next()?.value?.bplPath;
    const packageKey = packagePath ? normalizeKey(packagePath) : '';
    const packageBase = packagePath
      ? path.basename(packagePath, path.extname(packagePath)).toLowerCase()
      : '';
    for (const document of vscode.workspace.textDocuments) {
      if (document.languageId !== LanguageId.Pascal || document.isClosed) continue;
      const analysis = this.documentAnalysis(document);
      // A linked BPL contains RTTI/type references for many dependency Units.
      // Those references do not make the BPL the owner of those Units. Refresh
      // only for an authoritative DCP owner (or an exact package/unit name), or
      // every subsequently indexed package can repaint the same editor again.
      const relevant = [...analysis.usedUnits].some(unitName => {
        const owner = this.unitOwnerPackage.get(unitName)
          || this.unitOwnerPackage.get(unitName.split('.').at(-1)!);
        if (owner) return normalizeKey(owner) === packageKey;
        return packageBase === unitName || packageBase === unitName.split('.').at(-1)!;
      });
      if (!relevant) continue;
      const key = document.uri.toString();
      // If the document's own package batch is awaiting this package, that
      // batch will commit the complete result itself. Invalidating it here used
      // to create a second 0ms batch and a redundant decoration immediately
      // after the slow first one.
      if (this.documentPackagePromises.get(key)?.pending) continue;
      this.documentPackagePromises.delete(key);
      this.documentWarmPromises.delete(key);
      clearTimeout(this.pendingPackageRefreshes.get(key));
      const refreshTimer = setTimeout(() => {
        this.pendingPackageRefreshes.delete(key);
        const currentDocument = vscode.workspace.textDocuments.find(item =>
          item.uri.toString() === key && !item.isClosed);
        if (!currentDocument) return;
        // The first current-file pass may have completed before the package-to-
        // Unit map existed. Rebuild it now instead of retaining an empty result.
        this.documentPackagePromises.delete(key);
        this.documentWarmPromises.delete(key);
        this.warmCurrentDocument(currentDocument);
        const editor = vscode.window.visibleTextEditors.find(item =>
          item.document.uri.toString() === key);
        if (editor) this.scheduleDecorate(editor, 0);
        output.appendLine(
          `Compiled Unit package became ready; refreshed ${path.basename(currentDocument.fileName)}.`
        );
      }, 50);
      this.pendingPackageRefreshes.set(key, refreshTimer);
    }
  }

  async initialize() {
    const startedAt = Date.now();
    const installation = vscode.workspace.getConfiguration('vallenta.studio').get('installationPath', '');
    this.tdumpPath = path.join(installation, 'bin', 'tdump64.exe');
    if (!fs.existsSync(this.tdumpPath)) {
      output.appendLine(`Compiled package support disabled: tdump64.exe not found under ${installation}.`);
      return;
    }
    const [foundByFolder, dcpByFolder] = await Promise.all([
      Promise.all((vscode.workspace.workspaceFolders || [])
        .map(folder => findBplFiles(folder.uri.fsPath))),
      Promise.all((vscode.workspace.workspaceFolders || [])
        .map(folder => findDcpFiles(folder.uri.fsPath)))
    ]);
    const found = foundByFolder.flat();
    const preferred = new Map<string, string>();
    for (const item of found) {
      const key = path.basename(item).toLowerCase();
      const current = preferred.get(key);
      if (!current || this.pathScore(item) > this.pathScore(current)) preferred.set(key, item);
    }
    this.bplPaths = [...preferred.values()];
    for (const dcpPath of dcpByFolder.flat()) {
      const key = path.basename(dcpPath, path.extname(dcpPath)).toLowerCase();
      const current = this.dcpPathsByBase.get(key);
      if (!current || this.pathScore(dcpPath) > this.pathScore(current)) {
        this.dcpPathsByBase.set(key, dcpPath);
      }
    }
    const dcpIdentities = await Promise.all([...this.dcpPathsByBase.values()].map(async filePath => {
      try {
        const stat = await fs.promises.stat(filePath);
        return `${normalizeKey(filePath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      } catch {
        return normalizeKey(filePath);
      }
    }));
    this.dcpFingerprint = createHash('sha1').update(dcpIdentities.sort().join('|')).digest('hex');
    const packageByBase = new Map(this.bplPaths.map(item => [
      path.basename(item, path.extname(item)).toLowerCase(),
      item
    ]));
    const sharedOwners = this.context.workspaceState.get(
      `pascalAtlas.dcpOwnersV1:${this.dcpFingerprint}`,
      {}
    );
    if (sharedOwners && typeof sharedOwners === "object" && !Array.isArray(sharedOwners)) {
      for (const [unitName, packageBase] of Object.entries(sharedOwners)) {
        const ownerPath = packageByBase.get(String(packageBase).toLowerCase());
        if (ownerPath) this.unitOwnerPackage.set(unitName.toLowerCase(), ownerPath);
      }
    }
    this.compiledDiscoveryReady = true;
    // Decoration can run while discovery is still in progress. Never retain the
    // resulting empty promises: after reload that used to make the current file
    // wait until the unrelated background package scan happened to reach its BPL.
    this.dcpHintCache.clear();
    this.documentPackagePromises.clear();
    this.documentWarmPromises.clear();
    output.appendLine(
      `Compiled package fallback: ${this.bplPaths.length} unique BPL and `
      + `${this.dcpPathsByBase.size} matching DCP files available `
      + `after ${Date.now() - startedAt}ms.`
    );
  }

  featureEnabled(key: string, fallback = true, document?: vscode.TextDocument) {
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection, document?.uri);
    return configuration.get(SettingKey.Enabled, true) && configuration.get(key, fallback);
  }

  isPlatformSourceDocument(document: vscode.TextDocument) {
    if (!document?.fileName || this.platformSourceRoots.length === 0) return false;
    const fileName = path.resolve(document.fileName);
    return this.platformSourceRoots.some(root => {
      const relative = path.relative(path.resolve(root), fileName);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
  }

  documentVisit(document: vscode.TextDocument|undefined) {
    if (!document) return undefined;
    return {
      uri: document.uri.toString(),
      fileName: document.fileName,
      languageId: document.languageId,
      isPlatformSource: document.languageId === LanguageId.Platform
        || this.isPlatformSourceDocument(document),
      isWorkspaceDocument: Boolean(vscode.workspace.getWorkspaceFolder(document.uri))
    };
  }

  persistentDecorationCacheEnabled(document: vscode.TextDocument) {
    return vscode.workspace.getConfiguration(ConfigurationSection, document?.uri)
      .get(SettingKey.ColoringPersistedCacheEnabled, true);
  }

  compactDecorationSnapshot(document: vscode.TextDocument, snapshot: DecorationSnapshot): CompactDecorationSnapshot | undefined {
    if (!document || !snapshot?.ranges) return undefined;
    const compactRanges: CompactDecorationSnapshot['ranges'] = { classRanges: [], unitRanges: [], globalRanges: [], memberRanges: [], propertyRanges: [], constantRanges: [], enumMemberRanges: [] };
    for (const key of RANGE_KINDS) {
      const unique = new Map<string, [number, number, number, number]>();
      for (const range of snapshot.ranges[key] || []) {
        const value: [number, number, number, number] = [
          range.start.line,
          range.start.character,
          range.end.line,
          range.end.character
        ];
        unique.set(value.join(':'), value);
      }
      compactRanges[key] = [...unique.values()];
    }
    return {
      contentIdentity: snapshot.contentIdentity
        || createHash('sha1').update(document.getText()).digest('hex'),
      ranges: compactRanges
    };
  }

  hydrateDecorationSnapshot(snapshot: CompactDecorationSnapshot, document: vscode.TextDocument): DecorationSnapshot | undefined {
    if (!snapshot?.ranges || !snapshot.contentIdentity) return undefined;
    const ranges: DecorationRanges = { classRanges: [], unitRanges: [], globalRanges: [], memberRanges: [], propertyRanges: [], constantRanges: [], enumMemberRanges: [] };
    for (const key of RANGE_KINDS) {
      ranges[key] = (snapshot.ranges[key] || []).map((value: number[]) => new vscode.Range(
        new vscode.Position(value[0], value[1]),
        new vscode.Position(value[2], value[3])
      ));
    }
    return {
      version: document.version,
      contentIdentity: snapshot.contentIdentity,
      ranges
    };
  }

  queueDecorationSnapshot(document: vscode.TextDocument, snapshot: DecorationSnapshot) {
    if (!document || document.uri.scheme !== UriScheme.File
      || !this.persistentDecorationCacheEnabled(document)) return;
    const compact = this.compactDecorationSnapshot(document, snapshot);
    if (!compact) return;
    const key = normalizeKey(document.fileName);
    this.closedDecorationSnapshots.delete(key);
    this.closedDecorationSnapshots.set(key, compact);
    while (this.closedDecorationSnapshots.size > 12) {
      this.closedDecorationSnapshots.delete(this.closedDecorationSnapshots.keys().next().value!);
    }
    clearTimeout(this.decorationSnapshotPersistTimer);
    this.decorationSnapshotPersistTimer = setTimeout(() => {
      this.decorationSnapshotPersistTimer = undefined;
      void this.persistDecorationSnapshots().catch((error: unknown) => {
        output.appendLine(`Coloring cache persistence skipped: ${errorMessage(error)}`);
      });
    }, 1000);
  }

  persistDecorationSnapshots() {
    return Promise.resolve(this.context.workspaceState.update(
      DECORATION_SNAPSHOT_STATE_KEY,
      [...this.closedDecorationSnapshots]
    ));
  }

  clearDecorations(editor: vscode.TextEditor) {
    if (!editor || editor.document.isClosed
      || !vscode.window.visibleTextEditors.includes(editor)) return;
    for (const decoration of [
      this.decoration,
      this.unitDecoration,
      this.globalDecoration,
      this.memberDecoration,
      this.propertyDecoration,
      this.constantDecoration,
      this.enumMemberDecoration
    ]) editor.setDecorations(decoration, []);
    const state = this.decorationStates.get(editor.document.uri.toString());
    if (state) state.hasApplied = false;
  }

  invalidateInteractiveDocumentState(document: vscode.TextDocument, rewarm = false) {
    if (!document) return;
    const uri = document.uri.toString();
    for (const key of this.definitionPromises.keys()) {
      if (key.startsWith(`${uri}:`)) this.definitionPromises.delete(key);
    }
    for (const key of this.signatureHelpCache.keys()) {
      if (key.startsWith(`${uri}:`)) this.signatureHelpCache.delete(key);
    }
    if (rewarm) {
      this.documentWarmPromises.delete(uri);
      this.documentPackagePromises.delete(uri);
    }
  }

  retireDecorationEditor(editor: vscode.TextEditor) {
    if (!editor) return;
    const state = this.decorationStates.get(editorUri(editor));
    if (!state || state.editor !== editor) return;
    state.generation += 1;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.editor = undefined;
    state.pending = false;
  }

  editorIsLive(editor: vscode.TextEditor | undefined) {
    return Boolean(this.liveDecorationEditor(editor));
  }

  liveDecorationEditor(editor: vscode.TextEditor | undefined) {
    if (!editor || editor.document.isClosed) return undefined;
    const state = this.decorationStates.get(editorUri(editor));
    if (!state) return undefined;
    const visibleEditor = findVisibleEditor(vscode.window.visibleTextEditors, editor);
    if (!visibleEditor || visibleEditor.document.isClosed) return undefined;
    const stateEditor = findVisibleEditor(vscode.window.visibleTextEditors, state.editor);
    if (!stateEditor || editorUri(stateEditor) !== editorUri(visibleEditor)) return undefined;
    if (state.editor !== visibleEditor) state.editor = visibleEditor;
    return visibleEditor;
  }

  pathScore(value: string) {
    return (/trunk-win64-lib/i.test(value) ? 0 : 1000) - value.length;
  }

  async lookup(document: vscode.TextDocument, symbol: string): Promise<CompiledClass | undefined> {
    if (!this.featureEnabled(SettingKey.SymbolsCompiledEnabled, true, document)) return undefined;
    if (!this.tdumpPath || !/^[TI][A-Za-z0-9_]+$/.test(symbol)) return undefined;
    const key = symbol.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key);
    const promise = this.lookupUncached(document, symbol).catch(error => {
      output.appendLine(`Compiled symbol lookup failed for ${symbol}: ${error.message}`);
      return undefined;
    });
    this.cache.set(key, promise);
    return promise;
  }

  async lookupUncached(document: vscode.TextDocument, symbol: string): Promise<CompiledClass | undefined> {
    const candidates = rankBplCandidates(this.bplPaths, document.getText()).slice(0, 24);
    for (const bplPath of candidates) {
      let stdout;
      try {
        stdout = await this.dumpPackage(bplPath, symbol);
      } catch (error) {
        output.appendLine(`Skipped ${path.basename(bplPath)} while looking for ${symbol}: ${errorMessage(error)}`);
        continue;
      }
      const info = parseTdumpExports(stdout, symbol, bplPath);
      if (info) {
        output.appendLine(
          `Resolved compiled symbol ${symbol} from ${path.basename(bplPath)} (${info.methods.length} methods).`
        );
        return info;
      }
    }
    return undefined;
  }

  async dumpPackage(bplPath: string, symbol?: string): Promise<string> {
    let cachePath;
    if (!symbol) {
      try {
        const stat = await fs.promises.stat(bplPath);
        const identity = `${normalizeKey(bplPath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
        const cacheName = createHash('sha1').update(identity).digest('hex');
        const cacheRoot = path.join(this.context.globalStorageUri.fsPath, 'compiled-index-v1');
        cachePath = path.join(cacheRoot, `${cacheName}.tdump.gz`);
        const cached = await fs.promises.readFile(cachePath);
        return (await gunzipAsync(cached)).toString('utf8');
      } catch {
        // A cache miss falls through to tdump; cache corruption is self-healing.
      }
    }
    const temporaryBpl = path.join(os.tmpdir(), `pascal-atlas-${randomUUID()}.bpl`);
    try {
      await fs.promises.copyFile(bplPath, temporaryBpl);
      const args = ['-ns', '-q'];
      if (symbol) args.push(`-ee=${symbol}`);
      args.push(temporaryBpl);
      const { stdout } = await execFileAsync(this.tdumpPath, args, {
        windowsHide: true,
        timeout: symbol ? 8000 : 20000,
        maxBuffer: symbol ? 16 * 1024 * 1024 : 128 * 1024 * 1024
      });
      if (cachePath) {
        try {
          await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.promises.writeFile(cachePath, await gzipAsync(Buffer.from(stdout, 'utf8')));
        } catch (error) {
          output.appendLine(`Compiled index cache write skipped for ${path.basename(bplPath)}: ${errorMessage(error)}`);
        }
      }
      return stdout;
    } finally {
      await fs.promises.rm(temporaryBpl, { force: true });
    }
  }

  async dumpPackageStrings(bplPath: string): Promise<string> {
    const key = normalizeKey(bplPath);
    if (this.packageStringCache.has(key)) return this.packageStringCache.get(key)!;
    const promise = (async () => {
      let cachePath;
      try {
        const stat = await fs.promises.stat(bplPath);
        const identity = `${normalizeKey(bplPath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}:strings`;
        const cacheName = createHash('sha1').update(identity).digest('hex');
        const cacheRoot = path.join(this.context.globalStorageUri.fsPath, 'compiled-index-v1');
        cachePath = path.join(cacheRoot, `${cacheName}.tdump-strings.gz`);
        const cached = await fs.promises.readFile(cachePath);
        return (await gunzipAsync(cached)).toString('utf8');
      } catch {
        // Cache misses and damaged cache files are rebuilt from tdump below.
      }
      const temporaryBpl = path.join(os.tmpdir(), `pascal-atlas-rtti-${randomUUID()}.bpl`);
      try {
        await fs.promises.copyFile(bplPath, temporaryBpl);
        try {
          const { stdout } = await execFileAsync(this.tdumpPath, ['-ns', '-q', '-s4', temporaryBpl], {
            windowsHide: true,
            timeout: 20000,
            maxBuffer: 64 * 1024 * 1024
          });
          if (cachePath) {
            try {
              await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
              await fs.promises.writeFile(cachePath, await gzipAsync(Buffer.from(stdout, 'utf8')));
            } catch (error) {
              output.appendLine(`Compiled RTTI cache write skipped for ${path.basename(bplPath)}: ${errorMessage(error)}`);
            }
          }
          return stdout;
        } catch (error) {
          // tdump may report malformed arbitrary byte strings with exit code 1
          // while still returning the complete, useful string table on stdout.
          if (isRecord(error) && typeof error.stdout === "string" && error.stdout.length > 0) {
            if (cachePath) {
              try {
                await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
                await fs.promises.writeFile(cachePath, await gzipAsync(Buffer.from(error.stdout, 'utf8')));
              } catch (cacheError) {
                output.appendLine(
                  `Compiled RTTI cache write skipped for ${path.basename(bplPath)}: ${errorMessage(cacheError)}`
                );
              }
            }
            return error.stdout;
          }
          throw error;
        }
      } finally {
        await fs.promises.rm(temporaryBpl, { force: true });
      }
    })().catch(error => {
      output.appendLine(`Compiled RTTI string dump failed for ${path.basename(bplPath)}: ${error.message}`);
      return '';
    });
    this.packageStringCache.set(key, promise);
    return promise;
  }

  async indexPackage(bplPath: string): Promise<CompiledPackageData> {
    const key = normalizeKey(bplPath);
    if (this.packageClassCache.has(key)) return this.packageClassCache.get(key)!;
    const startedAt = Date.now();
    const promise = (async () => {
      let cachePath;
      const parsedCacheEnabled = vscode.workspace.getConfiguration(ConfigurationSection)
        .get(SettingKey.SymbolsCompiledParsedCacheEnabled, true);
      try {
        const stat = await fs.promises.stat(bplPath);
        if (parsedCacheEnabled) {
          const identity = `package-v4:${normalizeKey(bplPath)}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
          const cacheName = createHash('sha1').update(identity).digest('hex');
          cachePath = path.join(
            this.context.globalStorageUri.fsPath,
            'compiled-index-v1',
            `${cacheName}.package-index.bin.gz`
          );
          const compressed = await fs.promises.readFile(cachePath);
          const restored: unknown = v8Deserialize(await gunzipAsync(compressed));
          if (isCompiledPackageData(restored)) {
            restored.bplPath = bplPath;
            restored.parsedCacheHit = true;
            return restored;
          }
        }
      } catch {
        // Missing or incompatible parsed caches are rebuilt in the worker.
      }
      const stdout = await this.dumpPackage(bplPath);
      const parsed = await this.compiledParser.parsePackageIndex(stdout, bplPath);
      parsed.parsedCacheHit = false;
      if (cachePath) {
        try {
          await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.promises.writeFile(cachePath, await gzipAsync(v8Serialize(parsed)));
        } catch (error) {
          output.appendLine(
            `Parsed compiled index cache write skipped for ${path.basename(bplPath)}: ${errorMessage(error)}`
          );
        }
      }
      return parsed;
    })()
      .then(index => {
        const { names, units, packageIndex } = index;
        for (const [unitKey, unit] of packageIndex.units) {
          if (!this.unitPackageIndex.has(unitKey)) this.unitPackageIndex.set(unitKey, new Set());
          this.unitPackageIndex.get(unitKey)!.add(bplPath);
          if (!this.compiledUnitsByName.has(unitKey)) this.compiledUnitsByName.set(unitKey, []);
          this.compiledUnitsByName.get(unitKey)!.push(unit);
          const leaf = unitKey.split('.').at(-1)!;
          if (!this.compiledUnitsByLeaf.has(leaf)) this.compiledUnitsByLeaf.set(leaf, []);
          this.compiledUnitsByLeaf.get(leaf)!.push(unit);
        }
        output.appendLine(
          `${index.parsedCacheHit ? 'Restored' : 'Indexed'} compiled package ${path.basename(bplPath)} `
          + `(${names.size} class symbols, ${packageIndex.units.size} units, ${packageIndex.globals.size} globals, `
          + `${packageIndex.routines.size} routines) after ${Date.now() - startedAt}ms.`
        );
        return { names, units, packageIndex, bplPath };
      })
      .catch(error => {
        output.appendLine(`Compiled package index failed for ${path.basename(bplPath)}: ${error.message}`);
        return {
          names: new Map(),
          units: new Map(),
          packageIndex: { units: new Map(), classes: new Map(), globals: new Map(), routines: new Map() },
          bplPath
        };
      })
      .then(index => {
        this.packageIndexReady.add(key);
        this.refreshDocumentsForPackage(index);
        return index;
      });
    this.packageClassCache.set(key, promise);
    return promise;
  }

  displayUnitName(unitName: string, bplPath: string) {
    const base = path.basename(bplPath, path.extname(bplPath));
    const stripped = base.replace(/^(?:bcgl|dcl)/i, '');
    return stripped.toLowerCase() === unitName.toLowerCase() ? stripped : unitName;
  }

  async unitCandidatesForSymbol(symbol: string) {
    const key = symbol.toLowerCase();
    const results = new Set<string>();
    const cached: string[] = [];
    const remaining: string[] = [];
    for (const bplPath of this.bplPaths) {
      (this.packageClassCache.has(normalizeKey(bplPath)) ? cached : remaining).push(bplPath);
    }

    const inspect = async (paths: string[]): Promise<boolean> => {
      for (let start = 0; start < paths.length; start += 8) {
        const batch = paths.slice(start, start + 8);
        const indexes = await Promise.all(batch.map((item: string) => this.indexPackage(item)));
        indexes.forEach((index, indexInBatch) => {
          for (const unitName of index.units.get(key) || []) {
            results.add(this.displayUnitName(unitName, batch[indexInBatch]));
          }
        });
        if (results.size > 0) return true;
      }
      return false;
    };

    if (await inspect(cached)) return [...results];
    await inspect(remaining);
    return [...results];
  }

  async allUnitCandidates() {
    if (this.allUnitIndexPromise) return this.allUnitIndexPromise;
    this.allUnitIndexPromise = (async () => {
      const result: SymbolUnitIndex = new Map();
      for (let start = 0; start < this.bplPaths.length; start += 8) {
        const batch = this.bplPaths.slice(start, start + 8);
        const indexes = await Promise.all(batch.map(item => this.indexPackage(item)));
        indexes.forEach((index, indexInBatch) => {
          for (const [symbol, unitNames] of index.units) {
            if (!result.has(symbol)) result.set(symbol, new Set());
            for (const unitName of unitNames) {
              result.get(symbol)!.add(this.displayUnitName(unitName, batch[indexInBatch]));
            }
          }
        });
      }
      return result;
    })();
    return this.allUnitIndexPromise;
  }

  async allTypeUnitCandidates() {
    if (this.allTypeUnitIndexPromise) return this.allTypeUnitIndexPromise;
    this.allTypeUnitIndexPromise = (async () => {
      const result: SymbolUnitIndex = new Map();
      for (let start = 0; start < this.bplPaths.length; start += 8) {
        const batch = this.bplPaths.slice(start, start + 8);
        const indexes = await Promise.all(batch.map(item => this.indexPackage(item)));
        indexes.forEach((index, indexInBatch) => {
          for (const unit of index.packageIndex.units.values()) {
            for (const [symbol] of unit.classes) {
              if (!result.has(symbol)) result.set(symbol, new Set());
              result.get(symbol)!.add(this.displayUnitName(unit.symbol, batch[indexInBatch]));
            }
          }
        });
      }
      return result;
    })();
    return this.allTypeUnitIndexPromise;
  }

  indexedSymbol(document: vscode.TextDocument, symbol: string | undefined, kinds: readonly ['unit'], options?: LookupOptions): Promise<CompiledUnit | undefined>;
  indexedSymbol(document: vscode.TextDocument, symbol: string | undefined, kinds: readonly [typeof CompiledSymbolKind.Global], options?: LookupOptions): Promise<CompiledGlobal | undefined>;
  indexedSymbol(document: vscode.TextDocument, symbol: string | undefined, kinds: readonly [typeof CompiledSymbolKind.Routine], options?: LookupOptions): Promise<CompiledRoutine | undefined>;
  indexedSymbol(document: vscode.TextDocument, symbol: string | undefined, kinds: readonly ['class'], options?: LookupOptions): Promise<CompiledClass | undefined>;
  indexedSymbol(document: vscode.TextDocument, symbol: string | undefined, kinds?: readonly CompiledInfo['kind'][], options?: LookupOptions): Promise<CompiledInfo | undefined>;
  async indexedSymbol(document: vscode.TextDocument, symbol: string | undefined, kinds: readonly CompiledInfo['kind'][] = [PascalKeyword.Unit, CompiledSymbolKind.Global, PascalKeyword.Class, CompiledSymbolKind.Routine], options: LookupOptions = {}): Promise<CompiledInfo | undefined> {
    if (!symbol) return undefined;
    const key = symbol.toLowerCase();
    const analysis = this.documentAnalysis(document);
    const usedUnits = analysis.usedUnits;
    const ranked = rankBplCandidates(this.bplPaths, analysis.text);
    const cached = ranked.filter(item => options.cachedOnly
      ? this.packageIndexReady.has(normalizeKey(item))
      : this.packageClassCache.has(normalizeKey(item)));
    const sourceIndex = this.sourceIndex || { units: new Map() };
    const packageUnits = [...usedUnits].filter(unitName => !sourceIndex.units?.has(unitName)
      && !sourceIndex.units?.has(unitName.split('.').at(-1)!));
    const hinted = options.cachedOnly ? [] : await this.hintedPackagePaths(packageUnits);
    const priority = uniquePaths([...cached, ...hinted]);
    const priorityKeys = new Set(priority.map(normalizeKey));
    const remaining = options.cachedOnly
      ? []
      : ranked.filter(item => !priorityKeys.has(normalizeKey(item)));
    let fallback: CompiledInfo | undefined;

    const inspect = async (paths: string[]): Promise<CompiledInfo | undefined> => {
      for (let start = 0; start < paths.length; start += 8) {
        const batch = paths.slice(start, start + 8);
        const indexes = await Promise.all(batch.map((item: string) => this.indexPackage(item)));
        const matches: CompiledInfo[] = [];
        for (const index of indexes) {
          if (kinds.includes(PascalKeyword.Unit)) {
            const unit = this.compiledUnitForName(index.packageIndex, key);
            if (unit) matches.push(unit);
          }
          if (kinds.includes(CompiledSymbolKind.Global) && index.packageIndex.globals.has(key)) {
            matches.push(index.packageIndex.globals.get(key)!);
          }
          if (kinds.includes(PascalKeyword.Class) && index.packageIndex.classes.has(key)) {
            matches.push(index.packageIndex.classes.get(key)!);
          }
          if (kinds.includes(CompiledSymbolKind.Routine) && index.packageIndex.routines.has(key)) {
            matches.push(index.packageIndex.routines.get(key)!);
          }
        }
        if (matches.length > 0) {
          const preferred = matches.find(item => usedUnits.has(item.namespace.toLowerCase()));
          if (preferred) return preferred;
          if (!fallback) fallback = matches[0];
        }
      }
      return undefined;
    };

    return await inspect(priority) || await inspect(remaining) || fallback;
  }

  compiledUnitForName(packageIndex: CompiledPackageIndex | undefined, unitName: string): CompiledUnit | undefined {
    const key = unitName.toLowerCase();
    const exact = packageIndex?.units.get(key);
    if (exact) return exact;
    const leaf = key.split('.').at(-1)!;
    const requestedParts = key.split('.');
    const suffixMatches = [...(packageIndex?.units.values() || [])].map(unit => {
      const candidate = unit.symbol.toLowerCase();
      const parts = candidate.split('.');
      if (parts.at(-1) !== leaf) return undefined;
      let score = 1;
      if (candidate.endsWith(`.${key}`)) score = 100;
      else if (parts[0] === requestedParts[0]) {
        score = 50;
        let commonSuffix = 0;
        while (commonSuffix < Math.min(parts.length, requestedParts.length)
          && parts.at(-1 - commonSuffix) === requestedParts.at(-1 - commonSuffix)) {
          commonSuffix += 1;
        }
        score += commonSuffix * 10 - Math.abs(parts.length - requestedParts.length);
      }
      return { unit, score };
    }).filter((value): value is { unit: CompiledUnit; score: number } => Boolean(value)).sort((left, right) => right.score - left.score);
    return suffixMatches.length > 0
      && (suffixMatches.length === 1 || suffixMatches[0].score > suffixMatches[1].score)
      ? suffixMatches[0].unit
      : undefined;
  }

  cachedCompiledUnitForName(unitName: string) {
    const key = unitName.toLowerCase();
    const exact = this.compiledUnitsByName.get(key);
    if (exact?.length) return exact[0];
    const leaf = key.split('.').at(-1)!;
    const candidates = this.compiledUnitsByLeaf.get(leaf) || [];
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) return undefined;
    const requestedParts = key.split('.');
    const score = (unit: { symbol: string; }) => {
      const candidate = unit.symbol.toLowerCase();
      const parts = candidate.split('.');
      if (candidate === key) return 1000;
      if (candidate.endsWith(`.${key}`)) return 500;
      let commonSuffix = 0;
      while (commonSuffix < Math.min(parts.length, requestedParts.length)
        && parts.at(-1 - commonSuffix) === requestedParts.at(-1 - commonSuffix)) {
        commonSuffix += 1;
      }
      return commonSuffix * 10 + Number(parts[0] === requestedParts[0]);
    };
    return [...candidates].sort((left, right) => score(right) - score(left))[0];
  }

  async packageIndexesForUsedUnits(document: vscode.TextDocument): Promise<CompiledUnit[]> {
    const usedUnits = new Set(parseUsesUnits(document.getText()));
    if (usedUnits.size === 0) return [];
    const requestedUnits = [...usedUnits];

    const sourceIndex = this.sourceIndex;
    const compiledUnits = requestedUnits.filter(unitName => {
      const leaf = unitName.split('.').at(-1)!;
      return !isDelphiPlatformUnit(unitName)
        && !sourceIndex?.units?.has(unitName) && !sourceIndex?.units?.has(leaf);
    });

    // Start packages that can be inferred from the Unit namespace immediately.
    // Do not make MVCFramework.*, Spring.*, etc. wait behind the binary owner
    // scan for unrelated legacy Units in the same uses clause.
    const namespacePriority: string[] = [];
    for (const unitName of compiledUnits) {
      const unitKey = unitName.toLowerCase();
      const owner = this.bplPaths.find(item => {
        const base = path.basename(item, path.extname(item)).toLowerCase();
        return unitKey === base || unitKey.startsWith(`${base}.`);
      });
      if (!owner) continue;
      this.unitOwnerPackage.set(unitKey, owner);
      this.unitOwnerPackage.set(unitKey.split('.').at(-1)!, owner);
      if (!namespacePriority.includes(owner)) namespacePriority.push(owner);
    }
    const namespacePriorityPromise = Promise.all(
      namespacePriority.map(item => this.indexPackage(item))
    );

    // Resolve ownership before consulting package indexes. A package often
    // contains references to dependency Units, so the first package that happens
    // to be indexed is not necessarily that Unit's implementation package.
    const hinted = await this.hintedPackagePaths(compiledUnits);
    await Promise.all([
      namespacePriorityPromise,
      ...hinted.map((item: string) => this.indexPackage(item))
    ]);

    const collectMatches = async () => {
      const matches = [];
      const seen = new Set();
      const selectedByUnit = new Map<string, string>();
      for (const unitName of compiledUnits) {
        const leaf = unitName.split('.').at(-1)!;
        const owner = this.unitOwnerPackage.get(unitName) || this.unitOwnerPackage.get(leaf);
        if (owner) {
          selectedByUnit.set(unitName, owner);
          continue;
        }
        const candidates = [...new Set([
          ...(this.unitPackageIndex.get(unitName) || []),
          ...(this.unitPackageIndex.get(leaf) || [])
        ])];
        // With no DCP owner, prefer a package whose own name matches the Unit;
        // otherwise use one stable best candidate instead of fanning out to all
        // packages that merely link against it.
        const exact = candidates.find(item => {
          const base = path.basename(item, path.extname(item)).toLowerCase();
          return base === unitName || base === leaf;
        });
        const selected = exact || candidates.sort((left, right) =>
          this.pathScore(right) - this.pathScore(left))[0];
        if (selected) selectedByUnit.set(unitName, selected);
      }
      const packagePaths = [...new Set(selectedByUnit.values())];
      const indexes = await Promise.all(packagePaths.map(async bplPath => ({
        bplPath,
        index: await this.indexPackage(bplPath)
      })));
      const indexesByPath = new Map(indexes.map(item => [normalizeKey(item.bplPath), item.index]));
      for (const [unitName, bplPath] of selectedByUnit) {
        const index = indexesByPath.get(normalizeKey(bplPath));
        const leaf = unitName.split('.').at(-1)!;
        const unit = this.compiledUnitForName(index?.packageIndex, unitName)
          || this.compiledUnitForName(index?.packageIndex, leaf);
        const key = unit ? `${normalizeKey(unit.bplPath)}:${unitName}` : undefined;
        if (unit && !seen.has(key)) {
          seen.add(key);
          matches.push(unit);
        }
      }
      return matches;
    };

    return collectMatches();
  }

  async hintedPackagePaths(unitNames: string[]): Promise<string[]> {
    if (unitNames.length === 0) return [];
    // A decoration request may arrive between setting tdumpPath and completing
    // workspace discovery. An empty answer in that window is not a real result
    // and must not poison the hint cache for the rest of the VS Code session.
    if (!this.compiledDiscoveryReady || this.bplPaths.length === 0 || this.dcpPathsByBase.size === 0) return [];
    const alreadyOwned: string[] = [];
    const unresolvedUnits = [];
    for (const unitName of unitNames) {
      const owner = this.unitOwnerPackage.get(unitName.toLowerCase())
        || this.unitOwnerPackage.get(unitName.toLowerCase().split('.').at(-1)!);
      if (owner) {
        if (!alreadyOwned.includes(owner)) alreadyOwned.push(owner);
      } else {
        // Namespaced Delphi libraries conventionally place Units such as
        // MVCFramework.Servlet in MVCFramework.bpl. Prefer this deterministic
        // basename match before inspecting binary ownership signatures.
        const unitKey = unitName.toLowerCase();
        const namespaceOwner = this.bplPaths.find(item => {
          const base = path.basename(item, path.extname(item)).toLowerCase();
          return unitKey === base || unitKey.startsWith(`${base}.`);
        });
        if (namespaceOwner) {
          this.unitOwnerPackage.set(unitKey, namespaceOwner);
          this.unitOwnerPackage.set(unitKey.split('.').at(-1)!, namespaceOwner);
          if (!alreadyOwned.includes(namespaceOwner)) alreadyOwned.push(namespaceOwner);
        } else {
          unresolvedUnits.push(unitName);
        }
      }
    }
    if (unresolvedUnits.length === 0) return alreadyOwned;
    unitNames = unresolvedUnits;
    const signature = [...unitNames].sort().join(';');
    if (this.dcpHintCache.has(signature)) return this.dcpHintCache.get(signature)!;
    const promise = (async () => {
      const storageKey = `pascalAtlas.dcpHintsV2:${this.dcpFingerprint}:${signature}`;
      const persisted = asStringArray(this.context.workspaceState.get(storageKey, []));
      if (persisted.length > 0) {
        const byBase = new Map(this.bplPaths.map(item => [
          path.basename(item, path.extname(item)).toLowerCase(),
          item
        ]));
        const restored: string[] = [];
        for (const entry of persisted) {
          const separator = entry.indexOf('=');
          if (separator <= 0) continue;
          const unitName = entry.slice(0, separator);
          const bplPath = byBase.get(entry.slice(separator + 1));
          if (!bplPath) continue;
          this.unitOwnerPackage.set(unitName, bplPath);
          this.unitOwnerPackage.set(unitName.split('.').at(-1)!, bplPath);
          if (!restored.includes(bplPath)) restored.push(bplPath);
        }
        if (restored.length > 0) {
          await this.persistUnitOwnerCache();
          output.appendLine(
            `Current-file package hints restored for [${unitNames.join(', ')}]: `
            + `${restored.map(item => path.basename(item)).join(', ')}.`
          );
          return uniquePaths([...alreadyOwned, ...restored]);
        }
      }
      const scores = new Map<string, Map<string, number>>();
      const escaped = unitNames.map((unit: string) => {
        const leaf = unit.split('.').at(-1)!;
        return {
          unit,
          expression: new RegExp(
            `(?:_ZN|_ZTRN|_ZTVN)${leaf.length}${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
            'gi'
          )
        };
      });
      const candidates = this.bplPaths
        .map(bplPath => ({
          bplPath,
          dcpPath: this.dcpPathsByBase.get(path.basename(bplPath, path.extname(bplPath)).toLowerCase())
        }))
        .filter(item => item.dcpPath);
      for (let start = 0; start < candidates.length; start += 6) {
        const batch = candidates.slice(start, start + 6);
        const values = await Promise.all(batch.map(async item => {
          try {
            // Count definition-shaped Itanium names in the BPL. A DCP also
            // repeats dependency references heavily (Triangulation appeared
            // 269/264/235 times in owner/consumers), while `_ZN/_ZTRN/_ZTVN`
            // counts retain a clear 29/10/9 ownership signal.
            return (await fs.promises.readFile(item.bplPath)).toString('latin1');
          } catch {
            return '';
          }
        }));
        values.forEach((value, index) => {
          if (!value) return;
          const perUnit = new Map<string, number>();
          for (const item of escaped) perUnit.set(item.unit, [...value.matchAll(item.expression)].length);
          scores.set(batch[index].bplPath, perUnit);
        });
      }
      const result: string[] = [];
      const persistedOwners = [];
      for (const unitName of unitNames) {
        const ranked = [...scores].map(([bplPath, perUnit]) => ({
          bplPath,
          score: perUnit.get(unitName) || 0
        })).filter(item => item.score > 0)
          .sort((left, right) => right.score - left.score);
        // A real owner normally contains both the Unit implementation and its
        // RTTI, while consumers still contain imported symbol names. Requiring
        // a 3x lead rejected valid shared packages such as bcglGeoAlgo3D (15
        // Triangulation symbols versus 6 in a consumer). A 2x lead remains
        // conservative while correctly selecting the implementation package.
        const confident = ranked[0] && ranked[0].score >= 3
          && (!ranked[1] || ranked[0].score >= ranked[1].score * 2);
        if (confident) {
          const unitKey = unitName.toLowerCase();
          const ownerPath = ranked[0].bplPath;
          this.unitOwnerPackage.set(unitKey, ownerPath);
          this.unitOwnerPackage.set(unitKey.split('.').at(-1)!, ownerPath);
          persistedOwners.push(
            `${unitKey}=${path.basename(ownerPath, path.extname(ownerPath)).toLowerCase()}`
          );
          if (!result.includes(ownerPath)) result.push(ownerPath);
        }
      }
      output.appendLine(
        `Current-file package hints for [${unitNames.join(', ')}]: `
        + `${result.map(item => path.basename(item)).join(', ') || 'none'}.`
      );
      await this.context.workspaceState.update(storageKey, persistedOwners);
      await this.persistUnitOwnerCache();
      return uniquePaths([...alreadyOwned, ...result]);
    })();
    this.dcpHintCache.set(signature, promise);
    return promise;
  }

  persistUnitOwnerCache() {
    if (!this.dcpFingerprint) return Promise.resolve();
    const owners: Record<string, string> = {};
    for (const [unitName, bplPath] of this.unitOwnerPackage) {
      owners[unitName] = path.basename(bplPath, path.extname(bplPath)).toLowerCase();
    }
    return this.context.workspaceState.update(
      `pascalAtlas.dcpOwnersV1:${this.dcpFingerprint}`,
      owners
    );
  }

  warmRemainingPackages() {
    if (this.backgroundWarmPromise) return;
    this.backgroundWarmPromise = (async () => {
      const remaining = this.bplPaths.filter(item => !this.packageClassCache.has(normalizeKey(item)));
      for (let start = 0; start < remaining.length; start += 4) {
        await Promise.all(remaining.slice(start, start + 4).map(item => this.indexPackage(item)));
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
      const active = vscode.window.activeTextEditor;
      if (active) this.scheduleDecorate(active, 0);
    })().catch(error => output.appendLine(`Background package warm-up failed: ${error.message}`));
  }

  packageDataForDocument(document: vscode.TextDocument): Promise<PackageDocumentData> {
    if (!this.tdumpPath || document.languageId !== LanguageId.Pascal) {
      return Promise.resolve({ directIndexes: [], usedUnitIndexes: [] });
    }
    // RTL/VCL/FMX source files already have authoritative source declarations.
    // Treating their legacy Uses entries (for example WinUtils) as package-only
    // Units caused a pointless scan of every DCP before the new editor painted.
    if (this.isPlatformSourceDocument(document)) {
      return Promise.resolve({ directIndexes: [], usedUnitIndexes: [] });
    }
    if (!this.compiledDiscoveryReady || this.bplPaths.length === 0) {
      return Promise.resolve({ directIndexes: [], usedUnitIndexes: [] });
    }
    const key = document.uri.toString();
    const cached = this.documentPackagePromises.get(key);
    if (cached?.version === document.version) return cached.promise;
    const packageLimit = vscode.workspace.getConfiguration(ConfigurationSection, document.uri)
      .get(SettingKey.SymbolsCompiledInitialPackageLimit, 8);
    const analysis = this.documentAnalysis(document);
    const ownUnitNames = new Set([
      analysis.ownUnit,
      analysis.ownUnit?.split('.').at(-1)!
    ].filter(Boolean));
    const exactPackages = this.bplPaths.filter(item =>
      ownUnitNames.has(path.basename(item, path.extname(item)).toLowerCase()));
    const readyPackages = bplCandidatesForDocument(this.bplPaths, analysis.text)
      .filter(item => this.packageIndexReady.has(normalizeKey(item)));
    // Do not make current-file decoration wait for an arbitrary batch of eight
    // packages. Used Units are resolved separately via DCP ownership; the direct
    // list only needs this Unit's own package and already warm indexes.
    const packagePaths = uniquePaths([...exactPackages, ...readyPackages]).slice(0, packageLimit);
    const startedAt = Date.now();
    const promise = Promise.all([
      Promise.all(packagePaths.map(item => this.indexPackage(item))),
      this.packageIndexesForUsedUnits(document)
    ]).then(([directIndexes, usedUnitIndexes]) => {
      // This document already has a decoration pass awaiting the complete batch.
      // Cancel per-package refresh timers so Appbase/MvcEnv/MVCFramework_Cef are
      // committed together instead of visibly repainting the editor three times.
      clearTimeout(this.pendingPackageRefreshes.get(key));
      this.pendingPackageRefreshes.delete(key);
      output.appendLine(
        `Current-file package batch ready for ${path.basename(document.fileName)}: `
        + `${usedUnitIndexes.length} used Unit(s), ${directIndexes.length} direct package(s) `
        + `after ${Date.now() - startedAt}ms.`
      );
      return { directIndexes, usedUnitIndexes };
    });
    const cacheEntry = { version: document.version, promise, pending: true };
    this.documentPackagePromises.set(key, cacheEntry);
    promise.then(
      () => {
        if (this.documentPackagePromises.get(key) === cacheEntry) cacheEntry.pending = false;
      },
      () => {
        if (this.documentPackagePromises.get(key) === cacheEntry) cacheEntry.pending = false;
      }
    );
    return promise;
  }

  warmCurrentDocument(document: vscode.TextDocument) {
    if (!document || document.languageId !== LanguageId.Pascal
      || !this.featureEnabled(SettingKey.NavigationPrewarmCurrentFile, true, document)) return;
    // Always prepare the current source file first. This makes local and
    // cross-project source definitions available before any BPL work starts.
    const analysis = this.documentAnalysis(document);
    if (this.isPlatformSourceDocument(document)) return Promise.resolve();
    if (!this.tdumpPath || !this.featureEnabled(SettingKey.SymbolsCompiledEnabled, true, document)) {
      return Promise.resolve();
    }
    const key = document.uri.toString();
    const cached = this.documentWarmPromises.get(key);
    if (cached?.version === document.version) return cached.promise;
    const promise = (async () => {
      const startedAt = Date.now();
      const identifiers = new Set(
        [...analysis.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)]
          .map(match => match[0].toLowerCase())
      );
      for (const match of analysis.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
        const chain = pascalMemberChainBefore(analysis.text, match.index, analysis.code);
        if (chain.length === 0) continue;
        const inferred = inferPascalTypeFromIndex(
          analysis.typeInferenceIndex,
          chain[0],
          match.index
        );
        if (inferred) identifiers.add(pascalTypeBaseName(inferred).toLowerCase());
      }
      const { usedUnitIndexes } = await this.packageDataForDocument(document);
      const enrichments = [];
      const seen = new Set();
      for (const unit of usedUnitIndexes) {
        for (const [name, info] of unit.classes) {
          const identity = `class:${name}:${normalizeKey(info.bplPath)}`;
          if (identifiers.has(name) && !seen.has(identity)) {
            seen.add(identity);
            enrichments.push(this.enrichClass(info));
          }
        }
        for (const [name, info] of unit.globals) {
          const identity = `global:${name}:${normalizeKey(info.bplPath)}`;
          if (identifiers.has(name) && !seen.has(identity)) {
            seen.add(identity);
            enrichments.push(this.enrichGlobal(info, { workspaceMembers: false }));
          }
        }
        for (const [name, overloads] of unit.routines) {
          const info = overloads[0];
          const identity = `routine:${name}:${normalizeKey(info.bplPath)}`;
          if (identifiers.has(name) && !seen.has(identity)) {
            seen.add(identity);
            enrichments.push(this.enrichRoutine(info, { workspaceMembers: false }));
          }
        }
      }
      await Promise.all(enrichments);
      output.appendLine(
        `Current-file navigation warm-up completed for ${path.basename(document.fileName)} `
        + `(${usedUnitIndexes.length} compiled unit(s), ${enrichments.length} referenced object(s)) `
        + `after ${Date.now() - startedAt}ms.`
      );
    })().catch(error => {
      output.appendLine(`Current-file navigation warm-up failed for ${document.fileName}: ${error.message}`);
    });
    this.documentWarmPromises.set(key, { version: document.version, promise });
    return promise;
  }

  async workspaceMemberIndex() {
    if (this.workspaceMemberIndexPromise) return this.workspaceMemberIndexPromise;
    this.workspaceMemberIndexPromise = (async () => {
      const result: ObservedMemberIndex = new Map();
      const files = await vscode.workspace.findFiles(
        '**/*.{pas,pp,dpr,dpk}',
        '**/{.git,.hg,.svn,node_modules,.vsdcache}/**',
        20000
      );
      for (let start = 0; start < files.length; start += 32) {
        const parsed = await Promise.all(files.slice(start, start + 32).map(async uri => {
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            return maskPascalNonCode(Buffer.from(bytes).toString('utf8'));
          } catch {
            return '';
          }
        }));
        for (const code of parsed) {
          await yieldToExtensionHost();
          parseObservedMemberReferences(code, result);
        }
      }
      output.appendLine(`Indexed ${files.length} Pascal files for compiled-object member references.`);
      return result;
    })();
    return this.workspaceMemberIndexPromise;
  }

  mangledClassesForPackage(bplPath: string): Promise<Map<string, CompiledClass>> {
    const packageKey = normalizeKey(bplPath);
    if (this.packageMangledClassCache.has(packageKey)) {
      return this.packageMangledClassCache.get(packageKey)!;
    }
    const promise = (async () => {
      let cachePath;
      const parsedCacheEnabled = vscode.workspace.getConfiguration(ConfigurationSection)
        .get(SettingKey.SymbolsCompiledParsedCacheEnabled, true);
      try {
        const stat = await fs.promises.stat(bplPath);
        if (parsedCacheEnabled) {
          const identity = `mangled-v2:${packageKey}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
          const cacheName = createHash('sha1').update(identity).digest('hex');
          cachePath = path.join(
            this.context.globalStorageUri.fsPath,
            'compiled-index-v1',
            `${cacheName}.mangled-classes.bin.gz`
          );
          const restored = v8Deserialize(await gunzipAsync(await fs.promises.readFile(cachePath)));
          if (restored instanceof Map) return restored;
        }
      } catch {
        // Fall through to the shared string dump and worker parser.
      }
      const strings = await this.dumpPackageStrings(bplPath);
      const classes = await this.compiledParser.parseMangledClasses(strings, bplPath);
      if (cachePath) {
        try {
          await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.promises.writeFile(cachePath, await gzipAsync(v8Serialize(classes)));
        } catch (error) {
          output.appendLine(
            `Parsed mangled-class cache write skipped for ${path.basename(bplPath)}: ${errorMessage(error)}`
          );
        }
      }
      return classes;
    })();
    this.packageMangledClassCache.set(packageKey, promise);
    return promise;
  }

  async enrichGlobal(global: CompiledGlobal | undefined, options: EnrichmentOptions = {}): Promise<CompiledGlobal | undefined> {
    if (!global) return global;
    if (options.cachedOnly && !global.rttiLoaded && !global.rttiPromise) return global;
    if (!global.rttiLoaded) {
      if (!global.rttiPromise) global.rttiPromise = (async () => {
      if (global.classInfo && !global.classInfo.rttiMembers) {
        await this.enrichClass(global.classInfo);
        global.classInfo.rttiMembers ||= [];
        output.appendLine(
          `Recovered ${global.classInfo.rttiMembers.length} RTTI members for `
          + `${global.namespace}.${global.classInfo.symbol}.`
        );
      }
        global.rttiLoaded = true;
        return global;
      })();
      try {
        await global.rttiPromise;
      } catch (error) {
        global.rttiPromise = undefined;
        throw error;
      }
    }
    if (options.workspaceMembers === false || global.workspaceMembersLoaded) return global;
    if (global.workspaceEnrichmentPromise) return global.workspaceEnrichmentPromise;
    global.workspaceEnrichmentPromise = (async () => {
      const index = await this.workspaceMemberIndex();
      global.observedMembers = [...(index.get(global.symbol.toLowerCase()) || new Map()).values()]
        .map(name => ({ name, signature: `${global.symbol}.${name}`, inferred: true }));
      global.workspaceMembersLoaded = true;
      return global;
    })();
    try {
      return await global.workspaceEnrichmentPromise;
    } catch (error) {
      global.workspaceEnrichmentPromise = undefined;
      throw error;
    }
  }

  async enrichRoutine(routine: CompiledRoutine | undefined, options: EnrichmentOptions = {}): Promise<CompiledRoutine | undefined> {
    if (!routine) return routine;
    if (options.cachedOnly && !routine.returnTypeLoaded && !routine.returnTypePromise) return routine;
    if (!routine.returnTypeLoaded) {
      if (!routine.returnTypePromise) routine.returnTypePromise = (async () => {
      const classes = await this.mangledClassesForPackage(routine.bplPath);
      routine.classInfo = inferRoutineReturnClass(routine.symbol, classes);
      routine.typeName = routine.classInfo?.symbol;
        routine.returnTypeLoaded = true;
        return routine;
      })();
      try {
        await routine.returnTypePromise;
      } catch (error) {
        routine.returnTypePromise = undefined;
        throw error;
      }
    }
    if (options.workspaceMembers === false || routine.workspaceMembersLoaded) return routine;
    if (routine.workspaceEnrichmentPromise) return routine.workspaceEnrichmentPromise;
    routine.workspaceEnrichmentPromise = (async () => {
      const index = await this.workspaceMemberIndex();
      routine.observedMembers = [...(index.get(routine.symbol.toLowerCase()) || new Map()).values()]
        .map(name => ({ name, signature: `${routine.symbol}.${name}`, inferred: true }));
      routine.workspaceMembersLoaded = true;
      if (routine.classInfo) {
        output.appendLine(
          `Inferred compiled routine ${routine.namespace}.${routine.symbol} returns ${routine.classInfo.symbol} `
          + `(${routine.classInfo.methods.length} recovered members).`
        );
      }
      return routine;
    })();
    try {
      return await routine.workspaceEnrichmentPromise;
    } catch (error) {
      routine.workspaceEnrichmentPromise = undefined;
      throw error;
    }
  }

  async enrichClass(classInfo: CompiledClass | undefined, options: EnrichmentOptions = {}): Promise<CompiledClass | undefined> {
    if (!classInfo) return classInfo;
    const packageKey = normalizeKey(classInfo.bplPath);
    if (options.cachedOnly && !classInfo.compiledMembersLoaded && !classInfo.compiledMembersPromise
      && !this.packageMangledClassCache.has(packageKey)) {
      return classInfo;
    }
    if (classInfo.compiledMembersLoaded) return classInfo;
    if (!classInfo.compiledMembersPromise) classInfo.compiledMembersPromise = (async () => {
      const recovered = (await this.mangledClassesForPackage(classInfo.bplPath))
        .get(classInfo.symbol.toLowerCase());
      if (recovered) {
        for (const method of recovered.methods) {
          const existing = classInfo.methods.find((item: { name: string; }) =>
            item.name.toLowerCase() === method.name.toLowerCase());
          if (!existing) {
            classInfo.methods.push(method);
          } else if (method.typeName && !existing.typeName) {
            existing.typeName = method.typeName;
          }
        }
        for (const property of recovered.properties || []) {
          if (!classInfo.properties.some((item: { name: string; }) => item.name.toLowerCase() === property.name.toLowerCase())) {
            classInfo.properties.push(property);
          }
        }
        classInfo.rttiMembers = [...(recovered.rttiMembers || [])];
      }
      classInfo.compiledMembersLoaded = true;
      return classInfo;
    })();
    try {
      return await classInfo.compiledMembersPromise;
    } catch (error) {
      classInfo.compiledMembersPromise = undefined;
      throw error;
    }
  }

  wordAt(document: vscode.TextDocument, position: vscode.Position) {
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (!range) return undefined;
    const start = document.offsetAt(range.start);
    const end = document.offsetAt(range.end);
    const analysis = this.documentAnalysis(document);
    return analysis.code.slice(start, end).trim()
      ? { range, word: document.getText(range) }
      : undefined;
  }

  navigationBlockedAt(document: vscode.TextDocument, position: vscode.Position, suppliedToken?: WordToken) {
    const token = suppliedToken || this.wordAt(document, position);
    if (!token) return false;
    const analysis = this.documentAnalysis(document);
    return isPascalNonNavigableIdentifierAt(
      analysis.code,
      document.offsetAt(token.range.start),
      token.word
    );
  }

  async infoAt(document: vscode.TextDocument, position: vscode.Position, inferObjectType = false) {
    const token = this.wordAt(document, position);
    if (!token) return undefined;
    let typeName = token.word;
    if (inferObjectType && !/^[TI][A-Za-z0-9_]+$/.test(typeName)) {
      const analysis = this.documentAnalysis(document);
      typeName = inferPascalTypeFromIndex(
        analysis.typeInferenceIndex,
        token.word,
        document.offsetAt(token.range.start)
      ) || token.word;
    }
    const info = typeName ? await this.lookup(document, typeName) : undefined;
    return info ? { info, token } : undefined;
  }

  async compiledReferenceAt(document: vscode.TextDocument, position: vscode.Position, options: LookupOptions = {}): Promise<CompiledReference | undefined> {
    if (!this.featureEnabled(SettingKey.SymbolsCompiledEnabled, true, document)) return undefined;
    const token = this.wordAt(document, position);
    if (!token) return undefined;
    if (this.navigationBlockedAt(document, position, token)) return undefined;
    const analysis = this.documentAnalysis(document);
    const { text, code } = analysis;
    const enrichmentOptions = options.cachedOnly
      ? { workspaceMembers: false, cachedOnly: true }
      : {};
    const start = document.offsetAt(token.range.start);
    const qualifier = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(code.slice(0, start))?.[1];

    const receiverChain = pascalMemberChainBefore(text, start, code);
    if (receiverChain.length > 0) {
      const receiverInfos = await this.compiledReceiverInfosForChain(
        document,
        analysis,
        receiverChain,
        start,
        options
      );
      for (const classInfo of receiverInfos) {
        const member = knownCompiledMembers(classInfo).get(token.word.toLowerCase());
        if (!member) continue;
        return {
          info: classInfo,
          token,
          target: {
            kind: member.kind,
            name: token.word,
            className: classInfo.symbol
          },
          member: member.value
        };
      }
      // Some package-only Delphi interfaces retain their own RTTI name but not
      // their ancestor table (for example a request context inheriting response
      // methods). Resolve only a unique interface member in the same Unit.
      for (const receiverInfo of receiverInfos) {
        const packageKey = normalizeKey(receiverInfo.bplPath);
        if (options.cachedOnly && !this.packageMangledClassCache.has(packageKey)) continue;
        const fallback = uniqueCompiledInterfaceMember(
          receiverInfo,
          await this.mangledClassesForPackage(receiverInfo.bplPath),
          token.word
        );
        if (!fallback) continue;
        return {
          info: fallback.info,
          token,
          target: {
            kind: fallback.member.kind,
            name: token.word,
            className: fallback.info.symbol
          },
          member: fallback.member.value
        };
      }
    }

    // An unqualified call inside a method can be inherited from a compiled
    // base class. Follow the active source class hierarchy before treating the
    // name as an unrelated package-level routine.
    if (receiverChain.length === 0 && !qualifier) {
      const selfTypes = this.receiverTypeNames(analysis, 'Self', start);
      for (const selfType of selfTypes) {
        const classInfos = await this.compiledInfosForSourceHierarchy(
          document,
          analysis,
          selfType,
          options
        );
        for (const classInfo of classInfos) {
          const member = knownCompiledMembers(classInfo).get(token.word.toLowerCase());
          if (!member) continue;
          return {
            info: classInfo,
            token,
            target: {
              kind: member.kind,
              name: token.word,
              className: classInfo.symbol
            },
            member: member.value
          };
        }
      }
    }

    if (qualifier) {
      const initializerRoutine = inferPascalInitializerRoutine(text, qualifier, start, code);
      if (initializerRoutine) {
        const initializedBy = await this.enrichRoutine(await this.indexedSymbol(
          document,
          initializerRoutine,
          [CompiledSymbolKind.Routine],
          options
        ), enrichmentOptions);
        if (initializedBy?.classInfo) {
          const member = knownCompiledMembers(initializedBy.classInfo, initializedBy.observedMembers)
            .get(token.word.toLowerCase());
          if (member) {
            return {
              info: initializedBy,
              token,
              target: {
                kind: member.kind,
                name: token.word,
                className: initializedBy.classInfo.symbol
              },
              member: member.value
            };
          }
        }
      }

      const global = await this.enrichGlobal(
        await this.indexedSymbol(document, qualifier, [CompiledSymbolKind.Global], options),
        enrichmentOptions
      );
      let classInfo = global?.classInfo;
      if (!classInfo) {
        const typeNames = this.receiverTypeNames(analysis, qualifier, start);
        if (typeNames.length === 0 && /^[TI][A-Za-z0-9_]+$/.test(qualifier)) {
          typeNames.push(qualifier);
        }
        for (const typeName of typeNames) {
          classInfo = await this.enrichClass(
            await this.indexedSymbol(document, typeName, [PascalKeyword.Class], options),
            enrichmentOptions
          );
          if (classInfo) break;
        }
      }
      if (classInfo) {
        const member = knownCompiledMembers(classInfo, global?.observedMembers).get(token.word.toLowerCase());
        if (member) {
          return {
            info: global || classInfo,
            token,
            target: {
              kind: member.kind,
              name: token.word,
              className: classInfo.symbol
            },
            member: member.value
          };
        }
      }


      const routine = await this.enrichRoutine(await this.indexedSymbol(
        document,
        qualifier,
        [CompiledSymbolKind.Routine],
        options
      ), enrichmentOptions);
      if (routine?.classInfo) {
        const member = knownCompiledMembers(routine.classInfo, routine.observedMembers)
          .get(token.word.toLowerCase());
        if (member) {
          return {
            info: routine,
            token,
            target: {
              kind: member.kind,
              name: token.word,
              className: routine.classInfo.symbol
            },
            member: member.value
          };
        }
      }

      const unit = await this.indexedSymbol(document, qualifier, [PascalKeyword.Unit], options);
      if (unit) {
        const globalMember = unit.globals.get(token.word.toLowerCase());
        const routines = unit.routines.get(token.word.toLowerCase());
        const classMember = unit.classes.get(token.word.toLowerCase());
        const member = globalMember || routines?.[0] || classMember;
        if (member) {
          return {
            info: globalMember || unit,
            token,
            target: {
              kind: globalMember ? CompiledSymbolKind.Global : (routines ? CompiledSymbolKind.Routine : PascalKeyword.Class),
              name: token.word,
              className: classMember?.symbol
            },
            member
          };
        }
      }
    }

    const indexed = await this.indexedSymbol(document, token.word, [PascalKeyword.Unit, CompiledSymbolKind.Global, PascalKeyword.Class, CompiledSymbolKind.Routine], options);
    if (indexed) {
      if (indexed.kind === CompiledSymbolKind.Global) await this.enrichGlobal(indexed, enrichmentOptions);
      if (indexed.kind === SourceSymbolKind.Routine) await this.enrichRoutine(indexed, enrichmentOptions);
      return {
        info: indexed,
        token,
        target: { kind: indexed.kind, name: token.word },
        member: indexed
      };
    }
    return undefined;
  }

  typeAt(document: vscode.TextDocument, position: vscode.Position, inferObjectType = false) {
    const token = this.wordAt(document, position);
    if (!token) return undefined;
    let typeName = token.word;
    if (inferObjectType && !/^[TI][A-Za-z0-9_]+$/.test(typeName)) {
      const analysis = this.documentAnalysis(document);
      typeName = inferPascalTypeFromIndex(
        analysis.typeInferenceIndex,
        token.word,
        document.offsetAt(token.range.start)
      ) || token.word;
    }
    return typeName ? { typeName, token } : undefined;
  }

  receiverTypeNames(analysis: DocumentAnalysis, qualifier: string, offset: number): string[] {
    const inferred = inferPascalTypeFromIndex(analysis.typeInferenceIndex, qualifier, offset)
      || this.sourceForInVariableType(analysis, qualifier, offset);
    if (!inferred) return [];
    const names = [inferred];
    const seen = new Set([inferred.toLowerCase()]);
    if (qualifier.toLowerCase() !== PascalKeyword.Self) return names;

    // In a class/record helper, Self can address both helper methods and the
    // extended type. Keep both candidates: source navigation checks the helper
    // first, while compiled-package fallback can resolve the extended class.
    const key = inferred.toLowerCase().split('.').at(-1)!;
    const definitions = [
      ...(analysis.sourceUnit?.types || []).filter((item: { symbol: string; }) =>
        item.symbol.toLowerCase().split('.').at(-1)! === key),
      ...(this.sourceIndex?.types.get(key) || [])
    ];
    for (const definition of definitions) {
      const target = definition.helperTarget;
      if (!target || seen.has(target.toLowerCase())) continue;
      seen.add(target.toLowerCase());
      names.push(target);
    }
    return names;
  }

  sourceForInVariableType(analysis: DocumentAnalysis, identifier: string, offset: number): string | undefined {
    const collectionName = pascalForInCollectionFromIndex(
      analysis.typeInferenceIndex,
      identifier,
      offset
    );
    if (!collectionName) return undefined;
    const collectionType = inferPascalTypeFromIndex(
      analysis.typeInferenceIndex,
      collectionName,
      offset
    );
    if (!collectionType) return undefined;

    return this.sourceCollectionElementType(analysis, collectionType);
  }

  sourceCollectionElementType(analysis: DocumentAnalysis, collectionType: string, visited = new Set<string>()): string | undefined {
    const direct = inferPascalCollectionElementType(collectionType);
    if (direct) return direct;
    const collectionKey = pascalTypeBaseName(collectionType).toLowerCase();
    if (!collectionKey || visited.has(collectionKey)) return undefined;
    const nextVisited = new Set(visited);
    nextVisited.add(collectionKey);
    const definitions = [
      ...(analysis.sourceUnit?.types || []).filter((item: SourceDefinition) =>
        pascalTypeBaseName(item.symbol).toLowerCase() === collectionKey),
      ...(this.sourceIndex?.types.get(collectionKey) || [])
    ];
    for (const definition of definitions) {
      const parameters = definition.typeParameters || [];
      if (definition.elementType) {
        return substitutePascalTypeParameters(
          definition.elementType,
          parameters,
          collectionType
        );
      }
      if (!definition.aliasedType) continue;
      const alias = substitutePascalTypeParameters(
        definition.aliasedType,
        parameters,
        collectionType
      );
      const aliasedElement = inferPascalCollectionElementType(alias)
        || this.sourceCollectionElementType(analysis, alias, nextVisited);
      if (aliasedElement) return aliasedElement;
    }
    return undefined;
  }

  sourceMemberDefinitionsForType(analysis: DocumentAnalysis, typeName: string, memberName: string): SourceDefinition[] {
    return findSourceMemberDefinitions(
      [analysis.localSourceIndex, this.sourceIndex],
      typeName,
      memberName
    );
  }

  sourceMemberResultType(analysis: DocumentAnalysis, receiverType: string, definition: SourceDefinition): string | undefined {
    if (!definition?.typeName) return undefined;
    const ownerKey = pascalTypeBaseName(definition.owner || receiverType).toLowerCase();
    const ownerDefinitions = [
      ...(analysis.sourceUnit?.types || []).filter((item: SourceDefinition) =>
        pascalTypeBaseName(item.symbol).toLowerCase() === ownerKey),
      ...(this.sourceIndex?.types.get(ownerKey) || [])
    ];
    const parameters = ownerDefinitions.find(item => item.typeParameters?.length)
      ?.typeParameters || [];
    return substitutePascalTypeParameters(definition.typeName, parameters, receiverType);
  }

  sourceReceiverTypesForChain(analysis: DocumentAnalysis, chain: string[], offset: number): string[] {
    if (chain.length === 0) return [];
    let types = this.receiverTypeNames(analysis, chain[0], offset);
    const firstType = pascalTypeBaseName(chain[0]);
    const firstKey = firstType.toLowerCase();
    if (types.length === 0 && (
      analysis.sourceUnit?.types?.some((item: SourceDefinition) =>
        pascalTypeBaseName(item.symbol).toLowerCase() === firstKey)
      || this.sourceIndex?.types.has(firstKey)
    )) {
      types = [chain[0]];
    }
    for (const memberName of chain.slice(1)) {
      const next = [];
      const seen = new Set();
      for (const typeName of types) {
        if (memberName === PASCAL_INDEX_DEREFERENCE) {
          const resultType = this.sourceCollectionElementType(analysis, typeName);
          if (resultType && !seen.has(resultType.toLowerCase())) {
            seen.add(resultType.toLowerCase());
            next.push(resultType);
          }
          continue;
        }
        for (const definition of this.sourceMemberDefinitionsForType(
          analysis, typeName, memberName
        )) {
          const resultType = this.sourceMemberResultType(analysis, typeName, definition);
          if (!resultType || seen.has(resultType.toLowerCase())) continue;
          seen.add(resultType.toLowerCase());
          next.push(resultType);
        }
      }
      if (next.length === 0) return [];
      types = next;
    }
    return types;
  }

  async navigationReceiverTypesForChain(document: vscode.TextDocument, analysis: DocumentAnalysis, chain: string[], offset: number, options: LookupOptions = {}): Promise<string[]> {
    if (chain.length === 0) return [];
    let types = this.receiverTypeNames(analysis, chain[0], offset);
    const firstKey = pascalTypeBaseName(chain[0]).toLowerCase();
    if (types.length === 0 && (
      analysis.sourceUnit?.types?.some((item: SourceDefinition) =>
        pascalTypeBaseName(item.symbol).toLowerCase() === firstKey)
      || this.sourceIndex?.types.has(firstKey)
      || /^[TI][A-Za-z0-9_]+$/.test(chain[0])
    )) types = [chain[0]];

    return resolvePascalReceiverTypeChain(types, chain.slice(1), async (typeName: string, memberName: string) => {
      if (memberName === PASCAL_INDEX_DEREFERENCE) {
        const elementType = inferPascalCollectionElementType(typeName)
          || this.sourceCollectionElementType(analysis, typeName);
        return elementType ? [elementType] : [];
      }

      const sourceTypes = this.sourceMemberDefinitionsForType(analysis, typeName, memberName)
        .map(definition => this.sourceMemberResultType(analysis, typeName, definition))
        .filter((value): value is string => Boolean(value));
      if (sourceTypes.length > 0) return sourceTypes;

      const info = await this.enrichClass(await this.indexedSymbol(
        document,
        pascalTypeBaseName(typeName),
        [PascalKeyword.Class],
        options
      ), options.cachedOnly ? { cachedOnly: true } : {});
      const resultType = info ? knownCompiledMembers(info).get(memberName.toLowerCase())?.value?.typeName : undefined;
      return resultType ? [resultType] : [];
    });
  }

  async compiledInfosForSourceHierarchy(document: vscode.TextDocument, analysis: DocumentAnalysis, typeName: string, options: LookupOptions = {}): Promise<CompiledClass[]> {
    const pending = [typeName];
    const visited = new Set();
    const infos = [];
    while (pending.length > 0 && visited.size < 32) {
      const current = pending.shift();
      const key = pascalTypeBaseName(current).toLowerCase();
      if (!key || visited.has(key)) continue;
      visited.add(key);
      const info = await this.enrichClass(await this.indexedSymbol(
        document,
        pascalTypeBaseName(current),
        [PascalKeyword.Class],
        options
      ), options.cachedOnly ? { cachedOnly: true } : {});
      if (info) infos.push(info);
      const definitions = [
        ...(analysis.sourceUnit?.types || []).filter((item: SourceDefinition) =>
          pascalTypeBaseName(item.symbol).toLowerCase() === key),
        ...(this.sourceIndex?.types.get(key) || [])
      ];
      for (const definition of definitions) {
        for (const baseType of definition.baseTypes || []) pending.push(baseType);
      }
    }
    return infos;
  }

  compiledReceiverTypesForChain(analysis: DocumentAnalysis, chain: string[], offset: number, compiledClassInfos: Map<string, CompiledClass>): string[] {
    if (chain.length === 0) return [];
    let types = this.receiverTypeNames(analysis, chain[0], offset);
    const firstKey = pascalTypeBaseName(chain[0]).toLowerCase();
    if (types.length === 0 && compiledClassInfos.has(firstKey)) types = [chain[0]];
    for (const memberName of chain.slice(1)) {
      const next = [];
      const seen = new Set();
      for (const typeName of types) {
        if (memberName === PASCAL_INDEX_DEREFERENCE) {
          const resultType = inferPascalCollectionElementType(typeName)
            || this.sourceCollectionElementType(analysis, typeName);
          if (resultType && !seen.has(resultType.toLowerCase())) {
            seen.add(resultType.toLowerCase());
            next.push(resultType);
          }
          continue;
        }
        const info = compiledClassInfos.get(pascalTypeBaseName(typeName).toLowerCase());
        const member = info ? knownCompiledMembers(info).get(memberName.toLowerCase()) : undefined;
        const resultType = member?.value?.typeName;
        if (!resultType || seen.has(resultType.toLowerCase())) continue;
        seen.add(resultType.toLowerCase());
        next.push(resultType);
      }
      if (next.length === 0) return [];
      types = next;
    }
    return types;
  }

  async compiledReceiverInfosForChain(document: vscode.TextDocument, analysis: DocumentAnalysis, chain: string[], offset: number, options: LookupOptions = {}): Promise<CompiledClass[]> {
    if (chain.length === 0) return [];
    let types = this.receiverTypeNames(analysis, chain[0], offset);
    if (types.length === 0 && /^[TI][A-Za-z0-9_]+$/.test(chain[0])) types = [chain[0]];
    for (const memberName of chain.slice(1)) {
      const next = [];
      const seen = new Set();
      for (const typeName of types) {
        if (memberName === PASCAL_INDEX_DEREFERENCE) {
          const resultType = inferPascalCollectionElementType(typeName)
            || this.sourceCollectionElementType(analysis, typeName);
          if (resultType && !seen.has(resultType.toLowerCase())) {
            seen.add(resultType.toLowerCase());
            next.push(resultType);
          }
          continue;
        }
        const info = await this.enrichClass(await this.indexedSymbol(
          document,
          pascalTypeBaseName(typeName),
          [PascalKeyword.Class],
          options
        ), options.cachedOnly ? { cachedOnly: true } : {});
        const member = info ? knownCompiledMembers(info).get(memberName.toLowerCase()) : undefined;
        const resultType = member?.value?.typeName;
        if (!resultType || seen.has(resultType.toLowerCase())) continue;
        seen.add(resultType.toLowerCase());
        next.push(resultType);
      }
      if (next.length === 0) return [];
      types = next;
    }
    const infos = [];
    const seen = new Set();
    for (const typeName of types) {
      const info = await this.enrichClass(await this.indexedSymbol(
        document,
        pascalTypeBaseName(typeName),
        [PascalKeyword.Class],
        options
      ), options.cachedOnly ? { cachedOnly: true } : {});
      if (!info) continue;
      const identity = `${normalizeKey(info.bplPath)}:${info.symbol.toLowerCase()}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      infos.push(info);
    }
    return infos;
  }

  sourceMemberDefinitions(index: Pick<SourceIndex, 'members' | 'types'>, typeName: string, memberName: string) {
    return findSourceMemberDefinitions(index, typeName, memberName);
  }

  allSourceMembers(index: Pick<SourceIndex, 'members' | 'types'>, typeName: string) {
    const result = new Map<string, SourceDefinition>();
    const pending = [typeName];
    const visited = new Set();
    while (pending.length > 0) {
      const current = pending.shift();
      const key = pascalTypeBaseName(current).toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      for (const [memberKey, definitions] of index.members.get(key) || []) {
        if (!result.has(memberKey)) result.set(memberKey, definitions[0]);
      }
      for (const definition of index.types.get(key) || []) {
        for (const baseType of definition.baseTypes || []) pending.push(baseType);
      }
    }
    return result;
  }

  navigationTargetRange(start: vscode.Position, length: number | undefined, document?: vscode.TextDocument) {
    if (!this.featureEnabled(SettingKey.NavigationSelectTargetOnJump, false, document)) {
      return new vscode.Range(start, start);
    }
    return new vscode.Range(start, start.translate(0, Math.max(0, Number(length) || 0)));
  }

  definitionLink(originSelectionRange: vscode.Range, targetUri: vscode.Uri, targetStart: vscode.Position, targetLength: number | undefined, document?: vscode.TextDocument): vscode.DefinitionLink {
    const targetRange = new vscode.Range(
      targetStart,
      targetStart.translate(0, Math.max(1, Number(targetLength) || 1))
    );
    return {
      originSelectionRange,
      targetUri,
      targetRange,
      targetSelectionRange: this.navigationTargetRange(targetStart, targetLength, document)
    };
  }

  locationsForDefinitions(definitions: SourceDefinition[], symbol: string, preferImplementation: boolean, document: vscode.TextDocument, originSelectionRange: vscode.Range): Promise<vscode.DefinitionLink[]>;
  locationsForDefinitions(definitions: SourceDefinition[], symbol: string, preferImplementation?: boolean, document?: vscode.TextDocument): Promise<vscode.Location[]>;
  async locationsForDefinitions(definitions: SourceDefinition[], symbol: string, preferImplementation = false, document?: vscode.TextDocument, originSelectionRange?: vscode.Range): Promise<Array<vscode.Location | vscode.DefinitionLink>> {
    const seen = new Set();
    const locations = [];
    for (const definition of definitions) {
      if (!definition.filePath) continue;
      const useImplementation = preferImplementation
        && isInteger(definition.implementationOffset);
      const offset = useImplementation ? definition.implementationOffset! : definition.offset;
      const line = useImplementation ? definition.implementationLine : definition.line;
      const character = useImplementation
        ? definition.implementationCharacter
        : definition.character;
      const key = `${normalizeKey(definition.filePath)}:${offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (isInteger(line) && isInteger(character)) {
        const start = new vscode.Position(line, character);
        const uri = vscode.Uri.file(definition.filePath);
        locations.push(originSelectionRange
          ? this.definitionLink(originSelectionRange, uri, start, definition.length, document)
          : new vscode.Location(uri, this.navigationTargetRange(start, definition.length, document)));
        continue;
      }
      try {
        const targetDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(definition.filePath));
        const start = targetDocument.positionAt(offset);
        locations.push(originSelectionRange
          ? this.definitionLink(
              originSelectionRange,
              targetDocument.uri,
              start,
              definition.length,
              document
            )
          : new vscode.Location(
              targetDocument.uri,
              this.navigationTargetRange(start, definition.length, document)
            ));
      } catch (error) {
        output.appendLine(`Source definition unavailable for ${symbol}: ${errorMessage(error)}`);
      }
    }
    return locations;
  }

  async sourceLocalDeclarationAt(document: vscode.TextDocument, position: vscode.Position) {
    const token = this.wordAt(document, position);
    if (!token) return undefined;
    const analysis = this.documentAnalysis(document);
    const clickOffset = document.offsetAt(token.range.start);
    // Tokens after a dot are members. Treating them as unqualified locals first
    // can capture an unrelated declaration (for example DataJson.I versus I).
    if (isPascalMemberReference(analysis.text, clickOffset, analysis.code)) return undefined;
    const declaration = findPascalDeclaration(analysis.text, token.word, clickOffset, analysis.code);
    if (!declaration || declaration.offset === clickOffset) return undefined;
    // `function Ready: Boolean` resembles a variable declaration to the cheap
    // local parser. Let routine navigation resolve it to the implementation.
    const isRoutineDeclaration = (analysis.localDefinitions.get(token.word.toLowerCase()) || [])
      .some((item: SourceDefinition) => item.kind === SourceSymbolKind.Routine && item.offset === declaration.offset);
    if (isRoutineDeclaration) return undefined;
    return {
      token,
      declaration,
      location: this.definitionLink(
        token.range,
        document.uri,
        document.positionAt(declaration.offset),
        declaration.length,
        document
      )
    };
  }

  async sourceMemberAt(document: vscode.TextDocument, position: vscode.Position, options = { cachedOnly: true }) {
    const token = this.wordAt(document, position);
    if (!token) return undefined;
    const analysis = this.documentAnalysis(document);
    const { text, code } = analysis;
    const start = document.offsetAt(token.range.start);
    const chain = pascalMemberChainBefore(text, start, code);
    if (chain.length === 0) return undefined;
    const qualifier = chain.join('.');
    let typeNames = this.sourceReceiverTypesForChain(analysis, chain, start);
    if (typeNames.length === 0 && chain.length > 1) {
      typeNames = await this.navigationReceiverTypesForChain(
        document, analysis, chain, start, options
      );
    }
    if (typeNames.length === 0) return undefined;
    let typeName = typeNames[0];
    let definitions: SourceDefinition[] = [];
    for (const candidate of typeNames) {
      definitions = this.sourceMemberDefinitionsForType(analysis, candidate, token.word);
      if (definitions.length > 0) {
        typeName = candidate;
        break;
      }
    }
    if (definitions.length === 0) return undefined;
    const unique = [...new Map(definitions.map(item => [
      `${normalizeKey(item.filePath)}:${item.offset}`,
      item
    ])).values()].sort((left, right) => left.offset - right.offset);
    if (unique.length > 1
      && unique.every(item => normalizeKey(item.filePath) === normalizeKey(unique[0].filePath))
      && unique.at(-1)!.offset - unique[0].offset < 256) {
      // Delphi RTL/VCL often publishes CLR and native declarations in adjacent
      // conditional branches. This extension targets Win32/Win64, so prefer the
      // final native branch and navigate directly instead of opening a picker.
      definitions = [unique.at(-1)!];
    } else {
      definitions = unique;
    }
    const implementationOffset = document.offsetAt(token.range.start);
    const clickedImplementation = definitions.some(definition =>
      definition.kind === SourceSymbolKind.Routine
      && normalizeKey(definition.filePath) === normalizeKey(document.fileName)
      && definition.implementationOffset === implementationOffset);
    const preferImplementation = !clickedImplementation && this.featureEnabled(
      SettingKey.NavigationPreferImplementation, true, document
    );
    const implementationDefinitions = preferImplementation
      ? definitions.filter(item => item.kind === SourceSymbolKind.Routine
        && isInteger(item.implementationOffset))
      : [];
    if (implementationDefinitions.length > 0) definitions = implementationDefinitions;
    const locations = await this.locationsForDefinitions(
      definitions,
      token.word,
      preferImplementation,
      document,
      token.range
    );
    return {
      token,
      qualifier,
      typeName,
      definitions,
      locations,
      usedImplementation: implementationDefinitions.length > 0
    };
  }

  sourceUsesUnitLinksAt(document: vscode.TextDocument, position: vscode.Position) {
    const analysis = this.documentUsesAnalysis(document);
    const match = findPascalUsesUnitAt(
      analysis.text,
      document.offsetAt(position),
      analysis.usedUnitNames,
      analysis.code,
      analysis.usesUnitRanges
    );
    if (!match) return undefined;
    const unitKey = match.unitName.toLowerCase();
    const definitions = this.sourceIndex?.units.get(unitKey)
      || this.fastSourceUnits.get(unitKey)
      || [];
    if (definitions.length === 0) return undefined;
    const originSelectionRange = new vscode.Range(
      document.positionAt(match.start),
      document.positionAt(match.end)
    );
    const links = [];
    const seen = new Set();
    for (const definition of definitions) {
      if (!definition?.filePath || !isInteger(definition.line)
        || !isInteger(definition.character)) continue;
      const key = `${normalizeKey(definition.filePath)}:${definition.offset}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const targetStart = new vscode.Position(definition.line, definition.character);
      const targetSymbolRange = new vscode.Range(
        targetStart,
        targetStart.translate(0, Math.max(1, definition.length || match.unitName.length))
      );
      const targetSelectionRange = this.featureEnabled(
        SettingKey.NavigationSelectTargetOnJump, false, document
      ) ? targetSymbolRange : new vscode.Range(targetStart, targetStart);
      links.push({
        originSelectionRange,
        targetUri: vscode.Uri.file(definition.filePath),
        targetRange: targetSymbolRange,
        targetSelectionRange
      });
    }
    return links.length > 0
      ? { unitName: analysis.text.slice(match.start, match.end), links }
      : undefined;
  }

  async compiledUsesUnitLinksAt(document: vscode.TextDocument, position: vscode.Position) {
    const analysis = this.documentUsesAnalysis(document);
    const match = findPascalUsesUnitAt(
      analysis.text,
      document.offsetAt(position),
      analysis.usedUnitNames,
      analysis.code,
      analysis.usesUnitRanges
    );
    if (!match) return undefined;
    const unit = this.cachedCompiledUnitForName(match.unitName);
    if (!unit) return undefined;
    const location = this.virtualLocation(unit, { kind: PascalKeyword.Unit, name: unit.symbol });
    const originSelectionRange = new vscode.Range(
      document.positionAt(match.start),
      document.positionAt(match.end)
    );
    return {
      unitName: analysis.text.slice(match.start, match.end),
      links: [{
        originSelectionRange,
        targetUri: location.uri,
        targetRange: location.range,
        targetSelectionRange: location.range
      }]
    };
  }

  async sourceDefinitionsAt(document: vscode.TextDocument, position: vscode.Position) {
    const token = this.wordAt(document, position);
    if (!token) return undefined;
    if (this.navigationBlockedAt(document, position, token)) return undefined;
    const analysis = this.documentAnalysis(document);
    if (isPascalMemberReference(analysis.text, document.offsetAt(token.range.start), analysis.code)) {
      return undefined;
    }
    const resolved = this.typeAt(document, position, true);
    if (!resolved) return undefined;
    const index = this.sourceIndex;
    let definitions = analysis.localDefinitions.get(resolved.typeName.toLowerCase()) || [];
    if (definitions.length === 0 && index) {
      definitions = index.definitions.get(resolved.typeName.toLowerCase()) || [];
    }
    if (definitions.length === 0) return { ...resolved, locations: [] };

    // The lightweight source index intentionally keeps both its top-level and
    // owner-aware view. Collapse identical declaration offsets and keep the
    // owner-aware entry, which also carries the matching implementation.
    const byDeclaration = new Map<string, SourceDefinition>();
    for (const definition of definitions) {
      const key = `${normalizeKey(definition.filePath)}:${definition.offset}`;
      const existing = byDeclaration.get(key);
      if (!existing || (!existing.owner && definition.owner)
        || (!isInteger(existing.implementationOffset)
          && isInteger(definition.implementationOffset))) {
        byDeclaration.set(key, definition);
      }
    }
    definitions = [...byDeclaration.values()];

    const clickOffset = document.offsetAt(token.range.start);
    const exact = definitions.filter((definition: SourceDefinition) =>
      normalizeKey(definition.filePath) === normalizeKey(document.fileName)
      && (definition.offset === clickOffset || definition.implementationOffset === clickOffset));
    if (exact.length > 0) {
      definitions = [exact.sort((left: SourceDefinition, right: SourceDefinition) =>
        Number(Boolean(right.owner)) - Number(Boolean(left.owner))
        || Number(isInteger(right.implementationOffset))
          - Number(isInteger(left.implementationOffset)))[0]];
    } else {
      const preferred = definitions.filter((definition: SourceDefinition) => {
        return unitIsVisible(definition.unitName, analysis.visibleUnits);
      });
      if (preferred.length > 0) definitions = preferred;

      const currentFile = definitions.filter((definition: SourceDefinition) =>
        normalizeKey(definition.filePath) === normalizeKey(document.fileName));
      if (currentFile.length > 0) definitions = currentFile;
    }

    const clickedImplementation = exact.some((definition: SourceDefinition) =>
      definition.kind === SourceSymbolKind.Routine
      && definition.implementationOffset === clickOffset);
    const preferImplementation = !clickedImplementation && this.featureEnabled(
      SettingKey.NavigationPreferImplementation, true, document
    );
    const singleTarget = this.featureEnabled(
      SettingKey.NavigationSingleTargetByDefault, true, document
    );
    const selected = selectBestPascalDefinitions(definitions, {
      preferImplementation,
      singleTarget,
      usedUnitNames: analysis.usedUnitNames
    });
    definitions = selected.definitions;
    const locations = await this.locationsForDefinitions(
      definitions,
      resolved.typeName,
      preferImplementation,
      document,
      token.range
    );
    return {
      ...resolved,
      definitions,
      locations,
      usedImplementation: selected.usedImplementation
    };
  }

  async hasSourceReferenceAt(document: vscode.TextDocument, position: vscode.Position) {
    if (this.sourceUsesUnitLinksAt(document, position)?.links.length) return true;
    const analysis = this.documentAnalysis(document);
    const token = this.wordAt(document, position);
    if (!token) return false;
    if (this.navigationBlockedAt(document, position, token)) return false;
    const offset = document.offsetAt(token.range.start);
    if (isPascalMemberReference(analysis.text, offset, analysis.code)) {
      const sourceMember = await this.sourceMemberAt(document, position);
      return Boolean(sourceMember?.definitions?.length);
    }
    const resolved = this.typeAt(document, position, true);
    if (!resolved) return false;
    if (analysis.localDefinitions.has(resolved.typeName.toLowerCase())) return true;
    return Boolean((this.sourceIndex?.definitions.get(resolved.typeName.toLowerCase()) || [])
      .some((definition: SourceDefinition) => unitIsVisible(definition.unitName, analysis.visibleUnits)));
  }

  async definitionAt(document: vscode.TextDocument, position: vscode.Position, cancellationToken: vscode.CancellationToken|undefined, options: LookupOptions = {}) {
    if (!this.featureEnabled(SettingKey.NavigationEnabled, true, document)) return undefined;
    if (cancellationToken?.isCancellationRequested) return undefined;
    if (this.navigationBlockedAt(document, position)) return undefined;
    const usesUnit = this.sourceUsesUnitLinksAt(document, position);
    if (usesUnit?.links.length) {
      output.appendLine(
        `Resolved source unit ${usesUnit.unitName} (${usesUnit.links.length} definition(s)).`
      );
      return usesUnit.links;
    }
    const compiledUsesUnit = await this.compiledUsesUnitLinksAt(document, position);
    if (compiledUsesUnit?.links.length) {
      output.appendLine(
        `Resolved compiled source unit ${compiledUsesUnit.unitName} `
        + `(${compiledUsesUnit.links.length} definition(s)).`
      );
      return compiledUsesUnit.links;
    }
    const local = await this.sourceLocalDeclarationAt(document, position);
    if (local) {
      output.appendLine(`Resolved local declaration ${local.token.word}: ${local.declaration.typeName}.`);
      return local.location;
    }
    const [sourceMember, source] = await Promise.all([
      this.sourceMemberAt(document, position, {
        cachedOnly: options.cachedOnly !== false
      }),
      this.sourceDefinitionsAt(document, position)
    ]);
    const singleTarget = this.featureEnabled(
      SettingKey.NavigationSingleTargetByDefault, true, document
    );
    if (cancellationToken?.isCancellationRequested) return undefined;
    if (sourceMember?.locations.length) {
      if (singleTarget && sourceMember.locations.length > 1) {
        output.appendLine(
          `Delegating ambiguous member ${sourceMember.typeName}.${sourceMember.token.word} to Vallenta.`
        );
        return undefined;
      }
      output.appendLine(
        `Resolved inherited source member ${sourceMember.typeName}.${sourceMember.token.word} `
        + `(${sourceMember.locations.length} definition(s)).`
      );
      return singleTarget || sourceMember.locations.length === 1
        ? sourceMember.locations[0]
        : sourceMember.locations;
    }
    if (source?.locations.length) {
      output.appendLine(`Resolved source symbol ${source.typeName} (${source.locations.length} definition(s)).`);
      return singleTarget || source.locations.length === 1
        ? source.locations[0]
        : source.locations;
    }
    if (options.cachedOnly === false) {
      return this.compiledDefinitionAt(document, position, { cachedOnly: false });
    }
    const definitionKey = `${document.uri}:${document.version}:${document.offsetAt(position)}`;
    let compiledPromise = this.definitionPromises.get(definitionKey);
    if (!compiledPromise) {
      // Ctrl-hover must never start a cold package scan. Current-file warm-up
      // populates likely packages in the background; interactive navigation only
      // consumes that ready cache so another provider cannot be delayed by us.
      compiledPromise = this.compiledDefinitionAt(document, position, { cachedOnly: true }).catch(error => {
        output.appendLine(`Background definition lookup failed: ${error.message}`);
        return undefined;
      });
      this.definitionPromises.set(definitionKey, compiledPromise);
      compiledPromise.then(value => {
        // `cachedOnly` can legitimately miss while prewarming is still in
        // flight. An empty result is not stable and must never poison Ctrl-hover
        // for the rest of this document version.
        if (value === undefined && this.definitionPromises.get(definitionKey) === compiledPromise) {
          this.definitionPromises.delete(definitionKey);
        }
      });
    }
    const waitMs = vscode.workspace.getConfiguration(ConfigurationSection, document.uri)
      .get(SettingKey.NavigationInteractiveWaitMs, 100);
    const compiledLocation = await new Promise<vscode.DefinitionLink | typeof INTERACTIVE_LOOKUP_TIMEOUT | undefined>(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve(INTERACTIVE_LOOKUP_TIMEOUT);
      }, Math.max(0, waitMs));
      compiledPromise.then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      });
    });
    return compiledLocation === INTERACTIVE_LOOKUP_TIMEOUT ? undefined : compiledLocation;
  }

  async compiledDefinitionAt(document: vscode.TextDocument, position: vscode.Position, options: LookupOptions = {}) {
    const compiledReference = await this.compiledReferenceAt(document, position, options);
    if (compiledReference) {
      if (!this.featureEnabled(SettingKey.NavigationVirtualInterfaces, true, document)) return undefined;
      output.appendLine(
        `Resolved compiled ${compiledReference.target.kind} ${compiledReference.token.word} `
        + `from ${path.basename(compiledReference.info.bplPath)}.`
      );
      const location = this.virtualLocation(compiledReference.info, compiledReference.target);
      return this.definitionLink(
        compiledReference.token.range,
        location.uri,
        location.range.start,
        compiledReference.token.word.length,
        document
      );
    }
    if (options.cachedOnly) return undefined;
    const resolved = await this.infoAt(document, position, true);
    if (!resolved) return undefined;
    const location = this.virtualLocation(
      resolved.info,
      { kind: PascalKeyword.Class, name: resolved.info.symbol }
    );
    return this.definitionLink(
      resolved.token.range,
      location.uri,
      location.range.start,
      resolved.token.word.length,
      document
    );
  }

  async navigateToDefinition() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (this.navigationBlockedAt(editor.document, editor.selection.active)) return;
    const location = await this.definitionAt(
      editor.document,
      editor.selection.active,
      undefined,
      { cachedOnly: false }
    );
    if (!location) {
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      return;
    }
    if (Array.isArray(location)) {
      if (location.length !== 1) {
        await vscode.commands.executeCommand('editor.action.revealDefinition');
        return;
      }
    }
    const targetLocation = Array.isArray(location) ? location[0] : location;
    const targetUri = targetLocation.targetUri;
    const locationRange = targetLocation.targetSelectionRange || targetLocation.targetRange;
    const targetRange = this.featureEnabled(SettingKey.NavigationSelectTargetOnJump, false, editor.document)
      ? locationRange
      : new vscode.Range(locationRange.start, locationRange.start);
    const target = await vscode.window.showTextDocument(targetUri, {
      preview: true,
      preserveFocus: false,
      selection: targetRange
    });
    target.selection = new vscode.Selection(targetRange.start, targetRange.end);
    target.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    output.appendLine(
      `Navigated to ${targetUri.fsPath || targetUri.toString()}:${locationRange.start.line + 1}.`
    );
  }

  async navigateToAllDefinitions() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const document = editor.document;
    const position = editor.selection.active;
    const token = this.wordAt(document, position);
    if (!token) return;
    const analysis = this.documentAnalysis(document);
    const offset = document.offsetAt(token.range.start);
    if (isPascalNonNavigableIdentifierAt(analysis.code, offset, token.word)) return;
    let definitions: SourceDefinition[] = [];
    if (isPascalMemberReference(analysis.text, offset, analysis.code)) {
      const sourceMember = await this.sourceMemberAt(document, position, { cachedOnly: false });
      definitions = sourceMember?.definitions || [];
    } else {
      definitions = analysis.localDefinitions.get(token.word.toLowerCase())
        || this.sourceIndex?.definitions.get(token.word.toLowerCase()) || [];
      const visible = definitions.filter((item: SourceDefinition) => unitIsVisible(item.unitName, analysis.visibleUnits));
      if (visible.length > 0) definitions = visible;
    }

    const candidates: Array<vscode.QuickPickItem & { location: vscode.Location | vscode.DefinitionLink }> = [];
    const seen = new Set<string>();
    const addCandidate = (definition: SourceDefinition, implementation: boolean) => {
      const targetOffset = implementation ? definition.implementationOffset : definition.offset;
      if (!isInteger(targetOffset) || !definition.filePath) return;
      const key = `${normalizeKey(definition.filePath)}:${targetOffset}`;
      if (seen.has(key)) return;
      seen.add(key);
      const line = implementation ? definition.implementationLine : definition.line;
      const character = implementation ? definition.implementationCharacter : definition.character;
      if (!isInteger(line) || !isInteger(character)) return;
      const start = new vscode.Position(line, character);
      candidates.push({
        label: `${implementation ? '$(symbol-method)' : '$(symbol-field)'} `
          + `${definition.owner ? `${definition.owner}.` : ''}${definition.symbol}`,
        description: `${implementation ? 'Implementation' : 'Declaration'} · ${definition.unitName}`,
        detail: `${definition.filePath}:${line + 1}`,
        location: new vscode.Location(vscode.Uri.file(definition.filePath),
          this.navigationTargetRange(start, definition.length, document))
      });
    };
    for (const definition of definitions) {
      if (definition.kind === SourceSymbolKind.Routine && isInteger(definition.implementationOffset)) {
        addCandidate(definition, true);
      }
      addCandidate(definition, false);
    }
    if (candidates.length === 0) {
      const compiled = await this.compiledDefinitionAt(document, position, { cachedOnly: false });
      if (compiled) {
        const targetUri = compiled.targetUri;
        candidates.push({
          label: `$(symbol-file) ${token.word}`,
          description: 'Compiled package interface',
          detail: targetUri.toString(),
          location: compiled
        });
      }
    }
    if (candidates.length === 0) {
      vscode.window.showInformationMessage(`No declaration or implementation found for ${token.word}.`);
      return;
    }
    const selected = await vscode.window.showQuickPick(candidates, {
      title: `${token.word}: Select a declaration or implementation`,
      placeHolder: 'Regular Ctrl+Click/F12 navigation jumps directly to the best target'
    });
    if (!selected) return;
    const targetUri = 'targetUri' in selected.location ? selected.location.targetUri : selected.location.uri;
    const locationRange = 'targetUri' in selected.location ? selected.location.targetSelectionRange || selected.location.targetRange : selected.location.range;
    const targetRange = this.featureEnabled(SettingKey.NavigationSelectTargetOnJump, false, document)
      ? locationRange
      : new vscode.Range(locationRange.start, locationRange.start);
    const target = await vscode.window.showTextDocument(targetUri, {
      preview: true,
      preserveFocus: false,
      selection: targetRange
    });
    target.selection = new vscode.Selection(targetRange.start, targetRange.end);
    target.revealRange(targetRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  virtualUri(info: CompiledInfo) {
    const uri = vscode.Uri.from({
      scheme: 'pascal-atlas-binary',
      path: info.kind === PascalKeyword.Unit
        ? `/${info.symbol}.pas`
        : `/${info.namespace || 'CompiledPackage'}.${info.symbol}.pas`,
      query: path.basename(info.bplPath)
    });
    this.virtualDocuments.set(uri.toString(), renderVirtualUnit(info));
    return uri;
  }

  virtualLocation(info: CompiledInfo, target: CompiledReference['target']) {
    const uri = this.virtualUri(info);
    const text = this.virtualDocuments.get(uri.toString()) || '';
    const lines = text.split(/\r?\n/);
    const wanted = target.name.toLowerCase();
    let lineIndex = 0;
    let character = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const lower = line.toLowerCase();
      let matches = false;
      if (target.kind === PascalKeyword.Unit) matches = /^unit\s+/i.test(line) && lower.includes(wanted);
      else if (target.kind === CompiledSymbolKind.Global) matches = new RegExp(`^\\s*${target.name}\\s*:`, 'i').test(line);
      else if (target.kind === PascalKeyword.Class || target.kind === PascalKeyword.Interface) {
        matches = new RegExp(`^\\s*${target.name}\\s*=\\s*(?:class|interface)`, 'i').test(line);
      }
      else if (target.kind === PascalKeyword.Property) matches = lower.includes(`property ${wanted}`);
      else if (target.kind === 'observed' || target.kind === 'rtti') {
        matches = lower.includes(`member ${wanted}`);
      }
      else if (target.kind === PascalKeyword.Constructor || target.kind === PascalKeyword.Destructor) {
        matches = lower.includes(`${target.kind} ${wanted}`);
      }
      else if (target.kind === 'method') {
        matches = lower.includes(`::${String(target.className || '').toLowerCase()}::${wanted}(`);
      } else if (target.kind === SourceSymbolKind.Routine) {
        matches = lower.includes(`::${wanted}(`);
      }
      if (matches) {
        lineIndex = index;
        character = Math.max(0, lower.indexOf(wanted));
        break;
      }
    }
    return new vscode.Location(uri, new vscode.Position(lineIndex, character));
  }

  async packageDataWithin(document: vscode.TextDocument, waitMs: number) {
    const packagePromise = this.packageDataForDocument(document);
    return new Promise<PackageDocumentData | undefined>(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve(undefined);
      }, Math.max(0, waitMs));
      packagePromise.then(value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }

  async unqualifiedCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
    if (!this.featureEnabled(SettingKey.CompletionUnqualifiedEnabled, true, document)) return undefined;
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/)
      || new vscode.Range(position, position);
    const prefix = document.getText(range).toLowerCase();
    if (!prefix) return undefined;
    // Native snippets are contributed by the manifest and can answer without
    // entering the extension host. Do not make `if`, `while`, `begin`, etc.
    // wait behind source/package completion work during window startup.
    if (hasNativePascalCompletion(prefix)) return undefined;
    const analysis = this.documentAnalysis(document);
    const items = new Map<string, vscode.CompletionItem>();
    const add = (name: string, kind: vscode.CompletionItemKind|undefined, detail: string|undefined, priority = '0001') => {
      if (!name?.toLowerCase().startsWith(prefix)) return;
      const key = name.toLowerCase();
      if (items.has(key)) return;
      const item = new vscode.CompletionItem(name, kind);
      item.detail = detail;
      item.range = range;
      item.sortText = `${priority}-${key}`;
      items.set(key, item);
    };
    const completionKind = (kind: string) => {
      if (kind === SourceSymbolKind.Routine) return vscode.CompletionItemKind.Function;
      if (kind === PascalKeyword.Type) return vscode.CompletionItemKind.Class;
      if (kind === 'constant' || kind === 'enumMember') return vscode.CompletionItemKind.Constant;
      if (kind === PascalKeyword.Unit) return vscode.CompletionItemKind.Module;
      return vscode.CompletionItemKind.Variable;
    };

    for (const definitions of analysis.localDefinitions.values()) {
      for (const definition of definitions) {
        add(definition.symbol, completionKind(definition.kind),
          `[Current file] ${definition.unitName}`, '0000');
      }
    }
    if (this.sourceIndex) {
      for (const [name, definitions] of this.sourceIndex.definitions) {
        if (!name.startsWith(prefix) || items.size >= 250) continue;
        const definition = definitions.find((item: SourceDefinition) => unitIsVisible(item.unitName, analysis.visibleUnits));
        if (definition) add(definition.symbol, completionKind(definition.kind),
          `[Source: ${definition.unitName}]`, '0001');
      }
    }

    const waitMs = vscode.workspace.getConfiguration(ConfigurationSection, document.uri)
      .get(SettingKey.CompletionInteractiveWaitMs, 60);
    const packageData = await this.packageDataWithin(document, waitMs);
    for (const unit of packageData?.usedUnitIndexes || []) {
      for (const info of unit.globals.values()) {
        add(info.symbol, vscode.CompletionItemKind.Variable,
          `[Compiled package: ${unit.symbol}] ${info.typeName || info.signature}`, '0000');
      }
      for (const info of unit.classes.values()) {
        add(info.symbol, vscode.CompletionItemKind.Class,
          `[Compiled package: ${unit.symbol}]`, '0001');
      }
      for (const overloads of unit.routines.values()) {
        add(overloads[0].name, vscode.CompletionItemKind.Function,
          `[Compiled package: ${unit.symbol}] ${overloads.length} overloads`, '0001');
      }
    }
    return items.size > 0 ? new vscode.CompletionList([...items.values()], false) : undefined;
  }

  async sourceSignature(document: vscode.TextDocument, definition: SourceDefinition) {
    if (definition.signature) return definition.signature;
    const key = `${normalizeKey(definition.filePath)}:${definition.offset}`;
    if (this.sourceSignatureCache.has(key)) return this.sourceSignatureCache.get(key);
    const promise = (async () => {
      const text = normalizeKey(definition.filePath) === normalizeKey(document.fileName)
        ? document.getText()
        : await fs.promises.readFile(definition.filePath, 'utf8');
      return extractPascalRoutineSignature(text, definition.offset);
    })().catch(() => undefined);
    this.sourceSignatureCache.set(key, promise);
    return promise;
  }

  signatureInformation(label: string) {
    const signature = new vscode.SignatureInformation(label);
    signature.parameters = splitSignatureParameters(label)
      .map(parameter => new vscode.ParameterInformation(parameter));
    return signature;
  }

  signatureHelpFromLabels(labels: string[], activeParameter: number) {
    const orderedLabels = [...labels].sort((left, right) => {
      const defaults = (label: string) => splitSignatureParameters(label)
        .filter(parameter => /(?:^|\s)=\s*(?!=)/.test(parameter)).length;
      return defaults(right) - defaults(left);
    });
    const help = new vscode.SignatureHelp();
    help.signatures = orderedLabels.map(label => this.signatureInformation(label));
    const matchingIndex = help.signatures.findIndex(signature =>
      signature.parameters.length > activeParameter);
    help.activeSignature = Math.max(0, matchingIndex);
    const parameterCount = help.signatures[help.activeSignature]?.parameters.length || 0;
    help.activeParameter = parameterCount > 0
      ? Math.min(activeParameter, parameterCount - 1)
      : 0;
    return help;
  }

  async signatureHelpAt(document: vscode.TextDocument, position: vscode.Position, context: vscode.SignatureHelpContext) {
    if (!this.featureEnabled(SettingKey.SignatureHelpEnabled, true, document)) return undefined;
    if (context?.triggerCharacter === ','
      && !this.featureEnabled(SettingKey.SignatureHelpTriggerOnComma, true, document)) return undefined;
    const text = document.getText();
    const code = maskPascalNonCode(text);
    const call = findPascalCallAt(text, document.offsetAt(position), code);
    if (!call) return undefined;
    const cacheKey = `${document.uri}:${call.openOffset}:${call.qualifier || ''}.${call.name}`;
    const cached = this.signatureHelpCache.get(cacheKey);
    if (cached
      && cached.sourceReady === Boolean(this.sourceIndex)
      && Date.now() - cached.createdAt < 10000) {
      return this.signatureHelpFromLabels(cached.labels, call.activeParameter);
    }
    const analysis = this.documentAnalysis(document, { text, code });
    let definitions: SourceDefinition[] = [];
    if (call.qualifier) {
      const typeName = inferPascalTypeFromIndex(
        analysis.typeInferenceIndex,
        call.qualifier,
        call.nameOffset
      );
      if (typeName) {
        definitions = analysis.localMembers.get(typeName.toLowerCase().split('.').at(-1)!)
          ?.get(call.name.toLowerCase()) || [];
        if (definitions.length === 0 && this.sourceIndex) {
          definitions = this.sourceMemberDefinitions(this.sourceIndex, typeName, call.name);
        }
      }
    } else {
      definitions = analysis.localDefinitions.get(call.name.toLowerCase()) || [];
      if (definitions.length === 0 && this.sourceIndex) {
        definitions = (this.sourceIndex.definitions.get(call.name.toLowerCase()) || [])
          .filter((item: SourceDefinition) => unitIsVisible(item.unitName, analysis.visibleUnits));
      }
    }
    const labels = new Set<string>();
    const sourceLabels = await Promise.all(definitions
      .filter((item: SourceDefinition) => item.kind === SourceSymbolKind.Routine)
      .map((definition: SourceDefinition) => this.sourceSignature(document, definition)));
    for (const label of sourceLabels) {
      if (label) labels.add(label);
    }

    if (labels.size === 0) {
      const callPosition = document.positionAt(call.nameOffset);
      const reference = await this.compiledReferenceAt(document, callPosition, { cachedOnly: true });
      if (reference?.target.kind === 'method') {
        const classInfo = reference.info?.classInfo || (reference.info?.kind === PascalKeyword.Class ? reference.info : undefined);
        for (const method of classInfo?.methods || []) {
          if (method.name.toLowerCase() === call.name.toLowerCase()) labels.add(method.signature);
        }
        if (labels.size === 0 && reference.member?.signature) labels.add(reference.member.signature);
      } else if (reference?.target.kind === SourceSymbolKind.Routine) {
        const unit = await this.indexedSymbol(document, reference.info.namespace, [PascalKeyword.Unit], { cachedOnly: true });
        for (const routine of unit?.routines.get(call.name.toLowerCase()) || []) labels.add(routine.signature);
        if (labels.size === 0 && reference.member?.signature) labels.add(reference.member.signature);
      }
    }
    if (labels.size === 0) return undefined;
    const cacheEntry = {
      labels: [...labels],
      sourceReady: Boolean(this.sourceIndex),
      createdAt: Date.now()
    };
    this.signatureHelpCache.set(cacheKey, cacheEntry);
    while (this.signatureHelpCache.size > 128) {
      this.signatureHelpCache.delete(this.signatureHelpCache.keys().next().value!);
    }
    return this.signatureHelpFromLabels(cacheEntry.labels, call.activeParameter);
  }

  register() {
    const selector = [{ language: LanguageId.Pascal, scheme: UriScheme.File }];
    this.context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(
      'pascal-atlas-binary',
      { provideTextDocumentContent: uri => this.virtualDocuments.get(uri.toString()) || '' }
    ));
    this.context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition: async (document, position, cancellationToken) => {
        const result = await this.definitionAt(document, position, cancellationToken);
        return result && !Array.isArray(result) ? [result] : result;
      }
    }));
    this.context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
      provideHover: async (document, position, cancellationToken) => {
        if (!this.featureEnabled(SettingKey.HoverEnabled, true, document)
          || !this.featureEnabled(SettingKey.SymbolsCompiledEnabled, true, document)) return undefined;
        // DefinitionProvider owns whole-Unit navigation inside uses clauses.
        // Avoid running a second generic symbol lookup for the same Ctrl-hover.
        const usesAnalysis = this.documentUsesAnalysis(document);
        if (findPascalUsesUnitAt(
          usesAnalysis.text,
          document.offsetAt(position),
          usesAnalysis.usedUnitNames,
          usesAnalysis.code,
          usesAnalysis.usesUnitRanges
        )) return undefined;
        const token = this.wordAt(document, position);
        if (!token) return undefined;
        // Source-backed symbols belong to Vallenta's richer hover. Returning
        // immediately also prevents Ctrl-hover from starting any package work.
        if (await this.hasSourceReferenceAt(document, position)
          || cancellationToken?.isCancellationRequested) return undefined;
        const reference = await this.compiledReferenceAt(document, position, { cachedOnly: true });
        const info = reference?.info;
        if (!info) return undefined;
        const markdown = new vscode.MarkdownString();
        markdown.appendCodeblock(
          reference?.member?.signature || `${info.namespace}.${reference?.member?.name || info.symbol}`,
          LanguageId.Pascal
        );
        markdown.appendMarkdown(`Compiled symbol from **${path.basename(info.bplPath)}**`);
        if ((info.kind === PascalKeyword.Class || info.kind === PascalKeyword.Interface) && info.methods.length) {
          markdown.appendMarkdown('\n\nPublic exports:\n');
          for (const method of info.methods.slice(0, 20)) markdown.appendMarkdown(`\n- \`${method.name}\``);
        }
        return new vscode.Hover(markdown, token.range);
      }
    }));
    this.context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
      provideCompletionItems: async (document, position) => {
        if (!this.featureEnabled(SettingKey.CompletionEnabled, true, document)) return undefined;
        const analysis = this.documentAnalysis(document);
        const positionOffset = document.offsetAt(position);
        const prefix = analysis.code.slice(0, positionOffset);
        const qualifier = /([A-Za-z_][A-Za-z0-9_]*)\.\s*$/.exec(prefix)?.[1];
        if (!qualifier) return this.unqualifiedCompletionItems(document, position);
        const typeName = inferPascalTypeFromIndex(
          analysis.typeInferenceIndex,
          qualifier,
          positionOffset
        )
          || (/^[TI][A-Z]/.test(qualifier) ? qualifier : undefined);
        const initializerRoutine = typeName
          ? undefined
          : inferPascalInitializerRoutine(analysis.text, qualifier, positionOffset, analysis.code);
        const initializedBy = typeName || !initializerRoutine
          ? undefined
          : await this.enrichRoutine(await this.indexedSymbol(document, initializerRoutine, [CompiledSymbolKind.Routine]));
        const global = typeName || initializedBy
          ? undefined
          : await this.enrichGlobal(await this.indexedSymbol(document, qualifier, [CompiledSymbolKind.Global]));
        const routine = typeName || initializedBy || global
          ? undefined
          : await this.enrichRoutine(await this.indexedSymbol(document, qualifier, [CompiledSymbolKind.Routine]));
        const resolvedTypeName = typeName || initializedBy?.typeName || global?.typeName || routine?.typeName;
        if (!resolvedTypeName) {
          output.appendLine(`No Pascal type inferred for completion qualifier ${qualifier}.`);
          return undefined;
        }
        output.appendLine(`Completion requested for ${qualifier}: inferred ${resolvedTypeName}.`);
        let info = initializedBy?.classInfo || global?.classInfo || routine?.classInfo
          || await this.enrichClass(await this.indexedSymbol(document, resolvedTypeName, [PascalKeyword.Class]))
          || await this.lookup(document, resolvedTypeName);
        if (!info) {
          const sourceIndex = await this.sourceIndexPromise;
          const sourceMembers = this.allSourceMembers(sourceIndex, resolvedTypeName);
          if (sourceMembers.size > 0) {
            return new vscode.CompletionList([...sourceMembers.values()].map(definition => {
              const kind = definition.kind === SourceSymbolKind.Routine
                ? vscode.CompletionItemKind.Method
                : vscode.CompletionItemKind.Property;
              const item = new vscode.CompletionItem(definition.symbol, kind);
              item.detail = `[source: ${definition.unitName}] ${definition.owner}.${definition.symbol}`;
              item.sortText = `0000-${definition.symbol.toLowerCase()}`;
              return item;
            }), false);
          }
        }
        if (!info) {
          output.appendLine(`No compiled package symbol found for inferred type ${resolvedTypeName}.`);
          return undefined;
        }
        const groups = new Map<string, CompiledMethod[]>();
        for (const method of info.methods) {
          const key = method.name.toLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key)!.push(method);
        }
        const items = [...groups.values()].map(overloads => {
          const item = new vscode.CompletionItem(overloads[0].name, vscode.CompletionItemKind.Method);
          item.detail = `[compiled: ${path.basename(info.bplPath)}] ${overloads.length} overload(s)`;
          item.documentation = new vscode.MarkdownString(
            overloads.map((method: CompiledMethod) => `\`${method.signature}\``).join('\n\n')
          );
          item.sortText = `0000-${overloads[0].name.toLowerCase()}`;
          return item;
        });
        const knownMembers = knownCompiledMembers(
          info,
          initializedBy?.observedMembers || global?.observedMembers || routine?.observedMembers
        );
        for (const member of knownMembers.values()) {
          if (member.kind === 'method') continue;
          const item = new vscode.CompletionItem(member.name, vscode.CompletionItemKind.Property);
          item.detail = `[compiled workspace inference: ${path.basename(info.bplPath)}]`;
          if (member.kind === 'observed') {
            item.documentation = new vscode.MarkdownString(
              `Member observed on \`${initializedBy?.symbol || global?.symbol || routine?.symbol || qualifier}\` `
              + 'in Pascal workspace references.'
            );
          }
          item.sortText = `0001-${member.name.toLowerCase()}`;
          items.push(item);
        }
        output.appendLine(`Provided ${items.length} compiled members for ${qualifier}: ${resolvedTypeName}.`);
        return new vscode.CompletionList(items, false);
      }
    }, '.'));
    this.context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, {
      provideSignatureHelp: (document, position, _token, context) =>
        this.signatureHelpAt(document, position, context)
    }, '(', ','));
    this.context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const state of this.decorationStates.values()) {
        const visibleEditor = findVisibleEditor(editors, state.editor);
        if (state.editor && !visibleEditor) {
          this.retireDecorationEditor(state.editor);
        } else if (visibleEditor) {
          state.editor = visibleEditor;
        }
      }
      const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
      for (const editor of editors) {
        const inactiveDelay = vscode.workspace.getConfiguration(ConfigurationSection, editor.document.uri)
          .get(SettingKey.ColoringInactiveEditorDelayMs, 350);
        this.scheduleDecorate(editor, editor.document.uri.toString() === activeUri
          ? 0
          : inactiveDelay);
      }
    }));
    this.context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
      const previousEditor = this.activeEditor;
      const previousVisit = this.activeDocumentVisit;
      if (previousEditor && previousEditor !== editor
        && shouldRetireEditor(vscode.window.visibleTextEditors, previousEditor)) {
        this.retireDecorationEditor(previousEditor);
      }
      this.activeEditor = editor;
      const nextVisit = this.documentVisit(editor?.document);
      this.activeDocumentVisit = nextVisit;
      if (editor) {
        const returnedFromPlatformSource = editor.document.languageId === LanguageId.Pascal
          && nextVisit?.isWorkspaceDocument
          && (previousVisit?.isPlatformSource || Date.now() < this.platformReturnPendingUntil);
        if (returnedFromPlatformSource) this.platformReturnPendingUntil = 0;
        // Preview navigation to RTL/System files cancels outstanding definition
        // requests. Do not reuse an empty cached promise after Back restores the
        // original editor, and rewarm data that Vallenta may have closed.
        this.invalidateInteractiveDocumentState(editor.document, returnedFromPlatformSource);
        // The current-file pass is synchronous and isolated from package/LSP
        // work, so an editor switch must paint immediately. Optional compiled
        // enrichment still happens after the fast result is already visible.
        this.scheduleDecorate(editor, 0);
        void this.prioritizeSourceUnits(editor.document);
        if (returnedFromPlatformSource) {
          void this.warmCurrentDocument(editor.document);
          output.appendLine(
            `Restored interactive navigation after RTL/System return: ${path.basename(editor.document.fileName)}.`
          );
        }
      }
    }));
    this.context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      this.documentAnalysisCache.delete(event.document.uri.toString());
      const definitionPrefix = `${event.document.uri}:`;
      for (const key of this.definitionPromises.keys()) {
        if (key.startsWith(definitionPrefix)) this.definitionPromises.delete(key);
      }
      const editor = vscode.window.visibleTextEditors.find(
        item => item.document.uri.toString() === event.document.uri.toString()
      );
      if (editor) {
        const configuration = vscode.workspace.getConfiguration(ConfigurationSection, editor.document.uri);
        const active = vscode.window.activeTextEditor?.document.uri.toString() === event.document.uri.toString();
        this.scheduleDecorate(editor, active
          ? configuration.get(SettingKey.ColoringTypingDelayMs, 750)
          : configuration.get(SettingKey.ColoringInactiveEditorDelayMs, 350));
      }
    }));
    this.context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
      const key = document.uri.toString();
      if ((document.languageId === LanguageId.Platform || this.isPlatformSourceDocument(document))
        && (!vscode.window.activeTextEditor
          || vscode.window.activeTextEditor.document.uri.toString() === key)) {
        // Closing a preview can emit didClose before active-editor changed.
        // Keep a short immutable marker so the restored project editor still
        // gets its interactive caches invalidated and warmed.
        this.platformReturnPendingUntil = Date.now() + 2000;
      }
      const decorationState = this.decorationStates.get(key);
      clearTimeout(decorationState?.timer);
      if (decorationState?.lastApplied && document.uri.scheme === UriScheme.File) {
        const snapshotKey = normalizeKey(document.fileName);
        const snapshot = {
          ...decorationState.lastApplied,
          contentIdentity: createHash('sha1').update(document.getText()).digest('hex')
        };
        this.queueDecorationSnapshot(document, snapshot);
      }
      this.decorationStates.delete(key);
      this.documentWarmPromises.delete(key);
      this.documentPackagePromises.delete(key);
      this.documentAnalysisCache.delete(key);
      const signaturePrefix = `${document.uri}:`;
      for (const cacheKey of this.signatureHelpCache.keys()) {
        if (cacheKey.startsWith(signaturePrefix)) this.signatureHelpCache.delete(cacheKey);
      }
      clearTimeout(this.pendingPackageRefreshes.get(key));
      this.pendingPackageRefreshes.delete(key);
      const definitionPrefix = `${document.uri}:`;
      for (const cacheKey of this.definitionPromises.keys()) {
        if (cacheKey.startsWith(definitionPrefix)) this.definitionPromises.delete(cacheKey);
      }
    }));
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('pascalAtlas.coloring')
        && !event.affectsConfiguration('pascalAtlas.symbols.compiled')
        && !event.affectsConfiguration('pascalAtlas.enabled')) return;
      if (event.affectsConfiguration('pascalAtlas.coloring.colors')) {
        this.rebuildDecorationTypes(vscode.window.activeTextEditor?.document?.uri);
        for (const state of this.decorationStates.values()) state.hasApplied = false;
      }
      for (const editor of vscode.window.visibleTextEditors) this.scheduleDecorate(editor, 0);
    }));
    this.context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => {
      if (!vscode.workspace.getConfiguration(ConfigurationSection)
        .get(SettingKey.ColoringColorsUseDefault, true)) return;
      this.rebuildDecorationTypes(vscode.window.activeTextEditor?.document?.uri);
      for (const state of this.decorationStates.values()) state.hasApplied = false;
      for (const editor of vscode.window.visibleTextEditors) this.scheduleDecorate(editor, 0);
    }));

    // The active editor usually exists before this extension registers its
    // listeners during Reload Window, so no change event is guaranteed. Start
    // every visible Pascal editor explicitly; prioritize the active one.
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    for (const editor of vscode.window.visibleTextEditors) {
      this.scheduleDecorate(editor, editor.document.uri.toString() === activeUri ? 0 : 100);
      if (editor.document.uri.toString() === activeUri) void this.prioritizeSourceUnits(editor.document);
    }
  }

  scheduleDecorate(editor: vscode.TextEditor, delay = 750) {
    if (!editor || editor.document.isClosed || editor.document.languageId !== LanguageId.Pascal) return;
    if (!this.featureEnabled(SettingKey.ColoringEnabled, true, editor.document)) {
      this.clearDecorations(editor);
      return;
    }
    const key = editor.document.uri.toString();
    const existingState = this.decorationStates.get(key);
    const state: DecorationState = existingState || { generation: 0, running: false };
    if (!existingState && editor.document.uri.scheme === UriScheme.File
      && this.persistentDecorationCacheEnabled(editor.document)) {
      const snapshotKey = normalizeKey(editor.document.fileName);
      const compactSnapshot = this.closedDecorationSnapshots.get(snapshotKey);
      if (compactSnapshot) {
        const contentIdentity = createHash('sha1').update(editor.document.getText()).digest('hex');
        if (compactSnapshot.contentIdentity === contentIdentity) {
          state.lastApplied = this.hydrateDecorationSnapshot(compactSnapshot, editor.document);
          output.appendLine(`Restored coloring cache for ${path.basename(editor.document.fileName)}.`);
        }
      }
    }
    const editorChanged = state.editor !== editor;
    state.generation += 1;
    state.editor = editor;
    this.decorationStates.set(key, state);
    if (editorChanged || delay === 0) {
      // Decorations belong to a TextEditor instance, not to its URI. VS Code
      // can recreate that instance when following a definition and returning,
      // but it can also reuse the same instance after temporarily replacing a
      // preview tab. Re-submit the atomic result on every immediate activation.
      const snapshotMatches = state.lastApplied?.contentIdentity
        && state.lastApplied.contentIdentity === createHash('sha1')
          .update(editor.document.getText()).digest('hex');
      if (state.lastApplied?.version === editor.document.version || snapshotMatches) {
        // onDidChangeActiveTextEditor can fire while VS Code is still replacing
        // a preview model. Replaying here sends setDecorations to the disposed
        // model and leaves the replacement editor permanently undecorated.
        // Defer the replay to the scheduled turn, after the model is stable.
        state.replayRequested = true;
      } else {
        // An invalid or absent cache must not leave hasApplied=true: that flag
        // would skip the fast pass and wait for optional package enrichment.
        state.hasApplied = false;
      }
    }
    clearTimeout(state.timer);
    const generation = state.generation;
    state.timer = setTimeout(() => void this.runScheduledDecoration(key, generation), delay);
  }

  async runScheduledDecoration(key: string, generation: number) {
    const state = this.decorationStates.get(key);
    if (!state || state.generation !== generation) return;
    const liveEditor = vscode.window.visibleTextEditors.find(editor =>
      !editor.document.isClosed && editor.document.uri.toString() === key);
    if (!liveEditor) return;
    state.editor = liveEditor;
    if (state.replayRequested && state.lastApplied?.ranges) {
      state.replayRequested = false;
      if (!this.applyDecorationRanges(liveEditor, state.lastApplied.ranges)) {
        state.pending = true;
      }
    }
    if (state.running) {
      state.pending = true;
      return;
    }
    state.running = true;
    state.pending = false;
    try {
      await this.decorate(state.editor, generation);
    } catch (error) {
      output.appendLine(`Decoration failed for ${state.editor?.document.fileName || key}: ${errorMessage(error)}`);
    } finally {
      state.running = false;
      if (state.pending || state.generation !== generation) {
        const currentEditor = vscode.window.visibleTextEditors.find(editor =>
          !editor.document.isClosed && editor.document.uri.toString() === key);
        if (currentEditor) this.scheduleDecorate(currentEditor, 0);
      }
    }
  }

  applyDecorationRanges(editor: vscode.TextEditor, ranges: DecorationRanges) {
    let liveEditor = this.liveDecorationEditor(editor);
    if (!liveEditor) return false;
    editor = liveEditor;
    const rangeKey = (range: vscode.Range) =>
      `${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}`;
    const uniqueRanges = (values: vscode.Range[]) => [...new Map(values.map((range: vscode.Range) => [
      rangeKey(range),
      range
    ])).values()];
    const memberRanges = uniqueRanges(ranges.memberRanges);
    const memberKeys = new Set(memberRanges.map(rangeKey));
    const operations: Array<[vscode.TextEditorDecorationType, vscode.Range[]]> = [
      [this.decoration, uniqueRanges(ranges.classRanges)],
      [this.unitDecoration, uniqueRanges(ranges.unitRanges)],
      // A parameterless Pascal function has the form `Name: ReturnType`; the
      // fast fallback may also see it as a variable. Method is authoritative.
      [this.globalDecoration,
        uniqueRanges(ranges.globalRanges).filter(range => !memberKeys.has(rangeKey(range)))],
      [this.memberDecoration, memberRanges],
      [this.propertyDecoration,
        uniqueRanges(ranges.propertyRanges).filter(range => !memberKeys.has(rangeKey(range)))],
      [this.constantDecoration, uniqueRanges(ranges.constantRanges)],
      [this.enumMemberDecoration, uniqueRanges(ranges.enumMemberRanges)]
    ];
    for (const [decoration, values] of operations) {
      // A preview tab can replace its TextEditor between two calls. Stop the
      // batch immediately instead of submitting the rest through a stale handle.
      liveEditor = this.liveDecorationEditor(editor);
      if (!liveEditor || liveEditor !== editor) return false;
      editor.setDecorations(decoration, values);
    }
    liveEditor = this.liveDecorationEditor(editor);
    if (!liveEditor || liveEditor !== editor) return false;
    const state = this.decorationStates.get(editor.document.uri.toString());
    if (state) {
      state.hasApplied = true;
      state.lastApplied = {
        version: editor.document.version,
        contentIdentity: createHash('sha1').update(editor.document.getText()).digest('hex'),
        ranges: {
          classRanges: [...ranges.classRanges],
          unitRanges: [...ranges.unitRanges],
          globalRanges: [...ranges.globalRanges],
          memberRanges: [...ranges.memberRanges],
          propertyRanges: [...ranges.propertyRanges],
          constantRanges: [...ranges.constantRanges],
          enumMemberRanges: [...ranges.enumMemberRanges]
        }
      };
      this.queueDecorationSnapshot(editor.document, state.lastApplied);
    }
    return true;
  }

  async fastDecorationRanges(editor: vscode.TextEditor, isStale = () => false): Promise<FastDecorationRanges | undefined> {
    const analysis = this.documentAnalysis(editor.document);
    const {
      text,
      code,
      usedUnits,
      visibleUnits,
      ownUnit,
      localDefinitions,
      localMembers,
      unitIdentifierOffsets
    } = analysis;
    const sourceIndex = this.sourceIndex || {
      definitions: new Map(),
      types: new Map(),
      members: new Map(),
      units: new Map()
    };
    const sourceVariables = new Set();
    const declaredTypes = new Map<string, string>();
    const localRoutines = new Set();
    const localConstants = new Set();
    const syntacticColoring = collectPascalSyntacticColoring(code);
    for (const declaration of code.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*)/g)) {
      for (const name of declaration[1].match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
        const key = name.toLowerCase();
        sourceVariables.add(key);
        if (!declaredTypes.has(key)) declaredTypes.set(key, declaration[2]);
      }
    }
    for (const name of collectPascalInlineVariableNames(text, code)) sourceVariables.add(name);
    for (const declaration of code.matchAll(/^\s*(?:class\s+)?(?:procedure|function|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_.]*)/gim)) {
      localRoutines.add(declaration[1].split('.').at(-1)!.toLowerCase());
    }
    for (const section of code.matchAll(/\bconst\b([\s\S]*?)(?=^\s*(?:type|var|threadvar|resourcestring|procedure|function|constructor|destructor|implementation|begin)\b)/gim)) {
      for (const declaration of section[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/gm)) {
        localConstants.add(declaration[1].toLowerCase());
      }
    }
    const ranges: FastDecorationRanges = {
      classRanges: [],
      unitRanges: [],
      globalRanges: [],
      memberRanges: [],
      propertyRanges: [],
      constantRanges: [],
      enumMemberRanges: [],
      text,
      code,
      sourceIndex,
      usedUnits,
      visibleUnits,
      ownUnit,
      unitIdentifierOffsets,
      declaredTypes,
      typeInferenceIndex: analysis.typeInferenceIndex
    };
    let identifierCount = 0;
    for (const match of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      identifierCount += 1;
      if ((identifierCount & 255) === 0) {
        if (isStale()) return undefined;
        await yieldToExtensionHost();
        if (isStale()) return undefined;
      }
      const key = match[0].toLowerCase();
      // Visibility words are contextual in Delphi: `public` starts a class
      // section here, while `TVisibility.Public` and enum declarations can be
      // real symbols.  Exclude only the structural occurrence.
      if (isPascalVisibilityDirectiveAt(code, match.index, match[0])) continue;
      const isIntrinsicTypeCast = syntacticColoring.typeCasts.has(match.index);
      const isUnit = unitIdentifierOffsets.has(match.index);
      const isMember = isPascalMemberReference(text, match.index, code);
      // A dotted identifier must be classified from its receiver. Applying an
      // unrelated visible global with the same name caused false positives such
      // as IJson.AsArray.Length being painted as a global Length routine.
      const isSourceVariable = !isMember && sourceVariables.has(key) && !localRoutines.has(key);
      const isLocalRoutine = !isMember && localRoutines.has(key);
      const isLocalConstant = !isMember && localConstants.has(key);
      // The active document's own parser is authoritative and synchronous. It
      // must win even while the full RAD/source index is still building.
      const visibleDefinitions = [
        ...(localDefinitions.get(key) || []),
        ...(sourceIndex.definitions.get(key) || []).filter((definition: SourceDefinition) =>
          unitIsVisible(definition.unitName, visibleUnits))
      ];
      const hasConstant = !isMember
        && visibleDefinitions.some(definition => definition.kind === 'constant');
      const hasEnumMember = !isMember
        && visibleDefinitions.some(definition => definition.kind === 'enumMember');
      const hasType = !isMember
        && visibleDefinitions.some(definition => definition.kind === PascalKeyword.Type);
      const hasRoutine = !isMember
        && visibleDefinitions.some(definition => definition.kind === SourceSymbolKind.Routine);
      const hasGlobal = !isMember && !hasRoutine
        && visibleDefinitions.some(definition => definition.kind === 'variable' || definition.kind === 'field');
      const hasProperty = !isMember
        && visibleDefinitions.some(definition => definition.kind === PascalKeyword.Property);
      // Predefined type names are not reserved words in Delphi and can be
      // shadowed by a real routine. Prefer an in-scope declaration when one is
      // present; otherwise `PWideChar(Value)` is a cast, never a yellow call.
      if (isIntrinsicTypeCast && !isLocalRoutine && !hasRoutine) {
        ranges.classRanges.push(new vscode.Range(
          editor.document.positionAt(match.index),
          editor.document.positionAt(match.index + match[0].length)
        ));
        continue;
      }
      const isSyntacticType = !isMember && syntacticColoring.typeNames.has(key);
      const isSyntacticCall = !isMember && syntacticColoring.calls.has(match.index);
      if (!isUnit && !isSourceVariable && !isLocalRoutine && !isLocalConstant
        && !hasConstant && !hasEnumMember && !hasType && !hasRoutine && !hasGlobal && !hasProperty
        && !isSyntacticType && !isSyntacticCall) {
        continue;
      }
      const range = new vscode.Range(
        editor.document.positionAt(match.index),
        editor.document.positionAt(match.index + match[0].length)
      );
      if (isUnit) ranges.unitRanges.push(range);
      if (isSourceVariable || hasGlobal) ranges.globalRanges.push(range);
      if (isLocalRoutine || hasRoutine || isSyntacticCall) ranges.memberRanges.push(range);
      if (isLocalConstant || hasConstant) ranges.constantRanges.push(range);
      if (hasEnumMember) ranges.enumMemberRanges.push(range);
      if (hasType || isSyntacticType) ranges.classRanges.push(range);
      if (hasProperty) ranges.propertyRanges.push(range);
    }
    let memberReferenceCount = 0;
    // Walk every identifier that follows a dot. A non-overlapping pair regex
    // sees `Body.Open` and `Ref.TopoBody` but skips the essential `Open.Ref`
    // edge, so a multi-level chain could never be colored consistently.
    for (const match of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      const memberName = match[0];
      const memberOffset = match.index;
      const chain = pascalMemberChainBefore(text, memberOffset, code);
      if (chain.length === 0) continue;
      memberReferenceCount += 1;
      if ((memberReferenceCount & 31) === 0) {
        if (isStale()) return undefined;
        await yieldToExtensionHost();
        if (isStale()) return undefined;
      }
      const receiverTypes = this.sourceReceiverTypesForChain(analysis, chain, memberOffset);
      let sourceMember;
      for (const typeName of receiverTypes) {
        sourceMember = this.sourceMemberDefinitionsForType(
          analysis, typeName, memberName
        )[0];
        if (sourceMember) break;
      }
      const range = new vscode.Range(
        editor.document.positionAt(memberOffset),
        editor.document.positionAt(memberOffset + memberName.length)
      );
      if (sourceMember) {
        (sourceMember.kind === SourceSymbolKind.Routine ? ranges.memberRanges : ranges.propertyRanges).push(range);
        continue;
      }
      // Missing source/DCP metadata should not leave ordinary member syntax
      // uncolored. Unit-name segments are already handled by unitRanges.
      if (unitIdentifierOffsets.has(memberOffset)) continue;
      const fallbackKind = syntacticColoring.members.get(memberOffset);
      if (fallbackKind === 'method') ranges.memberRanges.push(range);
      else if (fallbackKind === PascalKeyword.Property) ranges.propertyRanges.push(range);
    }
    return ranges;
  }

  async decorate(editor: vscode.TextEditor, generation?: number) {
    if (editor.document.languageId !== LanguageId.Pascal) return;
    const editorKey = editor.document.uri.toString();
    const startedAt = Date.now();
    const version = editor.document.version;
    const isStale = () => editor.document.isClosed || editor.document.version !== version
      || (generation !== undefined
        && this.decorationStates.get(editor.document.uri.toString())?.generation !== generation);
    const ranges = await this.fastDecorationRanges(editor, isStale);
    if (!ranges) return;
    const fastElapsed = Date.now() - startedAt;
    if (fastElapsed >= 100) {
      output.appendLine(
        `Slow current-file decoration for ${path.basename(editor.document.fileName)}: ${fastElapsed}ms.`
      );
    }
    if (isStale()) return;
    const state = this.decorationStates.get(editor.document.uri.toString());
    const compiledColoring = this.tdumpPath
      && this.featureEnabled(SettingKey.SymbolsCompiledEnabled, true, editor.document);
    // The current-file source result is authoritative and cheap. Always commit
    // it before any optional package work; an old hasApplied flag must never
    // make source symbols wait behind DCP/BPL enrichment after editor return.
    // Preserve already-complete compiled ranges for the same document version
    // so this immediate source commit does not cause a brief color regression.
    if (compiledColoring && state?.lastApplied?.version === version) {
      for (const key of RANGE_KINDS) {
        ranges[key] = [...(state.lastApplied.ranges[key] || []), ...ranges[key]];
      }
    }
    const fastEditor = vscode.window.visibleTextEditors.find(item =>
      !item.document.isClosed && item.document.uri.toString() === editorKey);
    if (!fastEditor || fastEditor.document.version !== version || isStale()) return;
    editor = fastEditor;
    if (!this.applyDecorationRanges(editor, ranges)) {
      if (state) state.pending = true;
      return;
    }
    if (!compiledColoring) return;
    const { directIndexes, usedUnitIndexes } = await this.packageDataForDocument(editor.document);
    if (isStale()) return;
    const compiledClasses = new Set(directIndexes.flatMap((index: CompiledPackageData) => [...index.names.keys()]));
    const compiledClassInfos = new Map<string, CompiledClass>();
    for (const index of directIndexes) {
      for (const [key, info] of index.packageIndex.classes) compiledClassInfos.set(key, info);
    }
    const compiledUnits = new Set<string>();
    const compiledGlobals = new Map<string, CompiledGlobal>();
    const compiledRoutines = new Map<string, CompiledRoutine>();
    const referencedIdentifiers = new Set(
      [...ranges.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)].map(match => match[0].toLowerCase())
    );
    for (const match of ranges.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      const chain = pascalMemberChainBefore(ranges.text, match.index, ranges.code);
      if (chain.length === 0) continue;
      const typeName = inferPascalTypeFromIndex(
        ranges.typeInferenceIndex,
        chain[0],
        match.index
      );
      if (typeName) referencedIdentifiers.add(pascalTypeBaseName(typeName).toLowerCase());
    }
    const enrichmentTasks = [];
    for (const [key, info] of compiledClassInfos) {
      if (referencedIdentifiers.has(key)) enrichmentTasks.push(this.enrichClass(info));
    }
    for (const unit of usedUnitIndexes) {
      compiledUnits.add(unit.symbol.toLowerCase());
      for (const [key, info] of unit.classes) {
        compiledClasses.add(key);
        compiledClassInfos.set(key, info);
        if (referencedIdentifiers.has(key)) enrichmentTasks.push(this.enrichClass(info));
      }
      for (const [key, info] of unit.globals) {
        if (!referencedIdentifiers.has(key)) continue;
        compiledGlobals.set(key, info);
        enrichmentTasks.push(this.enrichGlobal(info, { workspaceMembers: false }));
      }
      for (const [key, overloads] of unit.routines) {
        if (!referencedIdentifiers.has(key)) continue;
        const info = overloads[0];
        compiledRoutines.set(key, info);
        enrichmentTasks.push(this.enrichRoutine(info, { workspaceMembers: false }));
      }
    }
    await Promise.all(enrichmentTasks);
    // Follow only member-result types reachable from the identifiers in this
    // document. This prepares TFaceDiscreteRes.FMesh -> TFaceMesh without
    // eagerly enriching thousands of unrelated generic classes in the BPL.
    for (let pass = 0; pass < 3; pass += 1) {
      const linked = [];
      let discovered = false;
      for (const key of [...referencedIdentifiers]) {
        const info = compiledClassInfos.get(key);
        if (!info?.compiledMembersLoaded) continue;
        for (const member of knownCompiledMembers(info).values()) {
          for (const typeToken of String(member.value?.typeName || '')
            .match(/\b[TI][A-Za-z0-9_]*\b/g) || []) {
            const typeKey = typeToken.toLowerCase();
            if (!compiledClassInfos.has(typeKey) || referencedIdentifiers.has(typeKey)) continue;
            referencedIdentifiers.add(typeKey);
            linked.push(this.enrichClass(compiledClassInfos.get(typeKey)));
            discovered = true;
          }
        }
      }
      if (!discovered) break;
      await Promise.all(linked);
    }
    let compiledIdentifierCount = 0;
    for (const match of ranges.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      compiledIdentifierCount += 1;
      if ((compiledIdentifierCount & 127) === 0) {
        await yieldToExtensionHost();
        if (isStale()) return;
      }
      const key = match[0].toLowerCase();
      if (isPascalVisibilityDirectiveAt(ranges.code, match.index, match[0])) continue;
      const isClass = compiledClasses.has(key);
      const isUnit = compiledUnits.has(key) && ranges.unitIdentifierOffsets.has(match.index);
      const isGlobal = compiledGlobals.has(key);
      const isRoutine = compiledRoutines.has(key);
      if (!isClass && !isUnit && !isGlobal && !isRoutine) continue;
      const range = new vscode.Range(
        editor.document.positionAt(match.index),
        editor.document.positionAt(match.index + match[0].length)
      );
      if (isClass) ranges.classRanges.push(range);
      if (isUnit) ranges.unitRanges.push(range);
      if (isGlobal) ranges.globalRanges.push(range);
      if (isRoutine) ranges.memberRanges.push(range);
    }
    let compiledMemberCount = 0;
    const analysis = this.documentAnalysis(editor.document);
    for (const match of ranges.code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
      const memberName = match[0];
      const memberOffset = match.index;
      const chain = pascalMemberChainBefore(ranges.text, memberOffset, ranges.code);
      if (chain.length === 0) continue;
      compiledMemberCount += 1;
      if ((compiledMemberCount & 15) === 0) {
        await yieldToExtensionHost();
        if (isStale()) return;
      }
      const receiverTypes = this.compiledReceiverTypesForChain(
        analysis,
        chain,
        memberOffset,
        compiledClassInfos
      );
      let member;
      for (const typeName of receiverTypes) {
        const info = compiledClassInfos.get(pascalTypeBaseName(typeName).toLowerCase());
        member = info ? knownCompiledMembers(info).get(memberName.toLowerCase()) : undefined;
        if (member) break;
      }
      if (member) {
        const range = new vscode.Range(
          editor.document.positionAt(memberOffset),
          editor.document.positionAt(memberOffset + memberName.length)
        );
        // Delphi permits parameterless functions without parentheses. A
        // mangled callable remains a method in `BodyDisc.Perform` and must not
        // change to the property/field color merely because `(` is absent.
        const isMethod = member.kind === 'method';
        (isMethod ? ranges.memberRanges : ranges.propertyRanges).push(range);
        continue;
      }
    }
    if (!isStale()) {
      const completeEditor = vscode.window.visibleTextEditors.find(item =>
        !item.document.isClosed && item.document.uri.toString() === editorKey);
      if (!completeEditor || completeEditor.document.version !== version) return;
      editor = completeEditor;
      if (!this.applyDecorationRanges(editor, ranges)) {
        const failedState = this.decorationStates.get(editorKey);
        if (failedState) failedState.pending = true;
        return;
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= 250) {
        output.appendLine(
          `Complete decoration for ${path.basename(editor.document.fileName)}: `
          + `${elapsed}ms (${fastElapsed}ms current-file phase).`
        );
      }
    }
  }
}

class UsesQuickFixSupport {
  context;
  compiledSymbolSupport;
  sourceIndexPromise;
  combinedIndexPromise: Promise<SymbolUnitIndex>|undefined;
  fullCombinedIndexPromise: Promise<SymbolUnitIndex>|undefined;
  sourceTypeIndexPromise: Promise<SymbolUnitIndex>|undefined;
  combinedTypeIndexPromise: Promise<SymbolUnitIndex>|undefined;
  fullCombinedTypeIndexPromise: Promise<SymbolUnitIndex>|undefined;
  dcpIndexPromise: Promise<{ fileCount: number; symbols: SymbolUnitIndex }>|undefined;
  knownTypeDecoration;
  refreshTimers: Map<string, NodeJS.Timeout>;

  constructor(context: vscode.ExtensionContext, compiledSymbolSupport: CompiledSymbolSupport, sourceIndexPromise: Promise<SourceIndex>) {
    this.context = context;
    this.compiledSymbolSupport = compiledSymbolSupport;
    this.sourceIndexPromise = sourceIndexPromise;
    this.combinedIndexPromise = undefined;
    this.fullCombinedIndexPromise = undefined;
    this.sourceTypeIndexPromise = undefined;
    this.combinedTypeIndexPromise = undefined;
    this.fullCombinedTypeIndexPromise = undefined;
    this.dcpIndexPromise = undefined;
    this.knownTypeDecoration = semanticDecoration(PascalKeyword.Class);
    this.refreshTimers = new Map();
    context.subscriptions.push(this.knownTypeDecoration);
  }

  async sourceIndex() {
    return this.sourceIndexPromise;
  }

  async sourceTypeIndex() {
    if (!this.sourceTypeIndexPromise) {
      this.sourceTypeIndexPromise = this.sourceIndex().then(sourceTypeUnitIndex);
    }
    return this.sourceTypeIndexPromise;
  }

  enabled(document: vscode.TextDocument) {
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection, document?.uri);
    return configuration.get(SettingKey.Enabled, true) && configuration.get(SettingKey.MissingUnitsEnabled, true);
  }

  async unitCandidates(document: vscode.TextDocument, symbol: string) {
    if (isPascalIntrinsicIdentifier(symbol)) return [];
    const compiledFallback = vscode.workspace.getConfiguration(ConfigurationSection, document.uri)
      .get(SettingKey.MissingUnitsCompiledFallback, true);
    const index = compiledFallback ? await this.fullCombinedIndex() : await this.combinedIndex();
    return filterAddUnitCandidates(index.get(symbol.toLowerCase()));
  }

  async combinedIndex() {
    if (!this.combinedIndexPromise) {
      const roots = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
      if (!this.dcpIndexPromise) {
        this.dcpIndexPromise = buildDcpSymbolIndex(roots).then(index => {
          output.appendLine(`DCP Add Unit index: ${index.fileCount} files, ${index.symbols.size} symbols.`);
          return index;
        });
      }
      this.combinedIndexPromise = Promise.all([
        this.sourceIndex(),
        this.dcpIndexPromise
      ]).then(([source, dcp]) => {
        const result: SymbolUnitIndex = new Map();
        for (const index of [source.symbols, dcp.symbols]) {
          for (const [symbol, units] of index) {
            if (!result.has(symbol)) result.set(symbol, new Set());
            for (const unitName of units) result.get(symbol)!.add(unitName);
          }
        }
        output.appendLine(`Lightweight Add Unit index: ${result.size} symbols.`);
        return result;
      });
    }
    return this.combinedIndexPromise;
  }

  async fullCombinedIndex() {
    if (!this.fullCombinedIndexPromise) {
      this.fullCombinedIndexPromise = Promise.all([
        this.combinedIndex(),
        this.compiledSymbolSupport.allUnitCandidates()
      ]).then(([lightweight, compiled]) => {
        const result = new Map([...lightweight].map(([symbol, units]) => [symbol, new Set(units)]));
        for (const [symbol, units] of compiled) {
          if (!result.has(symbol)) result.set(symbol, new Set());
          for (const unitName of units) result.get(symbol)!.add(unitName);
        }
        output.appendLine(`Full on-demand Add Unit index: ${result.size} symbols.`);
        return result;
      });
    }
    return this.fullCombinedIndexPromise;
  }

  async combinedTypeIndex() {
    if (!this.combinedTypeIndexPromise) {
      // Raw DCP strings do not carry a reliable declaration kind. Treating
      // every I/T-prefixed DCP symbol as a type caused routine names such as
      // IsNotNull to leak into automatic diagnostics. Automatic diagnostics
      // therefore use parsed source type declarations only; the explicit Add
      // Unit command can still search DCP/BPL symbols on demand.
      this.combinedTypeIndexPromise = this.sourceTypeIndex();
    }
    return this.combinedTypeIndexPromise;
  }

  async fullCombinedTypeIndex() {
    if (!this.fullCombinedTypeIndexPromise) {
      this.fullCombinedTypeIndexPromise = Promise.all([
        this.combinedTypeIndex(),
        this.compiledSymbolSupport.allTypeUnitCandidates()
      ]).then(([lightweight, compiled]) => {
        const result = new Map([...lightweight].map(([symbol, units]) => [symbol, new Set(units)]));
        for (const [symbol, units] of compiled) {
          if (!result.has(symbol)) result.set(symbol, new Set());
          for (const unitName of units) result.get(symbol)!.add(unitName);
        }
        return result;
      });
    }
    return this.fullCombinedTypeIndexPromise;
  }

  wordAtRange(document: vscode.TextDocument, range: vscode.Range) {
    const wordRange = document.getWordRangeAtPosition(range.start, /[A-Za-z_][A-Za-z0-9_]*/);
    return wordRange ? document.getText(wordRange) : undefined;
  }

  async addUnitAtCursor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !inList(editor.document.languageId, [LanguageId.Pascal, LanguageId.ObjectPascal])) return;
    if (!this.enabled(editor.document)) {
      vscode.window.showInformationMessage('Pascal Atlas: missing-Unit assistance is disabled.');
      return;
    }
    const document = editor.document;
    const position = editor.selection.active;
    const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    const symbol = range ? document.getText(range) : document.getText(editor.selection).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) {
      vscode.window.showInformationMessage('Add Unit: place the cursor on an unknown Pascal symbol.');
      return;
    }
    const symbolOffset = document.offsetAt(range?.start || position);
    if (isPascalRoutineDeclarationIdentifier(document.getText(), symbolOffset)) {
      output.appendLine(`Add Unit ignored for routine declaration ${symbol}.`);
      vscode.window.showInformationMessage(`Add Unit: ${symbol} is a routine declaration, not a missing type.`);
      return;
    }
    output.appendLine(`Add Unit requested for ${symbol} in ${path.basename(document.fileName)}.`);
    const ownUnit = parseSourceUnitSymbols(document.getText(), document.fileName)?.unitName?.toLowerCase();
    const candidates = filterAddUnitCandidates(await this.unitCandidates(document, symbol), ownUnit)
      .map(unitName => ({
        unitName,
        insertion: planUsesInsertion(document.getText(), symbolOffset, unitName)
      }))
      .filter((item): item is { unitName: string; insertion: { offset: number; text: string } } => Boolean(item.insertion));
    if (candidates.length === 0) {
      output.appendLine(`No missing Unit candidate found for ${symbol}.`);
      vscode.window.showInformationMessage(`Add Unit: no missing Unit found for ${symbol}.`);
      return;
    }
    let selected = candidates[0];
    if (candidates.length > 1) {
      const choice = await vscode.window.showQuickPick(
        candidates.map(item => ({ label: item.unitName, description: `Add to uses for ${symbol}`, item })),
        { title: `Select Unit for ${symbol}` }
      );
      if (!choice) return;
      selected = choice.item;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.insert(document.uri, document.positionAt(selected.insertion.offset), selected.insertion.text);
    if (await vscode.workspace.applyEdit(edit)) {
      output.appendLine(`Added ${selected.unitName} to uses for ${symbol} in ${path.basename(document.fileName)}.`);
    }
  }

  decorateKnownTypes(document: vscode.TextDocument, index: SymbolUnitIndex) {
    const editor = vscode.window.visibleTextEditors.find(
      item => item.document.uri.toString() === document.uri.toString()
    );
    if (!editor) return;
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection, document.uri);
    if (!configuration.get(SettingKey.Enabled, true) || !configuration.get(SettingKey.ColoringEnabled, true)) {
      editor.setDecorations(this.knownTypeDecoration, []);
      return;
    }
    const ranges = findKnownUnitReferences(document.getText(), index).map(reference => new vscode.Range(
      document.positionAt(reference.offset),
      document.positionAt(reference.offset + reference.length)
    ));
    editor.setDecorations(this.knownTypeDecoration, ranges);
  }

  async provideCodeActions(document: vscode.TextDocument, context: vscode.CodeActionContext) {
    if (!this.enabled(document)) return [];
    const text = document.getText();
    const ownUnit = parseSourceUnitSymbols(text, document.fileName)?.unitName?.toLowerCase();
    const actions = [];
    const seen = new Set();
    for (const diagnostic of context.diagnostics || []) {
      if (diagnostic.source === 'Pascal Atlas') continue;
      const symbol = unknownSymbolFromDiagnostic(diagnostic.message);
      if (!symbol || isPascalIntrinsicIdentifier(symbol)) continue;
      const symbolRange = document.getWordRangeAtPosition(
        diagnostic.range.start,
        /[A-Za-z_][A-Za-z0-9_]*/
      ) || diagnostic.range;
      const offset = document.offsetAt(symbolRange.start);
      const candidates = filterAddUnitCandidates(await this.unitCandidates(document, symbol), ownUnit)
        .map(unitName => ({
          unitName,
          insertion: planUsesInsertion(text, offset, unitName)
        }))
        .filter((item): item is { unitName: string; insertion: { offset: number; text: string } } => Boolean(item.insertion))
        .slice(0, 12);
      for (const candidate of candidates) {
        const identity = `${symbol.toLowerCase()}|${candidate.unitName.toLowerCase()}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const action = new vscode.CodeAction(
          `Add ${candidate.unitName} to uses (${symbol})`,
          vscode.CodeActionKind.QuickFix
        );
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, document.positionAt(candidate.insertion.offset), candidate.insertion.text);
        action.edit = edit;
        action.diagnostics = [diagnostic];
        action.isPreferred = candidates.length === 1;
        actions.push(action);
      }
    }
    return actions;
  }

  async refreshDiagnostics(document: vscode.TextDocument) {
    if (!inList(document.languageId, [LanguageId.Pascal, LanguageId.ObjectPascal]) || document.uri.scheme !== UriScheme.File) return;
    if (!this.enabled(document)) {
      const editor = vscode.window.visibleTextEditors.find(
        item => item.document.uri.toString() === document.uri.toString()
      );
      if (editor) editor.setDecorations(this.knownTypeDecoration, []);
      return;
    }
    const version = document.version;
    const index = await this.combinedTypeIndex();
    if (document.isClosed || document.version !== version) return;
    this.decorateKnownTypes(document, index);
  }

  scheduleDiagnostics(document: vscode.TextDocument) {
    const key = document.uri.toString();
    clearTimeout(this.refreshTimers.get(key));
    const delay = vscode.workspace.getConfiguration(ConfigurationSection, document.uri)
      .get(SettingKey.MissingUnitsDebounceMs, 350);
    this.refreshTimers.set(key, setTimeout(() => {
      this.refreshTimers.delete(key);
      this.refreshDiagnostics(document).catch(error => {
        output.appendLine(`Unit index refresh failed for ${document.fileName}: ${error.message}`);
      });
    }, delay));
  }

  register() {
    this.context.subscriptions.push(vscode.commands.registerCommand(CommandId.AddUnit, async () => {
      await this.addUnitAtCursor();
    }));
    this.context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(document => {
      this.scheduleDiagnostics(document);
    }));
    this.context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
      this.scheduleDiagnostics(event.document);
    }));
    this.context.subscriptions.push(vscode.languages.registerCodeActionsProvider(
      [
        { language: LanguageId.Pascal, scheme: UriScheme.File },
        { language: LanguageId.ObjectPascal, scheme: UriScheme.File }
      ],
      { provideCodeActions: (document, _range, context) => this.provideCodeActions(document, context) },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
    ));
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('pascalAtlas.missingUnits')
        && !event.affectsConfiguration('pascalAtlas.enabled')) return;
      for (const document of vscode.workspace.textDocuments) this.scheduleDiagnostics(document);
    }));
    for (const document of vscode.workspace.textDocuments) this.scheduleDiagnostics(document);
  }
}

function asStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter(item => typeof item === "string") : [];
}

function uniquePaths(values: string[]) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === '') {
      continue;
    }
    const key = normalizeKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function delphiSourceRoots() {
  const installation = vscode.workspace.getConfiguration('vallenta.studio').get('installationPath', '');
  const source = path.join(installation, 'source');
  return uniquePaths([
    path.join(source, 'rtl', 'sys'),
    path.join(source, 'rtl', 'common'),
    path.join(source, 'rtl', 'win'),
    path.join(source, 'vcl')
  ]).filter(value => {
    try {
      return fs.statSync(value).isDirectory();
    } catch {
      return false;
    }
  });
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value: string, index: number) => value === right[index]);
}

function minimalSourceRoots(values: string[]) {
  const candidates = uniquePaths(values)
    .filter(value => {
      try {
        return fs.statSync(value).isDirectory();
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.length - right.length);
  const roots: string[] = [];
  for (const candidate of candidates) {
    const nested = roots.some(root => {
      const relative = path.relative(root, candidate);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!nested) roots.push(candidate);
  }
  return roots;
}

async function restartLanguageServices() {
  const shouldRestart = vscode.workspace
    .getConfiguration(ConfigurationSection)
    .get(SettingKey.RestartActiveLsp, true);
  if (!shouldRestart) {
    return;
  }
  output.appendLine('Restarting the active Vallenta LSP with the updated DCC_UnitSearchPath.');
  await vscode.commands.executeCommand('vallenta.studio.lsp.restart');
}

function automaticProjectGroupDetectionEnabled(resource: vscode.ConfigurationScope|null|undefined) {
  const configuration = vscode.workspace.getConfiguration(ConfigurationSection, resource);
  return configuration.get(SettingKey.Enabled, true)
    && configuration.get(SettingKey.ProjectGroupsAutoDetect, true);
}

async function detectWorkspaceProjectGroups(workspaceFolder: vscode.WorkspaceFolder, options: { force?: boolean; refreshVallenta?: boolean } = {}) {
  if (!options.force && !automaticProjectGroupDetectionEnabled(workspaceFolder.uri)) {
    return { changed: false, discoveredGroups: [], addedGroups: [] };
  }
  const configuration = vscode.workspace.getConfiguration(ConfigurationSection, workspaceFolder.uri);
  const result = await ensureVallentaProjectGroups(workspaceFolder.uri.fsPath, {
    activateFirstProject: configuration.get(SettingKey.ProjectGroupsActivateFirstProject, true)
  });
  if (!result.changed) return result;
  output.appendLine(
    `[${workspaceFolder.name}] Auto-detected ${result.discoveredGroups.length} groupproj file(s); `
    + `added ${result.addedGroups.length} to Vallenta`
    + `${result.activeProjectChanged ? ' and selected the first child project' : ''}.`
  );
  if (options.refreshVallenta !== false) {
    try {
      await vscode.commands.executeCommand('vallenta.studio.refreshProjects');
    } catch (error) {
      output.appendLine(`Vallenta project refresh deferred: ${errorMessage(error)}`);
    }
  }
  return result;
}

async function detectAllWorkspaceProjectGroups(options: Partial<{ refreshVallenta?: boolean; force?: boolean; }|undefined> = {}) {
  const results = [];
  for (const folder of vscode.workspace.workspaceFolders || []) {
    results.push(await detectWorkspaceProjectGroups(folder, options));
  }
  return results;
}

async function activateVallentaForProjectGroups(results: Array<Awaited<ReturnType<typeof detectWorkspaceProjectGroups>>>) {
  const detected = (results || []).some((result) => result.discoveredGroups?.length > 0);
  if (!detected) return false;
  const changed = (results || []).some((result) => result.changed);
  const extension = vscode.extensions.getExtension('VallentaStudio.vallenta-studio');
  if (!extension) {
    output.appendLine('Vallenta activation deferred: extension is not installed yet.');
    return false;
  }
  const activatedNow = !extension.isActive;
  if (activatedNow) {
    output.appendLine('Activating Vallenta directly for the detected Project Group.');
    await extension.activate();
  }
  // An activation reads the already-written project files itself. When the
  // extension was already active, refresh only if discovery actually changed
  // them. Reissuing refresh on every Reload Window discarded Vallenta's warm
  // state and unnecessarily rebuilt the project model.
  if (changed && !activatedNow) {
    await vscode.commands.executeCommand('vallenta.studio.refreshProjects');
    output.appendLine('Vallenta project list refreshed after Project Group detection changed it.');
  } else {
    output.appendLine('Reused the persisted Vallenta Project Group without an extra refresh.');
  }
  return true;
}

function updateProcessUnitSearchPath(previousManaged: string[], nextManaged: string[]) {
  process.env.DCC_UnitSearchPath = mergeManagedSearchPath(
    process.env.DCC_UnitSearchPath || '',
    previousManaged,
    nextManaged
  );
  output.appendLine(
    `Injected ${nextManaged.length} managed paths into DCC_UnitSearchPath (${splitSearchPath(process.env.DCC_UnitSearchPath).length} total).`
  );
}

async function syncWorkspace(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder, options: { restart?: boolean; pathSync?: boolean } = {}) {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  await detectWorkspaceProjectGroups(workspaceFolder);
  const projects = discoverLoadedProjects(workspaceRoot);
  if (projects.length === 0) {
    output.appendLine(`[${workspaceFolder.name}] No loaded Vallenta projects found.`);
    return { changed: false, projects: [], paths: [] };
  }

  const includeNested = vscode.workspace
    .getConfiguration(ConfigurationSection, workspaceFolder.uri)
    .get(SettingKey.IncludeNestedSourceDirectories, true);
  // Vallenta already discovers the Delphi installation's complete source tree.
  // Keep RTL/VCL roots in our private source index, but do not inject them into
  // Vallenta's global libraryPath where they cause a redundant LSP restart.
  const managedPaths = await collectPascalAtlasPaths(projects, includeNested);
  const stateKey = `${MANAGED_PATHS_KEY}:${workspaceRoot}`;
  const workspaceManaged = asStringArray(context.workspaceState.get(stateKey, []));
  // libraryPath is global, so paths managed by the previously active workspace
  // must be replaced instead of accumulated. Otherwise parallel checkouts of the
  // same Delphi project expose duplicate Unit names and definition lookup can
  // jump into the old checkout.
  const previousManaged = asStringArray(
    context.globalState.get(GLOBAL_MANAGED_PATHS_KEY, workspaceManaged)
  );
  const previousKeys = new Set(previousManaged.map(normalizeKey));
  updateProcessUnitSearchPath(previousManaged, managedPaths);

  const vallentaConfig = vscode.workspace.getConfiguration('vallenta.studio', workspaceFolder.uri);
  const inspected = vallentaConfig.inspect<string[]>('libraryPath');
  const currentGlobalPaths = asStringArray(inspected?.globalValue);
  const unmanagedGlobalPaths = currentGlobalPaths.filter(item => !previousKeys.has(normalizeKey(item)));
  const nextGlobalPaths = uniquePaths([...unmanagedGlobalPaths, ...managedPaths]);
  const globalChanged = !arraysEqual(currentGlobalPaths, nextGlobalPaths);

  // Vallenta 1.2.1 exposes libraryPath as a normal setting but its LSP startup
  // cache reads only the global value. Version 0.1 of this companion wrote a
  // workspace value; remove only its managed entries during migration.
  const currentWorkspacePaths = asStringArray(inspected?.workspaceValue);
  const cleanedWorkspacePaths = currentWorkspacePaths.filter(
    item => !previousKeys.has(normalizeKey(item))
  );
  const workspaceChanged = currentWorkspacePaths.length > 0
    && !arraysEqual(currentWorkspacePaths, cleanedWorkspacePaths);

  if (workspaceChanged) {
    const workspaceMatchesOldGlobal = arraysEqual(cleanedWorkspacePaths, currentGlobalPaths);
    await vallentaConfig.update(
      'libraryPath',
      workspaceMatchesOldGlobal ? undefined : cleanedWorkspacePaths,
      vscode.ConfigurationTarget.Workspace
    );
  }
  if (globalChanged) {
    await vallentaConfig.update(
      'libraryPath',
      nextGlobalPaths,
      vscode.ConfigurationTarget.Global
    );
  }
  await context.workspaceState.update(stateKey, managedPaths);
  await context.globalState.update(GLOBAL_MANAGED_PATHS_KEY, managedPaths);

  const changed = globalChanged || workspaceChanged;
  output.appendLine(
    `[${workspaceFolder.name}] ${projects.length} projects, ${managedPaths.length} managed global source paths${changed ? ' (updated)' : ' (unchanged)'}; replaced ${previousManaged.length} previously managed paths.`
  );
  return { changed, globalChanged, projects, paths: managedPaths };
}

async function syncAll(context: vscode.ExtensionContext, options: Partial<{ restart: boolean; }> = {}) {
  const folders = vscode.workspace.workspaceFolders || [];
  const results = [];
  for (const folder of folders) {
    results.push(await syncWorkspace(context, folder, { ...options, restart: false }));
  }
  if (options.restart !== false && results.some(result => result.globalChanged)) {
    await restartLanguageServices();
  }
  return results;
}

function enqueueSync(context: vscode.ExtensionContext, options: { restart?: boolean } = {}) {
  syncPromise = syncPromise
    .catch(() => undefined)
    .then(() => syncAll(context, options))
    .catch(error => {
      output.appendLine(`Synchronization failed: ${error.stack || error.message}`);
      vscode.window.showErrorMessage(`Pascal Atlas: ${error.message}`);
    });
  return syncPromise;
}

function automaticPathSyncEnabled() {
  const configuration = vscode.workspace.getConfiguration(ConfigurationSection);
  return configuration.get(SettingKey.Enabled, true) && configuration.get(SettingKey.PathsEnabled, true);
}

function anyProjectGroupDetectionEnabled() {
  return (vscode.workspace.workspaceFolders || [])
    .some(folder => automaticProjectGroupDetectionEnabled(folder.uri));
}

function scheduleSync(context: vscode.ExtensionContext) {
  if (!automaticPathSyncEnabled() && !anyProjectGroupDetectionEnabled()) return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    if (automaticPathSyncEnabled()) {
      void enqueueSync(context);
      return;
    }
    void detectAllWorkspaceProjectGroups().catch(error => {
      output.appendLine(`Project Group detection failed: ${error.stack || error.message}`);
    });
  }, 750);
}

async function restoreWorkspace(context: vscode.ExtensionContext, workspaceFolder: vscode.WorkspaceFolder) {
  const workspaceRoot = workspaceFolder.uri.fsPath;
  const stateKey = `${MANAGED_PATHS_KEY}:${workspaceRoot}`;
  const workspaceManaged = asStringArray(context.workspaceState.get(stateKey, []));
  const previousManaged = asStringArray(
    context.globalState.get(GLOBAL_MANAGED_PATHS_KEY, workspaceManaged)
  );
  const previousKeys = new Set(previousManaged.map(normalizeKey));
  updateProcessUnitSearchPath(previousManaged, []);
  const vallentaConfig = vscode.workspace.getConfiguration('vallenta.studio', workspaceFolder.uri);
  const inspected = vallentaConfig.inspect<string[]>('libraryPath');
  const currentGlobalPaths = asStringArray(inspected?.globalValue);
  const restoredPaths = currentGlobalPaths.filter(item => !previousKeys.has(normalizeKey(item)));
  await vallentaConfig.update(
    'libraryPath',
    restoredPaths,
    vscode.ConfigurationTarget.Global
  );
  const currentWorkspacePaths = asStringArray(inspected?.workspaceValue);
  const cleanedWorkspacePaths = currentWorkspacePaths.filter(
    item => !previousKeys.has(normalizeKey(item))
  );
  if (!arraysEqual(currentWorkspacePaths, cleanedWorkspacePaths)) {
    await vallentaConfig.update(
      'libraryPath',
      cleanedWorkspacePaths.length === 0 ? undefined : cleanedWorkspacePaths,
      vscode.ConfigurationTarget.Workspace
    );
  }
  await context.workspaceState.update(stateKey, []);
  await context.globalState.update(GLOBAL_MANAGED_PATHS_KEY, []);
  output.appendLine(`[${workspaceFolder.name}] Removed ${previousManaged.length} managed paths.`);
}

async function syncVallentaEncodingWarningSetting() {
  const vallentaExtension = vscode.extensions.getExtension('VallentaStudio.vallenta-studio');
  if (!vallentaExtension) {
    output.appendLine('UTF-8 conversion warning preference deferred: Vallenta is not installed.');
    return false;
  }
  const ignoreWarning = vscode.workspace
    .getConfiguration(ConfigurationSection)
    .get(SettingKey.DiagnosticsIgnoreUtf8ConversionWarning, true);
  const vallentaConfiguration = vscode.workspace.getConfiguration('vallenta.studio');
  const encodingCheckEnabled = !ignoreWarning;
  if (vallentaConfiguration.get<boolean>('encodingCheck', true) === encodingCheckEnabled) return false;
  await vallentaConfiguration.update(
    'encodingCheck',
    encodingCheckEnabled,
    vscode.ConfigurationTarget.Global
  );
  output.appendLine(
    `${encodingCheckEnabled ? 'Enabled' : 'Suppressed'} Vallenta's ANSI-to-UTF-8 recommendation warning `
    + 'from the Pascal Atlas diagnostics preference.'
  );
  return true;
}

async function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(output);
  // Apply this before Vallenta is activated for a detected project group, so
  // its initial document scan cannot briefly publish an unwanted diagnostic.
  await syncVallentaEncodingWarningSetting().catch(error => {
    output.appendLine(`Could not synchronize the UTF-8 conversion warning preference: ${error.message}`);
  });
  // The project registration is the first awaited startup operation. It is a
  // small directory walk, and must finish before a visible class navigator can
  // request a model for a multi-megabyte source file.
  const startupProjectDiscoveryResults = await detectAllWorkspaceProjectGroups({
    refreshVallenta: false
  }).catch(error => {
    output.appendLine(`Automatic groupproj detection failed: ${error.stack || error.message}`);
    return [];
  });
  const startupProjectDiscoveryPromise = Promise.resolve(startupProjectDiscoveryResults);
  void activateVallentaForProjectGroups(startupProjectDiscoveryResults).catch(error => {
    output.appendLine(`Vallenta startup after groupproj detection failed: ${error.stack || error.message}`);
  });

  // Register the typing fast path before optional migrations, source/package
  // indexing, and UI services. Project Group registration above is deliberately
  // the sole startup prerequisite so Vallenta cannot miss the workspace.
  registerPascalLanguageConfiguration(context, vscode);
  registerPlatformSourceIsolation(context, output);
  registerImmediateSpaceExpansion(context, vscode);
  registerSpaceTriggeredSnippetExpansion(context, vscode);

  void initializeFirstRunSettings(context, output).catch(error => {
    output.appendLine(`First-run settings initialization skipped: ${error.message}`);
  });
  registerDependencySupport(context, output);
  registerEncodingSupport(context, output);
  const controlCenter = new PascalAtlasControlCenterProvider(context, output);
  controlCenter.register();
  void migrateLegacyFormatterSettings().catch(error => {
    output.appendLine(`Formatter setting migration skipped: ${error.message}`);
  });
  registerFormatter(context);
  registerExplorerSupport(context, output);

  // This extension activates eagerly, before Vallenta's onLanguage activation.
  // Bootstrap from the persisted extension so Vallenta's project evaluator inherits
  // DCC_UnitSearchPath before it starts the first language server.
  const bootstrapPaths = asStringArray(
    vscode.workspace.getConfiguration('vallenta.studio').get('libraryPath', [])
  );
  updateProcessUnitSearchPath([], bootstrapPaths);

  // Diagnostics must not wait for the much larger source/BPL symbol indexes.
  // A slow or failed optional index must never disable syntax/compiler errors.
  backgroundDiagnostics = new BackgroundDiagnostics(context, output);
  backgroundDiagnostics.register();
  const buildDebugSupport = new BuildDebugSupport(context, output, backgroundDiagnostics);
  buildDebugSupport.register();

  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  const projectSourceRoots = minimalSourceRoots([
    ...workspaceFolders.map(folder => folder.uri.fsPath),
    ...workspaceFolders.flatMap(folder => asStringArray(
      context.workspaceState.get(`${MANAGED_PATHS_KEY}:${folder.uri.fsPath}`, [])
    ))
  ]);
  const platformSourceRoots = minimalSourceRoots(delphiSourceRoots());
  const persistentSourceCacheEnabled = vscode.workspace.getConfiguration(ConfigurationSection)
    .get(SettingKey.SymbolsSourceCacheEnabled, true);
  const sourceCachePath = (label: string, roots: string[]) => {
    if (!persistentSourceCacheEnabled || roots.length === 0) return undefined;
    const identity = roots.map(normalizeKey).sort().join('|');
    const name = createHash('sha1').update(`${label}:${identity}`).digest('hex');
    return path.join(context.globalStorageUri.fsPath, 'source-index-v1', `${name}.json.gz`);
  };
  const projectSourceCachePath = sourceCachePath('project', projectSourceRoots);
  const platformSourceCachePath = sourceCachePath(PascalKeyword.Platform, platformSourceRoots);
  const activePascalDocument = vscode.window.activeTextEditor?.document.languageId === LanguageId.Pascal
    ? vscode.window.activeTextEditor.document
    : undefined;
  const priorityPlatformUnits = activePascalDocument
    ? [...parseUsesUnits(activePascalDocument.getText()), 'system']
    : ['system'];
  const immediatePlatformUnits = priorityPlatformUnits.filter(unitName =>
    /^(?:vcl|fmx)\./.test(unitName));
  const secondaryPlatformUnits = priorityPlatformUnits.filter(unitName =>
    !immediatePlatformUnits.includes(unitName));
  const indexIdlePromise = waitForPascalEditorIdle(context, 1500);
  const maintenanceIdlePromise = waitForPascalEditorIdle(context, 5000);
  // Keep startup work serial. Multiple parser workers plus Vallenta's first LSP
  // load competed for CPU and made a newly opened editor feel frozen.
  const priorityPlatformIndexPromise = indexIdlePromise.then(() =>
    buildSourceUnitIndexForUnits(platformSourceRoots, immediatePlatformUnits));
  // Cache validation starts immediately and only waits for the idle gate on a
  // miss. An unchanged workspace can therefore restore its complete symbol
  // graph while Vallenta starts, without reparsing every Unit after each reload.
  const projectSourceIndexPromise = buildSourceUnitIndex(projectSourceRoots, {
    cachePath: projectSourceCachePath,
    buildGate: priorityPlatformIndexPromise
  }).then(index => {
    if (index.cacheHit) {
      output.appendLine(
        `Restored project source index cache: ${index.fileCount} files after ${index.cacheElapsedMs}ms.`
      );
    } else if (projectSourceCachePath) {
      output.appendLine(
        `Rebuilt project source index cache: ${index.fileCount} files after ${index.cacheElapsedMs}ms.`
      );
    }
    return index;
  });
  // The shared symbol index is later augmented with RAD/VCL sources. Global
  // navigator search must keep a project-only snapshot so "global" means the
  // current workspace/project graph, not the whole Delphi installation.
  const navigatorSourceIndexPromise = projectSourceIndexPromise.then(index => ({
    files: new Set(index.files),
    definitions: new Map([...index.definitions]
      .map(([key, definitions]) => [key, [...definitions]]))
  }));
  registerClassNavigator(
    context,
    output,
    undefined,
    buildDebugSupport.projectNavigator,
    navigatorSourceIndexPromise
  );
  const secondaryPlatformIndexPromise = projectSourceIndexPromise.then(() =>
    buildSourceUnitIndexForUnits(platformSourceRoots, secondaryPlatformUnits));
  const sourceIndexPromise = Promise.all([
    projectSourceIndexPromise,
    priorityPlatformIndexPromise
  ]).then(([index, priorityPlatformIndex]) => {
    mergeSourceUnitIndexes(index, priorityPlatformIndex);
    output.appendLine(
      `Current-file-first source index ready: ${index.fileCount} files, ${index.symbols.size} symbols, `
      + `${index.definitions.size} definitions (${priorityPlatformIndex.fileCount} priority RAD/VCL files).`
    );
    return index;
  });
  const startupSyncPromise = automaticPathSyncEnabled()
    ? Promise.all([maintenanceIdlePromise, startupProjectDiscoveryPromise])
      .then(() => enqueueSync(context))
    : Promise.resolve();
  const platformBuildGate = Promise.all([
    sourceIndexPromise,
    secondaryPlatformIndexPromise,
    startupSyncPromise
  ]);
  const platformIndexPromise = buildSourceUnitIndex(platformSourceRoots, {
    cachePath: platformSourceCachePath,
    buildGate: platformBuildGate
  }).then(index => {
    if (index.cacheHit) {
      output.appendLine(
        `Restored RAD/VCL source index cache: ${index.fileCount} files after ${index.cacheElapsedMs}ms.`
      );
    } else if (platformSourceCachePath) {
      output.appendLine(
        `Rebuilt RAD/VCL source index cache: ${index.fileCount} files after ${index.cacheElapsedMs}ms.`
      );
    }
    return index;
  });

  compiledSymbols = new CompiledSymbolSupport(
    context,
    sourceIndexPromise,
    platformSourceRoots,
    projectSourceRoots
  );
  compiledSymbols.register();
  new PascalReferenceSupport(
    context,
    projectSourceIndexPromise,
    output,
    compiledSymbols
  ).register();
  // Publish the small active-file platform indexes as soon as each is ready.
  // They must not sit behind the whole-project source scan, otherwise a newly
  // opened editor can remain only partially colored for several seconds.
  void Promise.all([priorityPlatformIndexPromise, secondaryPlatformIndexPromise])
    .then(([priorityIndex, secondaryIndex]) => {
      mergeSourceUnitIndexes(priorityIndex, secondaryIndex);
      compiledSymbols.appendSourceIndex(priorityIndex);
    })
    .catch(error => output.appendLine(`Active-file platform index failed: ${error.message}`));
  void indexIdlePromise.then(() => {
    if (vscode.window.activeTextEditor) {
      compiledSymbols.scheduleDecorate(vscode.window.activeTextEditor, 0);
    }
  });
  new UsesQuickFixSupport(context, compiledSymbols, sourceIndexPromise).register();
  void indexIdlePromise.then(() => compiledSymbols.initialize()).then(() => {
    const activeUri = vscode.window.activeTextEditor?.document.uri.toString();
    if (vscode.window.activeTextEditor) {
      compiledSymbols.warmCurrentDocument(vscode.window.activeTextEditor.document);
      compiledSymbols.scheduleDecorate(vscode.window.activeTextEditor, 0);
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== activeUri) compiledSymbols.scheduleDecorate(editor, 350);
    }
  }).catch(error => {
    output.appendLine(`Compiled symbol initialization failed; source navigation remains active: ${error.stack || error.message}`);
  });
  void sourceIndexPromise.catch(error => {
    output.appendLine(`Source symbol index initialization failed; compiled navigation remains active: ${error.stack || error.message}`);
  });
  void Promise.all([sourceIndexPromise, secondaryPlatformIndexPromise]).then(([index, secondaryIndex]) => {
    mergeSourceUnitIndexes(index, secondaryIndex);
    compiledSymbols.sourceIndexExpanded(index);
    output.appendLine(
      `Current-file secondary platform index appended: ${secondaryIndex.fileCount} files; `
      + `${index.fileCount} current-priority files total.`
    );
  }).catch(error => {
    output.appendLine(`Current-file secondary platform index failed: ${error.stack || error.message}`);
  });
  void Promise.all([sourceIndexPromise, platformIndexPromise]).then(async ([index, platformIndex]) => {
    await mergeSourceUnitIndexesAsync(index, platformIndex);
    compiledSymbols.sourceIndexExpanded(index);
    output.appendLine(
      `RAD/VCL source index appended in background: ${platformIndex.fileCount} files; `
      + `${index.fileCount} total files and ${index.definitions.size} definition keys.`
    );
  }).catch(error => {
    output.appendLine(`RAD/VCL background source index failed: ${error.stack || error.message}`);
  });
  context.subscriptions.push(vscode.commands.registerCommand(CommandId.Sync, async () => {
    output.show(true);
    await enqueueSync(context);
    vscode.window.showInformationMessage('Pascal Atlas paths synchronized.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand(CommandId.ProjectsDetect, async () => {
    output.show(true);
    const results = await detectAllWorkspaceProjectGroups({ force: true });
    await activateVallentaForProjectGroups(results);
    await enqueueSync(context);
    const groups = results.reduce((total, result) => total + result.discoveredGroups.length, 0);
    const added = results.reduce((total, result) => total + result.addedGroups.length, 0);
    vscode.window.showInformationMessage(
      `Pascal Atlas: Found ${groups} groupproj file(s); added ${added} to Vallenta.`
    );
  }));
  context.subscriptions.push(vscode.commands.registerCommand(CommandId.Restore, async () => {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      await restoreWorkspace(context, folder);
    }
    await restartLanguageServices();
    vscode.window.showInformationMessage('Pascal Atlas managed paths removed.');
  }));
  context.subscriptions.push(vscode.commands.registerCommand(CommandId.ShowPaths, async () => {
    output.show(true);
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const stateKey = `${MANAGED_PATHS_KEY}:${folder.uri.fsPath}`;
      const paths = asStringArray(context.workspaceState.get(stateKey, []));
      output.appendLine(`\n[${folder.name}] Managed paths (${paths.length}):`);
      for (const item of paths) {
        output.appendLine(`  ${item}`);
      }
    }
  }));
  context.subscriptions.push(vscode.commands.registerCommand(CommandId.GoToDefinition, async () => {
    await compiledSymbols.navigateToDefinition();
  }));
  context.subscriptions.push(vscode.commands.registerCommand(CommandId.PeekAllDefinitions, async () => {
    await compiledSymbols.navigateToAllDefinitions();
  }));

  for (const folder of vscode.workspace.workspaceFolders || []) {
    const patterns = [
      new vscode.RelativePattern(folder, '.vallenta/projects.json'),
      new vscode.RelativePattern(folder, '**/*.groupproj'),
      new vscode.RelativePattern(folder, '**/*.dproj')
    ];
    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      watcher.onDidCreate(() => scheduleSync(context));
      watcher.onDidChange(() => scheduleSync(context));
      watcher.onDidDelete(() => scheduleSync(context));
      context.subscriptions.push(watcher);
    }
  }

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('pascalAtlas.paths.enabled')
      && !event.affectsConfiguration('pascalAtlas.projectGroups.autoDetect')
      && !event.affectsConfiguration('pascalAtlas.projectGroups.activateFirstProject')
      && !event.affectsConfiguration('pascalAtlas.includeNestedSourceDirectories')
      && !event.affectsConfiguration('pascalAtlas.enabled')) return;
    scheduleSync(context);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('pascalAtlas.diagnostics.ignoreUtf8ConversionWarning')) return;
    void syncVallentaEncodingWarningSetting().catch(error => {
      output.appendLine(`Could not synchronize the UTF-8 conversion warning preference: ${error.message}`);
    });
  }));

}

function deactivate() {
  clearTimeout(debounceTimer);
  backgroundDiagnostics?.dispose();
}

export { activate, deactivate };
