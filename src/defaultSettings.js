'use strict';

const FIRST_RUN_PROFILE_VERSION = 3;
const FIRST_RUN_PROFILE_STATE_KEY = 'pascalAtlas.firstRunProfileVersion';

// This is the baseline color scheme captured from the working Delphi setup.
// Resetting colors must never change coloring enablement or scheduling delays.
const DEFAULT_SYMBOL_COLORS = Object.freeze({
  'coloring.colors.useDefault': true,
  'coloring.colors.unit': '#4EC9B0',
  'coloring.colors.type': '#4EC9B0',
  'coloring.colors.variable': '#9CDCFE',
  'coloring.colors.constant': '#4FC1FF',
  'coloring.colors.enumMember': '#4FC1FF',
  'coloring.colors.property': '#9CDCFE',
  'coloring.colors.method': '#DCDCAA'
});

// The first-run experience is deliberately pinned instead of being inferred
// from future package defaults. Formatter syntax-standard settings are kept out
// of this profile: their own default/custom-profile lifecycle is independent.
const FIRST_RUN_SETTINGS = Object.freeze({
  enabled: true,
  'dependencies.autoInstall': true,
  'encoding.enabled': true,
  'encoding.delphiDefault': 'utf8',
  'encoding.otherDefault': 'utf8',
  'encoding.detectExisting': true,
  'encoding.respectDprojDeclaration': true,
  'classNavigator.enabled': true,
  'classNavigator.showUses': true,
  'classNavigator.showGlobalRoutines': true,
  'classNavigator.showInterfaces': true,
  'classNavigator.showRecordsAndObjects': true,
  'classNavigator.showProperties': true,
  'classNavigator.showProjectPackageEntry': true,
  'classNavigator.showProjectFileEntry': true,
  'classNavigator.showUnitInitialization': true,
  'classNavigator.showUnitFinalization': true,
  'classNavigator.memberOrder': 'visibility',
  'classNavigator.typeOrder': 'declaration',
  'classNavigator.followCursor': true,
  'classNavigator.highlightRange.enabled': true,
  'classNavigator.pauseWhenCollapsed': true,
  'classNavigator.scrollFollowDelayMs': 0,
  'classNavigator.scrollFollowOffsetLines': 1,
  'classNavigator.navigationClickHoldMs': 120,
  'classNavigator.navigationReveal.mode': 'smart',
  'classNavigator.navigationReveal.largeBlockStartPercent': 25,
  'classNavigator.keepFocusOnNavigationClick': true,
  'classNavigator.defaultOpenBelowExplorer': true,
  'classNavigator.backgroundParsing.enabled': true,
  'classNavigator.backgroundParsing.thresholdKb': 256,
  'classNavigator.aiSteps.enabled': true,
  'classNavigator.aiSteps.provider': 'oaicopilot',
  'classNavigator.aiSteps.modelId': '',
  'classNavigator.aiSteps.granularity': 'coarse',
  'classNavigator.aiSteps.maxSteps': 5,
  'classNavigator.aiSteps.substeps.enabled': true,
  'classNavigator.aiSteps.substeps.maxPerStep': 5,
  'classNavigator.aiSteps.substeps.minParentLines': 30,
  'classNavigator.aiSteps.substeps.maxDepth': 3,
  'classNavigator.aiSteps.maxSourceCharacters': 24000,
  'classNavigator.aiSteps.cacheEnabled': true,
  'classNavigator.aiSteps.highlightRange': true,
  'paths.enabled': true,
  'projectGroups.autoDetect': true,
  'projectGroups.activateFirstProject': true,
  restartActiveLsp: true,
  includeNestedSourceDirectories: true,
  'coloring.enabled': true,
  'coloring.typingDelayMs': 750,
  'coloring.inactiveEditorDelayMs': 350,
  'coloring.persistedCache.enabled': true,
  ...DEFAULT_SYMBOL_COLORS,
  'navigation.enabled': true,
  'navigation.preferImplementation': true,
  'navigation.singleTargetByDefault': true,
  'navigation.selectTargetOnJump': false,
  'navigation.candidatePickerShortcut': 'altF12',
  'navigation.virtualInterfaces': true,
  'navigation.isolatePlatformSources': true,
  'navigation.prewarmCurrentFile': true,
  'navigation.interactiveWaitMs': 100,
  'completion.enabled': true,
  'completion.unqualified.enabled': true,
  'completion.interactiveWaitMs': 60,
  'signatureHelp.enabled': true,
  'signatureHelp.triggerOnComma': true,
  'hover.enabled': true,
  'symbols.compiled.enabled': true,
  'symbols.compiled.parsedCache.enabled': true,
  'symbols.sourceCache.enabled': true,
  'symbols.compiled.initialPackageLimit': 8,
  'missingUnits.enabled': true,
  'missingUnits.debounceMs': 350,
  'missingUnits.compiledFallback': true,
  'formatter.enabled': true,
  'formatter.executablePath': '',
  'formatter.shortcut': 'shiftAltF',
  'formatter.preserveInlineVariables': true,
  'formatter.alignWrappedParameters': true,
  'formatter.onType.enabled': true,
  'formatter.onType.semicolon.scope': 'currentLine',
  'formatter.onType.closingParenthesis.scope': 'currentLine',
  'formatter.onType.enter.scope': 'currentAndPrevious',
  'formatter.onType.logging': false,
  'formatter.highlighting.enabled': true,
  'formatter.highlighting.blockLevelColors': ['#E06C75', '#D19A66', '#C586C0'],
  'explorer.hideFormFiles': true,
  'explorer.hideSkinConfigFiles': true,
  'explorer.hideBuildArtifacts': true,
  'explorer.hideProjectMetadata': true,
  'explorer.hideBuildDirectories': true,
  'projectNavigator.enabled': true,
  'projectNavigator.defaultExpansion': 'firstLevel',
  'projectNavigator.showGroupproj': true,
  'projectNavigator.showDpr': true,
  'projectNavigator.showDpk': true,
  'projectNavigator.showDproj': true,
  'projectNavigator.contextMenus.enabled': true,
  'build.enabled': true,
  'build.configuration': 'auto',
  'build.platform': 'auto',
  'build.saveBeforeBuild': true,
  'build.showStatusBar': true,
  'build.stopGroupOnFailure': true,
  'build.terminalSummary': true,
  'build.completionNotification': true,
  'build.timeoutSeconds': 1800,
  'build.msbuildPath': '',
  'run.buildBeforeRun': 'ifOutdated',

  'diagnostics.enabled': true,
  'diagnostics.syntax.enabled': true,
  'diagnostics.syntax.debounceMs': 300,
  'diagnostics.compiler.enabled': true,
  'diagnostics.compiler.idleDelayMs': 1500,
  'diagnostics.compiler.startupDelayMs': 20000,
  'diagnostics.compiler.maxParallelProjects': 2,
  'diagnostics.compiler.timeoutSeconds': 120,
  'diagnostics.compiler.includeWarnings': true,
  'diagnostics.ignoreUtf8ConversionWarning': true,
  'diagnostics.compiler.configuration': 'auto',
  'diagnostics.compiler.platform': 'auto'
});

function hasExplicitValue(inspected) {
  if (!inspected) return false;
  return [
    'globalValue',
    'workspaceValue',
    'workspaceFolderValue',
    'globalLanguageValue',
    'workspaceLanguageValue',
    'workspaceFolderLanguageValue'
  ].some(key => inspected[key] !== undefined);
}

async function initializeFirstRunSettings(context, output, vscodeApi) {
  const vscode = vscodeApi || require('vscode');
  const appliedVersion = context.globalState.get(FIRST_RUN_PROFILE_STATE_KEY, 0);
  if (appliedVersion >= FIRST_RUN_PROFILE_VERSION) return { initialized: false, updated: [] };

  const configuration = vscode.workspace.getConfiguration('pascalAtlas');
  const updated = [];
  for (const [key, expected] of Object.entries(FIRST_RUN_SETTINGS)) {
    // An explicit user/workspace choice always wins, even on first activation.
    if (hasExplicitValue(configuration.inspect(key))) continue;
    // Avoid dozens of settings-file writes when the extension manifest already
    // supplies the captured value. Write only if another default changes it.
    if (configuration.get(key) === expected) continue;
    await configuration.update(key, expected, vscode.ConfigurationTarget.Global);
    updated.push(key);
  }
  await context.globalState.update(FIRST_RUN_PROFILE_STATE_KEY, FIRST_RUN_PROFILE_VERSION);
  output?.appendLine(
    `First-run settings profile ${FIRST_RUN_PROFILE_VERSION} initialized; `
    + `${updated.length} value(s) persisted, formatter syntax rules excluded.`
  );
  return { initialized: true, updated };
}

async function resetSymbolColors(output, vscodeApi) {
  const vscode = vscodeApi || require('vscode');
  const configuration = vscode.workspace.getConfiguration('pascalAtlas');
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  for (const [key, value] of Object.entries(DEFAULT_SYMBOL_COLORS)) {
    await configuration.update(key, value, target);
  }
  output?.appendLine('Reset the Pascal Atlas symbol color profile; non-color settings were unchanged.');
  void vscode.window.showInformationMessage('Default symbol colors restored. Other settings, including coloring and delay options, were not changed.');
}

module.exports = {
  DEFAULT_SYMBOL_COLORS,
  FIRST_RUN_PROFILE_STATE_KEY,
  FIRST_RUN_PROFILE_VERSION,
  FIRST_RUN_SETTINGS,
  initializeFirstRunSettings,
  resetSymbolColors
};
