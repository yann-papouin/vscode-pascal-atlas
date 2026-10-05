import { LexerState } from "../shared/identifiers"
type PascalLexerState = (typeof LexerState)[keyof typeof LexerState]
import { PascalKeyword } from "../shared/pascal"
const CONTROL_WORDS = new Set<string>([
  PascalKeyword.Case,
  PascalKeyword.For,
  PascalKeyword.If,
  PascalKeyword.Repeat,
  PascalKeyword.While,
  PascalKeyword.With,
])
import { normalizeGenericTypeSpacing } from "./generics"

/**
 * Normalize Pascal code spacing outside comments and strings, optionally tightening
 * confirmed generic brackets.
 */
function formatCodeSegment(
  code: string,
  options: Partial<{ normalizeGenericTypeSpacing: boolean }> = {},
) {
  const formatted = code
    .replace(
      /\b([A-Za-z_]\w*)[ \t]+\(/g,
      /**
       * Remove call-name spacing only for ordinary identifiers, retaining spacing
       * required by control keywords.
       */ (match, word) => (CONTROL_WORDS.has(word.toLowerCase()) ? match : `${word}(`),
    )
    .replace(/\([ \t]+/g, "(")
    .replace(/[ \t]+\)/g, ")")
    .replace(/[ \t]*,[ \t]*/g, ", ")
    .replace(
      /[ \t]*(?::=|<=|>=|<>|=)[ \t]*/g,
      /** Normalize matched operator spacing while retaining the operator itself. */ (
        operator,
      ) => ` ${operator.trim()} `,
    )
    .replace(/[ \t]*:(?!=)[ \t]*/g, ": ")
    .replace(/[ \t]*;[ \t]*/g, "; ")
  return options.normalizeGenericTypeSpacing === false
    ? formatted
    : normalizeGenericTypeSpacing(formatted)
}

/**
 * Scan a line while carrying block-comment state across lines; optionally format only
 * code segments and retain literal/comment text verbatim.
 */
function scanPascalLine(
  line: string,
  initialState: PascalLexerState = LexerState.Code,
  shouldFormat = false,
  options: { normalizeGenericTypeSpacing?: boolean } = {},
) {
  let state = initialState
  let result = ""
  let code = ""
  let index = 0

  // Flush only code accumulated outside comments and strings; formatting a whole line would change literal contents.
  /**
   * Append the accumulated code segment through the optional spacing formatter before
   * switching to a literal or comment span.
   */
  const flushCode = () => {
    result += shouldFormat ? formatCodeSegment(code, options) : code
    code = ""
  }

  while (index < line.length) {
    if (state === LexerState.BraceComment) {
      const end = line.indexOf("}", index)
      if (end === -1) {
        result += line.slice(index)
        index = line.length
      } else {
        result += line.slice(index, end + 1)
        index = end + 1
        state = LexerState.Code
      }
      continue
    }

    if (state === LexerState.ParenComment) {
      const end = line.indexOf("*)", index)
      if (end === -1) {
        result += line.slice(index)
        index = line.length
      } else {
        result += line.slice(index, end + 2)
        index = end + 2
        state = LexerState.Code
      }
      continue
    }

    if (line.startsWith("//", index)) {
      flushCode()
      result += line.slice(index)
      index = line.length
      continue
    }

    if (line[index] === "{") {
      flushCode()
      result += "{"
      index += 1
      state = LexerState.BraceComment
      continue
    }

    if (line.startsWith("(*", index)) {
      flushCode()
      result += "(*"
      index += 2
      state = LexerState.ParenComment
      continue
    }

    // String contents bypass spacing rules, including escaped quotes that would otherwise resemble a closing delimiter.
    if (line[index] === "'") {
      flushCode()
      const start = index
      index += 1
      while (index < line.length) {
        if (line[index] !== "'") {
          index += 1
          continue
        }
        if (line[index + 1] === "'") {
          index += 2
          continue
        }
        index += 1
        break
      }
      result += line.slice(start, index)
      continue
    }

    code += line[index]
    index += 1
  }

  if (state === LexerState.Code) {
    flushCode()
  }

  return {
    text: shouldFormat ? result.trimEnd() : result,
    state,
  }
}

/**
 * Recover the block-comment state entering a line by scanning preceding lines without
 * modifying their contents.
 */
function commentStateBeforeLine(lines: string[], lineNumber: number) {
  let state: PascalLexerState = LexerState.Code
  for (let line = 0; line < lineNumber; line += 1) {
    state = scanPascalLine(lines[line], state).state
  }
  return state
}

/**
 * Format one line with its incoming lexical state and configured generic-spacing
 * behavior.
 */
function formatPascalLine(
  line: string,
  initialState: PascalLexerState = LexerState.Code,
  options: Partial<{ normalizeGenericTypeSpacing: boolean }> = {},
) {
  return scanPascalLine(line, initialState, true, options).text
}

/**
 * Translate an on-type formatting scope into current/previous-line work requests,
 * marking newline continuations for blank-line alignment.
 */
function onTypeLineRequests(lineNumber: number, character: string, scope: string) {
  if (scope === "disabled") return []
  const requests = []
  if (scope === "previousLine" || scope === "currentAndPrevious") {
    requests.push({ lineNumber: lineNumber - 1, alignBlankContinuationLine: false })
  }
  if (scope === "currentLine" || scope === "currentAndPrevious") {
    requests.push({
      lineNumber,
      alignBlankContinuationLine: character === "\n",
    })
  }
  return requests
}

export {
  commentStateBeforeLine,
  formatCodeSegment,
  formatPascalLine,
  onTypeLineRequests,
  scanPascalLine,
}
