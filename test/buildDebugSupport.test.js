'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');

const originalLoad = Module._load;
class TestEventEmitter {
  constructor() {
    this.values = [];
    this.event = () => ({ dispose() {} });
  }

  fire(value) {
    this.values.push(value);
  }

  dispose() {}
}

Module._load = function loadWithVscodeStub(request, parent, isMain) {
  if (request === 'vscode') return { EventEmitter: TestEventEmitter };
  return originalLoad.call(this, request, parent, isMain);
};
const {
  BuildTerminalSession,
  appendMsbuildProperties,
  buildOutputCategory,
  formalBuildEnvironment,
  formatBuildDuration,
  parseBuildDiagnosticLine,
  parseCommandLine,
  resolvedBuildSelection
} = require('../src/buildDebugSupport');
Module._load = originalLoad;

test('Run parameters preserve quoted arguments', () => {
  assert.deepEqual(parseCommandLine('--mode test "C:\\Program Files\\Demo data" /flag'), [
    '--mode', 'test', 'C:\\Program Files\\Demo data', '/flag'
  ]);
});

test('build completion duration is concise and stable', () => {
  assert.equal(formatBuildDuration(0), '0.0s');
  assert.equal(formatBuildDuration(2840), '2.8s');
});

test('build output categories keep errors, warnings and other messages independent', () => {
  assert.equal(buildOutputCategory('[ERROR] Unit1.pas(3): error E2029: Expected'), 'errors');
  assert.equal(buildOutputCategory('[WARN]  Unit1.pas(4): warning W1036: Unused'), 'warnings');
  assert.equal(buildOutputCategory('BUILD FAILED: Demo'), 'other');
});

test('changing build filters clears and redraws only the current build run', () => {
  const session = new BuildTerminalSession({ errors: true, warnings: true, other: true });
  session.open();
  session.emitLine('previous build output');
  session.beginRun({ errors: true, warnings: true, other: true });
  session.emitLine('[ERROR] current error');
  session.emitLine('[WARN]  current warning');
  session.emitLine('current other output');

  session.setFilters({ errors: false, warnings: true, other: true });

  const redraw = session.writeEmitter.values.at(-1);
  assert.match(redraw, /^\x1b\[2J\x1b\[3J\x1b\[H/);
  assert.doesNotMatch(redraw, /previous build output/);
  assert.doesNotMatch(redraw, /current error/);
  assert.match(redraw, /current warning/);
  assert.match(redraw, /current other output/);
});

test('hidden build diagnostics can still be restored into Problems', () => {
  const classic = parseBuildDiagnosticLine(
    '[ERROR] Unit1.pas(16): error E2029: Statement expected [D:\\Demo\\Demo.dproj]',
    'D:\\Demo'
  );
  assert.equal(classic.filePath, path.resolve('D:\\Demo', 'Unit1.pas'));
  assert.equal(classic.line, 15);
  assert.equal(classic.severity, 'error');
  assert.equal(classic.code, 'E2029');
  assert.equal(classic.message, 'Statement expected');

  const warning = parseBuildDiagnosticLine(
    '[WARN]  [dcc32 Warning] D:\\Demo\\Unit2.pas(42,7): W1036 Variable might not have been initialized',
    'D:\\Demo'
  );
  assert.equal(warning.line, 41);
  assert.equal(warning.column, 6);
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.code, 'W1036');
});

test('formal builds do not inherit language-server unit search paths', () => {
  const environment = {
    Path: 'C:\\Windows',
    DCC_UnitSearchPath: 'D:\\Projects\\First;D:\\Projects\\Second',
    dcc_unitsearchpath: 'case-insensitive duplicate'
  };
  assert.deepEqual(formalBuildEnvironment(environment), { Path: 'C:\\Windows' });
  assert.equal(environment.DCC_UnitSearchPath, 'D:\\Projects\\First;D:\\Projects\\Second');
});

test('foreground build suppresses internal runner command echo and Run uses Debug Console', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'buildDebugSupport.js'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'resources', 'pascal-atlas-build-runner.ps1'), 'utf8');
  assert.match(source, /task\.presentationOptions\s*=\s*\{[\s\S]*?echo:\s*false/);
  assert.match(source, /showReuseMessage:\s*false/);
  assert.match(source, /'-File', runnerPath/);
  assert.doesNotMatch(source, /'-Command', BUILD_RUNNER_SCRIPT/);
  assert.doesNotMatch(runner, /Compiling target/);
  assert.match(runner, /\[ERROR\]/);
  assert.match(runner, /\[WARN\]  /);
  assert.match(runner, /bytes code/);
  assert.match(runner, /\.dproj/);
  assert.match(runner, /BUILD FAILED/);
  assert.match(runner, /errorCount/);
  assert.match(runner, /\[\?25h/);
  assert.match(runner, /\[\?25l/);
  assert.match(runner, /PASCAL_ATLAS_BUILD_RESULT/);
  assert.match(runner, /exit 0/);
  assert.match(source, /DebugAdapterInlineImplementation/);
  assert.match(source, /category:\s*'stdout'/);
  assert.match(source, /category:\s*'stderr'/);
  assert.match(source, /noDebug:\s*true/);
  assert.doesNotMatch(source, /suppressDebugStatusbar:\s*true/);
  assert.match(source, /workbench\.debug\.action\.focusRepl/);
  assert.doesNotMatch(source, /vscode\.debug\.activeDebugConsole/);
  assert.doesNotMatch(source, /EXTERNAL_RUNNER_SCRIPT|runInExternalConsole|runInIntegratedTerminal/);
});

test('status bar build selection resolves auto to the Delphi project defaults', () => {
  const temporary = path.join(__dirname, 'status-selection.dproj');
  fs.writeFileSync(temporary, [
    '<Project>',
    "<PropertyGroup><Config Condition=\"'$(Config)'==''\">Release</Config><Platform Condition=\"'$(Platform)'==''\">Win64</Platform></PropertyGroup>",
    '</Project>'
  ].join(''));
  try {
    assert.deepEqual(resolvedBuildSelection(temporary, { configuration: 'auto', platform: 'auto' }), {
      configuration: 'Release',
      platform: 'Win64'
    });
    assert.deepEqual(resolvedBuildSelection(temporary, { configuration: 'Debug', platform: 'Win32' }), {
      configuration: 'Debug',
      platform: 'Win32'
    });
  } finally {
    fs.unlinkSync(temporary);
  }
});

test('manifest keeps project commands out of the native Explorer and exposes them on the project tree', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'buildDebugSupport.js'), 'utf8');
  const navigatorSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'classNavigator.js'), 'utf8');
  const navigatorWebviewSource = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'classNavigatorWebview.js'),
    'utf8'
  );
  assert.equal(manifest.contributes.menus['explorer/context'], undefined);
  const treeMenus = manifest.contributes.menus['view/item/context'];
  const packageMenus = treeMenus.filter(item => item.when.includes('viewItem == pascalAtlas.projectNavigator.package'));
  const projectMenus = treeMenus.filter(item => item.when.includes('pascalAtlas.navigator.mode == project')
    && !item.when.includes('viewItem == pascalAtlas.projectNavigator.package')
    && !item.when.includes('!viewItem'));
  const backgroundMenus = treeMenus.filter(item => item.when.includes('!viewItem'));
  assert.deepEqual(
    packageMenus.map(item => item.command),
    [
      'pascalAtlas.build.buildPackage',
      'pascalAtlas.build.compilePackage',
      'pascalAtlas.build.cleanPackage'
    ]
  );
  assert.deepEqual(
    projectMenus.map(item => item.command),
    [
      'pascalAtlas.build.buildGroup',
      'pascalAtlas.build.compileGroup',
      'pascalAtlas.build.cleanGroup',
      'pascalAtlas.run.group',
      'pascalAtlas.build.selectConfiguration',
      'pascalAtlas.build.selectPlatform'
    ]
  );
  assert.deepEqual(backgroundMenus, [], 'VS Code does not expose a blank TreeView background context-menu contribution point');
  assert.ok(
    [...packageMenus, ...projectMenus].every(item => item.group.startsWith('1_pascalAtlas@')),
    'project tree commands must share an early dedicated separator group'
  );
  assert.equal(Object.keys(manifest.contributes.configuration.properties).some(key => key.startsWith('pascalAtlas.debugger.')), false);
  assert.ok(manifest.contributes.configuration.properties['pascalAtlas.build.terminalSummary']);
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.build.output.showErrors'].default, true);
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.build.output.showWarnings'].default, true);
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.build.output.showOther'].default, true);
  const terminalToolbar = manifest.contributes.menus['view/title'].filter(item =>
    item.when.includes('view == terminal') && /toggle(?:Errors|Warnings|Other)/.test(item.command)
  );
  assert.equal(terminalToolbar.length, 6);
  assert.ok(terminalToolbar.every(item => item.when.includes('pascalAtlas.buildTerminalActive')));
  const commands = new Map(manifest.contributes.commands.map(item => [item.command, item]));
  assert.equal(commands.get('pascalAtlas.build.toggleErrorsChecked').title, '✓ Show Errors');
  assert.equal(commands.get('pascalAtlas.build.toggleWarningsChecked').title, '✓ Show Warnings');
  assert.equal(commands.get('pascalAtlas.build.toggleOtherChecked').title, '✓ Show Other Messages');
  assert.deepEqual(commands.get('pascalAtlas.build.toggleErrorsChecked').icon, {
    light: 'media/build-filter-error-checked-light.svg',
    dark: 'media/build-filter-error-checked-dark.svg'
  });
  assert.deepEqual(commands.get('pascalAtlas.build.toggleWarningsChecked').icon, {
    light: 'media/build-filter-warning-checked-light.svg',
    dark: 'media/build-filter-warning-checked-dark.svg'
  });
  assert.deepEqual(commands.get('pascalAtlas.build.toggleOtherChecked').icon, {
    light: 'media/build-filter-info-checked-light.svg',
    dark: 'media/build-filter-info-checked-dark.svg'
  });
  assert.equal(
    manifest.contributes.configuration.properties['pascalAtlas.diagnostics.ignoreUtf8ConversionWarning'].default,
    true
  );
  assert.ok(manifest.contributes.menus['view/title'].some(item =>
    item.command === 'pascalAtlas.build.selectOutputFilters' && item.when.includes('view == terminal')));
  assert.ok(manifest.contributes.menus['view/title'].some(item =>
    item.command === 'pascalAtlas.classNavigator.find'
      && item.when.includes('pascalAtlas.navigator.mode == class')));
  assert.equal(manifest.contributes.commands.find(item =>
    item.command === 'pascalAtlas.classNavigator.find').icon, '$(search)');
  assert.equal(manifest.contributes.views.explorer.find(item =>
    item.id === 'pascalAtlas.classNavigator').type, 'webview');
  assert.equal(manifest.contributes.views.explorer.some(item =>
    item.id === 'pascalAtlas.classNavigatorSearch'), false);
  const webviewContextMenu = manifest.contributes.menus['webview/context'];
  assert.ok(Array.isArray(webviewContextMenu));
  assert.ok(webviewContextMenu.every(item => item.when.includes("webviewId == 'pascalAtlas.classNavigator'")));
  assert.ok(webviewContextMenu.some(item =>
    item.command === 'pascalAtlas.classNavigator.generateAiSteps'
      && item.when.includes("webviewSection == 'classSymbol'")));
  assert.ok(webviewContextMenu.some(item =>
    item.command === 'pascalAtlas.classNavigator.context.buildPackage'
      && item.when.includes("webviewSection == 'projectPackage'")));
  assert.ok(webviewContextMenu.some(item =>
    item.command === 'pascalAtlas.classNavigator.context.runGroup'
      && item.when.includes("webviewSection == 'projectGroup'")));
  assert.doesNotMatch(navigatorSource, /registerWebviewViewProvider\('pascalAtlas\.classNavigatorSearch'/);
  assert.doesNotMatch(navigatorSource, /createQuickPick\(\)/);
  assert.doesNotMatch(navigatorSource, /registerCommand\('pascalAtlas\.classNavigator\.selectSort',[\s\S]{0,1200}?showQuickPick/);
  assert.match(navigatorSource, /new ClassNavigatorWebview\(vscode, 'pascalAtlas\.classNavigator'/);
  assert.match(navigatorSource, /WEBVIEW_CONTEXT_COMMANDS\.map[\s\S]*?tree\.selection\[0\][\s\S]*?executeCommand\(command, target\)/);
  assert.match(navigatorSource, /workspaceState\.update\(SEARCH_OPTIONS_STATE_KEY, navigatorSearchOptions\)/);
  assert.match(navigatorWebviewSource, /id="scope"[\s\S]*?Current file[\s\S]*?Global/);
  assert.match(navigatorWebviewSource, /id="kind-types"[\s\S]*?id="kind-files"[\s\S]*?id="kind-routines"/);
  assert.match(navigatorWebviewSource, /Always live[\s\S]*?Current file only[\s\S]*?On confirmation/);
  assert.match(navigatorWebviewSource, /event\.key === 'Escape'[\s\S]*?hideSearch\(\)/);
  assert.match(navigatorWebviewSource, /id="sort-panel"[\s\S]*?id="member-order"[\s\S]*?id="type-order"/);
  assert.match(navigatorWebviewSource, /type:'sortUpdate', key, value/);
  assert.match(navigatorSource, /classNavigator\.selectSort'[\s\S]*?tree\.showSort/);
  assert.match(navigatorSource, /navigatorSearchSession[\s\S]*?tree\.hideSearch\(\)/);
  assert.match(navigatorSource, /tree\.sortPanelOpen[\s\S]*?tree\.hideSort\(\)/);
  const navigatorSearchKeybinding = manifest.contributes.keybindings.find(item =>
    item.command === 'pascalAtlas.classNavigator.find');
  assert.equal(navigatorSearchKeybinding.key, 'ctrl+alt+n');
  assert.match(navigatorSearchKeybinding.when, /editorLangId/);
  assert.match(navigatorSearchKeybinding.when, /focusedView == pascalAtlas\.classNavigator/);
  assert.match(navigatorSearchKeybinding.when, /pascalAtlas\.classNavigator\.webviewFocused/);
  assert.match(navigatorSource, /onFocusChanged:[\s\S]*?pascalAtlas\.classNavigator\.webviewFocused/);
  assert.match(navigatorSource, /onSearchClosed: restoreState => closeNavigatorSearch\(true, restoreState\)/);
  assert.match(navigatorSource, /restoreNavigatorSearchSession[\s\S]*?preserveFocus: true[\s\S]*?TextEditorRevealType\.AtTop[\s\S]*?tree\.restoreSearchState/);
  assert.equal(manifest.contributes.submenus, undefined);
  for (const location of ['terminal/context', 'terminal/title/context']) {
    const menu = manifest.contributes.menus[location];
    for (const suffix of ['Errors', 'Warnings', 'Other']) {
      const unchecked = menu.find(item => item.command === `pascalAtlas.build.toggle${suffix}`);
      const checked = menu.find(item => item.command === `pascalAtlas.build.toggle${suffix}Checked`);
      assert.match(unchecked.when, new RegExp(`!config\\.pascalAtlas\\.build\\.output\\.show${suffix}`));
      assert.match(checked.when, new RegExp(`(?<!!)config\\.pascalAtlas\\.build\\.output\\.show${suffix}`));
      assert.equal(checked.group, unchecked.group);
      const icon = manifest.contributes.commands.find(item => item.command === checked.command).icon;
      assert.equal(typeof icon, 'object');
      assert.match(icon.light, /-checked-light\.svg$/);
      assert.match(icon.dark, /-checked-dark\.svg$/);
    }
  }
  assert.deepEqual(
    ['pascalAtlas.build.toggleErrors', 'pascalAtlas.build.toggleWarnings', 'pascalAtlas.build.toggleOther']
      .map(command => manifest.contributes.commands.find(item => item.command === command).title),
    ['Show Errors', 'Show Warnings', 'Show Other Messages']
  );
  assert.match(source, /createQuickPick\(\)[\s\S]*?canSelectMany\s*=\s*true/);
  assert.match(source, /onDidChangeSelection\([\s\S]*?buildTerminalSession\?\.setFilters\(next\)/);
  assert.doesNotMatch(source, /showQuickPick\(items,\s*\{[\s\S]*?Pascal Atlas: Build Output/);
  assert.ok(manifest.contributes.configuration.properties['pascalAtlas.build.completionNotification']);
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.build.showStatusBar'].default, true);
  assert.ok(manifest.contributes.configuration.properties['pascalAtlas.projectNavigator.enabled']);
  assert.ok(manifest.contributes.configuration.properties['pascalAtlas.projectNavigator.contextMenus.enabled']);
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.run.buildBeforeRun'].default, 'ifOutdated');
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.run.console'], undefined);
  assert.ok(manifest.contributes.debuggers.some(item => item.type === 'pascal-atlas-run'));
  assert.ok(manifest.contributes.commands.some(item =>
    item.command === 'pascalAtlas.run.stop' && item.enablement === 'pascalAtlas.runInProgress'));
  assert.equal(manifest.contributes.commands.find(item =>
    item.command === 'pascalAtlas.run.group').enablement, '!pascalAtlas.executionBusy');
  assert.equal(manifest.contributes.commands.some(item => item.command.startsWith('pascalAtlas.debug.')), false);
  assert.ok(manifest.contributes.keybindings.some(item =>
    item.command === 'pascalAtlas.run.stop' && item.key === 'shift+f5'));
  assert.match(source, /this\.statusItems\.stop\.command\s*=\s*this\.runInProgress[\s\S]*?'pascalAtlas\.run\.stop'[\s\S]*?'workbench\.action\.debug\.stop'/);
  assert.match(source, /if \(executionActive\) \{[\s\S]*?statusItems\.run\.hide\(\)[\s\S]*?statusItems\.stop\.show\(\)/);
  assert.equal(manifest.contributes.configurationDefaults['debug.showInStatusBar'], undefined);
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalAtlas.projectNavigator.actions'
    && item.group === '1_projectActions@1'));
  assert.equal(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalAtlas.projectNavigator.actions'
    && item.group.startsWith('navigation')), false, 'project actions belong only in the view overflow menu');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalAtlas.navigator.toggleMode').icon, '$(arrow-swap)');
  assert.equal(manifest.contributes.menus['view/title'].find(item => item.command === 'pascalAtlas.navigator.toggleMode').group, 'navigation@99');
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalAtlas.openSettings'
    && item.when.includes('pascalAtlas.navigator.mode == class')
    && !item.group.startsWith('navigation')),
  'class mode needs a real overflow action so its native ellipsis matches project mode');
  assert.equal(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalAtlas.classNavigator.refresh'), false);
  assert.match(navigatorSource, /new ClassNavigatorWebview\(vscode, 'pascalAtlas\.classNavigator'/);
  assert.match(navigatorWebviewSource, /const expanded = new Set\(saved\.expanded \|\| \[\]\)/);
  assert.match(navigatorSource, /this\.changed\.fire\(routine\)/,
    'AI completion must refresh only the completed routine subtree');
  assert.match(navigatorSource, /combinedChanged\.fire\(element\)/,
    'the combined navigator must preserve granular TreeDataProvider events');
  assert.ok(manifest.contributes.commands.some(item => item.command === 'pascalAtlas.classNavigator.stopAiGeneration'));
  assert.equal(manifest.contributes.commands.some(item =>
    item.command === 'pascalAtlas.classNavigator.generateAllAiSteps'), false);
  assert.ok(manifest.contributes.commands.some(item =>
    item.command === 'pascalAtlas.classNavigator.generateDetailedAiSteps'));
  for (const command of [
    'pascalAtlas.classNavigator.generateAiSteps',
    'pascalAtlas.classNavigator.generateDetailedAiSteps'
  ]) {
    const menu = manifest.contributes.menus['view/item/context'].find(item => item.command === command);
    assert.ok(menu?.when.includes('pascalAtlas.classNavigator.(routine|type)'));
    assert.equal(manifest.contributes.menus['view/title'].some(item => item.command === command), false);
  }
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalAtlas.classNavigator.stopAiGeneration'
    && item.when.includes('pascalAtlas.classNavigator.aiGenerating')));
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.classNavigator.aiSteps.batch.delayMs'], undefined);
  assert.equal(manifest.contributes.configuration.properties['pascalAtlas.classNavigator.aiSteps.batch.maxConsecutiveErrors'], undefined);
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalAtlas.build.buildPackage').title, 'Build');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalAtlas.build.compilePackage').title, 'Compile');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalAtlas.build.cleanPackage').title, 'Clean');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalAtlas.build.buildGroup').title, 'Build All');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalAtlas.build.compileGroup').title, 'Compile All');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalAtlas.build.cleanGroup').title, 'Clean All');
  assert.equal(manifest.contributes.views.explorer.some(item => item.id === 'pascalAtlas.projectNavigator'), false);
  assert.equal(manifest.contributes.views.explorer.find(item => item.id === 'pascalAtlas.classNavigator').name, 'Delphi Navigator');
  assert.equal(Object.keys(manifest.contributes.configuration.properties).some(key => key.startsWith('pascalAtlas.explorer.projectMarkers')), false);
  assert.ok(manifest.contributes.problemMatchers.some(item => item.name === 'pascalAtlasDelphi'));
  const classicMatcher = new RegExp(manifest.contributes.problemMatchers
    .find(item => item.name === 'pascalAtlasDelphiClassic').pattern.regexp);
  const error = classicMatcher.exec('[ERROR] FootballStatistics.dpr(16): error E2029: Statement expected');
  const warning = classicMatcher.exec('[WARN]  Unit1.pas(42): warning W1036: Variable might not have been initialized');
  assert.equal(error?.[1], 'FootballStatistics.dpr');
  assert.equal(error?.[4].toLowerCase(), 'error');
  assert.equal(warning?.[1], 'Unit1.pas');
  assert.equal(warning?.[4].toLowerCase(), 'warning');
});
