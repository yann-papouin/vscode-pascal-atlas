import { PascalKeyword } from "../shared/pascal"
const GENERIC_TYPE = /\b[TIEP][A-Za-z_]\w*\s*</gi

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

function removeRanges(text: string, ranges: readonly { start: number; end: number }[]) {
  let result = text
  for (const range of [...ranges].sort((left, right) => right.start - left.start)) {
    result = `${result.slice(0, range.start)}${result.slice(range.end)}`
  }
  return result
}

function normalizeGenericTypeSpacing(code: string) {
  return removeRanges(code, genericWhitespaceRanges(code))
}

function normalizeGenericTypeSpacingOnMaskedLine(line: string, maskedCodeLine: string) {
  return removeRanges(line, genericWhitespaceRanges(maskedCodeLine))
}

export {
  findGenericTypeSpans,
  normalizeGenericTypeSpacing,
  normalizeGenericTypeSpacingOnMaskedLine,
}
