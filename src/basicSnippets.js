'use strict';

const PASCAL_KEYWORD_SNIPPETS = require('../resources/pascal-keywords.code-snippets.json');

const BASIC_SNIPPETS = Object.freeze([
  {
    prefix: 'begin',
    label: 'begin/end block',
    body: 'begin\n\t$0\nend;',
    description: '插入 begin/end 代码块'
  },
  {
    prefix: 'if',
    label: 'if begin/end',
    body: 'if ${1:Condition} then\nbegin\n\t$0\nend;',
    description: '插入带 begin/end 的 if 代码块'
  },
  {
    prefix: 'ifelse',
    label: 'if/else begin/end',
    body: 'if ${1:Condition} then\nbegin\n\t${2}\nend\nelse\nbegin\n\t$0\nend;',
    description: '插入带 begin/end 的 if/else 代码块'
  },
  {
    prefix: 'for',
    label: 'for loop',
    body: 'for ${1:I} := ${2:0} to ${3:Count - 1} do\nbegin\n\t$0\nend;',
    description: '插入带 begin/end 的 for 循环'
  },
  {
    prefix: 'forin',
    label: 'for-in loop',
    body: 'for ${1:Item} in ${2:Items} do\nbegin\n\t$0\nend;',
    description: '插入带 begin/end 的 for-in 循环'
  },
  {
    prefix: 'while',
    label: 'while loop',
    body: 'while ${1:Condition} do\nbegin\n\t$0\nend;',
    description: '插入带 begin/end 的 while 循环'
  },
  {
    prefix: 'tryexcept',
    label: 'try/except block',
    body: 'try\n\t${1}\nexcept\n\t$0\nend;',
    description: '插入 try/except 代码块'
  },
  {
    prefix: 'tryfinally',
    label: 'try/finally block',
    body: 'try\n\t${1}\nfinally\n\t$0\nend;',
    description: '插入 try/finally 代码块'
  },
  {
    prefix: 'case',
    label: 'case/of block',
    body: 'case ${1:Value} of\n\t${2}: $0;\nend;',
    description: '插入 case/of 代码块'
  },
  {
    prefix: 'procedure',
    label: 'procedure body',
    body: 'procedure ${1:ProcedureName}(${2});\nbegin\n\t$0\nend;',
    description: '插入过程及 begin/end 实现'
  },
  {
    prefix: 'function',
    label: 'function body',
    body: 'function ${1:FunctionName}(${2}): ${3:Boolean};\nbegin\n\t$0\nend;',
    description: '插入函数及 begin/end 实现'
  }
]);

const SPACE_TRIGGER_SNIPPETS = new Map([
  ...BASIC_SNIPPETS
    .filter(snippet => [
      'begin', 'if', 'ifelse', 'for', 'forin', 'while',
      'tryexcept', 'tryfinally', 'case'
    ].includes(snippet.prefix))
    .map(snippet => [snippet.prefix, snippet.body]),
  ['repeat', 'repeat\n\t$0\nuntil ${1:Condition};'],
  ['with', 'with ${1:Value} do\nbegin\n\t$0\nend;'],
  ['try', 'try\n\t$0\nexcept\n\t\nend;']
]);
const PASCAL_KEYWORD_PREFIXES = Object.freeze(Object.values(PASCAL_KEYWORD_SNIPPETS)
  .map(snippet => String(snippet.prefix).toLowerCase()));

function matchingBasicSnippets(prefix) {
  const normalized = String(prefix || '').toLowerCase();
  return BASIC_SNIPPETS.filter(snippet => snippet.prefix.startsWith(normalized));
}

function hasNativePascalCompletion(prefix) {
  const normalized = String(prefix || '').toLowerCase();
  if (!normalized) return false;
  return matchingBasicSnippets(normalized).length > 0
    || PASCAL_KEYWORD_PREFIXES.some(keyword => keyword.startsWith(normalized));
}

function spaceTriggeredSnippet(linePrefix) {
  const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*) $/i.exec(String(linePrefix || ''));
  if (!match) return undefined;
  const prefix = match[2].toLowerCase();
  const body = SPACE_TRIGGER_SNIPPETS.get(prefix);
  return body && {
    body,
    endCharacter: match[0].length,
    prefix,
    startCharacter: match[1].length
  };
}

function inlineTriggeredSnippet(linePrefix) {
  const expansion = spaceTriggeredSnippet(`${String(linePrefix || '')} `);
  return expansion && {
    ...expansion,
    endCharacter: expansion.endCharacter - 1
  };
}

function plainSnippetPreview(body) {
  return String(body || '')
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\{\d+\}/g, '')
    .replace(/\$\d+/g, '');
}

function plainControlExpansion(prefix, baseIndent, editorOptions = {}) {
  const configuredTabSize = Number(editorOptions.tabSize);
  const tabSize = Number.isFinite(configuredTabSize) && configuredTabSize > 0
    ? Math.floor(configuredTabSize)
    : 2;
  const indentUnit = editorOptions.insertSpaces === false ? '\t' : ' '.repeat(tabSize);
  const body = SPACE_TRIGGER_SNIPPETS.get(String(prefix || '').toLowerCase());
  if (!body) return undefined;
  const indentedBody = body.split('\n').map((line, index) => {
    const leadingTabs = /^\t*/.exec(line)[0].length;
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
  const selectionColumn = beforeSelection.at(-1).length;
  return {
    selectionCharacter: selectionLineDelta === 0
      ? baseIndent.length + selectionColumn
      : selectionColumn,
    selectionLength: selection.length,
    selectionLineDelta,
    text
  };
}

function completionEnabled(vscode, document) {
  const configuration = vscode.workspace.getConfiguration('pascalUnion', document.uri);
  return configuration.get('enabled', true)
    && configuration.get('completion.enabled', true);
}

async function applyPlainControlExpansion(editor, vscode, expansion, lineNumber, endCharacter) {
  const baseIndent = editor.document.lineAt(lineNumber).text.slice(0, expansion.startCharacter);
  const rendered = plainControlExpansion(expansion.prefix, baseIndent, editor.options);
  const range = new vscode.Range(
    lineNumber,
    expansion.startCharacter,
    lineNumber,
    endCharacter
  );
  const changed = await editor.edit(
    editBuilder => editBuilder.replace(range, rendered.text),
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

function registerImmediateSpaceExpansion(context, vscode) {
  const typeSpace = async () => {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const selection = editor?.selection;
    const canExpand = document
      && ['pascal', 'objectpascal'].includes(document.languageId)
      && editor.selections.length === 1
      && selection.isEmpty
      && completionEnabled(vscode, document);
    const position = selection?.active;
    const expansion = canExpand && position
      ? inlineTriggeredSnippet(document.lineAt(position.line).text.slice(0, position.character))
      : undefined;
    if (!expansion) {
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
    'pascalUnion.completion.typeSpace',
    typeSpace
  );
  context.subscriptions.push(disposable);
  return disposable;
}

function registerSpaceTriggeredSnippetExpansion(context, vscode) {
  const disposable = vscode.workspace.onDidChangeTextDocument(event => {
    if (event.reason !== undefined || event.contentChanges.length !== 1) return;
    const change = event.contentChanges[0];
    if (!change.text.endsWith(' ') || /[\r\n]/.test(change.text)) return;
    const document = event.document;
    if (!['pascal', 'objectpascal'].includes(document.languageId)) return;

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

module.exports = {
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
