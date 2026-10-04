'use strict';

const { maskPascalNonCode } = require('./binarySymbols');

function typeKey(typeName) {
  const withoutGenerics = String(typeName || '').replace(/<.*$/, '').trim();
  return withoutGenerics.toLowerCase().split('.').at(-1);
}

function definitionIdentity(definition, useImplementation = false) {
  const offset = useImplementation && Number.isInteger(definition.implementationOffset)
    ? definition.implementationOffset
    : definition.offset;
  return `${String(definition.filePath || '').toLowerCase()}:${offset}`;
}

function descendantTypeDefinitions(index, targetTypeName) {
  const target = typeKey(targetTypeName);
  if (!target) return [];
  const known = new Set([target]);
  const result = [];
  const seen = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const definitions of index?.types?.values() || []) {
      for (const definition of definitions) {
        const key = typeKey(definition.symbol);
        if (!key || known.has(key)) continue;
        if (!(definition.baseTypes || []).some(baseType => known.has(typeKey(baseType)))) continue;
        known.add(key);
        const identity = definitionIdentity(definition);
        if (!seen.has(identity)) {
          seen.add(identity);
          result.push(definition);
        }
        changed = true;
      }
    }
  }
  return result;
}

function memberImplementationDefinitions(index, ownerTypeName, memberName) {
  const owner = typeKey(ownerTypeName);
  const member = String(memberName || '').toLowerCase();
  if (!owner || !member) return [];
  const owners = [owner, ...descendantTypeDefinitions(index, owner).map(item => typeKey(item.symbol))];
  const result = [];
  const seen = new Set();
  for (const ownerKey of owners) {
    for (const definition of index?.members?.get(ownerKey)?.get(member) || []) {
      if (!Number.isInteger(definition.implementationOffset)) continue;
      const identity = definitionIdentity(definition, true);
      if (seen.has(identity)) continue;
      seen.add(identity);
      result.push(definition);
    }
  }
  return result;
}

function routineImplementationDefinitions(index, routineName) {
  const result = [];
  const seen = new Set();
  for (const definition of index?.definitions?.get(String(routineName || '').toLowerCase()) || []) {
    if (definition.owner || definition.kind !== 'routine'
      || !Number.isInteger(definition.implementationOffset)) continue;
    const identity = definitionIdentity(definition, true);
    if (seen.has(identity)) continue;
    seen.add(identity);
    result.push(definition);
  }
  return result;
}

function enclosingRoutineOwner(text, offset) {
  const code = maskPascalNonCode(text).slice(0, Math.max(0, offset));
  const pattern = /^\s*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)/gim;
  let owner;
  for (const match of code.matchAll(pattern)) {
    const parts = match[1].split('.').map(item => item.replace(/\s*<.*>\s*$/, '').trim());
    if (parts.length > 1) owner = parts.at(-2);
  }
  return owner;
}

/** Locate the header semicolon without stopping inside parameters or generic constraints. */
function routineHeaderEnd(code, start) {
  let parentheses = 0;
  let brackets = 0;
  let angles = 0;
  for (let index = start; index < code.length; index += 1) {
    const current = code[index];
    if (current === '(') parentheses += 1;
    else if (current === ')') parentheses = Math.max(0, parentheses - 1);
    else if (current === '[') brackets += 1;
    else if (current === ']') brackets = Math.max(0, brackets - 1);
    else if (current === '<') angles += 1;
    else if (current === '>') angles = Math.max(0, angles - 1);
    else if (current === ';' && parentheses === 0 && brackets === 0 && angles === 0) return index + 1;
  }
  return -1;
}

/** Split a Pascal header at separators outside nested parameter and type expressions. */
function splitRoutineHeaderText(text, separator) {
  const parts = [];
  let start = 0;
  let parentheses = 0;
  let brackets = 0;
  let angles = 0;
  for (let index = 0; index < text.length; index += 1) {
    const token = text[index];
    if (token === '(') parentheses += 1;
    else if (token === ')') parentheses -= 1;
    else if (token === '[') brackets += 1;
    else if (token === ']') brackets -= 1;
    else if (token === '<') angles += 1;
    else if (token === '>') angles -= 1;
    else if (token === separator && parentheses === 0 && brackets === 0 && angles === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Match overloads by parameter modes/types and result type, ignoring names and defaults. */
function routineCounterpartKey(signature, name) {
  const code = maskPascalNonCode(signature || '').trim().toLowerCase();
  const prefix = /^(class\s+)?(function|procedure|constructor|destructor|operator)\s+/.exec(code);
  if (!prefix) return undefined;
  let cursor = prefix[0].length;
  let angles = 0;
  // Skip the qualified method name, including generic type/method arguments.
  for (; cursor < code.length; cursor += 1) {
    if (code[cursor] === '<') angles += 1;
    else if (code[cursor] === '>') angles -= 1;
    else if (angles === 0 && /[(:;]/.test(code[cursor])) break;
  }
  const methodName = splitRoutineHeaderText(code.slice(prefix[0].length, cursor), '.').at(-1).trim();
  const generic = /<([\s\S]*)>$/.exec(methodName);
  const arity = generic ? genericParameterNames(generic[1]).length : 0;
  let parameters = '';
  if (code[cursor] === '(') {
    const start = ++cursor;
    let depth = 1;
    for (; cursor < code.length; cursor += 1) {
      if (code[cursor] === '(') depth += 1;
      else if (code[cursor] === ')' && --depth === 0) break;
    }
    parameters = code.slice(start, cursor);
    cursor += 1;
  }
  const parameterTypes = [];
  for (const parameter of splitRoutineHeaderText(parameters, ';')) {
    if (!parameter.trim()) continue;
    const withoutDefault = splitRoutineHeaderText(parameter, '=')[0].trim();
    const mode = /^(constref|const|var|out)\b\s*/.exec(withoutDefault);
    const declaration = withoutDefault.slice(mode?.[0].length || 0);
    const [names, ...typeParts] = splitRoutineHeaderText(declaration, ':');
    const type = typeParts.join(':').replace(/\s+/g, '');
    for (const identifier of names.split(',')) {
      if (identifier.trim()) parameterTypes.push([mode?.[1] || '', type]);
    }
  }
  const resultType = code.slice(cursor).replace(/;[\s\S]*$/, '').replace(/^\s*:/, '').replace(/\s+/g, '');
  const identity = [prefix[2], Boolean(prefix[1]), name.toLowerCase(), parameterTypes, resultType];
  // Keep existing non-generic IDs stable while distinguishing generic overload arity.
  if (arity) identity.push(arity);
  return JSON.stringify(identity);
}

/** Read declaration directives only; a later method's abstract directive must not leak back. */
function methodDeclarationDirectives(code, node) {
  const result = new Set();
  const end = routineHeaderEnd(code, node.declarationOffset);
  if (end < 0) return result;
  let tail = code.slice(end);
  const directives = /^\s*(abstract|external|virtual|dynamic|override|overload|reintroduce|static|final|inline|cdecl|stdcall|safecall|register|pascal|message|dispid|deprecated|platform|experimental)\b[^;]*;/i;
  for (let match; (match = directives.exec(tail)); tail = tail.slice(match[0].length)) {
    result.add(match[1].toLowerCase());
  }
  return result;
}

/** Index complete declarations once, preserving all overloads for ambiguity checks. */
function indexRoutineDeclarations(nodes) {
  const bySignature = new Map();
  const byName = new Map();
  for (const node of nodes) {
    if (!bySignature.has(node.routineSignatureKey)) bySignature.set(node.routineSignatureKey, []);
    bySignature.get(node.routineSignatureKey).push(node);
    const name = node.name.toLowerCase();
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(node);
  }
  return { bySignature, byName };
}

/** Match a body exactly, or resolve a legal abbreviated heading without guessing an overload. */
function findRoutineCounterpart(index, signature, name) {
  const key = routineCounterpartKey(signature, name);
  if (!index || !key) return undefined;
  const available = node => !Number.isInteger(node.implementationOffset);
  const exact = index.bySignature.get(key)?.find(available);
  if (exact) return exact;
  if (signature.includes('(')) return undefined;
  const candidates = index.byName.get(name.toLowerCase()) || [];
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  if (!candidate || candidate.routineOverloaded || !candidate.routineSignatureKey || !available(candidate)) return undefined;
  const [kind, classMethod, , , result, arity = 0] = JSON.parse(key);
  const [expectedKind, expectedClass, , , expectedResult, expectedArity = 0] = JSON.parse(candidate.routineSignatureKey);
  return kind === expectedKind && classMethod === expectedClass && arity === expectedArity && (!result || result === expectedResult)
    ? candidate : undefined;
}

function lineStart(text, offset) { return text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1; }

/** Capture the entire declaration, including a multiline parameter/result heading. */
function routineDeclarationRange(code, nameOffset) {
  const scanStart = Math.max(0, nameOffset - 8192);
  // A heading can put the name on the next line. Match only the keyword and
  // optional qualified owner directly preceding it, not a previous routine.
  const prefix = /\b(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+(?:[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>]*>)?\s*\.\s*)*$/i
    .exec(code.slice(scanStart, nameOffset));
  if (!prefix) return undefined;
  const start = scanStart + prefix.index;
  const end = routineHeaderEnd(code, start);
  const heading = end < 0 ? '' : code.slice(start, end);
  // An unfinished heading must not absorb the next declaration's semicolon.
  const headers = heading.match(/^[ \t]*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+[A-Za-z_]/gim);
  const complete = end > start && (headers?.length || 0) === 1
    && !/\b(?:implementation|initialization|finalization|begin|end)\b/i.test(heading);
  return { start, end: complete ? end : undefined };
}

/** Constraints belong to declarations; implementation owner names use only type parameter names. */
function genericParameterNames(contents) {
  return splitRoutineHeaderText(contents, ';').flatMap(group =>
    splitRoutineHeaderText(group, ':')[0].split(',').map(name => name.trim())
      .filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)));
}

function closingBracket(code, start, open, close) {
  let depth = 0;
  for (let index = start; index < code.length; index += 1) {
    if (code[index] === open) depth += 1;
    else if (code[index] === close && --depth === 0) return index;
  }
  return -1;
}

function genericSuffix(code, afterName) {
  const start = afterName + (code.slice(afterName).match(/^\s*/)?.[0].length || 0);
  if (code[start] !== '<') return '';
  const end = closingBracket(code, start, '<', '>');
  if (end < 0) return undefined;
  const names = genericParameterNames(code.slice(start + 1, end));
  return names.length ? `<${names.join(', ')}>` : undefined;
}

/** Build a defining heading without defaults, declaration directives or generic constraints. */
function implementationHeading(text, code, target) {
  const heading = code.slice(target.declarationStartOffset, target.declarationHeaderEndOffset);
  const prefix = /^(?:class\s+)?(?:function|procedure)\s+/i.exec(heading);
  if (!prefix) return undefined;
  const methodEnd = prefix[0].length + target.name.length;
  const suffix = genericSuffix(heading, methodEnd);
  if (suffix === undefined) return undefined;
  let cursor = methodEnd;
  while (/\s/.test(heading[cursor] || '')) cursor += 1;
  if (heading[cursor] === '<') cursor = closingBracket(heading, cursor, '<', '>') + 1;
  let rest = heading.slice(cursor).trim();
  if (rest.startsWith('(')) {
    const end = closingBracket(rest, 0, '(', ')');
    if (end < 0) return undefined;
    const parameters = splitRoutineHeaderText(rest.slice(1, end), ';')
      .map(group => splitRoutineHeaderText(group, '=')[0].trim());
    rest = `(${parameters.join('; ')})${rest.slice(end + 1)}`;
  }
  const owners = [];
  for (let owner = target.parent; owner?.kind === 'type'; owner = owner.parent) {
    const ownerSuffix = genericSuffix(code, owner.offset + owner.name.length);
    if (ownerSuffix === undefined) return undefined;
    owners.unshift(`${owner.name}${ownerSuffix}`);
  }
  const qualified = [...owners, `${target.name}${suffix}`].join('.');
  return `${prefix[0]}${qualified}${rest}`.replace(/\s+/g, ' ').trim();
}

/** Comment spans keep trailing notes and attached documentation with their original routine. */
function commentSpans(text) {
  const spans = [];
  const tokens = /'(?:''|[^'])*'|\/\/[^\r\n]*|\{[^}]*\}|\(\*[\s\S]*?\*\)/g;
  for (const match of text.matchAll(tokens)) {
    if (!match[0].startsWith("'")) spans.push({ start: match.index, end: match.index + match[0].length,
      directive: /^(?:\{|\(\*)\s*\$/.test(match[0]) });
  }
  return spans;
}

function beforeImplementation(text, routine, comments) {
  let offset = lineStart(text, routine.header.start);
  if (text.slice(offset, routine.header.start).trim()) return routine.header.start;
  for (let index = comments.length - 1; index >= 0; index -= 1) {
    const comment = comments[index];
    if (comment.end > offset) continue;
    const gap = text.slice(comment.end, offset);
    if (comment.directive || /\S/.test(gap) || /\n[ \t\r]*\n/.test(gap)) break;
    const start = lineStart(text, comment.start);
    if (text.slice(start, comment.start).trim()) break; // This note belongs to the preceding end;.
    offset = start;
  }
  return offset;
}

function afterImplementation(text, routine, comments) {
  let offset = routine.terminatorEndOffset;
  for (const comment of comments) {
    if (comment.start < offset) continue;
    if (!/^[ \t\r]*$/.test(text.slice(offset, comment.start))) break;
    offset = comment.end;
  }
  const newline = text.indexOf('\n', offset);
  if (newline >= 0 && /^[ \t\r]*$/.test(text.slice(offset, newline))) return newline + 1;
  return offset;
}

function conditionalDepthAt(text, offset) {
  let depth = 0;
  for (const comment of commentSpans(text)) {
    if (comment.start >= offset) break;
    if (!comment.directive) continue;
    const match = /^(?:\{|\(\*)\s*\$\s*(IFDEF|IFNDEF|IFOPT|IF|ENDIF|IFEND)\b/i
      .exec(text.slice(comment.start, comment.end));
    if (match) depth += /^(?:ENDIF|IFEND)$/i.test(match[1]) ? -1 : 1;
  }
  return depth;
}

/**
 * Plan one insertion from the immediate declaration neighbors, then owner-local
 * alphabetical order. This pure function never changes the document or model.
 */
function planRoutineImplementation(text, model, caretOffset, editorOptions = {}) {
  const code = maskPascalNonCode(text);
  const unitHeading = /^\s*unit\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/i.exec(code);
  const interfaceSection = unitHeading && /^\s*interface\b/i.exec(code.slice(unitHeading[0].length));
  const implementation = /\bimplementation\b/i.exec(code);
  const finalEnd = /\bend\s*\.(?=\s*$)/i.exec(code);
  if (!unitHeading || !interfaceSection || !implementation || !finalEnd
    || unitHeading[0].length + interfaceSection[0].length >= implementation.index) {
    return { reason: 'A complete unit with an implementation section and closing end. is required.' };
  }
  const sectionStart = implementation.index + implementation[0].length;
  const lifecycle = /^[ \t]*(?:initialization|finalization)\b/im.exec(code.slice(sectionStart));
  const sectionEnd = lifecycle ? sectionStart + lifecycle.index : finalEnd.index;
  const target = (model?.routineNodes || []).find(node => Number.isInteger(node.declarationStartOffset)
    && caretOffset >= node.declarationStartOffset
    && caretOffset <= (node.declarationHeaderEndOffset ?? node.declarationEndOffset));
  if (!target || !['function', 'procedure'].includes(target.routineKind)) {
    return { reason: 'Place one caret in a function or procedure declaration.' };
  }
  const classMethod = target.parent?.kind === 'type' && target.parent.typeKind === 'class';
  const global = !target.owner && target.routineFlavor === 'global' && target.declarationOffset < implementation.index;
  if (!classMethod && !global) return { reason: 'Only class methods and global interface routines can be implemented here.' };
  if (!Number.isInteger(target.declarationHeaderEndOffset)) return { reason: 'Complete the routine heading before creating its implementation.' };
  if (Number.isInteger(target.implementationOffset)) return { reason: 'This routine already has an implementation.' };
  const directives = methodDeclarationDirectives(code, target);
  if (directives.has('abstract') || directives.has('external')) return { reason: 'This routine does not require a local implementation.' };
  const bodies = model.implementationRoutines || [];
  if (bodies.some(body => !body.complete || body.header.start < sectionStart || body.terminatorEndOffset > sectionEnd)) {
    return { reason: 'Complete the existing implementation blocks before inserting a new routine.' };
  }
  const sameOwner = node => classMethod ? node.parent === target.parent
    : !node.owner && node.routineFlavor === 'global';
  const declarations = model.routineNodes.filter(node => sameOwner(node)
    && Number.isInteger(node.declarationOffset)
    && (classMethod || node.declarationOffset < implementation.index))
    .sort((left, right) => left.declarationOffset - right.declarationOffset);
  const index = declarations.indexOf(target);
  const counterpart = node => bodies.find(body => body.header.nameOffset === node?.implementationOffset);
  const previous = counterpart(declarations[index - 1]);
  const next = counterpart(declarations[index + 1]);
  let anchor;
  let before = false;
  if (previous && next && Math.abs(bodies.indexOf(previous) - bodies.indexOf(next)) === 1) {
    // Physical adjacency wins even if implementation order reverses declaration order.
    anchor = previous.header.start < next.header.start ? previous : next;
  } else if (previous) anchor = previous;
  else if (next) { anchor = next; before = true; }
  else {
    const ownerBodies = bodies.filter(body => {
      if (global) return !body.header.owner;
      return model.routineNodes.some(node => sameOwner(node) && node.implementationOffset === body.header.nameOffset);
    });
    const name = target.name.toLowerCase();
    const equal = ownerBodies.filter(body => body.header.name.toLowerCase() === name);
    if (equal.length) anchor = equal.at(-1); // Keep overloads together.
    else {
      anchor = ownerBodies.find(body => body.header.name.toLowerCase() > name);
      before = Boolean(anchor);
      if (!anchor) anchor = ownerBodies.at(-1);
    }
    if (!anchor) anchor = bodies.at(-1);
  }
  const comments = commentSpans(text);
  const boundaryLineStart = lineStart(text, sectionEnd);
  const offset = anchor ? (before ? beforeImplementation(text, anchor, comments) : afterImplementation(text, anchor, comments))
    : boundaryLineStart >= sectionStart ? boundaryLineStart : sectionEnd;
  if (offset < sectionStart || offset > sectionEnd || conditionalDepthAt(text, target.declarationStartOffset)
    || conditionalDepthAt(text, offset)) return { reason: 'The declaration or insertion boundary cannot be safely resolved.' };
  const heading = implementationHeading(text, code, target);
  if (!heading) return { reason: 'The routine heading is incomplete or unsupported.' };
  const eol = editorOptions.eol || (text.includes('\r\n') ? '\r\n' : '\n');
  const tabSize = Number(editorOptions.tabSize);
  const indentUnit = editorOptions.insertSpaces === false ? '\t'
    : ' '.repeat(Number.isFinite(tabSize) && tabSize > 0 ? Math.floor(tabSize) : 2);
  const indent = anchor ? text.slice(lineStart(text, anchor.header.start), anchor.header.start).match(/^[ \t]*/)[0] : '';
  const keyword = /^(?:class\s+)?(function|procedure)/i.exec(heading)[1];
  const casing = word => keyword === keyword.toUpperCase() ? word.toUpperCase()
    : /^[A-Z][a-z]+$/.test(keyword) ? word[0].toUpperCase() + word.slice(1) : word;
  const leftBreaks = text.slice(0, offset).match(/(?:\r?\n[ \t]*)+$/)?.[0].match(/\n/g)?.length || 0;
  const rightBreaks = text.slice(offset).match(/^(?:[ \t]*\r?\n)+/)?.[0].match(/\n/g)?.length || 0;
  const prefix = eol.repeat(Math.max(0, 2 - leftBreaks));
  const start = `${prefix}${indent}${heading}${eol}${indent}${casing('begin')}${eol}${indent}${indentUnit}`;
  const insertion = `${start}${eol}${indent}${casing('end')};${eol.repeat(Math.max(0, 2 - rightBreaks))}`;
  return { offset, text: insertion, caretOffset: offset + start.length, targetId: target.id };
}

/** Execute a single version-checked edit, leaving model synchronization to the caller. */
function createImplementationCommand(vscode, { readyModel, onCreated }) {
  const pending = new Set();
  return async () => {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const inform = message => { void vscode.window.showInformationMessage(message); return false; };
    if (!document || !['pascal', 'objectpascal'].includes(document.languageId)
      || !vscode.workspace.getConfiguration('pascalAtlas', document.uri).get('enabled', true)) return false;
    if (vscode.workspace.fs?.isWritableFileSystem(document.uri.scheme) === false) return inform('The current document is read-only.');
    if (editor.selections.length !== 1 || !editor.selection.isEmpty) return inform('Use one caret without a selection to create an implementation.');
    const uri = document.uri.toString();
    if (pending.has(uri)) return inform('An implementation is already being created for this document.');
    pending.add(uri);
    const version = document.version;
    const caret = document.offsetAt(editor.selection.active);
    try {
      const model = await readyModel(document);
      if (vscode.window.activeTextEditor !== editor || document.isClosed || document.version !== version
        || editor.selections.length !== 1 || !editor.selection.isEmpty || document.offsetAt(editor.selection.active) !== caret) {
        return inform('The document, caret or active editor changed. Invoke Create Routine Implementation again.');
      }
      if (!model) return inform('The current source model is not available.');
      const plan = planRoutineImplementation(document.getText(), model, caret, {
        ...editor.options, eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
      });
      if (plan.reason) return inform(plan.reason);
      let inserted = false;
      const changed = await editor.edit(builder => {
        if (document.version !== version || vscode.window.activeTextEditor !== editor) return;
        builder.insert(document.positionAt(plan.offset), plan.text);
        inserted = true;
      }, { undoStopBefore: true, undoStopAfter: true });
      if (!changed || !inserted) return inform('The implementation could not be inserted into the current document.');
      if (vscode.window.activeTextEditor === editor) {
        const position = document.positionAt(plan.caretOffset);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      await onCreated?.(document, plan.targetId);
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not create the routine implementation: ${error.message}`);
      return false;
    } finally { pending.delete(uri); }
  };
}

module.exports = {
  descendantTypeDefinitions,
  enclosingRoutineOwner,
  memberImplementationDefinitions,
  routineImplementationDefinitions,
  methodDeclarationDirectives,
  createImplementationCommand,
  findRoutineCounterpart,
  indexRoutineDeclarations,
  planRoutineImplementation,
  routineDeclarationRange,
  routineCounterpartKey,
  routineHeaderEnd,
  typeKey
};
