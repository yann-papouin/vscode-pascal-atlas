import type { ProjectOverrides } from "./diagnosticCore"
import type { Memento, OutputChannel } from "vscode"
import { isRecord } from "./shared/guards"
import { errorMessage } from "./shared/guards"
import { PascalKeyword } from "./shared/pascal"
import { FileExtension } from "./shared/identifiers"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  decodeXml,
  findWorkspaceProjectGroups,
  normalizeKey,
  projectsFromGroup,
} from "./projectDiscovery"
import { evaluateProjectProperties, readProjectInfo } from "./diagnosticCore"

const CACHE_VERSION = 1
const CACHE_KEY = "pascalAtlas.delphiProjectModel.v1"

/**
 * Read and decode a named Delphi project XML value, using an empty string when no
 * element is present.
 */
function xmlValue(xml: string, name: string) {
  const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(xml)
  return match ? decodeXml(match[1]).trim() : ""
}

/**
 * Expand project/environment macros case-insensitively for up to ten passes, stopping
 * at a stable value and retaining unresolved references.
 */
function expandProperties(
  value: unknown,
  properties: Record<string, string | undefined>,
) {
  let result = String(value || "")
  const lookup = new Map(
    Object.entries(properties || {}).map(
      /** Normalize environment variable names while retaining their string values. */ ([
        key,
        item,
      ]) => [key.toLowerCase(), String(item || "")],
    ),
  )
  for (let pass = 0; pass < 10; pass += 1) {
    const next = result.replace(
      /\$\(([^)]+)\)/g,
      /**
       * Expand known project properties while retaining unknown placeholders verbatim.
       */ (whole, name) => lookup.get(name.toLowerCase()) ?? whole,
    )
    if (next === result) break
    result = next
  }
  return result
}

/**
 * Expand and resolve a project-relative path, returning an empty value when macros
 * remain unresolved.
 */
function resolveProjectPath(
  projectDir: string,
  value: unknown,
  properties: Record<string, string | undefined>,
) {
  const expanded = expandProperties(value, properties).trim()
  if (!expanded || /\$\([^)]+\)/.test(expanded)) return ""
  return path.resolve(projectDir, expanded)
}

/**
 * Classify a DPK as a package or a DPR as a library/application, reading only its
 * prefix and returning unknown for other source kinds.
 */
function mainKind(mainSource: string | undefined) {
  const extension = path.extname(mainSource || "").toLowerCase()
  if (extension === FileExtension.Package) return PascalKeyword.Package
  if (extension === FileExtension.Program) {
    try {
      const prefix = fs
        .readFileSync(mainSource || "", "utf8")
        .slice(0, 4096)
        .replace(/^\uFEFF/, "")
      if (/^\s*library\b/i.test(prefix)) return PascalKeyword.Library
    } catch {}
    return "application"
  }
  return "unknown"
}

/**
 * Derive the output artifact base name from a main source or project filename without
 * its extension.
 */
function artifactBase(mainSource: string) {
  return path.basename(mainSource || "", path.extname(mainSource || ""))
}

/**
 * Evaluate a project's effective build properties and environment to derive artifact,
 * debugger, search-path, and platform metadata.
 */
function projectDescriptor(
  projectPath: string,
  overrides: ProjectOverrides = {},
  environment: NodeJS.ProcessEnv = {},
) {
  const xml = fs.readFileSync(projectPath, "utf8")
  const info = readProjectInfo(projectPath, overrides)
  const properties = evaluateProjectProperties(xml, overrides)
  const kind = mainKind(info.mainSource)
  const base = artifactBase(info.mainSource || projectPath)
  const allProperties = {
    ...environment,
    ProjectDir: `${info.projectDir}${path.sep}`,
    ProjectPath: info.projectPath,
    ProjectName: base,
    ...properties,
  }
  const exeDir =
    resolveProjectPath(info.projectDir, properties.dcc_exeoutput, allProperties) ||
    info.projectDir
  const bplDir =
    resolveProjectPath(info.projectDir, properties.dcc_bploutput, allProperties) ||
    resolveProjectPath(
      info.projectDir,
      environment.BDSCOMMONDIR && path.join(environment.BDSCOMMONDIR, "Bpl"),
      allProperties,
    ) ||
    exeDir
  const dcpDir =
    resolveProjectPath(info.projectDir, properties.dcc_dcpoutput, allProperties) ||
    resolveProjectPath(
      info.projectDir,
      environment.BDSCOMMONDIR && path.join(environment.BDSCOMMONDIR, "Dcp"),
      allProperties,
    ) ||
    info.projectDir
  const output =
    kind === PascalKeyword.Package
      ? path.join(bplDir, `${base}.bpl`)
      : path.join(exeDir, `${base}${kind === PascalKeyword.Library ? ".dll" : ".exe"}`)
  const debugHost = resolveProjectPath(
    info.projectDir,
    properties.debugger_hostapplication || xmlValue(xml, "Debugger_HostApplication"),
    allProperties,
  )
  return {
    ...info,
    kind,
    name: base,
    targetedPlatforms:
      Number.parseInt(
        properties.targetedplatforms || xmlValue(xml, "TargetedPlatforms"),
        10,
      ) || 0,
    properties,
    output,
    mapFile: output.replace(/\.[^.]+$/, ".map"),
    rsmFile: output.replace(/\.[^.]+$/, ".rsm"),
    dcpFile: kind === PascalKeyword.Package ? path.join(dcpDir, `${base}.dcp`) : "",
    debugHost,
    runParams: expandProperties(
      properties.debugger_runparams || xmlValue(xml, "Debugger_RunParams"),
      allProperties,
    ).trim(),
  }
}

/**
 * Read only the project identity, main source, kind, name, and targeted platforms
 * needed for lightweight tree rendering.
 */
function minimalProjectDescriptor(projectPath: string) {
  const xml = fs.readFileSync(projectPath, "utf8")
  const projectDir = path.dirname(projectPath)
  const mainSourceValue = xmlValue(xml, "MainSource")
  const mainSource = mainSourceValue ? path.resolve(projectDir, mainSourceValue) : ""
  return {
    projectPath: path.resolve(projectPath),
    projectDir,
    mainSource,
    kind: mainKind(mainSource),
    name: artifactBase(mainSource || projectPath),
    targetedPlatforms: Number.parseInt(xmlValue(xml, "TargetedPlatforms"), 10) || 0,
  }
}

/**
 * Resolve group project includes and their declared dependencies into a stable group
 * descriptor.
 */
function groupDescriptor(groupPath: string) {
  const xml = fs.readFileSync(groupPath, "utf8")
  const projectPaths = projectsFromGroup(groupPath)
  const dependencies = new Map<string, string[]>()
  for (const match of xml.matchAll(
    /<Projects\b[^>]*\bInclude\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/Projects>/gi,
  )) {
    const project = path.resolve(path.dirname(groupPath), decodeXml(match[2]).trim())
    const values = []
    for (const dependency of match[3].matchAll(
      /<Dependencies\b[^>]*>([\s\S]*?)<\/Dependencies>/gi,
    )) {
      const value = decodeXml(dependency[1]).trim()
      if (value) values.push(value)
    }
    dependencies.set(normalizeKey(project), values)
  }
  return {
    groupPath: path.resolve(groupPath),
    groupDir: path.dirname(groupPath),
    name: path.basename(groupPath, path.extname(groupPath)),
    projectPaths,
    dependencies,
  }
}

/**
 * Return a size/mtime cache signature for a file, using an empty signature when it
 * cannot be inspected.
 */
function statSignature(filePath: string) {
  try {
    const stat = fs.statSync(filePath)
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`
  } catch {
    return ""
  }
}

/**
 * Discover project files below a workspace up to the configured cap, excluding
 * generated/hidden directories and symbolic links.
 */
async function findDprojFiles(workspaceRoot: string, maximum = 4096) {
  const results: string[] = []
  const skipped = new Set<string>([
    ".git",
    ".svn",
    ".hg",
    ".vs",
    ".vscode",
    ".vallenta",
    "node_modules",
    "__history",
    "__recovery",
  ])
  /**
   * Traverse eligible project-search directories until the result cap is reached,
   * skipping unreadable folders and symlink cycles.
   */
  async function visit(directory: string) {
    if (results.length >= maximum) return
    let entries
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (results.length >= maximum) break
      const item = path.join(directory, entry.name)
      if (
        entry.isFile() &&
        path.extname(entry.name).toLowerCase() === FileExtension.Project
      )
        results.push(path.resolve(item))
      else if (
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !skipped.has(entry.name.toLowerCase())
      )
        await visit(item)
    }
  }
  await visit(workspaceRoot)
  return results
}

export type ProjectDescriptor = ReturnType<typeof minimalProjectDescriptor>
export type DetailedProjectDescriptor = ReturnType<typeof projectDescriptor>
export type GroupDescriptor = ReturnType<typeof groupDescriptor>
interface ProjectModelCache {
  version: number
  projects: { projectPath: string; signature: string; descriptor: ProjectDescriptor }[]
  groups: { groupPath: string; signature: string }[]
}
/**
 * Validate the basic persisted project identity and source-kind metadata before
 * restoring a cached descriptor.
 */
function isProjectDescriptor(value: unknown): value is ProjectDescriptor {
  return (
    isRecord(value) &&
    ["projectPath", "projectDir", "mainSource", "name"].every(
      /**
       * Require the core project identity and source fields in a restored descriptor.
       */ (key) => typeof value[key] === "string",
    ) &&
    typeof value.targetedPlatforms === "number" &&
    ["package", "library", "application", "unknown"].includes(String(value.kind))
  )
}
/**
 * Validate the versioned project/group cache envelope and descriptor/signature fields
 * before inspecting its entries.
 */
function isProjectModelCache(value: unknown): value is ProjectModelCache {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    Array.isArray(value.projects) &&
    Array.isArray(value.groups) &&
    value.projects.every(
      /** Validate each cached project path, file signature, and descriptor. */ (
        item: unknown,
      ) =>
        isRecord(item) &&
        typeof item.projectPath === "string" &&
        typeof item.signature === "string" &&
        isProjectDescriptor(item.descriptor),
    ) &&
    value.groups.every(
      /** Validate each cached project group path and file signature. */ (
        item: unknown,
      ) =>
        isRecord(item) &&
        typeof item.groupPath === "string" &&
        typeof item.signature === "string",
    )
  )
}
class DelphiProjectModel {
  context: { workspaceState: Memento }
  output: Pick<OutputChannel, "appendLine">
  projects: Map<string, ProjectDescriptor>
  groups: Map<string, GroupDescriptor>
  packageRoots: Map<string, ProjectDescriptor[]>
  groupRoots: Map<string, GroupDescriptor[]>
  changeListeners: Set<() => void>
  workspaceRoots

  /**
   * Initialize workspace project/group indexes, cache restoration, and change
   * listeners for later discovery refreshes.
   */
  constructor(
    context: { workspaceState: Memento },
    output: Pick<OutputChannel, "appendLine">,
    workspaceRoots: string[] = [],
  ) {
    this.context = context
    this.output = output
    this.projects = new Map()
    this.groups = new Map()
    this.packageRoots = new Map()
    this.groupRoots = new Map()
    this.changeListeners = new Set()
    this.workspaceRoots = workspaceRoots.map(
      /** Resolve configured workspace roots to absolute paths. */ (item) =>
        path.resolve(item),
    )
  }

  /**
   * Subscribe to project-model changes and return a disposable that removes the
   * listener.
   */
  onDidChange(listener: () => void) {
    this.changeListeners.add(listener)
    return {
      dispose:
        /** Remove this project-model listener when its subscription is disposed. */ () =>
          this.changeListeners.delete(listener),
    }
  }

  /** Notify all current listeners after project/group indexes have changed. */
  emitChange() {
    for (const listener of this.changeListeners) listener()
  }

  /**
   * Restore validated project descriptors whose file signatures still match, and
   * rebuild cached group/root indexes from available state.
   */
  restore() {
    const cached = this.context.workspaceState.get<unknown>(CACHE_KEY)
    if (!isProjectModelCache(cached) || cached.version !== CACHE_VERSION) return false
    try {
      for (const item of cached.projects || []) {
        if (statSignature(item.projectPath) !== item.signature) continue
        this.projects.set(normalizeKey(item.projectPath), item.descriptor)
        if (item.descriptor.kind === PascalKeyword.Package)
          this.addTo(this.packageRoots, item.descriptor.projectDir, item.descriptor)
      }
      for (const item of cached.groups || []) {
        if (statSignature(item.groupPath) !== item.signature) continue
        const descriptor = groupDescriptor(item.groupPath)
        this.groups.set(normalizeKey(item.groupPath), descriptor)
        this.addTo(this.groupRoots, descriptor.groupDir, descriptor)
      }
      return this.projects.size > 0 || this.groups.size > 0
    } catch {
      this.clear()
      return false
    }
  }

  /**
   * Append a project or group descriptor to the supplied canonical directory bucket
   * without replacing its siblings.
   */
  addTo<T>(map: Map<string, T[]>, directory: string, descriptor: T) {
    const key = normalizeKey(directory)
    const values = map.get(key) || []
    values.push(descriptor)
    map.set(key, values)
  }

  /**
   * Reset every project/group/root index before publishing a fresh discovery result.
   */
  clear() {
    this.projects.clear()
    this.groups.clear()
    this.packageRoots.clear()
    this.groupRoots.clear()
  }

  /**
   * Discover workspace groups and projects, build fresh descriptors/root indexes,
   * persist cache signatures, and publish the refreshed model.
   */
  async refresh() {
    const projects = new Map<string, ProjectDescriptor>()
    const groups = new Map<string, GroupDescriptor>()
    const packageRoots = new Map<string, ProjectDescriptor[]>()
    const groupRoots = new Map<string, GroupDescriptor[]>()
    for (const folder of this.workspaceFolders()) {
      const [groupPaths, projectPaths] = await Promise.all([
        findWorkspaceProjectGroups(folder),
        findDprojFiles(folder),
      ])
      for (const groupPath of groupPaths) {
        try {
          const descriptor = groupDescriptor(groupPath)
          groups.set(normalizeKey(groupPath), descriptor)
          this.addLocal(groupRoots, descriptor.groupDir, descriptor)
        } catch (error) {
          this.output.appendLine(
            `Delphi group skipped (${groupPath}): ${errorMessage(error)}`,
          )
        }
      }
      for (const projectPath of projectPaths) {
        try {
          const descriptor = minimalProjectDescriptor(projectPath)
          projects.set(normalizeKey(projectPath), descriptor)
          if (descriptor.kind === PascalKeyword.Package)
            this.addLocal(packageRoots, descriptor.projectDir, descriptor)
        } catch (error) {
          this.output.appendLine(
            `Delphi project skipped (${projectPath}): ${errorMessage(error)}`,
          )
        }
      }
    }
    this.projects = projects
    this.groups = groups
    this.packageRoots = packageRoots
    this.groupRoots = groupRoots
    await this.context.workspaceState.update(CACHE_KEY, {
      version: CACHE_VERSION,
      projects: [...projects.values()].map(
        /**
         * Capture each project descriptor with its current file signature for cache
         * validation.
         */ (descriptor) => ({
          descriptor,
          projectPath: descriptor.projectPath,
          signature: statSignature(descriptor.projectPath),
        }),
      ),
      groups: [...groups.values()].map(
        /** Capture each project group path and file signature for cache validation. */ (
          descriptor,
        ) => ({
          groupPath: descriptor.groupPath,
          signature: statSignature(descriptor.groupPath),
        }),
      ),
    })
    this.output.appendLine(
      `Delphi project model ready: ${projects.size} project(s), ${groups.size} group(s), ${packageRoots.size} package root(s).`,
    )
    this.emitChange()
  }

  /**
   * Append a descriptor under its canonical directory key without replacing other
   * projects sharing that root.
   */
  addLocal<T>(map: Map<string, T[]>, directory: string, descriptor: T) {
    const key = normalizeKey(directory)
    const values = map.get(key) || []
    values.push(descriptor)
    map.set(key, values)
  }

  /** Return the workspace root paths used by project discovery. */
  workspaceFolders() {
    return this.workspaceRoots
  }

  /**
   * Return packages indexed under a canonical directory, or an empty list when that
   * root is unknown.
   */
  packageProjects(directory: string) {
    return this.packageRoots.get(normalizeKey(directory)) || []
  }

  /**
   * Return project groups indexed under a canonical directory, or an empty list when
   * that root is unknown.
   */
  groupsAt(directory: string) {
    return this.groupRoots.get(normalizeKey(directory)) || []
  }

  /** Look up a project descriptor using the canonical absolute project path. */
  project(projectPath: string) {
    return this.projects.get(normalizeKey(projectPath))
  }

  /** Return one original-spelling directory path for each indexed package root. */
  packageRootPaths() {
    return [...this.packageRoots.values()].flatMap(
      /** Collect the first project directory for each indexed project bucket. */ (
        values,
      ) => (values.length ? [values[0].projectDir] : []),
    )
  }

  /**
   * Return one original-spelling directory path for each indexed project-group root.
   */
  groupRootPaths() {
    return [...this.groupRoots.values()].flatMap(
      /** Collect the first group directory for each indexed group bucket. */ (
        values,
      ) => (values.length ? [values[0].groupDir] : []),
    )
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
  statSignature,
}
