import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test as test } from 'node:test';
import { ensureVallentaProjectGroups, findWorkspaceProjectGroups } from '../src/projectDiscovery';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-atlas-projects-'));
  const source = path.join(root, 'Source');
  const projectDirectory = path.join(source, 'Demo');
  fs.mkdirSync(projectDirectory, { recursive: true });
  const project = path.join(projectDirectory, 'Demo.dproj');
  const group = path.join(source, 'DemoGroup.groupproj');
  fs.writeFileSync(project, '<Project/>', 'utf8');
  fs.writeFileSync(group, '<Project><ItemGroup><Projects Include="Demo\\Demo.dproj"/></ItemGroup></Project>', 'utf8');
  return { root, group, project };
}

test('new workspaces discover groupproj and initialize Vallenta project state', async t => {
  const { root, group, project } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.deepEqual(await findWorkspaceProjectGroups(root), [group]);
  const first = await ensureVallentaProjectGroups(root, { activateFirstProject: true });
  assert.equal(first.changed, true);
  assert.deepEqual(first.addedGroups, [group]);

  const projects = JSON.parse(fs.readFileSync(path.join(root, '.vallenta', 'projects.json'), 'utf8'));
  assert.deepEqual(projects.projectGroups, [group]);
  const local = JSON.parse(fs.readFileSync(path.join(root, '.vallenta', 'projects.local.json'), 'utf8'));
  assert.equal(local.activeProject.projectPath, project);
  assert.equal(local.activeProject.groupPath, group);

  const second = await ensureVallentaProjectGroups(root, { activateFirstProject: true });
  assert.equal(second.changed, false);
  assert.deepEqual(second.addedGroups, []);
});

test('automatic detection preserves existing Vallenta fields and active project', async t => {
  const { root, group, project } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vallenta = path.join(root, '.vallenta');
  fs.mkdirSync(vallenta, { recursive: true });
  fs.writeFileSync(path.join(vallenta, 'projects.json'), JSON.stringify({
    projects: ['Manual.dproj'], projectGroups: [], customValue: 42
  }), 'utf8');
  const existingProject = path.join(root, 'Keep.dproj');
  fs.writeFileSync(existingProject, '<Project/>', 'utf8');
  fs.writeFileSync(path.join(vallenta, 'projects.local.json'), JSON.stringify({
    activeProject: { projectPath: existingProject }, customLocal: true
  }), 'utf8');

  await ensureVallentaProjectGroups(root, { activateFirstProject: true });
  const projects = JSON.parse(fs.readFileSync(path.join(vallenta, 'projects.json'), 'utf8'));
  const local = JSON.parse(fs.readFileSync(path.join(vallenta, 'projects.local.json'), 'utf8'));
  assert.equal(projects.customValue, 42);
  assert.deepEqual(projects.projects, ['Manual.dproj']);
  assert.deepEqual(projects.projectGroups, [group]);
  assert.equal(local.activeProject.projectPath, existingProject);
  assert.equal(local.customLocal, true);
  assert.notEqual(local.activeProject.projectPath, project);
});

test('automatic detection repairs an active project copied from another workspace', async t => {
  const { root, group, project } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vallenta = path.join(root, '.vallenta');
  fs.mkdirSync(vallenta, { recursive: true });
  const oldGroupDirectory = path.join(root, '..', 'OldCopy');
  fs.writeFileSync(path.join(vallenta, 'projects.local.json'), JSON.stringify({
    activeProject: {
      projectPath: path.join(oldGroupDirectory, 'Demo', 'Demo.dproj'),
      groupPath: path.join(oldGroupDirectory, 'DemoGroup.groupproj')
    }
  }), 'utf8');

  const result = await ensureVallentaProjectGroups(root, { activateFirstProject: true });
  const local = JSON.parse(fs.readFileSync(path.join(vallenta, 'projects.local.json'), 'utf8'));
  assert.equal(result.activeProjectChanged, true);
  assert.equal(result.repairedInvalidActiveProject, true);
  assert.deepEqual(local.activeProject, { projectPath: project, groupPath: group });
});
