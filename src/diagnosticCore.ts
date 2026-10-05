import { CompilerDirective } from "./shared/pascal"
export interface ProjectOverrides {
  configuration?: string
  platform?: string
}
export interface ProjectInfo {
  projectPath: string
  projectDir: string
  mainSource?: string
  configuration: string
  platform: string
  references: string[]
  searchPaths: string[]
  defines: string[]
}
import { isRecord } from "./shared/guards"
import { PascalKeyword } from "./shared/pascal"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { decodeXml, normalizeKey } from "./projectDiscovery"

/**
 * Read and decode the first named project XML element, returning undefined when its
 * value is absent or empty.
 */
function xmlValue(xml: string, name: string) {
  const expression = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i")
  const value = expression.exec(xml)?.[1]
  return value ? decodeXml(value).trim() : undefined
}

/**
 * Expand case-insensitive MSBuild property references for up to eight passes,
 * retaining unresolved macros and stopping once the value stabilizes.
 */
function expandSimpleProperties(
  value: string,
  properties: Readonly<Record<string, string>>,
) {
  let result = value || ""
  // Bound recursive macro expansion so mutually dependent project properties cannot keep the extension host in an infinite loop.
  for (let pass = 0; pass < 8; pass += 1) {
    const next = result.replace(
      /\$\(([^)]+)\)/g,
      /**
       * Expand known compiler properties while retaining unknown placeholders
       * verbatim.
       */ (whole, name) => properties[name.toLowerCase()] ?? whole,
    )
    if (next === result) break
    result = next
  }
  return result
}

/**
 * Remove navigation-injected source directories from compiler search paths, rejecting
 * unresolved macros and canonical duplicates.
 */
function excludeManagedSourcePaths(
  paths: readonly string[],
  managedPaths: readonly string[],
) {
  const managedKeys = new Set(
    (managedPaths || [])
      .filter(
        /** Discard non-string and blank search-path entries. */ (value) =>
          typeof value === "string" && value.trim(),
      )
      .map(normalizeKey),
  )
  const result = []
  const seen = new Set<string>()
  for (const value of paths || []) {
    if (typeof value !== "string" || !value.trim() || /\$\([^)]+\)/.test(value))
      continue
    const resolved = path.resolve(value)
    const key = normalizeKey(resolved)
    if (managedKeys.has(key) || seen.has(key)) continue
    seen.add(key)
    result.push(resolved)
  }
  return result
}

/**
 * Copy the process environment, remove every casing of the inherited DCC search-path
 * variable, and insert only the supplied compiler paths.
 */
function compilerEnvironmentWithSearchPath(
  environment: NodeJS.ProcessEnv,
  searchPaths: readonly string[],
) {
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === "dcc_unitsearchpath") delete result[key]
  }
  if (searchPaths?.length) result.DCC_UnitSearchPath = searchPaths.join(";")
  return result
}

/**
 * Evaluate the supported sanitized MSBuild condition subset after property expansion;
 * absent conditions match and unsupported or invalid expressions do not.
 */
function conditionMatches(
  condition: string | undefined,
  properties: Readonly<Record<string, string>>,
) {
  if (!condition) return true
  const expanded = expandSimpleProperties(decodeXml(condition), properties).replace(
    /\$\([^)]+\)/g,
    "",
  )
  if (!/^[\s()'"=!<>&|A-Za-z0-9_.:\\/-]+$/.test(expanded)) return false
  const expression = expanded
    .replace(new RegExp(String.raw`\b${PascalKeyword.And}\b`, "gi"), "&&")
    .replace(new RegExp(String.raw`\b${PascalKeyword.Or}\b`, "gi"), "||")
  try {
    return Boolean(Function(`"use strict"; return (${expression});`)())
  } catch {
    return false
  }
}

/**
 * Apply matching project property groups in XML order while retaining explicit build
 * overrides and supplying default Debug/Win32 values.
 */
function evaluateProjectProperties(xml: string, overrides: ProjectOverrides = {}) {
  const properties: Record<string, string> = {}
  if (overrides.configuration && overrides.configuration !== "auto")
    properties.config = overrides.configuration
  if (overrides.platform && overrides.platform !== "auto")
    properties.platform = overrides.platform
  for (const group of xml.matchAll(
    /<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi,
  )) {
    const condition = /\bCondition\s*=\s*(["'])(.*?)\1/i.exec(group[1])?.[2]
    if (!conditionMatches(condition, properties)) continue
    for (const property of group[2].matchAll(
      /<([A-Za-z_][A-Za-z0-9_.-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g,
    )) {
      const propertyCondition = /\bCondition\s*=\s*(["'])(.*?)\1/i.exec(
        property[2],
      )?.[2]
      if (!conditionMatches(propertyCondition, properties)) continue
      const key = property[1].toLowerCase()
      if (
        (key === "config" &&
          overrides.configuration &&
          overrides.configuration !== "auto") ||
        (key === PascalKeyword.Platform &&
          overrides.platform &&
          overrides.platform !== "auto")
      )
        continue
      properties[key] = expandSimpleProperties(
        decodeXml(property[3]).trim(),
        properties,
      )
    }
  }
  properties.config ||= "Debug"
  properties.platform ||= "Win32"
  return properties
}

/**
 * Read a Delphi project and referenced main source to resolve configuration, platform,
 * compiler defines, source references, and usable compiler paths.
 */
function readProjectInfo(projectPath: string, overrides: ProjectOverrides = {}) {
  const xml = fs.readFileSync(projectPath, "utf8")
  const projectDir = path.dirname(projectPath)
  const baseProperties = evaluateProjectProperties(xml, overrides)
  const mainSourceValue = baseProperties.mainsource || xmlValue(xml, "MainSource")
  const mainSource = mainSourceValue
    ? path.resolve(projectDir, expandSimpleProperties(mainSourceValue, baseProperties))
    : undefined
  const references = []
  for (const match of xml.matchAll(
    /<DCCReference\b[^>]*\bInclude\s*=\s*(["'])(.*?)\1/gi,
  )) {
    const value = decodeXml(match[2]).trim()
    if (/\.(?:pas|pp|inc)$/i.test(value))
      references.push(path.resolve(projectDir, value))
  }
  if (mainSource && fs.existsSync(mainSource)) {
    const mainText = fs.readFileSync(mainSource, "utf8")
    for (const match of mainText.matchAll(
      new RegExp(String.raw`\b(?:${PascalKeyword.In})\s*'((?:''|[^'])+)'`, "gi"),
    )) {
      references.push(
        path.resolve(path.dirname(mainSource), match[1].replace(/''/g, "'")),
      )
    }
  }
  const searchPaths = []
  for (const value of [
    baseProperties.dcc_unitsearchpath,
    baseProperties.dcc_includepath,
    baseProperties.dcc_resourcepath,
  ].filter(Boolean)) {
    for (const segment of value.split(";")) {
      const expanded = expandSimpleProperties(segment.trim(), baseProperties)
      if (expanded && !/\$\([^)]+\)/.test(expanded)) {
        searchPaths.push(
          path.isAbsolute(expanded)
            ? path.normalize(expanded)
            : path.resolve(projectDir, expanded),
        )
      }
    }
  }
  const defines = new Set<string>()
  for (const item of (baseProperties.dcc_define || "")
    .replace(/\$\([^)]+\)/g, "")
    .split(";")) {
    if (item.trim()) defines.add(item.trim().toUpperCase())
  }
  defines.add(baseProperties.platform.toUpperCase())
  if (/win32/i.test(baseProperties.platform)) defines.add("MSWINDOWS")
  if (/win64/i.test(baseProperties.platform)) defines.add("MSWINDOWS")
  return {
    projectPath: path.resolve(projectPath),
    projectDir,
    mainSource,
    configuration: baseProperties.config,
    platform: baseProperties.platform,
    references: [
      ...new Map(
        references.map(
          /** Pair case-insensitive reference path keys with their absolute paths. */ (
            item,
          ) => [normalizeKey(item), path.resolve(item)],
        ),
      ).values(),
    ],
    searchPaths: [
      ...new Map(
        searchPaths.map(
          /** Pair normalized search-path keys with the original path spellings. */ (
            item,
          ) => [normalizeKey(item), item],
        ),
      ).values(),
    ],
    defines: [...defines],
  }
}

/**
 * Read Vallenta's active-project selection relative to a workspace, returning
 * undefined for missing, invalid, or unusable state.
 */
function readActiveProject(workspaceRoot: string) {
  const filePath = path.join(workspaceRoot, ".vallenta", "projects.local.json")
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"))
    return isRecord(value) &&
      isRecord(value.activeProject) &&
      typeof value.activeProject.projectPath === "string"
      ? path.resolve(value.activeProject.projectPath)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Check containment with a relative path rather than a string prefix so similarly
 * named sibling directories are not treated as children.
 */
function pathIsInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/**
 * Choose a source file's owning project by explicit membership, active selection, then
 * deepest containing project directory.
 */
function resolveOwningProject(
  filePath: string,
  projects: readonly ProjectInfo[],
  activeProjectPath?: string,
) {
  const fileKey = normalizeKey(filePath)
  const activeKey = activeProjectPath ? normalizeKey(activeProjectPath) : undefined
  const direct = projects.filter(
    /**
     * Select projects that directly reference this file or use it as their main
     * source.
     */ (project) =>
      project.references.some(
        /** Match a project reference to the normalized source-file identity. */ (
          item,
        ) => normalizeKey(item) === fileKey,
      ) ||
      (project.mainSource && normalizeKey(project.mainSource) === fileKey),
  )
  // Explicit project membership outranks directory proximity; the active project breaks ties only within the applicable candidates.
  const activeDirect = direct.find(
    /** Prefer the active project among direct source owners. */ (project) =>
      normalizeKey(project.projectPath) === activeKey,
  )
  if (activeDirect) return activeDirect
  if (direct.length > 0) return direct[0]
  const containing = projects
    .filter(
      /** Select project directories that contain the source file. */ (project) =>
        pathIsInside(project.projectDir, filePath),
    )
    .sort(
      /**
       * Prefer the deepest project directory when multiple directories contain the
       * source file.
       */ (left, right) => right.projectDir.length - left.projectDir.length,
    )
  const activeContaining = containing.find(
    /** Prefer the active project among containing source owners. */ (project) =>
      normalizeKey(project.projectPath) === activeKey,
  )
  return activeContaining || containing[0]
}

/**
 * Quote a path for Pascal source, doubling apostrophes so the result remains a valid
 * string literal.
 */
function pascalQuote(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Resolve an include/resource path relative to the original source, substituting
 * filename wildcards and retaining unresolved MSBuild macros.
 */
function resolveDirectivePath(rawPath: string, originalPath: string) {
  let value = rawPath.replace(/''/g, "'")
  if (path.isAbsolute(value) || /^\$\([^)]+\)/.test(value)) return value
  if (value.includes("*"))
    value = value.replace(
      /\*/g,
      path.basename(originalPath, path.extname(originalPath)),
    )
  return path.resolve(path.dirname(originalPath), value)
}

/**
 * Rebase source in/include/resource references for isolated shadow compilation,
 * redirecting known dirty files while retaining other resolved paths.
 */
function rewritePascalPaths(
  text: string,
  originalPath: string,
  shadowByOriginal: ReadonlyMap<string, string> = new Map(),
) {
  /**
   * Redirect an original canonical source path to its shadow copy when one exists;
   * otherwise preserve the resolved original path.
   */
  const lookup = (value: string) => shadowByOriginal.get(normalizeKey(value)) || value
  let result = text.replace(
    new RegExp(String.raw`(\b${PascalKeyword.In}\s*)'((?:''|[^'])+)'`, "gi"),
    /**
     * Rewrite a Pascal source path to its shadow-source location while preserving
     * quoting.
     */ (whole, prefix, rawPath) => {
      const resolved = path.resolve(
        path.dirname(originalPath),
        rawPath.replace(/''/g, "'"),
      )
      return `${prefix}${pascalQuote(lookup(resolved))}`
    },
  )
  result = result.replace(
    new RegExp(
      String.raw`(\{\$\s*(?:I|${CompilerDirective.INCLUDE}|R|RESOURCE)\s+)(?:'((?:''|[^'])+)'|([^}\s]+))(\s*\})`,
      "gi",
    ),
    /**
     * Rewrite a compiler directive path while preserving its prefix, suffix, and
     * Pascal quoting.
     */ (whole, prefix, quoted, bare, suffix) => {
      const resolved = resolveDirectivePath(quoted || bare, originalPath)
      return `${prefix}${pascalQuote(lookup(resolved))}${suffix}`
    },
  )
  return result
}

/**
 * Normalize compiler labels or diagnostic-code prefixes to error, warning, or hint;
 * return undefined for unrelated output.
 */
function compilerSeverity(value: string, code: string) {
  const normalized = `${value || ""} ${code || ""}`.toLowerCase()
  if (/fatal|\bf\d{4}\b/.test(normalized)) return "error"
  if (/error|\be\d{4}\b/.test(normalized)) return "error"
  if (/warning|\bw\d{4}\b/.test(normalized)) return "warning"
  if (/hint|\bh\d{4}\b/.test(normalized)) return "hint"
  return undefined
}

/**
 * Extract diagnostics from supported dcc/MSBuild output layouts, retaining original
 * lines and ignoring lines with no recognized severity.
 */
function parseCompilerOutput(output: string) {
  const results = []
  const patterns = [
    /^\[(?:dcc\w*)\s+(Fatal|Error|Warning|Hint)\]\s+(.+?)\((\d+)(?:,(\d+))?\):\s*([FEWH]\d{4})?\s*(.*)$/i,
    /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning|hint)\s+([A-Z]+\d+)?\s*:?\s*(.*?)(?:\s+\[[^\]]+\])?$/i,
    /^(.+?)\((\d+)(?:,(\d+))?\)\s+(Fatal|Error|Warning|Hint):\s*([A-Z]+\d+)?\s*(.*)$/i,
    /^(.+?)\s*:\s*(fatal error|error|warning|hint)\s+([A-Z]+\d+)?\s*:?\s*(.*?)(?:\s+\[[^\]]+\])?$/i,
    /^(fatal error|error|warning|hint)\s+([A-Z]+\d+)?\s*:?\s*(.*)$/i,
  ]
  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let match = patterns[0].exec(line)
    if (match) {
      results.push({
        severity: compilerSeverity(match[1], match[5]),
        file: match[2],
        line: Number(match[3]),
        column: Number(match[4] || 0),
        code: match[5],
        message: match[6].trim(),
        raw: rawLine,
      })
      continue
    }
    match = patterns[1].exec(line)
    if (match) {
      results.push({
        severity: compilerSeverity(match[4], match[5]),
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3] || 0),
        code: match[5],
        message: match[6].trim(),
        raw: rawLine,
      })
      continue
    }
    match = patterns[2].exec(line)
    if (match) {
      results.push({
        severity: compilerSeverity(match[4], match[5]),
        file: match[1],
        line: Number(match[2]),
        column: Number(match[3] || 0),
        code: match[5],
        message: match[6].trim(),
        raw: rawLine,
      })
      continue
    }
    match = patterns[3].exec(line)
    if (match) {
      results.push({
        severity: compilerSeverity(match[2], match[3]),
        file: match[1],
        line: 1,
        column: 0,
        code: match[3],
        message: match[4].trim(),
        raw: rawLine,
      })
      continue
    }
    match = patterns[4].exec(line)
    if (match) {
      results.push({
        severity: compilerSeverity(match[1], match[2]),
        file: "",
        line: 1,
        column: 0,
        code: match[2],
        message: match[3].trim(),
        raw: rawLine,
      })
    }
  }
  return results.filter(
    /** Keep parsed compiler messages with a recognized diagnostic severity. */ (
      item,
    ) => item.severity,
  )
}

/**
 * Fingerprint compiler-relevant project inputs and the project file stamp so
 * configuration or project changes select a fresh diagnostics cache.
 */
function cacheKey(
  project: Pick<
    ProjectInfo,
    "projectPath" | "configuration" | "platform" | "defines" | "searchPaths"
  >,
  compilerPath = "",
) {
  const hash = createHash("sha256")
  hash.update(
    JSON.stringify({
      projectPath: normalizeKey(project.projectPath),
      configuration: project.configuration,
      platform: project.platform,
      defines: project.defines,
      searchPaths: project.searchPaths.map(normalizeKey),
      compilerPath: normalizeKey(compilerPath || "."),
    }),
  )
  try {
    const stat = fs.statSync(project.projectPath)
    hash.update(`${stat.size}:${stat.mtimeMs}`)
  } catch {}
  return hash.digest("hex").slice(0, 20)
}

export type ProjectTaskFailure =
  | { cancelled: true; reason: string }
  | { error: unknown }
interface QueuedProjectTask<T> {
  projectKey: string
  priority: number
  run: (signal: AbortSignal) => T | Promise<T>
  resolve: (value: T | ProjectTaskFailure) => void
  sequence: number
}
class ProjectTaskPool<T = unknown> {
  readonly maxParallel: number
  readonly running = new Map<string, { controller: AbortController }>()
  readonly queued = new Map<string, QueuedProjectTask<T>>()
  /** Create a project-keyed task queue with at least one concurrent execution slot. */
  constructor(maxParallel = 2) {
    this.maxParallel = Math.max(1, maxParallel)
  }
  /**
   * Replace pending work for a project, settle the superseded caller, and queue the
   * new operation with priority and an abort signal.
   */
  enqueue(
    projectKey: string,
    priority: number,
    run: (signal: AbortSignal) => T | Promise<T>,
  ): Promise<T | ProjectTaskFailure> {
    // A new queued request supersedes the old one, but the old caller still needs a cancellation result rather than an abandoned promise.
    this.queued.get(projectKey)?.resolve({ cancelled: true, reason: "superseded" })
    let resolve!: (value: T | ProjectTaskFailure) => void
    const promise = new Promise<T | ProjectTaskFailure>(
      /** Capture the resolver used to settle a queued project task. */ (done) => {
        resolve = done
      },
    )
    this.queued.set(projectKey, {
      projectKey,
      priority,
      run,
      resolve,
      sequence: Date.now() + Math.random(),
    })
    this.pump()
    return promise
  }
  /**
   * Settle queued work as cancelled and request cancellation of active work for the
   * same project key.
   */
  cancel(projectKey: string, reason = "cancelled"): void {
    const queued = this.queued.get(projectKey)
    if (queued) {
      this.queued.delete(projectKey)
      queued.resolve({ cancelled: true, reason })
    }
    this.running.get(projectKey)?.controller.abort(reason)
  }
  /** Cancel both queued and running project work with a shared reason. */
  cancelAll(reason = "cancelled"): void {
    for (const key of [...this.queued.keys(), ...this.running.keys()])
      this.cancel(key, reason)
  }
  /**
   * Start highest-priority queued work up to the concurrency limit, settle results or
   * failures, and refill slots after each completion.
   */
  pump(): void {
    while (this.running.size < this.maxParallel && this.queued.size > 0) {
      const task = [...this.queued.values()].sort(
        /** Prioritize queued work by urgency, using submission order to break ties. */ (
          left,
          right,
        ) => right.priority - left.priority || left.sequence - right.sequence,
      )[0]
      this.queued.delete(task.projectKey)
      const controller = new AbortController()
      this.running.set(task.projectKey, { controller })
      Promise.resolve()
        .then(
          /** Run the selected project task with its dedicated cancellation signal. */ () =>
            task.run(controller.signal),
        )
        .then(
          /** Settle the queued caller with the successful task result. */ (value) =>
            task.resolve(value),
          /** Settle the queued caller with the captured task failure. */ (
            error: unknown,
          ) => task.resolve({ error }),
        )
        .finally(
          /**
           * Release the completed project slot and schedule the next queued task on
           * either outcome.
           */ () => {
            // Free the slot on either outcome before scheduling the next queued project.
            this.running.delete(task.projectKey)
            this.pump()
          },
        )
    }
  }
}

export {
  ProjectTaskPool,
  cacheKey,
  compilerEnvironmentWithSearchPath,
  evaluateProjectProperties,
  excludeManagedSourcePaths,
  parseCompilerOutput,
  readActiveProject,
  readProjectInfo,
  resolveOwningProject,
  rewritePascalPaths,
}
