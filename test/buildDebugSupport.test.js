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
  compatiblePlatform,
  debugOutputConfiguration,
  debugMsbuildProperties,
  formalBuildEnvironment,
  formatBuildDuration,
  parseBuildDiagnosticLine,
  parseCommandLine,
  peMetadataFromBuffer,
  resolvedBuildSelection
} = require('../src/buildDebugSupport');
Module._load = originalLoad;

test('debug run parameters preserve quoted arguments', () => {
  assert.deepEqual(parseCommandLine('--mode test "C:\\Program Files\\Demo data" /flag'), [
    '--mode', 'test', 'C:\\Program Files\\Demo data', '/flag'
  ]);
});

test('launch debugging captures stdout and reveals the Debug Console by default', () => {
  const externalConfiguration = { get: (_key, fallback) => fallback };
  assert.deepEqual(debugOutputConfiguration(externalConfiguration, 'launch'), {
    captureOutput: false,
    externalConsole: true,
    internalConsoleOptions: 'neverOpen'
  });
  const debugConsoleConfiguration = {
    get: (key, fallback) => key === 'debugger.programConsole' ? 'debugConsole' : fallback
  };
  assert.deepEqual(debugOutputConfiguration(debugConsoleConfiguration, 'launch'), {
    captureOutput: true,
    externalConsole: false,
    internalConsoleOptions: 'openOnSessionStart'
  });
  assert.deepEqual(debugOutputConfiguration(debugConsoleConfiguration, 'attach'), {
    captureOutput: false,
    externalConsole: false,
    internalConsoleOptions: 'neverOpen'
  });
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
  const runner = fs.readFileSync(path.join(__dirname, '..', 'resources', 'pascal-union-build-runner.ps1'), 'utf8');
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
  assert.match(runner, /PASCAL_UNION_BUILD_RESULT/);
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

test('debug build requests detailed map and source-level debug information', () => {
  const args = [];
  appendMsbuildProperties(args, debugMsbuildProperties());
  assert.deepEqual(args, [
    '/p:DCC_MapFile=3',
    '/p:DCC_Optimize=false',
    '/p:DCC_GenerateStackFrames=true',
    '/p:DCC_DebugInfoInExe=true',
    '/p:DCC_LocalDebugSymbols=true',
    '/p:DCC_SymbolReferenceInfo=2'
  ]);
});

test('debug platform falls back to a platform supported by every group project', () => {
  assert.equal(compatiblePlatform([{ targetedPlatforms: 1 }, { targetedPlatforms: 1 }], 'Win64'), 'Win32');
  assert.equal(compatiblePlatform([{ targetedPlatforms: 3 }, { targetedPlatforms: 3 }], 'Win64'), 'Win64');
  assert.equal(compatiblePlatform([{ targetedPlatforms: 0 }], 'Win64'), 'Win64');
});

test('embedded Delphi TD32 PE section counts as debug information', () => {
  const buffer = Buffer.alloc(1024);
  buffer.writeUInt16LE(0x5A4D, 0);
  buffer.writeUInt32LE(0x80, 0x3C);
  buffer.write('PE\0\0', 0x80, 'ascii');
  buffer.writeUInt16LE(0x014C, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(0xE0, 0x94);
  buffer.write('.debug\0\0', 0x178, 'ascii');
  assert.deepEqual(peMetadataFromBuffer(buffer), { machine: 'Win32', sections: ['.debug'] });
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
  const packageMenus = treeMenus.filter(item => item.when.includes('viewItem == pascalUnion.projectNavigator.package'));
  const projectMenus = treeMenus.filter(item => item.when.includes('pascalUnion.navigator.mode == project')
    && !item.when.includes('viewItem == pascalUnion.projectNavigator.package')
    && !item.when.includes('!viewItem'));
  const backgroundMenus = treeMenus.filter(item => item.when.includes('!viewItem'));
  assert.deepEqual(
    packageMenus.map(item => item.command),
    [
      'pascalUnion.build.buildPackage',
      'pascalUnion.build.compilePackage',
      'pascalUnion.build.cleanPackage',
      'pascalUnion.debug.debugPackage',
      'pascalUnion.debug.attachPackage'
    ]
  );
  assert.deepEqual(
    projectMenus.map(item => item.command),
    [
      'pascalUnion.build.buildGroup',
      'pascalUnion.build.compileGroup',
      'pascalUnion.build.cleanGroup',
      'pascalUnion.run.group',
      'pascalUnion.debug.buildAndDebugGroup',
      'pascalUnion.debug.selectStartupProject',
      'pascalUnion.build.selectConfiguration',
      'pascalUnion.build.selectPlatform'
    ]
  );
  assert.deepEqual(backgroundMenus, [], 'VS Code does not expose a blank TreeView background context-menu contribution point');
  assert.ok(
    [...packageMenus, ...projectMenus].every(item => item.group.startsWith('1_pascalUnion@')),
    'project tree commands must share an early dedicated separator group'
  );
  assert.ok(manifest.contributes.configuration.properties['pascalUnion.debugger.autoInstall']);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.debugger.generateDetailedMap'].default, true);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.debugger.stopAtEntry'].default, true);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.debugger.programConsole'].default, 'external');
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.debugger.revealOutputOnStart'].default, true);
  assert.ok(manifest.contributes.configuration.properties['pascalUnion.build.terminalSummary']);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.build.output.showErrors'].default, true);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.build.output.showWarnings'].default, true);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.build.output.showOther'].default, true);
  const terminalToolbar = manifest.contributes.menus['view/title'].filter(item =>
    item.when.includes('view == terminal') && /toggle(?:Errors|Warnings|Other)/.test(item.command)
  );
  assert.equal(terminalToolbar.length, 6);
  assert.ok(terminalToolbar.every(item => item.when.includes('pascalUnion.buildTerminalActive')));
  const commands = new Map(manifest.contributes.commands.map(item => [item.command, item]));
  assert.equal(commands.get('pascalUnion.build.toggleErrorsChecked').title, '✓ 显示错误');
  assert.equal(commands.get('pascalUnion.build.toggleWarningsChecked').title, '✓ 显示警告');
  assert.equal(commands.get('pascalUnion.build.toggleOtherChecked').title, '✓ 显示其他信息');
  assert.deepEqual(commands.get('pascalUnion.build.toggleErrorsChecked').icon, {
    light: 'media/build-filter-error-checked-light.svg',
    dark: 'media/build-filter-error-checked-dark.svg'
  });
  assert.deepEqual(commands.get('pascalUnion.build.toggleWarningsChecked').icon, {
    light: 'media/build-filter-warning-checked-light.svg',
    dark: 'media/build-filter-warning-checked-dark.svg'
  });
  assert.deepEqual(commands.get('pascalUnion.build.toggleOtherChecked').icon, {
    light: 'media/build-filter-info-checked-light.svg',
    dark: 'media/build-filter-info-checked-dark.svg'
  });
  assert.equal(
    manifest.contributes.configuration.properties['pascalUnion.diagnostics.ignoreUtf8ConversionWarning'].default,
    true
  );
  assert.ok(manifest.contributes.menus['view/title'].some(item =>
    item.command === 'pascalUnion.build.selectOutputFilters' && item.when.includes('view == terminal')));
  assert.ok(manifest.contributes.menus['view/title'].some(item =>
    item.command === 'pascalUnion.classNavigator.find'
      && item.when.includes('pascalUnion.navigator.mode == class')));
  assert.equal(manifest.contributes.commands.find(item =>
    item.command === 'pascalUnion.classNavigator.find').icon, '$(search)');
  assert.equal(manifest.contributes.views.explorer.find(item =>
    item.id === 'pascalUnion.classNavigator').type, 'webview');
  assert.equal(manifest.contributes.views.explorer.some(item =>
    item.id === 'pascalUnion.classNavigatorSearch'), false);
  const webviewContextMenu = manifest.contributes.menus['webview/context'];
  assert.ok(Array.isArray(webviewContextMenu));
  assert.ok(webviewContextMenu.every(item => item.when.includes("webviewId == 'pascalUnion.classNavigator'")));
  assert.ok(webviewContextMenu.some(item =>
    item.command === 'pascalUnion.classNavigator.generateAiSteps'
      && item.when.includes("webviewSection == 'classSymbol'")));
  assert.ok(webviewContextMenu.some(item =>
    item.command === 'pascalUnion.classNavigator.context.buildPackage'
      && item.when.includes("webviewSection == 'projectPackage'")));
  assert.ok(webviewContextMenu.some(item =>
    item.command === 'pascalUnion.classNavigator.context.runGroup'
      && item.when.includes("webviewSection == 'projectGroup'")));
  assert.doesNotMatch(navigatorSource, /registerWebviewViewProvider\('pascalUnion\.classNavigatorSearch'/);
  assert.doesNotMatch(navigatorSource, /createQuickPick\(\)/);
  assert.doesNotMatch(navigatorSource, /registerCommand\('pascalUnion\.classNavigator\.selectSort',[\s\S]{0,1200}?showQuickPick/);
  assert.match(navigatorSource, /new ClassNavigatorWebview\(vscode, 'pascalUnion\.classNavigator'/);
  assert.match(navigatorSource, /WEBVIEW_CONTEXT_COMMANDS\.map[\s\S]*?tree\.selection\[0\][\s\S]*?executeCommand\(command, target\)/);
  assert.match(navigatorSource, /workspaceState\.update\(SEARCH_OPTIONS_STATE_KEY, navigatorSearchOptions\)/);
  assert.match(navigatorWebviewSource, /id="scope"[\s\S]*?当前文件[\s\S]*?全局/);
  assert.match(navigatorWebviewSource, /id="kind-types"[\s\S]*?id="kind-files"[\s\S]*?id="kind-routines"/);
  assert.match(navigatorWebviewSource, /全部实时[\s\S]*?仅当前文件实时[\s\S]*?确认时/);
  assert.match(navigatorWebviewSource, /event\.key === 'Escape'[\s\S]*?hideSearch\(\)/);
  assert.match(navigatorWebviewSource, /id="sort-panel"[\s\S]*?id="member-order"[\s\S]*?id="type-order"/);
  assert.match(navigatorWebviewSource, /type:'sortUpdate', key, value/);
  assert.match(navigatorSource, /classNavigator\.selectSort'[\s\S]*?tree\.showSort/);
  assert.match(navigatorSource, /navigatorSearchSession[\s\S]*?tree\.hideSearch\(\)/);
  assert.match(navigatorSource, /tree\.sortPanelOpen[\s\S]*?tree\.hideSort\(\)/);
  const navigatorSearchKeybinding = manifest.contributes.keybindings.find(item =>
    item.command === 'pascalUnion.classNavigator.find');
  assert.equal(navigatorSearchKeybinding.key, 'ctrl+alt+n');
  assert.match(navigatorSearchKeybinding.when, /editorLangId/);
  assert.match(navigatorSearchKeybinding.when, /focusedView == pascalUnion\.classNavigator/);
  assert.match(navigatorSearchKeybinding.when, /pascalUnion\.classNavigator\.webviewFocused/);
  assert.match(navigatorSource, /onFocusChanged:[\s\S]*?pascalUnion\.classNavigator\.webviewFocused/);
  assert.match(navigatorSource, /onSearchClosed: restoreState => closeNavigatorSearch\(true, restoreState\)/);
  assert.match(navigatorSource, /restoreNavigatorSearchSession[\s\S]*?preserveFocus: true[\s\S]*?TextEditorRevealType\.AtTop[\s\S]*?tree\.restoreSearchState/);
  assert.equal(manifest.contributes.submenus, undefined);
  for (const location of ['terminal/context', 'terminal/title/context']) {
    const menu = manifest.contributes.menus[location];
    for (const suffix of ['Errors', 'Warnings', 'Other']) {
      const unchecked = menu.find(item => item.command === `pascalUnion.build.toggle${suffix}`);
      const checked = menu.find(item => item.command === `pascalUnion.build.toggle${suffix}Checked`);
      assert.match(unchecked.when, new RegExp(`!config\\.pascalUnion\\.build\\.output\\.show${suffix}`));
      assert.match(checked.when, new RegExp(`(?<!!)config\\.pascalUnion\\.build\\.output\\.show${suffix}`));
      assert.equal(checked.group, unchecked.group);
      const icon = manifest.contributes.commands.find(item => item.command === checked.command).icon;
      assert.equal(typeof icon, 'object');
      assert.match(icon.light, /-checked-light\.svg$/);
      assert.match(icon.dark, /-checked-dark\.svg$/);
    }
  }
  assert.deepEqual(
    ['pascalUnion.build.toggleErrors', 'pascalUnion.build.toggleWarnings', 'pascalUnion.build.toggleOther']
      .map(command => manifest.contributes.commands.find(item => item.command === command).title),
    ['显示错误', '显示警告', '显示其他信息']
  );
  assert.match(source, /createQuickPick\(\)[\s\S]*?canSelectMany\s*=\s*true/);
  assert.match(source, /onDidChangeSelection\([\s\S]*?buildTerminalSession\?\.setFilters\(next\)/);
  assert.doesNotMatch(source, /showQuickPick\(items,\s*\{[\s\S]*?Pascal Union：构建输出/);
  assert.ok(manifest.contributes.configuration.properties['pascalUnion.build.completionNotification']);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.build.showStatusBar'].default, true);
  assert.ok(manifest.contributes.configuration.properties['pascalUnion.projectNavigator.enabled']);
  assert.ok(manifest.contributes.configuration.properties['pascalUnion.projectNavigator.contextMenus.enabled']);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.debugger.shortcutMode'].default, 'visualStudio');
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.run.buildBeforeRun'].default, 'ifOutdated');
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.run.console'], undefined);
  assert.ok(manifest.contributes.debuggers.some(item => item.type === 'pascal-union-run'));
  assert.ok(manifest.contributes.commands.some(item =>
    item.command === 'pascalUnion.run.stop' && item.enablement === 'pascalUnion.runInProgress'));
  assert.equal(manifest.contributes.commands.find(item =>
    item.command === 'pascalUnion.run.group').enablement, '!pascalUnion.executionBusy');
  assert.equal(manifest.contributes.commands.find(item =>
    item.command === 'pascalUnion.debug.buildAndDebugGroup').enablement, '!pascalUnion.executionBusy');
  assert.ok(manifest.contributes.keybindings.some(item =>
    item.command === 'pascalUnion.run.stop' && item.key === 'shift+f5'));
  assert.match(source, /this\.statusItems\.stop\.command\s*=\s*this\.runInProgress[\s\S]*?'pascalUnion\.run\.stop'[\s\S]*?'workbench\.action\.debug\.stop'/);
  assert.match(source, /if \(executionActive\) \{[\s\S]*?statusItems\.run\.hide\(\)[\s\S]*?statusItems\.debug\.hide\(\)[\s\S]*?statusItems\.stop\.show\(\)/);
  assert.equal(manifest.contributes.configurationDefaults['debug.showInStatusBar'], 'never');
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalUnion.projectNavigator.actions'
    && item.group === '1_projectActions@1'));
  assert.equal(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalUnion.projectNavigator.actions'
    && item.group.startsWith('navigation')), false, 'project actions belong only in the view overflow menu');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.navigator.toggleMode').icon, '$(arrow-swap)');
  assert.equal(manifest.contributes.menus['view/title'].find(item => item.command === 'pascalUnion.navigator.toggleMode').group, 'navigation@99');
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalUnion.openSettings'
    && item.when.includes('pascalUnion.navigator.mode == class')
    && !item.group.startsWith('navigation')),
  'class mode needs a real overflow action so its native ellipsis matches project mode');
  assert.equal(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalUnion.classNavigator.refresh'), false);
  assert.match(navigatorSource, /new ClassNavigatorWebview\(vscode, 'pascalUnion\.classNavigator'/);
  assert.match(navigatorWebviewSource, /const expanded = new Set\(saved\.expanded \|\| \[\]\)/);
  assert.match(navigatorSource, /this\.changed\.fire\(routine\)/,
    'AI completion must refresh only the completed routine subtree');
  assert.match(navigatorSource, /combinedChanged\.fire\(element\)/,
    'the combined navigator must preserve granular TreeDataProvider events');
  assert.ok(manifest.contributes.commands.some(item => item.command === 'pascalUnion.classNavigator.stopAiGeneration'));
  assert.equal(manifest.contributes.commands.some(item =>
    item.command === 'pascalUnion.classNavigator.generateAllAiSteps'), false);
  assert.ok(manifest.contributes.commands.some(item =>
    item.command === 'pascalUnion.classNavigator.generateDetailedAiSteps'));
  for (const command of [
    'pascalUnion.classNavigator.generateAiSteps',
    'pascalUnion.classNavigator.generateDetailedAiSteps'
  ]) {
    const menu = manifest.contributes.menus['view/item/context'].find(item => item.command === command);
    assert.ok(menu?.when.includes('pascalUnion.classNavigator.(routine|type)'));
    assert.equal(manifest.contributes.menus['view/title'].some(item => item.command === command), false);
  }
  assert.ok(manifest.contributes.menus['view/title'].some(item => item.command === 'pascalUnion.classNavigator.stopAiGeneration'
    && item.when.includes('pascalUnion.classNavigator.aiGenerating')));
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.classNavigator.aiSteps.batch.delayMs'], undefined);
  assert.equal(manifest.contributes.configuration.properties['pascalUnion.classNavigator.aiSteps.batch.maxConsecutiveErrors'], undefined);
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.debug.buildAndDebugGroup').title, 'Debug');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.build.buildPackage').title, 'Build');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.build.compilePackage').title, 'Compile');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.build.cleanPackage').title, 'Clean');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.build.buildGroup').title, 'Build All');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.build.compileGroup').title, 'Compile All');
  assert.equal(manifest.contributes.commands.find(item => item.command === 'pascalUnion.build.cleanGroup').title, 'Clean All');
  assert.equal(manifest.contributes.views.explorer.some(item => item.id === 'pascalUnion.projectNavigator'), false);
  assert.equal(manifest.contributes.views.explorer.find(item => item.id === 'pascalUnion.classNavigator').name, 'Delphi 导航');
  assert.equal(Object.keys(manifest.contributes.configuration.properties).some(key => key.startsWith('pascalUnion.explorer.projectMarkers')), false);
  assert.ok(manifest.contributes.problemMatchers.some(item => item.name === 'pascalUnionDelphi'));
  const classicMatcher = new RegExp(manifest.contributes.problemMatchers
    .find(item => item.name === 'pascalUnionDelphiClassic').pattern.regexp);
  const error = classicMatcher.exec('[ERROR] FootballStatistics.dpr(16): error E2029: Statement expected');
  const warning = classicMatcher.exec('[WARN]  Unit1.pas(42): warning W1036: Variable might not have been initialized');
  assert.equal(error?.[1], 'FootballStatistics.dpr');
  assert.equal(error?.[4].toLowerCase(), 'error');
  assert.equal(warning?.[1], 'Unit1.pas');
  assert.equal(warning?.[4].toLowerCase(), 'warning');
});
