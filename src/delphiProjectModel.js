'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  decodeXml,
  findWorkspaceProjectGroups,
  normalizeKey,
  projectsFromGroup
} = require('./projectDiscovery');
const { evaluateProjectProperties, readProjectInfo } = require('./diagnosticCore');

const CACHE_VERSION = 1;
const CACHE_KEY = 'pascalUnion.delphiProjectModel.v1';

function xmlValue(xml, name) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]).trim() : '';
}

function expandProperties(value, properties) {
  let result = String(value || '');
  const lookup = new Map(Object.entries(properties || {}).map(([key, item]) => [key.toLowerCase(), String(item || '')]));
  for (let pass = 0; pass < 10; pass += 1) {
    const next = result.replace(/\$\(([^)]+)\)/g, (whole, name) => lookup.get(name.toLowerCase()) ?? whole);
    if (next === result) break;
    result = next;
  }
  return result;
}

function resolveProjectPath(projectDir, value, properties) {
  const expanded = expandProperties(value, properties).trim();
  if (!expanded || /\$\([^)]+\)/.test(expanded)) return '';
  return path.resolve(projectDir, expanded);
}

function mainKind(mainSource) {
  const extension = path.extname(mainSource || '').toLowerCase();
  if (extension === '.dpk') return 'package';
  if (extension === '.dpr') {
    try {
      const prefix = fs.readFileSync(mainSource, 'utf8').slice(0, 4096).replace(/^\uFEFF/, '');
      if (/^\s*library\b/i.test(prefix)) return 'library';
    } catch {}
    return 'application';
  }
  return 'unknown';
}

function artifactBase(mainSource) {
  return path.basename(mainSource || '', path.extname(mainSource || ''));
}

function projectDescriptor(projectPath, overrides = {}, environment = {}) {
  const xml = fs.readFileSync(projectPath, 'utf8');
  const info = readProjectInfo(projectPath, overrides);
  const properties = evaluateProjectProperties(xml, overrides);
  const kind = mainKind(info.mainSource);
  const base = artifactBase(info.mainSource || projectPath);
  const allProperties = {
    ...environment,
    ProjectDir: `${info.projectDir}${path.sep}`,
    ProjectPath: info.projectPath,
    ProjectName: base,
    ...properties
  };
  const exeDir = resolveProjectPath(info.projectDir, properties.dcc_exeoutput, allProperties) || info.projectDir;
  const bplDir = resolveProjectPath(info.projectDir, properties.dcc_bploutput, allProperties)
    || resolveProjectPath(info.projectDir, environment.BDSCOMMONDIR && path.join(environment.BDSCOMMONDIR, 'Bpl'), allProperties)
    || exeDir;
  const dcpDir = resolveProjectPath(info.projectDir, properties.dcc_dcpoutput, allProperties)
    || resolveProjectPath(info.projectDir, environment.BDSCOMMONDIR && path.join(environment.BDSCOMMONDIR, 'Dcp'), allProperties)
    || info.projectDir;
  const output = kind === 'package'
    ? path.join(bplDir, `${base}.bpl`)
    : path.join(exeDir, `${base}${kind === 'library' ? '.dll' : '.exe'}`);
  const debugHost = resolveProjectPath(info.projectDir, properties.debugger_hostapplication || xmlValue(xml, 'Debugger_HostApplication'), allProperties);
  return {
    ...info,
    kind,
    name: base,
    targetedPlatforms: Number.parseInt(properties.targetedplatforms || xmlValue(xml, 'TargetedPlatforms'), 10) || 0,
    properties,
    output,
    mapFile: output.replace(/\.[^.]+$/, '.map'),
    rsmFile: output.replace(/\.[^.]+$/, '.rsm'),
    dcpFile: kind === 'package' ? path.join(dcpDir, `${base}.dcp`) : '',
    debugHost,
    runParams: expandProperties(properties.debugger_runparams || xmlValue(xml, 'Debugger_RunParams'), allProperties).trim()
  };
}

function minimalProjectDescriptor(projectPath) {
  const xml = fs.readFileSync(projectPath, 'utf8');
  const projectDir = path.dirname(projectPath);
  const mainSourceValue = xmlValue(xml, 'MainSource');
  const mainSource = mainSourceValue ? path.resolve(projectDir, mainSourceValue) : '';
  return {
    projectPath: path.resolve(projectPath),
    projectDir,
    mainSource,
    kind: mainKind(mainSource),
    name: artifactBase(mainSource || projectPath),
    targetedPlatforms: Number.parseInt(xmlValue(xml, 'TargetedPlatforms'), 10) || 0
  };
}

function groupDescriptor(groupPath) {
  const xml = fs.readFileSync(groupPath, 'utf8');
  const projectPaths = projectsFromGroup(groupPath);
  const dependencies = new Map();
  for (const match of xml.matchAll(/<Projects\b[^>]*\bInclude\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/Projects>/gi)) {
    const project = path.resolve(path.dirname(groupPath), decodeXml(match[2]).trim());
    const values = [];
    for (const dependency of match[3].matchAll(/<Dependencies\b[^>]*>([\s\S]*?)<\/Dependencies>/gi)) {
      const value = decodeXml(dependency[1]).trim();
      if (value) values.push(value);
    }
    dependencies.set(normalizeKey(project), values);
  }
  return {
    groupPath: path.resolve(groupPath),
    groupDir: path.dirname(groupPath),
    name: path.basename(groupPath, path.extname(groupPath)),
    projectPaths,
    dependencies
  };
}

function statSignature(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return '';
  }
}

async function findDprojFiles(workspaceRoot, maximum = 4096) {
  const results = [];
  const skipped = new Set(['.git', '.svn', '.hg', '.vs', '.vscode', '.vallenta', 'node_modules', '__history', '__recovery']);
  async function visit(directory) {
    if (results.length >= maximum) return;
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maximum) break;
      const item = path.join(directory, entry.name);
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.dproj') results.push(path.resolve(item));
      else if (entry.isDirectory() && !entry.isSymbolicLink() && !skipped.has(entry.name.toLowerCase())) await visit(item);
    }
  }
  await visit(workspaceRoot);
  return results;
}

class DelphiProjectModel {
  constructor(context, output, workspaceRoots = []) {
    this.context = context;
    this.output = output;
    this.projects = new Map();
    this.groups = new Map();
    this.packageRoots = new Map();
    this.groupRoots = new Map();
    this.changeListeners = new Set();
    this.workspaceRoots = workspaceRoots.map(item => path.resolve(item));
  }

  onDidChange(listener) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  emitChange() {
    for (const listener of this.changeListeners) listener();
  }

  restore() {
    const cached = this.context.workspaceState.get(CACHE_KEY);
    if (!cached || cached.version !== CACHE_VERSION) return false;
    try {
      for (const item of cached.projects || []) {
        if (statSignature(item.projectPath) !== item.signature) continue;
        this.projects.set(normalizeKey(item.projectPath), item.descriptor);
        if (item.descriptor.kind === 'package') this.addTo(this.packageRoots, item.descriptor.projectDir, item.descriptor);
      }
      for (const item of cached.groups || []) {
        if (statSignature(item.groupPath) !== item.signature) continue;
        const descriptor = groupDescriptor(item.groupPath);
        this.groups.set(normalizeKey(item.groupPath), descriptor);
        this.addTo(this.groupRoots, descriptor.groupDir, descriptor);
      }
      return this.projects.size > 0 || this.groups.size > 0;
    } catch {
      this.clear();
      return false;
    }
  }

  addTo(map, directory, descriptor) {
    const key = normalizeKey(directory);
    const values = map.get(key) || [];
    values.push(descriptor);
    map.set(key, values);
  }

  clear() {
    this.projects.clear();
    this.groups.clear();
    this.packageRoots.clear();
    this.groupRoots.clear();
  }

  async refresh() {
    const projects = new Map();
    const groups = new Map();
    const packageRoots = new Map();
    const groupRoots = new Map();
    for (const folder of this.workspaceFolders()) {
      const [groupPaths, projectPaths] = await Promise.all([
        findWorkspaceProjectGroups(folder),
        findDprojFiles(folder)
      ]);
      for (const groupPath of groupPaths) {
        try {
          const descriptor = groupDescriptor(groupPath);
          groups.set(normalizeKey(groupPath), descriptor);
          this.addLocal(groupRoots, descriptor.groupDir, descriptor);
        } catch (error) {
          this.output.appendLine(`Delphi group skipped (${groupPath}): ${error.message}`);
        }
      }
      for (const projectPath of projectPaths) {
        try {
          const descriptor = minimalProjectDescriptor(projectPath);
          projects.set(normalizeKey(projectPath), descriptor);
          if (descriptor.kind === 'package') this.addLocal(packageRoots, descriptor.projectDir, descriptor);
        } catch (error) {
          this.output.appendLine(`Delphi project skipped (${projectPath}): ${error.message}`);
        }
      }
    }
    this.projects = projects;
    this.groups = groups;
    this.packageRoots = packageRoots;
    this.groupRoots = groupRoots;
    await this.context.workspaceState.update(CACHE_KEY, {
      version: CACHE_VERSION,
      projects: [...projects.values()].map(descriptor => ({ descriptor, projectPath: descriptor.projectPath, signature: statSignature(descriptor.projectPath) })),
      groups: [...groups.values()].map(descriptor => ({ groupPath: descriptor.groupPath, signature: statSignature(descriptor.groupPath) }))
    });
    this.output.appendLine(`Delphi project model ready: ${projects.size} project(s), ${groups.size} group(s), ${packageRoots.size} package root(s).`);
    this.emitChange();
  }

  addLocal(map, directory, descriptor) {
    const key = normalizeKey(directory);
    const values = map.get(key) || [];
    values.push(descriptor);
    map.set(key, values);
  }

  workspaceFolders() {
    return this.workspaceRoots;
  }

  packageProjects(directory) {
    return this.packageRoots.get(normalizeKey(directory)) || [];
  }

  groupsAt(directory) {
    return this.groupRoots.get(normalizeKey(directory)) || [];
  }

  project(projectPath) {
    return this.projects.get(normalizeKey(projectPath));
  }

  packageRootPaths() {
    return [...this.packageRoots.values()].flatMap(values => values.length ? [values[0].projectDir] : []);
  }

  groupRootPaths() {
    return [...this.groupRoots.values()].flatMap(values => values.length ? [values[0].groupDir] : []);
  }
}

module.exports = {
  CACHE_KEY,
  CACHE_VERSION,
  DelphiProjectModel,
  expandProperties,
  findDprojFiles,
  groupDescriptor,
  minimalProjectDescriptor,
  projectDescriptor,
  resolveProjectPath,
  statSignature
};
