import { UriScheme } from "./shared/identifiers"
import type { SourceIndex, SourceDefinition } from "./shared/models"
import { isInteger, errorMessage } from "./shared/guards"
import { PascalKeyword } from "./shared/pascal"
import {
  CommandId,
  ConfigurationSection,
  LanguageId,
  SettingKey,
} from "./shared/identifiers"
import * as fs from "node:fs"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"
import { inferPascalType, maskPascalNonCode } from "./binarySymbols"
import {
  descendantTypeDefinitions,
  enclosingRoutineOwner,
  memberImplementationDefinitions,
  routineImplementationDefinitions,
  typeKey,
} from "./implementationCore"
import { normalizeKey } from "./projectDiscovery"
import {
  automaticInterfaceGuidText,
  findIdentifierOccurrences,
  formatDelphiGuid,
  identifierAt,
  isDelphiInterfaceDeclaration,
  lineStartsFor,
  positionAt,
} from "./referenceCore"

const PASCAL_SELECTOR = [
  { language: LanguageId.Pascal, scheme: UriScheme.File },
  { language: LanguageId.ObjectPascal, scheme: UriScheme.File },
]

interface ReferenceCompiledSupport {
  /**
   * Resolve the caret's source member and expose its receiver type when available for
   * implementation lookup.
   */
  sourceMemberAt(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<{ typeName?: string } | undefined>
}
type ImplementationTarget =
  | { kind: "member"; name: string; owner: string }
  | { kind: "type" | "routine"; name: string; owner?: undefined }
class PascalReferenceSupport {
  context
  projectSourceIndexPromise
  output
  compiledSymbolSupport
  automaticGuidEdits

  /**
   * Create source-reference and implementation support using the shared project-index
   * promise and optional compiled-member resolution.
   */
  constructor(
    context: Pick<vscode.ExtensionContext, "subscriptions">,
    projectSourceIndexPromise: Promise<SourceIndex>,
    output: vscode.OutputChannel,
    compiledSymbolSupport?: ReferenceCompiledSupport,
  ) {
    this.context = context
    this.projectSourceIndexPromise = projectSourceIndexPromise
    this.output = output
    this.compiledSymbolSupport = compiledSymbolSupport
    this.automaticGuidEdits = new Set<string>()
  }

  /**
   * Index open file documents by canonical path so scans prefer unsaved editor text
   * over disk contents.
   */
  openDocumentsByPath() {
    return new Map(
      vscode.workspace.textDocuments
        .filter(
          /**
           * Include only file-backed documents when preferring unsaved source over disk
           * reads.
           */ (document) => document.uri.scheme === UriScheme.File,
        )
        .map(
          /** Key open documents by canonical filesystem path. */ (document) => [
            normalizeKey(document.fileName),
            document,
          ],
        ),
    )
  }

  /**
   * Combine indexed Pascal files with the current document and remove canonical path
   * duplicates.
   */
  async sourceFiles(document: Pick<vscode.TextDocument, "fileName">) {
    const index = await this.projectSourceIndexPromise
    const files = new Map<string, string>()
    for (const filePath of index?.files || [])
      files.set(normalizeKey(filePath), filePath)
    files.set(normalizeKey(document.fileName), document.fileName)
    return [...files.values()]
  }

  /**
   * Collect declaration and implementation offset keys used to exclude declaration
   * occurrences from a reference scan.
   */
  declarationLocations(index: SourceIndex, identifier: string) {
    const result = new Set<string>()
    for (const definition of index?.definitions?.get(identifier.toLowerCase()) || []) {
      result.add(`${normalizeKey(definition.filePath)}:${definition.offset}`)
      if (isInteger(definition.implementationOffset)) {
        result.add(
          `${normalizeKey(definition.filePath)}:${definition.implementationOffset}`,
        )
      }
    }
    return result
  }

  /**
   * Scan masked source in bounded batches, honoring cancellation and unsaved
   * documents, then return deterministic whole-identifier reference locations.
   */
  async findReferences(
    document: vscode.TextDocument,
    position: vscode.Position,
    cancellationToken: vscode.CancellationToken | undefined,
    includeDeclaration = true,
  ) {
    const selected = identifierAt(document.getText(), document.offsetAt(position))
    if (!selected) return []
    const index = await this.projectSourceIndexPromise
    const files = await this.sourceFiles(document)
    // Open documents take precedence over disk reads so references include current unsaved edits.
    const openDocuments = this.openDocumentsByPath()
    const declarations = includeDeclaration
      ? new Set()
      : this.declarationLocations(index, selected.word)
    const locations = []

    // Bound file reads and yield between batches to keep reference scans cancellable and the extension host responsive.
    for (let start = 0; start < files.length; start += 24) {
      if (cancellationToken?.isCancellationRequested) return locations
      const batch = files.slice(start, start + 24)
      const sources = await Promise.all(
        batch.map(
          /**
           * Read each reference-scan input from its open document when available,
           * otherwise from disk.
           */ async (filePath) => {
            const openDocument = openDocuments.get(normalizeKey(filePath))
            if (openDocument) {
              return {
                filePath: openDocument.fileName,
                text: openDocument.getText(),
                document: openDocument,
              }
            }
            try {
              return { filePath, text: await fs.promises.readFile(filePath, "utf8") }
            } catch (error) {
              this.output.appendLine(
                `Reference scan skipped ${filePath}: ${errorMessage(error)}`,
              )
              return undefined
            }
          },
        ),
      )

      for (const source of sources) {
        if (!source) continue
        const uri = source.document?.uri || vscode.Uri.file(source.filePath)
        const lineStarts = source.document ? undefined : lineStartsFor(source.text)
        for (const occurrence of findIdentifierOccurrences(
          source.text,
          selected.word,
        )) {
          if (declarations.has(`${normalizeKey(source.filePath)}:${occurrence.offset}`))
            continue
          const startPosition = source.document
            ? source.document.positionAt(occurrence.offset)
            : /**
               * Convert the occurrence start offset to a VS Code position using cached
               * line starts.
               */ (() => {
                const result = positionAt(lineStarts || [], occurrence.offset)
                return new vscode.Position(result.line, result.character)
              })()
          const endPosition = source.document
            ? source.document.positionAt(occurrence.offset + occurrence.length)
            : /**
               * Convert the occurrence end offset to a VS Code position using cached
               * line starts.
               */ (() => {
                const result = positionAt(
                  lineStarts || [],
                  occurrence.offset + occurrence.length,
                )
                return new vscode.Position(result.line, result.character)
              })()
          locations.push(
            new vscode.Location(uri, new vscode.Range(startPosition, endPosition)),
          )
        }
      }
      await new Promise(
        /** Resolve after yielding once to the extension-host event loop. */ (
          resolve,
        ) => setImmediate(resolve),
      )
    }

    locations.sort(
      /** Order reference locations by file path, then source line and character. */ (
        left,
        right,
      ) =>
        left.uri.fsPath.localeCompare(right.uri.fsPath) ||
        left.range.start.line - right.range.start.line ||
        left.range.start.character - right.range.start.character,
    )
    this.output.appendLine(
      `Found ${locations.length} project reference(s) for ${selected.word} in ${files.length} Pascal file(s).`,
    )
    return locations
  }

  /**
   * Resolve references for the active Pascal identifier with progress reporting and
   * open VS Code's reference UI.
   */
  async showReferences() {
    const editor = vscode.window.activeTextEditor
    if (
      !editor ||
      !new Set<string>([LanguageId.Pascal, LanguageId.ObjectPascal]).has(
        editor.document.languageId,
      )
    )
      return
    const position = editor.selection.active
    const selected = identifierAt(
      editor.document.getText(),
      editor.document.offsetAt(position),
    )
    if (!selected) {
      void vscode.window.showInformationMessage(
        "Place the cursor on a Pascal identifier.",
      )
      return
    }
    const locations = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Finding all references to ${selected.word}…`,
        cancellable: false,
      },
      /**
       * Find references for the captured editor position, including its declaration.
       */ () => this.findReferences(editor.document, position, undefined, true),
    )
    if (locations.length === 0) {
      void vscode.window.showInformationMessage(
        `No references found for ${selected.word}.`,
      )
      return
    }
    await vscode.commands.executeCommand(
      "editor.action.showReferences",
      editor.document.uri,
      position,
      locations,
    )
  }

  /**
   * Convert source metadata to a VS Code location, optionally preferring
   * implementation coordinates with declaration fallbacks.
   */
  definitionLocation(definition: SourceDefinition, preferImplementation = false) {
    const useImplementation =
      preferImplementation && isInteger(definition.implementationOffset)
    const line = useImplementation
      ? (definition.implementationLine ?? definition.line)
      : definition.line
    const character = useImplementation
      ? (definition.implementationCharacter ?? definition.character)
      : definition.character
    const start = new vscode.Position(line, character)
    return new vscode.Location(
      vscode.Uri.file(definition.filePath),
      new vscode.Range(
        start,
        start.translate(0, definition.length || definition.symbol.length),
      ),
    )
  }

  /**
   * Find a declaration of the selected identifier at the same canonical file path and
   * token span.
   */
  exactDefinitionAt(
    index: SourceIndex,
    document: Pick<vscode.TextDocument, "fileName">,
    selected: { word: string; start: number; end?: number },
  ) {
    const fileKey = normalizeKey(document.fileName)
    return (index?.definitions?.get(selected.word.toLowerCase()) || []).find(
      /**
       * Find the definition whose canonical file and identifier span contain the
       * selected token.
       */ (definition) =>
        normalizeKey(definition.filePath) === fileKey &&
        selected.start >= definition.offset &&
        selected.start < definition.offset + definition.length,
    )
  }

  /**
   * Classify the selected symbol as a member, type, or global routine using exact
   * declarations, receiver inference, and enclosing-owner fallbacks.
   */
  async implementationTarget(
    document: vscode.TextDocument,
    position: vscode.Position,
    index: SourceIndex,
  ): Promise<ImplementationTarget | undefined> {
    const text = document.getText()
    const offset = document.offsetAt(position)
    const selected = identifierAt(text, offset)
    if (!selected) return undefined
    const exact = this.exactDefinitionAt(index, document, selected)
    if (exact?.owner) {
      return { kind: "member", name: selected.word, owner: exact.owner }
    }
    if (exact?.kind === PascalKeyword.Type)
      return { kind: PascalKeyword.Type, name: exact.symbol }
    if (exact?.kind === "routine") return { kind: "routine", name: exact.symbol }

    const sourceMember = await this.compiledSymbolSupport?.sourceMemberAt(
      document,
      position,
    )
    if (sourceMember?.typeName) {
      return { kind: "member", name: selected.word, owner: sourceMember.typeName }
    }

    const code = maskPascalNonCode(text)
    const qualifier = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(
      code.slice(0, selected.start),
    )?.[1]
    const qualifiedType = qualifier
      ? inferPascalType(text, qualifier, selected.start, code)
      : undefined
    if (qualifiedType)
      return { kind: "member", name: selected.word, owner: qualifiedType }

    const enclosingOwner = enclosingRoutineOwner(text, selected.start)
    if (
      enclosingOwner &&
      index?.members?.get(typeKey(enclosingOwner))?.has(selected.word.toLowerCase())
    ) {
      return { kind: "member", name: selected.word, owner: enclosingOwner }
    }
    if (index?.types?.has(selected.word.toLowerCase())) {
      return { kind: PascalKeyword.Type, name: selected.word }
    }
    if (
      (index?.definitions?.get(selected.word.toLowerCase()) || []).some(
        /** Recognize a global routine when no type owner is available. */ (item) =>
          item.kind === "routine" && !item.owner,
      )
    ) {
      return { kind: "routine", name: selected.word }
    }
    return undefined
  }

  /**
   * Resolve descendant types or matching member/global routine bodies for the selected
   * symbol, honoring cancellation before lookup.
   */
  async findImplementations(
    document: vscode.TextDocument,
    position: vscode.Position,
    cancellationToken?: vscode.CancellationToken,
  ) {
    const index = await this.projectSourceIndexPromise
    if (cancellationToken?.isCancellationRequested) return []
    const target = await this.implementationTarget(document, position, index)
    if (!target) return []
    let definitions
    if (target.kind === PascalKeyword.Type) {
      definitions = descendantTypeDefinitions(index, target.name)
    } else if (target.kind === "member") {
      definitions = memberImplementationDefinitions(index, target.owner, target.name)
    } else {
      definitions = routineImplementationDefinitions(index, target.name)
    }
    const preferImplementation = target.kind !== PascalKeyword.Type
    const locations = definitions.map(
      /** Convert each implementation candidate into a navigable source location. */ (
        definition,
      ) => this.definitionLocation(definition, preferImplementation),
    )
    this.output.appendLine(
      `Found ${locations.length} implementation(s) for ${target.kind} ` +
        `${target.owner ? `${target.owner}.` : ""}${target.name}.`,
    )
    return locations
  }

  /**
   * Find implementations for the active Pascal symbol and display their locations
   * through VS Code's reference UI.
   */
  async showImplementations() {
    const editor = vscode.window.activeTextEditor
    if (
      !editor ||
      !new Set<string>([LanguageId.Pascal, LanguageId.ObjectPascal]).has(
        editor.document.languageId,
      )
    )
      return
    const position = editor.selection.active
    const selected = identifierAt(
      editor.document.getText(),
      editor.document.offsetAt(position),
    )
    if (!selected) {
      void vscode.window.showInformationMessage(
        "Place the cursor on a Pascal type or method.",
      )
      return
    }
    const locations = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Finding all implementations of ${selected.word}…`,
        cancellable: false,
      },
      /** Find implementations for the captured editor position. */ () =>
        this.findImplementations(editor.document, position),
    )
    if (locations.length === 0) {
      void vscode.window.showInformationMessage(
        `No implementations found for ${selected.word}.`,
      )
      return
    }
    await vscode.commands.executeCommand(
      "editor.action.showReferences",
      editor.document.uri,
      position,
      locations,
    )
  }

  /**
   * Replace the active Pascal editor selection with a newly generated Delphi-format
   * GUID and report rejected edits.
   */
  async insertGuid() {
    const editor = vscode.window.activeTextEditor
    if (
      !editor ||
      !new Set<string>([LanguageId.Pascal, LanguageId.ObjectPascal]).has(
        editor.document.languageId,
      )
    )
      return
    const value = formatDelphiGuid(randomUUID())
    if (!value) return
    const inserted = await editor.edit(
      /** Replace the current selection with the generated interface GUID. */ (
        builder,
      ) => builder.replace(editor.selection, value),
    )
    if (!inserted)
      void vscode.window.showErrorMessage(
        "Could not insert a GUID at the current position.",
      )
  }

  /**
   * Detect an isolated newline after a Delphi interface heading and queue a guarded
   * GUID attribute insertion after on-type formatting settles.
   */
  scheduleAutomaticInterfaceGuid(event: vscode.TextDocumentChangeEvent) {
    const document = event.document
    if (
      !new Set<string>([LanguageId.Pascal, LanguageId.ObjectPascal]).has(
        document.languageId,
      ) ||
      !vscode.workspace
        .getConfiguration(ConfigurationSection, document.uri)
        .get(SettingKey.CompletionInterfaceGuidEnabled, true) ||
      this.automaticGuidEdits.has(document.uri.toString()) ||
      event.contentChanges.length !== 1 ||
      !/\r?\n/.test(event.contentChanges[0].text)
    )
      return
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) return
    const lineNumber = event.contentChanges[0].range.start.line + 1
    if (
      lineNumber <= 0 ||
      lineNumber >= document.lineCount ||
      !isDelphiInterfaceDeclaration(document.lineAt(lineNumber - 1).text) ||
      document.lineAt(lineNumber).text.trim()
    )
      return

    // Let the Enter on-type formatter finish first. A snippet final tab stop
    // then owns the caret, so formatting cannot leave it on the GUID line.
    setTimeout(
      /**
       * Insert the interface GUID only if the captured document, caret, and empty line
       * remain unchanged.
       */ async () => {
        const activeEditor = vscode.window.activeTextEditor
        if (
          !activeEditor ||
          activeEditor.document.uri.toString() !== document.uri.toString() ||
          activeEditor.selection.active.line !== lineNumber ||
          lineNumber >= document.lineCount ||
          document.lineAt(lineNumber).text.trim()
        )
          return
        const declarationIndent =
          /^\s*/.exec(document.lineAt(lineNumber - 1).text)?.[0] || ""
        const indentUnit = activeEditor.options.insertSpaces
          ? " ".repeat(Number(activeEditor.options.tabSize) || 2)
          : "\t"
        const indentation = declarationIndent + indentUnit
        const eol = document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
        const insertion = automaticInterfaceGuidText(indentation, eol, randomUUID())
        const key = document.uri.toString()
        this.automaticGuidEdits.add(key)
        try {
          const line = document.lineAt(lineNumber)
          const snippet = new vscode.SnippetString(`${insertion}$0`)
          await activeEditor.insertSnippet(snippet, line.range, {
            undoStopBefore: false,
            undoStopAfter: false,
          })
        } finally {
          this.automaticGuidEdits.delete(key)
        }
      },
      25,
    )
  }

  /**
   * Register reference/implementation providers, their commands, GUID insertion, and
   * the document-change listener with the extension lifecycle.
   */
  register() {
    this.context.subscriptions.push(
      vscode.languages.registerReferenceProvider(PASCAL_SELECTOR, {
        provideReferences: /**
         * Delegate reference requests while preserving cancellation and declaration
         * inclusion.
         */ (document, position, options, token) =>
          this.findReferences(document, position, token, options.includeDeclaration),
      }),
      vscode.languages.registerImplementationProvider(PASCAL_SELECTOR, {
        provideImplementation: /**
         * Delegate implementation requests while preserving their cancellation token.
         */ (document, position, token) =>
          this.findImplementations(document, position, token),
      }),
      vscode.commands.registerCommand(
        CommandId.InsertGuid,
        /** Insert a newly generated Delphi GUID at the active selection. */ () =>
          this.insertGuid(),
      ),
      vscode.workspace.onDidChangeTextDocument(
        /**
         * Check whether this document edit should trigger automatic interface GUID
         * insertion.
         */ (event) => {
          this.scheduleAutomaticInterfaceGuid(event)
        },
      ),
    )
  }
}

export { PascalReferenceSupport }
