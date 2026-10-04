import { UriScheme } from "../shared/identifiers"
import type { BlankLineProtection } from "./postprocess"
import { isInteger, errorMessage } from "../shared/guards"
import {
  CommandId,
  ConfigurationSection,
  LanguageId,
  SettingKey,
} from "../shared/identifiers"
import * as vscode from "vscode"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { execFile } from "child_process"
import {
  commentStateBeforeLine,
  formatPascalLine,
  onTypeLineRequests,
} from "./formatter"
import {
  alignWrappedArgumentLine,
  alignWrappedParameters,
  normalizeGenericTypeSpacing,
  normalizeInlineVariableContinuations,
  normalizeTypeNameCapitalization,
  normalizeVariableNameCapitalization,
  postprocessPascal,
  protectBlankLinesForFormatting,
  restoreProtectedBlankLines,
} from "./postprocess"
import {
  DEFAULT_BLOCK_LEVEL_COLORS,
  normalizeBlockLevelColors,
  findDelphiKeywordMatchGroup,
  findDelphiModuleKeywordHighlights,
  findDelphiSelfKeywordHighlights,
  findDelphiKeywordHighlights,
  findPascalCommentHighlights,
} from "./highlighting"
import {
  STYLE_RULES,
  createStyleProfile,
  parseStyleProfile,
  resolveFormatterConfig,
} from "./styleRules"

const EXTENSION_ID = "yannpapouin.pascal-atlas"
const LEGACY_FORMATTER_EXTENSION_IDS = new Set<string>([
  "local.pascal-on-type-formatter",
])
const HIGHLIGHT_COLORS = Object.freeze({
  typeDeclaration: "#569CD6",
  typeIdentifier: "#4EC9B0",
  callable: "#DCDCAA",
  fieldIdentifier: "#9CDCFE",
  comment: "#6A9955",
})
const SELECTOR = [
  { language: LanguageId.Pascal, scheme: UriScheme.File },
  { language: LanguageId.Pascal, scheme: "untitled" },
  { language: LanguageId.ObjectPascal, scheme: UriScheme.File },
  { language: LanguageId.ObjectPascal, scheme: "untitled" },
]
const KEYWORD_HIGHLIGHT_SELECTOR = [
  ...SELECTOR,
  { language: LanguageId.Platform, scheme: UriScheme.File },
]
async function saveStyleProfile(output: vscode.LogOutputChannel) {
  const configuration = vscode.workspace.getConfiguration("pascalAtlas.formatter")
  const usingDefault = configuration.get("style.useDefault", true)
  const profile = createStyleProfile(
    (key, defaultValue) => configuration.get(key, defaultValue),
    usingDefault,
  )
  const uri = await vscode.window.showSaveDialog({
    title: "Save Pascal Atlas Formatting Profile",
    defaultUri: vscode.Uri.file(
      path.join(os.homedir(), "PascalAtlasFormatterStyle.json"),
    ),
    filters: { "Pascal Atlas Formatting Profile": ["json"] },
    saveLabel: "Save Profile",
  })
  if (!uri) return
  await fs.promises.writeFile(
    uri.fsPath,
    `${JSON.stringify(profile, null, 2)}\n`,
    "utf8",
  )
  output.info(`Saved formatter style profile to ${uri.fsPath}.`)
  const message = usingDefault
    ? "The default profile was saved as an editable custom profile."
    : "The current custom formatting profile was saved."
  void vscode.window.showInformationMessage(message)
}

async function loadStyleProfile(output: vscode.LogOutputChannel) {
  const uris = await vscode.window.showOpenDialog({
    title: "Load Pascal Atlas Formatting Profile",
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    filters: { "Pascal Atlas Formatting Profile": ["json"] },
    openLabel: "Load Profile",
  })
  if (!uris?.length) return
  const values = parseStyleProfile(await fs.promises.readFile(uris[0].fsPath, "utf8"))
  const configuration = vscode.workspace.getConfiguration("pascalAtlas.formatter")
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global
  await configuration.update("style.useDefault", false, target)
  for (const rule of STYLE_RULES) {
    await configuration.update(rule.key, values.get(rule.key), target)
  }
  output.info(`Loaded formatter style profile from ${uris[0].fsPath}.`)
  void vscode.window.showInformationMessage(
    "Custom formatting profile loaded and enabled.",
  )
}

function isPascal(document: vscode.TextDocument) {
  return (
    document.languageId === LanguageId.Pascal ||
    document.languageId === LanguageId.ObjectPascal
  )
}

function formatterConfiguration(document?: Pick<vscode.TextDocument, "uri">) {
  return vscode.workspace.getConfiguration("pascalAtlas.formatter", document?.uri)
}

function formatterEnabled(document: vscode.TextDocument) {
  return (
    vscode.workspace
      .getConfiguration(ConfigurationSection, document?.uri)
      .get(SettingKey.Enabled, true) &&
    formatterConfiguration(document).get(SettingKey.Enabled, true)
  )
}

function onTypeScope(document: vscode.TextDocument, character: string) {
  const configuration = formatterConfiguration(document)
  if (character === ";")
    return configuration.get("onType.semicolon.scope", "currentLine")
  if (character === ")")
    return configuration.get("onType.closingParenthesis.scope", "currentLine")
  return configuration.get("onType.enter.scope", "currentAndPrevious")
}

function scopeIncludes(scope: string, part: string) {
  return scope === part || scope === "currentAndPrevious"
}

function findFormatterExecutable(document: vscode.TextDocument | undefined) {
  const configured = formatterConfiguration(document).get("executablePath", "").trim()
  if (configured) {
    return configured
  }

  const programFilesX86 = process.env["ProgramFiles(x86)"]
  if (!programFilesX86) {
    return undefined
  }

  const studioRoot = path.join(programFilesX86, "Embarcadero", "Studio")
  if (!fs.existsSync(studioRoot)) {
    return undefined
  }

  const versions = fs
    .readdirSync(studioRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))

  for (const version of versions) {
    const candidate = path.join(studioRoot, version, "bin", "Formatter.exe")
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

function runFormatter(
  executable: string,
  args: readonly string[],
  workingDirectory: string,
  cancellationToken: vscode.CancellationToken,
) {
  return new Promise<void>((resolve, reject) => {
    const child = execFile(
      executable,
      args,
      { cwd: workingDirectory, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        cancellationSubscription.dispose()
        if (error) {
          reject(new Error(stderr?.trim() || stdout?.trim() || error.message))
        } else {
          resolve()
        }
      },
    )

    const cancellationSubscription = cancellationToken.onCancellationRequested(() => {
      child.kill()
      reject(new vscode.CancellationError())
    })
  })
}

function quoteCommandArgument(argument: string) {
  const value = String(argument)
  if (!/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
}

function formatCommandLine(executable: string, args: string[]) {
  return [executable, ...args].map(quoteCommandArgument).join(" ")
}

async function formatDocument(
  context: { asAbsolutePath: (relativePath: string) => string },
  document: vscode.TextDocument,
  cancellationToken: vscode.CancellationToken,
  output: vscode.LogOutputChannel,
) {
  const executable = findFormatterExecutable(document)
  if (!executable || !fs.existsSync(executable)) {
    const message =
      "Embarcadero Formatter.exe was not found. Configure pascalAtlas.formatter.executablePath."
    output.error(message)
    void vscode.window.showErrorMessage(message, "Open Settings").then((choice) => {
      if (choice === "Open Settings") {
        void vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "pascalAtlas.formatter.executablePath",
        )
      }
    })
    return undefined
  }

  const temporaryDirectory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "delphi-personal-formatter-"),
  )
  const inputPath = path.join(temporaryDirectory, "document.pas")
  const configPath = path.join(temporaryDirectory, "DelphiFormatter.config")
  const baseConfigPath = context.asAbsolutePath(
    path.join("resources", "DelphiFormatter.config"),
  )

  try {
    const source = document.getText()
    const activeEditor = vscode.window.activeTextEditor
    const protectedBlankLines: (BlankLineProtection & {
      selectionIndexes: number[]
    })[] = []
    if (activeEditor?.document.uri.toString() === document.uri.toString()) {
      const protectedByLine = new Map<
        number,
        BlankLineProtection & { selectionIndexes: number[] }
      >()
      for (const [selectionIndex, selection] of activeEditor.selections.entries()) {
        const lineNumber = selection.active.line
        const line = document.lineAt(lineNumber)
        if (line.text.trim() === "") {
          const existing = protectedByLine.get(lineNumber)
          if (existing) {
            existing.selectionIndexes.push(selectionIndex)
            continue
          }
          let marker = `__DELPHI_PERSONAL_FORMATTER_CARET_${lineNumber}__`
          while (source.includes(marker)) {
            marker = `${marker}_`
          }
          const protection: BlankLineProtection & { selectionIndexes: number[] } = {
            lineNumber,
            indentation: line.text,
            marker,
            selectionIndexes: [selectionIndex],
          }
          protectedBlankLines.push(protection)
          protectedByLine.set(lineNumber, protection)
        }
      }
    }

    const configuration = formatterConfiguration(document)
    const baseConfig = await fs.promises.readFile(baseConfigPath, "utf8")
    const formatterConfig = resolveFormatterConfig(
      baseConfig,
      configuration.get("style.useDefault", true),
      (key, defaultValue) => configuration.get(key, defaultValue),
    )
    await Promise.all([
      fs.promises.writeFile(
        inputPath,
        protectBlankLinesForFormatting(source, protectedBlankLines),
        "utf8",
      ),
      fs.promises.writeFile(configPath, formatterConfig, "utf8"),
    ])
    const args = ["-silent", "-config", configPath, inputPath]
    output.info(`Formatter command: ${formatCommandLine(executable, args)}`)
    await runFormatter(executable, args, temporaryDirectory, cancellationToken)

    let formatted = await fs.promises.readFile(inputPath, "utf8")
    if (formatted.charCodeAt(0) === 0xfeff) {
      formatted = formatted.slice(1)
    }

    formatted = postprocessPascal(formatted, {
      preserveInlineVariables: configuration.get("preserveInlineVariables", true),
      normalizeTypeNameCapitalization: configuration.get(
        "normalizeTypeNameCapitalization",
        true,
      ),
      normalizeVariableNameCapitalization: configuration.get(
        "normalizeVariableNameCapitalization",
        true,
      ),
      normalizeGenericTypeSpacing: configuration.get(
        "normalizeGenericTypeSpacing",
        true,
      ),
      normalizeInlineVariableContinuations: configuration.get(
        "normalizeInlineVariableContinuations",
        true,
      ),
      alignWrappedParameters: configuration.get("alignWrappedParameters", true),
    })
    formatted = restoreProtectedBlankLines(formatted, protectedBlankLines)
    output.info(`Formatted ${document.fileName} with ${executable}.`)
    return {
      text: formatted,
      caretPositions: protectedBlankLines
        .filter(
          (
            protection,
          ): protection is BlankLineProtection & {
            selectionIndexes: number[]
            resolvedLineNumber: number
            resolvedCharacter: number
          } =>
            protection.resolvedLineNumber !== undefined &&
            protection.resolvedCharacter !== undefined,
        )
        .map((protection) => ({
          lineNumber: protection.resolvedLineNumber,
          character: protection.resolvedCharacter,
          selectionIndexes: protection.selectionIndexes,
        })),
    }
  } finally {
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function lineFormattingEdit(
  document: vscode.TextDocument,
  lineNumber: number,
  options: { alignBlankContinuationLine?: boolean } = {},
) {
  if (lineNumber < 0 || lineNumber >= document.lineCount) {
    return undefined
  }

  let lines = Array.from(
    { length: document.lineCount },
    (_, index) => document.lineAt(index).text,
  )
  const initialCommentState = commentStateBeforeLine(lines, lineNumber)
  const trimmedTarget = lines[lineNumber].trimStart()
  const isContinuationSlotLine =
    options.alignBlankContinuationLine &&
    (trimmedTarget === "" || trimmedTarget.startsWith(")"))
  if (!isContinuationSlotLine) {
    lines[lineNumber] = formatPascalLine(lines[lineNumber], initialCommentState, {
      normalizeGenericTypeSpacing: formatterConfiguration(document).get(
        "normalizeGenericTypeSpacing",
        true,
      ),
    })
  }
  const configuration = formatterConfiguration(document)
  if (configuration.get("normalizeTypeNameCapitalization", false)) {
    lines = normalizeTypeNameCapitalization(lines)
  }
  if (configuration.get("normalizeVariableNameCapitalization", false)) {
    lines = normalizeVariableNameCapitalization(lines)
  }
  if (configuration.get("normalizeGenericTypeSpacing", true)) {
    lines = normalizeGenericTypeSpacing(lines)
  }

  if (configuration.get("alignWrappedParameters", true)) {
    const alignedLines = alignWrappedParameters(lines, {
      alignBlankLineIndexes: isContinuationSlotLine ? [lineNumber] : [],
    })
    lines[lineNumber] = alignedLines[lineNumber]

    if (isContinuationSlotLine) {
      const configuredTabSize = vscode.workspace
        .getConfiguration("editor", document.uri)
        .get("tabSize", 2)
      const indentSize = isInteger(configuredTabSize) ? configuredTabSize : 2
      lines[lineNumber] = alignWrappedArgumentLine(lines, lineNumber, indentSize)[
        lineNumber
      ]
    }
  }
  if (configuration.get("normalizeInlineVariableContinuations", true)) {
    lines = normalizeInlineVariableContinuations(lines, {
      includeBlankLineIndexes: isContinuationSlotLine ? [lineNumber] : [],
    })
  }

  const line = document.lineAt(lineNumber)
  if (isContinuationSlotLine) {
    const currentIndentLength = line.text.length - line.text.trimStart().length
    const desiredIndent = lines[lineNumber].slice(
      0,
      lines[lineNumber].length - lines[lineNumber].trimStart().length,
    )
    return desiredIndent.length === currentIndentLength
      ? undefined
      : vscode.TextEdit.replace(
          new vscode.Range(lineNumber, 0, lineNumber, currentIndentLength),
          desiredIndent,
        )
  }
  return lines[lineNumber] === line.text
    ? undefined
    : vscode.TextEdit.replace(line.range, lines[lineNumber])
}

function continuationFormattingEdit(document: vscode.TextDocument, lineNumber: number) {
  const targetText =
    lineNumber >= 0 && lineNumber < document.lineCount
      ? document.lineAt(lineNumber).text
      : ""
  const trimmedTarget = targetText.trimStart()
  if (
    lineNumber <= 0 ||
    lineNumber >= document.lineCount ||
    (trimmedTarget !== "" && !trimmedTarget.startsWith(")")) ||
    !formatterConfiguration(document).get("alignWrappedParameters", true)
  ) {
    return undefined
  }

  let lines = Array.from(
    { length: document.lineCount },
    (_, index) => document.lineAt(index).text,
  )
  lines = alignWrappedParameters(lines, { alignBlankLineIndexes: [lineNumber] })

  const configuredTabSize = vscode.workspace
    .getConfiguration("editor", document.uri)
    .get("tabSize", 2)
  const indentSize = isInteger(configuredTabSize) ? configuredTabSize : 2
  lines = alignWrappedArgumentLine(lines, lineNumber, indentSize)
  if (
    formatterConfiguration(document).get("normalizeInlineVariableContinuations", true)
  ) {
    lines = normalizeInlineVariableContinuations(lines, {
      includeBlankLineIndexes: [lineNumber],
    })
  }

  const line = document.lineAt(lineNumber)
  const currentIndentLength = line.text.length - line.text.trimStart().length
  const desiredIndent = lines[lineNumber].slice(
    0,
    lines[lineNumber].length - lines[lineNumber].trimStart().length,
  )
  return desiredIndent.length === currentIndentLength
    ? undefined
    : vscode.TextEdit.replace(
        new vscode.Range(lineNumber, 0, lineNumber, currentIndentLength),
        desiredIndent,
      )
}

function registerKeywordHighlighting(context: { subscriptions: vscode.Disposable[] }) {
  const uniformFontDecoration = vscode.window.createTextEditorDecorationType({
    fontWeight: "normal",
    fontStyle: "normal",
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  })
  const classDecoration = vscode.window.createTextEditorDecorationType({
    color: HIGHLIGHT_COLORS.typeDeclaration,
  })
  const moduleKeywordDecoration = vscode.window.createTextEditorDecorationType({
    // File/module sections intentionally follow `type`, not Dark+'s purple
    // keyword.control rule and not the indentation-level palette.
    color: HIGHLIGHT_COLORS.typeDeclaration,
  })
  const selfKeywordDecoration = vscode.window.createTextEditorDecorationType({
    // Vallenta classifies Self as variable.language; keep its color aligned
    // with Delphi's ordinary type keywords.
    color: HIGHLIGHT_COLORS.typeDeclaration,
  })
  const blockDecorationSets = new Map<string, vscode.TextEditorDecorationType[]>()
  const typeLikeDecoration = vscode.window.createTextEditorDecorationType({
    color: HIGHLIGHT_COLORS.typeIdentifier,
  })
  const callableDecoration = vscode.window.createTextEditorDecorationType({
    color: HIGHLIGHT_COLORS.callable,
  })
  const fieldDecoration = vscode.window.createTextEditorDecorationType({
    color: HIGHLIGHT_COLORS.fieldIdentifier,
  })
  const commentDecoration = vscode.window.createTextEditorDecorationType({
    color: HIGHLIGHT_COLORS.comment,
  })
  const pendingRefreshes = new Map<string, ReturnType<typeof setTimeout>>()

  context.subscriptions.push(
    vscode.languages.registerDocumentHighlightProvider(KEYWORD_HIGHLIGHT_SELECTOR, {
      provideDocumentHighlights(document, position) {
        if (
          !vscode.workspace
            .getConfiguration(ConfigurationSection, document.uri)
            .get(SettingKey.Enabled, true)
        ) {
          return undefined
        }
        const matches = findDelphiKeywordMatchGroup(document.getText(), position)
        if (!matches) return undefined
        return matches.map(
          (match) =>
            new vscode.DocumentHighlight(
              new vscode.Range(match.line, match.start, match.line, match.end),
              vscode.DocumentHighlightKind.Text,
            ),
        )
      },
    }),
    uniformFontDecoration,
    classDecoration,
    moduleKeywordDecoration,
    selfKeywordDecoration,
    typeLikeDecoration,
    callableDecoration,
    fieldDecoration,
    commentDecoration,
    {
      dispose: () => {
        for (const decorations of blockDecorationSets.values()) {
          decorations.forEach((decoration) => decoration.dispose())
        }
        blockDecorationSets.clear()
      },
    },
  )

  const blockDecorationsFor = (document: vscode.TextDocument) => {
    const colors = normalizeBlockLevelColors(
      formatterConfiguration(document).get(
        "highlighting.blockLevelColors",
        DEFAULT_BLOCK_LEVEL_COLORS,
      ),
    )
    const key = colors.map((color) => color.toUpperCase()).join(",")
    if (!blockDecorationSets.has(key)) {
      blockDecorationSets.set(
        key,
        colors.map((color) =>
          vscode.window.createTextEditorDecorationType({
            color,
          }),
        ),
      )
    }
    return blockDecorationSets.get(key) || []
  }

  const clearBlockDecorations = (
    editor: vscode.TextEditor,
    retainedDecorations?: vscode.TextEditorDecorationType[],
  ) => {
    for (const decorations of blockDecorationSets.values()) {
      if (decorations === retainedDecorations) continue
      decorations.forEach((decoration) => editor.setDecorations(decoration, []))
    }
  }

  const refreshEditor = (editor: vscode.TextEditor | undefined) => {
    if (!editor || !isPascal(editor.document)) {
      return
    }

    const paEnabled = vscode.workspace
      .getConfiguration(ConfigurationSection, editor.document.uri)
      .get(SettingKey.Enabled, true)
    const finalLine = Math.max(0, editor.document.lineCount - 1)
    editor.setDecorations(
      uniformFontDecoration,
      paEnabled
        ? [
            new vscode.Range(
              0,
              0,
              finalLine,
              editor.document.lineAt(finalLine).text.length,
            ),
          ]
        : [],
    )

    if (
      !formatterEnabled(editor.document) ||
      !formatterConfiguration(editor.document).get("highlighting.enabled", true)
    ) {
      editor.setDecorations(classDecoration, [])
      editor.setDecorations(moduleKeywordDecoration, [])
      editor.setDecorations(selfKeywordDecoration, [])
      clearBlockDecorations(editor)
      editor.setDecorations(typeLikeDecoration, [])
      editor.setDecorations(callableDecoration, [])
      editor.setDecorations(fieldDecoration, [])
      editor.setDecorations(commentDecoration, [])
      return
    }

    const configuration = formatterConfiguration(editor.document)
    const blockLevelDecorations = blockDecorationsFor(editor.document)
    clearBlockDecorations(editor, blockLevelDecorations)
    const highlights = findDelphiKeywordHighlights(editor.document.getText(), {
      tabSize: configuration.get("style.indentation.tabSize", 2),
      indentSize: configuration.get("style.indentation.indentSize", 2),
      blockLevelCount: blockLevelDecorations.length,
    })
    const toRanges = (items: { line: number; start: number; end: number }[]) =>
      items.map((item) => new vscode.Range(item.line, item.start, item.line, item.end))
    editor.setDecorations(
      classDecoration,
      toRanges([
        ...highlights.typeDeclarationKeywords,
        ...highlights.typeDeclarationEndKeywords,
      ]),
    )
    editor.setDecorations(
      moduleKeywordDecoration,
      toRanges(findDelphiModuleKeywordHighlights(editor.document.getText())),
    )
    editor.setDecorations(
      selfKeywordDecoration,
      toRanges(findDelphiSelfKeywordHighlights(editor.document.getText())),
    )
    blockLevelDecorations.forEach((decoration, index) =>
      editor.setDecorations(
        decoration,
        toRanges(highlights.blockLevelKeywords[index] || []),
      ),
    )
    const paConfiguration = vscode.workspace.getConfiguration(
      ConfigurationSection,
      editor.document.uri,
    )
    const paOwnsSymbols =
      paConfiguration.get(SettingKey.Enabled, true) &&
      paConfiguration.get(SettingKey.ColoringEnabled, true)
    // Pascal Atlas owns symbol categories while it is enabled. Keeping the old
    // Formatter type/callable/field layer active as well causes the same token
    // to be repainted by two independent debounce cycles.
    editor.setDecorations(
      typeLikeDecoration,
      paOwnsSymbols ? [] : toRanges(highlights.typeLikeIdentifiers),
    )
    editor.setDecorations(
      callableDecoration,
      paOwnsSymbols ? [] : toRanges(highlights.callableIdentifiers),
    )
    editor.setDecorations(
      fieldDecoration,
      paOwnsSymbols ? [] : toRanges(highlights.fieldIdentifiers),
    )
    // Vallenta semantic tokens can remain attached to identifiers after code is
    // commented out. Apply this last so real comments always render uniformly.
    editor.setDecorations(
      commentDecoration,
      toRanges(findPascalCommentHighlights(editor.document.getText())),
    )
  }

  const refreshVisibleEditors = () =>
    vscode.window.visibleTextEditors.forEach(refreshEditor)
  const scheduleRefresh = (document: vscode.TextDocument) => {
    const key = document.uri.toString()
    clearTimeout(pendingRefreshes.get(key))
    pendingRefreshes.set(
      key,
      setTimeout(() => {
        pendingRefreshes.delete(key)
        vscode.window.visibleTextEditors
          .filter((editor) => editor.document.uri.toString() === key)
          .forEach(refreshEditor)
      }, 50),
    )
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refreshEditor),
    vscode.window.onDidChangeVisibleTextEditors(refreshVisibleEditors),
    vscode.workspace.onDidChangeTextDocument((event) =>
      scheduleRefresh(event.document),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(
          "pascalAtlas.formatter.highlighting.blockLevelColors",
        ) ||
        event.affectsConfiguration("pascalAtlas.formatter.highlighting.enabled") ||
        event.affectsConfiguration("pascalAtlas.formatter.enabled") ||
        event.affectsConfiguration("pascalAtlas.coloring.enabled") ||
        event.affectsConfiguration("pascalAtlas.enabled")
      ) {
        refreshVisibleEditors()
      }
    }),
    { dispose: () => pendingRefreshes.forEach((timeout) => clearTimeout(timeout)) },
  )

  refreshVisibleEditors()
}

function registerFormatter(
  context: Pick<vscode.ExtensionContext, "subscriptions" | "asAbsolutePath">,
) {
  const output = vscode.window.createOutputChannel("Pascal Atlas Formatter", {
    log: true,
  })
  const pendingContinuationLines = new Map<
    string,
    {
      document: vscode.TextDocument
      lineNumbers: Set<number>
      timeout?: ReturnType<typeof setTimeout>
    }
  >()
  const applyingContinuationEdits = new Set<string>()
  const pendingCaretRestorations = new Map<
    string,
    {
      caretPositions: {
        lineNumber: number
        character: number
        selectionIndexes: number[]
      }[]
    }
  >()
  const applyCaretRestoration = (documentKey: string) => {
    const pending = pendingCaretRestorations.get(documentKey)
    if (!pending) {
      return
    }
    pendingCaretRestorations.delete(documentKey)
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === documentKey,
    )
    if (!editor) {
      return
    }

    const selections = [...editor.selections]
    for (const caret of pending.caretPositions) {
      if (caret.lineNumber < 0 || caret.lineNumber >= editor.document.lineCount) {
        continue
      }
      const lineLength = editor.document.lineAt(caret.lineNumber).text.length
      const position = new vscode.Position(
        caret.lineNumber,
        Math.min(caret.character, lineLength),
      )
      for (const selectionIndex of caret.selectionIndexes) {
        if (selectionIndex < selections.length) {
          selections[selectionIndex] = new vscode.Selection(position, position)
        }
      }
    }
    editor.selections = selections
  }
  context.subscriptions.push(output)
  registerKeywordHighlighting(context)

  context.subscriptions.push(
    vscode.commands.registerCommand(CommandId.FormatterFormatDocument, () => {
      return vscode.commands.executeCommand("editor.action.formatDocument")
    }),
    vscode.commands.registerCommand(CommandId.FormatterStyleSave, async () => {
      try {
        await saveStyleProfile(output)
      } catch (error) {
        output.error(error instanceof Error ? error : errorMessage(error))
        void vscode.window.showErrorMessage(
          `Failed to save formatting profile: ${errorMessage(error) ?? error}`,
        )
      }
    }),
    vscode.commands.registerCommand(CommandId.FormatterStyleLoad, async () => {
      try {
        await loadStyleProfile(output)
      } catch (error) {
        output.error(error instanceof Error ? error : errorMessage(error))
        void vscode.window.showErrorMessage(
          `Failed to load formatting profile: ${errorMessage(error) ?? error}`,
        )
      }
    }),
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, {
      async provideDocumentFormattingEdits(document, options, cancellationToken) {
        if (!formatterEnabled(document)) return []
        try {
          const result = await formatDocument(
            context,
            document,
            cancellationToken,
            output,
          )
          if (result === undefined) {
            return []
          }
          if (result.caretPositions.length > 0) {
            const documentKey = document.uri.toString()
            pendingCaretRestorations.set(documentKey, {
              caretPositions: result.caretPositions,
            })
            if (result.text === document.getText()) {
              setTimeout(() => applyCaretRestoration(documentKey), 0)
            }
          }
          if (result.text === document.getText()) {
            return []
          }
          const lastLine = document.lineAt(document.lineCount - 1)
          const range = new vscode.Range(
            0,
            0,
            document.lineCount - 1,
            lastLine.text.length,
          )
          return [vscode.TextEdit.replace(range, result.text)]
        } catch (error) {
          if (!(error instanceof vscode.CancellationError)) {
            output.error(error instanceof Error ? error : errorMessage(error))
            void vscode.window.showErrorMessage(
              `Delphi formatting failed: ${errorMessage(error) ?? error}`,
            )
          }
          return []
        }
      },
    }),
    vscode.workspace.onWillSaveTextDocument((event) => {
      const document = event.document
      if (
        !formatterEnabled(document) ||
        !formatterConfiguration(document).get("formatOnSave", true)
      )
        return

      const cancellation = new vscode.CancellationTokenSource()
      event.waitUntil(
        (async () => {
          try {
            const result = await formatDocument(
              context,
              document,
              cancellation.token,
              output,
            )
            if (!result || result.text === document.getText()) return []
            const lastLine = document.lineAt(document.lineCount - 1)
            const range = new vscode.Range(
              0,
              0,
              document.lineCount - 1,
              lastLine.text.length,
            )
            return [vscode.TextEdit.replace(range, result.text)]
          } catch (error) {
            if (!(error instanceof vscode.CancellationError)) {
              output.error(error instanceof Error ? error : errorMessage(error))
              void vscode.window.showErrorMessage(
                `Delphi formatting failed: ${errorMessage(error) ?? error}`,
              )
            }
            return []
          } finally {
            cancellation.dispose()
          }
        })(),
      )
    }),
  )

  context.subscriptions.push(
    vscode.languages.registerOnTypeFormattingEditProvider(
      SELECTOR,
      {
        provideOnTypeFormattingEdits(document, position, character) {
          if (
            !formatterEnabled(document) ||
            !formatterConfiguration(document).get("onType.enabled", true)
          )
            return []
          const scope = onTypeScope(document, character)
          const lineRequests = onTypeLineRequests(position.line, character, scope)
          const edits = lineRequests
            .map(({ lineNumber, alignBlankContinuationLine }) =>
              lineFormattingEdit(document, lineNumber, { alignBlankContinuationLine }),
            )
            .filter((edit): edit is vscode.TextEdit => Boolean(edit))

          if (formatterConfiguration(document).get("onType.logging", false)) {
            output.info(
              `Official on-type trigger '${character === "\n" ? "Enter" : character}' on line ${position.line + 1}; changed=${edits.length > 0}.`,
            )
          }
          return edits
        },
      },
      ";",
      ")",
      "\n",
    ),
  )

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      const document = event.document
      const documentKey = document.uri.toString()
      if (pendingCaretRestorations.has(documentKey)) {
        setTimeout(() => applyCaretRestoration(documentKey), 0)
      }
      if (
        !isPascal(document) ||
        !formatterEnabled(document) ||
        !formatterConfiguration(document).get("onType.enabled", true) ||
        !scopeIncludes(onTypeScope(document, "\n"), "currentLine") ||
        applyingContinuationEdits.has(documentKey) ||
        !vscode.workspace
          .getConfiguration("editor", document.uri)
          .get("formatOnType", false)
      ) {
        return
      }

      const destinationLines = event.contentChanges
        .filter((change) => /^(?:\r?\n[ \t]*)+$/.test(change.text))
        .map((change) => {
          const newlineCount = change.text.match(/\r\n|\n/g)?.length ?? 0
          return change.range.start.line + newlineCount
        })
      if (destinationLines.length === 0) {
        return
      }

      const pending = pendingContinuationLines.get(documentKey) ?? {
        document,
        lineNumbers: new Set<number>(),
        timeout: undefined,
      }
      destinationLines.forEach((lineNumber) => pending.lineNumbers.add(lineNumber))
      clearTimeout(pending.timeout)
      pending.timeout = setTimeout(() => {
        pendingContinuationLines.delete(documentKey)
        const edits = [...pending.lineNumbers]
          .map((lineNumber) => continuationFormattingEdit(pending.document, lineNumber))
          .filter((edit): edit is vscode.TextEdit => Boolean(edit))
        if (formatterConfiguration(pending.document).get("onType.logging", false)) {
          output.info(
            `Post-Enter continuation indentation on line(s) ${[...pending.lineNumbers].map((line) => line + 1).join(", ")}; changed=${edits.length > 0}.`,
          )
        }
        if (edits.length === 0) {
          return
        }

        const workspaceEdit = new vscode.WorkspaceEdit()
        workspaceEdit.set(pending.document.uri, edits)
        applyingContinuationEdits.add(documentKey)
        void Promise.resolve(vscode.workspace.applyEdit(workspaceEdit)).finally(() =>
          applyingContinuationEdits.delete(documentKey),
        )
      }, 0)
      pendingContinuationLines.set(documentKey, pending)
    }),
    {
      dispose: () => {
        pendingContinuationLines.forEach((pending) => clearTimeout(pending.timeout))
        pendingCaretRestorations.clear()
      },
    },
  )

  output.info(`${EXTENSION_ID} activated. Document and on-type formatting are ready.`)
}

async function migrateLegacyFormatterSettings() {
  const legacy = vscode.workspace.getConfiguration("delphiPersonalFormatter")
  const current = vscode.workspace.getConfiguration("pascalAtlas.formatter")
  const mappings = [
    ["executablePath", "executablePath"],
    ["preserveInlineVariables", "preserveInlineVariables"],
    ["alignWrappedParameters", "alignWrappedParameters"],
    ["onTypeLogging", "onType.logging"],
    ["highlighting.enabled", "highlighting.enabled"],
  ]
  for (const [legacyKey, currentKey] of mappings) {
    const source = legacy.inspect(legacyKey)
    const target = current.inspect(currentKey)
    if (!source || !target) continue
    if (source.globalValue !== undefined && target.globalValue === undefined) {
      await current.update(
        currentKey,
        source.globalValue,
        vscode.ConfigurationTarget.Global,
      )
    }
    if (source.workspaceValue !== undefined && target.workspaceValue === undefined) {
      await current.update(
        currentKey,
        source.workspaceValue,
        vscode.ConfigurationTarget.Workspace,
      )
    }
  }
  const folder = vscode.workspace.workspaceFolders?.[0]
  for (const languageId of [LanguageId.Pascal, LanguageId.ObjectPascal]) {
    const editor = vscode.workspace.getConfiguration("editor", {
      uri: folder?.uri,
      languageId,
    })
    const inspected = editor.inspect<string>("defaultFormatter")
    const targets: [
      "globalLanguageValue" | "workspaceLanguageValue" | "workspaceFolderLanguageValue",
      vscode.ConfigurationTarget,
      boolean,
    ][] = [
      ["globalLanguageValue", vscode.ConfigurationTarget.Global, true],
      ["workspaceLanguageValue", vscode.ConfigurationTarget.Workspace, Boolean(folder)],
      [
        "workspaceFolderLanguageValue",
        vscode.ConfigurationTarget.WorkspaceFolder,
        Boolean(folder),
      ],
    ]
    let migrated = false
    for (const [property, target, available] of targets) {
      if (
        !available ||
        !LEGACY_FORMATTER_EXTENSION_IDS.has(inspected?.[property] || "")
      )
        continue
      await editor.update("defaultFormatter", EXTENSION_ID, target, true)
      migrated = true
    }
    if (
      !migrated &&
      LEGACY_FORMATTER_EXTENSION_IDS.has(editor.get<string>("defaultFormatter", ""))
    ) {
      await editor.update(
        "defaultFormatter",
        EXTENSION_ID,
        folder
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global,
        true,
      )
    }
  }
}

export { findFormatterExecutable, migrateLegacyFormatterSettings, registerFormatter }
