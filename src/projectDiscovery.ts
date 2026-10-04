import { isRecord } from './shared/guards';
import { errorMessage } from './shared/guards';
import { PascalKeyword } from './shared/pascal';
import { FileExtension } from './shared/identifiers';
import * as fs from 'fs';
import * as path from 'path';
import { URL } from 'url';

const PASCAL_EXTENSIONS = new Set<string>([FileExtension.Pascal, '.pp', '.inc']);
const SKIPPED_DIRECTORIES = new Set<string>([
  '.git',
  '.svn',
  '.hg',
  '.vs',
  '.vscode',
  '.vallenta',
  'node_modules',
  '__history',
  '__recovery',
  'win32',
  'win64',
  'debug',
  'release'
]);

function decodeXml(value: string) {
  return value
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function normalizeKey(value: string) {
  const resolved = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function uniqueExistingPaths(values: readonly unknown[]) {
  const result = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.trim() === '') {
      continue;
    }
    const resolved = path.resolve(value.trim());
    const key = normalizeKey(resolved);
    if (!seen.has(key) && fs.existsSync(resolved)) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}

function projectPathFromEntry(entry: unknown, workspaceRoot: string) {
  const raw = typeof entry === "string"
    ? entry
    : isRecord(entry) ? entry.path || entry.projectPath : undefined;
  if (!raw || typeof raw !== "string") {
    return null;
  }
  return path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(workspaceRoot, raw);
}

function projectsFromGroup(groupPath: string) {
  if (!fs.existsSync(groupPath)) {
    return [];
  }
  const xml = fs.readFileSync(groupPath, 'utf8');
  const groupDir = path.dirname(groupPath);
  const projects = [];
  const expression = /<Projects\b[^>]*\bInclude\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = expression.exec(xml)) !== null) {
    const include = decodeXml(match[2]).trim();
    if (include) {
      projects.push(path.resolve(groupDir, include));
    }
  }
  return projects;
}

async function findWorkspaceProjectGroups(workspaceRoot: string, maximum = 64) {
  const groups: string[] = [];
  async function visit(directory: string) {
    if (groups.length >= maximum) return;
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (groups.length >= maximum) break;
      const entryPath = path.join(directory, entry.name);
      if (entry.isFile() && path.extname(entry.name).toLowerCase() === FileExtension.Group) {
        groups.push(path.resolve(entryPath));
      } else if (entry.isDirectory()
        && !entry.isSymbolicLink()
        && !SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
        await visit(entryPath);
      }
    }
  }
  await visit(workspaceRoot);
  return groups.sort((left, right) => {
    const relativeLeft = path.relative(workspaceRoot, left);
    const relativeRight = path.relative(workspaceRoot, right);
    const depthDifference = relativeLeft.split(path.sep).length - relativeRight.split(path.sep).length;
    return depthDifference || relativeLeft.localeCompare(relativeRight);
  });
}

async function readJsonObject(filePath: string, fallback: Record<string, unknown>) {
  if (!fs.existsSync(filePath)) return { ...fallback };
  try {
    const parsed: unknown = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
    if (!isRecord(parsed)) {
      throw new Error('root value must be an object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`Cannot parse ${filePath}: ${errorMessage(error)}`);
  }
}

async function writeJsonObject(filePath: string, value: unknown) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function ensureVallentaProjectGroups(workspaceRoot: string, options: { activateFirstProject?: boolean; maximumGroups?: number } = {}) {
  const discoveredGroups = await findWorkspaceProjectGroups(
    workspaceRoot,
    options.maximumGroups || 64
  );
  if (discoveredGroups.length === 0) {
    return {
      changed: false,
      configChanged: false,
      activeProjectChanged: false,
      repairedInvalidActiveProject: false,
      discoveredGroups,
      addedGroups: []
    };
  }

  const vallentaDirectory = path.join(workspaceRoot, '.vallenta');
  const configPath = path.join(vallentaDirectory, 'projects.json');
  const config = await readJsonObject(configPath, { projects: [], projectGroups: [] });
  const projects = Array.isArray(config.projects) ? config.projects : [];
  const projectGroups = Array.isArray(config.projectGroups) ? config.projectGroups : [];
  const knownGroups = new Set(projectGroups
    .map((entry: unknown) => projectPathFromEntry(entry, workspaceRoot))
    .filter((value): value is string => typeof value === 'string')
    .map(normalizeKey));
  const addedGroups = discoveredGroups.filter(groupPath => !knownGroups.has(normalizeKey(groupPath)));
  const configChanged = addedGroups.length > 0
    || !Array.isArray(config.projects)
    || !Array.isArray(config.projectGroups);
  if (configChanged) {
    config.projects = projects;
    config.projectGroups = [...projectGroups, ...addedGroups];
    await writeJsonObject(configPath, config);
  }

  let activeProjectChanged = false;
  let repairedInvalidActiveProject = false;
  if (options.activateFirstProject !== false) {
    const localPath = path.join(vallentaDirectory, 'projects.local.json');
    const local = await readJsonObject(localPath, {});
    const activeProject = isRecord(local.activeProject) ? local.activeProject : undefined;
    const configuredActiveProject = projectPathFromEntry(activeProject, workspaceRoot);
    const configuredActiveGroup = projectPathFromEntry(
      activeProject?.groupPath,
      workspaceRoot
    );
    const hasActiveProject = Boolean(configuredActiveProject && fs.existsSync(configuredActiveProject));
    if (!hasActiveProject) {
      const groupPath = discoveredGroups.find(candidate => configuredActiveGroup
        && path.basename(candidate).toLowerCase() === path.basename(configuredActiveGroup).toLowerCase())
        || discoveredGroups[0];
      const groupProjects = projectsFromGroup(groupPath).filter(filePath => fs.existsSync(filePath));
      const groupProjectKeys = new Set(groupProjects.map(normalizeKey));
      // A copied/moved workspace often retains absolute paths in
      // projects.local.json. Preserve the same selected child project by
      // rebasing its path relative to the old group onto the detected group.
      let firstProject;
      if (configuredActiveProject && configuredActiveGroup) {
        const relativeProject = path.relative(
          path.dirname(configuredActiveGroup),
          configuredActiveProject
        );
        const rebasedProject = path.resolve(path.dirname(groupPath), relativeProject);
        if (groupProjectKeys.has(normalizeKey(rebasedProject))) firstProject = rebasedProject;
      }
      firstProject ||= groupProjects[0];
      if (firstProject) {
        repairedInvalidActiveProject = Boolean(activeProject?.projectPath
          || (configuredActiveGroup && !fs.existsSync(configuredActiveGroup)));
        local.activeProject = { projectPath: firstProject, groupPath };
        const recentProjects = Array.isArray(local.recentProjects) ? local.recentProjects : [];
        const groupKey = normalizeKey(groupPath);
        local.recentProjects = [
          {
            path: groupPath,
            name: path.basename(groupPath, path.extname(groupPath)),
            lastOpened: Date.now()
          },
          ...recentProjects.filter((entry: unknown) => {
            const existingPath = projectPathFromEntry(entry, workspaceRoot);
            return !existingPath || normalizeKey(existingPath) !== groupKey;
          })
        ].slice(0, 20);
        await writeJsonObject(localPath, local);
        activeProjectChanged = true;
      }
    }
  }
  return {
    changed: configChanged || activeProjectChanged,
    configChanged,
    activeProjectChanged,
    repairedInvalidActiveProject,
    discoveredGroups,
    addedGroups
  };
}

function discoverLoadedProjects(workspaceRoot: string) {
  const configPath = path.join(workspaceRoot, '.vallenta', 'projects.json');
  if (!fs.existsSync(configPath)) {
    return [];
  }

  let config: unknown;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${configPath}: ${errorMessage(error)}`);
  }

  if (!isRecord(config)) throw new Error(`Cannot parse ${configPath}: root value must be an object`);
  const candidates: string[] = [];
  const projects: unknown[] = Array.isArray(config.projects) ? config.projects : [];
  const projectGroups: unknown[] = Array.isArray(config.projectGroups) ? config.projectGroups : [];
  for (const entry of projects) {
    const projectPath = projectPathFromEntry(entry, workspaceRoot);
    if (projectPath) {
      candidates.push(projectPath);
    }
  }
  for (const entry of projectGroups) {
    const groupPath = projectPathFromEntry(entry, workspaceRoot);
    if (groupPath) {
      candidates.push(...projectsFromGroup(groupPath));
    }
  }
  return uniqueExistingPaths(candidates);
}

function dprojSearchPaths(projectFile: string) {
  if (!fs.existsSync(projectFile)) {
    return [];
  }
  const xml = fs.readFileSync(projectFile, 'utf8');
  const projectDir = path.dirname(projectFile);
  const candidates = [];
  const expression = /<DCC_UnitSearchPath\b[^>]*>([\s\S]*?)<\/DCC_UnitSearchPath>/gi;
  let match;
  while ((match = expression.exec(xml)) !== null) {
    const value = decodeXml(match[1]);
    for (const segment of value.split(';')) {
      const trimmed = segment.trim();
      if (!trimmed || /\$\([^)]+\)/.test(trimmed)) {
        continue;
      }
      candidates.push(path.isAbsolute(trimmed)
        ? trimmed
        : path.resolve(projectDir, trimmed));
    }
  }
  return uniqueExistingPaths(candidates);
}

async function walkSourceDirectories(root: string) {
  const sourceDirectories = new Set<string>();

  async function visit(directory: string) {
    let entries;
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    let containsSource = false;
    const children = [];
    for (const entry of entries) {
      if (entry.isFile() && PASCAL_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        containsSource = true;
      } else if (entry.isDirectory()
        && !entry.isSymbolicLink()
        && !SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())) {
        children.push(path.join(directory, entry.name));
      }
    }
    if (containsSource) {
      sourceDirectories.add(path.resolve(directory));
    }
    await Promise.all(children.map(visit));
  }

  await visit(root);
  return [...sourceDirectories];
}

async function collectPascalAtlasPaths(projectFiles: string[], includeNestedSourceDirectories = true) {
  const candidates = [];
  for (const projectFile of projectFiles) {
    const projectDir = path.dirname(projectFile);
    candidates.push(projectDir, ...dprojSearchPaths(projectFile));
    if (includeNestedSourceDirectories) {
      candidates.push(...await walkSourceDirectories(projectDir));
    }
  }
  return uniqueExistingPaths(candidates).sort((left, right) => left.localeCompare(right));
}

export {
  collectPascalAtlasPaths,
  decodeXml,
  discoverLoadedProjects,
  dprojSearchPaths,
  ensureVallentaProjectGroups,
  findWorkspaceProjectGroups,
  normalizeKey,
  projectsFromGroup,
  uniqueExistingPaths,
  walkSourceDirectories
};
