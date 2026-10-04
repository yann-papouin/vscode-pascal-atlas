'use strict';

const path = require('node:path');
const vscode = require('vscode');
const { minimalProjectDescriptor } = require('./delphiProjectModel');
const { normalizeKey } = require('./projectDiscovery');

function uniqueFileNodes(paths, parentId) {
  const seen = new Set();
  const result = [];
  for (const filePath of paths.filter(Boolean)) {
    const resolved = path.resolve(filePath);
    const key = normalizeKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: `${parentId}:file:${key}`,
      kind: 'file',
      label: path.basename(resolved),
      filePath: resolved,
      children: []
    });
  }
  return result;
}

function resolveDescriptor(model, projectPath) {
  const cached = model.project(projectPath);
  if (cached) return cached;
  try { return minimalProjectDescriptor(projectPath); } catch { return undefined; }
}

function packageNode(descriptor, parentId, options = {}) {
  const id = `${parentId}:package:${normalizeKey(descriptor.projectPath)}`;
  return {
    id,
    kind: 'package',
    label: descriptor.name,
    fsPath: descriptor.projectDir,
    projectPath: descriptor.projectPath,
    contextValue: 'pascalAtlas.projectNavigator.package',
    children: uniqueFileNodes([
      options.showDpk === false ? undefined : descriptor.mainSource,
      options.showDproj === false ? undefined : descriptor.projectPath
    ], id)
  };
}

function projectChildren(descriptors, projectFile, parentId, options = {}) {
  const applicationFiles = descriptors
    .filter(item => item && (item.kind === 'application' || item.kind === 'library'))
    .map(item => options.showDpr === false ? undefined : item.mainSource)
    .filter(item => path.extname(item || '').toLowerCase() === '.dpr');
  const files = uniqueFileNodes([
    options.showGroupproj === false ? undefined : projectFile,
    ...applicationFiles
  ], parentId);
  const packages = descriptors
    .filter(item => item?.kind === 'package')
    .map(item => packageNode(item, parentId, options));
  return [...files, ...packages];
}

function projectNavigationModel(model, options = {}) {
  const roots = [];
  const groupedProjects = new Set();
  const groups = [...model.groups.values()].sort((left, right) => left.groupPath.localeCompare(right.groupPath));
  for (const group of groups) {
    const id = `project:group:${normalizeKey(group.groupPath)}`;
    const descriptors = group.projectPaths.map(projectPath => {
      groupedProjects.add(normalizeKey(projectPath));
      return resolveDescriptor(model, projectPath);
    }).filter(Boolean);
    roots.push({
      id,
      kind: 'project',
      label: group.name,
      fsPath: group.groupDir,
      groupPath: group.groupPath,
      projectPaths: group.projectPaths,
      contextValue: 'pascalAtlas.projectNavigator.project',
      children: projectChildren(descriptors, group.groupPath, id, options)
    });
  }

  // Keep standalone DPROJ/DPK workspaces useful even when they have no
  // groupproj. When a workspace does contain a groupproj, that file is the
  // authoritative project/package relationship. Showing every other DPROJ as
  // one synthetic workspace project flattens unrelated tools, tests and legacy
  // projects into a misleading second tree.
  for (const workspaceRoot of model.workspaceFolders()) {
    const hasWorkspaceGroup = groups.some(group => {
      const relative = path.relative(workspaceRoot, group.groupPath);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (hasWorkspaceGroup) continue;
    const descriptors = [...model.projects.values()].filter(descriptor => {
      if (groupedProjects.has(normalizeKey(descriptor.projectPath))) return false;
      const relative = path.relative(workspaceRoot, descriptor.projectPath);
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    });
    if (!descriptors.length) continue;
    const id = `project:workspace:${normalizeKey(workspaceRoot)}`;
    roots.push({
      id,
      kind: 'project',
      label: path.basename(workspaceRoot),
      fsPath: workspaceRoot,
      projectPaths: descriptors.map(item => item.projectPath),
      contextValue: 'pascalAtlas.projectNavigator.looseProject',
      children: projectChildren(descriptors, undefined, id, options)
    });
  }
  const attachParents = (nodes, parent) => {
    for (const node of nodes) {
      node.parent = parent;
      attachParents(node.children || [], node);
    }
  };
  attachParents(roots, undefined);
  return roots;
}

function projectInitialCollapsibleState(kind, defaultExpansion, vscodeApi = vscode) {
  if (kind === 'project') return vscodeApi.TreeItemCollapsibleState.Expanded;
  if (kind === 'package') {
    return defaultExpansion === 'all'
      ? vscodeApi.TreeItemCollapsibleState.Expanded
      : vscodeApi.TreeItemCollapsibleState.Collapsed;
  }
  return vscodeApi.TreeItemCollapsibleState.None;
}

class ProjectNavigatorProvider {
  constructor(model) {
    this.model = model;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.roots = [];
    this.refresh();
  }

  refresh() {
    const configuration = vscode.workspace.getConfiguration('pascalAtlas');
    this.roots = projectNavigationModel(this.model, {
      showGroupproj: configuration.get('projectNavigator.showGroupproj', true),
      showDpr: configuration.get('projectNavigator.showDpr', true),
      showDpk: configuration.get('projectNavigator.showDpk', true),
      showDproj: configuration.get('projectNavigator.showDproj', true)
    });
    this.emitter.fire(undefined);
  }

  getChildren(element) {
    return element ? element.children || [] : this.roots;
  }

  getParent(element) {
    return element?.parent;
  }

  getTreeItem(element) {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.id = element.id;
      item.tooltip = element.filePath;
      item.command = {
        command: 'vscode.open',
        title: 'Open Delphi project file',
        arguments: [vscode.Uri.file(element.filePath)]
      };
      return item;
    }
    const defaultExpansion = vscode.workspace.getConfiguration('pascalAtlas')
      .get('projectNavigator.defaultExpansion', 'firstLevel');
    const item = new vscode.TreeItem(
      element.label,
      projectInitialCollapsibleState(element.kind, defaultExpansion)
    );
    item.id = element.id;
    item.contextValue = element.contextValue;
    item.tooltip = element.groupPath || element.projectPath || element.fsPath;
    item.iconPath = new vscode.ThemeIcon(element.kind === 'package' ? 'package' : 'project');
    return item;
  }

  dispose() {
    this.emitter.dispose();
  }
}

module.exports = {
  ProjectNavigatorProvider,
  packageNode,
  projectInitialCollapsibleState,
  projectNavigationModel
};
