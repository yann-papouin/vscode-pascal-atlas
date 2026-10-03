'use strict';

const { maskPascalNonCode } = require('./binarySymbols');

function identifierAt(text, offset) {
  if (!Number.isInteger(offset)) return undefined;
  let cursor = Math.max(0, Math.min(offset, text.length));
  if (cursor === text.length || !/[A-Za-z0-9_]/.test(text[cursor] || '')) cursor -= 1;
  if (cursor < 0 || !/[A-Za-z0-9_]/.test(text[cursor])) return undefined;
  let start = cursor;
  let end = cursor + 1;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start -= 1;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end += 1;
  const word = text.slice(start, end);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(word) ? { word, start, end } : undefined;
}

function findIdentifierOccurrences(text, identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier || '')) return [];
  const code = maskPascalNonCode(text);
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...code.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))]
    .map(match => ({ offset: match.index, length: match[0].length }));
}

function lineStartsFor(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  const line = Math.max(0, high);
  return { line, character: offset - lineStarts[line] };
}

function formatDelphiGuid(uuid) {
  const normalized = String(uuid || '').replace(/[{}]/g, '').toUpperCase();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)) return undefined;
  return `{${normalized}}`;
}

function isDelphiInterfaceDeclaration(line) {
  return /^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?\s*=\s*interface(?:\s*\([^)]*\))?\s*$/i
    .test(String(line || ''));
}

function automaticInterfaceGuidText(indentation, eol, uuid) {
  const guid = formatDelphiGuid(uuid);
  return guid ? `${indentation}['${guid}']${eol}${indentation}` : undefined;
}

module.exports = {
  automaticInterfaceGuidText,
  findIdentifierOccurrences,
  formatDelphiGuid,
  identifierAt,
  isDelphiInterfaceDeclaration,
  lineStartsFor,
  positionAt
};
