'use strict';

const path = require('node:path');

function normalizeKey(value) {
  return path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

function splitSearchPath(value) {
  return typeof value === 'string'
    ? value.split(';').map(item => item.trim()).filter(Boolean)
    : [];
}

function mergeManagedSearchPath(currentValue, previousManaged, nextManaged) {
  const previousKeys = new Set(previousManaged.map(normalizeKey));
  const values = [
    ...splitSearchPath(currentValue).filter(item => !previousKeys.has(normalizeKey(item))),
    ...nextManaged
  ];
  const result = [];
  const seen = new Set();
  for (const value of values) {
    const key = normalizeKey(value);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result.join(';');
}

module.exports = { mergeManagedSearchPath, splitSearchPath };
