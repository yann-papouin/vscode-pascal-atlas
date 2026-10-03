'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { promisify } = require('node:util');
const { Worker } = require('node:worker_threads');
const { gzip, gunzip } = require('node:zlib');
const { decodePascalBytes } = require('./encodingSupport');
const {
  extractPascalRoutineSignature,
  inferPascalCollectionElementType,
  maskPascalNonCode,
  pascalRoutineReturnType,
  pascalTypeBaseName,
  substitutePascalTypeParameters,
  parseUsesUnits
} = require('./binarySymbols');
const { isPascalIntrinsicIdentifier } = require('./syntacticColoring');

const IGNORED_DIRECTORIES = new Set(['.git', '.hg', '.svn', '.vsdcache', 'node_modules']);
const PASCAL_FILE_DISCOVERY_CACHE = new Map();
const OFF_THREAD_PARSE_BYTES = 128 * 1024;
const SOURCE_INDEX_CACHE_VERSION = 4;
const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);
const IMPLICIT_PASCAL_UNITS = new Set(['system']);
function isImplicitPascalUnit(unitName) {
  return IMPLICIT_PASCAL_UNITS.has(String(unitName || '').trim().toLowerCase());
}

function pascalUnitNamesEquivalent(left, right) {
  const leftKey = String(left || '').trim().toLowerCase();
  const rightKey = String(right || '').trim().toLowerCase();
  if (!leftKey || !rightKey) return false;
  if (leftKey === rightKey) return true;
  // Delphi permits a namespaced unit to be referenced by its leaf name (for
  // example Classes for System.Classes). Do not equate two different fully
  // qualified units that merely share the same leaf.
  if (leftKey.includes('.') && rightKey.includes('.')) return false;
  return leftKey.split('.').at(-1) === rightKey.split('.').at(-1);
}

function filterAddUnitCandidates(unitNames, ownUnit) {
  const seen = new Set();
  const result = [];
  for (const unitName of unitNames || []) {
    const key = String(unitName || '').trim().toLowerCase();
    if (!key || pascalUnitNamesEquivalent(key, ownUnit)
      || isImplicitPascalUnit(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(unitName);
  }
  return result;
}

function selectBestPascalDefinitions(definitions, options = {}) {
  let selected = [...(definitions || [])];
  const preferImplementation = options.preferImplementation !== false;
  const singleTarget = options.singleTarget !== false;
  let usedImplementation = false;

  if (preferImplementation && selected.length > 0
    && selected.every(item => item.kind === 'routine')) {
    const implementations = selected.filter(item => Number.isInteger(item.implementationOffset));
    if (implementations.length > 0) {
      selected = implementations;
      usedImplementation = true;
    }
  }

  if (singleTarget && selected.length > 1) {
    const usedOrder = (options.usedUnitNames || []).map(item => String(item).toLowerCase());
    const leafOrder = usedOrder.map(item => item.split('.').at(-1));
    const rank = definition => {
      const unit = String(definition.unitName || '').toLowerCase();
      return Math.max(usedOrder.lastIndexOf(unit), leafOrder.lastIndexOf(unit.split('.').at(-1)));
    };
    selected.sort((left, right) => rank(right) - rank(left)
      || left.offset - right.offset
      || String(left.signature || '').localeCompare(String(right.signature || '')));
    selected = [selected[0]];
  }

  return { definitions: selected, usedImplementation };
}

function sourceTypeUnitIndex(sourceIndex) {
  const result = new Map();
  for (const [symbol, definitions] of sourceIndex?.types || []) {
    for (const definition of definitions) {
      if (!definition?.unitName) continue;
      if (!result.has(symbol)) result.set(symbol, new Set());
      result.get(symbol).add(definition.unitName);
    }
  }
  return result;
}

function findSourceMemberDefinitions(indexes, typeName, memberName) {
  const sources = (Array.isArray(indexes) ? indexes : [indexes]).filter(Boolean);
  const wanted = String(memberName || '').toLowerCase();
  const pending = [typeName];
  const visited = new Set();

  while (pending.length > 0) {
    const current = pending.shift();
    const key = pascalTypeBaseName(current).toLowerCase();
    if (!key || visited.has(key)) continue;
    visited.add(key);

    const direct = sources.flatMap(index => index.members?.get(key)?.get(wanted) || []);
    if (direct.length > 0) return direct;

    const definitions = sources.flatMap(index => index.types?.get(key) || []);
    for (const definition of definitions) {
      const parameters = definition.typeParameters || [];
      for (const baseType of definition.baseTypes || []) {
        pending.push(substitutePascalTypeParameters(baseType, parameters, current));
      }
      if (definition.aliasedType) {
        pending.push(substitutePascalTypeParameters(
          definition.aliasedType,
          parameters,
          current
        ));
      }
    }
  }
  return [];
}

function createSourceParserWorker() {
  let worker;
  let nextRequestId = 1;
  const pending = new Map();
  const failPending = error => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const ensureWorker = () => {
    if (worker) return worker;
    worker = new Worker(path.join(__dirname, 'sourceIndexWorker.js'));
    worker.on('message', message => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.unit);
    });
    worker.on('error', failPending);
    worker.on('exit', code => {
      if (code !== 0 && pending.size > 0) {
        failPending(new Error(`Pascal source parser worker exited with code ${code}.`));
      }
      worker = undefined;
    });
    return worker;
  };
  return {
    parse(text, filePath) {
      const id = nextRequestId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ensureWorker().postMessage({ id, text, filePath });
      });
    },
    async dispose() {
      if (!worker) return;
      const activeWorker = worker;
      worker = undefined;
      await activeWorker.terminate();
    }
  };
}

async function findFilesWithExtensions(rootPath, extensions) {
  const results = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const batch = pending.splice(0, 16);
    const listings = await Promise.all(batch.map(async directory => {
      try {
        return [directory, await fs.promises.readdir(directory, { withFileTypes: true })];
      } catch {
        return [directory, []];
      }
    }));
    for (const [directory, entries] of listings) {
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) pending.push(fullPath);
        } else if (entry.isFile() && extensions.has(path.extname(entry.name).toLowerCase())) {
          results.push(fullPath);
        }
      }
    }
  }
  return results;
}

async function findPascalUnitFiles(rootPath) {
  const key = path.resolve(rootPath).toLowerCase();
  if (!PASCAL_FILE_DISCOVERY_CACHE.has(key)) {
    // Startup creates current-file, secondary and full indexes concurrently.
    // Share one directory walk instead of traversing the same RAD/project tree
    // for every index and again on each editor switch.
    PASCAL_FILE_DISCOVERY_CACHE.set(
      key,
      findFilesWithExtensions(rootPath, new Set(['.pas', '.pp']))
        .catch(error => {
          PASCAL_FILE_DISCOVERY_CACHE.delete(key);
          throw error;
        })
    );
  }
  return PASCAL_FILE_DISCOVERY_CACHE.get(key);
}

async function findPascalUnitFilesByName(rootPath, unitNames) {
  const wanted = new Set();
  for (const unitName of unitNames || []) {
    const key = String(unitName || '').toLowerCase();
    if (!key) continue;
    wanted.add(key);
    wanted.add(key.split('.').at(-1));
  }
  if (wanted.size === 0) return [];
  const files = await findPascalUnitFiles(rootPath);
  return files.filter(filePath => {
    const base = path.basename(filePath, path.extname(filePath)).toLowerCase();
    return wanted.has(base) || wanted.has(base.split('.').at(-1));
  });
}

async function buildDcpSymbolIndex(rootPaths) {
  const preferred = new Map();
  for (const rootPath of rootPaths) {
    for (const filePath of await findFilesWithExtensions(rootPath, new Set(['.dcp']))) {
      const key = path.basename(filePath).toLowerCase();
      const current = preferred.get(key);
      const score = value => (/trunk-win64-lib/i.test(value) ? 0 : 1000) - value.length;
      if (!current || score(filePath) > score(current)) preferred.set(key, filePath);
    }
  }

  const paths = [...preferred.values()];
  const symbols = new Map();
  for (let start = 0; start < paths.length; start += 4) {
    const parsed = await Promise.all(paths.slice(start, start + 4).map(async filePath => {
      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.size > 128 * 1024 * 1024) return [];
        const text = (await fs.promises.readFile(filePath)).toString('latin1');
        const entries = [];
        for (const match of text.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\.([TI][A-Za-z0-9_]+)\b/g)) {
          entries.push([match[2].toLowerCase(), match[1]]);
        }
        return entries;
      } catch {
        return [];
      }
    }));
    for (const entries of parsed) {
      for (const [symbol, unitName] of entries) {
        if (!symbols.has(symbol)) symbols.set(symbol, new Set());
        symbols.get(symbol).add(unitName);
      }
    }
  }
  return { fileCount: paths.length, symbols };
}

function isBodylessStructureDeclaration(code, afterKindOffset) {
  let cursor = afterKindOffset;
  while (/\s/.test(code[cursor] || '')) cursor += 1;
  if (code[cursor] === ';') return true;
  if (code[cursor] !== '(') return false;
  let depth = 0;
  for (; cursor < code.length; cursor += 1) {
    if (code[cursor] === '(') depth += 1;
    else if (code[cursor] === ')') {
      depth -= 1;
      if (depth === 0) {
        cursor += 1;
        break;
      }
    }
  }
  while (/\s/.test(code[cursor] || '')) cursor += 1;
  return code[cursor] === ';';
}

function findStructureEnd(code, bodyStart) {
  let depth = 1;
  // Only a named type declaration opens a nested structure here. The previous
  // broad `: class` branch also matched generic constraints such as `<T: class>`
  // inside method declarations, leaving the outer class permanently nested and
  // dropping all of its members from the source index.
  const tokenPattern = /^\s*(?:type\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?\s*=\s*(?:packed\s+)?(?:class(?!\s+of\b)|record|object|interface)\b|\bend\s*;/gim;
  tokenPattern.lastIndex = bodyStart;
  let token;
  while ((token = tokenPattern.exec(code))) {
    if (/^\s*end\s*;/i.test(token[0])) {
      depth -= 1;
      if (depth === 0) return token.index;
    } else if (!isBodylessStructureDeclaration(code, tokenPattern.lastIndex)) {
      depth += 1;
    }
  }
  return -1;
}

function maskNestedStructures(body) {
  const result = body.split('');
  const tokenPattern = /^\s*(?:type\s+)?[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?\s*=\s*(?:packed\s+)?(?:class(?!\s+of\b)|record|object|interface)\b|\bend\s*;/gim;
  let depth = 0;
  let nestedStart = -1;
  let token;
  while ((token = tokenPattern.exec(body))) {
    if (/^\s*end\s*;/i.test(token[0])) {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && nestedStart >= 0) {
        for (let index = nestedStart; index < tokenPattern.lastIndex; index += 1) {
          if (result[index] !== '\r' && result[index] !== '\n') result[index] = ' ';
        }
        nestedStart = -1;
      }
    } else {
      if (isBodylessStructureDeclaration(body, tokenPattern.lastIndex)) continue;
      if (depth === 0) nestedStart = token.index;
      depth += 1;
    }
  }
  return result.join('');
}

function parseSourceUnitSymbols(text, filePath, preparedCode, options = {}) {
  const code = preparedCode || maskPascalNonCode(text);
  const unitMatch = /\bunit\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/i.exec(code);
  const unitName = unitMatch?.[1];
  if (!unitName) return undefined;
  const implementation = /\bimplementation\b/i.exec(code);
  const includeImplementationSymbols = Boolean(
    options.includeImplementationSymbols || options.includeImplementationTypes
  );
  const publicCode = implementation ? code.slice(0, implementation.index) : code;
  const symbols = new Set([unitName]);
  const definitions = [];
  const types = [];
  const members = [];
  const lineStarts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lineStarts.push(index + 1);
  }
  const sourcePositionAt = offset => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (lineStarts[middle] <= offset) low = middle + 1;
      else high = middle - 1;
    }
    const line = Math.max(0, high);
    return { line, character: offset - lineStarts[line] };
  };

  const addDefinition = (symbol, offset, kind = 'symbol', extra = {}) => {
    symbols.add(symbol);
    const position = sourcePositionAt(offset);
    const definition = {
      symbol,
      unitName,
      filePath,
      offset,
      length: symbol.length,
      line: position.line,
      character: position.character,
      kind,
      ...extra
    };
    definitions.push(definition);
    return definition;
  };

  const applyTypeDeclarationMetadata = (definition, genericText, rightHandSide) => {
    definition.typeParameters = String(genericText || '')
      .split(/[;,]/)
      .map(item => item.trim().split(':')[0].trim())
      .filter(item => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item));
    const element = /\barray(?:\s*\[[^\]]*\])?\s+of\s+([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/i
      .exec(rightHandSide || '');
    if (element) definition.elementType = element[1].trim();
    const alias = /^\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/
      .exec(rightHandSide || '');
    if (alias && !/^(?:class|record|object|interface|procedure|function|reference|set|file)$/i
      .test(alias[1])) {
      definition.aliasedType = alias[1].replace(/\s+/g, '');
      definition.elementType ||= inferPascalCollectionElementType(definition.aliasedType);
    }
  };

  addDefinition(unitName, unitMatch.index + unitMatch[0].indexOf(unitName), 'unit');

  for (const match of publicCode.matchAll(/^\s*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_.]*)/gim)) {
    const qualifiedName = match[1];
    const symbol = qualifiedName.split('.').at(-1);
    const offset = match.index + match[0].lastIndexOf(symbol);
    const signature = extractPascalRoutineSignature(text, offset, code);
    addDefinition(symbol, offset, 'routine', {
      signature,
      typeName: pascalRoutineReturnType(signature)
    });
  }

  let section = '';
  let lineOffset = 0;
  // Computing this inside the line loop made a 50,000-line source call
  // String.includes over the complete 1.5 MB document for every line.
  const eolWidth = text.includes('\r\n') ? 2 : 1;
  for (const line of publicCode.split(/\r?\n/)) {
    // A section header occupies its own logical line. Accepting any line that
    // merely starts with `var` mistakes multiline routine parameters for a
    // global var section and makes later type aliases disappear from the index.
    const sectionMatch = /^\s*(const|resourcestring|var|threadvar|type)\s*$/i.exec(line);
    if (sectionMatch) section = sectionMatch[1].toLowerCase();
    if (section === 'type') {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<([^=\r\n]*)>)?\s*=\s*(.*)$/.exec(line);
      if (match) {
        const definition = addDefinition(match[1], lineOffset + line.indexOf(match[1]), 'type');
        applyTypeDeclarationMetadata(definition, match[2], match[3]);
        types.push(definition);
      }
    } else if (section === 'const' || section === 'resourcestring') {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/.exec(line);
      if (match) addDefinition(match[1], lineOffset + line.indexOf(match[1]), 'constant');
    } else if (section === 'var' || section === 'threadvar') {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*)/.exec(line);
      if (match) {
        for (const name of match[1].split(',').map(item => item.trim())) {
          addDefinition(name, lineOffset + line.indexOf(name), 'variable', { typeName: match[2] });
        }
      }
    }
    lineOffset += line.length + eolWidth;
  }

  if (includeImplementationSymbols && implementation) {
    let implementationSection = '';
    let implementationLineOffset = implementation.index;
    const implementationCode = code.slice(implementation.index);
    for (const line of implementationCode.split(/\r?\n/)) {
      const sectionMatch = /^\s*(type|const|resourcestring|var|threadvar)\s*$/i.exec(line);
      const sectionBoundary = /^\s*(?:implementation|uses|procedure|function|constructor|destructor|operator|initialization|finalization|begin)\b/i.test(line);
      if (sectionMatch) implementationSection = sectionMatch[1].toLowerCase();
      else if (sectionBoundary) implementationSection = '';

      if (implementationSection === 'type') {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<([^=\r\n]*)>)?\s*=\s*(.*)$/.exec(line);
        if (match) {
          const offset = implementationLineOffset + line.indexOf(match[1]);
          if (!definitions.some(item => item.offset === offset && item.kind === 'type')) {
            const definition = addDefinition(match[1], offset, 'type');
            applyTypeDeclarationMetadata(definition, match[2], match[3]);
            types.push(definition);
          }
        }
      } else if (implementationSection === 'const' || implementationSection === 'resourcestring') {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/.exec(line);
        if (match) addDefinition(match[1], implementationLineOffset + line.indexOf(match[1]), 'constant');
      } else if (implementationSection === 'var' || implementationSection === 'threadvar') {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*)/.exec(line);
        if (match) {
          for (const name of match[1].split(',').map(item => item.trim())) {
            addDefinition(name, implementationLineOffset + line.indexOf(name), 'variable', {
              typeName: match[2]
            });
          }
        }
      }
      implementationLineOffset += line.length + eolWidth;
    }
  }

  // `TWidgetClass = class of TWidget` is a metaclass alias, not a class body.
  // Treating it as a structure made findStructureEnd consume every following
  // declaration up to a distant `end;`, then ran three member regexes over the
  // same huge overlapping ranges. CADGks.pas spent tens of seconds here.
  const structurePattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^=\r\n]*>)?\s*=\s*(?:packed\s+)?(class(?!\s+of\b)|record|object|interface)(?:\s+helper\s+for\s+([A-Za-z_][A-Za-z0-9_.<>]*))?(?:\s*\(([^)]*)\))?/gim;
  const enumPattern = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\(([\s\S]*?)\)\s*;/gim;
  const parseStructures = (structureCode, baseOffset = 0) => {
    for (const match of structureCode.matchAll(structurePattern)) {
      const owner = match[1];
      const ownerOffset = baseOffset + match.index + match[0].indexOf(owner);
      let typeDefinition = types.find(item => item.offset === ownerOffset);
      if (!typeDefinition) {
        typeDefinition = addDefinition(owner, ownerOffset, 'type');
        types.push(typeDefinition);
      }
      typeDefinition.structureKind = match[2].toLowerCase();
      typeDefinition.helperTarget = match[3]?.trim();
      const genericHeader = match[0].slice(0, match[0].indexOf('='));
      const genericParameters = /<([^>]*)>/.exec(genericHeader)?.[1] || '';
      typeDefinition.typeParameters = genericParameters
        .split(/[;,]/)
        .map(item => item.trim().split(':')[0].trim())
        .filter(item => /^[A-Za-z_][A-Za-z0-9_]*$/.test(item));
      const baseTypes = [match[3], ...(match[4] || '').split(',')]
        .map(item => item?.trim()).filter(Boolean);
      if (typeDefinition.structureKind === 'class'
        && !typeDefinition.helperTarget
        && owner.toLowerCase() !== 'tobject'
        && baseTypes.length === 0) {
        baseTypes.push('TObject');
      }
      typeDefinition.baseTypes = baseTypes;
      const bodyStart = match.index + match[0].length;
      // Delphi import units contain long lists such as `IFoo = interface;`.
      // Delphi also permits body-less descendants such as
      // `EGraphics = class(Exception);` and generic forms like
      // `TFooList = class(TList<TFoo>);`.
      if (isBodylessStructureDeclaration(structureCode, bodyStart)) continue;
      const bodyEnd = findStructureEnd(structureCode, bodyStart);
      if (bodyEnd < 0) continue;
      const body = maskNestedStructures(structureCode.slice(bodyStart, bodyEnd));
      const addMember = (name, relativeOffset, kind, typeName, extra = {}) => {
        const absoluteOffset = baseOffset + bodyStart + relativeOffset;
        const definition = addDefinition(name, absoluteOffset, kind, { owner, typeName });
        Object.assign(definition, extra);
        members.push(definition);
        return definition;
      };
      // Leading `\s*` can cross line boundaries. On a large class body it
      // causes catastrophic multiline backtracking at almost every line; only
      // horizontal indentation is valid before a declaration here.
      for (const property of body.matchAll(/^[ \t]*property\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[[^\]]*\])?\s*:\s*([A-Za-z_][A-Za-z0-9_.]*(?:\s*<[^;=()]+>)?)/gim)) {
        addMember(property[1], property.index + property[0].lastIndexOf(property[1]), 'property', property[2]);
      }
      for (const routine of body.matchAll(/^[ \t]*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_]*)/gim)) {
        const relativeOffset = routine.index + routine[0].lastIndexOf(routine[1]);
        const absoluteOffset = baseOffset + bodyStart + relativeOffset;
        const signature = extractPascalRoutineSignature(text, absoluteOffset, code);
        addMember(routine[1], relativeOffset, 'routine', pascalRoutineReturnType(signature), {
          signature
        });
      }
      for (const field of body.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([A-Za-z_][A-Za-z0-9_.<>]*)\s*;/gim)) {
        for (const name of field[1].split(',').map(item => item.trim())) {
          addMember(name, field.index + field[0].indexOf(name), 'field', field[2]);
        }
      }
    }

    for (const match of structureCode.matchAll(enumPattern)) {
      const owner = match[1];
      const ownerOffset = baseOffset + match.index + match[0].indexOf(owner);
      let typeDefinition = types.find(item => item.offset === ownerOffset);
      if (!typeDefinition) {
        typeDefinition = addDefinition(owner, ownerOffset, 'type');
        types.push(typeDefinition);
      }
      typeDefinition.structureKind = 'enum';
      const body = match[2];
      const bodyOffset = baseOffset + match.index + match[0].indexOf(body);
      for (const item of body.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
        const name = item[1];
        const offset = bodyOffset + item.index + item[0].lastIndexOf(name);
        const definition = addDefinition(name, offset, 'enumMember', { owner, typeName: owner });
        members.push(definition);
      }
    }
  };

  parseStructures(publicCode);
  // Project indexes remain interface-only. The active document additionally
  // parses just the implementation slice, avoiding a second O(file) pass over
  // every public type while still making private types immediately available.
  if (includeImplementationSymbols && implementation) {
    parseStructures(code.slice(implementation.index), implementation.index);
  }

  // Attach implementation-body locations to public routine declarations. This
  // lets the companion answer Ctrl+Click without waiting for the LSP queue while
  // still preserving Delphi's interface declaration as the canonical symbol.
  if (implementation) {
    const implementationCode = code.slice(implementation.index);
    const routineDefinitions = definitions.filter(item => item.kind === 'routine');
    const occurrenceByKey = new Map();
    const implementationPattern = /^\s*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)/gim;
    for (const match of implementationCode.matchAll(implementationPattern)) {
      const qualifiedName = match[1];
      const parts = qualifiedName.split('.').map(part => part.replace(/\s*<.*>\s*$/, ''));
      const symbol = parts.at(-1);
      const owner = parts.length > 1 ? parts.at(-2) : undefined;
      let candidates = routineDefinitions.filter(item =>
        item.symbol.toLowerCase() === symbol.toLowerCase());
      if (owner) {
        const owned = candidates.filter(item =>
          item.owner?.toLowerCase().split('.').at(-1) === owner.toLowerCase());
        if (owned.length > 0) candidates = owned;
      } else {
        const unowned = candidates.filter(item => !item.owner);
        if (unowned.length > 0) candidates = unowned;
      }
      const implementationOffset = implementation.index + match.index
        + match[0].lastIndexOf(symbol);
      if (candidates.length === 0) {
        if (includeImplementationSymbols && !owner) {
          const definition = addDefinition(symbol, implementationOffset, 'routine', {
            signature: extractPascalRoutineSignature(text, implementationOffset, code)
          });
          routineDefinitions.push(definition);
        }
        continue;
      }
      const occurrenceKey = `${owner?.toLowerCase() || ''}.${symbol.toLowerCase()}`;
      const ordinal = occurrenceByKey.get(occurrenceKey) || 0;
      occurrenceByKey.set(occurrenceKey, ordinal + 1);
      const definition = candidates[Math.min(ordinal, candidates.length - 1)];
      const position = sourcePositionAt(implementationOffset);
      definition.implementationOffset = implementationOffset;
      definition.implementationLine = position.line;
      definition.implementationCharacter = position.character;
    }
  }
  return { unitName, symbols, definitions, types, members };
}

async function buildSourceUnitIndexFromFiles(paths) {
  const uniquePaths = [];
  const seenPaths = new Set();
  for (const filePath of paths) {
    const key = path.resolve(filePath).toLowerCase();
    if (!seenPaths.has(key)) {
      seenPaths.add(key);
      uniquePaths.push(filePath);
    }
  }

  paths = uniquePaths;
  const index = new Map();
  const definitions = new Map();
  const types = new Map();
  const members = new Map();
  const units = new Map();
  const sourceParserWorker = createSourceParserWorker();
  try {
    for (let start = 0; start < paths.length; start += 32) {
      const batch = paths.slice(start, start + 32);
      const sources = await Promise.all(batch.map(async filePath => {
        try {
          const stat = await fs.promises.stat(filePath);
          if (stat.size > 4 * 1024 * 1024) return undefined;
          return { filePath, text: decodePascalBytes(await fs.promises.readFile(filePath)) };
        } catch {
          return undefined;
        }
      }));
      for (const source of sources.filter(Boolean)) {
        // Parsing a batch in Promise continuations starves commands registered by
        // this extension: microtasks run before the setImmediate checkpoints used
        // by coloring. Keep file I/O parallel, yield between small units, and move
        // large generated SDK units off the extension-host thread entirely.
        await new Promise(resolve => setImmediate(resolve));
        const unit = source.text.length >= OFF_THREAD_PARSE_BYTES
          ? await sourceParserWorker.parse(source.text, source.filePath)
          : parseSourceUnitSymbols(source.text, source.filePath);
        if (!unit) continue;
        const unitDefinition = unit.definitions.find(item => item.kind === 'unit');
        for (const unitKey of [unit.unitName.toLowerCase(), unit.unitName.toLowerCase().split('.').at(-1)]) {
          if (!units.has(unitKey)) units.set(unitKey, []);
          units.get(unitKey).push(unitDefinition);
        }
        for (const symbol of unit.symbols) {
          const key = symbol.toLowerCase();
          if (!index.has(key)) index.set(key, new Set());
          index.get(key).add(unit.unitName);
        }
        for (const definition of unit.definitions) {
          const key = definition.symbol.toLowerCase();
          if (!definitions.has(key)) definitions.set(key, []);
          definitions.get(key).push(definition);
        }
        for (const definition of unit.types) {
          const key = definition.symbol.toLowerCase();
          if (!types.has(key)) types.set(key, []);
          types.get(key).push(definition);
        }
        for (const definition of unit.members) {
          const ownerKey = definition.owner.toLowerCase();
          if (!members.has(ownerKey)) members.set(ownerKey, new Map());
          const memberKey = definition.symbol.toLowerCase();
          if (!members.get(ownerKey).has(memberKey)) members.get(ownerKey).set(memberKey, []);
          members.get(ownerKey).get(memberKey).push(definition);
        }
      }
    }
  } finally {
    await sourceParserWorker.dispose();
  }
  return {
    fileCount: paths.length,
    files: new Set(paths.map(filePath => path.resolve(filePath).toLowerCase())),
    symbols: index,
    definitions,
    types,
    members,
    units
  };
}

function serializeSourceUnitIndex(index) {
  return {
    fileCount: index.fileCount,
    files: [...index.files],
    symbols: [...index.symbols].map(([key, values]) => [key, [...values]]),
    definitions: [...index.definitions],
    types: [...index.types],
    members: [...index.members].map(([owner, values]) => [owner, [...values]]),
    units: [...index.units]
  };
}

function deserializeSourceUnitIndex(value) {
  if (!value || typeof value !== 'object') return undefined;
  return {
    fileCount: Number(value.fileCount) || 0,
    files: new Set(value.files || []),
    symbols: new Map((value.symbols || []).map(([key, values]) => [key, new Set(values)])),
    definitions: new Map(value.definitions || []),
    types: new Map(value.types || []),
    members: new Map((value.members || []).map(([owner, values]) => [owner, new Map(values)])),
    units: new Map(value.units || [])
  };
}

async function sourceFilesFingerprint(paths) {
  const identities = [];
  for (let start = 0; start < paths.length; start += 64) {
    const batch = await Promise.all(paths.slice(start, start + 64).map(async filePath => {
      try {
        const stat = await fs.promises.stat(filePath);
        return `${path.resolve(filePath).toLowerCase()}:${stat.size}:${Math.trunc(stat.mtimeMs)}`;
      } catch {
        return `${path.resolve(filePath).toLowerCase()}:missing`;
      }
    }));
    identities.push(...batch);
  }
  return createHash('sha256').update(identities.sort().join('|')).digest('hex');
}

async function readSourceIndexCache(cachePath, fingerprint) {
  if (!cachePath) return undefined;
  try {
    const compressed = await fs.promises.readFile(cachePath);
    const stored = JSON.parse((await gunzipAsync(compressed)).toString('utf8'));
    if (stored.version !== SOURCE_INDEX_CACHE_VERSION || stored.fingerprint !== fingerprint) {
      return undefined;
    }
    return deserializeSourceUnitIndex(stored.index);
  } catch {
    return undefined;
  }
}

async function writeSourceIndexCache(cachePath, fingerprint, index) {
  if (!cachePath) return;
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(cachePath), { recursive: true });
    const serialized = JSON.stringify({
      version: SOURCE_INDEX_CACHE_VERSION,
      fingerprint,
      createdAt: Date.now(),
      index: serializeSourceUnitIndex(index)
    });
    await fs.promises.writeFile(temporaryPath, await gzipAsync(Buffer.from(serialized, 'utf8')));
    await fs.promises.rm(cachePath, { force: true });
    await fs.promises.rename(temporaryPath, cachePath);
  } catch {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function buildSourceUnitIndex(rootPaths, options = {}) {
  const startedAt = Date.now();
  const paths = [];
  const seenPaths = new Set();
  const discoveredByRoot = await Promise.all(rootPaths.map(findPascalUnitFiles));
  for (const discovered of discoveredByRoot) {
    for (const filePath of discovered) {
      const key = path.resolve(filePath).toLowerCase();
      if (!seenPaths.has(key)) {
        seenPaths.add(key);
        paths.push(filePath);
      }
    }
  }
  const fingerprint = options.cachePath ? await sourceFilesFingerprint(paths) : undefined;
  const cached = await readSourceIndexCache(options.cachePath, fingerprint);
  if (cached) {
    cached.cacheHit = true;
    cached.cacheElapsedMs = Date.now() - startedAt;
    return cached;
  }
  if (options.buildGate) await options.buildGate;
  const index = await buildSourceUnitIndexFromFiles(paths);
  index.cacheHit = false;
  index.cacheElapsedMs = Date.now() - startedAt;
  await writeSourceIndexCache(options.cachePath, fingerprint, index);
  return index;
}

async function buildSourceUnitIndexForUnits(rootPaths, unitNames) {
  const discovered = await Promise.all(
    rootPaths.map(rootPath => findPascalUnitFilesByName(rootPath, unitNames))
  );
  return buildSourceUnitIndexFromFiles(discovered.flat());
}

function mergeSourceUnitIndexes(target, ...sources) {
  const mergeArrayMap = (targetMap, sourceMap) => {
    for (const [key, values] of sourceMap) {
      if (!targetMap.has(key)) targetMap.set(key, []);
      const existing = targetMap.get(key);
      const identities = new Set(existing.map(value =>
        `${String(value.filePath || '').toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`));
      for (const value of values) {
        const identity = `${String(value.filePath || '').toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`;
        if (identities.has(identity)) continue;
        identities.add(identity);
        existing.push(value);
      }
    }
  };
  for (const source of sources) {
    if (!source) continue;
    if (target.files && source.files) {
      for (const filePath of source.files) target.files.add(filePath);
      target.fileCount = target.files.size;
    } else {
      target.fileCount += source.fileCount;
    }
    for (const [key, values] of source.symbols) {
      if (!target.symbols.has(key)) target.symbols.set(key, new Set());
      for (const value of values) target.symbols.get(key).add(value);
    }
    mergeArrayMap(target.definitions, source.definitions);
    mergeArrayMap(target.types, source.types);
    mergeArrayMap(target.units, source.units);
    for (const [owner, sourceMembers] of source.members) {
      if (!target.members.has(owner)) target.members.set(owner, new Map());
      mergeArrayMap(target.members.get(owner), sourceMembers);
    }
  }
  return target;
}

async function mergeSourceUnitIndexesAsync(target, ...sources) {
  let operations = 0;
  const maybeYield = () => {
    operations += 1;
    return operations % 256 === 0
      ? new Promise(resolve => setImmediate(resolve))
      : undefined;
  };
  const mergeArrayMap = async (targetMap, sourceMap) => {
    for (const [key, values] of sourceMap) {
      if (!targetMap.has(key)) targetMap.set(key, []);
      const existing = targetMap.get(key);
      const identities = new Set(existing.map(value =>
        `${String(value.filePath || '').toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`));
      for (const value of values) {
        const identity = `${String(value.filePath || '').toLowerCase()}:${value.offset}:${value.kind}:${value.symbol}`;
        if (identities.has(identity)) continue;
        identities.add(identity);
        existing.push(value);
      }
      const pause = maybeYield();
      if (pause) await pause;
    }
  };
  for (const source of sources) {
    if (!source) continue;
    if (target.files && source.files) {
      for (const filePath of source.files) target.files.add(filePath);
      target.fileCount = target.files.size;
    } else {
      target.fileCount += source.fileCount;
    }
    for (const [key, values] of source.symbols) {
      if (!target.symbols.has(key)) target.symbols.set(key, new Set());
      for (const value of values) target.symbols.get(key).add(value);
      const pause = maybeYield();
      if (pause) await pause;
    }
    await mergeArrayMap(target.definitions, source.definitions);
    await mergeArrayMap(target.types, source.types);
    await mergeArrayMap(target.units, source.units);
    for (const [owner, sourceMembers] of source.members) {
      if (!target.members.has(owner)) target.members.set(owner, new Map());
      await mergeArrayMap(target.members.get(owner), sourceMembers);
    }
  }
  return target;
}

function unknownSymbolFromDiagnostic(message) {
  return /\b(?:unknown (?:identifier|type)|undeclared identifier|identifier not found)\b[^'"]*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/i.exec(message)?.[1];
}

function pascalRoutineDeclarationIdentifierOffsets(code) {
  const offsets = new Set();
  const declarationPattern = /^\s*(?:class\s+)?(?:function|procedure|constructor|destructor|operator)\s+([A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?(?:\s*\.\s*[A-Za-z_][A-Za-z0-9_]*(?:\s*<[^>\r\n]*>)?)*)/gim;
  for (const declaration of code.matchAll(declarationPattern)) {
    const name = declaration[1];
    const nameOffset = declaration.index + declaration[0].indexOf(name);

    // Names in `function TFoo<T>.IsValid: Boolean` are declarations, not type
    // references, even when a name happens to begin with T or I.
    for (const segment of name.matchAll(/(?:^|\.)\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
      offsets.add(nameOffset + segment.index + segment[0].lastIndexOf(segment[1]));
    }

    // Generic parameters are declarations too. Keep constraint types visible:
    // in `<TItem: IFoo>`, TItem is ignored while IFoo remains a real reference.
    for (const generic of name.matchAll(/<([^>]*)>/g)) {
      const body = generic[1];
      const bodyOffset = nameOffset + generic.index + generic[0].indexOf(body);
      let groupOffset = 0;
      for (const group of body.split(';')) {
        const parameterNames = group.split(':', 1)[0];
        for (const parameter of parameterNames.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
          offsets.add(bodyOffset + groupOffset + parameter.index);
        }
        groupOffset += group.length + 1;
      }
    }
  }
  return offsets;
}

function isPascalRoutineDeclarationIdentifier(text, offset, preparedCode) {
  const code = preparedCode || maskPascalNonCode(text);
  return pascalRoutineDeclarationIdentifierOffsets(code).has(offset);
}

function pascalUnitNameFromCode(code) {
  return /\bunit\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/i.exec(code)?.[1]?.toLowerCase();
}

function usedUnitVisibility(usedUnits) {
  const exact = new Set();
  const unqualifiedLeaves = new Set();
  const allLeaves = new Set();
  for (const unitName of usedUnits || []) {
    const key = String(unitName || '').toLowerCase();
    if (!key) continue;
    exact.add(key);
    allLeaves.add(key.split('.').at(-1));
    if (!key.includes('.')) unqualifiedLeaves.add(key);
  }
  return unitName => {
    const key = String(unitName || '').toLowerCase();
    if (!key) return false;
    if (exact.has(key)) return true;
    const leaf = key.split('.').at(-1);
    if (unqualifiedLeaves.has(leaf)) return true;
    return !key.includes('.') && allLeaves.has(leaf);
  };
}

function findMissingUnitReferences(text, symbolIndex) {
  const code = maskPascalNonCode(text);
  const routineDeclarationOffsets = pascalRoutineDeclarationIdentifierOffsets(code);
  const usedUnits = new Set(parseUsesUnits(text));
  // Delphi implicitly imports System into every program and unit. Symbols such
  // as TObject must never produce an Add Unit diagnostic.
  usedUnits.add('system');
  const ownUnit = pascalUnitNameFromCode(code);
  const unitIsVisible = usedUnitVisibility(usedUnits);
  const declared = new Set();
  for (const match of code.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^=\r\n]*>)?\s*=\s*/gim)) {
    declared.add(match[1].toLowerCase());
  }

  const references = [];
  let scannedOffset = 0;
  let previousNonWhitespace = -1;
  for (const match of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    while (scannedOffset < match.index) {
      if (!/\s/.test(code[scannedOffset])) previousNonWhitespace = scannedOffset;
      scannedOffset += 1;
    }
    const key = match[0].toLowerCase();
    if (declared.has(key) || isPascalIntrinsicIdentifier(key)
      || routineDeclarationOffsets.has(match.index)) continue;
    // This used to slice and rescan the whole prefix for every identifier.
    // On a 1.5 MB Unit that is O(n²) and blocked the extension host for
    // 6–8 minutes. The monotonic cursor computes the same fact in one pass.
    if (previousNonWhitespace >= 0 && code[previousNonWhitespace] === '.') continue;
    const candidates = filterAddUnitCandidates(symbolIndex.get(key), ownUnit);
    if (candidates.length === 0 || candidates.some(unitIsVisible)) continue;
    references.push({ offset: match.index, length: match[0].length, symbol: match[0], units: candidates });
  }
  return references;
}

function findKnownUnitReferences(text, symbolIndex) {
  const code = maskPascalNonCode(text);
  const routineDeclarationOffsets = pascalRoutineDeclarationIdentifierOffsets(code);
  const usedUnits = new Set(parseUsesUnits(text));
  usedUnits.add('system');
  const ownUnit = pascalUnitNameFromCode(code);
  const unitIsVisible = usedUnitVisibility(usedUnits);
  const references = [];
  for (const match of code.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*\b/g)) {
    const key = match[0].toLowerCase();
    if (isPascalIntrinsicIdentifier(key) || routineDeclarationOffsets.has(match.index)) continue;
    const candidates = symbolIndex.get(key);
    if (!candidates) continue;
    if (![...candidates].some(unitName => pascalUnitNamesEquivalent(unitName, ownUnit)
      || unitIsVisible(unitName))) continue;
    references.push({ offset: match.index, length: match[0].length, symbol: match[0] });
  }
  return references;
}

function planUsesInsertion(text, diagnosticOffset, unitName) {
  if (!unitName || isImplicitPascalUnit(unitName)
    || parseUsesUnits(text).some(usedUnit => pascalUnitNamesEquivalent(unitName, usedUnit))) return undefined;
  const code = maskPascalNonCode(text);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const interfaceMatch = /\binterface\b/i.exec(code);
  const implementationMatch = /\bimplementation\b/i.exec(code);
  let sectionStart = 0;
  let sectionEnd = code.length;
  let useImplementation = false;

  if (interfaceMatch) {
    useImplementation = Boolean(implementationMatch && diagnosticOffset > implementationMatch.index);
    sectionStart = useImplementation ? implementationMatch.index : interfaceMatch.index;
    sectionEnd = useImplementation || !implementationMatch ? code.length : implementationMatch.index;
  }

  const insertionForUses = (usesMatch, baseOffset) => {
    const semicolonOffset = baseOffset + usesMatch.index + usesMatch[0].lastIndexOf(';');
    const actualClause = text.slice(baseOffset + usesMatch.index, semicolonOffset);
    const trailingComma = /,\s*$/.test(actualClause);
    if (/\r?\n/.test(actualClause)) {
      const indentation = /(?:^|\r?\n)([ \t]+)[^\r\n]*$/.exec(actualClause)?.[1] || '  ';
      return { offset: semicolonOffset, text: `${trailingComma ? '' : ','}${eol}${indentation}${unitName}` };
    }
    return { offset: semicolonOffset, text: `${trailingComma ? '' : ','} ${unitName}` };
  };

  const section = code.slice(sectionStart, sectionEnd);
  const usesMatch = /\buses\b([\s\S]*?);/i.exec(section);
  if (usesMatch) {
    return insertionForUses(usesMatch, sectionStart);
  }
  if (useImplementation && interfaceMatch && implementationMatch) {
    const interfaceSection = code.slice(interfaceMatch.index, implementationMatch.index);
    const interfaceUses = /\buses\b([\s\S]*?);/i.exec(interfaceSection);
    if (interfaceUses) return insertionForUses(interfaceUses, interfaceMatch.index);
  }

  let anchor;
  if (interfaceMatch) {
    anchor = useImplementation && implementationMatch ? implementationMatch : interfaceMatch;
  } else {
    anchor = /\b(?:program|library|package)\s+[A-Za-z_][A-Za-z0-9_.]*\s*;/i.exec(code);
  }
  if (!anchor) return undefined;
  const lineEnd = text.indexOf('\n', anchor.index + anchor[0].length);
  const offset = lineEnd < 0 ? anchor.index + anchor[0].length : lineEnd + 1;
  return { offset, text: `${eol}uses${eol}  ${unitName};${eol}` };
}

module.exports = {
  buildDcpSymbolIndex,
  buildSourceUnitIndex,
  buildSourceUnitIndexForUnits,
  mergeSourceUnitIndexes,
  mergeSourceUnitIndexesAsync,
  filterAddUnitCandidates,
  findSourceMemberDefinitions,
  findKnownUnitReferences,
  findMissingUnitReferences,
  findPascalUnitFiles,
  isImplicitPascalUnit,
  isPascalIntrinsicIdentifier,
  isPascalRoutineDeclarationIdentifier,
  pascalUnitNamesEquivalent,
  parseSourceUnitSymbols,
  planUsesInsertion,
  selectBestPascalDefinitions,
  sourceTypeUnitIndex,
  unknownSymbolFromDiagnostic
};
