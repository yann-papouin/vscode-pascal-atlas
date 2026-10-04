'use strict';

const { maskPascalNonCode } = require('./binarySymbols');

const PASCAL_LANGUAGE_IDS = new Set(['pascal', 'objectpascal', 'pascal-atlas-platform']);
const BRACKET_COLOR_COUNT = 6;

const PASCAL_INDENTATION_RULES = Object.freeze({
  increaseIndentPattern: /(?:\bbegin\b|\btry\b|\brepeat\b)\s*(?:;?\s*(?:\/\/.*)?)$|^\s*case\b.*\bof\b\s*(?:\/\/.*)?$|^\s*(?:[\w.<>]+\s*=\s*)?(?:class|record|object|interface|dispinterface)\b.*$|^\s*(?:strict\s+)?(?:private|protected|public|published)\s*$/i,
  decreaseIndentPattern: /^\s*(?:end\b|until\b|except\b|finally\b|else\b|(?:strict\s+)?(?:private|protected|public|published)\b)/i,
  indentNextLinePattern: /^\s*(?:(?:if|for|while|with)\b.*\b(?:then|do)\b|else\b|except\b|finally\b)\s*(?:\/\/.*)?$/i,
  unIndentedLinePattern: /^\s*(?:program|unit|library|package)\b/i
});

const BLOCK_START_PATTERN = /(?:\bbegin\b|\btry\b|\brepeat\b)\s*(?:;?\s*(?:\/\/.*)?)$|^\s*case\b.*\bof\b\s*(?:\/\/.*)?$|^\s*(?:[\w.<>]+\s*=\s*)?(?:class|record|object|interface|dispinterface)\b.*$/i;
const SINGLE_STATEMENT_PATTERN = /^\s*(?:(?:if|for|while|with)\b.*\b(?:then|do)\b|else\b|except\b|finally\b|(?:strict\s+)?(?:private|protected|public|published)\b)\s*(?:\/\/.*)?$/i;

function languageConfiguration(vscode) {
  return {
    comments: {
      lineComment: '//',
      blockComment: ['{', '}']
    },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    // Angle brackets are deliberately handled by the Pascal-aware collector
    // below. Registering them here would make VS Code pair comparison operators
    // such as `A < B` because the base Pascal grammar gives both forms the same
    // operator scope.
    colorizedBracketPairs: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: "'", close: "'", notIn: ['string', 'comment'] }
    ],
    surroundingPairs: [['{', '}'], ['[', ']'], ['(', ')'], ["'", "'"]],
    indentationRules: PASCAL_INDENTATION_RULES,
    onEnterRules: [
      {
        beforeText: /\bbegin\s*$/i,
        afterText: /^\s*end\b/i,
        action: { indentAction: vscode.IndentAction.IndentOutdent }
      },
      {
        beforeText: BLOCK_START_PATTERN,
        action: { indentAction: vscode.IndentAction.Indent }
      },
      {
        beforeText: SINGLE_STATEMENT_PATTERN,
        action: { indentAction: vscode.IndentAction.Indent }
      }
    ]
  };
}

function previousIdentifier(code, offset) {
  let cursor = offset - 1;
  if (cursor < 0 || !/[A-Za-z0-9_]/.test(code[cursor])) return undefined;
  const end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_]/.test(code[cursor])) cursor -= 1;
  return { name: code.slice(cursor + 1, end), start: cursor + 1 };
}

function nextNonWhitespace(code, offset) {
  let cursor = offset;
  while (cursor < code.length && /\s/.test(code[cursor])) cursor += 1;
  return cursor;
}

function genericCloseOffset(code, openOffset) {
  let depth = 0;
  for (let cursor = openOffset; cursor < code.length; cursor += 1) {
    const character = code[cursor];
    if (character === '<') depth += 1;
    else if (character === '>') {
      depth -= 1;
      if (depth === 0) return cursor;
    } else if (depth === 1 && character === ';') {
      // Never let an unmatched comparison consume following statements.
      return -1;
    }
  }
  return -1;
}

function looksLikePascalGeneric(code, openOffset, closeOffset, prefix) {
  const body = code.slice(openOffset + 1, closeOffset);
  if (!/[A-Za-z_]/.test(body)) return false;
  if (!/^[A-Za-z0-9_.,:\s<>^\[\]&]+$/.test(body)) return false;
  if (/\b(?:and|or|xor|then|do|begin|end)\b/i.test(body)) return false;

  const after = nextNonWhitespace(code, closeOffset + 1);
  const afterCharacter = code[after] || '';
  // `>=` is a relational operator, not the end of generic arguments. A generic
  // declaration uses whitespace before its following equals sign.
  if (after === closeOffset + 1 && afterCharacter === '=') return false;

  let before = prefix.start - 1;
  while (before >= 0 && /\s/.test(code[before])) before -= 1;
  const typeContext = before < 0 || /[:=(,\[>]/.test(code[before]);
  const conventionalTypeName = /^[TIP][A-Za-z0-9_]+$/.test(prefix.name);
  const genericCall = afterCharacter === '(';
  if (!typeContext && !conventionalTypeName && !genericCall) return false;

  return after >= code.length || /[.\[(,;):=^>]/.test(afterCharacter);
}

/**
 * Returns both characters of every confirmed Delphi generic angle pair. The
 * depth is relative only to other angle pairs so it behaves like VS Code's
 * independent color pool and cannot be shifted by surrounding calls/indexers.
 */
function collectPascalGenericAngleBrackets(text, preparedCode) {
  const code = preparedCode || maskPascalNonCode(text);
  const result = [];
  for (let openOffset = 0; openOffset < code.length; openOffset += 1) {
    if (code[openOffset] !== '<') continue;
    const prefix = previousIdentifier(code, openOffset);
    if (!prefix) continue;
    const closeOffset = genericCloseOffset(code, openOffset);
    if (closeOffset < 0 || !looksLikePascalGeneric(code, openOffset, closeOffset, prefix)) continue;

    const stack = [];
    for (let cursor = openOffset; cursor <= closeOffset; cursor += 1) {
      if (code[cursor] === '<') {
        stack.push({ offset: cursor, depth: stack.length });
      } else if (code[cursor] === '>' && stack.length > 0) {
        const opening = stack.pop();
        result.push(opening, { offset: cursor, depth: opening.depth });
      }
    }
    openOffset = closeOffset;
  }
  return result.sort((left, right) => left.offset - right.offset);
}

function registerPascalGenericBracketColoring(context, vscode) {
  const decorations = Array.from({ length: BRACKET_COLOR_COUNT }, (_, index) =>
    vscode.window.createTextEditorDecorationType({
      color: new vscode.ThemeColor(`editorBracketHighlight.foreground${index + 1}`)
    }));
  const timers = new Map();

  const clear = (editor) => decorations.forEach(decoration => editor.setDecorations(decoration, []));
  const refresh = (editor) => {
    if (!editor || !PASCAL_LANGUAGE_IDS.has(editor.document.languageId)) return;
    const bracketColoringEnabled = vscode.workspace.getConfiguration('editor', editor.document.uri)
      .get('bracketPairColorization.enabled', true);
    const paEnabled = vscode.workspace.getConfiguration('pascalAtlas', editor.document.uri)
      .get('enabled', true);
    if (!bracketColoringEnabled || !paEnabled) {
      clear(editor);
      return;
    }
    const buckets = Array.from({ length: BRACKET_COLOR_COUNT }, () => []);
    for (const bracket of collectPascalGenericAngleBrackets(editor.document.getText())) {
      const start = editor.document.positionAt(bracket.offset);
      buckets[bracket.depth % BRACKET_COLOR_COUNT].push(new vscode.Range(
        start,
        start.translate(0, 1)
      ));
    }
    decorations.forEach((decoration, index) => editor.setDecorations(decoration, buckets[index]));
  };
  const schedule = (editor, delay = 30) => {
    if (!editor || !PASCAL_LANGUAGE_IDS.has(editor.document.languageId)) return;
    const key = editor.document.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      const live = vscode.window.visibleTextEditors.find(candidate =>
        candidate.document.uri.toString() === key);
      if (live) refresh(live);
    }, delay));
  };

  context.subscriptions.push(
    ...decorations,
    vscode.window.onDidChangeVisibleTextEditors(editors => editors.forEach(editor => schedule(editor, 0))),
    vscode.window.onDidChangeActiveTextEditor(editor => schedule(editor, 0)),
    vscode.workspace.onDidChangeTextDocument(event => {
      const editor = vscode.window.visibleTextEditors.find(candidate =>
        candidate.document === event.document);
      if (editor) schedule(editor);
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (!event.affectsConfiguration('editor.bracketPairColorization')
        && !event.affectsConfiguration('pascalAtlas.enabled')) return;
      vscode.window.visibleTextEditors.forEach(editor => schedule(editor, 0));
    }),
    {
      dispose() {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear();
      }
    }
  );
  vscode.window.visibleTextEditors.forEach(editor => schedule(editor, 0));
}

function registerPascalLanguageConfiguration(context, vscode) {
  for (const language of ['pascal', 'objectpascal', 'pascal-atlas-platform']) {
    context.subscriptions.push(
      vscode.languages.setLanguageConfiguration(language, languageConfiguration(vscode))
    );
  }
  registerPascalGenericBracketColoring(context, vscode);
}

module.exports = {
  BLOCK_START_PATTERN,
  PASCAL_INDENTATION_RULES,
  SINGLE_STATEMENT_PATTERN,
  collectPascalGenericAngleBrackets,
  languageConfiguration,
  registerPascalLanguageConfiguration
};
