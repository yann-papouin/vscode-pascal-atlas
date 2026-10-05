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
/**
 * Ask for a destination and save the active/default formatter rule profile as editable
 * UTF-8 JSON, doing nothing when the dialog is cancelled.
 */
async function saveStyleProfile(output: vscode.LogOutputChannel) {
  const configuration = vscode.workspace.getConfiguration("pascalAtlas.formatter")
  const usingDefault = configuration.get("style.useDefault", true)
  const profile = createStyleProfile(
    /** Read a configured formatter setting with its profile default. */ (
      key,
      defaultValue,
    ) => configuration.get(key, defaultValue),
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

/**
 * Read and validate a chosen formatting profile, enable custom styling, and update its
 * rule values at workspace or global scope.
 */
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

/**
 * Recognize ordinary Pascal/Object Pascal documents eligible for formatting commands
 * and on-type edits.
 */
function isPascal(document: vscode.TextDocument) {
  return (
    document.languageId === LanguageId.Pascal ||
    document.languageId === LanguageId.ObjectPascal
  )
}

/** Read formatter settings in the optional document URI scope. */
function formatterConfiguration(document?: Pick<vscode.TextDocument, "uri">) {
  return vscode.workspace.getConfiguration("pascalAtlas.formatter", document?.uri)
}

/** Require both Pascal Atlas and its formatter to be enabled for the document. */
function formatterEnabled(document: vscode.TextDocument) {
  return (
    vscode.workspace
      .getConfiguration(ConfigurationSection, document?.uri)
      .get(SettingKey.Enabled, true) &&
    formatterConfiguration(document).get(SettingKey.Enabled, true)
  )
}

/**
 * Select the configured line scope for semicolon, closing-parenthesis, or newline
 * formatting triggers.
 */
function onTypeScope(document: vscode.TextDocument, character: string) {
  const configuration = formatterConfiguration(document)
  if (character === ";")
    return configuration.get("onType.semicolon.scope", "currentLine")
  if (character === ")")
    return configuration.get("onType.closingParenthesis.scope", "currentLine")
  return configuration.get("onType.enter.scope", "currentAndPrevious")
}

/**
 * Check whether an on-type scope includes a requested current/previous-line operation.
 */
function scopeIncludes(scope: string, part: string) {
  return scope === part || scope === "currentAndPrevious"
}

/**
 * Resolve the configured or installed RAD Studio formatter path for the document's
 * settings scope.
 */
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
    .filter(
      /** Select formatter installation subdirectories. */ (entry) =>
        entry.isDirectory(),
    )
    .map(
      /** Extract local formatter subdirectory names from directory entries. */ (
        entry,
      ) => entry.name,
    )
    .sort(
      /**
       * Prefer the newest formatter subdirectory using descending numeric name
       * ordering.
       */ (left, right) => right.localeCompare(left, undefined, { numeric: true }),
    )

  for (const version of versions) {
    const candidate = path.join(studioRoot, version, "bin", "Formatter.exe")
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

/**
 * Execute the local formatter hidden with cancellation support, settling its
 * completion/error promise and disposing the cancellation subscription.
 */
function runFormatter(
  executable: string,
  args: readonly string[],
  workingDirectory: string,
  cancellationToken: vscode.CancellationToken,
) {
  return new Promise<void>(
    /**
     * Connect formatter process completion and cancellation to the returned promise.
     */ (resolve, reject) => {
      const child = execFile(
        executable,
        args,
        { cwd: workingDirectory, windowsHide: true, maxBuffer: 1024 * 1024 },
        /**
         * Release formatter cancellation handling and resolve success or reject with
         * process output.
         */ (error, stdout, stderr) => {
          cancellationSubscription.dispose()
          if (error) {
            reject(new Error(stderr?.trim() || stdout?.trim() || error.message))
          } else {
            resolve()
          }
        },
      )

      const cancellationSubscription = cancellationToken.onCancellationRequested(
        /**
         * Kill the formatter process and reject its result when cancellation is requested.
         */ () => {
          child.kill()
          reject(new vscode.CancellationError())
        },
      )
    },
  )
}

/**
 * Quote an executable/logging argument using Windows-safe backslash/quote escaping
 * when whitespace or quotes require it.
 */
function quoteCommandArgument(argument: string) {
  const value = String(argument)
  if (!/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`
}

/**
 * Render the formatter executable and arguments as a readable quoted command line for
 * logs.
 */
function formatCommandLine(executable: string, args: string[]) {
  return [executable, ...args].map(quoteCommandArgument).join(" ")
}

/**
 * Format an isolated source copy with the configured local Formatter.exe, postprocess
 * its output, restore protected caret lines, and always clean temporary files.
 */
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
    void vscode.window.showErrorMessage(message, "Open Settings").then(
      /** Open formatter settings when the user selects the offered setup action. */ (
        choice,
      ) => {
        if (choice === "Open Settings") {
          void vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "pascalAtlas.formatter.executablePath",
          )
        }
      },
    )
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
          // Choose a marker absent from the source so genuine comment text cannot be mistaken for a protected caret line.
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
      /** Read a document-scoped formatter setting with its profile default. */ (
        key,
        defaultValue,
      ) => configuration.get(key, defaultValue),
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
          /**
           * Keep blank-line protections with both resolved line and character
           * positions.
           */ (
            protection,
          ): protection is BlankLineProtection & {
            selectionIndexes: number[]
            resolvedLineNumber: number
            resolvedCharacter: number
          } =>
            protection.resolvedLineNumber !== undefined &&
            protection.resolvedCharacter !== undefined,
        )
        .map(
          /**
           * Carry resolved blank-line positions and their affected selection indexes
           * into caret restoration.
           */ (protection) => ({
            lineNumber: protection.resolvedLineNumber,
            character: protection.resolvedCharacter,
            selectionIndexes: protection.selectionIndexes,
          }),
        ),
    }
  } finally {
    // The formatter works only on the isolated copy; its temporary source/config files must be removed on cancellation or failure too.
    await fs.promises.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

/**
 * Compute a local line replacement under current normalization settings, retaining
 * comment state and returning undefined when no text change is needed.
 */
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
    /** Create the next initialized entry used by line formatting edit. */ (_, index) =>
      document.lineAt(index).text,
  )
  // Recover lexical state from preceding lines before applying spacing rules; an apparent code line may still be inside a block comment.
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

/**
 * Adjust only indentation for an eligible blank/closing-delimiter continuation line,
 * leaving other document text unchanged.
 */
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
    /** Create the next initialized entry used by continuation formatting edit. */ (
      _,
      index,
    ) => document.lineAt(index).text,
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

/**
 * Register structural keyword occurrence/highlight providers and reusable editor
 * decorations, with settings-aware debounced refresh and complete disposal.
 */
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
      /**
       * Return the structural keyword group at the caret only when the extension is
       * enabled, leaving unmatched symbols to other providers.
       */
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
          /** Convert matching Pascal keyword spans to textual document highlights. */ (
            match,
          ) =>
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
      dispose:
        /** Dispose all block decoration variants and release their cached sets. */ () => {
          for (const decorations of blockDecorationSets.values()) {
            decorations.forEach(
              /** Release each cached block decoration type. */ (decoration) =>
                decoration.dispose(),
            )
          }
          blockDecorationSets.clear()
        },
    },
  )

  /**
   * Cache one decoration set per validated structural color palette so editors sharing
   * a palette reuse the same resources.
   */
  const blockDecorationsFor = (document: vscode.TextDocument) => {
    const colors = normalizeBlockLevelColors(
      formatterConfiguration(document).get(
        "highlighting.blockLevelColors",
        DEFAULT_BLOCK_LEVEL_COLORS,
      ),
    )
    const key = colors
      .map(
        /** Normalize colors for stable decoration-cache keys. */ (color) =>
          color.toUpperCase(),
      )
      .join(",")
    if (!blockDecorationSets.has(key)) {
      blockDecorationSets.set(
        key,
        colors.map(
          /** Create a VS Code decoration type for each nesting-level color. */ (
            color,
          ) =>
            vscode.window.createTextEditorDecorationType({
              color,
            }),
        ),
      )
    }
    return blockDecorationSets.get(key) || []
  }

  /**
   * Remove every cached block-palette decoration from an editor before replacing or
   * disabling its structural coloring.
   */
  const clearBlockDecorations = (
    editor: vscode.TextEditor,
    retainedDecorations?: vscode.TextEditorDecorationType[],
  ) => {
    for (const decorations of blockDecorationSets.values()) {
      if (decorations === retainedDecorations) continue
      decorations.forEach(
        /** Remove every decoration in this set from the editor. */ (decoration) =>
          editor.setDecorations(decoration, []),
      )
    }
  }

  const refreshEditor = /**
   * Refresh one Pascal editor using current enablement, font, and syntax-highlighting
   * settings.
   */ (editor: vscode.TextEditor | undefined) => {
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
    const toRanges =
      /** Convert line-relative highlight spans to VS Code decoration ranges. */ (
        items: { line: number; start: number; end: number }[],
      ) =>
        items.map(
          /** Convert one line-relative highlight span into a VS Code range. */ (
            item,
          ) => new vscode.Range(item.line, item.start, item.line, item.end),
        )
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
    blockLevelDecorations.forEach(
      /**
       * Apply each nesting-level keyword bucket using its matching decoration color.
       */ (decoration, index) =>
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

  const refreshVisibleEditors =
    /** Refresh syntax decorations for all currently visible editors. */ () =>
      vscode.window.visibleTextEditors.forEach(refreshEditor)
  /**
   * Debounce keyword highlighting and rebind its scheduled work to the live editor
   * rather than a stale editor object.
   */
  const scheduleRefresh = (document: vscode.TextDocument) => {
    const key = document.uri.toString()
    clearTimeout(pendingRefreshes.get(key))
    pendingRefreshes.set(
      key,
      setTimeout(
        /**
         * Refresh all visible instances of this document after its debounce expires.
         */ () => {
          pendingRefreshes.delete(key)
          vscode.window.visibleTextEditors
            .filter(
              /** Select visible editors displaying the scheduled document. */ (
                editor,
              ) => editor.document.uri.toString() === key,
            )
            .forEach(refreshEditor)
        },
        50,
      ),
    )
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(refreshEditor),
    vscode.window.onDidChangeVisibleTextEditors(refreshVisibleEditors),
    vscode.workspace.onDidChangeTextDocument(
      /** Debounce keyword highlight updates for the changed document. */ (event) =>
        scheduleRefresh(event.document),
    ),
    vscode.workspace.onDidChangeConfiguration(
      /**
       * Refresh visible keyword decorations when relevant formatter or coloring settings
       * change.
       */ (event) => {
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
      },
    ),
    {
      dispose:
        /** Cancel pending editor decoration refresh timers during disposal. */ () =>
          pendingRefreshes.forEach(
            /** Cancel each delayed editor highlight refresh. */ (timeout) =>
              clearTimeout(timeout),
          ),
    },
  )

  refreshVisibleEditors()
}

/**
 * Register formatter commands/providers and guarded continuation/caret restoration
 * handlers, retaining subscriptions and pending-work cleanup.
 */
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
  /**
   * Rebind to a visible editor and restore selections whose protected blank-line
   * markers were resolved by document formatting.
   */
  const applyCaretRestoration = (documentKey: string) => {
    const pending = pendingCaretRestorations.get(documentKey)
    if (!pending) {
      return
    }
    pendingCaretRestorations.delete(documentKey)
    const editor = vscode.window.visibleTextEditors.find(
      /** Find a visible editor for the saved document identity. */ (candidate) =>
        candidate.document.uri.toString() === documentKey,
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
    vscode.commands.registerCommand(
      CommandId.FormatterFormatDocument,
      /** Invoke VS Code document formatting through the registered Pascal provider. */ () => {
        return vscode.commands.executeCommand("editor.action.formatDocument")
      },
    ),
    vscode.commands.registerCommand(
      CommandId.FormatterStyleSave,
      /**
       * Save the current formatter style profile and report any persistence failure.
       */ async () => {
        try {
          await saveStyleProfile(output)
        } catch (error) {
          output.error(error instanceof Error ? error : errorMessage(error))
          void vscode.window.showErrorMessage(
            `Failed to save formatting profile: ${errorMessage(error) ?? error}`,
          )
        }
      },
    ),
    vscode.commands.registerCommand(
      CommandId.FormatterStyleLoad,
      /** Load the selected formatter style profile and report any loading failure. */ async () => {
        try {
          await loadStyleProfile(output)
        } catch (error) {
          output.error(error instanceof Error ? error : errorMessage(error))
          void vscode.window.showErrorMessage(
            `Failed to load formatting profile: ${errorMessage(error) ?? error}`,
          )
        }
      },
    ),
    vscode.languages.registerDocumentFormattingEditProvider(SELECTOR, {
      /**
       * Format a supported enabled document through the local formatter and return a
       * replacement only when output differs, logging non-cancellation failures.
       */
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
              setTimeout(
                /**
                 * Restore the caret after document formatting edits have reached the
                 * editor.
                 */ () => applyCaretRestoration(documentKey),
                0,
              )
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
    vscode.workspace.onWillSaveTextDocument(
      /** Queue enabled format-on-save edits through the save event lifetime. */ (
        event,
      ) => {
        const document = event.document
        if (
          !formatterEnabled(document) ||
          !formatterConfiguration(document).get("formatOnSave", true)
        )
          return

        const cancellation = new vscode.CancellationTokenSource()
        event.waitUntil(
          /**
           * Format the saved document and return a whole-document edit only when its
           * text changes.
           */ (async () => {
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
      },
    ),
  )

  context.subscriptions.push(
    vscode.languages.registerOnTypeFormattingEditProvider(
      SELECTOR,
      {
        /**
         * Translate the typed trigger into configured line-formatting requests and
         * return only changed-line edits.
         */
        provideOnTypeFormattingEdits(document, position, character) {
          if (
            !formatterEnabled(document) ||
            !formatterConfiguration(document).get("onType.enabled", true)
          )
            return []
          const scope = onTypeScope(document, character)
          const lineRequests = onTypeLineRequests(position.line, character, scope)
          const edits = lineRequests
            .map(
              /**
               * Compute each requested line-formatting edit with its continuation
               * alignment policy.
               */ ({ lineNumber, alignBlankContinuationLine }) =>
                lineFormattingEdit(document, lineNumber, {
                  alignBlankContinuationLine,
                }),
            )
            .filter(
              /** Discard line-formatting requests that produced no edit. */ (
                edit,
              ): edit is vscode.TextEdit => Boolean(edit),
            )

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
    vscode.workspace.onDidChangeTextDocument(
      /**
       * Restore pending caret state and schedule eligible Enter continuation edits for
       * the changed document.
       */ (event) => {
        const document = event.document
        const documentKey = document.uri.toString()
        if (pendingCaretRestorations.has(documentKey)) {
          setTimeout(
            /**
             * Restore the caret after the pending format-on-type edits have reached the
             * editor.
             */ () => applyCaretRestoration(documentKey),
            0,
          )
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
          .filter(
            /**
             * Select Enter changes containing only newlines and optional indentation.
             */ (change) => /^(?:\r?\n[ \t]*)+$/.test(change.text),
          )
          .map(
            /** Locate the destination line after each inserted newline sequence. */ (
              change,
            ) => {
              const newlineCount = change.text.match(/\r\n|\n/g)?.length ?? 0
              return change.range.start.line + newlineCount
            },
          )
        if (destinationLines.length === 0) {
          return
        }

        const pending = pendingContinuationLines.get(documentKey) ?? {
          document,
          lineNumbers: new Set<number>(),
          timeout: undefined,
        }
        destinationLines.forEach(
          /**
           * Merge destination lines into the pending continuation-formatting request.
           */ (lineNumber) => pending.lineNumbers.add(lineNumber),
        )
        clearTimeout(pending.timeout)
        pending.timeout = setTimeout(
          /**
           * Apply accumulated continuation indentation edits after the Enter debounce
           * expires.
           */ () => {
            pendingContinuationLines.delete(documentKey)
            const edits = [...pending.lineNumbers]
              .map(
                /** Compute continuation edits for the accumulated affected lines. */ (
                  lineNumber,
                ) => continuationFormattingEdit(pending.document, lineNumber),
              )
              .filter(
                /** Discard continuation lines whose indentation already matches. */ (
                  edit,
                ): edit is vscode.TextEdit => Boolean(edit),
              )
            if (formatterConfiguration(pending.document).get("onType.logging", false)) {
              output.info(
                `Post-Enter continuation indentation on line(s) ${[
                  ...pending.lineNumbers,
                ]
                  .map(
                    /**
                     * Convert pending zero-based continuation lines to display line numbers.
                     */ (line) => line + 1,
                  )
                  .join(", ")}; changed=${edits.length > 0}.`,
              )
            }
            if (edits.length === 0) {
              return
            }

            const workspaceEdit = new vscode.WorkspaceEdit()
            workspaceEdit.set(pending.document.uri, edits)
            applyingContinuationEdits.add(documentKey)
            void Promise.resolve(vscode.workspace.applyEdit(workspaceEdit)).finally(
              /** Release the continuation-edit reentrancy guard on either outcome. */ () =>
                applyingContinuationEdits.delete(documentKey),
            )
          },
          0,
        )
        pendingContinuationLines.set(documentKey, pending)
      },
    ),
    {
      dispose: /**
       * Cancel pending continuation timers and release saved caret restoration state.
       */ () => {
        pendingContinuationLines.forEach(
          /** Cancel each pending continuation-formatting timer. */ (pending) =>
            clearTimeout(pending.timeout),
        )
        pendingCaretRestorations.clear()
      },
    },
  )

  output.info(`${EXTENSION_ID} activated. Document and on-type formatting are ready.`)
}

/**
 * Migrate managed legacy formatter choices into Pascal Atlas without overwriting
 * explicit user settings.
 */
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
