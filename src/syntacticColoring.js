'use strict';

const PASCAL_KEYWORDS = new Set([
  'and', 'array', 'as', 'asm', 'begin', 'case', 'class', 'const', 'constructor',
  'destructor', 'dispinterface', 'div', 'do', 'downto', 'else', 'end', 'except',
  'exports', 'file', 'finalization', 'finally', 'for', 'function', 'goto', 'if',
  'implementation', 'in', 'inherited', 'initialization', 'inline', 'interface',
  'is', 'label', 'library', 'mod', 'nil', 'not', 'object', 'of', 'or', 'out',
  'packed', 'procedure', 'program', 'property', 'raise', 'record', 'repeat',
  'resourcestring', 'set', 'shl', 'shr', 'string', 'then', 'threadvar', 'to',
  'try', 'type', 'unit', 'until', 'uses', 'var', 'while', 'with', 'xor'
]);

const PASCAL_INTRINSIC_TYPE_IDENTIFIERS = new Set([
  'ansichar', 'ansistring', 'boolean', 'byte', 'bytebool', 'cardinal', 'char',
  'comp', 'currency', 'double', 'extended', 'int8', 'int16', 'int32',
  'int64', 'integer', 'intptr', 'longbool', 'longint', 'longword', 'nativeint',
  'nativeuint', 'olevariant', 'pansichar', 'pchar', 'pointer', 'pwidechar',
  'rawbytestring', 'real', 'real48', 'shortint', 'shortstring',
  'single', 'smallint', 'string', 'text', 'uint8', 'uint16', 'uint32',
  'uint64', 'uintptr', 'unicodestring', 'utf8string', 'variant', 'widechar',
  'widestring', 'word', 'wordbool'
]);
const PASCAL_INTRINSIC_IDENTIFIERS = new Set([
  ...PASCAL_INTRINSIC_TYPE_IDENTIFIERS,
  'false', 'nil', 'result', 'self', 'true'
]);

const VISIBILITY_KEYWORDS = new Set([
  'private', 'protected', 'public', 'published', 'automated'
]);
const MEMBER_SECTION_STARTERS = new Set([
  'class', 'const', 'constructor', 'destructor', 'end', 'function', 'operator',
  'private', 'procedure', 'property', 'protected', 'public', 'published',
  'strict', 'threadvar', 'type', 'var'
]);

function nextClassMemberLooksLikeDeclaration(code, offset) {
  const tail = code.slice(offset);
  const next = /^\s*([A-Za-z_][A-Za-z0-9_]*|.)/.exec(tail);
  if (!next) return true;
  if (next[1] === '[') return true; // Delphi custom attribute before a member.
  if (!/^[A-Za-z_]/.test(next[1])) return false;
  const key = next[1].toLowerCase();
  if (MEMBER_SECTION_STARTERS.has(key)) return true;
  const afterName = tail.slice(next.index + next[0].lastIndexOf(next[1]) + next[1].length);
  return /^\s*(?:,\s*[A-Za-z_][A-Za-z0-9_]*\s*)*:/.test(afterName);
}

/**
 * Returns true only when a contextual visibility word is being used as a
 * class-section directive.  Delphi also legally uses names such as `Public`
 * for enum members, so an unconditional reserved-word blacklist would erase
 * valid symbol coloring.  The masked-code caller supplies comments and strings
 * as whitespace; punctuation after an enum value (`Public,` / `Public)`) keeps
 * those real symbols out of this branch.
 */
function isPascalVisibilityDirectiveAt(code, offset, identifier) {
  const key = String(identifier || '').toLowerCase();
  if (key !== 'strict' && !VISIBILITY_KEYWORDS.has(key)) return false;
  const lineStart = Math.max(code.lastIndexOf('\n', offset - 1), code.lastIndexOf('\r', offset - 1)) + 1;
  const prefix = code.slice(lineStart, offset).trim().toLowerCase();
  if (key === 'strict') {
    if (prefix) return false;
    const following = /^\s*(private|protected)\b/i.exec(code.slice(offset + identifier.length));
    return Boolean(following);
  }
  if (prefix !== '' && prefix !== 'strict') return false;
  if (prefix === 'strict' && key !== 'private' && key !== 'protected') return false;
  return nextClassMemberLooksLikeDeclaration(code, offset + identifier.length);
}

function isMemberReference(code, offset) {
  let cursor = offset - 1;
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
  return code[cursor] === '.';
}

function isEscapedOrQualifiedIdentifier(code, offset) {
  let cursor = offset - 1;
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
  return code[cursor] === '.' || code[cursor] === '&';
}

function isPascalIntrinsicIdentifier(symbol) {
  return PASCAL_INTRINSIC_IDENTIFIERS.has(String(symbol || '').trim().toLowerCase());
}

function isPascalIntrinsicTypeIdentifier(symbol) {
  return PASCAL_INTRINSIC_TYPE_IDENTIFIERS.has(String(symbol || '').trim().toLowerCase());
}

function isSystemQualifiedIdentifier(code, offset) {
  let cursor = offset - 1;
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
  if (code[cursor] !== '.') return false;
  cursor -= 1;
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
  const end = cursor + 1;
  while (cursor >= 0 && /[A-Za-z0-9_]/.test(code[cursor])) cursor -= 1;
  return code.slice(cursor + 1, end).toLowerCase() === 'system';
}

function isPascalIntrinsicTypeCastAt(code, offset, identifier, looksLikeCall = true) {
  if (!looksLikeCall || !isPascalIntrinsicTypeIdentifier(identifier)) return false;
  let cursor = offset - 1;
  while (cursor >= 0 && /\s/.test(code[cursor])) cursor -= 1;
  if (code[cursor] === '&') return false;
  return code[cursor] !== '.' || isSystemQualifiedIdentifier(code, offset);
}

function isPascalNonNavigableIdentifierAt(code, offset, identifier) {
  if (isEscapedOrQualifiedIdentifier(code, offset)) return false;
  const key = String(identifier || '').toLowerCase();
  if (PASCAL_KEYWORDS.has(key) || isPascalIntrinsicIdentifier(key)) return true;
  return (key === 'strict' || VISIBILITY_KEYWORDS.has(key))
    && isPascalVisibilityDirectiveAt(code, offset, identifier);
}

function collectPascalSyntacticColoring(code) {
  const typeNames = new Set();
  const typeCasts = new Set();
  const calls = new Set();
  const members = new Map();

  // This is deliberately restricted to declaration-style colons. It supplies
  // useful coloring when a third-party Unit is available only as a DCU (for
  // example `Params: IJson` or a `TMVCResult` return type).
  for (const declaration of code.matchAll(/:\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()\r\n]*>)?)/g)) {
    for (const identifier of declaration[1].matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const key = identifier[0].toLowerCase();
      if (!PASCAL_KEYWORDS.has(key)) typeNames.add(key);
    }
  }

  for (const identifier of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const key = identifier[0].toLowerCase();
    const offset = identifier.index;
    const suffix = code.slice(offset + identifier[0].length);
    const looksLikeCall = /^\s*(?:<[^<>\r\n]*>\s*)?\(/.test(suffix);
    if (isPascalIntrinsicTypeCastAt(code, offset, identifier[0], looksLikeCall)) {
      typeCasts.add(offset);
      continue;
    }
    if (PASCAL_KEYWORDS.has(key)) continue;
    if (isMemberReference(code, offset)) {
      members.set(offset, looksLikeCall ? 'method' : 'property');
    } else if (looksLikeCall && !typeNames.has(key)) {
      calls.add(offset);
    }
  }

  return { typeNames, typeCasts, calls, members };
}

module.exports = {
  collectPascalSyntacticColoring,
  isPascalIntrinsicIdentifier,
  isPascalIntrinsicTypeCastAt,
  isPascalIntrinsicTypeIdentifier,
  isPascalNonNavigableIdentifierAt,
  isPascalVisibilityDirectiveAt
};
