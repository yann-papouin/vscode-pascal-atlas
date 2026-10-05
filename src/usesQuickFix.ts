import { SourceSymbolKind, PascalBuiltinName } from "./shared/symbols"
import type {
  SourceDefinition,
  SourceUnit,
  SourceIndex,
  SerializedSourceIndex,
  DefinitionSelectionOptions,
} from "./shared/sourceModels"
import { workerPath } from "./runtimePaths"
import { isInteger, isRecord } from "./shared/guards"
import { FileExtension, WorkerEvent } from "./shared/identifiers"
import { PascalKeyword } from "./shared/pascal"
import * as fs from "node:fs"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { promisify } from "node:util"
import { Worker } from "node:worker_threads"
import { gzip, gunzip } from "node:zlib"
import { decodePascalBytes } from "./encodingSupport"
import {
  extractPascalRoutineSignature,
  inferPascalCollectionElementType,
  maskPascalNonCode,
  pascalRoutineReturnType,
  pascalTypeBaseName,
  substitutePascalTypeParameters,
  parseUsesUnits,
} from "./binarySymbols"
import { isPascalIntrinsicIdentifier } from "./syntacticColoring"

const IGNORED_DIRECTORIES = new Set<string>([
  ".git",
  ".hg",
  ".svn",
  ".vsdcache",
  "node_modules",
])
const PASCAL_FILE_DISCOVERY_CACHE = new Map<string, Promise<string[]>>()
const OFF_THREAD_PARSE_BYTES = 128 * 1024
const SOURCE_INDEX_CACHE_VERSION = 4
const gzipAsync = promisify(gzip)
const gunzipAsync = promisify(gunzip)
const IMPLICIT_PASCAL_UNITS = new Set<string>(["system"])
/**
 * Recognize a unit implicitly imported by Delphi so missing-uses assistance does not
 * propose it.
 */
function isImplicitPascalUnit(unitName: string) {
  return IMPLICIT_PASCAL_UNITS.has(
    String(unitName || "")
      .trim()
      .toLowerCase(),
  )
}

/**
 * Compare used/candidate unit names case-insensitively, allowing a namespaced unit's
 * leaf spelling without conflating two different fully qualified names.
 */
function pascalUnitNamesEquivalent(left: string, right: unknown) {
  const leftKey = String(left || "")
    .trim()
    .toLowerCase()
  const rightKey = String(right || "")
    .trim()
    .toLowerCase()
  if (!leftKey || !rightKey) return false
  if (leftKey === rightKey) return true
  // Delphi permits a namespaced unit to be referenced by its leaf name (for
  // example Classes for System.Classes). Do not equate two different fully
  // qualified units that merely share the same leaf.
  if (leftKey.includes(".") && rightKey.includes(".")) return false
  return leftKey.split(".").at(-1) === rightKey.split(".").at(-1)
}

/**
 * Remove empty, duplicate, own-unit, and implicit-unit proposals while retaining each
 * candidate's original display spelling.
 */
function filterAddUnitCandidates(
  unitNames: Iterable<string> | undefined,
  ownUnit?: string,
): string[] {
  const seen = new Set()
  const result = []
  for (const unitName of unitNames || []) {
    const key = String(unitName || "")
      .trim()
      .toLowerCase()
    if (
      !key ||
      pascalUnitNamesEquivalent(key, ownUnit) ||
      isImplicitPascalUnit(key) ||
      seen.has(key)
    )
      continue
    seen.add(key)
    result.push(unitName)
  }
  return result
}

/**
 * Rank declaration/body candidates according to implementation and single-target
 * preferences, retaining overload identity and requested all-target behavior.
 */
function selectBestPascalDefinitions<
  Definition extends {
    kind: string
    offset: number
    unitName?: string
    signature?: string
    implementationOffset?: number
  },
>(definitions: Definition[], options: DefinitionSelectionOptions = {}) {
  let selected = [...(definitions || [])]
  const preferImplementation = options.preferImplementation !== false
  const singleTarget = options.singleTarget !== false
  let usedImplementation = false

  if (
    preferImplementation &&
    selected.length > 0 &&
    selected.every(
      /** Prefer implementation coordinates only when every candidate is a routine. */ (
        item,
      ) => item.kind === SourceSymbolKind.Routine,
    )
  ) {
    const implementations = selected.filter(
      /** Retain routine declarations with a known implementation location. */ (item) =>
        isInteger(item.implementationOffset),
    )
    if (implementations.length > 0) {
      selected = implementations
      usedImplementation = true
    }
  }

  if (singleTarget && selected.length > 1) {
    const usedOrder = (options.usedUnitNames || []).map(
      /** Normalize used-unit names for declaration ranking. */ (item: string) =>
        String(item).toLowerCase(),
    )
    const leafOrder = usedOrder.map(
      /** Include unit leaf names when ranking namespaced declarations. */ (
        item: string,
      ) => item.split(".").at(-1),
    )
    const rank = /**
     * Rank a definition by the latest matching qualified or unqualified unit in the
     * uses order.
     */ (definition: Definition) => {
      const unit = String(definition.unitName || "").toLowerCase()
      return Math.max(
        usedOrder.lastIndexOf(unit),
        leafOrder.lastIndexOf(unit.split(".").at(-1)),
      )
    }
    selected.sort(
      /**
       * Prefer later used units, then earlier source positions and stable signature
       * order.
       */ (left, right) =>
        rank(right) - rank(left) ||
        left.offset - right.offset ||
        String(left.signature || "").localeCompare(String(right.signature || "")),
    )
    selected = [selected[0]]
  }

  return { definitions: selected, usedImplementation }
}

/**
 * Project source type definitions into a symbol-to-owning-unit lookup for missing-uses
 * proposals.
 */
function sourceTypeUnitIndex(
  sourceIndex: Pick<SourceIndex, "types">,
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>()
  for (const [symbol, definitions] of sourceIndex?.types || []) {
    for (const definition of definitions) {
      if (!definition?.unitName) continue
      if (!result.has(symbol)) result.set(symbol, new Set())
      result.get(symbol)!.add(definition.unitName)
    }
  }
  return result
}

/**
 * Resolve members through source type aliases and inheritance across indexes, stopping
 * cycles and preferring the nearest available definitions.
 */
function findSourceMemberDefinitions(
  indexes:
    | Pick<SourceIndex, "types" | "members">
    | Array<Pick<SourceIndex, "types" | "members"> | undefined>,
  typeName: string,
  memberName: string,
): SourceDefinition[] {
  const sources = (Array.isArray(indexes) ? indexes : [indexes]).filter(
    /** Ignore absent source indexes before traversing type metadata. */ (
      index,
    ): index is Pick<SourceIndex, "types" | "members"> => Boolean(index),
  )
  const wanted = String(memberName || "").toLowerCase()
  const pending = [typeName]
  const visited = new Set()

  while (pending.length > 0) {
    const current = pending.shift()!
    const key = pascalTypeBaseName(current).toLowerCase()
    if (!key || visited.has(key)) continue
    visited.add(key)

    const direct = sources.flatMap(
      /**
       * Collect direct members of the current type from each available source index.
       */ (index) => index.members?.get(key)?.get(wanted) || [],
    )
    if (direct.length > 0) return direct

    const definitions = sources.flatMap(
      /**
       * Collect the current type's alias and ancestor metadata from all source indexes.
       */ (index) => index.types?.get(key) || [],
    )
    for (const definition of definitions) {
      const parameters = definition.typeParameters || []
      for (const baseType of definition.baseTypes || []) {
        pending.push(substitutePascalTypeParameters(baseType, parameters, current))
      }
      if (definition.aliasedType) {
        pending.push(
          substitutePascalTypeParameters(definition.aliasedType, parameters, current),
        )
      }
    }
  }
  return []
}

/**
 * Create a lazy correlated parser-worker facade that validates transferred units,
 * rejects failed requests, and supports thread disposal.
 */
function createSourceParserWorker() {
  let worker: Worker | undefined
  let nextRequestId = 1
  const pending = new Map<
    number,
    { resolve: (unit: SourceUnit | undefined) => void; reject: (error: Error) => void }
  >()
  /**
   * Reject and clear every outstanding source-parse request when the shared parser
   * worker fails.
   */
  const failPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  /**
   * Start the source-parser thread on demand and connect validated replies plus
   * error/exit cleanup to pending requests.
   */
  const ensureWorker = () => {
    if (worker) return worker
    worker = new Worker(workerPath("sourceIndexWorker.js"))
    worker.on(
      WorkerEvent.Message,
      /**
       * Route a validated worker reply to its matching pending request and discard
       * unknown or late replies.
       */ (message: unknown) => {
        if (!isRecord(message) || !isInteger(message.id)) return
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (typeof message.error === "string") request.reject(new Error(message.error))
        else if (message.unit === undefined || isSourceUnit(message.unit))
          request.resolve(message.unit)
        else request.reject(new Error("Invalid source-index worker response."))
      },
    )
    worker.on(WorkerEvent.Error, failPending)
    worker.on(
      WorkerEvent.Exit,
      /**
       * Handle worker/process termination and release or reject outstanding work when
       * its exit is unsuccessful.
       */ (code) => {
        if (code !== 0 && pending.size > 0) {
          failPending(
            new Error(`Pascal source parser worker exited with code ${code}.`),
          )
        }
        worker = undefined
      },
    )
    return worker
  }
  return {
    /**
     * Post a source-unit parse request with a unique correlation ID and return its
     * typed completion promise.
     */
    parse(text: string, filePath: string) {
      const id = nextRequestId++
      return new Promise<SourceUnit | undefined>(
        /** Connect asynchronous completion and rejection to the parse promise. */ (
          resolve,
          reject,
        ) => {
          pending.set(id, { resolve, reject })
          ensureWorker().postMessage({ id, text, filePath })
        },
      )
    },
    /**
     * Release the source parser reference and await termination of the active worker
     * when one exists.
     */
    async dispose() {
      if (!worker) return
      const activeWorker = worker
      worker = undefined
      await activeWorker.terminate()
    },
  }
}

/**
 * Discover matching artifacts in bounded directory batches while skipping symlinks,
 * ignored trees, and unreadable folders.
 */
async function findFilesWithExtensions(rootPath: string, extensions: Set<string>) {
  const results = []
  const pending = [rootPath]
  while (pending.length > 0) {
    const batch = pending.splice(0, 16)
    const listings = await Promise.all(
      batch.map(
        /**
         * Read directory entries in parallel, treating unreadable directories as empty.
         */ async (directory) => {
          try {
            return [
              directory,
              await fs.promises.readdir(directory, { withFileTypes: true }),
            ] as const
          } catch {
            return [directory, []] as const
          }
        },
      ),
    )
    for (const [directory, entries] of listings) {
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) pending.push(fullPath)
        } else if (
          entry.isFile() &&
          extensions.has(path.extname(entry.name).toLowerCase())
        ) {
          results.push(fullPath)
        }
      }
    }
  }
  return results
}

/**
 * Share one cached discovery promise per canonical source root, removing failed
 * promises so later scans can retry.
 */
async function findPascalUnitFiles(rootPath: string) {
  const key = path.resolve(rootPath).toLowerCase()
  if (!PASCAL_FILE_DISCOVERY_CACHE.has(key)) {
    // Startup creates current-file, secondary and full indexes concurrently.
    // Share one directory walk instead of traversing the same RAD/project tree
    // for every index and again on each editor switch.
    PASCAL_FILE_DISCOVERY_CACHE.set(
      key,
      findFilesWithExtensions(
        rootPath,
        new Set<string>([FileExtension.Pascal, ".pp"]),
      ).catch(
        /**
         * Evict a failed discovery promise so a later request can retry the same root.
         */ (error) => {
          PASCAL_FILE_DISCOVERY_CACHE.delete(key)
          throw error
        },
      ),
    )
  }
  return PASCAL_FILE_DISCOVERY_CACHE.get(key)!
}

/** Filter cached Pascal source discovery by requested qualified or leaf unit names. */
async function findPascalUnitFilesByName(
  rootPath: string,
  unitNames: Iterable<string>,
) {
  const wanted = new Set()
  for (const unitName of unitNames || []) {
    const key = String(unitName || "").toLowerCase()
    if (!key) continue
    wanted.add(key)
    wanted.add(key.split(".").at(-1)!)
  }
  if (wanted.size === 0) return []
  const files = await findPascalUnitFiles(rootPath)
  return files.filter(
    /** Match discovered filenames against qualified or leaf unit names. */ (
      filePath: string,
    ) => {
      const base = path.basename(filePath, path.extname(filePath)).toLowerCase()
      return wanted.has(base) || wanted.has(base.split(".").at(-1))
    },
  )
}

/**
 * Scan preferred bounded-size DCP files for recoverable namespaced type/unit pairs and
 * merge them into a candidate-unit lookup.
 */
async function buildDcpSymbolIndex(rootPaths: string[]) {
  const preferred = new Map<string, string>()
  for (const rootPath of rootPaths) {
    for (const filePath of await findFilesWithExtensions(
      rootPath,
      new Set<string>([FileExtension.CompiledSymbols]),
    )) {
      const key = path.basename(filePath).toLowerCase()
      const current = preferred.get(key)
      /**
       * Prefer non-trunk duplicate symbol artifacts and shorter paths when choosing
       * one DCP file per basename.
       */
      const score = (value: string) =>
        (/trunk-win64-lib/i.test(value) ? 0 : 1000) - value.length
      if (!current || score(filePath) > score(current)) preferred.set(key, filePath)
    }
  }

  const paths = [...preferred.values()]
  const symbols = new Map<string, Set<string>>()
  for (let start = 0; start < paths.length; start += 4) {
    const parsed = await Promise.all(
      paths.slice(start, start + 4).map(
        /**
         * Recover namespaced type/unit pairs from readable DCPs within the file-size
         * limit.
         */ async (filePath) => {
          try {
            const stat = await fs.promises.stat(filePath)
            if (stat.size > 128 * 1024 * 1024) return []
            const text = (await fs.promises.readFile(filePath)).toString("latin1")
            const entries: Array<[string, string]> = []
            for (const match of text.matchAll(
              /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([TI][A-Za-z0-9_]+)\b/g,
            )) {
              entries.push([match[2].toLowerCase(), match[1]])
            }
            return entries
          } catch {
            return []
          }
        },
      ),
    )
    for (const entries of parsed) {
      for (const [symbol, unitName] of entries) {
        if (!symbols.has(symbol)) symbols.set(symbol, new Set())
        symbols.get(symbol)!.add(unitName)
      }
    }
  }
  return { fileCount: paths.length, symbols }
}

/**
 * Recognize forward or ancestor-only type declarations that end at a semicolon rather
 * than owning a nested structure body.
 */
function isBodylessStructureDeclaration(code: string, afterKindOffset: number) {
  let cursor = afterKindOffset
  while (/\s/.test(code[cursor] || "")) cursor += 1
  if (code[cursor] === ";") return true
  if (code[cursor] !== "(") return false
  let depth = 0
  for (; cursor < code.length; cursor += 1) {
    if (code[cursor] === "(") depth += 1
    else if (code[cursor] === ")") {
      depth -= 1
      if (depth === 0) {
        cursor += 1
        break
      }
    }
  }
  while (/\s/.test(code[cursor] || "")) cursor += 1
  return code[cursor] === ";"
}

/**
 * Find a class/record/object/interface block's boundary using named nested
 * declarations, avoiding false nesting from generic class constraints.
 */
function findStructureEnd(code: string, bodyStart: number) {
  let depth = 1
  // Only a named type declaration opens a nested structure here. The previous
  // broad `: class` branch also matched generic constraints such as `<T: class>`
  // inside method declarations, leaving the outer class permanently nested and
  // dropping all of its members from the source index.
  const tokenPattern = new RegExp(
    "^\\s*(?:" +
      PascalKeyword.Type +
      "\\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>\\r\\n]*>)?\\s*=\\s*(?:" +
      PascalKeyword.Packed +
      "\\s+)?(?:" +
      PascalKeyword.Class +
      "(?!\\s+" +
      PascalKeyword.Of +
      "\\b)|" +
      PascalKeyword.Record +
      "|" +
      PascalKeyword.Object +
      "|" +
      PascalKeyword.Interface +
      ")\\b|\\b" +
      PascalKeyword.End +
      "\\s*;",
    "gim",
  )
  tokenPattern.lastIndex = bodyStart
  let token
  while ((token = tokenPattern.exec(code))) {
    if (new RegExp("^\\s*" + PascalKeyword.End + "\\s*;", "i").test(token[0])) {
      depth -= 1
      if (depth === 0) return token.index
    } else if (!isBodylessStructureDeclaration(code, tokenPattern.lastIndex)) {
      depth += 1
    }
  }
  return -1
}

/**
 * Blank nested type bodies while preserving code offsets so an outer type does not
 * inherit their member declarations.
 */
function maskNestedStructures(body: string) {
  const result = body.split("")
  const tokenPattern = new RegExp(
    "^\\s*(?:" +
      PascalKeyword.Type +
      "\\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>\\r\\n]*>)?\\s*=\\s*(?:" +
      PascalKeyword.Packed +
      "\\s+)?(?:" +
      PascalKeyword.Class +
      "(?!\\s+" +
      PascalKeyword.Of +
      "\\b)|" +
      PascalKeyword.Record +
      "|" +
      PascalKeyword.Object +
      "|" +
      PascalKeyword.Interface +
      ")\\b|\\b" +
      PascalKeyword.End +
      "\\s*;",
    "gim",
  )
  let depth = 0
  let nestedStart = -1
  let token
  while ((token = tokenPattern.exec(body))) {
    if (new RegExp("^\\s*" + PascalKeyword.End + "\\s*;", "i").test(token[0])) {
      if (depth === 0) continue
      depth -= 1
      if (depth === 0 && nestedStart >= 0) {
        for (let index = nestedStart; index < tokenPattern.lastIndex; index += 1) {
          if (result[index] !== "\r" && result[index] !== "\n") result[index] = " "
        }
        nestedStart = -1
      }
    } else {
      if (isBodylessStructureDeclaration(body, tokenPattern.lastIndex)) continue
      if (depth === 0) nestedStart = token.index
      depth += 1
    }
  }
  return result.join("")
}

/**
 * Parse a Pascal unit into typed public definitions, type/member metadata, and routine
 * body coordinates, optionally including active-file implementation symbols.
 */
function parseSourceUnitSymbols(
  text: string,
  filePath: string,
  preparedCode?: string,
  options: {
    includeImplementationSymbols?: boolean
    includeImplementationTypes?: boolean
  } = {},
): SourceUnit | undefined {
  const code = preparedCode || maskPascalNonCode(text)
  const unitMatch = new RegExp(
    "\\b" + PascalKeyword.Unit + "\\s+([A-Za-z_][A-Za-z0-9_.]*)\\s*;",
    "i",
  ).exec(code)
  const unitName = unitMatch?.[1]
  if (!unitMatch || !unitName) return undefined
  const implementation = new RegExp(
    "\\b" + PascalKeyword.Implementation + "\\b",
    "i",
  ).exec(code)
  const includeImplementationSymbols = Boolean(
    options.includeImplementationSymbols || options.includeImplementationTypes,
  )
  const publicCode = implementation ? code.slice(0, implementation.index) : code
  const symbols = new Set([unitName])
  const definitions: SourceDefinition[] = []
  const types: SourceDefinition[] = []
  const members: SourceDefinition[] = []
  const lineStarts = [0]
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lineStarts.push(index + 1)
  }
  /**
   * Convert an original UTF-16 offset to a line/column using the precomputed
   * line-start table.
   */
  const sourcePositionAt = (offset: number) => {
    let low = 0
    let high = lineStarts.length - 1
    while (low <= high) {
      const middle = (low + high) >> 1
      if (lineStarts[middle] <= offset) low = middle + 1
      else high = middle - 1
    }
    const line = Math.max(0, high)
    return { line, character: offset - lineStarts[line] }
  }

  /**
   * Record a named source definition with its owning unit, file, original span, and
   * optional type/signature metadata.
   */
  const addDefinition = (
    symbol: string,
    offset: number,
    kind: string = SourceSymbolKind.Symbol,
    extra: Pick<SourceDefinition, "signature" | "typeName" | "owner"> = {},
  ): SourceDefinition => {
    symbols.add(symbol)
    const position = sourcePositionAt(offset)
    const definition = {
      symbol,
      unitName,
      filePath,
      offset,
      length: symbol.length,
      line: position.line,
      character: position.character,
      kind,
      ...extra,
    }
    definitions.push(definition)
    return definition
  }

  /**
   * Attach declared generic parameters, collection element types, and non-structural
   * alias targets to a source type definition.
   */
  const applyTypeDeclarationMetadata = (
    definition: SourceDefinition,
    genericText: string,
    rightHandSide: string,
  ) => {
    definition.typeParameters = String(genericText || "")
      .split(/[;,]/)
      .map(
        /** Extract a generic parameter name before any constraint text. */ (item) =>
          item.trim().split(":")[0].trim(),
      )
      .filter(
        /** Retain only valid generic parameter identifiers. */ (item) =>
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(item),
      )
    const element = new RegExp(
      "\\b" +
        PascalKeyword.Array +
        "(?:\\s*\\[[^\\]]*\\])?\\s+" +
        PascalKeyword.Of +
        "\\s+([A-Za-z_][A-Za-z0-9_.]*(?:\\s*<[^;=()]+>)?)",
      "i",
    ).exec(rightHandSide || "")
    if (element) definition.elementType = element[1].trim()
    const alias = /^\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/.exec(
      rightHandSide || "",
    )
    if (
      alias &&
      !new RegExp(
        "^(?:" +
          PascalKeyword.Class +
          "|" +
          PascalKeyword.Record +
          "|" +
          PascalKeyword.Object +
          "|" +
          PascalKeyword.Interface +
          "|" +
          PascalKeyword.Procedure +
          "|" +
          PascalKeyword.Function +
          "|" +
          PascalKeyword.Reference +
          "|" +
          PascalKeyword.Set +
          "|" +
          PascalKeyword.File +
          ")$",
        "i",
      ).test(alias[1])
    ) {
      definition.aliasedType = alias[1].replace(/\s+/g, "")
      definition.elementType ||= inferPascalCollectionElementType(
        definition.aliasedType,
      )
    }
  }

  addDefinition(
    unitName,
    unitMatch.index + unitMatch[0].indexOf(unitName),
    PascalKeyword.Unit,
  )

  for (const match of publicCode.matchAll(
    new RegExp(
      "^\\s*(?:" +
        PascalKeyword.Class +
        "\\s+)?(?:" +
        PascalKeyword.Function +
        "|" +
        PascalKeyword.Procedure +
        "|" +
        PascalKeyword.Constructor +
        "|" +
        PascalKeyword.Destructor +
        "|" +
        PascalKeyword.Operator +
        ")\\s+([A-Za-z_][A-Za-z0-9_.]*)",
      "gim",
    ),
  )) {
    const qualifiedName = match[1]
    const symbol = qualifiedName.split(".").at(-1)!
    const offset = match.index + match[0].lastIndexOf(symbol)
    const signature = extractPascalRoutineSignature(text, offset, code)
    addDefinition(symbol, offset, SourceSymbolKind.Routine, {
      signature,
      typeName: pascalRoutineReturnType(signature),
    })
  }

  let section = ""
  let lineOffset = 0
  // Computing this inside the line loop made a 50,000-line source call
  // String.includes over the complete 1.5 MB document for every line.
  const eolWidth = text.includes("\r\n") ? 2 : 1
  for (const line of publicCode.split(/\r?\n/)) {
    // A section header occupies its own logical line. Accepting any line that
    // merely starts with `var` mistakes multiline routine parameters for a
    // global var section and makes later type aliases disappear from the index.
    const sectionMatch = new RegExp(
      "^\\s*(" +
        PascalKeyword.Const +
        "|" +
        PascalKeyword.Resourcestring +
        "|" +
        PascalKeyword.Var +
        "|" +
        PascalKeyword.Threadvar +
        "|" +
        PascalKeyword.Type +
        ")\\s*$",
      "i",
    ).exec(line)
    if (sectionMatch) section = sectionMatch[1].toLowerCase()
    if (section === PascalKeyword.Type) {
      const match =
        /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<([^=\r\n]*)>)?\s*=\s*(.*)$/.exec(line)
      if (match) {
        const definition = addDefinition(
          match[1],
          lineOffset + line.indexOf(match[1]),
          PascalKeyword.Type,
        )
        applyTypeDeclarationMetadata(definition, match[2], match[3])
        types.push(definition)
      }
    } else if (
      section === PascalKeyword.Const ||
      section === PascalKeyword.Resourcestring
    ) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/.exec(line)
      if (match)
        addDefinition(
          match[1],
          lineOffset + line.indexOf(match[1]),
          SourceSymbolKind.Constant,
        )
    } else if (section === PascalKeyword.Var || section === PascalKeyword.Threadvar) {
      const match =
        /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*)/.exec(
          line,
        )
      if (match) {
        for (const name of match[1]
          .split(",")
          .map(
            /** Trim each name from a grouped public variable declaration. */ (item) =>
              item.trim(),
          )) {
          addDefinition(
            name,
            lineOffset + line.indexOf(name),
            SourceSymbolKind.Variable,
            { typeName: match[2] },
          )
        }
      }
    }
    lineOffset += line.length + eolWidth
  }

  if (includeImplementationSymbols && implementation) {
    let implementationSection = ""
    let implementationLineOffset = implementation.index
    const implementationCode = code.slice(implementation.index)
    for (const line of implementationCode.split(/\r?\n/)) {
      const sectionMatch = new RegExp(
        "^\\s*(" +
          PascalKeyword.Type +
          "|" +
          PascalKeyword.Const +
          "|" +
          PascalKeyword.Resourcestring +
          "|" +
          PascalKeyword.Var +
          "|" +
          PascalKeyword.Threadvar +
          ")\\s*$",
        "i",
      ).exec(line)
      const sectionBoundary = new RegExp(
        "^\\s*(?:" +
          PascalKeyword.Implementation +
          "|" +
          PascalKeyword.Uses +
          "|" +
          PascalKeyword.Procedure +
          "|" +
          PascalKeyword.Function +
          "|" +
          PascalKeyword.Constructor +
          "|" +
          PascalKeyword.Destructor +
          "|" +
          PascalKeyword.Operator +
          "|" +
          PascalKeyword.Initialization +
          "|" +
          PascalKeyword.Finalization +
          "|" +
          PascalKeyword.Begin +
          ")\\b",
        "i",
      ).test(line)
      if (sectionMatch) implementationSection = sectionMatch[1].toLowerCase()
      else if (sectionBoundary) implementationSection = ""

      if (implementationSection === PascalKeyword.Type) {
        const match =
          /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<([^=\r\n]*)>)?\s*=\s*(.*)$/.exec(line)
        if (match) {
          const offset = implementationLineOffset + line.indexOf(match[1])
          if (
            !definitions.some(
              /**
               * Avoid duplicating a type declaration already collected at this source
               * offset.
               */ (item) => item.offset === offset && item.kind === PascalKeyword.Type,
            )
          ) {
            const definition = addDefinition(match[1], offset, PascalKeyword.Type)
            applyTypeDeclarationMetadata(definition, match[2], match[3])
            types.push(definition)
          }
        }
      } else if (
        implementationSection === PascalKeyword.Const ||
        implementationSection === PascalKeyword.Resourcestring
      ) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/.exec(line)
        if (match)
          addDefinition(
            match[1],
            implementationLineOffset + line.indexOf(match[1]),
            SourceSymbolKind.Constant,
          )
      } else if (
        implementationSection === PascalKeyword.Var ||
        implementationSection === PascalKeyword.Threadvar
      ) {
        const match =
          /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*)/.exec(
            line,
          )
        if (match) {
          for (const name of match[1]
            .split(",")
            .map(
              /** Trim each name from a grouped implementation variable declaration. */ (
                item,
              ) => item.trim(),
            )) {
            addDefinition(
              name,
              implementationLineOffset + line.indexOf(name),
              SourceSymbolKind.Variable,
              {
                typeName: match[2],
              },
            )
          }
        }
      }
      implementationLineOffset += line.length + eolWidth
    }
  }

  // `TWidgetClass = class of TWidget` is a metaclass alias, not a class body.
  // Treating it as a structure made findStructureEnd consume every following
  // declaration up to a distant `end;`, then ran three member regexes over the
  // same huge overlapping ranges. CADGks.pas spent tens of seconds here.
  const structurePattern = new RegExp(
    "^\\s*([A-Za-z_][A-Za-z0-9_]*)(?:\\s*<[^=\\r\\n]*>)?\\s*=\\s*(?:" +
      PascalKeyword.Packed +
      "\\s+)?(" +
      PascalKeyword.Class +
      "(?!\\s+" +
      PascalKeyword.Of +
      "\\b)|" +
      PascalKeyword.Record +
      "|" +
      PascalKeyword.Object +
      "|" +
      PascalKeyword.Interface +
      ")(?:\\s+" +
      PascalKeyword.Helper +
      "\\s+" +
      PascalKeyword.For +
      "\\s+([A-Za-z_][A-Za-z0-9_.<>]*))?(?:\\s*\\(([^)]*)\\))?",
    "gim",
  )
  const enumPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(([\s\S]*?)\)\s*;/gim
  /**
   * Parse source structures/enums in one masked slice, rebasing member offsets to the
   * original unit and excluding nested type bodies from outer members.
   */
  const parseStructures = (structureCode: string, baseOffset = 0) => {
    for (const match of structureCode.matchAll(structurePattern)) {
      const owner = match[1]
      const ownerOffset = baseOffset + match.index + match[0].indexOf(owner)
      let typeDefinition = types.find(
        /**
         * Reuse type metadata already recorded for this structure's declaration offset.
         */ (item) => item.offset === ownerOffset,
      )
      if (!typeDefinition) {
        typeDefinition = addDefinition(owner, ownerOffset, PascalKeyword.Type)
        types.push(typeDefinition)
      }
      typeDefinition.structureKind = match[2].toLowerCase()
      typeDefinition.helperTarget = match[3]?.trim()
      const genericHeader = match[0].slice(0, match[0].indexOf("="))
      const genericParameters = /<([^>]*)>/.exec(genericHeader)?.[1] || ""
      typeDefinition.typeParameters = genericParameters
        .split(/[;,]/)
        .map(
          /** Extract the structure's generic parameter names before constraint text. */ (
            item,
          ) => item.trim().split(":")[0].trim(),
        )
        .filter(
          /** Retain only valid generic parameter identifiers. */ (item) =>
            /^[A-Za-z_][A-Za-z0-9_]*$/.test(item),
        )
      const baseTypes = [match[3], ...(match[4] || "").split(",")]
        .map(
          /** Trim helper targets and inherited type names. */ (item) => item?.trim(),
        )
        .filter(
          /** Remove empty helper or ancestor entries before hierarchy inference. */ (
            item,
          ): item is string => Boolean(item),
        )
      if (
        typeDefinition.structureKind === PascalKeyword.Class &&
        !typeDefinition.helperTarget &&
        owner.toLowerCase() !== PascalBuiltinName.TObject.toLowerCase() &&
        baseTypes.length === 0
      ) {
        baseTypes.push(PascalBuiltinName.TObject)
      }
      typeDefinition.baseTypes = baseTypes
      const bodyStart = match.index + match[0].length
      // Delphi import units contain long lists such as `IFoo = interface;`.
      // Delphi also permits body-less descendants such as
      // `EGraphics = class(Exception);` and generic forms like
      // `TFooList = class(TList<TFoo>);`.
      if (isBodylessStructureDeclaration(structureCode, bodyStart)) continue
      const bodyEnd = findStructureEnd(structureCode, bodyStart)
      if (bodyEnd < 0) continue
      const body = maskNestedStructures(structureCode.slice(bodyStart, bodyEnd))
      /**
       * Record a source member under its declaring type with rebased source
       * coordinates and member-specific metadata.
       */
      const addMember = (
        name: string,
        relativeOffset: number,
        kind: string | undefined,
        typeName: string | undefined,
        extra: Pick<SourceDefinition, "signature"> = {},
      ) => {
        const absoluteOffset = baseOffset + bodyStart + relativeOffset
        const definition = addDefinition(name, absoluteOffset, kind, {
          owner,
          typeName,
        })
        Object.assign(definition, extra)
        members.push(definition)
        return definition
      }
      // Leading `\s*` can cross line boundaries. On a large class body it
      // causes catastrophic multiline backtracking at almost every line; only
      // horizontal indentation is valid before a declaration here.
      for (const property of body.matchAll(
        new RegExp(
          "^[ \\t]*" +
            PascalKeyword.Property +
            "\\s+([A-Za-z_][A-Za-z0-9_]*)(?:\\s*\\[[^\\]]*\\])?\\s*:\\s*([A-Za-z_][A-Za-z0-9_.]*(?:\\s*<[^;=()]+>)?)",
          "gim",
        ),
      )) {
        addMember(
          property[1],
          property.index + property[0].lastIndexOf(property[1]),
          PascalKeyword.Property,
          property[2],
        )
      }
      for (const routine of body.matchAll(
        new RegExp(
          "^[ \\t]*(?:" +
            PascalKeyword.Class +
            "\\s+)?(?:" +
            PascalKeyword.Function +
            "|" +
            PascalKeyword.Procedure +
            "|" +
            PascalKeyword.Constructor +
            "|" +
            PascalKeyword.Destructor +
            "|" +
            PascalKeyword.Operator +
            ")\\s+([A-Za-z_][A-Za-z0-9_]*)",
          "gim",
        ),
      )) {
        const relativeOffset = routine.index + routine[0].lastIndexOf(routine[1])
        const absoluteOffset = baseOffset + bodyStart + relativeOffset
        const signature = extractPascalRoutineSignature(text, absoluteOffset, code)
        addMember(
          routine[1],
          relativeOffset,
          SourceSymbolKind.Routine,
          pascalRoutineReturnType(signature),
          {
            signature,
          },
        )
      }
      for (const field of body.matchAll(
        /^[ \t]*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*)\s*;/gim,
      )) {
        for (const name of field[1]
          .split(",")
          .map(
            /** Trim each field name in a grouped member declaration. */ (
              item: string,
            ) => item.trim(),
          )) {
          addMember(
            name,
            field.index + field[0].indexOf(name),
            SourceSymbolKind.Field,
            field[2],
          )
        }
      }
    }

    for (const match of structureCode.matchAll(enumPattern)) {
      const owner = match[1]
      const ownerOffset = baseOffset + match.index + match[0].indexOf(owner)
      let typeDefinition = types.find(
        /** Reuse type metadata already recorded for this enum's declaration offset. */ (
          item,
        ) => item.offset === ownerOffset,
      )
      if (!typeDefinition) {
        typeDefinition = addDefinition(owner, ownerOffset, PascalKeyword.Type)
        types.push(typeDefinition)
      }
      typeDefinition.structureKind = "enum"
      const body = match[2]
      const bodyOffset = baseOffset + match.index + match[0].indexOf(body)
      for (const item of body.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = item[1]
        const offset = bodyOffset + item.index + item[0].lastIndexOf(name)
        const definition = addDefinition(name, offset, SourceSymbolKind.EnumMember, {
          owner,
          typeName: owner,
        })
        members.push(definition)
      }
    }
  }

  parseStructures(publicCode)
  // Project indexes remain interface-only. The active document additionally
  // parses just the implementation slice, avoiding a second O(file) pass over
  // every public type while still making private types immediately available.
  if (includeImplementationSymbols && implementation) {
    parseStructures(code.slice(implementation.index), implementation.index)
  }

  // Attach implementation-body locations to public routine declarations. This
  // lets the companion answer Ctrl+Click without waiting for the LSP queue while
  // still preserving Delphi's interface declaration as the canonical symbol.
  if (implementation) {
    const implementationCode = code.slice(implementation.index)
    const routineDefinitions = definitions.filter(
      /** Consider routine declarations when pairing implementation headings. */ (
        item,
      ) => item.kind === SourceSymbolKind.Routine,
    )
    const occurrenceByKey = new Map<string, number>()
    const implementationPattern = new RegExp(
      "^\\s*(?:" +
        PascalKeyword.Class +
        "\\s+)?(?:" +
        PascalKeyword.Function +
        "|" +
        PascalKeyword.Procedure +
        "|" +
        PascalKeyword.Constructor +
        "|" +
        PascalKeyword.Destructor +
        "|" +
        PascalKeyword.Operator +
        ")\\s+([A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>\\r\\n]*>)?(?:\\.[A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>\\r\\n]*>)?)*)",
      "gim",
    )
    for (const match of implementationCode.matchAll(implementationPattern)) {
      const qualifiedName = match[1]
      const parts = qualifiedName.split(".").map(
        /**
         * Remove generic argument text from qualified routine-name components for
         * owner matching.
         */ (part: string) => part.replace(/\s*<.*>\s*$/, ""),
      )
      const symbol = parts.at(-1)!
      const owner = parts.length > 1 ? parts.at(-2) : undefined
      let candidates = routineDefinitions.filter(
        /** Find declarations sharing this implementation's routine name. */ (item) =>
          item.symbol.toLowerCase() === symbol.toLowerCase(),
      )
      if (owner) {
        const owned = candidates.filter(
          /**
           * Prefer declarations whose owning type matches the implementation heading.
           */ (item) =>
            item.owner?.toLowerCase().split(".").at(-1) === owner.toLowerCase(),
        )
        if (owned.length > 0) candidates = owned
      } else {
        const unowned = candidates.filter(
          /** Match unqualified implementations to global routine declarations. */ (
            item,
          ) => !item.owner,
        )
        if (unowned.length > 0) candidates = unowned
      }
      const implementationOffset =
        implementation.index + match.index + match[0].lastIndexOf(symbol)
      if (candidates.length === 0) {
        if (includeImplementationSymbols && !owner) {
          const definition = addDefinition(
            symbol,
            implementationOffset,
            SourceSymbolKind.Routine,
            {
              signature: extractPascalRoutineSignature(
                text,
                implementationOffset,
                code,
              ),
            },
          )
          routineDefinitions.push(definition)
        }
        continue
      }
      const occurrenceKey = `${owner?.toLowerCase() || ""}.${symbol.toLowerCase()}`
      const ordinal = occurrenceByKey.get(occurrenceKey) || 0
      occurrenceByKey.set(occurrenceKey, ordinal + 1)
      const definition = candidates[Math.min(ordinal, candidates.length - 1)]
      const position = sourcePositionAt(implementationOffset)
      definition.implementationOffset = implementationOffset
      definition.implementationLine = position.line
      definition.implementationCharacter = position.character
    }
  }
  return { unitName, symbols, definitions, types, members }
}

/**
 * Read bounded batches of deduplicated source files, parse large units off-thread,
 * merge symbol/type/member/unit indexes, and dispose the parser worker on either
 * outcome.
 */
async function buildSourceUnitIndexFromFiles(paths: string[]): Promise<SourceIndex> {
  const uniquePaths = []
  const seenPaths = new Set()
  for (const filePath of paths) {
    const key = path.resolve(filePath).toLowerCase()
    if (!seenPaths.has(key)) {
      seenPaths.add(key)
      uniquePaths.push(filePath)
    }
  }

  paths = uniquePaths
  const index = new Map<string, Set<string>>()
  const definitions = new Map<string, SourceDefinition[]>()
  const types = new Map<string, SourceDefinition[]>()
  const members = new Map<string, Map<string, SourceDefinition[]>>()
  const units = new Map<string, SourceDefinition[]>()
  const sourceParserWorker = createSourceParserWorker()
  try {
    for (let start = 0; start < paths.length; start += 32) {
      const batch = paths.slice(start, start + 32)
      const sources = await Promise.all(
        batch.map(
          /**
           * Read and decode eligible source files, skipping oversized or unreadable
           * inputs.
           */ async (filePath: string) => {
            try {
              const stat = await fs.promises.stat(filePath)
              // Keep oversized or unreadable source files from turning an interactive index update into an unbounded read/parse operation.
              if (stat.size > 4 * 1024 * 1024) return undefined
              return {
                filePath,
                text: decodePascalBytes(await fs.promises.readFile(filePath)),
              }
            } catch {
              return undefined
            }
          },
        ),
      )
      for (const source of sources) {
        if (!source) continue
        // Parsing a batch in Promise continuations starves commands registered by
        // this extension: microtasks run before the setImmediate checkpoints used
        // by coloring. Keep file I/O parallel, yield between small units, and move
        // large generated SDK units off the extension-host thread entirely.
        await new Promise(
          /** Resolve after yielding once to the extension-host event loop. */ (
            resolve,
          ) => setImmediate(resolve),
        )
        const unit =
          source.text.length >= OFF_THREAD_PARSE_BYTES
            ? await sourceParserWorker.parse(source.text, source.filePath)
            : parseSourceUnitSymbols(source.text, source.filePath)
        if (!unit) continue
        const unitDefinition = unit.definitions.find(
          /**
           * Find the unit declaration used by exact and leaf-name navigation indexes.
           */ (item: { kind: string }) => item.kind === PascalKeyword.Unit,
        )
        if (!unitDefinition) continue
        for (const unitKey of [
          unit.unitName.toLowerCase(),
          unit.unitName.toLowerCase().split(".").at(-1)!,
        ]) {
          if (!units.has(unitKey)) units.set(unitKey, [])
          units.get(unitKey)!.push(unitDefinition)
        }
        for (const symbol of unit.symbols) {
          const key = symbol.toLowerCase()
          if (!index.has(key)) index.set(key, new Set())
          index.get(key)!.add(unit.unitName)
        }
        for (const definition of unit.definitions) {
          const key = definition.symbol.toLowerCase()
          if (!definitions.has(key)) definitions.set(key, [])
          definitions.get(key)!.push(definition)
        }
        for (const definition of unit.types) {
          const key = definition.symbol.toLowerCase()
          if (!types.has(key)) types.set(key, [])
          types.get(key)!.push(definition)
        }
        for (const definition of unit.members) {
          if (!definition.owner) continue
          const ownerKey = definition.owner.toLowerCase()
          if (!members.has(ownerKey)) members.set(ownerKey, new Map())
          const memberKey = definition.symbol.toLowerCase()
          if (!members.get(ownerKey)!.has(memberKey))
            members.get(ownerKey)!.set(memberKey, [])
          members.get(ownerKey)!.get(memberKey)!.push(definition)
        }
      }
    }
  } finally {
    await sourceParserWorker.dispose()
  }
  return {
    fileCount: paths.length,
    files: new Set(
      paths.map(
        /** Retain canonical lowercase source paths for index deduplication. */ (
          filePath: string,
        ) => path.resolve(filePath).toLowerCase(),
      ),
    ),
    symbols: index,
    definitions,
    types,
    members,
    units,
  }
}

/**
 * Convert nested source-index Maps and Sets to JSON-compatible entry arrays without
 * losing symbol-definition metadata.
 */
function serializeSourceUnitIndex(index: SourceIndex): SerializedSourceIndex {
  return {
    fileCount: index.fileCount,
    files: [...index.files],
    symbols: [...index.symbols].map(
      /** Serialize each symbol's owning-unit Set as an entry array. */ ([
        key,
        values,
      ]) => [key, [...values]],
    ),
    definitions: [...index.definitions],
    types: [...index.types],
    members: [...index.members].map(
      /** Serialize each owner's member Map as an entry array. */ ([owner, values]) => [
        owner,
        [...values],
      ],
    ),
    units: [...index.units],
  }
}

/**
 * Validate transferred source-unit symbol Sets and definition/type/member arrays
 * before adopting a worker result.
 */
function isSourceUnit(value: unknown): value is SourceUnit {
  return (
    isRecord(value) &&
    typeof value.unitName === "string" &&
    value.symbols instanceof Set &&
    [...value.symbols].every(
      /** Require transferred symbol names to be strings. */ (symbol) =>
        typeof symbol === "string",
    ) &&
    Array.isArray(value.definitions) &&
    value.definitions.every(isSourceDefinition) &&
    Array.isArray(value.types) &&
    value.types.every(isSourceDefinition) &&
    Array.isArray(value.members) &&
    value.members.every(isSourceDefinition)
  )
}
/**
 * Validate a source definition's symbol, owning unit, file path, kind, and integer
 * coordinates before accepting transferred or cached data.
 */
export function isSourceDefinition(value: unknown): value is SourceDefinition {
  return (
    isRecord(value) &&
    typeof value.symbol === "string" &&
    typeof value.unitName === "string" &&
    typeof value.filePath === "string" &&
    typeof value.kind === "string" &&
    isInteger(value.offset) &&
    isInteger(value.length) &&
    isInteger(value.line) &&
    isInteger(value.character)
  )
}
/**
 * Validate serialized string-keyed definition-array entries before rebuilding their
 * Map.
 */
function isDefinitionEntries(
  value: unknown,
): value is Array<[string, SourceDefinition[]]> {
  return (
    Array.isArray(value) &&
    value.every(
      /** Validate each string-keyed array of serialized source definitions. */ (
        entry,
      ) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        Array.isArray(entry[1]) &&
        entry[1].every(isSourceDefinition),
    )
  )
}
/**
 * Validate the complete serialized source-index container and nested entry arrays
 * before restoring Maps and Sets.
 */
function isSerializedSourceIndex(value: unknown): value is SerializedSourceIndex {
  return (
    isRecord(value) &&
    isInteger(value.fileCount) &&
    Array.isArray(value.files) &&
    value.files.every(
      /** Require persisted file paths to be strings. */ (file) =>
        typeof file === "string",
    ) &&
    Array.isArray(value.symbols) &&
    value.symbols.every(
      /** Validate each symbol entry and its array of owning-unit names. */ (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        Array.isArray(entry[1]) &&
        entry[1].every(
          /** Require persisted owning-unit names to be strings. */ (unit) =>
            typeof unit === "string",
        ),
    ) &&
    isDefinitionEntries(value.definitions) &&
    isDefinitionEntries(value.types) &&
    isDefinitionEntries(value.units) &&
    Array.isArray(value.members) &&
    value.members.every(
      /** Validate each type-owner entry and its nested member-definition entries. */ (
        entry,
      ) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "string" &&
        isDefinitionEntries(entry[1]),
    )
  )
}

/**
 * Restore validated serialized source-index Maps/Sets, returning undefined when the
 * stored shape is incompatible.
 */
function deserializeSourceUnitIndex(value: unknown): SourceIndex | undefined {
  if (!isSerializedSourceIndex(value)) return undefined
  return {
    fileCount: Number(value.fileCount) || 0,
    files: new Set(value.files || []),
    symbols: new Map(
      (value.symbols || []).map(
        /** Restore each serialized owning-unit array as a Set. */ ([key, values]) => [
          key,
          new Set(values),
        ],
      ),
    ),
    definitions: new Map(value.definitions || []),
    types: new Map(value.types || []),
    members: new Map(
      (value.members || []).map(
        /** Restore each owner's serialized member entries as a Map. */ ([
          owner,
          values,
        ]) => [owner, new Map(values)],
      ),
    ),
    units: new Map(value.units || []),
  }
}

/**
 * Hash canonical file paths and bounded-batch size/mtime signatures, including
 * missing-file markers, to detect source-index cache invalidation.
 */
async function sourceFilesFingerprint(paths: string[]) {
  const identities = []
  for (let start = 0; start < paths.length; start += 64) {
    const batch = await Promise.all(
      paths.slice(start, start + 64).map(
        /**
         * Describe each file by canonical path, size, and modification time, including
         * missing-file markers.
         */ async (filePath: string) => {
          try {
            const stat = await fs.promises.stat(filePath)
            return `${path.resolve(filePath).toLowerCase()}:${stat.size}:${Math.trunc(stat.mtimeMs)}`
          } catch {
            return `${path.resolve(filePath).toLowerCase()}:missing`
          }
        },
      ),
    )
    identities.push(...batch)
  }
  return createHash("sha256").update(identities.sort().join("|")).digest("hex")
}

/**
 * Read/decompress a source cache only when its version, fingerprint, and serialized
 * index are valid; treat missing/corrupt caches as misses.
 */
async function readSourceIndexCache(
  cachePath: string | undefined,
  fingerprint: string | undefined,
): Promise<SourceIndex | undefined> {
  if (!cachePath) return undefined
  try {
    const compressed = await fs.promises.readFile(cachePath)
    const stored: unknown = JSON.parse((await gunzipAsync(compressed)).toString("utf8"))
    if (
      !isRecord(stored) ||
      stored.version !== SOURCE_INDEX_CACHE_VERSION ||
      stored.fingerprint !== fingerprint
    ) {
      return undefined
    }
    return deserializeSourceUnitIndex(stored.index)
  } catch {
    return undefined
  }
}

/**
 * Write a versioned compressed index through a temporary file before replacing the
 * cache, suppressing persistence failures and removing failed temporary writes.
 */
async function writeSourceIndexCache(
  cachePath: string | undefined,
  fingerprint: string | undefined,
  index: SourceIndex,
) {
  if (!cachePath) return
  // Serialize and compress away from the live cache path so readers never observe a partially written cache payload.
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true })
    const serialized = JSON.stringify({
      version: SOURCE_INDEX_CACHE_VERSION,
      fingerprint,
      createdAt: Date.now(),
      index: serializeSourceUnitIndex(index),
    })
    await fs.promises.writeFile(
      temporaryPath,
      await gzipAsync(Buffer.from(serialized, "utf8")),
    )
    await fs.promises.rm(cachePath, { force: true })
    await fs.promises.rename(temporaryPath, cachePath)
  } catch {
    await fs.promises
      .rm(temporaryPath, { force: true })
      .catch(
        /** Ignore failure to remove an already unavailable temporary cache file. */ () =>
          undefined,
      )
  }
}

/**
 * Discover and deduplicate source files, reuse a matching cache, then wait for any
 * startup build gate before parsing and persisting a fresh index.
 */
async function buildSourceUnitIndex(
  rootPaths: string[],
  options: { cachePath?: string; buildGate?: Promise<unknown> } = {},
): Promise<SourceIndex> {
  const startedAt = Date.now()
  const paths = []
  const seenPaths = new Set()
  const discoveredByRoot = await Promise.all(rootPaths.map(findPascalUnitFiles))
  for (const discovered of discoveredByRoot) {
    for (const filePath of discovered) {
      const key = path.resolve(filePath).toLowerCase()
      if (!seenPaths.has(key)) {
        seenPaths.add(key)
        paths.push(filePath)
      }
    }
  }
  const fingerprint = options.cachePath
    ? await sourceFilesFingerprint(paths)
    : undefined
  const cached = await readSourceIndexCache(options.cachePath, fingerprint)
  if (cached) {
    cached.cacheHit = true
    cached.cacheElapsedMs = Date.now() - startedAt
    return cached
  }
  if (options.buildGate) await options.buildGate
  const index = await buildSourceUnitIndexFromFiles(paths)
  index.cacheHit = false
  index.cacheElapsedMs = Date.now() - startedAt
  await writeSourceIndexCache(options.cachePath, fingerprint, index)
  return index
}

/**
 * Build a focused source index from files matching requested unit names across the
 * supplied roots.
 */
async function buildSourceUnitIndexForUnits(rootPaths: string[], unitNames: string[]) {
  const discovered = await Promise.all(
    rootPaths.map(
      /** Discover requested unit filenames under each supplied source root. */ (
        rootPath: string,
      ) => findPascalUnitFilesByName(rootPath, unitNames),
    ),
  )
  return buildSourceUnitIndexFromFiles(discovered.flat())
}

/**
 * Merge symbols, files, units, type/member definitions, and counts into a target index
 * while deduplicating source identities.
 */
function mergeSourceUnitIndexes(
  target: SourceIndex,
  ...sources: SourceIndex[]
): SourceIndex {
  /**
   * Append source definition arrays into an index Map while suppressing definitions
   * already present by canonical source identity.
   */
  const mergeArrayMap = (
    targetMap: Map<string, SourceDefinition[]>,
    sourceMap: Map<string, SourceDefinition[]>,
  ) => {
    for (const [key, values] of sourceMap) {
      if (!targetMap.has(key)) targetMap.set(key, [])
      const existing = targetMap.get(key)!
      const identities = new Set(
        existing.map(
          /**
           * Identify existing definitions by file, offset, kind, and symbol before
           * merging.
           */ (value: SourceDefinition) =>
            `${String(value.filePath || "").toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`,
        ),
      )
      for (const value of values) {
        const identity = `${String(value.filePath || "").toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`
        if (identities.has(identity)) continue
        identities.add(identity)
        existing.push(value)
      }
    }
  }
  for (const source of sources) {
    if (!source) continue
    if (target.files && source.files) {
      for (const filePath of source.files) target.files.add(filePath)
      target.fileCount = target.files.size
    } else {
      target.fileCount += source.fileCount
    }
    for (const [key, values] of source.symbols) {
      if (!target.symbols.has(key)) target.symbols.set(key, new Set())
      for (const value of values) target.symbols.get(key)!.add(value)
    }
    mergeArrayMap(target.definitions, source.definitions)
    mergeArrayMap(target.types, source.types)
    mergeArrayMap(target.units, source.units)
    for (const [owner, sourceMembers] of source.members) {
      if (!target.members.has(owner)) target.members.set(owner, new Map())
      mergeArrayMap(target.members.get(owner)!, sourceMembers)
    }
  }
  return target
}

/**
 * Merge source indexes with the same identity rules as the synchronous merge, yielding
 * periodically for host responsiveness.
 */
async function mergeSourceUnitIndexesAsync(
  target: SourceIndex,
  ...sources: SourceIndex[]
): Promise<SourceIndex> {
  let operations = 0
  /**
   * Yield every bounded number of merge operations so large background index merges do
   * not monopolize the extension host.
   */
  const maybeYield = () => {
    // Yield in bounded chunks rather than per definition, balancing host responsiveness against scheduling overhead.
    operations += 1
    return operations % 256 === 0
      ? new Promise(
          /** Resolve after yielding once to the extension-host event loop. */ (
            resolve,
          ) => setImmediate(resolve),
        )
      : undefined
  }
  /**
   * Append source definition arrays into an index Map while suppressing definitions
   * already present by canonical source identity.
   */
  const mergeArrayMap = async (
    targetMap: Map<string, SourceDefinition[]>,
    sourceMap: Map<string, SourceDefinition[]>,
  ) => {
    for (const [key, values] of sourceMap) {
      if (!targetMap.has(key)) targetMap.set(key, [])
      const existing = targetMap.get(key)!
      const identities = new Set(
        existing.map(
          /**
           * Identify existing definitions by file, offset, kind, and symbol before
           * merging.
           */ (value: SourceDefinition) =>
            `${String(value.filePath || "").toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`,
        ),
      )
      for (const value of values) {
        const identity = `${String(value.filePath || "").toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`
        if (identities.has(identity)) continue
        identities.add(identity)
        existing.push(value)
      }
      const pause = maybeYield()
      if (pause) await pause
    }
  }
  for (const source of sources) {
    if (!source) continue
    if (target.files && source.files) {
      for (const filePath of source.files) target.files.add(filePath)
      target.fileCount = target.files.size
    } else {
      target.fileCount += source.fileCount
    }
    for (const [key, values] of source.symbols) {
      if (!target.symbols.has(key)) target.symbols.set(key, new Set())
      for (const value of values) target.symbols.get(key)!.add(value)
      const pause = maybeYield()
      if (pause) await pause
    }
    await mergeArrayMap(target.definitions, source.definitions)
    await mergeArrayMap(target.types, source.types)
    await mergeArrayMap(target.units, source.units)
    for (const [owner, sourceMembers] of source.members) {
      if (!target.members.has(owner)) target.members.set(owner, new Map())
      await mergeArrayMap(target.members.get(owner)!, sourceMembers)
    }
  }
  return target
}

/**
 * Extract an undeclared identifier from supported compiler/LSP message spellings,
 * returning undefined for unrelated diagnostics.
 */
function unknownSymbolFromDiagnostic(message: string) {
  return new RegExp(
    "\\b(?:unknown (?:identifier|" +
      PascalKeyword.Type +
      ")|undeclared identifier|identifier " +
      PascalKeyword.Not +
      " found)\\b[^'\"]*['\"]([A-Za-z_][A-Za-z0-9_]*)['\"]",
    "i",
  ).exec(message)?.[1]
}

/**
 * Collect the original offsets of routine-heading identifiers so missing-unit scans do
 * not treat declarations as unresolved uses.
 */
function pascalRoutineDeclarationIdentifierOffsets(code: string) {
  const offsets = new Set<number>()
  const declarationPattern = new RegExp(
    "^\\s*(?:" +
      PascalKeyword.Class +
      "\\s+)?(?:" +
      PascalKeyword.Function +
      "|" +
      PascalKeyword.Procedure +
      "|" +
      PascalKeyword.Constructor +
      "|" +
      PascalKeyword.Destructor +
      "|" +
      PascalKeyword.Operator +
      ")\\s+([A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>\\r\\n]*>)?(?:\\s*\\.\\s*[A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>\\r\\n]*>)?)*)",
    "gim",
  )
  for (const declaration of code.matchAll(declarationPattern)) {
    const name = declaration[1]
    const nameOffset = declaration.index + declaration[0].indexOf(name)

    // Names in `function TFoo<T>.IsValid: Boolean` are declarations, not type
    // references, even when a name happens to begin with T or I.
    for (const segment of name.matchAll(/(?:^|\.)\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
      offsets.add(nameOffset + segment.index + segment[0].lastIndexOf(segment[1]))
    }

    // Generic parameters are declarations too. Keep constraint types visible:
    // in `<TItem: IFoo>`, TItem is ignored while IFoo remains a real reference.
    for (const generic of name.matchAll(/<([^>]*)>/g)) {
      const body = generic[1]
      const bodyOffset = nameOffset + generic.index + generic[0].indexOf(body)
      let groupOffset = 0
      for (const group of body.split(";")) {
        const parameterNames = group.split(":", 1)[0]
        for (const parameter of parameterNames.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          offsets.add(bodyOffset + groupOffset + parameter.index)
        }
        groupOffset += group.length + 1
      }
    }
  }
  return offsets
}

/**
 * Test whether a source offset names a routine declaration, reusing masked code when
 * supplied.
 */
function isPascalRoutineDeclarationIdentifier(
  text: string,
  offset: number,
  preparedCode?: string,
) {
  const code = preparedCode || maskPascalNonCode(text)
  return pascalRoutineDeclarationIdentifierOffsets(code).has(offset)
}

/**
 * Read the lowercase unit identity from masked source text, returning undefined for
 * non-unit sources.
 */
function pascalUnitNameFromCode(code: string) {
  return new RegExp(
    "\\b" + PascalKeyword.Unit + "\\s+([A-Za-z_][A-Za-z0-9_.]*)\\s*;",
    "i",
  )
    .exec(code)?.[1]
    ?.toLowerCase()
}

/**
 * Build a unit-visibility predicate that distinguishes qualified uses from unqualified
 * leaf-name imports.
 */
function usedUnitVisibility(usedUnits: Set<string>) {
  const exact = new Set<string>()
  const unqualifiedLeaves = new Set<string>()
  const allLeaves = new Set<string>()
  for (const unitName of usedUnits || []) {
    const key = String(unitName || "").toLowerCase()
    if (!key) continue
    exact.add(key)
    allLeaves.add(key.split(".").at(-1)!)
    if (!key.includes(".")) unqualifiedLeaves.add(key)
  }
  return (
    /** Test unit visibility using exact names and Pascal unqualified namespace matching rules. */
    (unitName: string) => {
      const key = String(unitName || "").toLowerCase()
      if (!key) return false
      if (exact.has(key)) return true
      const leaf = key.split(".").at(-1)!
      if (unqualifiedLeaves.has(leaf)) return true
      return !key.includes(".") && allLeaves.has(leaf)
    }
  )
}

/**
 * Find known symbols missing a visible owning unit, excluding type/routine
 * declarations, member accesses, and intrinsic names.
 */
function findMissingUnitReferences(
  text: string,
  symbolIndex: Map<string, Set<string>>,
) {
  const code = maskPascalNonCode(text)
  const routineDeclarationOffsets = pascalRoutineDeclarationIdentifierOffsets(code)
  const usedUnits = new Set(parseUsesUnits(text))
  // Delphi implicitly imports System into every program and unit. Symbols such
  // as TObject must never produce an Add Unit diagnostic.
  usedUnits.add("system")
  const ownUnit = pascalUnitNameFromCode(code)
  const unitIsVisible = usedUnitVisibility(usedUnits)
  const declared = new Set()
  for (const match of code.matchAll(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^=\r\n]*>)?\s*=\s*/gim,
  )) {
    declared.add(match[1].toLowerCase())
  }

  const references = []
  let scannedOffset = 0
  let previousNonWhitespace = -1
  for (const match of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    while (scannedOffset < match.index) {
      if (!/\s/.test(code[scannedOffset])) previousNonWhitespace = scannedOffset
      scannedOffset += 1
    }
    const key = match[0].toLowerCase()
    if (
      declared.has(key) ||
      isPascalIntrinsicIdentifier(key) ||
      routineDeclarationOffsets.has(match.index)
    )
      continue
    // This used to slice and rescan the whole prefix for every identifier.
    // On a 1.5 MB Unit that is O(n²) and blocked the extension host for
    // 6–8 minutes. The monotonic cursor computes the same fact in one pass.
    if (previousNonWhitespace >= 0 && code[previousNonWhitespace] === ".") continue
    const candidates = filterAddUnitCandidates(symbolIndex.get(key), ownUnit)
    if (candidates.length === 0 || candidates.some(unitIsVisible)) continue
    references.push({
      offset: match.index,
      length: match[0].length,
      symbol: match[0],
      units: candidates,
    })
  }
  return references
}

/**
 * Collect nonintrinsic, non-routine-declaration identifiers whose candidate owning
 * unit is current or visible through uses.
 */
function findKnownUnitReferences(text: string, symbolIndex: Map<string, Set<string>>) {
  const code = maskPascalNonCode(text)
  const routineDeclarationOffsets = pascalRoutineDeclarationIdentifierOffsets(code)
  const usedUnits = new Set(parseUsesUnits(text))
  usedUnits.add("system")
  const ownUnit = pascalUnitNameFromCode(code)
  const unitIsVisible = usedUnitVisibility(usedUnits)
  const references = []
  for (const match of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const key = match[0].toLowerCase()
    if (isPascalIntrinsicIdentifier(key) || routineDeclarationOffsets.has(match.index))
      continue
    const candidates = symbolIndex.get(key)
    if (!candidates) continue
    if (
      ![...candidates].some(
        /** Accept candidates owned by the current unit or a visible imported unit. */ (
          unitName,
        ) => pascalUnitNamesEquivalent(unitName, ownUnit) || unitIsVisible(unitName),
      )
    )
      continue
    references.push({ offset: match.index, length: match[0].length, symbol: match[0] })
  }
  return references
}

/**
 * Plan a non-destructive unit addition in the applicable interface/implementation uses
 * clause, avoiding duplicates and preserving nearby indentation and separators.
 */
function planUsesInsertion(text: string, diagnosticOffset: number, unitName: string) {
  if (
    !unitName ||
    isImplicitPascalUnit(unitName) ||
    parseUsesUnits(text).some(
      /**
       * Reject a uses insertion when the unit is already imported under an equivalent
       * name.
       */ (usedUnit) => pascalUnitNamesEquivalent(unitName, usedUnit),
    )
  )
    return undefined
  const code = maskPascalNonCode(text)
  const eol = text.includes("\r\n") ? "\r\n" : "\n"
  const interfaceMatch = new RegExp("\\b" + PascalKeyword.Interface + "\\b", "i").exec(
    code,
  )
  const implementationMatch = new RegExp(
    "\\b" + PascalKeyword.Implementation + "\\b",
    "i",
  ).exec(code)
  let sectionStart = 0
  let sectionEnd = code.length
  let useImplementation = false

  if (interfaceMatch) {
    useImplementation = Boolean(
      implementationMatch && diagnosticOffset > implementationMatch.index,
    )
    sectionStart =
      useImplementation && implementationMatch
        ? implementationMatch.index
        : interfaceMatch.index
    sectionEnd =
      useImplementation || !implementationMatch
        ? code.length
        : implementationMatch.index
  }

  const insertionForUses = /**
   * Insert a unit before the uses semicolon while preserving multiline indentation and
   * trailing commas.
   */ (usesMatch: RegExpExecArray, baseOffset: number) => {
    const semicolonOffset = baseOffset + usesMatch.index + usesMatch[0].lastIndexOf(";")
    const actualClause = text.slice(baseOffset + usesMatch.index, semicolonOffset)
    const trailingComma = /,\s*$/.test(actualClause)
    if (/\r?\n/.test(actualClause)) {
      const indentation = /(?:^|\r?\n)([ \t]+)[^\r\n]*$/.exec(actualClause)?.[1] || "  "
      return {
        offset: semicolonOffset,
        text: `${trailingComma ? "" : ","}${eol}${indentation}${unitName}`,
      }
    }
    return { offset: semicolonOffset, text: `${trailingComma ? "" : ","} ${unitName}` }
  }

  const section = code.slice(sectionStart, sectionEnd)
  const usesMatch = new RegExp(
    "\\b" + PascalKeyword.Uses + "\\b([\\s\\S]*?);",
    "i",
  ).exec(section)
  if (usesMatch) {
    return insertionForUses(usesMatch, sectionStart)
  }
  if (useImplementation && interfaceMatch && implementationMatch) {
    const interfaceSection = code.slice(interfaceMatch.index, implementationMatch.index)
    const interfaceUses = new RegExp(
      "\\b" + PascalKeyword.Uses + "\\b([\\s\\S]*?);",
      "i",
    ).exec(interfaceSection)
    if (interfaceUses) return insertionForUses(interfaceUses, interfaceMatch.index)
  }

  let anchor
  if (interfaceMatch) {
    anchor =
      useImplementation && implementationMatch ? implementationMatch : interfaceMatch
  } else {
    anchor = new RegExp(
      "\\b(?:" +
        PascalKeyword.Program +
        "|" +
        PascalKeyword.Library +
        "|" +
        PascalKeyword.Package +
        ")\\s+[A-Za-z_][A-Za-z0-9_.]*\\s*;",
      "i",
    ).exec(code)
  }
  if (!anchor) return undefined
  const lineEnd = text.indexOf("\n", anchor.index + anchor[0].length)
  const offset = lineEnd < 0 ? anchor.index + anchor[0].length : lineEnd + 1
  return { offset, text: `${eol}uses${eol}  ${unitName};${eol}` }
}

export {
  buildDcpSymbolIndex,
  buildSourceUnitIndex,
  buildSourceUnitIndexForUnits,
  mergeSourceUnitIndexes,
  mergeSourceUnitIndexesAsync,
  filterAddUnitCandidates,
  findSourceMemberDefinitions,
  findKnownUnitReferences,
  findMissingUnitReferences,
  findPascalUnitFiles,
  isImplicitPascalUnit,
  isPascalIntrinsicIdentifier,
  isPascalRoutineDeclarationIdentifier,
  pascalUnitNamesEquivalent,
  parseSourceUnitSymbols,
  planUsesInsertion,
  selectBestPascalDefinitions,
  sourceTypeUnitIndex,
  unknownSymbolFromDiagnostic,
}
