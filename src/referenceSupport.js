'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const vscode = require('vscode');
const { inferPascalType, maskPascalNonCode } = require('./binarySymbols');
const {
  descendantTypeDefinitions,
  enclosingRoutineOwner,
  memberImplementationDefinitions,
  routineImplementationDefinitions,
  typeKey
} = require('./implementationCore');
const { normalizeKey } = require('./projectDiscovery');
const {
  automaticInterfaceGuidText,
  findIdentifierOccurrences,
  formatDelphiGuid,
  identifierAt,
  isDelphiInterfaceDeclaration,
  lineStartsFor,
  positionAt
} = require('./referenceCore');

const PASCAL_SELECTOR = [
  { language: 'pascal', scheme: 'file' },
  { language: 'objectpascal', scheme: 'file' }
];

class PascalReferenceSupport {
  constructor(context, projectSourceIndexPromise, output, compiledSymbolSupport) {
    this.context = context;
    this.projectSourceIndexPromise = projectSourceIndexPromise;
    this.output = output;
    this.compiledSymbolSupport = compiledSymbolSupport;
    this.automaticGuidEdits = new Set();
  }

  openDocumentsByPath() {
    return new Map(vscode.workspace.textDocuments
      .filter(document => document.uri.scheme === 'file')
      .map(document => [normalizeKey(document.fileName), document]));
  }

  async sourceFiles(document) {
    const index = await this.projectSourceIndexPromise;
    const files = new Map();
    for (const filePath of index?.files || []) files.set(normalizeKey(filePath), filePath);
    files.set(normalizeKey(document.fileName), document.fileName);
    return [...files.values()];
  }

  declarationLocations(index, identifier) {
    const result = new Set();
    for (const definition of index?.definitions?.get(identifier.toLowerCase()) || []) {
      result.add(`${normalizeKey(definition.filePath)}:${definition.offset}`);
      if (Number.isInteger(definition.implementationOffset)) {
        result.add(`${normalizeKey(definition.filePath)}:${definition.implementationOffset}`);
      }
    }
    return result;
  }

  async findReferences(document, position, cancellationToken, includeDeclaration = true) {
    const selected = identifierAt(document.getText(), document.offsetAt(position));
    if (!selected) return [];
    const index = await this.projectSourceIndexPromise;
    const files = await this.sourceFiles(document);
    const openDocuments = this.openDocumentsByPath();
    const declarations = includeDeclaration
      ? new Set()
      : this.declarationLocations(index, selected.word);
    const locations = [];

    for (let start = 0; start < files.length; start += 24) {
      if (cancellationToken?.isCancellationRequested) return locations;
      const batch = files.slice(start, start + 24);
      const sources = await Promise.all(batch.map(async filePath => {
        const openDocument = openDocuments.get(normalizeKey(filePath));
        if (openDocument) {
          return { filePath: openDocument.fileName, text: openDocument.getText(), document: openDocument };
        }
        try {
          return { filePath, text: await fs.promises.readFile(filePath, 'utf8') };
        } catch (error) {
          this.output.appendLine(`Reference scan skipped ${filePath}: ${error.message}`);
          return undefined;
        }
      }));

      for (const source of sources.filter(Boolean)) {
        const uri = source.document?.uri || vscode.Uri.file(source.filePath);
        const lineStarts = source.document ? undefined : lineStartsFor(source.text);
        for (const occurrence of findIdentifierOccurrences(source.text, selected.word)) {
          if (declarations.has(`${normalizeKey(source.filePath)}:${occurrence.offset}`)) continue;
          const startPosition = source.document
            ? source.document.positionAt(occurrence.offset)
            : positionAt(lineStarts, occurrence.offset);
          const endPosition = source.document
            ? source.document.positionAt(occurrence.offset + occurrence.length)
            : positionAt(lineStarts, occurrence.offset + occurrence.length);
          locations.push(new vscode.Location(uri, new vscode.Range(startPosition, endPosition)));
        }
      }
      await new Promise(resolve => setImmediate(resolve));
    }

    locations.sort((left, right) => left.uri.fsPath.localeCompare(right.uri.fsPath)
      || left.range.start.line - right.range.start.line
      || left.range.start.character - right.range.start.character);
    this.output.appendLine(
      `Found ${locations.length} project reference(s) for ${selected.word} in ${files.length} Pascal file(s).`
    );
    return locations;
  }

  async showReferences() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['pascal', 'objectpascal'].includes(editor.document.languageId)) return;
    const position = editor.selection.active;
    const selected = identifierAt(editor.document.getText(), editor.document.offsetAt(position));
    if (!selected) {
      void vscode.window.showInformationMessage('请把光标放在 Pascal 标识符上。');
      return;
    }
    const locations = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Window,
      title: `正在查找 ${selected.word} 的所有引用…`,
      cancellable: false
    }, () => this.findReferences(editor.document, position, undefined, true));
    if (locations.length === 0) {
      void vscode.window.showInformationMessage(`未找到 ${selected.word} 的引用。`);
      return;
    }
    await vscode.commands.executeCommand(
      'editor.action.showReferences',
      editor.document.uri,
      position,
      locations
    );
  }

  definitionLocation(definition, preferImplementation = false) {
    const useImplementation = preferImplementation
      && Number.isInteger(definition.implementationOffset);
    const line = useImplementation ? definition.implementationLine : definition.line;
    const character = useImplementation
      ? definition.implementationCharacter
      : definition.character;
    const start = new vscode.Position(line, character);
    return new vscode.Location(
      vscode.Uri.file(definition.filePath),
      new vscode.Range(start, start.translate(0, definition.length || definition.symbol.length))
    );
  }

  exactDefinitionAt(index, document, selected) {
    const fileKey = normalizeKey(document.fileName);
    return (index?.definitions?.get(selected.word.toLowerCase()) || []).find(definition =>
      normalizeKey(definition.filePath) === fileKey
      && selected.start >= definition.offset
      && selected.start < definition.offset + definition.length);
  }

  async implementationTarget(document, position, index) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    const selected = identifierAt(text, offset);
    if (!selected) return undefined;
    const exact = this.exactDefinitionAt(index, document, selected);
    if (exact?.owner) {
      return { kind: 'member', name: selected.word, owner: exact.owner };
    }
    if (exact?.kind === 'type') return { kind: 'type', name: exact.symbol };
    if (exact?.kind === 'routine') return { kind: 'routine', name: exact.symbol };

    const sourceMember = await this.compiledSymbolSupport?.sourceMemberAt(document, position);
    if (sourceMember?.typeName) {
      return { kind: 'member', name: selected.word, owner: sourceMember.typeName };
    }

    const code = maskPascalNonCode(text);
    const qualifier = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\.\s*$/.exec(code.slice(0, selected.start))?.[1];
    const qualifiedType = qualifier
      ? inferPascalType(text, qualifier, selected.start, code)
      : undefined;
    if (qualifiedType) return { kind: 'member', name: selected.word, owner: qualifiedType };

    const enclosingOwner = enclosingRoutineOwner(text, selected.start);
    if (enclosingOwner
      && index?.members?.get(typeKey(enclosingOwner))?.has(selected.word.toLowerCase())) {
      return { kind: 'member', name: selected.word, owner: enclosingOwner };
    }
    if (index?.types?.has(selected.word.toLowerCase())) {
      return { kind: 'type', name: selected.word };
    }
    if ((index?.definitions?.get(selected.word.toLowerCase()) || [])
      .some(item => item.kind === 'routine' && !item.owner)) {
      return { kind: 'routine', name: selected.word };
    }
    return undefined;
  }

  async findImplementations(document, position, cancellationToken) {
    const index = await this.projectSourceIndexPromise;
    if (cancellationToken?.isCancellationRequested) return [];
    const target = await this.implementationTarget(document, position, index);
    if (!target) return [];
    let definitions;
    if (target.kind === 'type') {
      definitions = descendantTypeDefinitions(index, target.name);
    } else if (target.kind === 'member') {
      definitions = memberImplementationDefinitions(index, target.owner, target.name);
    } else {
      definitions = routineImplementationDefinitions(index, target.name);
    }
    const preferImplementation = target.kind !== 'type';
    const locations = definitions.map(definition =>
      this.definitionLocation(definition, preferImplementation));
    this.output.appendLine(
      `Found ${locations.length} implementation(s) for ${target.kind} `
      + `${target.owner ? `${target.owner}.` : ''}${target.name}.`
    );
    return locations;
  }

  async showImplementations() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['pascal', 'objectpascal'].includes(editor.document.languageId)) return;
    const position = editor.selection.active;
    const selected = identifierAt(editor.document.getText(), editor.document.offsetAt(position));
    if (!selected) {
      void vscode.window.showInformationMessage('请把光标放在 Pascal 类型或方法上。');
      return;
    }
    const locations = await vscode.window.withProgress({
      location: vscode.ProgressLocation.Window,
      title: `正在查找 ${selected.word} 的所有实现…`,
      cancellable: false
    }, () => this.findImplementations(editor.document, position));
    if (locations.length === 0) {
      void vscode.window.showInformationMessage(`未找到 ${selected.word} 的实现。`);
      return;
    }
    await vscode.commands.executeCommand(
      'editor.action.showReferences',
      editor.document.uri,
      position,
      locations
    );
  }

  async insertGuid() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !['pascal', 'objectpascal'].includes(editor.document.languageId)) return;
    const value = formatDelphiGuid(randomUUID());
    const inserted = await editor.edit(builder => builder.replace(editor.selection, value));
    if (!inserted) void vscode.window.showErrorMessage('无法在当前位置插入 GUID。');
  }

  scheduleAutomaticInterfaceGuid(event) {
    const document = event.document;
    if (!['pascal', 'objectpascal'].includes(document.languageId)
      || !vscode.workspace.getConfiguration('pascalUnion', document.uri)
        .get('completion.interfaceGuid.enabled', true)
      || this.automaticGuidEdits.has(document.uri.toString())
      || event.contentChanges.length !== 1
      || !/\r?\n/.test(event.contentChanges[0].text)) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) return;
    const lineNumber = event.contentChanges[0].range.start.line + 1;
    if (lineNumber <= 0 || lineNumber >= document.lineCount
      || !isDelphiInterfaceDeclaration(document.lineAt(lineNumber - 1).text)
      || document.lineAt(lineNumber).text.trim()) return;

    // Let the Enter on-type formatter finish first. A snippet final tab stop
    // then owns the caret, so formatting cannot leave it on the GUID line.
    setTimeout(async () => {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || activeEditor.document.uri.toString() !== document.uri.toString()
        || activeEditor.selection.active.line !== lineNumber
        || lineNumber >= document.lineCount
        || document.lineAt(lineNumber).text.trim()) return;
      const declarationIndent = /^\s*/.exec(document.lineAt(lineNumber - 1).text)?.[0] || '';
      const indentUnit = activeEditor.options.insertSpaces
        ? ' '.repeat(Number(activeEditor.options.tabSize) || 2)
        : '\t';
      const indentation = declarationIndent + indentUnit;
      const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const insertion = automaticInterfaceGuidText(indentation, eol, randomUUID());
      const key = document.uri.toString();
      this.automaticGuidEdits.add(key);
      try {
        const line = document.lineAt(lineNumber);
        const snippet = new vscode.SnippetString(`${insertion}$0`);
        await activeEditor.insertSnippet(snippet, line.range, {
          undoStopBefore: false,
          undoStopAfter: false
        });
      } finally {
        this.automaticGuidEdits.delete(key);
      }
    }, 25);
  }

  register() {
    this.context.subscriptions.push(
      vscode.languages.registerReferenceProvider(PASCAL_SELECTOR, {
        provideReferences: (document, position, options, token) =>
          this.findReferences(document, position, token, options.includeDeclaration)
      }),
      vscode.languages.registerImplementationProvider(PASCAL_SELECTOR, {
        provideImplementation: (document, position, token) =>
          this.findImplementations(document, position, token)
      }),
      vscode.commands.registerCommand('pascalUnion.insertGuid', () => this.insertGuid()),
      vscode.workspace.onDidChangeTextDocument(event => {
        this.scheduleAutomaticInterfaceGuid(event);
      })
    );
  }
}

module.exports = { PascalReferenceSupport };
