import type { ProjectOverrides } from './diagnosticCore';
import type { Memento, OutputChannel } from 'vscode';
import { isRecord } from './shared/guards';
import { errorMessage } from './shared/guards';
import { PascalKeyword } from './shared/pascal';
import { FileExtension } from './shared/identifiers';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { decodeXml, findWorkspaceProjectGroups, normalizeKey, projectsFromGroup } from './projectDiscovery';
import { evaluateProjectProperties, readProjectInfo } from './diagnosticCore';

const CACHE_VERSION = 1;
const CACHE_KEY = 'pascalAtlas.delphiProjectModel.v1';

function xmlValue(xml: string, name: string) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i').exec(xml);
  return match ? decodeXml(match[1]).trim() : '';
}

function expandProperties(value: unknown, properties: Record<string, string | undefined>) {
  let result = String(value || '');
  const lookup = new Map(Object.entries(properties || {}).map(([key, item]) => [key.toLowerCase(), String(item || '')]));
  for (let pass = 0; pass < 10; pass += 1) {
    const next = result.replace(/\$\(([^)]+)\)/g, (whole, name) => lookup.get(name.toLowerCase()) ?? whole);
    if (next === result) break;
    result = next;
  }
  return result;
}

function resolveProjectPath(projectDir: string, value: unknown, properties: Record<string, string | undefined>) {
  const expanded = expandProperties(value, properties).trim();
  if (!expanded || /\$\([^)]+\)/.test(expanded)) return '';
  return path.resolve(projectDir, expanded);
}

function mainKind(mainSource: string | undefined) {
  const extension = path.extname(mainSource || '').toLowerCase();
  if (extension === FileExtension.Package) return PascalKeyword.Package;
  if (extension === FileExtension.Program) {
    try {
      const prefix = fs.readFileSync(mainSource || '', 'utf8').slice(0, 4096).replace(/^\uFEFF/, '');
      if (/^\s*library\b/i.test(prefix)) return PascalKeyword.Library;
    } catch {}
    return 'application';
  }
  return 'unknown';
}

function artifactBase(mainSource: string) {
  return path.basename(mainSource || '', path.extname(mainSource || ''));
}

function projectDescriptor(projectPath: string, overrides: ProjectOverrides = {}, environment: NodeJS.ProcessEnv = {}) {
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
  const output = kind === PascalKeyword.Package
    ? path.join(bplDir, `${base}.bpl`)
    : path.join(exeDir, `${base}${kind === PascalKeyword.Library ? '.dll' : '.exe'}`);
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
    dcpFile: kind === PascalKeyword.Package ? path.join(dcpDir, `${base}.dcp`) : '',
    debugHost,
    runParams: expandProperties(properties.debugger_runparams || xmlValue(xml, 'Debugger_RunParams'), allProperties).trim()
  };
}

function minimalProjectDescriptor(projectPath: string) {
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

function groupDescriptor(groupPath: string) {
  const xml = fs.readFileSync(groupPath, 'utf8');
  const projectPaths = projectsFromGroup(groupPath);
  const dependencies = new Map<string, string[]>();
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

function statSignature(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return '';
  }
}

async function findDprojFiles(workspaceRoot: string, maximum = 4096) {
  const results: string[] = [];
  const skipped = new Set<string>(['.git', '.svn', '.hg', '.vs', '.vscode', '.vallenta', 'node_modules', '__history', '__recovery']);
  async function visit(directory: string) {
    if (results.length >= maximum) return;
    let entries;
    try { entries = await fs.promises.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (results.length >= maximum) break;
      const item = path.join(directory, entry.name);
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === FileExtension.Project) results.push(path.resolve(item));
      else if (entry.isDirectory() && !entry.isSymbolicLink() && !skipped.has(entry.name.toLowerCase())) await visit(item);
    }
  }
  await visit(workspaceRoot);
  return results;
}

export type ProjectDescriptor = ReturnType<typeof minimalProjectDescriptor>;
export type DetailedProjectDescriptor = ReturnType<typeof projectDescriptor>;
export type GroupDescriptor = ReturnType<typeof groupDescriptor>;
interface ProjectModelCache { version: number; projects: { projectPath: string; signature: string; descriptor: ProjectDescriptor }[]; groups: { groupPath: string; signature: string }[]; }
function isProjectDescriptor(value: unknown): value is ProjectDescriptor {
  return isRecord(value) && ['projectPath', 'projectDir', 'mainSource', 'name'].every(key => typeof value[key] === 'string')
    && typeof value.targetedPlatforms === 'number' && ['package', 'library', 'application', 'unknown'].includes(String(value.kind));
}
function isProjectModelCache(value: unknown): value is ProjectModelCache {
  return isRecord(value) && typeof value.version === 'number' && Array.isArray(value.projects) && Array.isArray(value.groups)
    && value.projects.every((item: unknown) => isRecord(item) && typeof item.projectPath === 'string' && typeof item.signature === 'string' && isProjectDescriptor(item.descriptor))
    && value.groups.every((item: unknown) => isRecord(item) && typeof item.groupPath === 'string' && typeof item.signature === 'string');
}
class DelphiProjectModel {
  context: { workspaceState: Memento };
  output: Pick<OutputChannel, "appendLine">;
  projects: Map<string, ProjectDescriptor>;
  groups: Map<string, GroupDescriptor>;
  packageRoots: Map<string, ProjectDescriptor[]>;
  groupRoots: Map<string, GroupDescriptor[]>;
  changeListeners: Set<() => void>;
  workspaceRoots;

  constructor(context: { workspaceState: Memento }, output: Pick<OutputChannel, "appendLine">, workspaceRoots: string[] = []) {
    this.context = context;
    this.output = output;
    this.projects = new Map();
    this.groups = new Map();
    this.packageRoots = new Map();
    this.groupRoots = new Map();
    this.changeListeners = new Set();
    this.workspaceRoots = workspaceRoots.map(item => path.resolve(item));
  }

  onDidChange(listener: () => void) {
    this.changeListeners.add(listener);
    return { dispose: () => this.changeListeners.delete(listener) };
  }

  emitChange() {
    for (const listener of this.changeListeners) listener();
  }

  restore() {
    const cached = this.context.workspaceState.get<unknown>(CACHE_KEY);
    if (!isProjectModelCache(cached) || cached.version !== CACHE_VERSION) return false;
    try {
      for (const item of cached.projects || []) {
        if (statSignature(item.projectPath) !== item.signature) continue;
        this.projects.set(normalizeKey(item.projectPath), item.descriptor);
        if (item.descriptor.kind === PascalKeyword.Package) this.addTo(this.packageRoots, item.descriptor.projectDir, item.descriptor);
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

  addTo<T>(map: Map<string, T[]>, directory: string, descriptor: T) {
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
    const projects = new Map<string, ProjectDescriptor>();
    const groups = new Map<string, GroupDescriptor>();
    const packageRoots = new Map<string, ProjectDescriptor[]>();
    const groupRoots = new Map<string, GroupDescriptor[]>();
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
          this.output.appendLine(`Delphi group skipped (${groupPath}): ${errorMessage(error)}`);
        }
      }
      for (const projectPath of projectPaths) {
        try {
          const descriptor = minimalProjectDescriptor(projectPath);
          projects.set(normalizeKey(projectPath), descriptor);
          if (descriptor.kind === PascalKeyword.Package) this.addLocal(packageRoots, descriptor.projectDir, descriptor);
        } catch (error) {
          this.output.appendLine(`Delphi project skipped (${projectPath}): ${errorMessage(error)}`);
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

  addLocal<T>(map: Map<string, T[]>, directory: string, descriptor: T) {
    const key = normalizeKey(directory);
    const values = map.get(key) || [];
    values.push(descriptor);
    map.set(key, values);
  }

  workspaceFolders() {
    return this.workspaceRoots;
  }

  packageProjects(directory: string) {
    return this.packageRoots.get(normalizeKey(directory)) || [];
  }

  groupsAt(directory: string) {
    return this.groupRoots.get(normalizeKey(directory)) || [];
  }

  project(projectPath: string) {
    return this.projects.get(normalizeKey(projectPath));
  }

  packageRootPaths() {
    return [...this.packageRoots.values()].flatMap(values => values.length ? [values[0].projectDir] : []);
  }

  groupRootPaths() {
    return [...this.groupRoots.values()].flatMap(values => values.length ? [values[0].groupDir] : []);
  }
}

export {
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
