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

/** Read complete directive statements, including their source positions for insertion. */
function routineDirectiveStatements(code, headerEnd) {
  const result = [];
  if (!Number.isInteger(headerEnd) || headerEnd < 0) return result;
  let cursor = headerEnd;
  const pattern = /^\s*(abstract|external|forward|virtual|dynamic|override|overload|reintroduce|static|final|inline|cdecl|stdcall|safecall|register|pascal|varargs|message|dispid|deprecated|platform|experimental|library)\b[^;]*;/i;
  for (let match; (match = pattern.exec(code.slice(cursor)));) {
    result.push({ name: match[1].toLowerCase(), start: cursor + match[0].search(/\S/), end: cursor + match[0].length });
    cursor += match[0].length;
  }
  return result;
}

/** Read declaration directives only; a later method's abstract directive must not leak back. */
function methodDeclarationDirectives(code, node) {
  return new Set(routineDirectiveStatements(code, routineHeaderEnd(code, node.declarationOffset)).map(item => item.name));
}

function skipSpace(code, offset) {
  while (/\s/.test(code[offset] || '')) offset += 1;
  return offset;
}

/**
 * Read a structure lexically. Entire nested structures and method headings are
 * consumed as members so their visibility labels cannot affect the outer type.
 */
function structureLayout(code, kindOffset, depth = 0) {
  if (depth > 64) return undefined;
  const kindMatch = /^(class|record|object|interface)\b/i.exec(code.slice(kindOffset));
  if (!kindMatch) return undefined;
  const kind = kindMatch[1].toLowerCase();
  let cursor = skipSpace(code, kindOffset + kindMatch[0].length);
  if (kind === 'class' && /^of\b/i.test(code.slice(cursor))) return undefined;
  for (let modifier; (modifier = /^(abstract|sealed)\b\s*/i.exec(code.slice(cursor)));) cursor += modifier[0].length;
  const helper = /^helper\s+for\s+[A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^>]*>)?\s*/i.exec(code.slice(cursor));
  if (helper) cursor += helper[0].length;
  let ancestor = false;
  if (code[cursor] === '(') {
    const close = closingBracket(code, cursor, '(', ')');
    if (close < 0) return undefined;
    ancestor = true; cursor = skipSpace(code, close + 1);
  }
  if (code[cursor] === ';') {
    return { kind, keyword: kindMatch[0], bodyStart: cursor, endOffset: cursor + 1,
      shorthand: ancestor && kind === 'class', forward: !ancestor, sections: [], members: [] };
  }
  const bodyStart = cursor;
  const sections = [{ access: kind === 'class' ? 'published' : 'public', start: bodyStart, bodyStart, implicit: true }];
  const members = [];
  let declarationKind;
  for (; cursor < code.length;) {
    cursor = skipSpace(code, cursor);
    const close = /^end\s*;/i.exec(code.slice(cursor));
    if (close) {
      sections.at(-1).end = cursor;
      return { kind, keyword: kindMatch[0], bodyStart, closingStart: cursor,
        endOffset: cursor + close[0].length, sections, members };
    }
    const visibility = /^(strict\s+(?:private|protected)|public|published|private|protected|automated)\b/i.exec(code.slice(cursor));
    if (visibility) {
      sections.at(-1).end = cursor;
      sections.push({ access: visibility[1].toLowerCase().replace(/\s+/g, '-'), start: cursor,
        bodyStart: cursor + visibility[0].length, spelling: visibility[0] });
      cursor += visibility[0].length; declarationKind = undefined; continue;
    }
    const group = /^(?:class\s+)?(type|const|var|threadvar)\b/i.exec(code.slice(cursor));
    if (group) { declarationKind = group[1].toLowerCase(); cursor += group[0].length; continue; }
    const attributeStart = cursor;
    while (code[cursor] === '[') {
      const closeAttribute = closingBracket(code, cursor, '[', ']');
      if (closeAttribute < 0) return undefined;
      cursor = skipSpace(code, closeAttribute + 1);
    }
    if (kind === 'interface' && /^end\s*;/i.test(code.slice(cursor))) continue;
    const start = cursor;
    const section = sections.length - 1;
    const routine = /^((?:class\s+)?(function|procedure|constructor|destructor|operator)\s+)([A-Za-z_][A-Za-z0-9_]*)/i.exec(code.slice(start));
    if (routine) {
      const nameOffset = start + routine[1].length;
      const range = routineDeclarationRange(code, nameOffset);
      if (!range?.end) return undefined;
      const directives = routineDirectiveStatements(code, range.end);
      const end = directives.at(-1)?.end ?? range.end;
      members.push({ kind: 'routine', name: routine[3], nameOffset, start, attributeStart,
        headerEnd: range.end, end, section, access: sections[section].access, directives });
      cursor = end; declarationKind = undefined; continue;
    }
    // Other declarations end at a semicolon outside parentheses, generics and
    // nested record/class bodies (including anonymous record fields).
    let parentheses = 0;
    let brackets = 0;
    let angles = 0;
    let end;
    for (; cursor < code.length; cursor += 1) {
      const token = code[cursor];
      if (!parentheses && !brackets && !angles && /[A-Za-z]/.test(token)
        && !/[A-Za-z0-9_&.]/.test(code[cursor - 1] || '')) {
        if (/^(?:implementation|initialization|finalization|end)\b/i.test(code.slice(cursor))) return undefined;
        const nestedKind = /^(?:class|record|object|interface)\b/i.exec(code.slice(cursor));
        if (nestedKind && !/^class\s+of\b/i.test(code.slice(cursor))) {
          const nested = structureLayout(code, cursor, depth + 1);
          if (!nested) return undefined;
          end = nested.endOffset; break;
        }
      }
      if (token === '(') parentheses += 1;
      else if (token === ')') parentheses -= 1;
      else if (token === '[') brackets += 1;
      else if (token === ']') brackets -= 1;
      else if (token === '<') angles += 1;
      else if (token === '>') angles = Math.max(0, angles - 1);
      else if (token === ';' && !parentheses && !brackets && !angles) { end = cursor + 1; break; }
    }
    if (!end) return undefined;
    const property = /^(?:class\s+)?property\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(code.slice(start, end));
    const names = property ? [property[1]] : (/^([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)/.exec(code.slice(start, end))?.[1] || '').split(',').map(name => name.trim()).filter(Boolean);
    for (const name of names) {
      members.push({ kind: property ? 'property' : declarationKind === 'type' ? 'type' : 'field',
        name, start, attributeStart, end, section, access: sections[section].access,
        accessors: property ? [...code.slice(start, end).matchAll(/\b(?:read|write)\s+([A-Za-z_][A-Za-z0-9_]*)/gi)].map(match => match[1].toLowerCase()) : [] });
    }
    cursor = end;
  }
  return undefined;
}

/** Read a real class definition, rejecting synthetic Navigator owners and forward-only types. */
function readClassLayout(text, offset, preparedCode) {
  const code = preparedCode || maskPascalNonCode(text);
  const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(code.slice(offset));
  if (!name) return undefined;
  let cursor = skipSpace(code, offset + name[0].length);
  if (code[cursor] === '<') {
    const close = closingBracket(code, cursor, '<', '>');
    if (close < 0) return undefined;
    cursor = skipSpace(code, close + 1);
  }
  if (code[cursor] !== '=') return undefined;
  cursor = skipSpace(code, cursor + 1);
  if (!/^class\b/i.test(code.slice(cursor))) return undefined;
  const layout = structureLayout(code, cursor);
  return layout && { ...layout, offset, name: name[0] };
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

/** Compact code whitespace without changing defaults or swallowing code after line comments. */
function compactRoutineHeading(text) {
  const literals = [];
  const protectedText = text.replace(/'(?:''|[^'])*'|\/\/[^\r\n]*|\{[^}]*\}|\(\*[\s\S]*?\*\)/g, token => {
    literals.push(token.startsWith('//') ? token + (text.includes('\r\n') ? '\r\n' : '\n') : token);
    return `\0${literals.length - 1}\0`;
  });
  return protectedText.replace(/\s+/g, ' ').trim().replace(/\0(\d+)\0/g, (_, index) => literals[Number(index)]);
}

function keywordCase(word, reference) {
  const first = reference?.match(/[A-Za-z]+/)?.[0] || '';
  return first && first === first.toUpperCase() ? word.toUpperCase()
    : /^[A-Z][a-z]+$/.test(first) ? word[0].toUpperCase() + word.slice(1) : word;
}

function declarationFromBody(text, code, body, overloaded) {
  const prefix = /^(?:class\s+)?(function|procedure)\s+/i.exec(code.slice(body.header.start));
  if (!prefix || body.header.headerEnd < 0) return undefined;
  const heading = compactRoutineHeading(text.slice(body.header.start, body.header.start + prefix[0].length)
    + text.slice(body.header.nameOffset, body.header.headerEnd));
  const key = routineCounterpartKey(heading, body.header.name);
  if (!key) return undefined;
  const [kind, , , parameters, result] = JSON.parse(key);
  if ((kind === 'function' && !result) || (kind === 'procedure' && result)
    || parameters.some(([mode, type]) => !mode && !type)) return undefined;
  const directives = routineDirectiveStatements(code, body.header.headerEnd)
    .filter(item => /^(cdecl|stdcall|safecall|register|pascal|varargs)$/.test(item.name))
    .map(item => compactRoutineHeading(text.slice(item.start, item.end)));
  if (overloaded) directives.unshift(`${keywordCase('overload', prefix[1])};`);
  return { text: [heading, ...directives].join(' '), key,
    nameOffset: /^(?:class\s+)?(?:function|procedure)\s+/i.exec(maskPascalNonCode(heading))[0].length };
}

/** Parameter modes, result types and routine kinds cannot distinguish an overload. */
function overloadParameterKey(key) {
  const [, , name, parameters, , arity = 0] = JSON.parse(key);
  return JSON.stringify([name, arity, parameters.map(([, type]) => type)]);
}

function declarationEntry(text, code, member) {
  const signature = text.slice(member.start, member.headerEnd);
  return { ...member, signature, routineSignatureKey: routineCounterpartKey(signature, member.name),
    routineOverloaded: member.directives.some(item => item.name === 'overload') };
}

function declarationInsertionBefore(text, entry, comments) {
  return beforeImplementation(text, { header: { start: entry.attributeStart ?? entry.start } }, comments);
}

function declarationInsertionAfter(text, entry, comments) {
  return afterImplementation(text, { terminatorEndOffset: entry.end }, comments);
}

/** Keep insertions at the same position ordered and translate the caret through all repairs. */
function finishCounterpartPlan(main, repairs, targetId, direction) {
  let caretRelative = main.caretRelative;
  const edits = [];
  for (const repair of repairs) {
    if (repair.offset === main.offset && repair.endOffset === repair.offset && main.endOffset === main.offset) {
      main = { ...main, text: repair.text + main.text };
      caretRelative += repair.text.length;
    } else edits.push(repair);
  }
  edits.push({ offset: main.offset, endOffset: main.endOffset, text: main.text });
  edits.sort((left, right) => left.offset - right.offset);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index].offset < edits[index - 1].endOffset) return { reason: 'The required declaration edits overlap.' };
  }
  const shift = edits.filter(edit => edit.offset < main.offset)
    .reduce((sum, edit) => sum + edit.text.length - (edit.endOffset - edit.offset), 0);
  return { edits, caretOffset: main.offset + caretRelative + shift, targetId, direction };
}

/**
 * Create a missing declaration using immediate implementation neighbors. Class
 * anchors prefer protected, then private; otherwise placement uses public names.
 */
function planRoutineDeclaration(text, model, caretOffset, editorOptions = {}) {
  const code = maskPascalNonCode(text);
  const unitHeading = /^\s*unit\s+[A-Za-z_][A-Za-z0-9_.]*\s*;\s*interface\b/i.exec(code);
  const implementation = /\bimplementation\b/i.exec(code);
  if (!unitHeading || !implementation || !/\bend\s*\.(?=\s*$)/i.test(code)) {
    return { reason: 'A complete unit with an interface and implementation section is required.' };
  }
  const bodies = model?.implementationRoutines || [];
  const body = bodies.find(item => caretOffset >= item.header.start && caretOffset <= (item.terminatorEndOffset ?? item.end));
  if (!body) return { reason: 'Place one caret in a top-level function or procedure implementation.' };
  if (body.children.some(child => caretOffset >= child.header.start && caretOffset < child.end)) {
    return { reason: 'Local routines cannot have class or unit-interface declarations.' };
  }
  const target = model.routineNodes.find(node => node.implementationOffset === body.header.nameOffset);
  if (!target || !['function', 'procedure'].includes(target.routineKind) || !body.complete) {
    return { reason: 'Complete the function or procedure implementation before creating its declaration.' };
  }
  if (conditionalDepthAt(text, body.header.start)) return { reason: 'The implementation is inside an unresolved conditional section.' };
  const owner = body.header.owner ? target.parent : undefined;
  const global = !body.header.owner && target.routineFlavor === 'global';
  const layout = owner?.kind === 'type' && owner.typeKind === 'class' ? readClassLayout(text, owner.offset, code) : undefined;
  if (!global && (!layout || layout.forward)) return { reason: 'The owning class definition is unavailable or incomplete.' };
  if ((layout && layout.members.some(member => member.kind === 'routine' && member.nameOffset === target.declarationOffset))
    || (global && target.declarationOffset < implementation.index)) return { reason: 'This routine already has a declaration.' };
  const bodyDirectives = routineDirectiveStatements(code, body.header.headerEnd);
  if (bodyDirectives.some(item => item.name === 'forward')) return { reason: 'A forward declaration is not a routine implementation.' };
  let declarations;
  if (layout) declarations = layout.members.filter(member => member.kind === 'routine').map(member => declarationEntry(text, code, member));
  else declarations = model.routineNodes.filter(node => !node.owner && node.routineFlavor === 'global'
    && node.declarationOffset < implementation.index).map(node => {
    const directives = routineDirectiveStatements(code, node.declarationHeaderEndOffset);
    return declarationEntry(text, code, { name: node.name, nameOffset: node.declarationOffset,
      start: node.declarationStartOffset, headerEnd: node.declarationHeaderEndOffset,
      end: directives.at(-1)?.end ?? node.declarationHeaderEndOffset, directives });
  });
  if (declarations.some(entry => !entry.headerEnd || !entry.routineSignatureKey)) {
    return { reason: 'Complete the existing declarations before adding a counterpart.' };
  }
  const heading = declarationFromBody(text, code, body, false);
  if (!heading) return { reason: 'The implementation must supply a complete parameter and result signature.' };
  if (declarations.some(entry => entry.routineSignatureKey === heading.key)) return { reason: 'This routine already has a declaration.' };
  const family = declarations.filter(entry => entry.name.toLowerCase() === target.name.toLowerCase());
  if (family.some(entry => overloadParameterKey(entry.routineSignatureKey) === overloadParameterKey(heading.key))) {
    return { reason: 'An existing declaration has incompatible parameters, modifiers or result type; correct that signature first.' };
  }
  if (layout?.members.some(member => (member.kind !== 'routine' && member.name.toLowerCase() === target.name.toLowerCase())
    || (family.length && member.accessors?.includes(target.name.toLowerCase())))) {
    return { reason: 'The name conflicts with a class member or property-accessor contract.' };
  }
  const sameOwner = item => global ? !item.header.owner : model.routineNodes
    .some(node => node.parent === owner && node.implementationOffset === item.header.nameOffset);
  const ownerBodies = bodies.filter(sameOwner);
  const index = indexRoutineDeclarations(declarations);
  const entryByBody = new Map();
  for (const item of ownerBodies) {
    const entry = findRoutineCounterpart(index, text.slice(item.header.start, item.header.headerEnd), item.header.name);
    if (entry) { entry.implementationOffset = item.header.nameOffset; entryByBody.set(item, entry); }
  }
  if (entryByBody.has(body)) return { reason: 'This routine already has a declaration.' };
  // Private global overloads need not be exported, but their defining
  // declarations still participate in the unit's overload family.
  if (global) {
    for (const item of ownerBodies) {
      if (item === body || entryByBody.has(item) || item.header.name.toLowerCase() !== target.name.toLowerCase()) continue;
      if (!declarationFromBody(text, code, item, false)) return { reason: 'Complete the related overload headings before creating a declaration.' };
      const directives = routineDirectiveStatements(code, item.header.headerEnd);
      const entry = declarationEntry(text, code, { name: item.header.name, nameOffset: item.header.nameOffset,
        start: item.header.start, headerEnd: item.header.headerEnd, end: directives.at(-1)?.end ?? item.header.headerEnd, directives });
      if (overloadParameterKey(entry.routineSignatureKey) === overloadParameterKey(heading.key)) return { reason: 'A global routine with incompatible signature already exists.' };
      entry.implementationOffset = item.header.nameOffset;
      family.push(entry);
    }
  }
  const position = ownerBodies.indexOf(body);
  let previous = entryByBody.get(ownerBodies[position - 1]);
  let next = entryByBody.get(ownerBodies[position + 1]);
  const category = access => access?.replace(/^strict-/, '');
  let section;
  if (layout) {
    const available = [previous, next].filter(Boolean);
    const preferred = available.some(entry => category(entry.access) === 'protected') ? 'protected'
      : available.some(entry => category(entry.access) === 'private') ? 'private' : 'public';
    previous = category(previous?.access) === preferred ? previous : undefined;
    next = category(next?.access) === preferred ? next : undefined;
    section = layout.sections[(previous || next)?.section];
    // Separate blocks have separate lexical scopes, even with equal visibility.
    if (previous && next && previous.section !== next.section) next = undefined;
  }
  let anchor;
  let before = false;
  const ordered = declarations.filter(entry => !layout || entry.section === (previous || next)?.section)
    .sort((left, right) => left.start - right.start);
  if (previous && next && Math.abs(ordered.indexOf(previous) - ordered.indexOf(next)) === 1) {
    anchor = previous.start < next.start ? previous : next;
  } else if (previous) anchor = previous;
  else if (next) { anchor = next; before = true; }
  else {
    const pool = declarations.filter(entry => !layout || entry.access === 'public').sort((left, right) => left.start - right.start);
    const equal = pool.filter(entry => entry.name.toLowerCase() === target.name.toLowerCase());
    if (equal.length) anchor = equal.at(-1);
    else { anchor = pool.find(entry => entry.name.toLowerCase() > target.name.toLowerCase()); before = Boolean(anchor); anchor ||= pool.at(-1); }
    section = layout ? (anchor ? layout.sections[anchor.section] : layout.sections.find(item => item.access === 'public')) : undefined;
  }
  const eol = editorOptions.eol || (text.includes('\r\n') ? '\r\n' : '\n');
  const size = Number(editorOptions.tabSize);
  const indentUnit = editorOptions.insertSpaces === false ? '\t' : ' '.repeat(Number.isFinite(size) && size > 0 ? Math.floor(size) : 2);
  const leadingIndent = offset => text.slice(lineStart(text, offset), offset).match(/^[ \t]*/)[0];
  const classIndent = layout ? leadingIndent(layout.offset) : '';
  const visibilityIndent = layout ? leadingIndent(layout.sections.find(item => !item.implicit)?.start ?? layout.offset) : '';
  const sample = anchor || layout?.members.find(member => member.section === layout.sections.indexOf(section)) || layout?.members[0];
  const memberIndent = sample && !text.slice(lineStart(text, sample.start), sample.start).trim()
    ? leadingIndent(sample.start) : layout ? visibilityIndent + indentUnit : '';
  const needsOverload = family.length > 0 || bodyDirectives.some(item => item.name === 'overload');
  if (needsOverload && layout?.members.some(member => member.accessors?.includes(target.name.toLowerCase()))) {
    return { reason: 'A property-accessor contract cannot be made overloaded.' };
  }
  const completeHeading = declarationFromBody(text, code, body, needsOverload);
  const comments = commentSpans(text);
  let main;
  if (layout?.shorthand) {
    const label = keywordCase('public', layout.keyword);
    const prefix = `${eol}${visibilityIndent}${label}${eol}${memberIndent}`;
    main = { offset: layout.endOffset - 1, endOffset: layout.endOffset,
      text: `${prefix}${completeHeading.text}${eol}${classIndent}${keywordCase('end', layout.keyword)};`,
      caretRelative: prefix.length + completeHeading.nameOffset };
  } else {
    const boundary = layout ? section?.end ?? layout.closingStart : implementation.index;
    let offset = anchor ? (before ? declarationInsertionBefore(text, anchor, comments) : declarationInsertionAfter(text, anchor, comments))
      : beforeImplementation(text, { header: { start: boundary } }, comments);
    if (layout && offset < (section?.bodyStart ?? layout.bodyStart)) offset = boundary;
    if (offset < (layout?.bodyStart ?? unitHeading[0].length) || offset > boundary) return { reason: 'The declaration boundary cannot be safely resolved.' };
    const midLine = Boolean(text.slice(lineStart(text, offset), offset).trim());
    let prefix = midLine ? eol : '';
    if (layout && !section) prefix += `${visibilityIndent}${keywordCase('public', layout.sections.find(item => item.spelling)?.spelling || layout.keyword)}${eol}`;
    if (!layout && !anchor && !/\n[ \t\r]*\n$/.test(text.slice(0, offset))) prefix += eol;
    prefix += memberIndent;
    main = { offset, endOffset: offset, text: `${prefix}${completeHeading.text}${eol}${!layout && !anchor ? eol : ''}`,
      caretRelative: prefix.length + completeHeading.nameOffset };
  }
  if (conditionalDepthAt(text, main.offset)) return { reason: 'The declaration boundary is inside an unresolved conditional section.' };
  if (section && !section.implicit && conditionalDepthAt(text, section.start)) return { reason: 'The selected visibility section is conditional and cannot be resolved safely.' };
  const repairs = [];
  for (const entry of family) {
    if (conditionalDepthAt(text, entry.start)) return { reason: 'An overload declaration is inside an unresolved conditional section.' };
    if (!entry.routineOverloaded) {
      const offset = entry.directives.find(item => item.name === 'reintroduce')?.end ?? entry.headerEnd;
      const reference = /^(?:class\s+)?([A-Za-z]+)/i.exec(code.slice(entry.start))?.[1];
      repairs.push({ offset, endOffset: offset, text: ` ${keywordCase('overload', reference)};` });
    }
    const existing = ownerBodies.find(item => item.header.nameOffset === entry.implementationOffset);
    if (existing && !code.slice(existing.header.nameOffset, existing.header.headerEnd).includes('(')) {
      // Adding overload makes abbreviated defining headings invalid. Insert only
      // the known parameters/result, preserving qualification, comments and body.
      let nameEnd = existing.header.nameOffset + existing.header.name.length;
      const genericStart = skipSpace(code, nameEnd);
      if (code[genericStart] === '<') nameEnd = closingBracket(code, genericStart, '<', '>') + 1;
      const defining = implementationHeading(text, code, { ...entry, declarationStartOffset: entry.start,
        declarationHeaderEndOffset: entry.headerEnd });
      if (!defining) return { reason: 'An existing overload heading cannot be expanded safely.' };
      const start = defining.indexOf('(');
      const end = start < 0 ? -1 : closingBracket(defining, start, '(', ')');
      let addition = start < 0 ? '' : defining.slice(start, end + 1);
      const result = defining.slice(end < 0 ? defining.indexOf(':') : end + 1).replace(/;\s*$/, '');
      if (!code.slice(nameEnd, existing.header.headerEnd).includes(':') && /^\s*:/.test(result)) addition += result;
      if (addition) {
        if (conditionalDepthAt(text, nameEnd)) return { reason: 'An abbreviated overload is inside an unresolved conditional section.' };
        repairs.push({ offset: nameEnd, endOffset: nameEnd, text: addition });
      }
    }
  }
  return finishCounterpartPlan(main, repairs, target.id, 'declaration');
}

/** Dispatch by source position while retaining the original forward planner's API. */
function planRoutineCounterpart(text, model, caretOffset, editorOptions = {}) {
  const implementation = /\bimplementation\b/i.exec(maskPascalNonCode(text));
  const declaration = model?.routineNodes?.find(node => Number.isInteger(node.declarationStartOffset)
    && caretOffset >= node.declarationStartOffset && caretOffset <= (node.declarationHeaderEndOffset ?? node.declarationEndOffset)
    && (node.parent?.kind === 'type' || node.declarationOffset < implementation?.index));
  if (!declaration) return planRoutineDeclaration(text, model, caretOffset, editorOptions);
  const plan = planRoutineImplementation(text, model, caretOffset, editorOptions);
  return plan.reason ? plan : { ...plan, direction: 'implementation', edits: [{ offset: plan.offset, endOffset: plan.offset, text: plan.text }] };
}

/** Execute a version-checked counterpart edit and all required repairs in one undo group. */
function createImplementationCommand(vscode, { readyModel, onCreated }) {
  const pending = new Set();
  return async () => {
    const editor = vscode.window.activeTextEditor;
    const document = editor?.document;
    const inform = message => { void vscode.window.showInformationMessage(message); return false; };
    if (!document || !['pascal', 'objectpascal'].includes(document.languageId)
      || !vscode.workspace.getConfiguration('pascalAtlas', document.uri).get('enabled', true)) return false;
    if (vscode.workspace.fs?.isWritableFileSystem(document.uri.scheme) === false) return inform('The current document is read-only.');
    if (editor.selections.length !== 1 || !editor.selection.isEmpty) return inform('Use one caret without a selection to create a routine counterpart.');
    const uri = document.uri.toString();
    if (pending.has(uri)) return inform('A routine counterpart is already being created for this document.');
    pending.add(uri);
    const version = document.version;
    const caret = document.offsetAt(editor.selection.active);
    try {
      const model = await readyModel(document);
      if (vscode.window.activeTextEditor !== editor || document.isClosed || document.version !== version
        || editor.selections.length !== 1 || !editor.selection.isEmpty || document.offsetAt(editor.selection.active) !== caret) {
        return inform('The document, caret or active editor changed. Invoke Create Missing Routine Counterpart again.');
      }
      if (!model) return inform('The current source model is not available.');
      const plan = planRoutineCounterpart(document.getText(), model, caret, {
        ...editor.options, eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
      });
      if (plan.reason) return inform(plan.reason);
      let inserted = false;
      const changed = await editor.edit(builder => {
        if (document.version !== version || vscode.window.activeTextEditor !== editor) return;
        for (const edit of plan.edits) {
          if (edit.endOffset === edit.offset) builder.insert(document.positionAt(edit.offset), edit.text);
          else builder.replace(new vscode.Range(document.positionAt(edit.offset), document.positionAt(edit.endOffset)), edit.text);
        }
        inserted = true;
      }, { undoStopBefore: true, undoStopAfter: true });
      if (!changed || !inserted) return inform('The routine counterpart could not be inserted into the current document.');
      if (vscode.window.activeTextEditor === editor) {
        const position = document.positionAt(plan.caretOffset);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
      await onCreated?.(document, plan.targetId);
      return true;
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not create the routine counterpart: ${error.message}`);
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
  readClassLayout,
  routineDirectiveStatements,
  createImplementationCommand,
  findRoutineCounterpart,
  indexRoutineDeclarations,
  planRoutineImplementation,
  planRoutineDeclaration,
  planRoutineCounterpart,
  compactRoutineHeading,
  routineDeclarationRange,
  routineCounterpartKey,
  routineHeaderEnd,
  typeKey
};
