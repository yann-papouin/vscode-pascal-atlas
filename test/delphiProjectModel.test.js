'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  findDprojFiles,
  groupDescriptor,
  minimalProjectDescriptor,
  projectDescriptor
} = require('../src/delphiProjectModel');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-union-build-model-'));
  const source = path.join(root, 'Source');
  const packageDir = path.join(source, 'Demo.Package');
  const appDir = path.join(source, 'Demo.App');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(appDir, { recursive: true });
  const packageProject = path.join(packageDir, 'Demo.Package.dproj');
  const appProject = path.join(appDir, 'Demo.App.dproj');
  const packageSource = path.join(packageDir, 'Demo.Package.dpk');
  const appSource = path.join(appDir, 'Demo.App.dpr');
  const group = path.join(source, 'Demo.groupproj');
  fs.writeFileSync(packageSource, 'package Demo.Package; end.', 'utf8');
  fs.writeFileSync(appSource, 'program DemoApp; begin end.', 'utf8');
  fs.writeFileSync(packageProject, `<Project>
    <PropertyGroup><MainSource>Demo.Package.dpk</MainSource><Config>Debug</Config><Platform>Win64</Platform></PropertyGroup>
    <PropertyGroup><DCC_BplOutput>..\\bin</DCC_BplOutput><DCC_DcpOutput>..\\lib</DCC_DcpOutput><Debugger_HostApplication>..\\bin\\Demo.App.exe</Debugger_HostApplication></PropertyGroup>
  </Project>`, 'utf8');
  fs.writeFileSync(appProject, `<Project><PropertyGroup><MainSource>Demo.App.dpr</MainSource><Config>Debug</Config><Platform>Win64</Platform><DCC_ExeOutput>..\\bin</DCC_ExeOutput></PropertyGroup></Project>`, 'utf8');
  fs.writeFileSync(group, `<Project><ItemGroup>
    <Projects Include="Demo.Package\\Demo.Package.dproj"><Dependencies/></Projects>
    <Projects Include="Demo.App\\Demo.App.dproj"><Dependencies>Demo_Package</Dependencies></Projects>
  </ItemGroup></Project>`, 'utf8');
  return { root, source, packageDir, packageProject, appProject, group };
}

test('Delphi project model recognizes package roots and resolves real artifacts', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const minimal = minimalProjectDescriptor(value.packageProject);
  assert.equal(minimal.kind, 'package');
  assert.equal(minimal.projectDir, value.packageDir);
  const detailed = projectDescriptor(value.packageProject, { configuration: 'Debug', platform: 'Win64' });
  assert.equal(detailed.output, path.join(value.source, 'bin', 'Demo.Package.bpl'));
  assert.equal(detailed.dcpFile, path.join(value.source, 'lib', 'Demo.Package.dcp'));
  assert.equal(detailed.debugHost, path.join(value.source, 'bin', 'Demo.App.exe'));
});

test('group descriptor preserves groupproj project order and dependencies', t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const group = groupDescriptor(value.group);
  assert.deepEqual(group.projectPaths, [value.packageProject, value.appProject]);
  assert.deepEqual(group.dependencies.get(path.resolve(value.appProject).toLowerCase()), ['Demo_Package']);
});

test('workspace DPROJ discovery finds package and application projects', async t => {
  const value = fixture();
  t.after(() => fs.rmSync(value.root, { recursive: true, force: true }));
  const projects = await findDprojFiles(value.root);
  assert.deepEqual(projects.sort(), [value.appProject, value.packageProject].sort());
});

