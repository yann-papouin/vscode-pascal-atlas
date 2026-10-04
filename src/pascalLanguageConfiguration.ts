import type { Disposable, LanguageConfiguration, TextEditor, Range } from "vscode"
import { PascalKeyword } from "./shared/pascal"
import { ConfigurationSection, LanguageId, SettingKey } from "./shared/identifiers"
import { maskPascalNonCode } from "./binarySymbols"

const PASCAL_LANGUAGE_IDS = new Set<string>([
  LanguageId.Pascal,
  LanguageId.ObjectPascal,
  LanguageId.Platform,
])
const BRACKET_COLOR_COUNT = 6

const PASCAL_INDENTATION_RULES = Object.freeze({
  increaseIndentPattern: new RegExp(
    String.raw`(?:\b${PascalKeyword.Begin}\b|\b${PascalKeyword.Try}\b|\b${PascalKeyword.Repeat}\b)\s*(?:;?\s*(?:\/\/.*)?)$|^\s*${PascalKeyword.Case}\b.*\b${PascalKeyword.Of}\b\s*(?:\/\/.*)?$|^\s*(?:[\w.<>]+\s*=\s*)?(?:${PascalKeyword.Class}|${PascalKeyword.Record}|${PascalKeyword.Object}|${PascalKeyword.Interface}|${PascalKeyword.Dispinterface})\b.*$|^\s*(?:${PascalKeyword.Strict}\s+)?(?:${PascalKeyword.Private}|${PascalKeyword.Protected}|${PascalKeyword.Public}|${PascalKeyword.Published})\s*$`,
    "i",
  ),
  decreaseIndentPattern: new RegExp(
    String.raw`^\s*(?:${PascalKeyword.End}\b|${PascalKeyword.Until}\b|${PascalKeyword.Except}\b|${PascalKeyword.Finally}\b|${PascalKeyword.Else}\b|(?:${PascalKeyword.Strict}\s+)?(?:${PascalKeyword.Private}|${PascalKeyword.Protected}|${PascalKeyword.Public}|${PascalKeyword.Published})\b)`,
    "i",
  ),
  indentNextLinePattern: new RegExp(
    String.raw`^\s*(?:(?:${PascalKeyword.If}|${PascalKeyword.For}|${PascalKeyword.While}|${PascalKeyword.With})\b.*\b(?:${PascalKeyword.Then}|${PascalKeyword.Do})\b|${PascalKeyword.Else}\b|${PascalKeyword.Except}\b|${PascalKeyword.Finally}\b)\s*(?:\/\/.*)?$`,
    "i",
  ),
  unIndentedLinePattern: new RegExp(
    String.raw`^\s*(?:${PascalKeyword.Program}|${PascalKeyword.Unit}|${PascalKeyword.Library}|${PascalKeyword.Package})\b`,
    "i",
  ),
})

const BLOCK_START_PATTERN = new RegExp(
  String.raw`(?:\b${PascalKeyword.Begin}\b|\b${PascalKeyword.Try}\b|\b${PascalKeyword.Repeat}\b)\s*(?:;?\s*(?:\/\/.*)?)$|^\s*${PascalKeyword.Case}\b.*\b${PascalKeyword.Of}\b\s*(?:\/\/.*)?$|^\s*(?:[\w.<>]+\s*=\s*)?(?:${PascalKeyword.Class}|${PascalKeyword.Record}|${PascalKeyword.Object}|${PascalKeyword.Interface}|${PascalKeyword.Dispinterface})\b.*$`,
  "i",
)
const SINGLE_STATEMENT_PATTERN = new RegExp(
  String.raw`^\s*(?:(?:${PascalKeyword.If}|${PascalKeyword.For}|${PascalKeyword.While}|${PascalKeyword.With})\b.*\b(?:${PascalKeyword.Then}|${PascalKeyword.Do})\b|${PascalKeyword.Else}\b|${PascalKeyword.Except}\b|${PascalKeyword.Finally}\b|(?:${PascalKeyword.Strict}\s+)?(?:${PascalKeyword.Private}|${PascalKeyword.Protected}|${PascalKeyword.Public}|${PascalKeyword.Published})\b)\s*(?:\/\/.*)?$`,
  "i",
)

function languageConfiguration(vscode: {
  IndentAction: Pick<typeof import("vscode").IndentAction, "Indent" | "IndentOutdent">
  SyntaxTokenType?: typeof import("vscode").SyntaxTokenType
}): LanguageConfiguration & {
  colorizedBracketPairs: Array<[string, string]>
  surroundingPairs: Array<[string, string]>
} {
  const tokenTypes = vscode.SyntaxTokenType || { Other: 0, Comment: 1, String: 2 }
  return {
    comments: {
      lineComment: "//",
      blockComment: ["{", "}"],
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    // Angle brackets are deliberately handled by the Pascal-aware collector
    // below. Registering them here would make VS Code pair comparison operators
    // such as `A < B` because the base Pascal grammar gives both forms the same
    // operator scope.
    colorizedBracketPairs: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "'", close: "'", notIn: [tokenTypes.String, tokenTypes.Comment] },
    ],
    surroundingPairs: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["'", "'"],
    ],
    indentationRules: PASCAL_INDENTATION_RULES,
    onEnterRules: [
      {
        beforeText: new RegExp(String.raw`\b${PascalKeyword.Begin}\s*$`, "i"),
        afterText: new RegExp(String.raw`^\s*${PascalKeyword.End}\b`, "i"),
        action: { indentAction: vscode.IndentAction.IndentOutdent },
      },
      {
        beforeText: BLOCK_START_PATTERN,
        action: { indentAction: vscode.IndentAction.Indent },
      },
      {
        beforeText: SINGLE_STATEMENT_PATTERN,
        action: { indentAction: vscode.IndentAction.Indent },
      },
    ],
  }
}

function previousIdentifier(code: string, offset: number) {
  let cursor = offset - 1
  if (cursor < 0 || !/[A-Za-z0-9_]/.test(code[cursor])) return undefined
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_]/.test(code[cursor])) cursor -= 1
  return { name: code.slice(cursor + 1, end), start: cursor + 1 }
}

function nextNonWhitespace(code: string, offset: number) {
  let cursor = offset
  while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1
  return cursor
}

function genericCloseOffset(code: string, openOffset: number) {
  let depth = 0
  for (let cursor = openOffset; cursor < code.length; cursor += 1) {
    const character = code[cursor]
    if (character === "<") depth += 1
    else if (character === ">") {
      depth -= 1
      if (depth === 0) return cursor
    } else if (depth === 1 && character === ";") {
      // Never let an unmatched comparison consume following statements.
      return -1
    }
  }
  return -1
}

function looksLikePascalGeneric(
  code: string,
  openOffset: number,
  closeOffset: number,
  prefix: { name: string; start: number },
) {
  const body = code.slice(openOffset + 1, closeOffset)
  if (!/[A-Za-z_]/.test(body)) return false
  if (!/^[A-Za-z0-9_.,:\s<>^[\]&]+$/.test(body)) return false
  if (
    new RegExp(
      String.raw`\b(?:${PascalKeyword.And}|${PascalKeyword.Or}|${PascalKeyword.Xor}|${PascalKeyword.Then}|${PascalKeyword.Do}|${PascalKeyword.Begin}|${PascalKeyword.End})\b`,
      "i",
    ).test(body)
  )
    return false

  const after = nextNonWhitespace(code, closeOffset + 1)
  const afterCharacter = code[after] || ""
  // `>=` is a relational operator, not the end of generic arguments. A generic
  // declaration uses whitespace before its following equals sign.
  if (after === closeOffset + 1 && afterCharacter === "=") return false

  let before = prefix.start - 1
  while (before >= 0 && /\s/.test(code[before])) before -= 1
  const typeContext = before < 0 || /[:=(,[>]/.test(code[before])
  const conventionalTypeName = /^[TIP][A-Za-z0-9_]+$/.test(prefix.name)
  const genericCall = afterCharacter === "("
  if (!typeContext && !conventionalTypeName && !genericCall) return false

  return after >= code.length || /[.[(,;):=^>]/.test(afterCharacter)
}

/**
 * Returns both characters of every confirmed Delphi generic angle pair. The
 * depth is relative only to other angle pairs so it behaves like VS Code's
 * independent color pool and cannot be shifted by surrounding calls/indexers.
 */
function collectPascalGenericAngleBrackets(text: string, preparedCode?: string) {
  const code = preparedCode || maskPascalNonCode(text)
  const result: Array<{ offset: number; depth: number }> = []
  for (let openOffset = 0; openOffset < code.length; openOffset += 1) {
    if (code[openOffset] !== "<") continue
    const prefix = previousIdentifier(code, openOffset)
    if (!prefix) continue
    const closeOffset = genericCloseOffset(code, openOffset)
    if (
      closeOffset < 0 ||
      !looksLikePascalGeneric(code, openOffset, closeOffset, prefix)
    )
      continue

    const stack: Array<{ offset: number; depth: number }> = []
    for (let cursor = openOffset; cursor <= closeOffset; cursor += 1) {
      if (code[cursor] === "<") {
        stack.push({ offset: cursor, depth: stack.length })
      } else if (code[cursor] === ">" && stack.length > 0) {
        const opening = stack.pop()
        if (!opening) continue
        result.push(opening, { offset: cursor, depth: opening.depth })
      }
    }
    openOffset = closeOffset
  }
  return result.sort((left, right) => left.offset - right.offset)
}

function registerPascalGenericBracketColoring(
  context: { subscriptions: Disposable[] },
  vscode: typeof import("vscode"),
) {
  const decorations = Array.from({ length: BRACKET_COLOR_COUNT }, (_, index) =>
    vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor(`editorBracketHighlight.foreground${index + 1}`),
    }),
  )
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const clear = (editor: TextEditor) =>
    decorations.forEach((decoration) => editor.setDecorations(decoration, []))
  const refresh = (editor: TextEditor | undefined) => {
    if (!editor || !PASCAL_LANGUAGE_IDS.has(editor.document.languageId)) return
    const bracketColoringEnabled = vscode.workspace
      .getConfiguration("editor", editor.document.uri)
      .get("bracketPairColorization.enabled", true)
    const paEnabled = vscode.workspace
      .getConfiguration(ConfigurationSection, editor.document.uri)
      .get(SettingKey.Enabled, true)
    if (!bracketColoringEnabled || !paEnabled) {
      clear(editor)
      return
    }
    const buckets = Array.from({ length: BRACKET_COLOR_COUNT }, (): Range[] => [])
    for (const bracket of collectPascalGenericAngleBrackets(
      editor.document.getText(),
    )) {
      const start = editor.document.positionAt(bracket.offset)
      buckets[bracket.depth % BRACKET_COLOR_COUNT].push(
        new vscode.Range(start, start.translate(0, 1)),
      )
    }
    decorations.forEach((decoration, index) =>
      editor.setDecorations(decoration, buckets[index]),
    )
  }
  const schedule = (editor: TextEditor | undefined, delay = 30) => {
    if (!editor || !PASCAL_LANGUAGE_IDS.has(editor.document.languageId)) return
    const key = editor.document.uri.toString()
    clearTimeout(timers.get(key))
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        const live = vscode.window.visibleTextEditors.find(
          (candidate) => candidate.document.uri.toString() === key,
        )
        if (live) refresh(live)
      }, delay),
    )
  }

  context.subscriptions.push(
    ...decorations,
    vscode.window.onDidChangeVisibleTextEditors((editors) =>
      editors.forEach((editor) => schedule(editor, 0)),
    ),
    vscode.window.onDidChangeActiveTextEditor((editor) => schedule(editor, 0)),
    vscode.workspace.onDidChangeTextDocument((event) => {
      const editor = vscode.window.visibleTextEditors.find(
        (candidate) => candidate.document === event.document,
      )
      if (editor) schedule(editor)
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event.affectsConfiguration("editor.bracketPairColorization") &&
        !event.affectsConfiguration("pascalAtlas.enabled")
      )
        return
      vscode.window.visibleTextEditors.forEach((editor) => schedule(editor, 0))
    }),
    {
      dispose() {
        for (const timer of timers.values()) clearTimeout(timer)
        timers.clear()
      },
    },
  )
  vscode.window.visibleTextEditors.forEach((editor) => schedule(editor, 0))
}

function registerPascalLanguageConfiguration(
  context: { subscriptions: Disposable[] },
  vscode: typeof import("vscode"),
) {
  for (const language of [
    LanguageId.Pascal,
    LanguageId.ObjectPascal,
    LanguageId.Platform,
  ]) {
    context.subscriptions.push(
      vscode.languages.setLanguageConfiguration(
        language,
        languageConfiguration(vscode),
      ),
    )
  }
  registerPascalGenericBracketColoring(context, vscode)
}

export {
  BLOCK_START_PATTERN,
  PASCAL_INDENTATION_RULES,
  SINGLE_STATEMENT_PATTERN,
  collectPascalGenericAngleBrackets,
  languageConfiguration,
  registerPascalLanguageConfiguration,
}
