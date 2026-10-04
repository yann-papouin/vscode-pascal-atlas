import {
  CompiledSymbolKind,
  CompiledMemberKind,
  PascalBuiltinName,
} from "./shared/symbols"
import type {
  CompiledClass,
  CompiledGlobal,
  CompiledRoutine,
  CompiledInfo,
  CompiledMemberOwner,
  CompiledMethod,
  CompiledProperty,
  CompiledUnit,
  CompiledPackageIndex,
  KnownCompiledMember,
  ObservedMemberIndex,
  PascalTypeInferenceIndex,
  InferenceEntry,
  RoutineInferenceScope,
  PascalUsesRange,
} from "./shared/compiledModels"
import { PascalKeyword } from "./shared/pascal"
import { FileExtension, LexerState } from "./shared/identifiers"
import * as fs from "node:fs"
import * as path from "node:path"

const PASCAL_INDEX_DEREFERENCE = "[]"

const IGNORED_DIRECTORY_NAMES = new Set<string>([
  ".git",
  ".hg",
  ".svn",
  ".vsdcache",
  "node_modules",
])

async function findCompiledPackageFiles(rootPath: string, extension: string) {
  const results = []
  const pending = [rootPath]

  while (pending.length > 0) {
    const batch = pending.splice(0, 16)
    const listings = await Promise.all(
      batch.map(async (directory) => {
        try {
          return [
            directory,
            await fs.promises.readdir(directory, { withFileTypes: true }),
          ] as const
        } catch {
          return [directory, []] as const
        }
      }),
    )

    for (const [directory, entries] of listings) {
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORY_NAMES.has(entry.name.toLowerCase()))
            pending.push(fullPath)
        } else if (
          entry.isFile() &&
          path.extname(entry.name).toLowerCase() === extension
        ) {
          results.push(fullPath)
        }
      }
    }
  }

  return results
}

async function findBplFiles(rootPath: string) {
  return findCompiledPackageFiles(rootPath, FileExtension.CompiledPackage)
}

async function findDcpFiles(rootPath: string) {
  return findCompiledPackageFiles(rootPath, FileExtension.CompiledSymbols)
}

function maskPascalNonCode(text: string) {
  // Index this buffer by UTF-16 code unit, exactly like String#slice and regex
  // offsets. Spreading a string collapses surrogate pairs and shifts every
  // following source position when a comment contains a supplementary char.
  const result = text.split("")
  let state: string = LexerState.Code

  const blank = (index: number) => {
    if (result[index] !== "\r" && result[index] !== "\n") result[index] = " "
  }

  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]
    const next = text[index + 1]
    if (state === LexerState.Code) {
      if (current === "'") {
        blank(index)
        state = LexerState.String
      } else if (current === "/" && next === "/") {
        blank(index)
        blank(index + 1)
        index += 1
        state = "line-comment"
      } else if (current === "{") {
        blank(index)
        state = "brace-comment"
      } else if (current === "(" && next === "*") {
        blank(index)
        blank(index + 1)
        index += 1
        state = "paren-comment"
      }
    } else if (state === LexerState.String) {
      blank(index)
      if (current === "'" && next === "'") {
        blank(index + 1)
        index += 1
      } else if (current === "'") {
        state = LexerState.Code
      }
    } else if (state === "line-comment") {
      blank(index)
      if (current === "\r" || current === "\n") state = LexerState.Code
    } else if (state === "brace-comment") {
      blank(index)
      if (current === "}") state = LexerState.Code
    } else if (state === "paren-comment") {
      blank(index)
      if (current === "*" && next === ")") {
        blank(index + 1)
        index += 1
        state = LexerState.Code
      }
    }
  }

  return result.join("")
}

function declarationType(code: string, identifier: string) {
  const key = identifier.toLowerCase()
  let result
  for (const match of code.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/gi,
  )) {
    const names = match[1].split(",").map((item: string) => item.trim().toLowerCase())
    if (names.includes(key)) result = match[2]
  }
  return result
}

function inferPascalType(
  text: string,
  identifier: string,
  offset = text.length,
  preparedCode?: string,
  seenIdentifiers = new Set<string>(),
): string | undefined {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) return undefined
  const code = preparedCode || maskPascalNonCode(text)
  const key = identifier.toLowerCase()
  if (seenIdentifiers.has(key)) return undefined
  const resolving = new Set(seenIdentifiers)
  resolving.add(key)
  const prefix = code.slice(0, Math.max(0, Math.min(offset, code.length)))
  const routinePattern = new RegExp(
    "\\b(?:" +
      PascalKeyword.Class +
      "\\s+)?(?:" +
      PascalKeyword.Function +
      "|" +
      PascalKeyword.Procedure +
      "|" +
      PascalKeyword.Constructor +
      "|" +
      PascalKeyword.Destructor +
      ")\\s+([A-Za-z_][A-Za-z0-9_.]*)\\s*(?:\\(([\\s\\S]*?)\\))?\\s*(?::\\s*([A-Za-z_][A-Za-z0-9_.]*(?:\\s*<[^;=()]+>)?))?[^;]*;",
    "gi",
  )
  let routine
  let owningRoutine
  for (const match of prefix.matchAll(routinePattern)) {
    routine = match
    // A nested local routine has no qualified owner, but Delphi's Self still
    // refers to the surrounding class/helper method. Keep the most recent
    // qualified routine separately instead of losing it to the local routine.
    if (match[1].includes(".")) owningRoutine = match
  }
  if (routine) {
    const localType = declarationType(
      prefix.slice(routine.index + routine[0].length),
      identifier,
    )
    if (localType) return localType
    const parameterType = declarationType(routine[2] || "", identifier)
    if (parameterType) return parameterType
    if (key === PascalKeyword.Result && routine[3]) return routine[3]
  }
  if (key === PascalKeyword.Self && owningRoutine)
    return owningRoutine[1].split(".").at(-2)

  const precedingType = declarationType(prefix, identifier)
  if (precedingType) return precedingType
  const followingType = declarationType(code.slice(offset), identifier)
  if (followingType) return followingType

  // Delphi inline variables have no explicit declaration to index. Preserve
  // the constructor type and the common `GetXxxResList` convention used by
  // binary-only geometry APIs so later member-chain resolution can continue.
  // These names are only hints: callers still validate them against a source
  // or compiled type before returning a definition.
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const initializer = new RegExp(`\\bvar\\s+${escaped}\\s*:=\\s*([^;]+)`, "gi")
  let initializerMatch
  for (const match of prefix.matchAll(initializer)) initializerMatch = match
  if (initializerMatch) {
    const expression = initializerMatch[1].trim()
    const constructor =
      /^([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)\s*\.\s*Create\b/i.exec(expression)
    if (constructor) return constructor[1].replace(/\s+/g, "")

    const resultList =
      /\.\s*Get([A-Za-z_][A-Za-z0-9_]*?)ResList\s*(?:\([^;]*\))?\s*$/i.exec(expression)
    if (resultList) return `TList<T${resultList[1]}DiscreteRes>`

    const field = /^([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*F([A-Z][A-Za-z0-9_]*)\s*$/.exec(
      expression,
    )
    if (field) {
      const ownerType = inferPascalType(
        text,
        field[1],
        initializerMatch.index,
        code,
        resolving,
      )
      const ownerStem = pascalTypeBaseName(ownerType || "")
        .replace(/^T/, "")
        .replace(/(?:Discrete)?Res(?:ult)?$/, "")
      if (ownerStem) return `T${ownerStem}${field[2]}`
    }
  }

  // `for var Face in FaceList` inherits the generic element type. When the
  // list itself is an inline result of GetFaceResList, the initializer rule
  // above reconstructs TList<TFaceDiscreteRes> without package source.
  let collectionName
  for (const match of prefix.matchAll(
    new RegExp(
      "\\b" +
        PascalKeyword.For +
        "\\s+(?:" +
        PascalKeyword.Var +
        "\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s+" +
        PascalKeyword.In +
        "\\s+([A-Za-z_][A-Za-z0-9_]*)",
      "gi",
    ),
  )) {
    if (match[1].toLowerCase() === key) collectionName = match[2]
  }
  if (collectionName) {
    const collectionType = inferPascalType(
      text,
      collectionName,
      offset,
      code,
      resolving,
    )
    const elementType = inferPascalCollectionElementType(collectionType)
    if (elementType) return elementType
  }
  const cast = new RegExp(
    `\\b${escaped}\\s*:=[^;]*?\\bas\\s+([TI][A-Za-z0-9_]+)`,
    "i",
  ).exec(code)
  return cast?.[1]
}

function appendInferenceEntry(
  map: Map<string, InferenceEntry[]>,
  name: string,
  value: InferenceEntry,
) {
  const key = String(name || "").toLowerCase()
  if (!key) return
  if (!map.has(key)) map.set(key, [])
  map.get(key)!.push(value)
}

function inferenceEntryAt(
  entries: InferenceEntry[] | undefined,
  offset: number,
  minimumOffset = 0,
) {
  if (!entries?.length) return undefined
  let low = 0
  let high = entries.length - 1
  let candidate = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (entries[middle].offset <= offset) {
      candidate = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  const result = candidate >= 0 ? entries[candidate] : undefined
  return result && result.offset >= minimumOffset ? result : undefined
}

function firstInferenceEntryAfter(
  entries: InferenceEntry[] | undefined,
  offset: number,
) {
  if (!entries?.length) return undefined
  let low = 0
  let high = entries.length - 1
  let candidate = entries.length
  while (low <= high) {
    const middle = (low + high) >> 1
    if (entries[middle].offset > offset) {
      candidate = middle
      high = middle - 1
    } else {
      low = middle + 1
    }
  }
  return candidate < entries.length ? entries[candidate] : undefined
}

function declarationMap(value: string) {
  const result = new Map<string, string>()
  for (const match of String(value || "").matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/gi,
  )) {
    for (const name of match[1]
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)) {
      result.set(name.toLowerCase(), match[2])
    }
  }
  return result
}

function buildPascalTypeInferenceIndex(text: string, preparedCode?: string) {
  const code = preparedCode || maskPascalNonCode(text)
  const declarations = new Map<string, InferenceEntry[]>()
  const inlineInitializers = new Map<string, InferenceEntry[]>()
  const forInVariables = new Map<string, InferenceEntry[]>()
  const casts = new Map<string, InferenceEntry[]>()
  const routines: RoutineInferenceScope[] = []

  for (const match of code.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/gi,
  )) {
    for (const nameMatch of match[1].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      appendInferenceEntry(declarations, nameMatch[0], {
        offset: match.index + nameMatch.index,
        typeName: match[2],
      })
    }
  }

  const routinePattern = new RegExp(
    "\\b(?:" +
      PascalKeyword.Class +
      "\\s+)?(?:" +
      PascalKeyword.Function +
      "|" +
      PascalKeyword.Procedure +
      "|" +
      PascalKeyword.Constructor +
      "|" +
      PascalKeyword.Destructor +
      ")\\s+([A-Za-z_][A-Za-z0-9_.]*)\\s*(?:\\(([\\s\\S]*?)\\))?\\s*(?::\\s*([A-Za-z_][A-Za-z0-9_.]*(?:\\s*<[^;=()]+>)?))?[^;]*;",
    "gi",
  )
  let lastQualifiedOwner
  for (const match of code.matchAll(routinePattern)) {
    const parts = match[1].split(".")
    const owner = parts.length > 1 ? parts.at(-2) : undefined
    if (owner) lastQualifiedOwner = owner
    routines.push({
      offset: match.index,
      headerEnd: match.index + match[0].length,
      owner,
      selfOwner: owner || lastQualifiedOwner,
      returnType: match[3],
      parameters: declarationMap(match[2] || ""),
    })
  }

  for (const match of code.matchAll(
    new RegExp(
      "\\b" + PascalKeyword.Var + "\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:=\\s*([^;]+)",
      "gi",
    ),
  )) {
    appendInferenceEntry(inlineInitializers, match[1], {
      offset: match.index,
      expression: match[2].trim(),
    })
  }
  for (const match of code.matchAll(
    new RegExp(
      "\\b" +
        PascalKeyword.For +
        "\\s+(?:" +
        PascalKeyword.Var +
        "\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s+" +
        PascalKeyword.In +
        "\\s+([A-Za-z_][A-Za-z0-9_]*)",
      "gi",
    ),
  )) {
    appendInferenceEntry(forInVariables, match[1], {
      offset: match.index,
      collectionName: match[2],
    })
  }
  for (const match of code.matchAll(
    new RegExp(
      "\\b([A-Za-z_][A-Za-z0-9_]*)\\s*:=[^;]*?\\b" +
        PascalKeyword.As +
        "\\s+([TI][A-Za-z0-9_]+)",
      "gi",
    ),
  )) {
    appendInferenceEntry(casts, match[1], { offset: match.index, typeName: match[2] })
  }

  return {
    text,
    code,
    declarations,
    inlineInitializers,
    forInVariables,
    casts,
    routines,
  }
}

function collectPascalInlineVariableNames(text: string, preparedCode?: string) {
  const code = preparedCode || maskPascalNonCode(text)
  const result = new Set<string>()
  for (const match of code.matchAll(
    new RegExp("\\b" + PascalKeyword.Var + "\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*:=", "gi"),
  )) {
    result.add(match[1].toLowerCase())
  }
  for (const match of code.matchAll(
    new RegExp(
      "\\b" +
        PascalKeyword.For +
        "\\s+" +
        PascalKeyword.Var +
        "\\s+([A-Za-z_][A-Za-z0-9_]*)\\s+" +
        PascalKeyword.In +
        "\\b",
      "gi",
    ),
  )) {
    result.add(match[1].toLowerCase())
  }
  return result
}

function routineInferenceScopeAt(index: PascalTypeInferenceIndex, offset: number) {
  const routines = index?.routines || []
  let low = 0
  let high = routines.length - 1
  let candidate = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (routines[middle].offset <= offset) {
      candidate = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return candidate >= 0 ? routines[candidate] : undefined
}

function inferPascalTypeFromIndex(
  index: PascalTypeInferenceIndex,
  identifier: string,
  offset = index.code.length,
  seenIdentifiers = new Set<string>(),
): string | undefined {
  if (!index || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) return undefined
  const key = identifier.toLowerCase()
  if (seenIdentifiers.has(key)) return undefined
  const resolving = new Set(seenIdentifiers)
  resolving.add(key)
  const scope = routineInferenceScopeAt(index, offset)
  const scopeStart = scope?.headerEnd || 0
  const localDeclaration = inferenceEntryAt(
    index.declarations.get(key),
    offset,
    scopeStart,
  )
  if (localDeclaration) return localDeclaration.typeName
  const parameterType = scope?.parameters.get(key)
  if (parameterType) return parameterType
  if (key === PascalKeyword.Result && scope?.returnType) return scope.returnType
  if (key === PascalKeyword.Self && scope?.selfOwner) return scope.selfOwner

  const precedingDeclaration = inferenceEntryAt(index.declarations.get(key), offset)
  if (precedingDeclaration) return precedingDeclaration.typeName

  const initializer = inferenceEntryAt(
    index.inlineInitializers.get(key),
    offset,
    scopeStart,
  )
  if (initializer) {
    const constructor =
      /^([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)\s*\.\s*Create\b/i.exec(
        initializer.expression || "",
      )
    if (constructor) return constructor[1].replace(/\s+/g, "")
    const resultList =
      /\.\s*Get([A-Za-z_][A-Za-z0-9_]*?)ResList\s*(?:\([^;]*\))?\s*$/i.exec(
        initializer.expression || "",
      )
    if (resultList) return `TList<T${resultList[1]}DiscreteRes>`
    const field = /^([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*F([A-Z][A-Za-z0-9_]*)\s*$/.exec(
      initializer.expression || "",
    )
    if (field) {
      const ownerType = inferPascalTypeFromIndex(
        index,
        field[1],
        initializer.offset,
        resolving,
      )
      const ownerStem = pascalTypeBaseName(ownerType || "")
        .replace(/^T/, "")
        .replace(/(?:Discrete)?Res(?:ult)?$/, "")
      if (ownerStem) return `T${ownerStem}${field[2]}`
    }
  }

  const forIn = inferenceEntryAt(index.forInVariables.get(key), offset, scopeStart)
  if (forIn) {
    const collectionType = inferPascalTypeFromIndex(
      index,
      forIn.collectionName || "",
      forIn.offset,
      resolving,
    )
    const elementType = inferPascalCollectionElementType(collectionType)
    if (elementType) return elementType
  }
  const cast =
    inferenceEntryAt(index.casts.get(key), offset, scopeStart) ||
    inferenceEntryAt(index.casts.get(key), offset)
  if (cast) return cast.typeName
  return firstInferenceEntryAfter(index.declarations.get(key), offset)?.typeName
}

function pascalForInCollectionFromIndex(
  index: PascalTypeInferenceIndex,
  identifier: string,
  offset = index.code.length,
) {
  if (!index) return undefined
  const scope = routineInferenceScopeAt(index, offset)
  return inferenceEntryAt(
    index.forInVariables.get(String(identifier || "").toLowerCase()),
    offset,
    scope?.headerEnd || 0,
  )?.collectionName
}

function inferPascalInitializerRoutine(
  text: string,
  identifier: string,
  offset = text.length,
  preparedCode?: string,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) return undefined
  const code = preparedCode || maskPascalNonCode(text)
  const prefix = code.slice(0, Math.max(0, Math.min(offset, code.length)))
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const assignment = new RegExp(
    `\\b(?:var\\s+)?${escaped}\\s*:=\\s*([A-Za-z_][A-Za-z0-9_.]*)\\s*\\(`,
    "gi",
  )
  let result
  for (const match of prefix.matchAll(assignment)) result = match[1].split(".").at(-1)
  return result
}

function isPascalMemberReference(text: string, offset: number, preparedCode?: string) {
  const code = preparedCode || maskPascalNonCode(text)
  let cursor = Math.max(0, Math.min(offset, code.length)) - 1
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
  return code[cursor] === "."
}

function splitPascalGenericArguments(value: string) {
  const result = []
  let start = 0
  let depth = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "<") depth += 1
    else if (value[index] === ">") depth = Math.max(0, depth - 1)
    else if (value[index] === "," && depth === 0) {
      result.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  result.push(value.slice(start).trim())
  return result.filter(Boolean)
}

function parsePascalTypeReference(value: unknown) {
  const text = String(value || "").trim()
  const open = text.indexOf("<")
  if (open < 0 || !text.endsWith(">")) return { base: text, arguments: [] }
  return {
    base: text.slice(0, open).trim(),
    arguments: splitPascalGenericArguments(text.slice(open + 1, -1)),
  }
}

function pascalTypeBaseName(value: unknown): string {
  return parsePascalTypeReference(value).base.split(".").at(-1) || ""
}

function substitutePascalTypeParameters(
  value: string,
  parameters: readonly string[],
  receiverType: string,
) {
  let result = String(value || "").trim()
  const receiver = parsePascalTypeReference(receiverType)
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]
    const argument = receiver.arguments[index]
    if (!argument) continue
    result = result.replace(
      new RegExp(`\\b${parameter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
      argument,
    )
  }
  return result
}

function inferPascalCollectionElementType(
  collectionType: string | undefined,
): string | undefined {
  const parsed = parsePascalTypeReference(collectionType)
  if (parsed.arguments.length === 0) return undefined
  const base = parsed.base.split(".").at(-1) || ""
  if (/^(?:TArray|TList|TObjectList|TEnumerable|IEnumerable)$/i.test(base)) {
    return parsed.arguments[0]
  }
  if (/Array$/i.test(base) && base.length > "Array".length) {
    return `${base.slice(0, -"Array".length)}<${parsed.arguments.join(", ")}>`
  }
  return undefined
}

function pascalRoutineReturnType(signature: string | undefined) {
  const text = String(signature || "").trim()
  if (
    !new RegExp(
      "^(?:" + PascalKeyword.Class + "\\s+)?" + PascalKeyword.Function + "\\b",
      "i",
    ).test(text)
  )
    return undefined
  const close = text.lastIndexOf(")")
  const tail =
    close >= 0
      ? text.slice(close + 1)
      : text.replace(
          new RegExp(
            "^(?:" +
              PascalKeyword.Class +
              "\\s+)?" +
              PascalKeyword.Function +
              "\\s+[A-Za-z_][A-Za-z0-9_]*(?:\\s*<[^>]*>)?",
            "i",
          ),
          "",
        )
  return /^\s*:\s*([^;]+)\s*;/i.exec(tail)?.[1].trim()
}

function pascalMemberChainBefore(text: string, offset: number, preparedCode?: string) {
  const code = preparedCode || maskPascalNonCode(text)
  let cursor = Math.max(0, Math.min(offset, code.length)) - 1
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
  // Most identifiers are not member accesses. Reject them in constant time;
  // the old implementation copied and regex-scanned the entire file prefix
  // even for these identifiers, which made large units quadratic.
  if (code[cursor] !== ".") return []
  const reversed = []
  while (cursor >= 0 && code[cursor] === ".") {
    cursor -= 1
    while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
    let followedCall = false
    // Preserve postfix indexing while skipping its expression. Calls and
    // explicit Delphi casts are skipped in the same balanced way, but their
    // identifier remains the receiver (`GetItem(...).Name` / `TItem(...).Name`).
    while (cursor >= 0 && (code[cursor] === "]" || code[cursor] === ")")) {
      const close = code[cursor]
      const open = close === "]" ? "[" : "("
      let depth = 1
      cursor -= 1
      while (cursor >= 0 && depth > 0) {
        if (code[cursor] === close) depth += 1
        else if (code[cursor] === open) depth -= 1
        cursor -= 1
      }
      if (depth !== 0) return []
      if (close === "]") reversed.push(PASCAL_INDEX_DEREFERENCE)
      else followedCall = true
      while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
    }
    // A static generic receiver ends in `>` rather than an identifier:
    // `TList<TItem>.Create`. Skip the balanced type arguments locally and keep
    // the base Pascal type as the receiver without scanning the file prefix.
    if (code[cursor] === ">") {
      let depth = 1
      cursor -= 1
      while (cursor >= 0 && depth > 0) {
        if (code[cursor] === ">") depth += 1
        else if (code[cursor] === "<") depth -= 1
        cursor -= 1
      }
      if (depth !== 0) return []
      while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
    }
    const end = cursor + 1
    while (cursor >= 0 && /[A-Za-z0-9_]/.test(code[cursor])) cursor -= 1
    const start = cursor + 1
    if (start >= end || !/[A-Za-z_]/.test(code[start])) return []
    const identifier = code.slice(start, end)
    reversed.push(identifier)
    while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1
    // A type-like callable is an explicit cast. Its argument expression is not
    // part of the receiver chain; keeping a preceding Unit qualifier here
    // would make `Unit.TItem(Value).Name` resolve Unit as the object instead.
    if (followedCall && /^[TI](?:[A-Z0-9_])/.test(identifier)) break
  }
  return reversed.reverse()
}

function collectPascalUnitIdentifierOffsets(
  text: string,
  usedUnits = parseUsesUnits(text),
  preparedCode?: string,
) {
  const code = preparedCode || maskPascalNonCode(text)
  const offsets = new Set<number>()
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const addIdentifiers = (value: string, baseOffset: number) => {
    for (const identifier of value.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      offsets.add(baseOffset + identifier.index)
    }
  }

  const usesSections = [
    ...code.matchAll(new RegExp("\\b" + PascalKeyword.Uses + "\\b([\\s\\S]*?);", "gi")),
  ]
  for (const unitName of usedUnits) {
    const parts = unitName.split(".").filter(Boolean)
    if (parts.length === 0) continue
    const unitExpression = parts.map(escape).join("\\s*\\.\\s*")
    const exactUnit = new RegExp(`\\b${unitExpression}(?![A-Za-z0-9_])`, "gi")
    for (const section of usesSections) {
      const bodyOffset = section.index + section[0].indexOf(section[1])
      for (const match of section[1].matchAll(exactUnit)) {
        addIdentifiers(match[0], bodyOffset + match.index)
      }
    }

    // Outside a uses clause, a unit name is meaningful only as a complete
    // qualifier (for example CH.Database.TCHDatabase or fsApplc.AppSys).
    const qualifier = new RegExp(`\\b${unitExpression}\\s*\\.`, "gi")
    for (const match of code.matchAll(qualifier)) addIdentifiers(match[0], match.index)
  }
  return offsets
}

function collectPascalUsesUnitRanges(
  text: string,
  usedUnits = parseUsesUnits(text),
  preparedCode?: string,
) {
  const code = preparedCode || maskPascalNonCode(text)
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const usesSections = [
    ...code.matchAll(new RegExp("\\b" + PascalKeyword.Uses + "\\b([\\s\\S]*?);", "gi")),
  ]
  const ranges = []
  for (const unitName of [...usedUnits].sort(
    (left, right) => right.length - left.length,
  )) {
    const parts = unitName.split(".").filter(Boolean)
    if (parts.length === 0) continue
    const unitExpression = parts.map(escape).join("\\s*\\.\\s*")
    const exactUnit = new RegExp(
      `\\b${unitExpression}(?!\\s*\\.)(?![A-Za-z0-9_])`,
      "gi",
    )
    for (const section of usesSections) {
      const bodyOffset = section.index + section[0].indexOf(section[1])
      for (const match of section[1].matchAll(exactUnit)) {
        const start = bodyOffset + match.index
        const end = start + match[0].length
        ranges.push({ unitName, start, end })
      }
    }
  }
  return ranges.sort((left, right) => left.start - right.start)
}

function findPascalUsesUnitAt(
  text: string,
  offset: number,
  usedUnits = parseUsesUnits(text),
  preparedCode?: string,
  ranges?: PascalUsesRange[],
) {
  return (ranges || collectPascalUsesUnitRanges(text, usedUnits, preparedCode)).find(
    (item: { start: number; end: number }) => offset >= item.start && offset < item.end,
  )
}

function findPascalDeclaration(
  text: string,
  identifier: string,
  offset = text.length,
  preparedCode?: string,
) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) return undefined
  const code = preparedCode || maskPascalNonCode(text)
  const key = identifier.toLowerCase()
  const declarations = []
  for (const match of code.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/gi,
  )) {
    const namesText = match[1]
    for (const nameMatch of namesText.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (nameMatch[0].toLowerCase() !== key) continue
      declarations.push({
        offset: match.index + nameMatch.index,
        length: nameMatch[0].length,
        typeName: match[2],
      })
    }
  }
  const before = declarations.filter((item) => item.offset <= offset)
  return before.at(-1) || declarations[0]
}

function findPascalCallAt(text: string, offset = text.length, preparedCode?: string) {
  const code = preparedCode || maskPascalNonCode(text)
  let nested = 0
  let openOffset = -1
  for (let index = Math.min(offset, code.length) - 1; index >= 0; index -= 1) {
    if (code[index] === ")") nested += 1
    else if (code[index] === "(") {
      if (nested === 0) {
        openOffset = index
        break
      }
      nested -= 1
    }
  }
  if (openOffset < 0) return undefined
  const before = code.slice(0, openOffset)
  const invocation =
    /(?:(\b[A-Za-z_][A-Za-z0-9_]*)\s*\.\s*)?\b([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before)
  if (!invocation) return undefined
  let activeParameter = 0
  let parentheses = 0
  let brackets = 0
  let angles = 0
  for (let index = openOffset + 1; index < Math.min(offset, code.length); index += 1) {
    const value = code[index]
    if (value === "(") parentheses += 1
    else if (value === ")") parentheses = Math.max(0, parentheses - 1)
    else if (value === "[") brackets += 1
    else if (value === "]") brackets = Math.max(0, brackets - 1)
    else if (value === "<") angles += 1
    else if (value === ">") angles = Math.max(0, angles - 1)
    else if (value === "," && parentheses === 0 && brackets === 0 && angles === 0)
      activeParameter += 1
  }
  return {
    name: invocation[2],
    qualifier: invocation[1],
    nameOffset: invocation.index + invocation[0].lastIndexOf(invocation[2]),
    openOffset,
    activeParameter,
  }
}

function splitSignatureParameters(signature: string) {
  const open = signature.indexOf("(")
  if (open < 0) return []
  let parentheses = 0
  let brackets = 0
  let angles = 0
  let close = -1
  const separators = []
  for (let index = open + 1; index < signature.length; index += 1) {
    const value = signature[index]
    if (value === "(") parentheses += 1
    else if (value === ")") {
      if (parentheses === 0 && brackets === 0 && angles === 0) {
        close = index
        break
      }
      parentheses = Math.max(0, parentheses - 1)
    } else if (value === "[") brackets += 1
    else if (value === "]") brackets = Math.max(0, brackets - 1)
    else if (value === "<") angles += 1
    else if (value === ">") angles = Math.max(0, angles - 1)
    else if (
      (value === "," || value === ";") &&
      parentheses === 0 &&
      brackets === 0 &&
      angles === 0
    )
      separators.push(index)
  }
  if (close < 0) return []
  const result = []
  let start = open + 1
  for (const end of [...separators, close]) {
    const value = signature.slice(start, end).trim()
    if (value) result.push(value)
    start = end + 1
  }
  return result
}

function extractPascalRoutineSignature(
  text: string,
  symbolOffset: number,
  preparedCode?: string,
) {
  const code = preparedCode || maskPascalNonCode(text)
  const lineStart = Math.max(0, code.lastIndexOf("\n", symbolOffset) + 1)
  const prefix = code.slice(lineStart, symbolOffset)
  const routine = new RegExp(
    "\\b(?:" +
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
      ")\\b",
    "i",
  ).exec(prefix)
  if (!routine) return undefined
  const start = lineStart + routine.index
  let parentheses = 0
  let end = -1
  for (let index = start; index < Math.min(code.length, start + 8192); index += 1) {
    if (code[index] === "(") parentheses += 1
    else if (code[index] === ")") parentheses = Math.max(0, parentheses - 1)
    else if (code[index] === ";" && parentheses === 0) {
      end = index + 1
      break
    }
  }
  if (end < 0) return undefined
  return text.slice(start, end).replace(/\s+/g, " ").trim()
}

function parseUsesUnits(text: string, preparedCode?: string) {
  const units = new Set<string>()
  const expression = new RegExp("\\b" + PascalKeyword.Uses + "\\s+([\\s\\S]*?);", "gi")
  for (const match of (preparedCode || maskPascalNonCode(text)).matchAll(expression)) {
    for (const item of match[1].split(",")) {
      const name = /^\s*([A-Za-z_][\w.]*)/.exec(item)?.[1]
      if (name) units.add(name.toLowerCase())
    }
  }
  return [...units]
}

function parseObservedMemberReferences(
  text: string,
  result: ObservedMemberIndex = new Map(),
) {
  const code = maskPascalNonCode(text)
  for (const match of code.matchAll(
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g,
  )) {
    const qualifier = match[1].toLowerCase()
    const member = match[2].toLowerCase()
    if (!result.has(qualifier)) result.set(qualifier, new Map())
    if (!result.get(qualifier)!.has(member))
      result.get(qualifier)!.set(member, match[2])
  }
  return result
}

function knownCompiledMembers(
  classInfo: CompiledMemberOwner,
  observedMembers: CompiledMethod[] = [],
): Map<string, KnownCompiledMember> {
  const result = new Map<string, KnownCompiledMember>()
  for (const method of classInfo?.methods || []) {
    const abiName = method.name.toLowerCase()
    const className = classInfo.symbol.toLowerCase()
    const name =
      abiName === className
        ? PascalBuiltinName.Create
        : abiName === `~${className}`
          ? PascalBuiltinName.Destroy
          : method.name
    const kind =
      abiName === className
        ? CompiledMemberKind.Constructor
        : abiName === `~${className}`
          ? CompiledMemberKind.Destructor
          : CompiledMemberKind.Method
    const value =
      name === method.name ? method : { ...method, name, abiName: method.name }
    const key = name.toLowerCase()
    if (!result.has(key)) result.set(key, { name, kind, value })
  }
  for (const property of classInfo?.properties || []) {
    const key = property.name.toLowerCase()
    if (!result.has(key))
      result.set(key, {
        name: property.name,
        kind: CompiledMemberKind.Property,
        value: property,
      })
  }
  for (const member of classInfo?.rttiMembers || []) {
    const key = member.name.toLowerCase()
    if (!result.has(key))
      result.set(key, {
        name: member.name,
        kind: CompiledMemberKind.Rtti,
        value: member,
      })
  }
  for (const member of observedMembers) {
    const key = member.name.toLowerCase()
    if (!result.has(key))
      result.set(key, {
        name: member.name,
        kind: CompiledMemberKind.Observed,
        value: member,
      })
  }
  return result
}

async function resolvePascalReceiverTypeChain(
  initialTypes: string[],
  memberNames: string[],
  resolveMemberTypes: (typeName: string, memberName: string) => Promise<string[]>,
): Promise<string[]> {
  let types = [
    ...new Map(
      (initialTypes || [])
        .filter(Boolean)
        .map((typeName: string) => [String(typeName).toLowerCase(), String(typeName)]),
    ).values(),
  ]
  for (const memberName of memberNames || []) {
    const next = new Map<string, string>()
    for (const typeName of types) {
      for (const resultType of (await resolveMemberTypes(typeName, memberName)) || []) {
        if (resultType) next.set(String(resultType).toLowerCase(), String(resultType))
      }
    }
    if (next.size === 0) return []
    types = [...next.values()]
  }
  return types
}

function uniqueCompiledInterfaceMember(
  receiverInfo: CompiledMemberOwner & { kind?: string; namespace?: string },
  allClasses: Iterable<CompiledClass> | Map<string, CompiledClass>,
  memberName: string,
) {
  if (receiverInfo?.kind !== PascalKeyword.Interface || !allClasses) return undefined
  const wanted = memberName.toLowerCase()
  if (knownCompiledMembers(receiverInfo).has(wanted)) return undefined
  const namespace = String(receiverInfo.namespace || "").toLowerCase()
  const matches = []
  for (const candidate of allClasses instanceof Map
    ? allClasses.values()
    : allClasses) {
    if (
      candidate.kind !== PascalKeyword.Interface ||
      candidate.symbol.toLowerCase() === receiverInfo.symbol.toLowerCase() ||
      String(candidate.namespace || "").toLowerCase() !== namespace
    )
      continue
    const member = knownCompiledMembers(candidate).get(wanted)
    if (member) matches.push({ info: candidate, member })
  }
  // A missing inheritance table must never turn into an arbitrary same-name
  // jump. The fallback is safe only when one sibling interface in the same
  // Delphi Unit owns the requested member.
  return matches.length === 1 ? matches[0] : undefined
}

function parseTdumpRttiMembers(
  output: string,
  classInfo: { symbol: string; namespace: string; methods: Array<{ name: string }> },
): CompiledMethod[] {
  const entries = []
  for (const match of output.matchAll(
    /^\s*(\d+):\s+([A-Za-z_][A-Za-z0-9_.<>]*)\s*$/gm,
  )) {
    entries.push({ offset: Number(match[1]), value: match[2] })
  }
  const classKey = classInfo.symbol.toLowerCase()
  const methodKeys = new Set(
    classInfo.methods.map((item: { name: string }) => item.name.toLowerCase()),
  )
  let methodMarker = -1
  for (let index = 0; index < entries.length; index += 1) {
    const value = entries[index].value.toLowerCase()
    if (!value.startsWith(classKey) || value.includes(".")) continue
    if (
      entries
        .slice(index + 1, index + 6)
        .some((item) => methodKeys.has(item.value.toLowerCase()))
    ) {
      methodMarker = index
      break
    }
  }
  if (methodMarker < 0) return []

  const names = new Map<string, CompiledMethod>()
  const add = (value: string) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return
    const key = value.toLowerCase()
    if (
      key === classKey ||
      key === classInfo.namespace.toLowerCase() ||
      methodKeys.has(key)
    )
      return
    if (!names.has(key)) {
      names.set(key, {
        name: value,
        signature: `${classInfo.symbol}.${value}`,
        rtti: true,
      })
    }
  }

  // Delphi extended RTTI places published/public data fields after the final
  // private F-prefixed field and before the method table for this class.
  let lastPrivateField = -1
  for (let index = methodMarker - 1; index >= 0; index -= 1) {
    if (/^F[A-Z][A-Za-z0-9_]*$/.test(entries[index].value)) {
      lastPrivateField = index
      break
    }
    if (methodMarker - index > 100) break
  }
  if (lastPrivateField >= 0) {
    for (let index = lastPrivateField + 1; index < methodMarker; index += 1)
      add(entries[index].value)
  }

  // A second class marker follows its methods and introduces the property
  // table.  It ends when RTTI for the next Delphi type begins.
  let propertyMarker = -1
  for (let index = methodMarker + 1; index < entries.length; index += 1) {
    const value = entries[index].value.toLowerCase()
    if (value.startsWith(classKey) && !value.includes(".")) {
      propertyMarker = index
      break
    }
  }
  if (propertyMarker >= 0) {
    for (let index = propertyMarker + 1; index < entries.length; index += 1) {
      const value = entries[index].value
      if (/^T[A-Z][A-Za-z0-9_.<>]*$/.test(value)) break
      add(value)
    }
  }
  return [...names.values()]
}

function rankBplCandidates(paths: string[], documentText: string) {
  const units = parseUsesUnits(documentText)
  const noise = /^(bcgl|dcl|rtl|vcl|fmx)/i
  return [...paths].sort(
    (left, right) => score(right) - score(left) || left.length - right.length,
  )

  function score(value: string) {
    const base = path.basename(value, path.extname(value)).toLowerCase()
    const stripped = base.replace(noise, "")
    let result = 0
    for (const unit of units) {
      const leaf = unit.split(".").at(-1) || ""
      if (base === leaf || stripped === leaf) result = Math.max(result, 100)
      else if (base.includes(leaf) || leaf.includes(stripped))
        result = Math.max(result, 80)
    }
    if (!/trunk-win64-lib/i.test(value)) result += 5
    return result
  }
}

function bplCandidatesForDocument(paths: string[], documentText: string) {
  const units = new Set(
    parseUsesUnits(documentText).map((unit) => unit.split(".").at(-1)),
  )
  const noise = /^(bcgl|dcl|rtl|vcl|fmx)/i
  return rankBplCandidates(paths, documentText).filter((value) => {
    const base = path.basename(value, path.extname(value)).toLowerCase()
    return units.has(base) || units.has(base.replace(noise, ""))
  })
}

function parseTdumpClassNames(output: string) {
  const names = new Map<string, string>()
  for (const match of output.matchAll(/::([TI][A-Za-z0-9_]+)::/g)) {
    if (!names.has(match[1].toLowerCase())) names.set(match[1].toLowerCase(), match[1])
  }
  let start = output.indexOf("_ZTRN")
  while (start >= 0) {
    const components = parseItaniumTypeInfoAt(output, start)
    const symbol = components?.at(-1)
    if (
      components &&
      symbol &&
      /^[TI][A-Za-z0-9_]+$/.test(symbol) &&
      !names.has(symbol.toLowerCase())
    ) {
      names.set(symbol.toLowerCase(), symbol)
    }
    start = output.indexOf("_ZTRN", start + 5)
  }
  return names
}

function parseTdumpClassUnits(output: string) {
  const units = new Map<string, Set<string>>()
  for (const match of output.matchAll(
    /(?:^|['\s<,(])([A-Za-z_][A-Za-z0-9_.]*)::([TI][A-Za-z0-9_]+)::/g,
  )) {
    const key = match[2].toLowerCase()
    if (!units.has(key)) units.set(key, new Set())
    units.get(key)!.add(match[1])
  }
  let start = output.indexOf("_ZTRN")
  while (start >= 0) {
    const components = parseItaniumTypeInfoAt(output, start)
    const symbol = components?.at(-1)
    if (components && symbol && /^[TI][A-Za-z0-9_]+$/.test(symbol)) {
      const key = symbol.toLowerCase()
      if (!units.has(key)) units.set(key, new Set())
      units.get(key)!.add(components.slice(0, -1).join("."))
    }
    start = output.indexOf("_ZTRN", start + 5)
  }
  return units
}

function exportedSignatures(output: string) {
  const result: string[] = []
  const seen = new Set()
  const add = (value: string) => {
    const signature = value.replace(/\s+/g, " ").trim()
    if (signature.includes("::") && !seen.has(signature)) {
      seen.add(signature)
      result.push(signature)
    }
  }
  for (const match of output.matchAll(/EXPORT\s+ord:\d+='([^']+)'/g)) {
    add(match[1])
  }
  // A complete PE dump prints the same exports as address/ordinal/table-index
  // rows instead of the compact `EXPORT ord=...` representation used by -ee.
  for (const match of output.matchAll(
    /^\s*[0-9A-F]{8,16}\s+\d+\s+[0-9A-F]{4,}\s+(.+?)\s*$/gim,
  )) {
    add(match[1])
  }
  return result
}

function inferredProperties(methods: CompiledMethod[]): CompiledProperty[] {
  const groups = new Map<string, CompiledProperty>()
  for (const method of methods) {
    const match = /^(Get|Set|Put)([A-Z][A-Za-z0-9_]*)$/.exec(method.name)
    if (!match) continue
    const key = match[2].toLowerCase()
    if (!groups.has(key)) groups.set(key, { name: match[2], getters: [], setters: [] })
    groups.get(key)![match[1] === "Get" ? "getters" : "setters"].push(method)
  }
  return [...groups.values()]
}

function inferCompiledGlobalType(
  globalName: string,
  classes: CompiledClass[] | Map<string, CompiledClass>,
) {
  const wanted = globalName.toLowerCase()
  const expanded = wanted
    .replace(/sys$/, "system")
    .replace(/mgr$/, "manager")
    .replace(/cfg$/, "config")
  const ranked = [...classes.values()]
    .map((info) => {
      const stem = info.symbol.slice(1).toLowerCase()
      let score = 0
      if (stem === wanted) score = 100
      else if (stem === expanded) score = 95
      else if (stem.startsWith(wanted) || wanted.startsWith(stem)) score = 70
      return { info, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
  return ranked.length > 0 && (ranked.length === 1 || ranked[0].score > ranked[1].score)
    ? ranked[0].info.symbol
    : undefined
}

function parseItaniumNameAt(output: string, start: number) {
  if (output.slice(start, start + 3) !== "_ZN") return undefined
  const components = []
  let cursor = start + 3
  while (cursor < output.length && /\d/.test(output[cursor])) {
    const lengthStart = cursor
    while (/\d/.test(output[cursor])) cursor += 1
    const length = Number(output.slice(lengthStart, cursor))
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > output.length)
      return undefined
    components.push(output.slice(cursor, cursor + length))
    cursor += length
  }
  return output[cursor] === "E" && components.length >= 2 ? components : undefined
}

function parseItaniumTypeInfoAt(output: string, start: number) {
  if (output.slice(start, start + 5) !== "_ZTRN") return undefined
  const components = []
  let cursor = start + 5
  while (cursor < output.length && /\d/.test(output[cursor])) {
    const lengthStart = cursor
    while (/\d/.test(output[cursor])) cursor += 1
    const length = Number(output.slice(lengthStart, cursor))
    if (!Number.isSafeInteger(length) || length <= 0 || cursor + length > output.length)
      return undefined
    components.push(output.slice(cursor, cursor + length))
    cursor += length
  }
  return output[cursor] === "E" && components.length >= 2 ? components : undefined
}

function parseTdumpMangledClasses(
  output: string,
  bplPath: string,
): Map<string, CompiledClass> {
  const classes = new Map<string, CompiledClass>()
  const ensureClass = (symbol: string, namespace: string) => {
    const key = symbol.toLowerCase()
    if (!classes.has(key)) {
      classes.set(key, {
        kind: symbol.startsWith("I") ? PascalKeyword.Interface : PascalKeyword.Class,
        symbol,
        namespace,
        bplPath,
        signatures: [],
        methods: [],
        properties: [],
      })
    }
    return classes.get(key)!
  }
  let start = output.indexOf("_ZN")
  while (start >= 0) {
    const components = parseItaniumNameAt(output, start)
    if (components && components.length >= 3) {
      const symbol = components[components.length - 2]
      const memberName = components[components.length - 1]
      if (
        /^[TI][A-Za-z0-9_]+$/.test(symbol) &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(memberName)
      ) {
        const info = ensureClass(symbol, components.slice(0, -2).join("."))
        const signature = `${components.join("::")}()`
        if (
          !info.methods.some(
            (item: { name: string }) =>
              item.name.toLowerCase() === memberName.toLowerCase(),
          )
        ) {
          info.methods.push({ name: memberName, signature, mangled: true })
        }
      }
    }
    start = output.indexOf("_ZN", start + 3)
  }

  // Type-info names cover records as well as classes. Records do not have a
  // vtable and therefore may never occur in a callable `_ZN...` export, but
  // their public field-name table is still present in tdump's string output.
  let typeInfoStart = output.indexOf("_ZTRN")
  while (typeInfoStart >= 0) {
    const components = parseItaniumTypeInfoAt(output, typeInfoStart)
    const symbol = components?.at(-1)
    if (components && symbol && /^[TI][A-Za-z0-9_]+$/.test(symbol)) {
      ensureClass(symbol, components.slice(0, -1).join("."))
    }
    typeInfoStart = output.indexOf("_ZTRN", typeInfoStart + 5)
  }

  // Delphi interfaces frequently export only their type-info symbol. Their
  // public method names still appear as one contiguous RTTI string table after
  // an `_ZTRN<Unit><Interface>E` marker. Recover that table so package-only
  // interfaces such as IBrowserBaseFrame expose SetResourcePath even though no
  // corresponding callable PE export exists.
  const rowIndexesByToken = new Map<string, number[]>()
  const rows = [...output.matchAll(/^\s*(\d+):\s+(.+?)\s*$/gm)].map((match, index) => {
    const value = match[2]
    const token = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(value)?.[1]
    if (token) {
      const key = token.toLowerCase()
      if (!rowIndexesByToken.has(key)) rowIndexesByToken.set(key, [])
      rowIndexesByToken.get(key)!.push(index)
    }
    return { offset: Number(match[1]), value, token }
  })
  for (let index = 0; index < rows.length; index += 1) {
    const markerStart = rows[index].value.indexOf("_ZTRN")
    if (markerStart < 0) continue
    const components = parseItaniumTypeInfoAt(rows[index].value, markerStart)
    const symbol = components?.at(-1)
    if (!components || !symbol || !/^I[A-Za-z0-9_]+$/.test(symbol)) continue
    const info = ensureClass(symbol, components.slice(0, -1).join("."))
    for (let next = index + 1; next < rows.length && next <= index + 128; next += 1) {
      const row = rows[next]
      if (row.value.includes("_ZTRN") || row.offset - rows[index].offset > 8192) break
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.value)) continue
      const memberName = row.value
      if (memberName.toLowerCase() === symbol.toLowerCase()) continue
      if (
        !info.methods.some(
          (item: { name: string }) =>
            item.name.toLowerCase() === memberName.toLowerCase(),
        )
      ) {
        info.methods.push({
          name: memberName,
          signature: `${components.slice(0, -1).join("::")}::${symbol}::${memberName}()`,
          rtti: true,
        })
      }
    }
  }
  for (const info of classes.values()) {
    info.properties = inferredProperties(info.methods)
    const pointerName = info.symbol.replace(/^T/, "P").toLowerCase()
    let marker = -1
    for (const index of rowIndexesByToken.get(info.symbol.toLowerCase()) || []) {
      const nearbyFields = rows
        .slice(index + 1, index + 12)
        .some((row) => /^F[A-Z][A-Za-z0-9_]*$/.test(row.token || ""))
      if (nearbyFields) {
        marker = index
        break
      }
    }
    if (marker < 0) continue
    const fields: { name: string; signature: string; rtti: boolean }[] = []
    for (
      let index = marker + 1;
      index < rows.length && index <= marker + 40;
      index += 1
    ) {
      if (rows[index].offset - rows[marker].offset > 2048) break
      const token = rows[index].token
      if (!token) continue
      const lower = token.toLowerCase()
      if (lower === pointerName || (/^T[A-Z]/.test(token) && index > marker + 1)) break
      if (
        /^F[A-Z][A-Za-z0-9_]*$/.test(token) &&
        !fields.some((item) => item.name.toLowerCase() === lower)
      ) {
        fields.push({
          name: token,
          signature: `${info.symbol}.${token}`,
          rtti: true,
        })
      }
    }
    info.rttiMembers = fields
  }

  // Recover enough return/field types to continue through common binary-only
  // record chains. The inferred name is retained only when that target type is
  // actually present in the same package, preventing an unvalidated jump.
  for (const info of classes.values()) {
    for (const method of info.methods) {
      const listMatch = /^Get([A-Za-z_][A-Za-z0-9_]*?)ResList$/.exec(method.name)
      if (!listMatch) continue
      const element = `T${listMatch[1]}DiscreteRes`
      if (classes.has(element.toLowerCase())) method.typeName = `TList<${element}>`
    }
    for (const member of info.rttiMembers || []) {
      const fieldMatch = /^F([A-Z][A-Za-z0-9_]*)$/.exec(member.name)
      if (!fieldMatch) continue
      const ownerStem = info.symbol
        .replace(/^T/, "")
        .replace(/(?:Discrete)?Res(?:ult)?$/, "")
      const candidate = `T${ownerStem}${fieldMatch[1]}`
      if (classes.has(candidate.toLowerCase())) member.typeName = candidate
    }
  }
  return classes
}

function inferRoutineReturnClass(
  routineName: string,
  classes: CompiledClass[] | Map<string, CompiledClass>,
) {
  const wanted = routineName.toLowerCase()
  const ranked = [...classes.values()]
    .map((info) => {
      const sourceStem = info.symbol.slice(1)
      const stem = sourceStem.toLowerCase()
      const acronym = (sourceStem.match(/[A-Z][a-z0-9]*/g) || [])
        .map((part: string) => part[0])
        .join("")
        .toLowerCase()
      let score = 0
      if (stem === wanted) score = 100
      else if (acronym === wanted) score = 95
      else if (stem.endsWith(wanted)) score = 90
      else if (stem.startsWith(wanted)) score = 75
      // Exported factory routines in Delphi packages most often expose their
      // concrete T-prefixed implementation through callable RTTI. When a paired
      // I-prefixed interface has the same acronym but no exported members, keep
      // the concrete class as the useful navigation/completion target.
      if (score > 0 && info.symbol.startsWith("T")) score += 1
      return { info, score }
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)
  return ranked.length > 0 && (ranked.length === 1 || ranked[0].score > ranked[1].score)
    ? ranked[0].info
    : undefined
}

/**
 * Builds a package-wide index from tdump's C++-style export names.  Unlike the
 * legacy class-only index this retains unit names and exported unit globals, so
 * a Pascal expression such as `fsApplc.AppSys.LoadPackage` can be reconstructed.
 */
function parseTdumpPackageIndex(output: string, bplPath: string): CompiledPackageIndex {
  const units = new Map<string, CompiledUnit>()
  const ensureUnit = (unitName: string) => {
    const key = unitName.toLowerCase()
    if (!units.has(key)) {
      units.set(key, {
        kind: PascalKeyword.Unit,
        symbol: unitName,
        namespace: unitName,
        bplPath,
        classes: new Map(),
        globals: new Map(),
        routines: new Map(),
      })
    }
    return units.get(key)!
  }

  for (const signature of exportedSignatures(output)) {
    // Every Delphi Unit emits lifecycle exports even when it contains no
    // T/I-prefixed class or public global. Treat the complete namespace before
    // initialization/finalization as the Unit name. This recovers Units such as
    // MVCFramework.Stereotype whose exported classes use C++-style names like
    // ComponentAttribute and were previously absent from the package index.
    const lifecycle = new RegExp(
      "^(.+?)::(?:" + PascalKeyword.Initialization + "|Finalization)\\(\\)$",
      "i",
    ).exec(signature)
    if (lifecycle) ensureUnit(lifecycle[1].replace(/::/g, "."))

    const classMember =
      /^([A-Za-z_][\w.]*)::([TI][A-Za-z0-9_]+?)(?:__\d+<.*>)?::(~?[A-Za-z_][\w]*)\s*\(/.exec(
        signature,
      )
    if (classMember) {
      const unit = ensureUnit(classMember[1])
      const classKey = classMember[2].toLowerCase()
      if (!unit.classes.has(classKey)) {
        unit.classes.set(classKey, {
          kind: classMember[2].startsWith("I")
            ? PascalKeyword.Interface
            : PascalKeyword.Class,
          symbol: classMember[2],
          namespace: unit.symbol,
          bplPath,
          signatures: [],
          methods: [],
          properties: [],
        })
      }
      const info = unit.classes.get(classKey)!
      info.signatures.push(signature)
      if (
        !info.methods.some(
          (item: CompiledMethod) =>
            item.name.toLowerCase() === classMember[3].toLowerCase() &&
            item.signature === signature,
        )
      ) {
        info.methods.push({ name: classMember[3], signature })
      }
      continue
    }

    const unitRoutine = /^([A-Za-z_][\w.]*)::([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(
      signature,
    )
    if (unitRoutine) {
      const unit = ensureUnit(unitRoutine[1])
      const key = unitRoutine[2].toLowerCase()
      if (!unit.routines.has(key)) unit.routines.set(key, [])
      unit.routines.get(key)!.push({
        kind: CompiledSymbolKind.Routine,
        name: unitRoutine[2],
        symbol: unitRoutine[2],
        namespace: unit.symbol,
        bplPath,
        signature,
      })
      continue
    }

    const global = /^([A-Za-z_][\w.]*)::([A-Za-z_][A-Za-z0-9_]*)$/.exec(signature)
    if (global) {
      const unit = ensureUnit(global[1])
      const key = global[2].toLowerCase()
      if (!unit.globals.has(key)) {
        unit.globals.set(key, {
          kind: CompiledSymbolKind.Global,
          symbol: global[2],
          namespace: unit.symbol,
          bplPath,
          signature,
        })
      }
    }
  }

  // Delphi interfaces may export only RTTI/type-info names rather than public
  // method symbols. Decode `_ZTRN<Unit><Interface>E` so the interface itself is
  // still available for coloring, completion, and virtual-source navigation.
  let typeInfoStart = output.indexOf("_ZTRN")
  while (typeInfoStart >= 0) {
    const components = parseItaniumTypeInfoAt(output, typeInfoStart)
    if (components) {
      const symbol = components.at(-1)
      if (symbol && /^[TI][A-Za-z0-9_]+$/.test(symbol)) {
        const unit = ensureUnit(components.slice(0, -1).join("."))
        const key = symbol.toLowerCase()
        if (!unit.classes.has(key)) {
          unit.classes.set(key, {
            kind: symbol.startsWith("I")
              ? PascalKeyword.Interface
              : PascalKeyword.Class,
            symbol,
            namespace: unit.symbol,
            bplPath,
            signatures: [],
            methods: [],
            properties: [],
          })
        }
      }
    }
    typeInfoStart = output.indexOf("_ZTRN", typeInfoStart + 5)
  }

  const classes = new Map<string, CompiledClass>()
  const globals = new Map<string, CompiledGlobal>()
  const routines = new Map<string, CompiledRoutine>()
  for (const unit of units.values()) {
    for (const info of unit.classes.values()) {
      info.properties = inferredProperties(info.methods)
      if (!classes.has(info.symbol.toLowerCase()))
        classes.set(info.symbol.toLowerCase(), info)
    }
    for (const info of unit.globals.values()) {
      info.typeName = inferCompiledGlobalType(info.symbol, unit.classes)
      info.classInfo = info.typeName
        ? unit.classes.get(info.typeName.toLowerCase())
        : undefined
      if (!globals.has(info.symbol.toLowerCase()))
        globals.set(info.symbol.toLowerCase(), info)
    }
    for (const overloads of unit.routines.values()) {
      for (const routine of overloads) {
        routine.kind = CompiledSymbolKind.Routine
        routine.symbol = routine.name
        routine.namespace = unit.symbol
        routine.bplPath = bplPath
      }
      if (!routines.has(overloads[0].name.toLowerCase()))
        routines.set(overloads[0].name.toLowerCase(), overloads[0])
    }
  }
  return { units, classes, globals, routines }
}

function parseTdumpExports(
  output: string,
  symbol: string,
  bplPath: string,
): CompiledClass | undefined {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const classPattern = new RegExp(`(?:^|[\\s<,(])([A-Za-z_][\\w.]*)::${escaped}::`, "i")
  const signatures = []
  for (const signature of exportedSignatures(output)) {
    if (classPattern.test(signature)) signatures.push(signature)
  }
  if (signatures.length === 0) {
    let start = output.indexOf("_ZTRN")
    while (start >= 0) {
      const components = parseItaniumTypeInfoAt(output, start)
      if (components && components.at(-1)?.toLowerCase() === symbol.toLowerCase()) {
        return {
          kind: symbol.startsWith("I") ? PascalKeyword.Interface : PascalKeyword.Class,
          symbol,
          namespace: components.slice(0, -1).join("."),
          bplPath,
          signatures: [],
          methods: [],
          properties: [],
        }
      }
      start = output.indexOf("_ZTRN", start + 5)
    }
    return undefined
  }
  const namespace = classPattern.exec(signatures[0])?.[1] || ""
  const methods: CompiledMethod[] = []
  const methodPattern = new RegExp(`::${escaped}::(~?[A-Za-z_][\\w]*)\\s*\\(`, "i")
  for (const signature of signatures) {
    const name = methodPattern.exec(signature)?.[1]
    if (
      name &&
      !methods.some(
        (item) =>
          item.name.toLowerCase() === name.toLowerCase() &&
          item.signature === signature,
      )
    ) {
      methods.push({ name, signature })
    }
  }
  return {
    kind: symbol.startsWith("I") ? PascalKeyword.Interface : PascalKeyword.Class,
    symbol,
    namespace,
    bplPath,
    signatures,
    methods,
    properties: inferredProperties(methods),
  }
}

function renderedCompiledMethod(
  method: CompiledMethod,
  classInfo: CompiledMemberOwner,
) {
  const methodName = String(method.name || "")
  const className = String(classInfo?.symbol || "")
  const parametersStart = method.signature?.indexOf("(") ?? -1
  const parameters =
    parametersStart >= 0 ? method.signature.slice(parametersStart) : "()"
  if (methodName.toLowerCase() === className.toLowerCase()) {
    return `${PascalKeyword.Constructor} ${PascalBuiltinName.Create}${parameters}; // compiled export: ${method.signature}`
  }
  if (methodName.toLowerCase() === `~${className.toLowerCase()}`) {
    return `${PascalKeyword.Destructor} ${PascalBuiltinName.Destroy}${parameters}; // compiled export: ${method.signature}`
  }
  return method.signature
}

function renderVirtualUnit(info: CompiledInfo) {
  if (info.kind === PascalKeyword.Unit) {
    const lines = [
      `${PascalKeyword.Unit} ${info.symbol};`,
      "",
      PascalKeyword.Interface,
      "",
    ]
    if (info.classes.size > 0) {
      lines.push(PascalKeyword.Type)
      for (const classInfo of info.classes.values()) {
        const declarationKind =
          classInfo.kind === PascalKeyword.Interface
            ? PascalKeyword.Interface
            : PascalKeyword.Class
        lines.push(
          `  ${classInfo.symbol} = ${declarationKind} // compiled symbol from ${path.basename(info.bplPath)}`,
          `  ${PascalKeyword.Public}`,
        )
        for (const method of classInfo.methods) {
          lines.push(`    // ${renderedCompiledMethod(method, classInfo)}`)
        }
        for (const property of classInfo.properties) {
          const accessors = [...property.getters, ...property.setters]
            .map((item) => item.name)
            .join(", ")
          lines.push(
            `    // ${PascalKeyword.Property} ${property.name}; // inferred from ${accessors}`,
          )
        }
        for (const member of classInfo.rttiMembers || []) {
          if (
            classInfo.methods.some(
              (item: { name: string }) =>
                item.name.toLowerCase() === member.name.toLowerCase(),
            ) ||
            classInfo.properties.some(
              (item: { name: string }) =>
                item.name.toLowerCase() === member.name.toLowerCase(),
            )
          )
            continue
          lines.push(
            `    // member ${member.name}${member.typeName ? `: ${member.typeName}` : ""}; // compiled RTTI`,
          )
        }
        lines.push(`  ${PascalKeyword.End};`, "")
      }
    }
    if (info.globals.size > 0) {
      lines.push(PascalKeyword.Var)
      for (const global of info.globals.values()) {
        lines.push(
          `  ${global.symbol}: ${global.typeName || PascalBuiltinName.Pointer}; // compiled export: ${global.signature}`,
        )
      }
      lines.push("")
    }
    for (const overloads of info.routines.values()) {
      for (const routine of overloads) lines.push(`// ${routine.signature}`)
    }
    lines.push("", PascalKeyword.Implementation, "", `${PascalKeyword.End}.`, "")
    return lines.join("\n")
  }

  if (info.kind === CompiledSymbolKind.Global && info.classInfo) {
    const classInfo = info.classInfo
    const lines = [
      `${PascalKeyword.Unit} ${info.namespace};`,
      "",
      PascalKeyword.Interface,
      "",
      PascalKeyword.Type,
      `  ${classInfo.symbol} = ${PascalKeyword.Class} // compiled symbol from ${path.basename(info.bplPath)}`,
      `  ${PascalKeyword.Public}`,
    ]
    for (const method of classInfo.methods) {
      lines.push(`    // ${renderedCompiledMethod(method, classInfo)}`)
    }
    for (const property of classInfo.properties) {
      const accessors = [...property.getters, ...property.setters]
        .map((item) => item.name)
        .join(", ")
      lines.push(
        `    // ${PascalKeyword.Property} ${property.name}; // inferred from ${accessors}`,
      )
    }
    for (const member of info.observedMembers || []) {
      if (
        classInfo.methods.some(
          (item: { name: string }) =>
            item.name.toLowerCase() === member.name.toLowerCase(),
        ) ||
        classInfo.properties.some(
          (item: { name: string }) =>
            item.name.toLowerCase() === member.name.toLowerCase(),
        ) ||
        classInfo.rttiMembers?.some(
          (item: { name: string }) =>
            item.name.toLowerCase() === member.name.toLowerCase(),
        )
      )
        continue
      lines.push(
        `    // member ${member.name}; // inferred from Pascal workspace references`,
      )
    }
    for (const member of classInfo.rttiMembers || []) {
      if (
        classInfo.methods.some(
          (item: { name: string }) =>
            item.name.toLowerCase() === member.name.toLowerCase(),
        ) ||
        classInfo.properties.some(
          (item: { name: string }) =>
            item.name.toLowerCase() === member.name.toLowerCase(),
        )
      )
        continue
      lines.push(`    // member ${member.name}; // compiled RTTI`)
    }
    lines.push(
      `  ${PascalKeyword.End};`,
      "",
      PascalKeyword.Var,
      `  ${info.symbol}: ${info.typeName}; // compiled export: ${info.signature}`,
      "",
      PascalKeyword.Implementation,
      "",
      `${PascalKeyword.End}.`,
      "",
    )
    return lines.join("\n")
  }

  if (info.kind === CompiledSymbolKind.Routine) {
    const lines = [
      `${PascalKeyword.Unit} ${info.namespace};`,
      "",
      PascalKeyword.Interface,
      "",
      `// ${info.signature}`,
    ]
    if (info.classInfo) {
      lines.push(
        "",
        PascalKeyword.Type,
        `  ${info.classInfo.symbol} = ${PascalKeyword.Class} // inferred return type from ${path.basename(info.bplPath)}`,
        `  ${PascalKeyword.Public}`,
      )
      for (const method of info.classInfo.methods) {
        lines.push(`    // ${renderedCompiledMethod(method, info.classInfo)}`)
      }
      for (const property of info.classInfo.properties || []) {
        const accessors = [...property.getters, ...property.setters]
          .map((item) => item.name)
          .join(", ")
        lines.push(
          `    // ${PascalKeyword.Property} ${property.name}; // inferred from ${accessors}`,
        )
      }
      for (const member of info.observedMembers || []) {
        if (
          info.classInfo.methods.some(
            (item: { name: string }) =>
              item.name.toLowerCase() === member.name.toLowerCase(),
          ) ||
          info.classInfo.properties?.some(
            (item: { name: string }) =>
              item.name.toLowerCase() === member.name.toLowerCase(),
          )
        )
          continue
        lines.push(
          `    // member ${member.name}; // inferred from Pascal workspace references`,
        )
      }
      lines.push(
        `  ${PascalKeyword.End};`,
        "",
        `// function ${info.symbol}: ${info.classInfo.symbol}; // compiled export`,
      )
    }
    lines.push("", PascalKeyword.Implementation, "", `${PascalKeyword.End}.`, "")
    return lines.join("\n")
  }

  if (info.kind === CompiledSymbolKind.Global)
    throw new TypeError("Compiled global requires class information.")

  const unitName = info.namespace || "CompiledPackage"
  const lines = [
    `${PascalKeyword.Unit} ${unitName};`,
    "",
    PascalKeyword.Interface,
    "",
    PascalKeyword.Type,
    `  ${info.symbol} = ${info.kind === PascalKeyword.Interface ? PascalKeyword.Interface : PascalKeyword.Class} // compiled symbol from ${path.basename(info.bplPath)}`,
    `  ${PascalKeyword.Public}`,
  ]
  for (const method of info.methods) {
    lines.push(`    // ${renderedCompiledMethod(method, info)}`)
  }
  for (const property of info.properties || []) {
    const accessors = [...property.getters, ...property.setters]
      .map((item) => item.name)
      .join(", ")
    lines.push(
      `    // ${PascalKeyword.Property} ${property.name}; // inferred from ${accessors}`,
    )
  }
  for (const member of info.rttiMembers || []) {
    if (
      info.methods.some(
        (item: { name: string }) =>
          item.name.toLowerCase() === member.name.toLowerCase(),
      ) ||
      info.properties?.some(
        (item: { name: string }) =>
          item.name.toLowerCase() === member.name.toLowerCase(),
      )
    )
      continue
    lines.push(
      `    // member ${member.name}${member.typeName ? `: ${member.typeName}` : ""}; // compiled RTTI`,
    )
  }
  lines.push(
    `  ${PascalKeyword.End};`,
    "",
    PascalKeyword.Implementation,
    "",
    `${PascalKeyword.End}.`,
    "",
  )
  return lines.join("\n")
}

export {
  PASCAL_INDEX_DEREFERENCE,
  bplCandidatesForDocument,
  buildPascalTypeInferenceIndex,
  collectPascalInlineVariableNames,
  collectPascalUnitIdentifierOffsets,
  collectPascalUsesUnitRanges,
  findBplFiles,
  findDcpFiles,
  findPascalDeclaration,
  findPascalCallAt,
  splitSignatureParameters,
  extractPascalRoutineSignature,
  inferPascalInitializerRoutine,
  inferPascalType,
  inferPascalTypeFromIndex,
  inferPascalCollectionElementType,
  isPascalMemberReference,
  parsePascalTypeReference,
  pascalMemberChainBefore,
  pascalForInCollectionFromIndex,
  pascalRoutineReturnType,
  pascalTypeBaseName,
  substitutePascalTypeParameters,
  inferRoutineReturnClass,
  knownCompiledMembers,
  uniqueCompiledInterfaceMember,
  maskPascalNonCode,
  parseObservedMemberReferences,
  findPascalUsesUnitAt,
  parseTdumpRttiMembers,
  parseTdumpClassNames,
  parseTdumpClassUnits,
  parseTdumpExports,
  parseTdumpPackageIndex,
  parseTdumpMangledClasses,
  parseUsesUnits,
  rankBplCandidates,
  renderVirtualUnit,
  resolvePascalReceiverTypeChain,
}
