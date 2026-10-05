import { PascalKeyword } from "../shared/pascal"
const GENERIC_TYPE = /\b[TIEP][A-Za-z_]\w*\s*</gi

/**
 * Collect complete conventional Delphi generic-type spans, requiring type-like
 * arguments and a plausible suffix to avoid ordinary comparison expressions.
 */
function findGenericTypeSpans(code: string) {
  const spans = []
  let match

  while ((match = GENERIC_TYPE.exec(code)) !== null) {
    const open = code.lastIndexOf("<", GENERIC_TYPE.lastIndex - 1)
    let depth = 0
    let close = -1

    for (let index = open; index < code.length; index += 1) {
      if (code[index] === "<") {
        depth += 1
      } else if (code[index] === ">") {
        depth -= 1
        if (depth === 0) {
          close = index
          break
        }
      }
    }

    if (close < 0) {
      continue
    }

    const body = code.slice(open + 1, close)
    const suffix = code.slice(close + 1)
    // Matching angle brackets alone is insufficient: comparisons can also balance, so validate both argument syntax and the following token.
    const hasTypeOnlyBody = /^[\sA-Za-z0-9_.,<>^]+$/.test(body)
    const hasGenericSuffix = new RegExp(
      String.raw`^\s*(?:$|[.()[\],;]|:=|=|\b(?:${PascalKeyword.And}|${PascalKeyword.Do}|${PascalKeyword.Or}|${PascalKeyword.Then})\b)`,
      "i",
    ).test(suffix)
    if (!hasTypeOnlyBody || !hasGenericSuffix) {
      continue
    }

    spans.push({ start: match.index, end: close + 1 })
    GENERIC_TYPE.lastIndex = close + 1
  }

  return spans
}

/**
 * Identify removable spaces around confirmed generic brackets and their following
 * punctuation using offsets in the supplied code.
 */
function genericWhitespaceRanges(code: string) {
  const ranges = []

  for (const span of findGenericTypeSpans(code)) {
    const text = code.slice(span.start, span.end)
    const whitespace = /(?<=[A-Za-z0-9_])([ \t]+)(?=<)|(?<=<)([ \t]+)|([ \t]+)(?=>)/g
    let match

    while ((match = whitespace.exec(text)) !== null) {
      ranges.push({
        start: span.start + match.index,
        end: span.start + match.index + match[0].length,
      })
    }

    const suffixWhitespace = code.slice(span.end).match(/^[ \t]+(?=[().,;\]])/)
    if (suffixWhitespace) {
      ranges.push({
        start: span.end,
        end: span.end + suffixWhitespace[0].length,
      })
    }
  }

  return ranges
}

/**
 * Delete formatting ranges from right to left so earlier source offsets stay valid
 * after each replacement.
 */
function removeRanges(text: string, ranges: readonly { start: number; end: number }[]) {
  let result = text
  // Right-to-left edits avoid rebasing ranges after shortening the line.
  for (const range of [...ranges].sort(
    /** Apply replacement ranges from right to left so earlier offsets stay valid. */ (
      left,
      right,
    ) => right.start - left.start,
  )) {
    result = `${result.slice(0, range.start)}${result.slice(range.end)}`
  }
  return result
}

/**
 * Remove redundant generic-bracket whitespace from code whose comments and strings
 * have already been excluded.
 */
function normalizeGenericTypeSpacing(code: string) {
  return removeRanges(code, genericWhitespaceRanges(code))
}

/**
 * Apply whitespace ranges discovered in aligned masked code to the original line,
 * preserving comment and string contents.
 */
function normalizeGenericTypeSpacingOnMaskedLine(line: string, maskedCodeLine: string) {
  return removeRanges(line, genericWhitespaceRanges(maskedCodeLine))
}

export {
  findGenericTypeSpans,
  normalizeGenericTypeSpacing,
  normalizeGenericTypeSpacingOnMaskedLine,
}
