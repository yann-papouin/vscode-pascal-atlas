import { inList } from "../shared/guards"
interface HighlightRange {
  line: number
  start: number
  end: number
}
interface KeywordToken extends HighlightRange {
  keyword: string
  indent: number
}
import { PascalKeyword } from "../shared/pascal"
import { Position } from "vscode"
import { maskPascalLines } from "./postprocess"

const DEFAULT_BLOCK_LEVEL_COLORS = Object.freeze(["#E06C75", "#D19A66", "#C586C0"])
const COLOR_VALUE = /^#[0-9a-f]{6}$/i
const PASCAL_KEYWORDS = new Set<string>([
  PascalKeyword.Absolute,
  PascalKeyword.Abstract,
  PascalKeyword.And,
  PascalKeyword.Array,
  PascalKeyword.As,
  PascalKeyword.Asm,
  PascalKeyword.Assembler,
  PascalKeyword.Begin,
  PascalKeyword.Break,
  PascalKeyword.Case,
  PascalKeyword.Class,
  PascalKeyword.Const,
  PascalKeyword.Constructor,
  PascalKeyword.Contains,
  PascalKeyword.Continue,
  PascalKeyword.Destructor,
  PascalKeyword.Dispinterface,
  PascalKeyword.Div,
  PascalKeyword.Do,
  PascalKeyword.Downto,
  PascalKeyword.Else,
  PascalKeyword.End,
  PascalKeyword.Except,
  PascalKeyword.Exit,
  PascalKeyword.Exports,
  PascalKeyword.External,
  PascalKeyword.File,
  PascalKeyword.Finalization,
  PascalKeyword.Finally,
  PascalKeyword.For,
  PascalKeyword.Forward,
  PascalKeyword.Function,
  PascalKeyword.Goto,
  PascalKeyword.Halt,
  PascalKeyword.Helper,
  PascalKeyword.If,
  PascalKeyword.Implementation,
  PascalKeyword.In,
  PascalKeyword.Inherited,
  PascalKeyword.Initialization,
  PascalKeyword.Inline,
  PascalKeyword.Interface,
  PascalKeyword.Is,
  PascalKeyword.Label,
  PascalKeyword.Library,
  PascalKeyword.Mod,
  PascalKeyword.Nil,
  PascalKeyword.Not,
  PascalKeyword.Object,
  PascalKeyword.Of,
  PascalKeyword.Operator,
  PascalKeyword.Or,
  PascalKeyword.Out,
  PascalKeyword.Package,
  PascalKeyword.Packed,
  PascalKeyword.Procedure,
  PascalKeyword.Program,
  PascalKeyword.Property,
  PascalKeyword.Raise,
  PascalKeyword.Record,
  PascalKeyword.Reference,
  PascalKeyword.Repeat,
  PascalKeyword.Resourcestring,
  PascalKeyword.Set,
  PascalKeyword.Shl,
  PascalKeyword.Shr,
  PascalKeyword.Then,
  PascalKeyword.Threadvar,
  PascalKeyword.To,
  PascalKeyword.Try,
  PascalKeyword.Type,
  PascalKeyword.Unit,
  PascalKeyword.Until,
  PascalKeyword.Uses,
  PascalKeyword.Var,
  PascalKeyword.While,
  PascalKeyword.With,
  PascalKeyword.Xor,
])
const KEYWORD_IDENTIFIER = /\b[A-Za-z_][A-Za-z0-9_]*\b/g

function normalizeBlockLevelColors(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    return [...DEFAULT_BLOCK_LEVEL_COLORS]
  }
  const colors = value.map((color) => String(color || "").trim())
  return colors.every((color) => COLOR_VALUE.test(color))
    ? colors
    : [...DEFAULT_BLOCK_LEVEL_COLORS]
}

function keywordTokenKey(token: HighlightRange) {
  return `${token.line}:${token.start}:${token.end}`
}

function findDelphiKeywordMatchGroup(
  text: string,
  position: Pick<Position, "line" | "character">,
) {
  const lines = text.split(/\r\n|\n|\r/)
  const codeLines = maskPascalLines(lines)
  const tokens: KeywordToken[] = []

  for (let line = 0; line < codeLines.length; line += 1) {
    const codeLine = codeLines[line]
    const indent = leadingIndentColumns(codeLine, 2)
    KEYWORD_IDENTIFIER.lastIndex = 0
    let match
    while ((match = KEYWORD_IDENTIFIER.exec(codeLine)) !== null) {
      const keyword = match[0].toLowerCase()
      if (!PASCAL_KEYWORDS.has(keyword)) continue
      // Delphi permits escaped identifiers and contextual words as members.
      // A token following `.` or `&` is a symbol, not a structural keyword.
      if (/[.&]\s*$/.test(codeLine.slice(0, match.index))) continue
      tokens.push({
        keyword,
        line,
        start: match.index,
        end: match.index + match[0].length,
        indent,
      })
    }
  }

  const current = tokens.find(
    (token) =>
      token.line === position.line &&
      position.character >= token.start &&
      position.character < token.end,
  )
  if (!current) return undefined

  const matchesByToken = new Map<string, Map<string, KeywordToken>>()
  const addGroup = (group: KeywordToken[]) => {
    const unique = [
      ...new Map(
        group.map((token: KeywordToken) => [keywordTokenKey(token), token]),
      ).values(),
    ]
    for (const token of unique) {
      const key = keywordTokenKey(token)
      if (!matchesByToken.has(key)) matchesByToken.set(key, new Map())
      const matches = matchesByToken.get(key)
      if (!matches) continue
      for (const member of unique) matches.set(keywordTokenKey(member), member)
    }
  }

  const blockStack = []
  const typeKinds = new Set<string>([
    PascalKeyword.Class,
    PascalKeyword.Record,
    PascalKeyword.Object,
    PascalKeyword.Interface,
  ])
  for (const token of tokens) {
    if (typeKinds.has(token.keyword)) {
      const codeLine = codeLines[token.line]
      if (
        isTypeBlockKeyword(codeLine, token.start) &&
        typeDeclarationHasBody(codeLine, token.end)
      ) {
        blockStack.push({ kind: token.keyword, token, group: [token] })
      }
      continue
    }
    if (
      inList(token.keyword, [
        PascalKeyword.Begin,
        PascalKeyword.Case,
        PascalKeyword.Try,
        PascalKeyword.Asm,
      ])
    ) {
      blockStack.push({ kind: token.keyword, token, group: [token] })
      continue
    }
    if (token.keyword === PascalKeyword.Repeat) {
      blockStack.push({ kind: PascalKeyword.Repeat, token, group: [token] })
      continue
    }
    if (token.keyword === PascalKeyword.Of) {
      const opening = [...blockStack]
        .reverse()
        .find(
          (item) =>
            item.kind === PascalKeyword.Case &&
            !item.group.some((member) => member.keyword === PascalKeyword.Of),
        )
      if (opening) opening.group.push(token)
      continue
    }
    if (
      token.keyword === PascalKeyword.Except ||
      token.keyword === PascalKeyword.Finally
    ) {
      const opening = [...blockStack]
        .reverse()
        .find((item) => item.kind === PascalKeyword.Try)
      if (opening) opening.group.push(token)
      continue
    }
    if (token.keyword === PascalKeyword.Until) {
      const index = blockStack.findLastIndex(
        (item: { kind: string }) => item.kind === PascalKeyword.Repeat,
      )
      if (index >= 0) {
        const opening = blockStack[index]
        opening.group.push(token)
        addGroup(opening.group)
        blockStack.splice(index, 1)
      }
      continue
    }
    if (token.keyword !== PascalKeyword.End) continue

    const opening = blockStack.pop()
    if (!opening) continue
    opening.group.push(token)
    addGroup(opening.group)

    // A variant-record case shares the record's terminating `end` rather than
    // owning a second one. Associate that boundary with both constructs.
    const containingType = blockStack.at(-1)
    if (
      opening.kind === PascalKeyword.Case &&
      containingType &&
      typeKinds.has(containingType.kind) &&
      token.indent <= containingType.token.indent
    ) {
      blockStack.pop()
      containingType.group.push(token)
      addGroup(containingType.group)
    }
  }

  const findHeaderTerminator = (
    index: number,
    terminator: string,
    intermediate: readonly string[] = [],
  ) => {
    const group = [tokens[index]]
    for (
      let cursor = index + 1;
      cursor < tokens.length && cursor <= index + 80;
      cursor += 1
    ) {
      const candidate = tokens[cursor]
      if (candidate.keyword === terminator) {
        group.push(candidate)
        return group
      }
      if (
        intermediate.includes(candidate.keyword) &&
        !group.some((member) => member.keyword === candidate.keyword)
      ) {
        group.push(candidate)
      }
      if (
        inList(candidate.keyword, [
          PascalKeyword.Begin,
          PascalKeyword.End,
          PascalKeyword.Repeat,
          PascalKeyword.Until,
        ])
      )
        break
      if (candidate.keyword === tokens[index].keyword) break
    }
    return undefined
  }

  const ifGroups = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token.keyword === PascalKeyword.For) {
      const group = findHeaderTerminator(index, PascalKeyword.Do, [
        PascalKeyword.To,
        PascalKeyword.Downto,
        PascalKeyword.In,
      ])
      if (group) addGroup(group)
    } else if (
      token.keyword === PascalKeyword.While ||
      token.keyword === PascalKeyword.With
    ) {
      const group = findHeaderTerminator(index, PascalKeyword.Do)
      if (group) addGroup(group)
    } else if (token.keyword === PascalKeyword.If) {
      const group = findHeaderTerminator(index, PascalKeyword.Then)
      if (group) ifGroups.push({ token, group })
    }
  }

  for (const token of tokens.filter((item) => item.keyword === PascalKeyword.Else)) {
    const owner = [...ifGroups]
      .reverse()
      .find(
        (item) =>
          item.token.line <= token.line &&
          item.token.indent === token.indent &&
          !item.group.some((member) => member.keyword === PascalKeyword.Else),
      )
    if (owner) owner.group.push(token)
  }
  ifGroups.forEach((item) => addGroup(item.group))

  return [...(matchesByToken.get(keywordTokenKey(current))?.values() || [current])]
}

function findDelphiModuleKeywordHighlights(text: string) {
  const lines = text.split(/\r\n|\n|\r/)
  const codeLines = maskPascalLines(lines)
  const ranges = []
  const moduleKeyword = new RegExp(
    String.raw`^\s*(${PascalKeyword.Unit}|${PascalKeyword.Program}|${PascalKeyword.Library}|${PascalKeyword.Package}|${PascalKeyword.Interface}|${PascalKeyword.Implementation}|${PascalKeyword.Uses}|${PascalKeyword.Initialization}|${PascalKeyword.Finalization}|requires|${PascalKeyword.Contains}|${PascalKeyword.Exports})\b`,
    "i",
  )
  const moduleEnd = new RegExp(String.raw`^\s*(${PascalKeyword.End})\s*\.`, "i")

  for (let line = 0; line < codeLines.length; line += 1) {
    const codeLine = codeLines[line]
    const match = moduleKeyword.exec(codeLine) || moduleEnd.exec(codeLine)
    if (!match) continue
    const start = match.index + match[0].toLowerCase().indexOf(match[1].toLowerCase())
    ranges.push({ line, start, end: start + match[1].length })
  }
  return ranges
}

function findDelphiSelfKeywordHighlights(text: string) {
  const lines = text.split(/\r\n|\n|\r/)
  const codeLines = maskPascalLines(lines)
  const ranges = []
  const selfKeyword = new RegExp(String.raw`\b${PascalKeyword.Self}\b`, "gi")

  for (let line = 0; line < codeLines.length; line += 1) {
    const codeLine = codeLines[line]
    selfKeyword.lastIndex = 0
    let match
    while ((match = selfKeyword.exec(codeLine)) !== null) {
      // Delphi's escaped identifiers and members named `Self` are symbols.
      // Only the standalone language keyword receives the keyword style.
      if (/[.&]\s*$/.test(codeLine.slice(0, match.index))) continue
      ranges.push({ line, start: match.index, end: match.index + match[0].length })
    }
  }
  return ranges
}

const STRUCTURAL_KEYWORDS = new RegExp(
  String.raw`\b(${PascalKeyword.Begin}|${PascalKeyword.End}|${PascalKeyword.Case}|${PascalKeyword.Try}|${PascalKeyword.Asm}|${PascalKeyword.Class}|${PascalKeyword.Record}|${PascalKeyword.Object}|${PascalKeyword.Interface}|${PascalKeyword.Repeat}|${PascalKeyword.Until})\b`,
  "gi",
)
const LEVEL_KEYWORDS = new RegExp(
  String.raw`\b(${PascalKeyword.Begin}|${PascalKeyword.End}|${PascalKeyword.If}|${PascalKeyword.Then}|${PascalKeyword.Else}|${PascalKeyword.Case}|${PascalKeyword.Of}|${PascalKeyword.For}|${PascalKeyword.In}|${PascalKeyword.To}|${PascalKeyword.Downto}|${PascalKeyword.Do}|${PascalKeyword.While}|${PascalKeyword.Repeat}|${PascalKeyword.Until}|${PascalKeyword.Break}|${PascalKeyword.Continue}|${PascalKeyword.Exit}|${PascalKeyword.Halt}|abort|${PascalKeyword.Try}|${PascalKeyword.Except}|${PascalKeyword.Finally}|on|${PascalKeyword.Raise}|${PascalKeyword.With}|${PascalKeyword.Goto}|${PascalKeyword.Label}|${PascalKeyword.Asm})\b`,
  "gi",
)
const TYPE_LIKE_IDENTIFIER = /\bT[A-Z]\w*\b/g
const CALLABLE_IDENTIFIER = /\b([A-Za-z_]\w*)\s*(?=\()/g
const FIELD_DECLARATION = /^\s*((?:F[A-Z]\w*\s*,\s*)*F[A-Z]\w*)\s*:/
const IDENTIFIER = /\b[A-Za-z_]\w*\b/g
const NON_CALLABLE_KEYWORDS = new Set<string>([
  PascalKeyword.And,
  PascalKeyword.Array,
  PascalKeyword.As,
  PascalKeyword.Asm,
  PascalKeyword.Begin,
  PascalKeyword.Case,
  PascalKeyword.Class,
  PascalKeyword.Const,
  PascalKeyword.Constructor,
  PascalKeyword.Destructor,
  PascalKeyword.Dispinterface,
  PascalKeyword.Div,
  PascalKeyword.Do,
  PascalKeyword.Downto,
  PascalKeyword.Else,
  PascalKeyword.End,
  PascalKeyword.Except,
  PascalKeyword.Exports,
  PascalKeyword.File,
  PascalKeyword.Finalization,
  PascalKeyword.Finally,
  PascalKeyword.For,
  PascalKeyword.Function,
  PascalKeyword.Goto,
  PascalKeyword.If,
  PascalKeyword.Implementation,
  PascalKeyword.In,
  PascalKeyword.Inherited,
  PascalKeyword.Initialization,
  PascalKeyword.Inline,
  PascalKeyword.Interface,
  PascalKeyword.Is,
  PascalKeyword.Label,
  PascalKeyword.Library,
  PascalKeyword.Mod,
  PascalKeyword.Nil,
  PascalKeyword.Not,
  PascalKeyword.Object,
  PascalKeyword.Of,
  PascalKeyword.Or,
  PascalKeyword.Out,
  PascalKeyword.Packed,
  PascalKeyword.Procedure,
  PascalKeyword.Program,
  PascalKeyword.Property,
  PascalKeyword.Raise,
  PascalKeyword.Record,
  PascalKeyword.Repeat,
  PascalKeyword.Resourcestring,
  PascalKeyword.Set,
  PascalKeyword.Shl,
  PascalKeyword.Shr,
  PascalKeyword.Then,
  PascalKeyword.Threadvar,
  PascalKeyword.To,
  PascalKeyword.Try,
  PascalKeyword.Type,
  PascalKeyword.Unit,
  PascalKeyword.Until,
  PascalKeyword.Uses,
  PascalKeyword.Var,
  PascalKeyword.While,
  PascalKeyword.With,
  PascalKeyword.Xor,
])

function isTypeBlockKeyword(codeLine: string, keywordStart: number) {
  return new RegExp(String.raw`=\s*(?:${PascalKeyword.Packed}\s+)?$`, "i").test(
    codeLine.slice(0, keywordStart),
  )
}

function typeDeclarationHasBody(codeLine: string, keywordEnd: number) {
  const suffix = codeLine.slice(keywordEnd)
  if (new RegExp(String.raw`^\s+${PascalKeyword.Of}\b`, "i").test(suffix)) return false
  return !/^\s*(?:\([^)]*\)\s*)?;/.test(suffix)
}

function isTypeOfKeyword(codeLine: string, keywordStart: number) {
  const prefix = codeLine.slice(0, keywordStart)
  return (
    new RegExp(
      String.raw`\b(?:${PascalKeyword.Class}|${PascalKeyword.Set}|${PascalKeyword.File})\s*$`,
      "i",
    ).test(prefix) ||
    new RegExp(String.raw`\b${PascalKeyword.Array}\s*(?:\[[^\]]*\])?\s*$`, "i").test(
      prefix,
    )
  )
}

function leadingIndentColumns(line: string, tabSize = 2) {
  let columns = 0
  for (const character of line) {
    if (character === " ") {
      columns += 1
    } else if (character === "\t") {
      columns += tabSize - (columns % tabSize)
    } else {
      break
    }
  }
  return columns
}

function findPascalCommentHighlights(text: string) {
  const lines = text.split(/\r\n|\n|\r/)
  const ranges: HighlightRange[] = []
  let state = "code"

  const add = (line: number, start: number, end: number) => {
    if (end > start) ranges.push({ line, start, end })
  }

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber]
    let index = 0
    while (index < line.length) {
      if (state === "braceComment" || state === "braceDirective") {
        const end = line.indexOf("}", index)
        if (state === "braceComment")
          add(lineNumber, index, end < 0 ? line.length : end + 1)
        if (end < 0) break
        index = end + 1
        state = "code"
        continue
      }
      if (state === "parenComment" || state === "parenDirective") {
        const end = line.indexOf("*)", index)
        if (state === "parenComment")
          add(lineNumber, index, end < 0 ? line.length : end + 2)
        if (end < 0) break
        index = end + 2
        state = "code"
        continue
      }
      if (line.startsWith("//", index)) {
        add(lineNumber, index, line.length)
        break
      }
      if (line[index] === "{") {
        const directive = line[index + 1] === "$"
        const end = line.indexOf("}", index + 1)
        if (!directive) add(lineNumber, index, end < 0 ? line.length : end + 1)
        if (end < 0) {
          state = directive ? "braceDirective" : "braceComment"
          break
        }
        index = end + 1
        continue
      }
      if (line.startsWith("(*", index)) {
        const directive = line[index + 2] === "$"
        const end = line.indexOf("*)", index + 2)
        if (!directive) add(lineNumber, index, end < 0 ? line.length : end + 2)
        if (end < 0) {
          state = directive ? "parenDirective" : "parenComment"
          break
        }
        index = end + 2
        continue
      }
      if (line[index] === "'") {
        index += 1
        while (index < line.length) {
          if (line[index] !== "'") {
            index += 1
          } else if (line[index + 1] === "'") {
            index += 2
          } else {
            index += 1
            break
          }
        }
        continue
      }
      index += 1
    }
  }
  return ranges
}

function findDelphiKeywordHighlights(
  text: string,
  options: {
    tabSize?: number | string
    indentSize?: number | string
    blockLevelCount?: number
  } = {},
) {
  const lines = text.split(/\r\n|\n|\r/)
  const codeLines = maskPascalLines(lines)
  const tabSize = Math.max(1, Number(options.tabSize) || 2)
  const indentSize = Math.max(1, Number(options.indentSize) || 2)
  const blockLevelCount = Math.max(1, Number(options.blockLevelCount) || 3)
  const typeStack = []
  const classKeywords = []
  const classEndKeywords = []
  const typeDeclarationKeywords = []
  const typeDeclarationEndKeywords = []
  const blockLevelKeywords = Array.from(
    { length: blockLevelCount },
    (): HighlightRange[] => [],
  )
  const typeLikeIdentifiers = []
  const callableIdentifiers = []
  const fieldIdentifiers = []
  const callableRanges = new Set<string>()
  const declaredFields = new Set<string>()

  for (const codeLine of codeLines) {
    const declarationMatch = FIELD_DECLARATION.exec(codeLine)
    if (!declarationMatch) {
      continue
    }
    for (const name of declarationMatch[1].split(",")) {
      declaredFields.add(name.trim().toLowerCase())
    }
  }

  for (let line = 0; line < codeLines.length; line += 1) {
    const codeLine = codeLines[line]
    if (
      new RegExp(
        String.raw`^\s*(?:${PascalKeyword.Implementation}|${PascalKeyword.Initialization}|${PascalKeyword.Finalization})\b`,
        "i",
      ).test(codeLine)
    ) {
      typeStack.length = 0
    }
    IDENTIFIER.lastIndex = 0
    let identifierMatch
    while ((identifierMatch = IDENTIFIER.exec(codeLine)) !== null) {
      if (declaredFields.has(identifierMatch[0].toLowerCase())) {
        fieldIdentifiers.push({
          line,
          start: identifierMatch.index,
          end: identifierMatch.index + identifierMatch[0].length,
        })
      }
    }

    TYPE_LIKE_IDENTIFIER.lastIndex = 0
    let typeMatch
    while ((typeMatch = TYPE_LIKE_IDENTIFIER.exec(codeLine)) !== null) {
      typeLikeIdentifiers.push({
        line,
        start: typeMatch.index,
        end: typeMatch.index + typeMatch[0].length,
      })
    }

    CALLABLE_IDENTIFIER.lastIndex = 0
    let callableMatch
    while ((callableMatch = CALLABLE_IDENTIFIER.exec(codeLine)) !== null) {
      const identifier = callableMatch[1]
      if (
        NON_CALLABLE_KEYWORDS.has(identifier.toLowerCase()) ||
        /^T[A-Z]/.test(identifier)
      ) {
        continue
      }
      const range = {
        line,
        start: callableMatch.index,
        end: callableMatch.index + identifier.length,
      }
      const key = `${range.line}:${range.start}:${range.end}`
      if (!callableRanges.has(key)) {
        callableRanges.add(key)
        callableIdentifiers.push(range)
      }
    }

    const indentationLevel =
      Math.floor(leadingIndentColumns(codeLine, tabSize) / indentSize) %
      blockLevelKeywords.length
    LEVEL_KEYWORDS.lastIndex = 0
    let levelMatch
    while ((levelMatch = LEVEL_KEYWORDS.exec(codeLine)) !== null) {
      if (
        levelMatch[0].toLowerCase() === PascalKeyword.Of &&
        isTypeOfKeyword(codeLine, levelMatch.index)
      ) {
        typeDeclarationKeywords.push({
          line,
          start: levelMatch.index,
          end: levelMatch.index + levelMatch[0].length,
        })
        continue
      }
      // The final `end.` closes the Pascal module, not an indentation-level
      // executable block. Leave it to the active theme's normal keyword color.
      if (
        levelMatch[0].toLowerCase() === PascalKeyword.End &&
        /^\s*\./.test(codeLine.slice(levelMatch.index + levelMatch[0].length))
      ) {
        continue
      }
      blockLevelKeywords[indentationLevel].push({
        line,
        start: levelMatch.index,
        end: levelMatch.index + levelMatch[0].length,
      })
    }

    STRUCTURAL_KEYWORDS.lastIndex = 0
    let match

    while ((match = STRUCTURAL_KEYWORDS.exec(codeLine)) !== null) {
      const keyword = match[1].toLowerCase()
      const range = { line, start: match.index, end: match.index + match[0].length }

      if (keyword === PascalKeyword.Class) {
        classKeywords.push(range)
        if (isTypeBlockKeyword(codeLine, match.index)) {
          typeDeclarationKeywords.push(range)
          if (typeDeclarationHasBody(codeLine, match.index + match[0].length)) {
            typeStack.push({
              kind: PascalKeyword.Class,
              indent: leadingIndentColumns(codeLine, tabSize),
            })
          }
        }
        continue
      }

      if (
        keyword === PascalKeyword.Record ||
        keyword === PascalKeyword.Object ||
        keyword === PascalKeyword.Interface
      ) {
        if (isTypeBlockKeyword(codeLine, match.index)) {
          typeDeclarationKeywords.push(range)
          if (typeDeclarationHasBody(codeLine, match.index + match[0].length)) {
            typeStack.push({
              kind: keyword,
              indent: leadingIndentColumns(codeLine, tabSize),
            })
          }
        }
        continue
      }

      if (keyword === PascalKeyword.Begin) {
        continue
      }

      if (keyword === PascalKeyword.End) {
        const indentColumns = leadingIndentColumns(codeLine, tabSize)
        const openingType = typeStack.at(-1)
        // Type bodies contain declarations rather than executable begin/end
        // blocks. Matching their boundary by indentation avoids having a
        // variant-record `case` steal the record's final `end`.
        if (openingType && indentColumns <= openingType.indent) {
          typeStack.pop()
          if (openingType.kind === PascalKeyword.Class) {
            classEndKeywords.push(range)
            typeDeclarationEndKeywords.push(range)
          } else {
            typeDeclarationEndKeywords.push(range)
          }
        }
      }
    }
  }

  const typeBoundaryKeys = new Set(
    [...typeDeclarationKeywords, ...typeDeclarationEndKeywords].map(
      (range) => `${range.line}:${range.start}:${range.end}`,
    ),
  )
  const visibleLevelKeywords = blockLevelKeywords.map((ranges) =>
    ranges.filter(
      (range) => !typeBoundaryKeys.has(`${range.line}:${range.start}:${range.end}`),
    ),
  )

  return {
    classKeywords,
    classEndKeywords,
    typeDeclarationKeywords,
    typeDeclarationEndKeywords,
    blockLevelKeywords: visibleLevelKeywords,
    typeLikeIdentifiers,
    callableIdentifiers,
    fieldIdentifiers,
  }
}

export {
  DEFAULT_BLOCK_LEVEL_COLORS,
  normalizeBlockLevelColors,
  findDelphiKeywordMatchGroup,
  findDelphiModuleKeywordHighlights,
  findDelphiSelfKeywordHighlights,
  findDelphiKeywordHighlights,
  findPascalCommentHighlights,
}
