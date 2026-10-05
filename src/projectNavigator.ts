import type { ProjectDescriptor, GroupDescriptor } from "./delphiProjectModel"
import { ConfigurationSection, FileExtension, SettingKey } from "./shared/identifiers"
import { PascalKeyword } from "./shared/pascal"
import * as path from "node:path"
import * as vscode from "vscode"
import { DelphiProjectModel, minimalProjectDescriptor } from "./delphiProjectModel"
import { normalizeKey } from "./projectDiscovery"

export interface ProjectNavigationNode {
  id: string
  kind: string
  label: string
  filePath?: string
  fsPath?: string
  projectPath?: string
  groupPath?: string
  projectPaths?: string[]
  contextValue?: string
  children: ProjectNavigationNode[]
  parent?: ProjectNavigationNode
}
interface ProjectNavigationOptions {
  showDpr?: boolean
  showGroupproj?: boolean
  showDpk?: boolean
  showDproj?: boolean
}
type NavigationDescriptor = Pick<
  ProjectDescriptor,
  "name" | "kind" | "projectPath" | "projectDir" | "mainSource"
>
type NavigationGroup = Pick<
  GroupDescriptor,
  "name" | "groupPath" | "groupDir" | "projectPaths"
>
interface ProjectNavigationModel {
  groups: Map<string, NavigationGroup>
  projects: Map<string, NavigationDescriptor>
  /** Return the workspace roots used to group standalone projects. */
  workspaceFolders(): string[]
  /** Look up cached metadata for a project path before attempting a disk read. */
  project?(projectPath: string): NavigationDescriptor | undefined
}
/**
 * Build file-navigation nodes from resolved paths, deduplicating their identities
 * while retaining each file's display name.
 */
function uniqueFileNodes(
  paths: (string | undefined)[],
  parentId: string,
): ProjectNavigationNode[] {
  const seen = new Set()
  const result: ProjectNavigationNode[] = []
  for (const filePath of paths.filter(
    /**
     * Ignore missing or empty file paths before canonicalizing and deduplicating them.
     */ (value): value is string => Boolean(value),
  )) {
    const resolved = path.resolve(filePath)
    const key = normalizeKey(resolved)
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      id: `${parentId}:file:${key}`,
      kind: PascalKeyword.File,
      label: path.basename(resolved),
      filePath: resolved,
      children: [],
    })
  }
  return result
}

/**
 * Use an indexed project descriptor when available, otherwise read minimal project
 * metadata and omit unreadable projects.
 */
function resolveDescriptor(model: ProjectNavigationModel, projectPath: string) {
  const cached = model.project?.(projectPath)
  if (cached) return cached
  try {
    return minimalProjectDescriptor(projectPath)
  } catch {
    return undefined
  }
}

/**
 * Build a package tree node with the enabled DPK/DPROJ child files and package action
 * context.
 */
function packageNode(
  descriptor: NavigationDescriptor,
  parentId: string,
  options: ProjectNavigationOptions = {},
): ProjectNavigationNode {
  const id = `${parentId}:package:${normalizeKey(descriptor.projectPath)}`
  return {
    id,
    kind: PascalKeyword.Package,
    label: descriptor.name,
    fsPath: descriptor.projectDir,
    projectPath: descriptor.projectPath,
    contextValue: "pascalAtlas.projectNavigator.package",
    children: uniqueFileNodes(
      [
        options.showDpk === false ? undefined : descriptor.mainSource,
        options.showDproj === false ? undefined : descriptor.projectPath,
      ],
      id,
    ),
  }
}

/**
 * Place visible group/application files before package nodes, honoring the independent
 * project-file visibility switches.
 */
function projectChildren(
  descriptors: NavigationDescriptor[],
  projectFile: string | undefined,
  parentId: string,
  options: ProjectNavigationOptions = {},
) {
  const applicationFiles = descriptors
    .filter(
      /**
       * Select application and library descriptors whose main sources can appear as
       * program files.
       */ (item) =>
        item && (item.kind === "application" || item.kind === PascalKeyword.Library),
    )
    .map(
      /** Include each main source only when program-file visibility is enabled. */ (
        item,
      ) => (options.showDpr === false ? undefined : item.mainSource),
    )
    .filter(
      /** Retain program sources and omit other main-source file kinds. */ (item) =>
        path.extname(item || "").toLowerCase() === FileExtension.Program,
    )
  const files = uniqueFileNodes(
    [options.showGroupproj === false ? undefined : projectFile, ...applicationFiles],
    parentId,
  )
  const packages = descriptors
    .filter(
      /** Select package descriptors for package-specific nodes and actions. */ (
        item,
      ) => item?.kind === PascalKeyword.Package,
    )
    .map(
      /** Build each package node with the configured source/project-file visibility. */ (
        item,
      ) => packageNode(item, parentId, options),
    )
  return [...files, ...packages]
}

/**
 * Build group-authoritative project roots and standalone-workspace fallbacks, then
 * attach parent links for tree navigation.
 */
function projectNavigationModel(
  model: ProjectNavigationModel,
  options: ProjectNavigationOptions = {},
): ProjectNavigationNode[] {
  const roots: ProjectNavigationNode[] = []
  const groupedProjects = new Set()
  const groups = [...model.groups.values()].sort(
    /** Order project groups by path for stable presentation. */ (left, right) =>
      left.groupPath.localeCompare(right.groupPath),
  )
  for (const group of groups) {
    const id = `project:group:${normalizeKey(group.groupPath)}`
    const descriptors = group.projectPaths
      .map(
        /** Mark each referenced project as grouped and resolve its descriptor. */ (
          projectPath,
        ) => {
          groupedProjects.add(normalizeKey(projectPath))
          return resolveDescriptor(model, projectPath)
        },
      )
      .filter(
        /** Omit project references whose descriptors could not be read. */ (
          descriptor,
        ): descriptor is NavigationDescriptor => Boolean(descriptor),
      )
    roots.push({
      id,
      kind: "project",
      label: group.name,
      fsPath: group.groupDir,
      groupPath: group.groupPath,
      projectPaths: group.projectPaths,
      contextValue: "pascalAtlas.projectNavigator.project",
      children: projectChildren(descriptors, group.groupPath, id, options),
    })
  }

  // Keep standalone DPROJ/DPK workspaces useful even when they have no
  // groupproj. When a workspace does contain a groupproj, that file is the
  // authoritative project/package relationship. Showing every other DPROJ as
  // one synthetic workspace project flattens unrelated tools, tests and legacy
  // projects into a misleading second tree.
  for (const workspaceRoot of model.workspaceFolders()) {
    const hasWorkspaceGroup = groups.some(
      /**
       * Check whether a project group inside this workspace already defines its project
       * tree.
       */ (group) => {
        const relative = path.relative(workspaceRoot, group.groupPath)
        return (
          relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
        )
      },
    )
    if (hasWorkspaceGroup) continue
    const descriptors = [...model.projects.values()].filter(
      /** Keep ungrouped project descriptors contained in this workspace root. */ (
        descriptor,
      ) => {
        if (groupedProjects.has(normalizeKey(descriptor.projectPath))) return false
        const relative = path.relative(workspaceRoot, descriptor.projectPath)
        return (
          relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
        )
      },
    )
    if (!descriptors.length) continue
    const id = `project:workspace:${normalizeKey(workspaceRoot)}`
    roots.push({
      id,
      kind: "project",
      label: path.basename(workspaceRoot),
      fsPath: workspaceRoot,
      projectPaths: descriptors.map(
        /** Retain the standalone projects' paths for project-level actions. */ (
          item,
        ) => item.projectPath,
      ),
      contextValue: "pascalAtlas.projectNavigator.looseProject",
      children: projectChildren(descriptors, undefined, id, options),
    })
  }
  /**
   * Assign parent links recursively so tree reveal and context actions can recover
   * each project node's ancestry.
   */
  const attachParents = (
    nodes: ProjectNavigationNode[],
    parent: ProjectNavigationNode | undefined,
  ) => {
    for (const node of nodes) {
      node.parent = parent
      attachParents(node.children || [], node)
    }
  }
  attachParents(roots, undefined)
  return roots
}

/**
 * Expand project roots by default and expand package nodes only when the configured
 * expansion mode requests all nodes.
 */
function projectInitialCollapsibleState(
  kind: string,
  defaultExpansion: string,
  vscodeApi: Pick<typeof vscode, "TreeItemCollapsibleState"> = vscode,
) {
  if (kind === "project") return vscodeApi.TreeItemCollapsibleState.Expanded
  if (kind === PascalKeyword.Package) {
    return defaultExpansion === "all"
      ? vscodeApi.TreeItemCollapsibleState.Expanded
      : vscodeApi.TreeItemCollapsibleState.Collapsed
  }
  return vscodeApi.TreeItemCollapsibleState.None
}

class ProjectNavigatorProvider {
  model
  emitter
  onDidChangeTreeData
  roots: ProjectNavigationNode[]

  /**
   * Create the project tree provider, its change emitter, and an initial view of the
   * indexed project model.
   */
  constructor(model: DelphiProjectModel) {
    this.model = model
    this.emitter = new vscode.EventEmitter<ProjectNavigationNode | undefined>()
    this.onDidChangeTreeData = this.emitter.event
    this.roots = []
    this.refresh()
  }

  /**
   * Rebuild the visible project roots from current settings and emit a full tree-data
   * refresh.
   */
  refresh() {
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection)
    this.roots = projectNavigationModel(this.model, {
      showGroupproj: configuration.get(SettingKey.ProjectNavigatorShowGroupproj, true),
      showDpr: configuration.get(SettingKey.ProjectNavigatorShowDpr, true),
      showDpk: configuration.get(SettingKey.ProjectNavigatorShowDpk, true),
      showDproj: configuration.get(SettingKey.ProjectNavigatorShowDproj, true),
    })
    this.emitter.fire(undefined)
  }

  /**
   * Return a node's children or the root projects when VS Code requests the top level.
   */
  getChildren(element?: ProjectNavigationNode) {
    return element ? element.children || [] : this.roots
  }

  /** Expose the stored parent link used by tree reveal operations. */
  getParent(element: ProjectNavigationNode) {
    return element?.parent
  }

  /**
   * Render a project/package/file node with its context, expansion state, icons, and
   * applicable open action.
   */
  getTreeItem(element: ProjectNavigationNode) {
    if (element.kind === PascalKeyword.File) {
      const item = new vscode.TreeItem(
        element.label,
        vscode.TreeItemCollapsibleState.None,
      )
      item.id = element.id
      item.tooltip = element.filePath
      item.command = {
        command: "vscode.open",
        title: "Open Delphi project file",
        arguments: [vscode.Uri.file(element.filePath || "")],
      }
      return item
    }
    const defaultExpansion = vscode.workspace
      .getConfiguration(ConfigurationSection)
      .get(SettingKey.ProjectNavigatorDefaultExpansion, "firstLevel")
    const item = new vscode.TreeItem(
      element.label,
      projectInitialCollapsibleState(element.kind, defaultExpansion),
    )
    item.id = element.id
    item.contextValue = element.contextValue
    item.tooltip = element.groupPath || element.projectPath || element.fsPath
    item.iconPath = new vscode.ThemeIcon(
      element.kind === PascalKeyword.Package ? PascalKeyword.Package : "project",
    )
    return item
  }

  /** Release the project tree change emitter when the provider is retired. */
  dispose() {
    this.emitter.dispose()
  }
}

export {
  ProjectNavigatorProvider,
  packageNode,
  projectInitialCollapsibleState,
  projectNavigationModel,
}
