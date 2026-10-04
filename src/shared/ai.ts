import type { NavigatorTarget } from "./models"
export interface AiStep {
  title: string
  line: number
  children?: AiStep[]
}
export interface LineRange {
  startLine: number
  endLine: number
}
export interface RoutineSourceRange extends LineRange {
  startOffset: number
  endOffset: number
}
export interface AiStepOptions {
  granularity?: string
  maxSteps?: number
  effectiveMaxSteps?: number
  maxSourceCharacters?: number
  substepsEnabled?: boolean
  maxSubsteps?: number
  substepMinParentLines?: number
  maxDepth?: number
  targetLinesPerStep?: number
  chunkLabelCache?: Map<string, string> | Record<string, string>
}
export interface PlannedCodeLine {
  raw: string
  code: string
  index: number
  line: number
  meaningful: boolean
  safeBoundary: boolean
}
export interface PlannedStep {
  id: string
  kind: "leaf" | "group"
  line: number
  endLine: number
  meaningfulLines?: number
  codeLines: PlannedCodeLine[]
  source?: string
  children: string[]
  hash: string
  fallbackTitle?: string
}
export interface DetailedStepPlan {
  protocol: string
  targetLines: number
  minLines: number
  maxLines: number
  leaves: PlannedStep[]
  nodes: PlannedStep[]
  roots: string[]
  maxDepth: number
}
export interface AiStepAnalysis extends LineRange, AiStepOptions {
  fixedPlan?: DetailedStepPlan
  cachedLabels?: Record<string, string>
  unresolvedIds?: string[]
}
export interface RoutineAnalysisContext extends RoutineSourceRange {
  truncated: boolean
  numberedSource: string
}
export interface AiStepPrompt extends RoutineAnalysisContext, AiStepAnalysis {
  prompt: string
  meaningfulLineCount: number
  targetLinesPerStep: number
  effectiveMaxSteps: number
  granularity: string
  substepsEnabled: boolean
  maxSubsteps: number
  maxDepth: number
  substepMinParentLines: number
}
export interface AiStepResponseResult {
  planned?: boolean
  steps: AiStep[]
  labels?: Record<string, string>
  modelLabels?: Record<string, string>
  missingIds?: string[]
  validLabelCount?: number
  responseLength?: number
}
export interface AiBatchRequest {
  routine: NavigatorTarget
  analysis?: AiStepPrompt
}
export interface AiBatchEntry {
  id: string
  request: AiBatchRequest & { analysis: AiStepPrompt }
}
export interface AiBatchPrompt {
  entries: AiBatchEntry[]
  prompt: string
}
