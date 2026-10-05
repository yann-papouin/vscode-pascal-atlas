import { NavigatorStateKey } from "./shared/navConstants"
import { inList } from "./shared/guards"
import type {
  AiStep,
  AiStepOptions,
  RoutineAnalysisContext,
  RoutineSourceRange,
  AiStepAnalysis,
  AiStepPrompt,
  DetailedStepPlan,
  PlannedStep,
  AiStepResponseResult,
  AiBatchRequest,
  AiBatchPrompt,
  AiBatchEntry,
  LineRange,
} from "./shared/ai"
import type { NavigatorTarget, NavigatorNode } from "./shared/models"
import { isInteger, isRecord } from "./shared/guards"
import { PascalKeyword } from "./shared/pascal"
import { createHash } from "node:crypto"

const AI_STEP_CACHE_STATE_KEY = NavigatorStateKey.AiSteps
const AI_STEP_CHUNK_CACHE_STATE_KEY = NavigatorStateKey.AiStepChunks
const AI_STEP_PROMPT_VERSION = 8
const DEFAULT_MAX_SOURCE_CHARACTERS = 24000

/** Narrow response values to object records before reading their fields. */
function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined
}

/** Find the beginning of the source line containing a UTF-16 offset. */
function lineStartOffset(text: string, offset: number) {
  return Math.max(0, text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1)
}

/**
 * Convert a UTF-16 offset to the one-based source line numbering sent to
 * language-model providers.
 */
function lineNumberAt(text: string, offset: number) {
  let line = 1
  for (let index = 0; index < Math.min(text.length, Math.max(0, offset)); index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

/**
 * Convert a one-based source line to its original UTF-16 offset, clamping before the
 * first line or beyond the document.
 */
function offsetAtLine(text: string, oneBasedLine: number) {
  if (oneBasedLine <= 1) return 0
  let line = 1
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue
    line += 1
    if (line === oneBasedLine) return index + 1
  }
  return text.length
}

/**
 * Resolve a routine's implemented source range and meaningful line bounds, excluding
 * trailing whitespace from its last navigable line.
 */
function routineSourceRange(text: string, node: NavigatorTarget) {
  if (!isInteger(node?.implementationOffset)) return undefined
  const startOffset = lineStartOffset(text, node.implementationOffset)
  const rawEnd = isInteger(node.implementationEndOffset)
    ? node.implementationEndOffset
    : text.length
  const endOffset = Math.max(startOffset, Math.min(text.length, rawEnd))
  let meaningfulEndOffset = endOffset
  while (
    meaningfulEndOffset > startOffset &&
    /\s/.test(text[meaningfulEndOffset - 1])
  ) {
    meaningfulEndOffset -= 1
  }
  return {
    startOffset,
    endOffset,
    startLine: lineNumberAt(text, startOffset),
    endLine: lineNumberAt(text, Math.max(startOffset, meaningfulEndOffset - 1)),
  }
}

/**
 * Fingerprint routine identity, source content, prompt version, and planning settings
 * so cached steps are reused only for compatible analyses.
 */
function routineAnalysisKey(
  documentUri: string,
  text: string,
  node: NavigatorTarget,
  options: AiStepOptions = {},
) {
  const range = routineSourceRange(text, node)
  if (!range) return undefined
  const identity = [
    node.owner || "global",
    node.name || node.label || "",
    node.signature || "",
  ]
    .join("|")
    .toLowerCase()
  const sourceHash = createHash("sha256")
    .update(text.slice(range.startOffset, range.endOffset))
    .digest("hex")
    .slice(0, 20)
  const granularity = inList(options.granularity, ["balanced", "detailed"])
    ? options.granularity
    : "coarse"
  const strategy = [
    granularity,
    Math.max(1, Math.min(12, Number(options.maxSteps) || 5)),
    Math.max(
      2000,
      Number(options.maxSourceCharacters) || DEFAULT_MAX_SOURCE_CHARACTERS,
    ),
    options.substepsEnabled === false ? "flat" : "nested",
    Math.max(2, Math.min(8, Number(options.maxSubsteps) || 5)),
    Math.max(6, Math.min(100, Number(options.substepMinParentLines) || 30)),
    Math.max(2, Math.min(5, Number(options.maxDepth) || 3)),
    Math.max(6, Math.min(50, Number(options.targetLinesPerStep) || 20)),
  ].join(":")
  return `v${AI_STEP_PROMPT_VERSION}|${strategy}|${documentUri}|${identity}|${sourceHash}`
}

/**
 * Build numbered routine source within the character budget, retaining real head/tail
 * line numbers when truncation is required.
 */
function buildRoutineAnalysisContext(
  text: string,
  node: NavigatorTarget,
  maxSourceCharacters = DEFAULT_MAX_SOURCE_CHARACTERS,
): RoutineAnalysisContext | undefined {
  const range = routineSourceRange(text, node)
  if (!range) return undefined
  const completeSource = text.slice(range.startOffset, range.endOffset)
  const limit = Math.max(
    2000,
    Number(maxSourceCharacters) || DEFAULT_MAX_SOURCE_CHARACTERS,
  )
  const lines = completeSource.split(/\r?\n/)
  /**
   * Prefix a source line with its original padded one-based line number for stable
   * provider-to-editor references.
   */
  const numberedLine = (line: string, index: number) =>
    `[${String(range.startLine + index).padStart(5, "0")}] ${line}`
  let truncated = false
  let numberedSource
  if (completeSource.length <= limit) {
    numberedSource = lines.map(numberedLine).join("\n")
  } else {
    truncated = true
    const headBudget = Math.floor(limit * 0.72)
    const tailBudget = Math.floor(limit * 0.28)
    let headEnd = 0
    let headSize = 0
    while (
      headEnd < lines.length &&
      headSize + lines[headEnd].length + 1 <= headBudget
    ) {
      headSize += lines[headEnd].length + 1
      headEnd += 1
    }
    let tailStart = lines.length
    let tailSize = 0
    while (
      tailStart > headEnd &&
      tailSize + lines[tailStart - 1].length + 1 <= tailBudget
    ) {
      tailStart -= 1
      tailSize += lines[tailStart].length + 1
    }
    numberedSource = [
      ...lines
        .slice(0, headEnd)
        .map(
          /** Number retained leading lines from the routine's original start line. */ (
            line: string,
            index: number,
          ) => numberedLine(line, index),
        ),
      "{ ... middle section omitted due to length limit ... }",
      ...lines.slice(tailStart).map(
        /**
         * Number retained trailing lines using their original positions, including the
         * omitted middle.
         */ (line: string, index: number) => numberedLine(line, tailStart + index),
      ),
    ].join("\n")
  }
  return {
    ...range,
    truncated,
    numberedSource,
  }
}

/**
 * Remove comments/string contents while carrying lexical state across lines to
 * identify meaningful safe step boundaries.
 */
function compactPascalLine(
  line: string,
  state: { comment: string; string: boolean; parentheses?: number; brackets?: number },
) {
  let result = ""
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    const next = line[index + 1]
    if (state.comment === "brace") {
      if (character === "}") state.comment = ""
      continue
    }
    if (state.comment === "paren") {
      if (character === "*" && next === ")") {
        state.comment = ""
        index += 1
      }
      continue
    }
    if (state.string) {
      if (character === "'" && next === "'") {
        index += 1
      } else if (character === "'") {
        state.string = false
      }
      result += " "
      continue
    }
    if (character === "/" && next === "/") break
    if (character === "{") {
      state.comment = "brace"
      continue
    }
    if (character === "(" && next === "*") {
      state.comment = "paren"
      index += 1
      continue
    }
    if (character === "'") {
      state.string = true
      result += " "
      continue
    }
    result += character
  }
  return result.trim()
}

/**
 * Partition ordered entries into up to the requested number of nonempty, roughly equal
 * contiguous groups.
 */
function balancedPartitions<T>(items: T[], count: number): T[][] {
  const result = []
  let offset = 0
  for (let index = 0; index < count; index += 1) {
    const remaining = items.length - offset
    const partitions = count - index
    const size = Math.ceil(remaining / partitions)
    result.push(items.slice(offset, offset + size))
    offset += size
  }
  return result.filter(
    /**
     * Discard empty partitions when fewer entries than requested groups are available.
     */ (part) => part.length > 0,
  )
}

/**
 * Choose a deterministic functional label from a planned group or its first meaningful
 * Pascal control statement.
 */
function fallbackPlannedTitle(
  node: { kind: string; codeLines: Array<{ code: string }> },
  index: number,
) {
  if (node.kind === "group") return `Organize functional phase ${index + 1}`
  const first =
    node.codeLines.find(
      /** Find the first nonempty code line to choose a local fallback title. */ (
        line,
      ) => line.code,
    )?.code || ""
  if (new RegExp(String.raw`^${PascalKeyword.If}\b`, "i").test(first))
    return "Evaluate condition"
  if (
    new RegExp(
      String.raw`^(?:${PascalKeyword.For}|${PascalKeyword.While}|${PascalKeyword.Repeat})\b`,
      "i",
    ).test(first)
  )
    return "Iterate over data"
  if (new RegExp(String.raw`^${PascalKeyword.Case}\b`, "i").test(first))
    return "Handle conditional branches"
  if (
    new RegExp(
      String.raw`^(?:${PascalKeyword.Try}|${PascalKeyword.Except}|${PascalKeyword.Finally})\b`,
      "i",
    ).test(first)
  )
    return "Handle exceptions"
  if (new RegExp(String.raw`^${PascalKeyword.Result}\s*:=`, "i").test(first))
    return "Prepare and return result"
  if (
    new RegExp(
      String.raw`^(?:${PascalKeyword.Exit}|${PascalKeyword.Break}|${PascalKeyword.Continue})\b`,
      "i",
    ).test(first)
  )
    return "End current operation"
  return `Process code block ${index + 1}`
}

/**
 * Partition complete routine source into bounded blocks and hierarchy, preferring safe
 * split points; truncated source cannot provide a fixed plan.
 */
function buildDetailedStepPlan(
  text: string,
  context: RoutineAnalysisContext | undefined,
  options: AiStepOptions = {},
): DetailedStepPlan | undefined {
  // A fixed detailed partition needs the complete routine; head/tail prompt truncation cannot safely own the omitted source boundaries.
  if (!context || context.truncated) return undefined
  const targetLines = Math.max(
    6,
    Math.min(30, Number(options.targetLinesPerStep) || 10),
  )
  const minLines = Math.max(4, Math.floor(targetLines * 0.7))
  const maxLines = Math.max(targetLines + 3, Math.ceil(targetLines * 1.4))
  const maxSubsteps = Math.max(2, Math.min(8, Number(options.maxSubsteps) || 6))
  const maxDepth = Math.max(2, Math.min(5, Number(options.maxDepth) || 3))
  const maxRoots = Math.max(2, Math.min(12, Number(options.maxSteps) || 8))
  const source = text.slice(context.startOffset, context.endOffset)
  const rawLines = source.split(/\r?\n/)
  const state = { comment: "", string: false, parentheses: 0, brackets: 0 }
  const codeLines = rawLines.map(
    /**
     * Track meaningful code and balanced delimiters to identify safe line boundaries.
     */ (raw: string, index: number) => {
      const code = compactPascalLine(raw, state)
      for (const character of code) {
        if (character === "(") state.parentheses += 1
        else if (character === ")")
          state.parentheses = Math.max(0, state.parentheses - 1)
        else if (character === "[") state.brackets += 1
        else if (character === "]") state.brackets = Math.max(0, state.brackets - 1)
      }
      const safeBoundary =
        state.parentheses === 0 &&
        state.brackets === 0 &&
        (/;\s*$/.test(code) ||
          new RegExp(String.raw`^${PascalKeyword.End}\b[.;]?\s*$`, "i").test(code))
      return {
        raw,
        code,
        index,
        line: context.startLine + index,
        meaningful: code.length > 0,
        safeBoundary,
      }
    },
  )
  const meaningful = codeLines.filter(
    /**
     * Retain code-bearing lines for partition sizing without losing their original line
     * indices.
     */ (line) => line.meaningful,
  )
  if (!meaningful.length) return undefined

  const leafRanges: Array<[number, number]> = []
  let startMeaningful = 0
  while (startMeaningful < meaningful.length) {
    const remaining = meaningful.length - startMeaningful
    if (remaining <= maxLines || (leafRanges.length > 0 && remaining < minLines)) {
      leafRanges.push([startMeaningful, meaningful.length - 1])
      break
    }
    const targetEnd = Math.min(meaningful.length - 1, startMeaningful + targetLines - 1)
    const maximumEnd = Math.min(meaningful.length - 1, startMeaningful + maxLines - 1)
    const minimumEnd = Math.min(maximumEnd, startMeaningful + minLines - 1)
    let end = -1
    for (let index = targetEnd; index <= maximumEnd; index += 1) {
      if (meaningful[index].safeBoundary) {
        end = index
        break
      }
    }
    if (end < 0) {
      for (let index = targetEnd - 1; index >= minimumEnd; index -= 1) {
        if (meaningful[index].safeBoundary) {
          end = index
          break
        }
      }
    }
    if (end < 0) {
      end = maximumEnd
      while (
        end + 1 < meaningful.length &&
        !meaningful[end].safeBoundary &&
        end - startMeaningful + 1 < maxLines * 2
      )
        end += 1
    }
    leafRanges.push([startMeaningful, end])
    startMeaningful = end + 1
  }

  if (leafRanges.length > 1) {
    const last = leafRanges[leafRanges.length - 1]
    if (last[1] - last[0] + 1 < minLines) {
      leafRanges[leafRanges.length - 2][1] = last[1]
      leafRanges.pop()
    }
  }

  const nodes = new Map<string, PlannedStep>()
  const leaves = leafRanges.map(
    /**
     * Create a leaf block spanning its meaningful lines and the intervening source text.
     */ (range, index) => {
      const first = meaningful[range[0]]
      const last = meaningful[range[1]]
      const nextFirst = leafRanges[index + 1]
        ? meaningful[leafRanges[index + 1][0]]
        : undefined
      const startIndex = first.index
      const endIndex = nextFirst
        ? Math.max(startIndex, nextFirst.index - 1)
        : rawLines.length - 1
      const chunkSource = rawLines.slice(startIndex, endIndex + 1).join("\n")
      const node: PlannedStep = {
        id: `c${String(index + 1).padStart(2, "0")}`,
        kind: "leaf",
        line: first.line,
        endLine: context.startLine + endIndex,
        meaningfulLines: range[1] - range[0] + 1,
        codeLines: codeLines.slice(startIndex, endIndex + 1),
        source: chunkSource,
        children: [],
        hash: createHash("sha256")
          .update(`leaf\n${chunkSource}`)
          .digest("hex")
          .slice(0, 24),
      }
      nodes.set(node.id, node)
      return node
    },
  )

  let level: PlannedStep[] = leaves
  let depth = 1
  while (level.length > maxRoots && depth < maxDepth) {
    const minimumParents = Math.ceil(level.length / maxSubsteps)
    const desiredParents = Math.max(
      minimumParents,
      Math.min(maxRoots, Math.floor(level.length / 2)),
    )
    const groups = balancedPartitions(level, desiredParents).map(
      /**
       * Group adjacent blocks under a parent whose range and hash derive from its
       * children.
       */ (children, index) => {
        const node: PlannedStep = {
          id: `g${depth}_${String(index + 1).padStart(2, "0")}`,
          kind: "group",
          line: children[0].line,
          endLine: children[children.length - 1].endLine,
          children: children.map(
            /**
             * Store child IDs so the fixed hierarchy remains independent of provider
             * output.
             */ (child) => child.id,
          ),
          codeLines: [],
          hash: createHash("sha256")
            .update(
              `group\n${children
                .map(
                  /**
                   * Hash child blocks in order so a changed child invalidates its parent's
                   * cached label.
                   */ (child) => child.hash,
                )
                .join("\n")}`,
            )
            .digest("hex")
            .slice(0, 24),
        }
        nodes.set(node.id, node)
        return node
      },
    )
    level = groups
    depth += 1
  }
  for (const [index, node] of [...nodes.values()].entries()) {
    node.fallbackTitle = fallbackPlannedTitle(node, index)
  }
  return {
    protocol: "fixed-chunks-v1",
    targetLines,
    minLines,
    maxLines,
    leaves,
    nodes: [...nodes.values()],
    roots: level.map(
      /** Record the current top-level blocks as the plan's roots. */ (node) => node.id,
    ),
    maxDepth: depth,
  }
}

/**
 * Reuse validated hash-based labels and request only unresolved fixed-plan IDs while
 * keeping line ranges and hierarchy under parser control.
 */
function plannedPrompt(
  plan: DetailedStepPlan,
  context: RoutineAnalysisContext,
  signature: string,
  cachedLabels: Map<string, string> | Record<string, string> = new Map(),
) {
  const labels: Record<string, string> = {}
  for (const node of plan.nodes) {
    const cached =
      cachedLabels instanceof Map
        ? cachedLabels.get(node.hash)
        : cachedLabels?.[node.hash]
    if (cached) labels[node.id] = normalizeStepTitle(cached)
  }
  const unresolved = plan.nodes.filter(
    /** Select fixed blocks that still need a provider-supplied label. */ (node) =>
      !labels[node.id],
  )
  const descriptions = plan.nodes.map(
    /** Describe each block's fixed range, children, and any reusable label. */ (
      node,
    ) =>
      node.kind === "leaf"
        ? `${node.id}: lines ${node.line}-${node.endLine}${labels[node.id] ? `, existing title "${labels[node.id]}"` : ""}`
        : `${node.id}: lines ${node.line}-${node.endLine}, includes ${node.children.join(", ")}${labels[node.id] ? `, existing title "${labels[node.id]}"` : ""}`,
  )
  const sources = plan.leaves
    .filter(
      /** Send source only for leaf blocks whose labels are not cached. */ (node) =>
        !labels[node.id],
    )
    .map(
      /**
       * Format an unlabeled leaf's ID, original line range, and source for the prompt.
       */ (node) => `--- ${node.id} [${node.line}-${node.endLine}] ---\n${node.source}`,
    )
  return {
    cachedLabels: labels,
    unresolvedIds: unresolved.map(
      /** Record the exact block IDs the response must label. */ (node) => node.id,
    ),
    prompt: [
      "You are a Delphi/Object Pascal code navigation assistant.",
      `The local parser has divided function ${signature} into fixed code blocks of about ${plan.targetLines} lines.`,
      "Boundaries and hierarchy are fixed. Do not repartition, merge, omit, or change any IDs.",
      "Write a concise, clear English functional title only for IDs that do not already have one. Leaf titles describe the block; parent titles summarize their children.",
      "Do not number titles. Keep each title under 8 words. Do not explain.",
      `Return all ${unresolved.length} IDs below. Output one complete JSON object per line, without an array, Markdown, or code fences:`,
      '{"id":"c01","title":"Validate input parameters"}',
      '{"id":"g1_01","title":"Prepare grouped data"}',
      "",
      "Fixed structure:",
      ...descriptions,
      "",
      "Code blocks to analyze:",
      ...sources,
    ].join("\n"),
  }
}

/**
 * Build a routine analysis prompt with bounded granularity/substep settings, fixed
 * detailed plans when possible, and compatible cached labels.
 */
function buildAiStepPrompt(
  text: string,
  node: NavigatorTarget,
  options: AiStepOptions = {},
): AiStepPrompt | undefined {
  const context = buildRoutineAnalysisContext(text, node, options.maxSourceCharacters)
  if (!context) return undefined
  const configuredMaxSteps = Math.max(1, Math.min(12, Number(options.maxSteps) || 5))
  const granularity = inList(options.granularity, ["balanced", "detailed"])
    ? options.granularity
    : "coarse"
  const substepsEnabled = options.substepsEnabled !== false
  const maxSubsteps = Math.max(2, Math.min(8, Number(options.maxSubsteps) || 5))
  const maxDepth = Math.max(2, Math.min(5, Number(options.maxDepth) || 3))
  const substepMinParentLines = Math.max(
    6,
    Math.min(100, Number(options.substepMinParentLines) || 30),
  )
  const targetLinesPerStep = Math.max(
    6,
    Math.min(
      50,
      Number(options.targetLinesPerStep) || (granularity === "detailed" ? 10 : 20),
    ),
  )
  const source = text.slice(context.startOffset, context.endOffset)
  const meaningfulLineCount = source.split(/\r?\n/).filter(
    /**
     * Count nonblank source lines to bound the number of requested functional steps.
     */ (line) => line.trim().length > 0,
  ).length
  // A hard density ceiling prevents a model from turning every branch or call
  // into a navigation item. Small routines intentionally collapse to one step.
  // Detailed output stays hierarchical: top-level phases remain broad while
  // recursive leaves approach the configured reading granularity.
  const linesPerStep =
    granularity === "detailed"
      ? Math.max(24, targetLinesPerStep * 3)
      : targetLinesPerStep
  const effectiveMaxSteps = Math.min(
    configuredMaxSteps,
    Math.max(1, Math.ceil(meaningfulLineCount / linesPerStep)),
  )
  if (granularity === "detailed") {
    const fixedPlan = buildDetailedStepPlan(text, context, {
      ...options,
      maxSteps: effectiveMaxSteps,
      targetLinesPerStep,
    })
    if (fixedPlan) {
      const fixedPrompt = plannedPrompt(
        fixedPlan,
        context,
        node.signature ||
          `${node.owner ? `${node.owner}.` : ""}${node.name || node.label}`,
        options.chunkLabelCache,
      )
      return {
        ...context,
        meaningfulLineCount,
        targetLinesPerStep,
        effectiveMaxSteps,
        granularity: granularity || "coarse",
        substepsEnabled,
        maxSubsteps,
        maxDepth,
        substepMinParentLines,
        fixedPlan,
        cachedLabels: fixedPrompt.cachedLabels,
        unresolvedIds: fixedPrompt.unresolvedIds,
        prompt: fixedPrompt.prompt,
      }
    }
  }
  const granularityRules =
    granularity === "coarse"
      ? [
          "Identify only top-level functional phases; do not summarize statement by statement.",
          "Combine adjacent parameter validation, variable preparation, assignments, function calls, and result handling into larger functional blocks.",
          "A single if/for statement, assignment, function call, or comment title should not be a step unless it serves an independent business purpose.",
          "Each step should cover a continuous implementation segment with a clear purpose. Usually include a dozen or more lines of meaningful code; short routines may return just one step.",
          "Do not split code to reach the maximum step count. Prefer fewer steps that express the complete functional phases.",
        ]
      : granularity === "detailed"
        ? [
            "Identify business phases, data transformations, loops, important branches, state changes, and result handling without summarizing statement by statement.",
            `Break complex parent steps into smaller continuous functional blocks; target about ${targetLinesPerStep} lines of meaningful code for the smallest leaf steps.`,
            "Do not make second-level steps overly broad: if they still contain multiple loops, branches, or state changes, add children recursively using the same granularity at every level.",
            "For long, complex routines with nested loops, branches, or state changes, do not return only flat top-level steps. At least one complex top-level step must have two or more children, and complex children must be refined recursively.",
            "A simple assignment, condition, or single function call should not be a step on its own.",
          ]
        : [
            "Summarize meaningful implementation phases. Do not mechanically turn a single assignment or function call into a step.",
            "Combine adjacent statements that serve the same purpose.",
          ]
  return {
    ...context,
    meaningfulLineCount,
    targetLinesPerStep,
    effectiveMaxSteps,
    granularity: granularity || "coarse",
    substepsEnabled,
    maxSubsteps,
    maxDepth,
    substepMinParentLines,
    prompt: [
      "You are a Delphi/Object Pascal code navigation assistant.",
      "Summarize this routine as concise, clear English functional steps in execution order.",
      ...granularityRules,
      `Return at most ${effectiveMaxSteps} steps. Do not number titles; keep each under 8 words. Do not explain.`,
      substepsEnabled
        ? `If a step is expected to cover at least ${substepMinParentLines} lines and contains multiple independently navigable phases, add children recursively; use at most ${maxSubsteps} per level and ${maxDepth} levels.`
        : "",
      substepsEnabled
        ? "Do not add children to simple steps or split a single condition, assignment, or call into a substep."
        : "",
      "Each step line must match the bracketed line number where that step actually begins in the provided source.",
      "Output strict JSON only, without Markdown or code fences:",
      substepsEnabled
        ? '{"steps":[{"title":"Process input data","line":42,"children":[{"title":"Validate input","line":43},{"title":"Build groups","line":68,"children":[{"title":"Create index","line":70}]}]}]}'
        : '{"steps":[{"title":"Validate input parameters","line":42}]}',
      context.truncated
        ? "The source is too long and its middle section was omitted. Create reliably navigable steps only for visible code."
        : "",
      "",
      `Routine: ${node.signature || `${node.owner ? `${node.owner}.` : ""}${node.name || node.label}`}`,
      context.numberedSource,
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

/**
 * Combine source-bearing routine analyses into one correlated prompt with each
 * routine's original line numbers and step limits.
 */
function buildBatchAiStepPrompt(requests: AiBatchRequest[]): AiBatchPrompt | undefined {
  const entries = (requests || [])
    .filter(
      /**
       * Keep requests with source-bearing analyses that can be included in the batch.
       */ (request): request is AiBatchRequest & { analysis: AiStepPrompt } =>
        !!request.analysis?.numberedSource,
    )
    .map(
      /**
       * Assign a batch-local ID that correlates each response with its routine request.
       */ (request, index: number) => ({ id: `r${index + 1}`, request }),
    )
  if (!entries.length) return undefined
  const first = entries[0].request.analysis
  const detailed = first.granularity === "detailed"
  const routineBlocks = entries.map(
    /**
     * Include the routine identity, step budget, and numbered source under its batch ID.
     */ ({ id, request }) =>
      [
        `--- ${id} ---`,
        `Routine: ${request.routine.signature || `${request.routine.owner ? `${request.routine.owner}.` : ""}${request.routine.name || request.routine.label}`}`,
        `At most ${request.analysis.effectiveMaxSteps} top-level steps.`,
        request.analysis.numberedSource,
      ].join("\n"),
  )
  return {
    entries,
    prompt: [
      "You are a Delphi/Object Pascal code navigation assistant.",
      `Process all ${entries.length} routines below in one request. For each, create concise, clear English functional steps in execution order.`,
      "Return exactly one result for every ID. Do not omit, merge, or change IDs.",
      detailed
        ? "Identify business phases, data transformations, loops, and important branches. Refine complex phases recursively without summarizing statement by statement."
        : "Identify only phases with an independent business purpose. Do not mechanically turn a single condition, assignment, call, or few lines of code into a step.",
      "Do not number step titles; keep each under 8 words. The line must be the bracketed line number where the step actually begins in the provided source.",
      first.substepsEnabled
        ? `Complex steps may have children recursively, with at most ${first.maxSubsteps} per level and ${first.maxDepth} levels. Do not add children to simple steps.`
        : "Do not generate children.",
      "Output strict JSON only, without Markdown or code fences:",
      '{"routines":[{"id":"r1","steps":[{"title":"Validate input","line":42},{"title":"Process data","line":55,"children":[{"title":"Build index","line":57}]}]}]}',
      "",
      ...routineBlocks,
    ].join("\n\n"),
  }
}

/**
 * Extract a likely fenced or outer JSON object/array from provider text, falling back
 * to the trimmed response.
 */
function jsonCandidate(value: string) {
  const text = String(value || "").trim()
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const candidate = fenced || text
  const objectStart = candidate.indexOf("{")
  const objectEnd = candidate.lastIndexOf("}")
  if (objectStart >= 0 && objectEnd > objectStart)
    return candidate.slice(objectStart, objectEnd + 1)
  const arrayStart = candidate.indexOf("[")
  const arrayEnd = candidate.lastIndexOf("]")
  if (arrayStart >= 0 && arrayEnd > arrayStart)
    return candidate.slice(arrayStart, arrayEnd + 1)
  return candidate
}

/**
 * Collect distinct fenced, balanced, and streamed JSON candidates so reasoning text or
 * partial trailing output does not discard otherwise usable labels.
 */
function jsonCandidates(value: unknown) {
  const text = String(value || "").trim()
  const candidates: string[] = []
  /**
   * Retain one nonempty normalized JSON candidate without repeating an already tried
   * response fragment.
   */
  const add = (candidate: string) => {
    const normalized = String(candidate || "").trim()
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized)
  }
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) add(match[1])
  add(text)
  add(jsonCandidate(text))

  // Compatible providers may prepend reasoning or append another object.
  // Extract balanced JSON values instead of joining the first opening brace
  // to the final closing brace, which would make otherwise valid JSON fail.
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "{" && text[start] !== "[") continue
    const stack = []
    let quoted = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === "\\") escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === "{" || character === "[") stack.push(character)
      else if (character === "}" || character === "]") {
        const opening = stack.pop()
        if (
          (opening === "{" && character !== "}") ||
          (opening === "[" && character !== "]")
        )
          break
        if (!stack.length) {
          add(text.slice(start, index + 1))
          start = index
          break
        }
      }
    }
  }
  return candidates
}

/**
 * Return the first parsable JSON response candidate or undefined when every candidate
 * is invalid/incomplete.
 */
function parseJsonResponse(value: unknown): unknown {
  for (const candidate of jsonCandidates(value)) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next fenced/balanced candidate.
    }
  }
  return undefined
}

/**
 * Normalize provider labels by removing step prefixes/trailing punctuation, collapsing
 * whitespace, and applying the display-length limit.
 */
function normalizeStepTitle(value: unknown) {
  return String(value || "")
    .replace(/^\s*(?:step\s*)?\d+\s*[.:)-]?\s*/iu, "")
    .replace(/[.;]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 72)
}

/**
 * Validate, deduplicate, cap, and source-order provider step entries whose titles and
 * integer lines fit the requested routine bounds.
 */
function normalizedStepEntries(entries: unknown[], range: LineRange, limit: number) {
  const result = []
  const seen = new Set()
  for (const value of entries || []) {
    const entry = record(value)
    const title = normalizeStepTitle(entry?.title ?? entry?.name ?? entry?.label)
    const rawLine = entry?.line ?? entry?.startLine ?? entry?.start_line
    const line =
      typeof rawLine === "number"
        ? rawLine
        : Number(String(rawLine ?? "").match(/\d+/)?.[0])
    if (!title || !/[A-Za-z]/u.test(title) || !isInteger(line)) continue
    if (line < range.startLine || line > range.endLine) continue
    const key = `${line}:${title.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({ title, line, source: entry })
    if (result.length >= limit) break
  }
  return result.sort(
    /** Order normalized steps by their original source lines. */ (left, right) =>
      left.line - right.line,
  )
}

/**
 * Absorb valid labels only for parser-known plan IDs from supported provider/streamed
 * JSON shapes, retaining cached labels separately from newly supplied labels.
 */
function plannedLabelsFromResponse(value: unknown, analysis: AiStepAnalysis) {
  const plan = analysis?.fixedPlan
  // The provider may label existing blocks only; accepting invented IDs would detach labels from parser-owned source ranges.
  const knownIds = new Set(
    plan?.nodes?.map(
      /** Collect the parser-owned IDs that provider labels are allowed to reference. */ (
        node,
      ) => node.id,
    ) || [],
  )
  const labels = { ...analysis?.cachedLabels }
  const modelLabels: Record<string, string> = {}
  /**
   * Merge usable labels from a parsed response shape only when their IDs belong to the
   * fixed plan and their titles are nonempty.
   */
  const absorb = (value: unknown) => {
    const parsed = record(value)
    const rows = parsed?.id
      ? [parsed]
      : Array.isArray(value)
        ? value
        : (parsed?.items ??
          parsed?.labels ??
          record(parsed?.result)?.items ??
          record(parsed?.data)?.items)
    if (Array.isArray(rows)) {
      for (const value of rows) {
        const row = record(value)
        const id = String(row?.id || "").trim()
        const title = normalizeStepTitle(row?.title ?? row?.name ?? row?.label)
        if (!knownIds.has(id) || !title || !/[A-Za-z]/u.test(title)) continue
        labels[id] = title
        modelLabels[id] = title
      }
    } else if (rows && typeof rows === "object") {
      for (const [id, value] of Object.entries(rows)) {
        const title = normalizeStepTitle(value)
        if (!knownIds.has(id) || !title || !/[A-Za-z]/u.test(title)) continue
        labels[id] = title
        modelLabels[id] = title
      }
    }
  }
  const seen = new Set()
  for (const candidate of jsonCandidates(value)) {
    try {
      const parsed = JSON.parse(candidate)
      const signature = JSON.stringify(parsed)
      if (seen.has(signature)) continue
      seen.add(signature)
      absorb(parsed)
    } catch {
      // Streaming text can end with an incomplete final JSON line.
    }
  }
  return { labels, modelLabels }
}

/**
 * Rebuild AI step hierarchy from the fixed plan's original boundaries and selected
 * labels, using deterministic fallback titles for missing labels.
 */
function plannedStepsFromLabels(
  analysis: AiStepAnalysis,
  labels: Record<string, string> = {},
): AiStep[] {
  const plan = analysis?.fixedPlan
  if (!plan) return []
  // Rebuild navigation from the trusted plan instead of trusting provider-supplied line boundaries.
  const byId = new Map(
    plan.nodes.map(
      /** Index fixed blocks by ID for recursive hierarchy reconstruction. */ (
        node,
      ) => [node.id, node],
    ),
  )
  /**
   * Materialize a fixed-plan step and its known children without allowing provider
   * labels to alter source ranges or hierarchy.
   */
  const create = (id: string): AiStep | undefined => {
    const node = byId.get(id)
    if (!node) return undefined
    const children = node.children
      .map(create)
      .filter(
        /** Omit child references absent from the fixed plan. */ (
          step,
        ): step is AiStep => step !== undefined,
      )
    return {
      title: labels[id] || node.fallbackTitle || "",
      line: node.line,
      ...(children.length ? { children } : {}),
    }
  }
  return plan.roots
    .map(create)
    .filter(
      /** Omit root references absent from the fixed plan. */ (step): step is AiStep =>
        step !== undefined,
    )
}

/**
 * Normalize planned or free-form provider output into usable steps plus repair
 * metadata such as missing IDs and validated label counts.
 */
function parseAiStepResponseResult(
  value: string,
  analysis: AiStepAnalysis | undefined,
  limits: number | AiStepOptions | undefined = analysis,
): AiStepResponseResult {
  if (analysis?.fixedPlan) {
    const { labels, modelLabels } = plannedLabelsFromResponse(value, analysis)
    const unresolvedIds =
      analysis.unresolvedIds ||
      analysis.fixedPlan.nodes.map(
        /** Use all fixed-plan IDs when no explicit unresolved subset was recorded. */ (
          node,
        ) => node.id,
      )
    const missingIds = unresolvedIds.filter(
      /** Find requested IDs that this response did not validly label. */ (
        id: string | number,
      ) => !modelLabels[id],
    )
    return {
      planned: true,
      steps: plannedStepsFromLabels(analysis, labels),
      labels,
      modelLabels,
      missingIds,
      validLabelCount: Object.keys(modelLabels).length,
    }
  }
  const steps = parseAiStepResponse(value, analysis, limits)
  return {
    planned: false,
    steps,
    labels: {},
    modelLabels: {},
    missingIds: [],
    validLabelCount: steps.length,
  }
}

/**
 * Merge initial/repair labels with cached labels for a fixed plan, preserving its
 * ranges and recomputing unresolved IDs.
 */
function mergeAiStepResponseResults(
  analysis: AiStepAnalysis | undefined,
  first: AiStepResponseResult,
  second: AiStepResponseResult,
): AiStepResponseResult {
  if (!analysis?.fixedPlan) return second?.steps?.length ? second : first
  const labels = {
    ...analysis.cachedLabels,
    ...first?.modelLabels,
    ...second?.modelLabels,
  }
  const unresolvedIds = analysis.unresolvedIds || []
  const missingIds = unresolvedIds.filter(
    /**
     * Find requested IDs still unlabeled after merging the initial and repair responses.
     */ (id: string | number) => !labels[id],
  )
  const modelLabels = { ...first?.modelLabels, ...second?.modelLabels }
  return {
    planned: true,
    steps: plannedStepsFromLabels(analysis, labels),
    labels,
    modelLabels,
    missingIds,
    validLabelCount: Object.keys(modelLabels).length,
  }
}

/**
 * Request labels only for missing fixed-plan IDs, retaining existing titles and
 * parser-defined hierarchy/ranges.
 */
function buildAiStepRepairPrompt(
  analysis: AiStepAnalysis | undefined,
  missingIds: string[] = [],
) {
  const plan = analysis?.fixedPlan
  if (!plan) return ""
  const wanted = new Set(missingIds || [])
  const byId = new Map(
    plan.nodes.map(
      /** Index fixed blocks so repair prompts retain their original source bounds. */ (
        node,
      ) => [node.id, node],
    ),
  )
  const descriptions = [...wanted]
    .map(
      /**
       * Describe only missing blocks, including child IDs for groups and source for
       * leaves.
       */ (id) => {
        const node = byId.get(id)
        if (!node) return ""
        if (node.kind === "group") {
          const children = node.children.map(
            /**
             * Annotate child IDs with cached titles when available to guide a group label.
             */ (childId: string | number) => {
              const title = analysis?.cachedLabels?.[childId]
              return title ? `${childId}（${title}）` : childId
            },
          )
          return `${id}: lines ${node.line}-${node.endLine}, includes ${children.join(", ")}`
        }
        return `--- ${id} [${node.line}-${node.endLine}] ---\n${node.source}`
      },
    )
    .filter(Boolean)
  return [
    "You are a Delphi/Object Pascal code navigation assistant.",
    "The previous response omitted a few IDs. Fill in only the IDs listed below; do not repeat other items or change the fixed boundaries.",
    "Each title must be a concise, clear English functional label. Do not number titles; keep each under 8 words.",
    'Output one complete JSON object per line, without an array, Markdown, or code fences: {"id":"c01","title":"Process input data"}',
    "",
    ...descriptions,
  ].join("\n")
}

/**
 * Pair displayed step titles with their fixed-plan content hashes for reuse after
 * unchanged source blocks move within a routine.
 */
function plannedLabelsByHash(
  analysis: AiStepAnalysis | undefined,
  steps: AiStep[],
): Array<[string, string]> {
  const plan = analysis?.fixedPlan
  if (!plan) return []
  const byId = new Map(
    plan.nodes.map(
      /** Index fixed blocks to associate displayed titles with their content hashes. */ (
        node,
      ) => [node.id, node],
    ),
  )
  const result: Array<[string, string]> = []
  /**
   * Traverse fixed-plan IDs and matching step rows to collect reusable content-hash
   * labels in their existing hierarchy order.
   */
  const visit = (ids: string[], rows: AiStep[] = []) => {
    for (let index = 0; index < ids.length; index += 1) {
      const node = byId.get(ids[index])
      const step = rows?.[index]
      if (!node || !step?.title) continue
      result.push([node.hash, step.title])
      if (node.children.length) visit(node.children, step.children)
    }
  }
  visit(plan.roots, steps)
  return result
}

/**
 * Parse supported provider step layouts, validating bounds/count/depth and using
 * parser-owned ranges whenever a fixed plan exists.
 */
function parseAiStepResponse(
  value: string,
  range: AiStepAnalysis | undefined,
  limits: number | AiStepOptions | undefined = 8,
): AiStep[] {
  if (range?.fixedPlan) {
    const { labels } = plannedLabelsFromResponse(value, range)
    return plannedStepsFromLabels(range, labels)
  }
  const valueParsed = parseJsonResponse(value)
  const parsed = record(valueParsed)
  if (valueParsed === undefined) return []
  const sourceSteps = Array.isArray(valueParsed)
    ? valueParsed
    : (parsed?.steps ?? record(parsed?.result)?.steps ?? record(parsed?.data)?.steps)
  if (!Array.isArray(sourceSteps) || !range) return []
  const options: AiStepOptions =
    typeof limits === "object" && limits ? limits : { effectiveMaxSteps: limits }
  const maxSteps = Math.max(
    1,
    Math.min(12, Number(options.effectiveMaxSteps ?? options.maxSteps) || 5),
  )
  const substepsEnabled = options.substepsEnabled !== false
  const maxSubsteps = Math.max(2, Math.min(8, Number(options.maxSubsteps) || 5))
  const maxDepth = Math.max(2, Math.min(5, Number(options.maxDepth) || 3))
  const substepMinParentLines = Math.max(
    6,
    Math.min(100, Number(options.substepMinParentLines) || 30),
  )
  const topSteps = normalizedStepEntries(sourceSteps, range, maxSteps)
  const normalizeLevel = /**
   * Recursively normalize AI steps, bounding source spans and enforcing substep depth
   * limits.
   */ (
    steps: ReturnType<typeof normalizedStepEntries>,
    endLine: number,
    depth: number,
  ): AiStep[] =>
    steps.map(
      /**
       * Bound a step by the next sibling and retain children only when depth and span
       * allow them.
       */ (step, index: number) => {
        const itemEndLine = Math.max(
          step.line,
          (steps[index + 1]?.line ?? endLine + 1) - 1,
        )
        let children: AiStep[] = []
        if (
          substepsEnabled &&
          depth < maxDepth &&
          itemEndLine - step.line + 1 >= substepMinParentLines
        ) {
          const childEntries = normalizedStepEntries(
            Array.isArray(step.source?.children)
              ? step.source.children
              : Array.isArray(step.source?.substeps)
                ? step.source.substeps
                : [],
            { startLine: step.line, endLine: itemEndLine },
            maxSubsteps,
          )
          children = normalizeLevel(childEntries, itemEndLine, depth + 1)
          if (children.length < 2) children = []
        }
        return {
          title: step.title,
          line: step.line,
          ...(children.length ? { children } : {}),
        }
      },
    )
  return normalizeLevel(topSteps, range.endLine, 1)
}

/**
 * Correlate batch response rows to requested routine IDs and normalize each routine
 * using its own analysis limits.
 */
function parseBatchAiStepResponse(value: string, batch: AiBatchPrompt | undefined) {
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonCandidate(value))
  } catch {
    return []
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : (record(parsed)?.routines ?? record(parsed)?.results)
  if (!Array.isArray(rows)) return []
  const byId = new Map(
    rows.map(
      /** Index batch response records by their correlation IDs. */ (value) => {
        const row = record(value)
        return [String(row?.id || ""), row] as const
      },
    ),
  )
  return (batch?.entries || []).map(
    /**
     * Normalize each requested routine's result using that routine's source bounds and
     * limits.
     */ (entry) => {
      const row = byId.get(entry.id)
      const steps = row
        ? parseAiStepResponse(
            JSON.stringify({ steps: row.steps }),
            entry.request.analysis,
            entry.request.analysis,
          )
        : []
      return { ...entry, steps }
    },
  )
}

/**
 * Create a stable navigable AI-step node with original source offsets, bounded line
 * span, numbered display label, and recursively nested substeps.
 */
function createStepNode(
  text: string,
  analysisKey: string | undefined,
  step: AiStep,
  index: number,
  endLine: number,
  parentPrefix = "",
  siblingCount = 1,
): NavigatorNode {
  const lineOffset = offsetAtLine(text, step.line)
  const sourceLineEnd = text.indexOf("\n", lineOffset)
  const lineText = text.slice(
    lineOffset,
    sourceLineEnd < 0 ? text.length : sourceLineEnd,
  )
  const indentation = /^\s*/.exec(lineText)?.[0].length || 0
  const number = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`
  const node: NavigatorNode = {
    id: `ai-step:${createHash("sha1").update(`${analysisKey}:${number}:${step.line}`).digest("hex").slice(0, 16)}`,
    kind: "ai-step",
    label: siblingCount > 1 ? `${number}. ${step.title}` : step.title,
    name: step.title,
    offset: Math.min(text.length, lineOffset + indentation),
    line: step.line,
    startLine: step.line,
    endLine: Math.max(step.line, endLine),
    stepDepth: number.split(".").length,
    children: [],
  }
  const children = Array.isArray(step.children) ? step.children : []
  node.children = children.map(
    /**
     * Create child nodes within their sibling boundaries, carrying the parent's number
     * prefix.
     */ (child, childIndex: number) =>
      createStepNode(
        text,
        analysisKey,
        child,
        childIndex,
        Math.max(
          child.line,
          (children[childIndex + 1]?.line ?? (node.endLine ?? endLine) + 1) - 1,
        ),
        number,
        children.length,
      ),
  )
  for (const child of node.children) child.parent = node
  return node
}

/**
 * Build a routine's AI-step nodes using the next step or routine end to bound each
 * source range.
 */
function createAiStepNodes(
  text: string,
  routineNode: NavigatorTarget,
  analysisKey: string | undefined,
  steps: AiStep[],
): NavigatorNode[] {
  const routineRange = routineSourceRange(text, routineNode)
  return steps.map(
    /** Create top-level steps bounded by the next step or the routine's last line. */ (
      step,
      index: number,
    ) =>
      createStepNode(
        text,
        analysisKey,
        step,
        index,
        Math.max(
          step.line,
          isInteger(steps[index + 1]?.line)
            ? steps[index + 1].line - 1
            : (routineRange?.endLine ?? step.line),
        ),
        "",
        steps.length,
      ),
  )
}

export {
  AI_STEP_CACHE_STATE_KEY,
  AI_STEP_CHUNK_CACHE_STATE_KEY,
  AI_STEP_PROMPT_VERSION,
  buildAiStepRepairPrompt,
  buildAiStepPrompt,
  buildBatchAiStepPrompt,
  buildDetailedStepPlan,
  buildRoutineAnalysisContext,
  createAiStepNodes,
  lineStartOffset,
  mergeAiStepResponseResults,
  normalizeStepTitle,
  offsetAtLine,
  parseAiStepResponse,
  parseAiStepResponseResult,
  parseBatchAiStepResponse,
  plannedLabelsByHash,
  routineAnalysisKey,
  routineSourceRange,
}
