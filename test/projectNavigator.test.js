'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === 'vscode') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { projectInitialCollapsibleState, projectNavigationModel } = require('../src/projectNavigator');
Module._load = originalLoad;

test('project navigator groups group/application files above package nodes', () => {
  const root = path.resolve('D:/Demo');
  const groupPath = path.join(root, 'Demo.groupproj');
  const appProject = path.join(root, 'DemoApp.dproj');
  const packageProject = path.join(root, 'Core', 'Core.dproj');
  const descriptors = new Map([
    [appProject.toLowerCase(), {
      kind: 'application', name: 'DemoApp', projectPath: appProject,
      projectDir: root, mainSource: path.join(root, 'DemoApp.dpr')
    }],
    [packageProject.toLowerCase(), {
      kind: 'package', name: 'Core', projectPath: packageProject,
      projectDir: path.dirname(packageProject), mainSource: path.join(root, 'Core', 'Core.dpk')
    }]
  ]);
  const model = {
    groups: new Map([['group', {
      name: 'Demo', groupPath, groupDir: root, projectPaths: [appProject, packageProject]
    }]]),
    projects: descriptors,
    workspaceFolders: () => [root],
    project: projectPath => descriptors.get(path.resolve(projectPath).toLowerCase())
  };

  const roots = projectNavigationModel(model);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].label, 'Demo');
  assert.equal(roots[0].contextValue, 'pascalAtlas.projectNavigator.project');
  assert.deepEqual(roots[0].children.map(item => item.label), [
    'Demo.groupproj', 'DemoApp.dpr', 'Core'
  ]);
  const packageItem = roots[0].children[2];
  assert.equal(packageItem.contextValue, 'pascalAtlas.projectNavigator.package');
  assert.deepEqual(packageItem.children.map(item => item.label), ['Core.dpk', 'Core.dproj']);
  assert.ok(packageItem.children.every(item => item.kind === 'file'));
});

test('groupproj is authoritative and suppresses a synthetic loose workspace tree', () => {
  const root = path.resolve('D:/BevelCompWork');
  const groupPath = path.join(root, 'Tubest_Trunk_XE.groupproj');
  const groupedProject = path.join(root, 'CAD', 'gks.dproj');
  const looseProject = path.join(root, 'Plugins', 'reports.dproj');
  const descriptors = new Map([
    [groupedProject.toLowerCase(), {
      kind: 'package', name: 'gks', projectPath: groupedProject,
      projectDir: path.dirname(groupedProject), mainSource: path.join(root, 'CAD', 'gks.dpk')
    }],
    [looseProject.toLowerCase(), {
      kind: 'application', name: 'reports', projectPath: looseProject,
      projectDir: path.dirname(looseProject), mainSource: path.join(root, 'Plugins', 'reports.dpr')
    }]
  ]);
  const model = {
    groups: new Map([['group', {
      name: 'Tubest_Trunk_XE', groupPath, groupDir: root, projectPaths: [groupedProject]
    }]]),
    projects: descriptors,
    workspaceFolders: () => [root],
    project: projectPath => descriptors.get(path.resolve(projectPath).toLowerCase())
  };
  const roots = projectNavigationModel(model);
  assert.deepEqual(roots.map(item => item.label), ['Tubest_Trunk_XE']);
  assert.equal(roots[0].children.some(item => item.label === 'reports.dpr'), false);
});

test('project navigator file switches hide only requested project file types', () => {
  const root = path.resolve('D:/Demo');
  const groupPath = path.join(root, 'Demo.groupproj');
  const packageProject = path.join(root, 'Core.dproj');
  const descriptor = {
    kind: 'package', name: 'Core', projectPath: packageProject,
    projectDir: root, mainSource: path.join(root, 'Core.dpk')
  };
  const model = {
    groups: new Map([['group', { name: 'Demo', groupPath, groupDir: root, projectPaths: [packageProject] }]]),
    projects: new Map([[packageProject.toLowerCase(), descriptor]]),
    workspaceFolders: () => [root],
    project: () => descriptor
  };
  const [projectItem] = projectNavigationModel(model, { showGroupproj: false, showDpk: false });
  assert.deepEqual(projectItem.children.map(item => item.label), ['Core']);
  assert.deepEqual(projectItem.children[0].children.map(item => item.label), ['Core.dproj']);
});

test('project navigator expands only the project level by default', () => {
  const api = { TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 } };
  assert.equal(projectInitialCollapsibleState('project', 'firstLevel', api), 2);
  assert.equal(projectInitialCollapsibleState('package', 'firstLevel', api), 1);
  assert.equal(projectInitialCollapsibleState('package', 'all', api), 2);
  assert.equal(projectInitialCollapsibleState('file', 'firstLevel', api), 0);
});
