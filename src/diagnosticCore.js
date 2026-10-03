'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { decodeXml, normalizeKey } = require('./projectDiscovery');

function xmlValue(xml, name) {
  const expression = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i');
  return expression.exec(xml)?.[1] ? decodeXml(expression.exec(xml)[1]).trim() : undefined;
}

function expandSimpleProperties(value, properties) {
  let result = value || '';
  for (let pass = 0; pass < 8; pass += 1) {
    const next = result.replace(/\$\(([^)]+)\)/g, (whole, name) => properties[name.toLowerCase()] ?? whole);
    if (next === result) break;
    result = next;
  }
  return result;
}

function excludeManagedSourcePaths(paths, managedPaths) {
  const managedKeys = new Set((managedPaths || [])
    .filter(value => typeof value === 'string' && value.trim())
    .map(normalizeKey));
  const result = [];
  const seen = new Set();
  for (const value of paths || []) {
    if (typeof value !== 'string' || !value.trim() || /\$\([^)]+\)/.test(value)) continue;
    const resolved = path.resolve(value);
    const key = normalizeKey(resolved);
    if (managedKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function compilerEnvironmentWithSearchPath(environment, searchPaths) {
  const result = { ...(environment || {}) };
  for (const key of Object.keys(result)) {
    if (key.toLowerCase() === 'dcc_unitsearchpath') delete result[key];
  }
  if (searchPaths?.length) result.DCC_UnitSearchPath = searchPaths.join(';');
  return result;
}

function conditionMatches(condition, properties) {
  if (!condition) return true;
  const expanded = expandSimpleProperties(decodeXml(condition), properties).replace(/\$\([^)]+\)/g, '');
  if (!/^[\s()'"=!<>&|A-Za-z0-9_.:\\/-]+$/.test(expanded)) return false;
  const expression = expanded.replace(/\band\b/gi, '&&').replace(/\bor\b/gi, '||');
  try {
    return Boolean(Function(`"use strict"; return (${expression});`)());
  } catch {
    return false;
  }
}

function evaluateProjectProperties(xml, overrides = {}) {
  const properties = {};
  if (overrides.configuration && overrides.configuration !== 'auto') properties.config = overrides.configuration;
  if (overrides.platform && overrides.platform !== 'auto') properties.platform = overrides.platform;
  for (const group of xml.matchAll(/<PropertyGroup\b([^>]*)>([\s\S]*?)<\/PropertyGroup>/gi)) {
    const condition = /\bCondition\s*=\s*(["'])(.*?)\1/i.exec(group[1])?.[2];
    if (!conditionMatches(condition, properties)) continue;
    for (const property of group[2].matchAll(/<([A-Za-z_][A-Za-z0-9_.-]*)\b([^>]*)>([\s\S]*?)<\/\1>/g)) {
      const propertyCondition = /\bCondition\s*=\s*(["'])(.*?)\1/i.exec(property[2])?.[2];
      if (!conditionMatches(propertyCondition, properties)) continue;
      const key = property[1].toLowerCase();
      if ((key === 'config' && overrides.configuration && overrides.configuration !== 'auto')
        || (key === 'platform' && overrides.platform && overrides.platform !== 'auto')) continue;
      properties[key] = expandSimpleProperties(decodeXml(property[3]).trim(), properties);
    }
  }
  properties.config ||= 'Debug';
  properties.platform ||= 'Win32';
  return properties;
}

function readProjectInfo(projectPath, overrides = {}) {
  const xml = fs.readFileSync(projectPath, 'utf8');
  const projectDir = path.dirname(projectPath);
  const baseProperties = evaluateProjectProperties(xml, overrides);
  const mainSourceValue = baseProperties.mainsource || xmlValue(xml, 'MainSource');
  const mainSource = mainSourceValue
    ? path.resolve(projectDir, expandSimpleProperties(mainSourceValue, baseProperties))
    : undefined;
  const references = [];
  for (const match of xml.matchAll(/<DCCReference\b[^>]*\bInclude\s*=\s*(["'])(.*?)\1/gi)) {
    const value = decodeXml(match[2]).trim();
    if (/\.(?:pas|pp|inc)$/i.test(value)) references.push(path.resolve(projectDir, value));
  }
  if (mainSource && fs.existsSync(mainSource)) {
    const mainText = fs.readFileSync(mainSource, 'utf8');
    for (const match of mainText.matchAll(/\b(?:in)\s*'((?:''|[^'])+)'/gi)) {
      references.push(path.resolve(path.dirname(mainSource), match[1].replace(/''/g, "'")));
    }
  }
  const searchPaths = [];
  for (const value of [baseProperties.dcc_unitsearchpath, baseProperties.dcc_includepath, baseProperties.dcc_resourcepath].filter(Boolean)) {
    for (const segment of value.split(';')) {
      const expanded = expandSimpleProperties(segment.trim(), baseProperties);
      if (expanded && !/\$\([^)]+\)/.test(expanded)) {
        searchPaths.push(path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(projectDir, expanded));
      }
    }
  }
  const defines = new Set();
  for (const item of (baseProperties.dcc_define || '').replace(/\$\([^)]+\)/g, '').split(';')) {
    if (item.trim()) defines.add(item.trim().toUpperCase());
  }
  defines.add(baseProperties.platform.toUpperCase());
  if (/win32/i.test(baseProperties.platform)) defines.add('MSWINDOWS');
  if (/win64/i.test(baseProperties.platform)) defines.add('MSWINDOWS');
  return {
    projectPath: path.resolve(projectPath),
    projectDir,
    mainSource,
    configuration: baseProperties.config,
    platform: baseProperties.platform,
    references: [...new Map(references.map(item => [normalizeKey(item), path.resolve(item)])).values()],
    searchPaths: [...new Map(searchPaths.map(item => [normalizeKey(item), item])).values()],
    defines: [...defines]
  };
}

function readActiveProject(workspaceRoot) {
  const filePath = path.join(workspaceRoot, '.vallenta', 'projects.local.json');
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value?.activeProject?.projectPath ? path.resolve(value.activeProject.projectPath) : undefined;
  } catch {
    return undefined;
  }
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveOwningProject(filePath, projects, activeProjectPath) {
  const fileKey = normalizeKey(filePath);
  const activeKey = activeProjectPath ? normalizeKey(activeProjectPath) : undefined;
  const direct = projects.filter(project => project.references.some(item => normalizeKey(item) === fileKey)
    || (project.mainSource && normalizeKey(project.mainSource) === fileKey));
  const activeDirect = direct.find(project => normalizeKey(project.projectPath) === activeKey);
  if (activeDirect) return activeDirect;
  if (direct.length > 0) return direct[0];
  const containing = projects.filter(project => pathIsInside(project.projectDir, filePath))
    .sort((left, right) => right.projectDir.length - left.projectDir.length);
  const activeContaining = containing.find(project => normalizeKey(project.projectPath) === activeKey);
  return activeContaining || containing[0];
}

function pascalQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolveDirectivePath(rawPath, originalPath) {
  let value = rawPath.replace(/''/g, "'");
  if (path.isAbsolute(value) || /^\$\([^)]+\)/.test(value)) return value;
  if (value.includes('*')) value = value.replace(/\*/g, path.basename(originalPath, path.extname(originalPath)));
  return path.resolve(path.dirname(originalPath), value);
}

function rewritePascalPaths(text, originalPath, shadowByOriginal = new Map()) {
  const lookup = value => shadowByOriginal.get(normalizeKey(value)) || value;
  let result = text.replace(/(\bin\s*)'((?:''|[^'])+)'/gi, (whole, prefix, rawPath) => {
    const resolved = path.resolve(path.dirname(originalPath), rawPath.replace(/''/g, "'"));
    return `${prefix}${pascalQuote(lookup(resolved))}`;
  });
  result = result.replace(/(\{\$\s*(?:I|INCLUDE|R|RESOURCE)\s+)(?:'((?:''|[^'])+)'|([^}\s]+))(\s*\})/gi,
    (whole, prefix, quoted, bare, suffix) => {
      const resolved = resolveDirectivePath(quoted || bare, originalPath);
      return `${prefix}${pascalQuote(lookup(resolved))}${suffix}`;
    });
  return result;
}

function compilerSeverity(value, code) {
  const normalized = `${value || ''} ${code || ''}`.toLowerCase();
  if (/fatal|\bf\d{4}\b/.test(normalized)) return 'error';
  if (/error|\be\d{4}\b/.test(normalized)) return 'error';
  if (/warning|\bw\d{4}\b/.test(normalized)) return 'warning';
  if (/hint|\bh\d{4}\b/.test(normalized)) return 'hint';
  return undefined;
}

function parseCompilerOutput(output) {
  const results = [];
  const patterns = [
    /^\[(?:dcc\w*)\s+(Fatal|Error|Warning|Hint)\]\s+(.+?)\((\d+)(?:,(\d+))?\):\s*([FEWH]\d{4})?\s*(.*)$/i,
    /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(fatal error|error|warning|hint)\s+([A-Z]+\d+)?\s*:?\s*(.*?)(?:\s+\[[^\]]+\])?$/i,
    /^(.+?)\((\d+)(?:,(\d+))?\)\s+(Fatal|Error|Warning|Hint):\s*([A-Z]+\d+)?\s*(.*)$/i,
    /^(.+?)\s*:\s*(fatal error|error|warning|hint)\s+([A-Z]+\d+)?\s*:?\s*(.*?)(?:\s+\[[^\]]+\])?$/i,
    /^(fatal error|error|warning|hint)\s+([A-Z]+\d+)?\s*:?\s*(.*)$/i
  ];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let match = patterns[0].exec(line);
    if (match) {
      results.push({ severity: compilerSeverity(match[1], match[5]), file: match[2], line: Number(match[3]), column: Number(match[4] || 0), code: match[5], message: match[6].trim(), raw: rawLine });
      continue;
    }
    match = patterns[1].exec(line);
    if (match) {
      results.push({ severity: compilerSeverity(match[4], match[5]), file: match[1], line: Number(match[2]), column: Number(match[3] || 0), code: match[5], message: match[6].trim(), raw: rawLine });
      continue;
    }
    match = patterns[2].exec(line);
    if (match) {
      results.push({ severity: compilerSeverity(match[4], match[5]), file: match[1], line: Number(match[2]), column: Number(match[3] || 0), code: match[5], message: match[6].trim(), raw: rawLine });
      continue;
    }
    match = patterns[3].exec(line);
    if (match) {
      results.push({ severity: compilerSeverity(match[2], match[3]), file: match[1], line: 1, column: 0, code: match[3], message: match[4].trim(), raw: rawLine });
      continue;
    }
    match = patterns[4].exec(line);
    if (match) {
      results.push({ severity: compilerSeverity(match[1], match[2]), file: '', line: 1, column: 0, code: match[2], message: match[3].trim(), raw: rawLine });
    }
  }
  return results.filter(item => item.severity);
}

function cacheKey(project, compilerPath = '') {
  const hash = createHash('sha256');
  hash.update(JSON.stringify({
    projectPath: normalizeKey(project.projectPath),
    configuration: project.configuration,
    platform: project.platform,
    defines: project.defines,
    searchPaths: project.searchPaths.map(normalizeKey),
    compilerPath: normalizeKey(compilerPath || '.')
  }));
  try {
    const stat = fs.statSync(project.projectPath);
    hash.update(`${stat.size}:${stat.mtimeMs}`);
  } catch {}
  return hash.digest('hex').slice(0, 20);
}

class ProjectTaskPool {
  constructor(maxParallel = 2) {
    this.maxParallel = Math.max(1, maxParallel);
    this.running = new Map();
    this.queued = new Map();
  }

  enqueue(projectKey, priority, run) {
    const previous = this.queued.get(projectKey);
    if (previous) previous.resolve({ cancelled: true, reason: 'superseded' });
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    this.queued.set(projectKey, { projectKey, priority, run, resolve, sequence: Date.now() + Math.random() });
    this.pump();
    return promise;
  }

  cancel(projectKey, reason = 'cancelled') {
    const queued = this.queued.get(projectKey);
    if (queued) {
      this.queued.delete(projectKey);
      queued.resolve({ cancelled: true, reason });
    }
    const running = this.running.get(projectKey);
    if (running) running.controller.abort(reason);
  }

  cancelAll(reason = 'cancelled') {
    for (const key of [...this.queued.keys(), ...this.running.keys()]) this.cancel(key, reason);
  }

  pump() {
    while (this.running.size < this.maxParallel && this.queued.size > 0) {
      const task = [...this.queued.values()].sort((left, right) => right.priority - left.priority || left.sequence - right.sequence)[0];
      this.queued.delete(task.projectKey);
      const controller = new AbortController();
      this.running.set(task.projectKey, { controller });
      Promise.resolve().then(() => task.run(controller.signal))
        .then(value => task.resolve(value), error => task.resolve({ error }))
        .finally(() => {
          this.running.delete(task.projectKey);
          this.pump();
        });
    }
  }
}

module.exports = {
  ProjectTaskPool,
  cacheKey,
  compilerEnvironmentWithSearchPath,
  evaluateProjectProperties,
  excludeManagedSourcePaths,
  parseCompilerOutput,
  readActiveProject,
  readProjectInfo,
  resolveOwningProject,
  rewritePascalPaths
};
