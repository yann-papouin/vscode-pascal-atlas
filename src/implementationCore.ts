import { inList } from "./shared/guards"
import type {
  CounterpartModel,
  RoutineDeclarationIndex,
  DeclarationEntry,
  EditorOptions,
  SourceEdit,
  PlanFailure,
  ImplementationPlan,
  CounterpartPlan,
  ImplementationApi,
  EditableDocument,
  EditorPosition,
  EditorRange,
  EditorSelection,
} from "./shared/implementation"
import type {
  SourceIndex,
  SourceDefinition,
  NavigatorTarget,
  RoutineBody,
  RoutineHeader,
  RoutineDirective,
  StructureLayout,
  StructureSection,
  StructureMember,
} from "./shared/models"
import { isInteger, errorMessage } from "./shared/guards"
import { ConfigurationSection, LanguageId, SettingKey } from "./shared/identifiers"
import { PascalKeyword, CompilerDirective } from "./shared/pascal"
import { maskPascalNonCode } from "./binarySymbols"

function typeKey(typeName: string | undefined) {
  const withoutGenerics = String(typeName || "")
    .replace(/<.*$/, "")
    .trim()
  return withoutGenerics.toLowerCase().split(".").at(-1) || ""
}

function definitionIdentity(definition: NavigatorTarget, useImplementation = false) {
  const offset =
    useImplementation && isInteger(definition.implementationOffset)
      ? definition.implementationOffset
      : definition.offset
  return `${String(definition.filePath || "").toLowerCase()}:${offset}`
}

function descendantTypeDefinitions(
  index: Pick<SourceIndex, "types"> | undefined,
  targetTypeName: string,
): SourceDefinition[] {
  const target = typeKey(targetTypeName)
  if (!target) return []
  const known = new Set([target])
  const result = []
  const seen = new Set()
  let changed = true
  while (changed) {
    changed = false
    for (const definitions of index?.types?.values() || []) {
      for (const definition of definitions) {
        const key = typeKey(definition.symbol)
        if (!key || known.has(key)) continue
        if (
          !(definition.baseTypes || []).some((baseType: string) =>
            known.has(typeKey(baseType)),
          )
        )
          continue
        known.add(key)
        const identity = definitionIdentity(definition)
        if (!seen.has(identity)) {
          seen.add(identity)
          result.push(definition)
        }
        changed = true
      }
    }
  }
  return result
}

function memberImplementationDefinitions(
  index: Pick<SourceIndex, "types" | "members"> | undefined,
  ownerTypeName: string,
  memberName: string,
): SourceDefinition[] {
  const owner = typeKey(ownerTypeName)
  const member = String(memberName || "").toLowerCase()
  if (!owner || !member) return []
  const owners = [
    owner,
    ...descendantTypeDefinitions(index, owner).map((item) => typeKey(item.symbol)),
  ]
  const result = []
  const seen = new Set()
  for (const ownerKey of owners) {
    for (const definition of index?.members?.get(ownerKey)?.get(member) || []) {
      if (!isInteger(definition.implementationOffset)) continue
      const identity = definitionIdentity(definition, true)
      if (seen.has(identity)) continue
      seen.add(identity)
      result.push(definition)
    }
  }
  return result
}

function routineImplementationDefinitions(
  index: Pick<SourceIndex, "definitions"> | undefined,
  routineName: string,
): SourceDefinition[] {
  const result = []
  const seen = new Set()
  for (const definition of index?.definitions?.get(
    String(routineName || "").toLowerCase(),
  ) || []) {
    if (
      definition.owner ||
      definition.kind !== "routine" ||
      !isInteger(definition.implementationOffset)
    )
      continue
    const identity = definitionIdentity(definition, true)
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push(definition)
  }
  return result
}

function enclosingRoutineOwner(text: string, offset: number) {
  const code = maskPascalNonCode(text).slice(0, Math.max(0, offset))
  const pattern = new RegExp(
    String.raw`^\s*(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)`,
    "gim",
  )
  let owner
  for (const match of code.matchAll(pattern)) {
    const parts = match[1]
      .split(".")
      .map((item: string) => item.replace(/\s*<.*>\s*$/, "").trim())
    if (parts.length > 1) owner = parts.at(-2)
  }
  return owner
}

/** Locate the header semicolon without stopping inside parameters or generic constraints. */
function routineHeaderEnd(code: string, start: number) {
  let parentheses = 0
  let brackets = 0
  let angles = 0
  for (let index = start; index < code.length; index += 1) {
    const current = code[index]
    if (current === "(") parentheses += 1
    else if (current === ")") parentheses = Math.max(0, parentheses - 1)
    else if (current === "[") brackets += 1
    else if (current === "]") brackets = Math.max(0, brackets - 1)
    else if (current === "<") angles += 1
    else if (current === ">") angles = Math.max(0, angles - 1)
    else if (current === ";" && parentheses === 0 && brackets === 0 && angles === 0)
      return index + 1
  }
  return -1
}

/** Split a Pascal header at separators outside nested parameter and type expressions. */
function splitRoutineHeaderText(text: string, separator: string) {
  const parts = []
  let start = 0
  let parentheses = 0
  let brackets = 0
  let angles = 0
  for (let index = 0; index < text.length; index += 1) {
    const token = text[index]
    if (token === "(") parentheses += 1
    else if (token === ")") parentheses -= 1
    else if (token === "[") brackets += 1
    else if (token === "]") brackets -= 1
    else if (token === "<") angles += 1
    else if (token === ">") angles -= 1
    else if (
      token === separator &&
      parentheses === 0 &&
      brackets === 0 &&
      angles === 0
    ) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** Match overloads by parameter modes/types and result type, ignoring names and defaults. */
function routineCounterpartKey(signature: string | undefined, name = "") {
  const code = maskPascalNonCode(signature || "")
    .trim()
    .toLowerCase()
  const prefix = new RegExp(
    String.raw`^(${PascalKeyword.Class}\s+)?(${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\s+`,
  ).exec(code)
  if (!prefix) return undefined
  let cursor = prefix[0].length
  let angles = 0
  // Skip the qualified method name, including generic type/method arguments.
  for (; cursor < code.length; cursor += 1) {
    if (code[cursor] === "<") angles += 1
    else if (code[cursor] === ">") angles -= 1
    else if (angles === 0 && /[(:;]/.test(code[cursor])) break
  }
  const methodName =
    splitRoutineHeaderText(code.slice(prefix[0].length, cursor), ".").at(-1)?.trim() ||
    ""
  const generic = /<([\s\S]*)>$/.exec(methodName)
  const arity = generic ? genericParameterNames(generic[1]).length : 0
  let parameters = ""
  if (code[cursor] === "(") {
    const start = ++cursor
    let depth = 1
    for (; cursor < code.length; cursor += 1) {
      if (code[cursor] === "(") depth += 1
      else if (code[cursor] === ")" && --depth === 0) break
    }
    parameters = code.slice(start, cursor)
    cursor += 1
  }
  const parameterTypes = []
  for (const parameter of splitRoutineHeaderText(parameters, ";")) {
    if (!parameter.trim()) continue
    const withoutDefault = splitRoutineHeaderText(parameter, "=")[0].trim()
    const mode = new RegExp(
      String.raw`^(${PascalKeyword.Constref}|${PascalKeyword.Const}|${PascalKeyword.Var}|${PascalKeyword.Out})\b\s*`,
    ).exec(withoutDefault)
    const declaration = withoutDefault.slice(mode?.[0].length || 0)
    const [names, ...typeParts] = splitRoutineHeaderText(declaration, ":")
    const type = typeParts.join(":").replace(/\s+/g, "")
    for (const identifier of names.split(",")) {
      if (identifier.trim()) parameterTypes.push([mode?.[1] || "", type])
    }
  }
  const resultType = code
    .slice(cursor)
    .replace(/;[\s\S]*$/, "")
    .replace(/^\s*:/, "")
    .replace(/\s+/g, "")
  const identity: Array<string | boolean | string[][] | number> = [
    prefix[2],
    Boolean(prefix[1]),
    name.toLowerCase(),
    parameterTypes,
    resultType,
  ]
  // Keep existing non-generic IDs stable while distinguishing generic overload arity.
  if (arity) identity.push(arity)
  return JSON.stringify(identity)
}

/** Read complete directive statements, including their source positions for insertion. */
function routineDirectiveStatements(code: string, headerEnd: unknown) {
  const result: RoutineDirective[] = []
  if (!isInteger(headerEnd) || headerEnd < 0) return result
  let cursor = headerEnd
  const pattern = new RegExp(
    String.raw`^\s*(${PascalKeyword.Abstract}|${PascalKeyword.External}|${PascalKeyword.Forward}|${PascalKeyword.Virtual}|${PascalKeyword.Dynamic}|${PascalKeyword.Override}|${PascalKeyword.Overload}|${PascalKeyword.Reintroduce}|${PascalKeyword.Static}|${PascalKeyword.Final}|${PascalKeyword.Inline}|${PascalKeyword.Cdecl}|${PascalKeyword.Stdcall}|${PascalKeyword.Safecall}|${PascalKeyword.Register}|pascal|${PascalKeyword.Varargs}|${PascalKeyword.Message}|${PascalKeyword.Dispid}|${PascalKeyword.Deprecated}|${PascalKeyword.Platform}|${PascalKeyword.Experimental}|${PascalKeyword.Library})\b[^;]*;`,
    "i",
  )
  for (let match; (match = pattern.exec(code.slice(cursor))); ) {
    result.push({
      name: match[1].toLowerCase(),
      start: cursor + match[0].search(/\S/),
      end: cursor + match[0].length,
    })
    cursor += match[0].length
  }
  return result
}

/** Read declaration directives only; a later method's abstract directive must not leak back. */
function methodDeclarationDirectives(code: string, node: NavigatorTarget) {
  return new Set(
    routineDirectiveStatements(
      code,
      routineHeaderEnd(code, node.declarationOffset ?? 0),
    ).map((item) => item.name),
  )
}

function skipSpace(code: string, offset: number) {
  while (/\s/.test(code[offset] || "")) offset += 1
  return offset
}

/**
 * Read a structure lexically. Entire nested structures and method headings are
 * consumed as members so their visibility labels cannot affect the outer type.
 */
function structureLayout(
  code: string,
  kindOffset: number,
  depth = 0,
): StructureLayout | undefined {
  if (depth > 64) return undefined
  const kindMatch = new RegExp(
    String.raw`^(${PascalKeyword.Class}|${PascalKeyword.Record}|${PascalKeyword.Object}|${PascalKeyword.Interface})\b`,
    "i",
  ).exec(code.slice(kindOffset))
  if (!kindMatch) return undefined
  const kind = kindMatch[1].toLowerCase()
  let cursor = skipSpace(code, kindOffset + kindMatch[0].length)
  if (
    kind === PascalKeyword.Class &&
    new RegExp(String.raw`^${PascalKeyword.Of}\b`, "i").test(code.slice(cursor))
  )
    return undefined
  for (
    let modifier;
    (modifier = new RegExp(
      String.raw`^(${PascalKeyword.Abstract}|${PascalKeyword.Sealed})\b\s*`,
      "i",
    ).exec(code.slice(cursor)));

  )
    cursor += modifier[0].length
  const helper = new RegExp(
    String.raw`^${PascalKeyword.Helper}\s+${PascalKeyword.For}\s+[A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^>]*>)?\s*`,
    "i",
  ).exec(code.slice(cursor))
  if (helper) cursor += helper[0].length
  let ancestor = false
  if (code[cursor] === "(") {
    const close = closingBracket(code, cursor, "(", ")")
    if (close < 0) return undefined
    ancestor = true
    cursor = skipSpace(code, close + 1)
  }
  if (code[cursor] === ";") {
    return {
      kind,
      keyword: kindMatch[0],
      bodyStart: cursor,
      endOffset: cursor + 1,
      shorthand: ancestor && kind === PascalKeyword.Class,
      forward: !ancestor,
      sections: [],
      members: [],
    }
  }
  const bodyStart = cursor
  const sections: StructureSection[] = [
    {
      access:
        kind === PascalKeyword.Class ? PascalKeyword.Published : PascalKeyword.Public,
      start: bodyStart,
      bodyStart,
      implicit: true,
    },
  ]
  const members: StructureMember[] = []
  let declarationKind
  for (; cursor < code.length; ) {
    cursor = skipSpace(code, cursor)
    const close = new RegExp(String.raw`^${PascalKeyword.End}\s*;`, "i").exec(
      code.slice(cursor),
    )
    if (close) {
      sections[sections.length - 1].end = cursor
      return {
        kind,
        keyword: kindMatch[0],
        bodyStart,
        closingStart: cursor,
        endOffset: cursor + close[0].length,
        sections,
        members,
      }
    }
    const visibility = new RegExp(
      String.raw`^(${PascalKeyword.Strict}\s+(?:${PascalKeyword.Private}|${PascalKeyword.Protected})|${PascalKeyword.Public}|${PascalKeyword.Published}|${PascalKeyword.Private}|${PascalKeyword.Protected}|${PascalKeyword.Automated})\b`,
      "i",
    ).exec(code.slice(cursor))
    if (visibility) {
      sections[sections.length - 1].end = cursor
      sections.push({
        access: visibility[1].toLowerCase().replace(/\s+/g, "-"),
        start: cursor,
        bodyStart: cursor + visibility[0].length,
        spelling: visibility[0],
      })
      cursor += visibility[0].length
      declarationKind = undefined
      continue
    }
    const group = new RegExp(
      String.raw`^(?:${PascalKeyword.Class}\s+)?(${PascalKeyword.Type}|${PascalKeyword.Const}|${PascalKeyword.Var}|${PascalKeyword.Threadvar})\b`,
      "i",
    ).exec(code.slice(cursor))
    if (group) {
      declarationKind = group[1].toLowerCase()
      cursor += group[0].length
      continue
    }
    const attributeStart = cursor
    while (code[cursor] === "[") {
      const closeAttribute = closingBracket(code, cursor, "[", "]")
      if (closeAttribute < 0) return undefined
      cursor = skipSpace(code, closeAttribute + 1)
    }
    if (
      kind === PascalKeyword.Interface &&
      new RegExp(String.raw`^${PascalKeyword.End}\s*;`, "i").test(code.slice(cursor))
    )
      continue
    const start = cursor
    const section = sections.length - 1
    const routine = new RegExp(
      String.raw`^((?:${PascalKeyword.Class}\s+)?(${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\s+)([A-Za-z_][A-Za-z0-9_]*)`,
      "i",
    ).exec(code.slice(start))
    if (routine) {
      const nameOffset = start + routine[1].length
      const range = routineDeclarationRange(code, nameOffset)
      if (!range?.end) return undefined
      const directives = routineDirectiveStatements(code, range.end)
      const end = directives.at(-1)?.end ?? range.end
      members.push({
        kind: "routine",
        name: routine[3],
        nameOffset,
        start,
        attributeStart,
        headerEnd: range.end,
        end,
        section,
        access: sections[section].access,
        directives,
      })
      cursor = end
      declarationKind = undefined
      continue
    }
    // Other declarations end at a semicolon outside parentheses, generics and
    // nested record/class bodies (including anonymous record fields).
    let parentheses = 0
    let brackets = 0
    let angles = 0
    let end
    for (; cursor < code.length; cursor += 1) {
      const token = code[cursor]
      if (
        !parentheses &&
        !brackets &&
        !angles &&
        /[A-Za-z]/.test(token) &&
        !/[A-Za-z0-9_&.]/.test(code[cursor - 1] || "")
      ) {
        if (
          new RegExp(
            String.raw`^(?:${PascalKeyword.Implementation}|${PascalKeyword.Initialization}|${PascalKeyword.Finalization}|${PascalKeyword.End})\b`,
            "i",
          ).test(code.slice(cursor))
        )
          return undefined
        const nestedKind = new RegExp(
          String.raw`^(?:${PascalKeyword.Class}|${PascalKeyword.Record}|${PascalKeyword.Object}|${PascalKeyword.Interface})\b`,
          "i",
        ).exec(code.slice(cursor))
        if (
          nestedKind &&
          !new RegExp(
            String.raw`^${PascalKeyword.Class}\s+${PascalKeyword.Of}\b`,
            "i",
          ).test(code.slice(cursor))
        ) {
          const nested = structureLayout(code, cursor, depth + 1)
          if (!nested) return undefined
          end = nested.endOffset
          break
        }
      }
      if (token === "(") parentheses += 1
      else if (token === ")") parentheses -= 1
      else if (token === "[") brackets += 1
      else if (token === "]") brackets -= 1
      else if (token === "<") angles += 1
      else if (token === ">") angles = Math.max(0, angles - 1)
      else if (token === ";" && !parentheses && !brackets && !angles) {
        end = cursor + 1
        break
      }
    }
    if (!end) return undefined
    const property = new RegExp(
      String.raw`^(?:${PascalKeyword.Class}\s+)?${PascalKeyword.Property}\s+([A-Za-z_][A-Za-z0-9_]*)`,
      "i",
    ).exec(code.slice(start, end))
    const names = property
      ? [property[1]]
      : (
          /^([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/.exec(
            code.slice(start, end),
          )?.[1] || ""
        )
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
    for (const name of names) {
      members.push({
        kind: property
          ? PascalKeyword.Property
          : declarationKind === PascalKeyword.Type
            ? PascalKeyword.Type
            : "field",
        name,
        start,
        attributeStart,
        end,
        section,
        access: sections[section].access,
        accessors: property
          ? [
              ...code
                .slice(start, end)
                .matchAll(
                  new RegExp(
                    String.raw`\b(?:${PascalKeyword.Read}|${PascalKeyword.Write})\s+([A-Za-z_][A-Za-z0-9_]*)`,
                    "gi",
                  ),
                ),
            ].map((match) => match[1].toLowerCase())
          : [],
      })
    }
    cursor = end
  }
  return undefined
}

/** Read a real class definition, rejecting synthetic Navigator owners and forward-only types. */
function readClassLayout(text: string, offset: number, preparedCode?: string) {
  const code = preparedCode || maskPascalNonCode(text)
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(offset))
  if (!name) return undefined
  let cursor = skipSpace(code, offset + name[0].length)
  if (code[cursor] === "<") {
    const close = closingBracket(code, cursor, "<", ">")
    if (close < 0) return undefined
    cursor = skipSpace(code, close + 1)
  }
  if (code[cursor] !== "=") return undefined
  cursor = skipSpace(code, cursor + 1)
  if (!new RegExp(String.raw`^${PascalKeyword.Class}\b`, "i").test(code.slice(cursor)))
    return undefined
  const layout = structureLayout(code, cursor)
  return layout && { ...layout, offset, name: name[0] }
}

/** Index complete declarations once, preserving all overloads for ambiguity checks. */
function indexRoutineDeclarations<T extends NavigatorTarget>(
  nodes: T[],
): RoutineDeclarationIndex<T> {
  const bySignature = new Map<string | undefined, T[]>()
  const byName = new Map<string, T[]>()
  for (const node of nodes) {
    if (!bySignature.has(node.routineSignatureKey))
      bySignature.set(node.routineSignatureKey, [])
    bySignature.get(node.routineSignatureKey)!.push(node)
    const name = (node.name || "").toLowerCase()
    if (!byName.has(name)) byName.set(name, [])
    byName.get(name)!.push(node)
  }
  return { bySignature, byName }
}

/** Match a body exactly, or resolve a legal abbreviated heading without guessing an overload. */
function findRoutineCounterpart<T extends NavigatorTarget>(
  index: RoutineDeclarationIndex<T>,
  signature: string,
  name: string,
): T | undefined {
  const key = routineCounterpartKey(signature, name)
  if (!index || !key) return undefined
  const available = (node: NavigatorTarget) => !isInteger(node.implementationOffset)
  const exact = index.bySignature.get(key)?.find(available)
  if (exact) return exact
  if ((signature || "").includes("(")) return undefined
  const candidates = index.byName.get(name.toLowerCase()) || []
  const candidate = candidates.length === 1 ? candidates[0] : undefined
  if (
    !candidate ||
    candidate.routineOverloaded ||
    !candidate.routineSignatureKey ||
    !available(candidate)
  )
    return undefined
  const [kind, classMethod, , , result, arity = 0] = JSON.parse(key)
  const [expectedKind, expectedClass, , , expectedResult, expectedArity = 0] =
    JSON.parse(candidate.routineSignatureKey)
  return kind === expectedKind &&
    classMethod === expectedClass &&
    arity === expectedArity &&
    (!result || result === expectedResult)
    ? candidate
    : undefined
}

function lineStart(text: string, offset: number) {
  return text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1
}

/** Capture the entire declaration, including a multiline parameter/result heading. */
function routineDeclarationRange(code: string, nameOffset: number) {
  const scanStart = Math.max(0, nameOffset - 8192)
  // A heading can put the name on the next line. Match only the keyword and
  // optional qualified owner directly preceding it, not a previous routine.
  const prefix = new RegExp(
    String.raw`\b(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\s+(?:[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>]*>)?\s*\.\s*)*$`,
    "i",
  ).exec(code.slice(scanStart, nameOffset))
  if (!prefix) return undefined
  const start = scanStart + prefix.index
  const end = routineHeaderEnd(code, start)
  const heading = end < 0 ? "" : code.slice(start, end)
  // An unfinished heading must not absorb the next declaration's semicolon.
  const headers = heading.match(
    new RegExp(
      String.raw`^[ \t]*(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure}|${PascalKeyword.Constructor}|${PascalKeyword.Destructor}|${PascalKeyword.Operator})\s+[A-Za-z_]`,
      "gim",
    ),
  )
  const complete =
    end > start &&
    (headers?.length || 0) === 1 &&
    !new RegExp(
      String.raw`\b(?:${PascalKeyword.Implementation}|${PascalKeyword.Initialization}|${PascalKeyword.Finalization}|${PascalKeyword.Begin}|${PascalKeyword.End})\b`,
      "i",
    ).test(heading)
  return { start, end: complete ? end : undefined }
}

/** Constraints belong to declarations; implementation owner names use only type parameter names. */
function genericParameterNames(contents: string) {
  return splitRoutineHeaderText(contents, ";").flatMap((group) =>
    splitRoutineHeaderText(group, ":")[0]
      .split(",")
      .map((name: string) => name.trim())
      .filter((name: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)),
  )
}

function closingBracket(code: string, start: number, open: string, close: string) {
  let depth = 0
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === open) depth += 1
    else if (code[index] === close && --depth === 0) return index
  }
  return -1
}

function genericSuffix(code: string, afterName: number) {
  const start = afterName + (code.slice(afterName).match(/^\s*/)?.[0].length || 0)
  if (code[start] !== "<") return ""
  const end = closingBracket(code, start, "<", ">")
  if (end < 0) return undefined
  const names = genericParameterNames(code.slice(start + 1, end))
  return names.length ? `<${names.join(", ")}>` : undefined
}

/** Build a defining heading without defaults, declaration directives or generic constraints. */
function implementationHeading(text: string, code: string, target: NavigatorTarget) {
  const heading = code.slice(
    target.declarationStartOffset,
    target.declarationHeaderEndOffset,
  )
  const prefix = new RegExp(
    String.raw`^(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure})\s+`,
    "i",
  ).exec(heading)
  if (!prefix) return undefined
  if (!target.name) return undefined
  const methodEnd = prefix[0].length + target.name.length
  const suffix = genericSuffix(heading, methodEnd)
  if (suffix === undefined) return undefined
  let cursor = methodEnd
  while (/\s/.test(heading[cursor] || "")) cursor += 1
  if (heading[cursor] === "<") cursor = closingBracket(heading, cursor, "<", ">") + 1
  let rest = heading.slice(cursor).trim()
  if (rest.startsWith("(")) {
    const end = closingBracket(rest, 0, "(", ")")
    if (end < 0) return undefined
    const parameters = splitRoutineHeaderText(rest.slice(1, end), ";").map((group) =>
      splitRoutineHeaderText(group, "=")[0].trim(),
    )
    rest = `(${parameters.join("; ")})${rest.slice(end + 1)}`
  }
  const owners = []
  for (
    let owner = target.parent;
    owner?.kind === PascalKeyword.Type;
    owner = owner.parent
  ) {
    if (!isInteger(owner.offset) || !owner.name) return undefined
    const ownerSuffix = genericSuffix(code, owner.offset + owner.name.length)
    if (ownerSuffix === undefined) return undefined
    owners.unshift(`${owner.name}${ownerSuffix}`)
  }
  const qualified = [...owners, `${target.name}${suffix}`].join(".")
  return `${prefix[0]}${qualified}${rest}`.replace(/\s+/g, " ").trim()
}

/** Comment spans keep trailing notes and attached documentation with their original routine. */
interface CommentSpan {
  start: number
  end: number
  directive: boolean
}

function commentSpans(text: string): CommentSpan[] {
  const spans = []
  const tokens = /'(?:''|[^'])*'|\/\/[^\r\n]*|\{[^}]*\}|\(\*[\s\S]*?\*\)/g
  for (const match of text.matchAll(tokens)) {
    if (!match[0].startsWith("'"))
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        directive: /^(?:\{|\(\*)\s*\$/.test(match[0]),
      })
  }
  return spans
}

function beforeImplementation(
  text: string,
  routine: { header: { start: number } },
  comments: CommentSpan[],
) {
  let offset = lineStart(text, routine.header.start)
  if (text.slice(offset, routine.header.start).trim()) return routine.header.start
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index]
    if (comment.end > offset) continue
    const gap = text.slice(comment.end, offset)
    if (comment.directive || /\S/.test(gap) || /\n[ \t\r]*\n/.test(gap)) break
    const start = lineStart(text, comment.start)
    if (text.slice(start, comment.start).trim()) break // This note belongs to the preceding end;.
    offset = start
  }
  return offset
}

function afterImplementation(
  text: string,
  routine: { terminatorEndOffset?: number },
  comments: CommentSpan[],
) {
  let offset = routine.terminatorEndOffset ?? text.length
  for (const comment of comments) {
    if (comment.start < offset) continue
    if (!/^[ \t\r]*$/.test(text.slice(offset, comment.start))) break
    offset = comment.end
  }
  const newline = text.indexOf("\n", offset)
  if (newline >= 0 && /^[ \t\r]*$/.test(text.slice(offset, newline))) return newline + 1
  return offset
}

function conditionalDepthAt(text: string, offset: number) {
  let depth = 0
  for (const comment of commentSpans(text)) {
    if (comment.start >= offset) break
    if (!comment.directive) continue
    const match = new RegExp(
      String.raw`^(?:\{|\(\*)\s*\$\s*(${CompilerDirective.IFDEF}|${CompilerDirective.IFNDEF}|IFOPT|${CompilerDirective.IF}|${CompilerDirective.ENDIF}|${CompilerDirective.IFEND})\b`,
      "i",
    ).exec(text.slice(comment.start, comment.end))
    if (match)
      depth += new RegExp(
        String.raw`^(?:${CompilerDirective.ENDIF}|${CompilerDirective.IFEND})$`,
        "i",
      ).test(match[1])
        ? -1
        : 1
  }
  return depth
}

/**
 * Plan one insertion from the immediate declaration neighbors, then owner-local
 * alphabetical order. This pure function never changes the document or model.
 */
function planRoutineImplementation(
  text: string,
  model: CounterpartModel,
  caretOffset: number,
  editorOptions: EditorOptions = {},
): ImplementationPlan | PlanFailure {
  const code = maskPascalNonCode(text)
  const unitHeading = new RegExp(
    String.raw`^\s*${PascalKeyword.Unit}\s+[A-Za-z_][A-Za-z0-9_.]*\s*;`,
    "i",
  ).exec(code)
  const interfaceSection =
    unitHeading &&
    new RegExp(String.raw`^\s*${PascalKeyword.Interface}\b`, "i").exec(
      code.slice(unitHeading[0].length),
    )
  const implementation = /\bimplementation\b/i.exec(code)
  const finalEnd = /\bend\s*\.(?=\s*$)/i.exec(code)
  if (
    !unitHeading ||
    !interfaceSection ||
    !implementation ||
    !finalEnd ||
    unitHeading[0].length + interfaceSection[0].length >= implementation.index
  ) {
    return {
      reason:
        "A complete unit with an implementation section and closing end. is required.",
    }
  }
  const sectionStart = implementation.index + implementation[0].length
  const lifecycle = new RegExp(
    String.raw`^[ \t]*(?:${PascalKeyword.Initialization}|${PascalKeyword.Finalization})\b`,
    "im",
  ).exec(code.slice(sectionStart))
  const sectionEnd = lifecycle ? sectionStart + lifecycle.index : finalEnd.index
  const target = (model?.routineNodes || []).find(
    (node) =>
      isInteger(node.declarationStartOffset) &&
      caretOffset >= node.declarationStartOffset &&
      caretOffset <=
        (node.declarationHeaderEndOffset ?? node.declarationEndOffset ?? -1),
  )
  if (
    !target ||
    !target.name ||
    !inList(target.routineKind, [PascalKeyword.Function, PascalKeyword.Procedure])
  ) {
    return { reason: "Place one caret in a function or procedure declaration." }
  }
  const classMethod =
    target.parent?.kind === PascalKeyword.Type &&
    target.parent.typeKind === PascalKeyword.Class
  const global =
    !target.owner &&
    target.routineFlavor === "global" &&
    (target.declarationOffset ?? Infinity) < implementation.index
  if (!classMethod && !global)
    return {
      reason:
        "Only class methods and global interface routines can be implemented here.",
    }
  if (!isInteger(target.declarationHeaderEndOffset))
    return {
      reason: "Complete the routine heading before creating its implementation.",
    }
  if (isInteger(target.implementationOffset))
    return { reason: "This routine already has an implementation." }
  const directives = methodDeclarationDirectives(code, target)
  if (directives.has(PascalKeyword.Abstract) || directives.has(PascalKeyword.External))
    return { reason: "This routine does not require a local implementation." }
  const bodies = model.implementationRoutines || []
  if (
    bodies.some(
      (body) =>
        !body.complete ||
        body.header.start < sectionStart ||
        (body.terminatorEndOffset ?? body.end) > sectionEnd,
    )
  ) {
    return {
      reason:
        "Complete the existing implementation blocks before inserting a new routine.",
    }
  }
  const sameOwner = (node: NavigatorTarget) =>
    classMethod
      ? node.parent === target.parent
      : !node.owner && node.routineFlavor === "global"
  const declarations = model.routineNodes
    .filter(
      (node: NavigatorTarget) =>
        sameOwner(node) &&
        isInteger(node.declarationOffset) &&
        (classMethod || (node.declarationOffset ?? Infinity) < implementation.index),
    )
    .sort(
      (left: NavigatorTarget, right: NavigatorTarget) =>
        (left.declarationOffset ?? 0) - (right.declarationOffset ?? 0),
    )
  const index = declarations.indexOf(target)
  const counterpart = (node: NavigatorTarget) =>
    bodies.find((body) => body.header.nameOffset === node?.implementationOffset)
  const previous = counterpart(declarations[index - 1])
  const next = counterpart(declarations[index + 1])
  let anchor
  let before = false
  if (
    previous &&
    next &&
    Math.abs(bodies.indexOf(previous) - bodies.indexOf(next)) === 1
  ) {
    // Physical adjacency wins even if implementation order reverses declaration order.
    anchor = previous.header.start < next.header.start ? previous : next
  } else if (previous) anchor = previous
  else if (next) {
    anchor = next
    before = true
  } else {
    const ownerBodies = bodies.filter((body) => {
      if (global) return !body.header.owner
      return model.routineNodes.some(
        (node: NavigatorTarget) =>
          sameOwner(node) && node.implementationOffset === body.header.nameOffset,
      )
    })
    const name = (target.name || "").toLowerCase()
    const equal = ownerBodies.filter((body) => body.header.name.toLowerCase() === name)
    if (equal.length)
      anchor = equal.at(-1) // Keep overloads together.
    else {
      anchor = ownerBodies.find((body) => body.header.name.toLowerCase() > name)
      before = Boolean(anchor)
      if (!anchor) anchor = ownerBodies.at(-1)
    }
    if (!anchor) anchor = bodies.at(-1)
  }
  const comments = commentSpans(text)
  const boundaryLineStart = lineStart(text, sectionEnd)
  const offset = anchor
    ? before
      ? beforeImplementation(text, anchor, comments)
      : afterImplementation(text, anchor, comments)
    : boundaryLineStart >= sectionStart
      ? boundaryLineStart
      : sectionEnd
  if (
    offset < sectionStart ||
    offset > sectionEnd ||
    conditionalDepthAt(text, target.declarationStartOffset ?? 0) ||
    conditionalDepthAt(text, offset)
  )
    return {
      reason: "The declaration or insertion boundary cannot be safely resolved.",
    }
  const heading = implementationHeading(text, code, target)
  if (!heading) return { reason: "The routine heading is incomplete or unsupported." }
  const eol = editorOptions.eol || (text.includes("\r\n") ? "\r\n" : "\n")
  const tabSize = Number(editorOptions.tabSize)
  const indentUnit =
    editorOptions.insertSpaces === false
      ? "\t"
      : " ".repeat(Number.isFinite(tabSize) && tabSize > 0 ? Math.floor(tabSize) : 2)
  const indent = anchor
    ? text
        .slice(lineStart(text, anchor.header.start), anchor.header.start)
        .match(/^[ \t]*/)?.[0] || ""
    : ""
  const keyword =
    new RegExp(
      String.raw`^(?:${PascalKeyword.Class}\s+)?(${PascalKeyword.Function}|${PascalKeyword.Procedure})`,
      "i",
    ).exec(heading)?.[1] || ""
  const casing = (word: string) =>
    keyword === keyword.toUpperCase()
      ? word.toUpperCase()
      : /^[A-Z][a-z]+$/.test(keyword)
        ? word[0].toUpperCase() + word.slice(1)
        : word
  const leftBreaks =
    text
      .slice(0, offset)
      .match(/(?:\r?\n[ \t]*)+$/)?.[0]
      .match(/\n/g)?.length || 0
  const rightBreaks =
    text
      .slice(offset)
      .match(/^(?:[ \t]*\r?\n)+/)?.[0]
      .match(/\n/g)?.length || 0
  const prefix = eol.repeat(Math.max(0, 2 - leftBreaks))
  const start = `${prefix}${indent}${heading}${eol}${indent}${casing(PascalKeyword.Begin)}${eol}${indent}${indentUnit}`
  const insertion = `${start}${eol}${indent}${casing(PascalKeyword.End)};${eol.repeat(Math.max(0, 2 - rightBreaks))}`
  return {
    offset,
    text: insertion,
    caretOffset: offset + start.length,
    targetId: target.id,
  }
}

/** Compact code whitespace without changing defaults or swallowing code after line comments. */
function compactRoutineHeading(text: string) {
  const literals: string[] = []
  const protectedText = text.replace(
    /'(?:''|[^'])*'|\/\/[^\r\n]*|\{[^}]*\}|\(\*[\s\S]*?\*\)/g,
    (token: string) => {
      literals.push(
        token.startsWith("//")
          ? token + (text.includes("\r\n") ? "\r\n" : "\n")
          : token,
      )
      return `\0${literals.length - 1}\0`
    },
  )
  return protectedText
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\0(\d+)\0/g, (_: string, index: string) => literals[Number(index)])
}

function keywordCase(word: string, reference: string | undefined) {
  const first = reference?.match(/[A-Za-z]+/)?.[0] || ""
  return first && first === first.toUpperCase()
    ? word.toUpperCase()
    : /^[A-Z][a-z]+$/.test(first)
      ? word[0].toUpperCase() + word.slice(1)
      : word
}

function declarationFromBody(
  text: string,
  code: string,
  body: RoutineBody,
  overloaded: boolean,
) {
  const prefix = new RegExp(
    String.raw`^(?:${PascalKeyword.Class}\s+)?(${PascalKeyword.Function}|${PascalKeyword.Procedure})\s+`,
    "i",
  ).exec(code.slice(body.header.start))
  if (!prefix || body.header.headerEnd < 0) return undefined
  const heading = compactRoutineHeading(
    text.slice(body.header.start, body.header.start + prefix[0].length) +
      text.slice(body.header.nameOffset, body.header.headerEnd),
  )
  const key = routineCounterpartKey(heading, body.header.name)
  if (!key) return undefined
  const [kind, , , parameters, result] = JSON.parse(key) as [
    string,
    boolean,
    string,
    Array<[string, string]>,
    string,
  ]
  if (
    (kind === PascalKeyword.Function && !result) ||
    (kind === PascalKeyword.Procedure && result) ||
    parameters.some(([mode, type]) => !mode && !type)
  )
    return undefined
  const directives = routineDirectiveStatements(code, body.header.headerEnd)
    .filter((item) =>
      new RegExp(
        String.raw`^(${PascalKeyword.Cdecl}|${PascalKeyword.Stdcall}|${PascalKeyword.Safecall}|${PascalKeyword.Register}|pascal|${PascalKeyword.Varargs})$`,
      ).test(item.name),
    )
    .map((item) => compactRoutineHeading(text.slice(item.start, item.end)))
  if (overloaded)
    directives.unshift(`${keywordCase(PascalKeyword.Overload, prefix[1])};`)
  return {
    text: [heading, ...directives].join(" "),
    key,
    nameOffset:
      new RegExp(
        String.raw`^(?:${PascalKeyword.Class}\s+)?(?:${PascalKeyword.Function}|${PascalKeyword.Procedure})\s+`,
        "i",
      ).exec(maskPascalNonCode(heading))?.[0].length || 0,
  }
}

/** Parameter modes, result types and routine kinds cannot distinguish an overload. */
function overloadParameterKey(key: string) {
  const [, , name, parameters, , arity = 0] = JSON.parse(key) as [
    string,
    boolean,
    string,
    Array<[string, string]>,
    string,
    number?,
  ]
  return JSON.stringify([name, arity, parameters.map(([, type]) => type)])
}

function declarationEntry(
  text: string,
  code: string,
  member: Omit<StructureMember, "kind"> & { kind?: string },
): DeclarationEntry {
  const signature = text.slice(member.start, member.headerEnd ?? member.end)
  return {
    ...member,
    headerEnd: member.headerEnd ?? member.end,
    directives: member.directives || [],
    signature,
    routineSignatureKey: routineCounterpartKey(signature, member.name),
    routineOverloaded: (member.directives || []).some(
      (item) => item.name === PascalKeyword.Overload,
    ),
  }
}

function declarationInsertionBefore(
  text: string,
  entry: DeclarationEntry,
  comments: CommentSpan[],
) {
  return beforeImplementation(
    text,
    { header: { start: entry.attributeStart ?? entry.start } },
    comments,
  )
}

function declarationInsertionAfter(
  text: string,
  entry: DeclarationEntry,
  comments: CommentSpan[],
) {
  return afterImplementation(text, { terminatorEndOffset: entry.end }, comments)
}

/** Keep insertions at the same position ordered and translate the caret through all repairs. */
function finishCounterpartPlan(
  main: SourceEdit & { caretRelative: number },
  repairs: SourceEdit[],
  targetId: string | undefined,
  direction: string,
): CounterpartPlan | PlanFailure {
  let caretRelative = main.caretRelative
  const edits = []
  for (const repair of repairs) {
    if (
      repair.offset === main.offset &&
      repair.endOffset === repair.offset &&
      main.endOffset === main.offset
    ) {
      main = { ...main, text: repair.text + main.text }
      caretRelative += repair.text.length
    } else edits.push(repair)
  }
  edits.push({ offset: main.offset, endOffset: main.endOffset, text: main.text })
  edits.sort((left, right) => left.offset - right.offset)
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].offset < edits[index - 1].endOffset)
      return { reason: "The required declaration edits overlap." }
  }
  const shift = edits
    .filter((edit) => edit.offset < main.offset)
    .reduce((sum, edit) => sum + edit.text.length - (edit.endOffset - edit.offset), 0)
  return {
    edits,
    caretOffset: main.offset + caretRelative + shift,
    targetId,
    direction,
  }
}

/**
 * Create a missing declaration using immediate implementation neighbors. Class
 * anchors prefer protected, then private; otherwise placement uses public names.
 */
function planRoutineDeclaration(
  text: string,
  model: CounterpartModel,
  caretOffset: number,
  editorOptions: EditorOptions = {},
): CounterpartPlan | PlanFailure {
  const code = maskPascalNonCode(text)
  const unitHeading = new RegExp(
    String.raw`^\s*${PascalKeyword.Unit}\s+[A-Za-z_][A-Za-z0-9_.]*\s*;\s*${PascalKeyword.Interface}\b`,
    "i",
  ).exec(code)
  const implementation = /\bimplementation\b/i.exec(code)
  if (!unitHeading || !implementation || !/\bend\s*\.(?=\s*$)/i.test(code)) {
    return {
      reason:
        "A complete unit with an interface and implementation section is required.",
    }
  }
  const bodies = model?.implementationRoutines || []
  const body = bodies.find(
    (item) =>
      caretOffset >= item.header.start &&
      caretOffset <= (item.terminatorEndOffset ?? item.end),
  )
  if (!body)
    return {
      reason: "Place one caret in a top-level function or procedure implementation.",
    }
  if (
    body.children.some(
      (child) => caretOffset >= child.header.start && caretOffset < child.end,
    )
  ) {
    return {
      reason: "Local routines cannot have class or unit-interface declarations.",
    }
  }
  const target = model.routineNodes.find(
    (node: NavigatorTarget) => node.implementationOffset === body.header.nameOffset,
  )
  if (
    !target ||
    !target.name ||
    !inList(target.routineKind, [PascalKeyword.Function, PascalKeyword.Procedure]) ||
    !body.complete
  ) {
    return {
      reason:
        "Complete the function or procedure implementation before creating its declaration.",
    }
  }
  if (conditionalDepthAt(text, body.header.start))
    return { reason: "The implementation is inside an unresolved conditional section." }
  const owner = body.header.owner ? target.parent : undefined
  const global = !body.header.owner && target.routineFlavor === "global"
  const layout =
    owner?.kind === PascalKeyword.Type && owner.typeKind === PascalKeyword.Class
      ? readClassLayout(text, owner.offset ?? 0, code)
      : undefined
  if (!global && (!layout || layout.forward))
    return { reason: "The owning class definition is unavailable or incomplete." }
  if (
    (layout &&
      layout.members.some(
        (member) =>
          member.kind === "routine" && member.nameOffset === target.declarationOffset,
      )) ||
    (global && (target.declarationOffset ?? Infinity) < implementation.index)
  )
    return { reason: "This routine already has a declaration." }
  const bodyDirectives = routineDirectiveStatements(code, body.header.headerEnd)
  if (bodyDirectives.some((item) => item.name === PascalKeyword.Forward))
    return { reason: "A forward declaration is not a routine implementation." }
  let declarations
  if (layout)
    declarations = layout.members
      .filter((member) => member.kind === "routine")
      .map((member) => declarationEntry(text, code, member))
  else
    declarations = model.routineNodes
      .filter(
        (node: NavigatorTarget) =>
          !node.owner &&
          node.routineFlavor === "global" &&
          (node.declarationOffset ?? Infinity) < implementation.index,
      )
      .map((node: NavigatorTarget) => {
        const directives = routineDirectiveStatements(
          code,
          node.declarationHeaderEndOffset,
        )
        return declarationEntry(text, code, {
          name: node.name || "",
          nameOffset: node.declarationOffset,
          start: node.declarationStartOffset ?? 0,
          headerEnd: node.declarationHeaderEndOffset,
          end: directives.at(-1)?.end ?? node.declarationHeaderEndOffset ?? 0,
          directives,
        })
      })
  if (declarations.some((entry) => !entry.headerEnd || !entry.routineSignatureKey)) {
    return { reason: "Complete the existing declarations before adding a counterpart." }
  }
  const heading = declarationFromBody(text, code, body, false)
  if (!heading)
    return {
      reason:
        "The implementation must supply a complete parameter and result signature.",
    }
  if (declarations.some((entry) => entry.routineSignatureKey === heading.key))
    return { reason: "This routine already has a declaration." }
  const family = declarations.filter(
    (entry) => entry.name.toLowerCase() === (target.name || "").toLowerCase(),
  )
  if (
    family.some(
      (entry) =>
        overloadParameterKey(entry.routineSignatureKey || "") ===
        overloadParameterKey(heading.key),
    )
  ) {
    return {
      reason:
        "An existing declaration has incompatible parameters, modifiers or result type; correct that signature first.",
    }
  }
  if (
    layout?.members.some(
      (member) =>
        (member.kind !== "routine" &&
          member.name.toLowerCase() === (target.name || "").toLowerCase()) ||
        (family.length &&
          member.accessors?.includes((target.name || "").toLowerCase())),
    )
  ) {
    return {
      reason: "The name conflicts with a class member or property-accessor contract.",
    }
  }
  const sameOwner = (item: RoutineBody) =>
    global
      ? !item.header.owner
      : model.routineNodes.some(
          (node: NavigatorTarget) =>
            node.parent === owner &&
            node.implementationOffset === item.header.nameOffset,
        )
  const ownerBodies = bodies.filter(sameOwner)
  const index = indexRoutineDeclarations(declarations)
  const entryByBody = new Map<RoutineBody, DeclarationEntry>()
  for (const item of ownerBodies) {
    const entry = findRoutineCounterpart(
      index,
      text.slice(item.header.start, item.header.headerEnd),
      item.header.name,
    )
    if (entry) {
      entry.implementationOffset = item.header.nameOffset
      entryByBody.set(item, entry)
    }
  }
  if (entryByBody.has(body))
    return { reason: "This routine already has a declaration." }
  // Private global overloads need not be exported, but their defining
  // declarations still participate in the unit's overload family.
  if (global) {
    for (const item of ownerBodies) {
      if (
        item === body ||
        entryByBody.has(item) ||
        item.header.name.toLowerCase() !== (target.name || "").toLowerCase()
      )
        continue
      if (!declarationFromBody(text, code, item, false))
        return {
          reason:
            "Complete the related overload headings before creating a declaration.",
        }
      const directives = routineDirectiveStatements(code, item.header.headerEnd)
      const entry = declarationEntry(text, code, {
        name: item.header.name,
        nameOffset: item.header.nameOffset,
        start: item.header.start,
        headerEnd: item.header.headerEnd,
        end: directives.at(-1)?.end ?? item.header.headerEnd,
        directives,
      })
      if (
        overloadParameterKey(entry.routineSignatureKey || "") ===
        overloadParameterKey(heading.key)
      )
        return {
          reason: "A global routine with incompatible signature already exists.",
        }
      entry.implementationOffset = item.header.nameOffset
      family.push(entry)
    }
  }
  const position = ownerBodies.indexOf(body)
  let previous = entryByBody.get(ownerBodies[position - 1])
  let next = entryByBody.get(ownerBodies[position + 1])
  const category = (access: string | undefined) =>
    access?.replace(new RegExp(String.raw`^${PascalKeyword.Strict}-`), "")
  let section: StructureSection | undefined
  if (layout) {
    const available = [previous, next].filter(
      (entry): entry is DeclarationEntry => entry !== undefined,
    )
    const preferred = available.some(
      (entry) => category(entry.access) === PascalKeyword.Protected,
    )
      ? PascalKeyword.Protected
      : available.some((entry) => category(entry.access) === PascalKeyword.Private)
        ? PascalKeyword.Private
        : PascalKeyword.Public
    previous = category(previous?.access) === preferred ? previous : undefined
    next = category(next?.access) === preferred ? next : undefined
    section = layout.sections[(previous || next)?.section ?? -1]
    // Separate blocks have separate lexical scopes, even with equal visibility.
    if (previous && next && previous.section !== next.section) next = undefined
  }
  let anchor
  let before = false
  const ordered = declarations
    .filter((entry) => !layout || entry.section === (previous || next)?.section)
    .sort((left, right) => left.start - right.start)
  if (
    previous &&
    next &&
    Math.abs(ordered.indexOf(previous) - ordered.indexOf(next)) === 1
  ) {
    anchor = previous.start < next.start ? previous : next
  } else if (previous) anchor = previous
  else if (next) {
    anchor = next
    before = true
  } else {
    const pool = declarations
      .filter((entry) => !layout || entry.access === PascalKeyword.Public)
      .sort((left, right) => left.start - right.start)
    const equal = pool.filter(
      (entry) => entry.name.toLowerCase() === (target.name || "").toLowerCase(),
    )
    if (equal.length) anchor = equal.at(-1)
    else {
      anchor = pool.find(
        (entry) => entry.name.toLowerCase() > (target.name || "").toLowerCase(),
      )
      before = Boolean(anchor)
      anchor ||= pool.at(-1)
    }
    section = layout
      ? anchor
        ? layout.sections[anchor.section ?? -1]
        : layout.sections.find((item) => item.access === PascalKeyword.Public)
      : undefined
  }
  const eol = editorOptions.eol || (text.includes("\r\n") ? "\r\n" : "\n")
  const size = Number(editorOptions.tabSize)
  const indentUnit =
    editorOptions.insertSpaces === false
      ? "\t"
      : " ".repeat(Number.isFinite(size) && size > 0 ? Math.floor(size) : 2)
  const leadingIndent = (offset: number) =>
    text.slice(lineStart(text, offset), offset).match(/^[ \t]*/)?.[0] || ""
  const classIndent = layout ? leadingIndent(layout.offset) : ""
  const visibilityIndent = layout
    ? leadingIndent(
        layout.sections.find((item) => !item.implicit)?.start ?? layout.offset,
      )
    : ""
  const sample =
    anchor ||
    layout?.members.find(
      (member) => member.section === (section ? layout.sections.indexOf(section) : -1),
    ) ||
    layout?.members[0]
  const memberIndent =
    sample && !text.slice(lineStart(text, sample.start), sample.start).trim()
      ? leadingIndent(sample.start)
      : layout
        ? visibilityIndent + indentUnit
        : ""
  const needsOverload =
    family.length > 0 ||
    bodyDirectives.some((item) => item.name === PascalKeyword.Overload)
  if (
    needsOverload &&
    layout?.members.some((member) =>
      member.accessors?.includes((target.name || "").toLowerCase()),
    )
  ) {
    return { reason: "A property-accessor contract cannot be made overloaded." }
  }
  const completeHeading = declarationFromBody(text, code, body, needsOverload)
  if (!completeHeading)
    return { reason: "The implementation heading cannot be safely resolved." }
  const comments = commentSpans(text)
  let main: SourceEdit & { caretRelative: number }
  if (layout?.shorthand) {
    const label = keywordCase(PascalKeyword.Public, layout.keyword)
    const prefix = `${eol}${visibilityIndent}${label}${eol}${memberIndent}`
    main = {
      offset: layout.endOffset - 1,
      endOffset: layout.endOffset,
      text: `${prefix}${completeHeading.text}${eol}${classIndent}${keywordCase(PascalKeyword.End, layout.keyword)};`,
      caretRelative: prefix.length + completeHeading.nameOffset,
    }
  } else {
    const boundary = layout
      ? (section?.end ?? layout.closingStart ?? layout.endOffset)
      : implementation.index
    let offset = anchor
      ? before
        ? declarationInsertionBefore(text, anchor, comments)
        : declarationInsertionAfter(text, anchor, comments)
      : beforeImplementation(text, { header: { start: boundary } }, comments)
    if (layout && offset < (section?.bodyStart ?? layout.bodyStart)) offset = boundary
    if (offset < (layout?.bodyStart ?? unitHeading[0].length) || offset > boundary)
      return { reason: "The declaration boundary cannot be safely resolved." }
    const midLine = Boolean(text.slice(lineStart(text, offset), offset).trim())
    let prefix = midLine ? eol : ""
    if (layout && !section)
      prefix += `${visibilityIndent}${keywordCase(PascalKeyword.Public, layout.sections.find((item) => item.spelling)?.spelling || layout.keyword)}${eol}`
    if (!layout && !anchor && !/\n[ \t\r]*\n$/.test(text.slice(0, offset)))
      prefix += eol
    prefix += memberIndent
    main = {
      offset,
      endOffset: offset,
      text: `${prefix}${completeHeading.text}${eol}${!layout && !anchor ? eol : ""}`,
      caretRelative: prefix.length + completeHeading.nameOffset,
    }
  }
  if (conditionalDepthAt(text, main.offset))
    return {
      reason: "The declaration boundary is inside an unresolved conditional section.",
    }
  if (section && !section.implicit && conditionalDepthAt(text, section.start))
    return {
      reason:
        "The selected visibility section is conditional and cannot be resolved safely.",
    }
  const repairs = []
  for (const entry of family) {
    if (conditionalDepthAt(text, entry.start))
      return {
        reason: "An overload declaration is inside an unresolved conditional section.",
      }
    if (!entry.routineOverloaded) {
      const offset =
        entry.directives.find((item) => item.name === PascalKeyword.Reintroduce)?.end ??
        entry.headerEnd
      const reference = new RegExp(
        String.raw`^(?:${PascalKeyword.Class}\s+)?([A-Za-z]+)`,
        "i",
      ).exec(code.slice(entry.start))?.[1]
      repairs.push({
        offset,
        endOffset: offset,
        text: ` ${keywordCase(PascalKeyword.Overload, reference)};`,
      })
    }
    const existing = ownerBodies.find(
      (item) => item.header.nameOffset === entry.implementationOffset,
    )
    if (
      existing &&
      !code.slice(existing.header.nameOffset, existing.header.headerEnd).includes("(")
    ) {
      // Adding overload makes abbreviated defining headings invalid. Insert only
      // the known parameters/result, preserving qualification, comments and body.
      let nameEnd = existing.header.nameOffset + existing.header.name.length
      const genericStart = skipSpace(code, nameEnd)
      if (code[genericStart] === "<")
        nameEnd = closingBracket(code, genericStart, "<", ">") + 1
      const defining = implementationHeading(text, code, {
        ...entry,
        declarationStartOffset: entry.start,
        declarationHeaderEndOffset: entry.headerEnd,
      })
      if (!defining)
        return { reason: "An existing overload heading cannot be expanded safely." }
      const start = defining.indexOf("(")
      const end = start < 0 ? -1 : closingBracket(defining, start, "(", ")")
      let addition = start < 0 ? "" : defining.slice(start, end + 1)
      const result = defining
        .slice(end < 0 ? defining.indexOf(":") : end + 1)
        .replace(/;\s*$/, "")
      if (
        !code.slice(nameEnd, existing.header.headerEnd).includes(":") &&
        /^\s*:/.test(result)
      )
        addition += result
      if (addition) {
        if (conditionalDepthAt(text, nameEnd))
          return {
            reason:
              "An abbreviated overload is inside an unresolved conditional section.",
          }
        repairs.push({ offset: nameEnd, endOffset: nameEnd, text: addition })
      }
    }
  }
  return finishCounterpartPlan(main, repairs, target.id, "declaration")
}

/** Dispatch by source position while retaining the original forward planner's API. */
function planRoutineCounterpart(
  text: string,
  model: CounterpartModel,
  caretOffset: number,
  editorOptions: EditorOptions = {},
): CounterpartPlan | PlanFailure {
  const implementation = /\bimplementation\b/i.exec(maskPascalNonCode(text))
  const declaration = model?.routineNodes?.find(
    (node: NavigatorTarget) =>
      isInteger(node.declarationStartOffset) &&
      caretOffset >= node.declarationStartOffset &&
      caretOffset <=
        (node.declarationHeaderEndOffset ?? node.declarationEndOffset ?? -1) &&
      (node.parent?.kind === PascalKeyword.Type ||
        (node.declarationOffset ?? Infinity) < (implementation?.index ?? -1)),
  )
  if (!declaration)
    return planRoutineDeclaration(text, model, caretOffset, editorOptions)
  const plan = planRoutineImplementation(text, model, caretOffset, editorOptions)
  return plan.reason !== undefined
    ? plan
    : {
        ...plan,
        direction: PascalKeyword.Implementation,
        edits: [{ offset: plan.offset, endOffset: plan.offset, text: plan.text }],
      }
}

/** Execute a version-checked counterpart edit and all required repairs in one undo group. */
function createImplementationCommand<
  P extends EditorPosition,
  R extends EditorRange<P>,
  S extends EditorSelection<P>,
  U extends { scheme?: string; toString(): string },
>(
  vscode: ImplementationApi<P, R, S, U>,
  {
    readyModel,
    onCreated,
  }: {
    readyModel(
      document: EditableDocument<P, U>,
    ): PromiseLike<CounterpartModel | undefined>
    onCreated?: (
      document: EditableDocument<P, U>,
      targetId: string | undefined,
    ) => unknown
  },
) {
  const pending = new Set()
  return async () => {
    const editor = vscode.window.activeTextEditor
    const document = editor?.document
    const inform = (message: string) => {
      void vscode.window.showInformationMessage(message)
      return false
    }
    if (
      !document ||
      !inList(document.languageId, [LanguageId.Pascal, LanguageId.ObjectPascal]) ||
      !vscode.workspace
        .getConfiguration(ConfigurationSection, document.uri)
        .get(SettingKey.Enabled, true)
    )
      return false
    if (vscode.workspace.fs?.isWritableFileSystem(document.uri.scheme || "") === false)
      return inform("The current document is read-only.")
    if (editor.selections.length !== 1 || !editor.selection.isEmpty)
      return inform(
        "Use one caret without a selection to create a routine counterpart.",
      )
    const uri = document.uri.toString()
    if (pending.has(uri))
      return inform("A routine counterpart is already being created for this document.")
    pending.add(uri)
    const version = document.version
    const caret = document.offsetAt(editor.selection.active)
    try {
      const model = await readyModel(document)
      if (
        vscode.window.activeTextEditor !== editor ||
        document.isClosed ||
        document.version !== version ||
        editor.selections.length !== 1 ||
        !editor.selection.isEmpty ||
        document.offsetAt(editor.selection.active) !== caret
      ) {
        return inform(
          "The document, caret or active editor changed. Invoke Create Missing Routine Counterpart again.",
        )
      }
      if (!model) return inform("The current source model is not available.")
      const plan = planRoutineCounterpart(document.getText(), model, caret, {
        ...editor.options,
        eol: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
      })
      if (plan.reason !== undefined) return inform(plan.reason)
      let inserted = false
      const changed = await editor.edit(
        (builder) => {
          if (document.version !== version || vscode.window.activeTextEditor !== editor)
            return
          for (const edit of plan.edits) {
            if (edit.endOffset === edit.offset)
              builder.insert(document.positionAt(edit.offset), edit.text)
            else
              builder.replace(
                new vscode.Range(
                  document.positionAt(edit.offset),
                  document.positionAt(edit.endOffset),
                ),
                edit.text,
              )
          }
          inserted = true
        },
        { undoStopBefore: true, undoStopAfter: true },
      )
      if (!changed || !inserted)
        return inform(
          "The routine counterpart could not be inserted into the current document.",
        )
      if (vscode.window.activeTextEditor === editor) {
        const position = document.positionAt(plan.caretOffset)
        editor.selection = new vscode.Selection(position, position)
        editor.revealRange(
          new vscode.Range(position, position),
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        )
      }
      await onCreated?.(document, plan.targetId)
      return true
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Could not create the routine counterpart: ${errorMessage(error)}`,
      )
      return false
    } finally {
      pending.delete(uri)
    }
  }
}

export {
  descendantTypeDefinitions,
  enclosingRoutineOwner,
  memberImplementationDefinitions,
  routineImplementationDefinitions,
  methodDeclarationDirectives,
  readClassLayout,
  routineDirectiveStatements,
  createImplementationCommand,
  findRoutineCounterpart,
  indexRoutineDeclarations,
  planRoutineImplementation,
  planRoutineDeclaration,
  planRoutineCounterpart,
  compactRoutineHeading,
  routineDeclarationRange,
  routineCounterpartKey,
  routineHeaderEnd,
  typeKey,
}
