import { PascalKeyword } from "./shared/pascal";
import { isInteger } from './shared/guards';
import { maskPascalNonCode } from './binarySymbols';

function identifierAt(text: string, offset: unknown) {
  if (!isInteger(offset)) return undefined;
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

function findIdentifierOccurrences(text: string, identifier: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier || '')) return [];
  const code = maskPascalNonCode(text);
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...code.matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))]
    .map(match => ({ offset: match.index, length: match[0].length }));
}

function lineStartsFor(text: string) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(lineStarts: readonly number[], offset: number) {
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

function formatDelphiGuid(uuid: string) {
  const normalized = String(uuid || '').replace(/[{}]/g, '').toUpperCase();
  if (!/^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(normalized)) return undefined;
  return `{${normalized}}`;
}

function isDelphiInterfaceDeclaration(line: unknown) {
  return new RegExp(String.raw`^\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?\s*=\s*${PascalKeyword.Interface}(?:\s*\([^)]*\))?\s*$`, "i")
    .test(String(line || ''));
}

function automaticInterfaceGuidText(indentation: string, eol: string, uuid: string) {
  const guid = formatDelphiGuid(uuid);
  return guid ? `${indentation}['${guid}']${eol}${indentation}` : undefined;
}

export {
  automaticInterfaceGuidText,
  findIdentifierOccurrences,
  formatDelphiGuid,
  identifierAt,
  isDelphiInterfaceDeclaration,
  lineStartsFor,
  positionAt
};
