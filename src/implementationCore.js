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

module.exports = {
  descendantTypeDefinitions,
  enclosingRoutineOwner,
  memberImplementationDefinitions,
  routineImplementationDefinitions,
  typeKey
};
