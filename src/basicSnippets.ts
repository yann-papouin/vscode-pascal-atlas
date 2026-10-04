import type { Disposable, TextDocument, TextEditor, TextEditorOptions } from 'vscode';
import { CommandId, ConfigurationSection, LanguageId, SettingKey } from './shared/identifiers';
import { PascalKeyword } from './shared/pascal';
import * as fs from 'node:fs';
import { resourcePath } from './runtimePaths';
import { isRecord } from './shared/guards';
import { ResourcePath } from './shared/identifiers';
const keywordSnippetData: unknown = JSON.parse(fs.readFileSync(resourcePath(ResourcePath.KeywordSnippets), 'utf8'));
const PASCAL_KEYWORD_SNIPPETS = isRecord(keywordSnippetData) ? Object.values(keywordSnippetData).filter((value): value is Record<string, unknown> & { prefix: string } => isRecord(value) && typeof value.prefix === 'string') : [];

const BASIC_SNIPPETS = Object.freeze([
  {
    prefix: PascalKeyword.Begin,
    label: 'begin/end block',
    body: `${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a begin/end block'
  },
  {
    prefix: PascalKeyword.If,
    label: 'if begin/end',
    body: `${PascalKeyword.If} \${1:Condition} ${PascalKeyword.Then}
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert an if block with begin/end'
  },
  {
    prefix: 'ifelse',
    label: 'if/else begin/end',
    body: `${PascalKeyword.If} \${1:Condition} ${PascalKeyword.Then}
${PascalKeyword.Begin}
\t\${2}
${PascalKeyword.End}
${PascalKeyword.Else}
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert an if/else block with begin/end'
  },
  {
    prefix: PascalKeyword.For,
    label: 'for loop',
    body: `${PascalKeyword.For} \${1:I} := \${2:0} ${PascalKeyword.To} \${3:Count - 1} ${PascalKeyword.Do}
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a for loop with begin/end'
  },
  {
    prefix: 'forin',
    label: 'for-in loop',
    body: `${PascalKeyword.For} \${1:Item} ${PascalKeyword.In} \${2:Items} ${PascalKeyword.Do}
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a for-in loop with begin/end'
  },
  {
    prefix: PascalKeyword.While,
    label: 'while loop',
    body: `${PascalKeyword.While} \${1:Condition} ${PascalKeyword.Do}
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a while loop with begin/end'
  },
  {
    prefix: 'tryexcept',
    label: 'try/except block',
    body: `${PascalKeyword.Try}
\t\${1}
${PascalKeyword.Except}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a try/except block'
  },
  {
    prefix: 'tryfinally',
    label: 'try/finally block',
    body: `${PascalKeyword.Try}
\t\${1}
${PascalKeyword.Finally}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a try/finally block'
  },
  {
    prefix: PascalKeyword.Case,
    label: 'case/of block',
    body: `${PascalKeyword.Case} \${1:Value} ${PascalKeyword.Of}
\t\${2}: $0;
${PascalKeyword.End};`,
    description: 'Insert a case/of block'
  },
  {
    prefix: PascalKeyword.Procedure,
    label: 'procedure body',
    body: `${PascalKeyword.Procedure} \${1:ProcedureName}(\${2});
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a procedure with begin/end implementation'
  },
  {
    prefix: PascalKeyword.Function,
    label: 'function body',
    body: `${PascalKeyword.Function} \${1:FunctionName}(\${2}): \${3:Boolean};
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`,
    description: 'Insert a function with begin/end implementation'
  }
]);

const SPACE_TRIGGER_SNIPPETS = new Map<string, string>([
  ...BASIC_SNIPPETS
    .filter(snippet => [
      PascalKeyword.Begin, PascalKeyword.If, 'ifelse', PascalKeyword.For, 'forin', PascalKeyword.While,
      'tryexcept', 'tryfinally', PascalKeyword.Case
    ].includes(snippet.prefix))
    .map(snippet => [snippet.prefix, snippet.body] as const),
  [PascalKeyword.Repeat, `${PascalKeyword.Repeat}
\t$0
${PascalKeyword.Until} \${1:Condition};`],
  [PascalKeyword.With, `${PascalKeyword.With} \${1:Value} ${PascalKeyword.Do}
${PascalKeyword.Begin}
\t$0
${PascalKeyword.End};`],
  [PascalKeyword.Try, `${PascalKeyword.Try}
\t$0
${PascalKeyword.Except}
\t
${PascalKeyword.End};`]
]);
const PASCAL_KEYWORD_PREFIXES = Object.freeze(Object.values(PASCAL_KEYWORD_SNIPPETS)
  .map(snippet => String(snippet.prefix).toLowerCase()));

function matchingBasicSnippets(prefix: string) {
  const normalized = String(prefix || '').toLowerCase();
  return BASIC_SNIPPETS.filter(snippet => snippet.prefix.startsWith(normalized));
}

function hasNativePascalCompletion(prefix: unknown) {
  const normalized = String(prefix || '').toLowerCase();
  if (!normalized) return false;
  return matchingBasicSnippets(normalized).length > 0
    || PASCAL_KEYWORD_PREFIXES.some(keyword => keyword.startsWith(normalized));
}

function spaceTriggeredSnippet(linePrefix: string) {
  const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*) $/i.exec(String(linePrefix || ''));
  if (!match) return undefined;
  const prefix = match[2].toLowerCase();
  const body = SPACE_TRIGGER_SNIPPETS.get(prefix);
  return body ? {
    body,
    endCharacter: match[0].length,
    prefix,
    startCharacter: match[1].length
  } : undefined;
}

function inlineTriggeredSnippet(linePrefix: unknown) {
  const expansion = spaceTriggeredSnippet(`${String(linePrefix || '')} `);
  return expansion && {
    ...expansion,
    endCharacter: expansion.endCharacter - 1
  };
}

function plainSnippetPreview(body: unknown) {
  return String(body || '')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '');
}

function plainControlExpansion(prefix: unknown, baseIndent: string, editorOptions: TextEditorOptions = {}) {
  const configuredTabSize = Number(editorOptions.tabSize);
  const tabSize = Number.isFinite(configuredTabSize) && configuredTabSize > 0
    ? Math.floor(configuredTabSize)
    : 2;
  const indentUnit = editorOptions.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
  const body = SPACE_TRIGGER_SNIPPETS.get(String(prefix || '').toLowerCase());
  if (!body) return undefined;
  const indentedBody = body.split('\n').map((line, index) => {
    const leadingTabs = /^\t*/.exec(line)?.[0].length || 0;
    const content = line.slice(leadingTabs);
    if (index === 0) return content;
    return `${baseIndent}${indentUnit.repeat(leadingTabs)}${content}`;
  }).join('\n');
  const placeholders = [];
  let text = '';
  let cursor = 0;
  const placeholderPattern = /\$\{(\d+)(?::([^}]*))?\}|\$(\d+)/g;
  for (const match of indentedBody.matchAll(placeholderPattern)) {
    text += indentedBody.slice(cursor, match.index);
    const value = match[2] || '';
    placeholders.push({
      id: Number(match[1] ?? match[3]),
      offset: text.length,
      length: value.length
    });
    text += value;
    cursor = match.index + match[0].length;
  }
  text += indentedBody.slice(cursor);
  const selection = placeholders.sort((left, right) => {
    const leftRank = left.id === 0 ? Number.MAX_SAFE_INTEGER : left.id;
    const rightRank = right.id === 0 ? Number.MAX_SAFE_INTEGER : right.id;
    return leftRank - rightRank;
  })[0] || { offset: text.length, length: 0 };
  const beforeSelection = text.slice(0, selection.offset).split('\n');
  const selectionLineDelta = beforeSelection.length - 1;
  const selectionColumn = (beforeSelection.at(-1) || "").length;
  return {
    selectionCharacter: selectionLineDelta === 0
      ? baseIndent.length + selectionColumn
      : selectionColumn,
    selectionLength: selection.length,
    selectionLineDelta,
    text
  };
}

function completionEnabled(vscode: Pick<typeof import("vscode"), "workspace">, document: Pick<TextDocument, "uri">) {
  const configuration = vscode.workspace.getConfiguration(ConfigurationSection, document.uri);
  return configuration.get(SettingKey.Enabled, true)
    && configuration.get(SettingKey.CompletionEnabled, true);
}

async function applyPlainControlExpansion(editor: TextEditor, vscode: Pick<typeof import("vscode"), "Range" | "Position" | "Selection">, expansion: NonNullable<ReturnType<typeof spaceTriggeredSnippet>>, lineNumber: number, endCharacter: number) {
  const baseIndent = editor.document.lineAt(lineNumber).text.slice(0, expansion.startCharacter);
  const rendered = plainControlExpansion(expansion.prefix, baseIndent, editor.options);
  if (!rendered) return false;
  const range = new vscode.Range(
    lineNumber,
    expansion.startCharacter,
    lineNumber,
    endCharacter
  );
  const changed = await editor.edit(
(    editBuilder) => editBuilder.replace(range, rendered.text),
    { undoStopBefore: true, undoStopAfter: true }
  );
  if (!changed) return false;
  const selectionStart = new vscode.Position(
    lineNumber + rendered.selectionLineDelta,
    rendered.selectionCharacter
  );
  const selectionEnd = selectionStart.translate(0, rendered.selectionLength);
  editor.selection = new vscode.Selection(selectionStart, selectionEnd);
  return true;
}

function registerImmediateSpaceExpansion(context: { subscriptions: Disposable[] }, vscode: typeof import("vscode")) {
  const typeSpace = async () => {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const selection = editor?.selection;
    const canExpand = editor && selection && document
      && ([LanguageId.Pascal, LanguageId.ObjectPascal] as readonly string[]).includes(document.languageId)
      && editor.selections.length === 1
      && selection.isEmpty
      && completionEnabled(vscode, document);
    const position = selection?.active;
    const expansion = canExpand && position
      ? inlineTriggeredSnippet(document.lineAt(position.line).text.slice(0, position.character))
      : undefined;
    if (!expansion || !editor || !position) {
      return vscode.commands.executeCommand('default:type', { text: ' ' });
    }
    return applyPlainControlExpansion(
      editor,
      vscode,
      expansion,
      position.line,
      expansion.endCharacter
    );
  };
  const disposable = vscode.commands.registerCommand(
    CommandId.CompletionTypeSpace,
    typeSpace
  );
  context.subscriptions.push(disposable);
  return disposable;
}

function registerSpaceTriggeredSnippetExpansion(context: { subscriptions: Disposable[] }, vscode: typeof import("vscode")) {
  const disposable = vscode.workspace.onDidChangeTextDocument((event) => {
    if (event.reason !== undefined || event.contentChanges.length !== 1) return;
    const change = event.contentChanges[0];
    if (!change.text.endsWith(' ') || /[\r\n]/.test(change.text)) return;
    const document = event.document;
    if (!([LanguageId.Pascal, LanguageId.ObjectPascal] as readonly string[]).includes(document.languageId)) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== document.uri.toString()) return;
    if (!completionEnabled(vscode, document)) return;

    const lineNumber = change.range.start.line;
    const endCharacter = change.range.start.character + change.text.length;
    const expansion = spaceTriggeredSnippet(
      document.lineAt(lineNumber).text.slice(0, endCharacter)
    );
    if (!expansion) return;

    void applyPlainControlExpansion(
      editor,
      vscode,
      expansion,
      lineNumber,
      expansion.endCharacter
    );
  });
  context.subscriptions.push(disposable);
  return disposable;
}

export {
  BASIC_SNIPPETS,
  PASCAL_KEYWORD_PREFIXES,
  SPACE_TRIGGER_SNIPPETS,
  applyPlainControlExpansion,
  hasNativePascalCompletion,
  inlineTriggeredSnippet,
  matchingBasicSnippets,
  plainControlExpansion,
  plainSnippetPreview,
  registerImmediateSpaceExpansion,
  registerSpaceTriggeredSnippetExpansion,
  spaceTriggeredSnippet
};
