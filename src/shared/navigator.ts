import { isRecord, isInteger } from './guards';
import type * as VSCode from 'vscode';
import type { AiStep, AiStepOptions, AiStepPrompt } from './ai';
import type { NavigatorOptions, NavigatorModel, NavigatorNode, NavigatorTarget } from './models';
export interface NavigatorDocument { uri: { fsPath?: string; toString(): string }; version: number; fileName: string; languageId: string; getText(): string; }
export interface AiSettings extends AiStepOptions { enabled: boolean; provider: string; modelId: string; reasoningEffort: string; normalTargetLines: number; detailedTargetLines: number; maxSteps: number; substepsEnabled: boolean; maxSubsteps: number; substepMinParentLines: number; maxDepth: number; maxSourceCharacters: number; requestTimeoutSeconds: number; cacheEnabled: boolean; skipCached: boolean; granularity: string; }
export interface AiRequest { document: NavigatorDocument; routine: NavigatorNode; text: string; key: string; settings: AiSettings; analysis: AiStepPrompt; reusedChunkCache?: boolean; onPartial?: (steps: AiStep[], result?: unknown) => unknown; }
export interface AiCacheEntry { documentUri: string; routine?: string; generatedAt: number; model?: string; settings?: AiStepOptions; steps: AiStep[]; }
export interface ModelCache { key: string | undefined; model: NavigatorModel; documentUri: string; retainedModel?: NavigatorModel; pending?: boolean; stale?: boolean; }
export interface NavigatorActiveState { id?: string; identity?: string; documentUri: string; }
export interface PendingAiSteps { startedAt: number; documentUri: string; routineIdentity: string; settings: AiSettings; partialSteps?: AiStep[]; }
export interface NavigatorWorkspaceState { get<T>(key: string, fallback: T): T; update(key: string, value: unknown): PromiseLike<void>; }
export interface NavigatorContext { workspaceState: NavigatorWorkspaceState; }
export interface NavigatorConfiguration { get<T>(key: string, fallback: T): T; }
export interface NavigatorEmitter { event(listener: (value: NavigatorNode | undefined) => unknown): VSCode.Disposable; fire(value: NavigatorNode | undefined): void; dispose(): void; }
export interface NavigatorApi { EventEmitter: new () => NavigatorEmitter; window?: { activeTextEditor?: { document: NavigatorDocument } }; workspace?: { getConfiguration(section?: string, uri?: unknown): NavigatorConfiguration }; TreeItemCollapsibleState?: typeof VSCode.TreeItemCollapsibleState; TreeItem?: typeof VSCode.TreeItem; ThemeColor?: typeof VSCode.ThemeColor; ThemeIcon?: typeof VSCode.ThemeIcon; }

export interface NavigatorWorkerRequest { text: string; filePath?: string; options?: NavigatorOptions; }
export type NavigatorWorkerResponse = { model: NavigatorModel; elapsedMs: number; error?: never } | { error: string; model?: never; elapsedMs?: never };
export function isAiStep(value: unknown): value is AiStep {
  return isRecord(value) && typeof value.title === 'string' && isInteger(value.line)
    && (value.children === undefined || (Array.isArray(value.children) && value.children.every(isAiStep)));
}
function isAiStepOptions(value: unknown): value is AiStepOptions {
  return isRecord(value) && (value.granularity === undefined || typeof value.granularity === 'string')
    && ['maxSteps', 'effectiveMaxSteps', 'maxSourceCharacters', 'maxSubsteps', 'substepMinParentLines', 'maxDepth', 'targetLinesPerStep'].every(key => value[key] === undefined || typeof value[key] === 'number')
    && (value.substepsEnabled === undefined || typeof value.substepsEnabled === 'boolean');
}
export function isAiCacheEntry(value: unknown): value is AiCacheEntry {
  return isRecord(value) && typeof value.documentUri === 'string' && typeof value.generatedAt === 'number'
    && (value.routine === undefined || typeof value.routine === 'string')
    && (value.model === undefined || typeof value.model === 'string')
    && (value.settings === undefined || isAiStepOptions(value.settings))
    && Array.isArray(value.steps) && value.steps.every(isAiStep);
}
export function isNavigatorWorkerRequest(value: unknown): value is NavigatorWorkerRequest {
  return isRecord(value) && typeof value.text === 'string'
    && (value.filePath === undefined || typeof value.filePath === 'string')
    && (value.options === undefined || isRecord(value.options));
}
function isNavigatorNode(value: unknown): value is NavigatorNode {
  return isRecord(value) && typeof value.id === 'string' && typeof value.kind === 'string'
    && typeof value.label === 'string' && Array.isArray(value.children);
}
export function isNavigatorWorkerResponse(value: unknown): value is NavigatorWorkerResponse {
  if (!isRecord(value)) return false;
  if (typeof value.error === 'string') return true;
  const model = value.model;
  return typeof value.elapsedMs === 'number' && isRecord(model) && typeof model.filePath === 'string'
    && ['roots', 'nodes', 'routineNodes', 'implementationNodes', 'declarationNodes', 'propertyNodes', 'typeNodes', 'sectionNodes', 'uses'].every(key => Array.isArray(model[key]) && model[key].every(isNavigatorNode))
    && Array.isArray(model.implementationRoutines);
}
