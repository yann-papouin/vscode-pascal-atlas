import { isRecord, isInteger } from "./guards"
import type * as VSCode from "vscode"
import type { AiStep, AiStepOptions, AiStepPrompt } from "./ai"
import type {
  NavigatorOptions,
  NavigatorModel,
  NavigatorNode,
  NavigatorTarget,
} from "./models"
export interface NavigatorDocument {
  uri: {
    fsPath?: string
    /** Serialize the document URI for navigation and cache identity. */
    toString(): string
  }
  version: number
  fileName: string
  languageId: string
  /** Read the current source text for navigation model construction. */
  getText(): string
}
export interface AiSettings extends AiStepOptions {
  enabled: boolean
  provider: string
  modelId: string
  reasoningEffort: string
  normalTargetLines: number
  detailedTargetLines: number
  maxSteps: number
  substepsEnabled: boolean
  maxSubsteps: number
  substepMinParentLines: number
  maxDepth: number
  maxSourceCharacters: number
  requestTimeoutSeconds: number
  cacheEnabled: boolean
  skipCached: boolean
  granularity: string
}
export interface AiRequest {
  document: NavigatorDocument
  routine: NavigatorNode
  text: string
  key: string
  settings: AiSettings
  analysis: AiStepPrompt
  reusedChunkCache?: boolean
  onPartial?: (steps: AiStep[], result?: unknown) => unknown
}
export interface AiCacheEntry {
  documentUri: string
  routine?: string
  generatedAt: number
  model?: string
  settings?: AiStepOptions
  steps: AiStep[]
}
export interface ModelCache {
  key: string | undefined
  model: NavigatorModel
  documentUri: string
  retainedModel?: NavigatorModel
  pending?: boolean
  stale?: boolean
}
export interface NavigatorActiveState {
  id?: string
  identity?: string
  documentUri: string
}
export interface PendingAiSteps {
  startedAt: number
  documentUri: string
  routineIdentity: string
  settings: AiSettings
  partialSteps?: AiStep[]
}
export interface NavigatorWorkspaceState {
  /** Read a persisted or configured value with a fallback for missing keys. */
  get<T>(key: string, fallback: T): T
  /** Persist navigator state for the current workspace. */
  update(key: string, value: unknown): PromiseLike<void>
}
export interface NavigatorContext {
  workspaceState: NavigatorWorkspaceState
}
export interface NavigatorConfiguration {
  /** Read a persisted or configured value with a fallback for missing keys. */
  get<T>(key: string, fallback: T): T
}
export interface NavigatorEmitter {
  /**
   * Subscribe to navigator change notifications and return a disposable subscription.
   */
  event(listener: (value: NavigatorNode | undefined) => unknown): VSCode.Disposable
  /** Notify listeners that one node or the complete navigation tree changed. */
  fire(value: NavigatorNode | undefined): void
  /** Release event listeners owned by this navigator emitter. */
  dispose(): void
}
export interface NavigatorApi {
  EventEmitter: new () => NavigatorEmitter
  window?: { activeTextEditor?: { document: NavigatorDocument } }
  workspace?: {
    /** Read navigator configuration scoped to the optional resource. */
    getConfiguration(section?: string, uri?: unknown): NavigatorConfiguration
  }
  TreeItemCollapsibleState?: typeof VSCode.TreeItemCollapsibleState
  TreeItem?: typeof VSCode.TreeItem
  ThemeColor?: typeof VSCode.ThemeColor
  ThemeIcon?: typeof VSCode.ThemeIcon
}

export interface NavigatorWorkerRequest {
  text: string
  filePath?: string
  options?: NavigatorOptions
}
export type NavigatorWorkerResponse =
  | { model: NavigatorModel; elapsedMs: number; error?: never }
  | { error: string; model?: never; elapsedMs?: never }
/**
 * Validate a titled, integer-line AI step recursively, including optional nested
 * substeps.
 */
export function isAiStep(value: unknown): value is AiStep {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    isInteger(value.line) &&
    (value.children === undefined ||
      (Array.isArray(value.children) && value.children.every(isAiStep)))
  )
}
/**
 * Validate the optional numeric, boolean, and granularity fields restored with an AI
 * planning cache entry.
 */
function isAiStepOptions(value: unknown): value is AiStepOptions {
  return (
    isRecord(value) &&
    (value.granularity === undefined || typeof value.granularity === "string") &&
    [
      "maxSteps",
      "effectiveMaxSteps",
      "maxSourceCharacters",
      "maxSubsteps",
      "substepMinParentLines",
      "maxDepth",
      "targetLinesPerStep",
    ].every(
      /** Accept absent AI limits and require each supplied limit to be numeric. */ (
        key,
      ) => value[key] === undefined || typeof value[key] === "number",
    ) &&
    (value.substepsEnabled === undefined || typeof value.substepsEnabled === "boolean")
  )
}
/**
 * Validate persisted routine-step data and settings before reusing labels for a
 * document.
 */
export function isAiCacheEntry(value: unknown): value is AiCacheEntry {
  return (
    isRecord(value) &&
    typeof value.documentUri === "string" &&
    typeof value.generatedAt === "number" &&
    (value.routine === undefined || typeof value.routine === "string") &&
    (value.model === undefined || typeof value.model === "string") &&
    (value.settings === undefined || isAiStepOptions(value.settings)) &&
    Array.isArray(value.steps) &&
    value.steps.every(isAiStep)
  )
}
/**
 * Require source text and optional path/options records before building a navigation
 * model in a worker.
 */
export function isNavigatorWorkerRequest(
  value: unknown,
): value is NavigatorWorkerRequest {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    (value.filePath === undefined || typeof value.filePath === "string") &&
    (value.options === undefined || isRecord(value.options))
  )
}
/**
 * Check the basic identity, display, and child-container shape of a transferred
 * navigation node.
 */
function isNavigatorNode(value: unknown): value is NavigatorNode {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.kind === "string" &&
    typeof value.label === "string" &&
    Array.isArray(value.children)
  )
}
/**
 * Recognize an error reply or validate the model envelope and top-level node
 * collections before adopting a worker result.
 */
export function isNavigatorWorkerResponse(
  value: unknown,
): value is NavigatorWorkerResponse {
  if (!isRecord(value)) return false
  if (typeof value.error === "string") return true
  const model = value.model
  return (
    typeof value.elapsedMs === "number" &&
    isRecord(model) &&
    typeof model.filePath === "string" &&
    [
      "roots",
      "nodes",
      "routineNodes",
      "implementationNodes",
      "declarationNodes",
      "propertyNodes",
      "typeNodes",
      "sectionNodes",
      "uses",
    ].every(
      /** Require every transferred node collection to contain valid navigator nodes. */ (
        key,
      ) => Array.isArray(model[key]) && model[key].every(isNavigatorNode),
    ) &&
    Array.isArray(model.implementationRoutines)
  )
}
