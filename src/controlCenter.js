'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { discoverLoadedProjects } = require('./projectDiscovery');
const { STYLE_RULES } = require('./formatter/styleRules');
const { DEFAULT_BLOCK_LEVEL_COLORS } = require('./formatter/highlighting');
const { resetSymbolColors } = require('./defaultSettings');
const { languageCode, localizedPages, sectionsWithPages } = require('./controlCenterI18n');

const SECTIONS = [
  {
    title: 'Interface language',
    description: 'Controls the language used by Pascal Atlas settings pages.',
    settings: [
      {
        key: 'ui.language', label: 'Settings language', type: 'select', target: 'global', defaultValue: 'en',
        options: ['en'], optionLabels: ['English']
      }
    ]
  },
  {
    title: 'Master switch',
    description: 'Controls all Pascal Atlas companion features. Vallenta remains available when this is disabled.',
    settings: [
      { key: 'enabled', label: 'Enable Pascal Atlas', type: 'boolean' }
    ]
  },
  {
    title: 'Dependencies and compatibility',
    description: 'Keeps Vallenta Studio and debugging prerequisites available; legacy formatter and duplicate Pascal providers are not required.',
    settings: [
      { key: 'dependencies.autoInstall', label: 'Automatically install missing required extensions', type: 'boolean' }
    ],
    actions: [
      { command: 'pascalAtlas.dependencies.check', label: 'Check extension environment', icon: '✓' }
    ]
  },
  {
    title: 'File encoding',
    description: 'New Delphi files default to GB2312 and other files to UTF-8; ambiguous Pascal files fall back to GB2312.',
    settings: [
      { key: 'encoding.enabled', label: 'Enable file encoding policy', type: 'boolean' },
      {
        key: 'encoding.delphiDefault', label: 'New or ambiguous Delphi files', type: 'select', target: 'global',
        options: ['gb2312', 'gbk', 'utf8', 'utf8bom'],
        optionLabels: ['GB2312 (default)', 'GBK', 'UTF-8', 'UTF-8 with BOM']
      },
      {
        key: 'encoding.otherDefault', label: 'New or ambiguous non-Delphi files', type: 'select', target: 'global',
        options: ['utf8', 'utf8bom', 'gb2312', 'gbk'],
        optionLabels: ['UTF-8 (default)', 'UTF-8 with BOM', 'GB2312', 'GBK']
      },
      { key: 'encoding.detectExisting', label: 'Detect and preserve existing file encoding', type: 'boolean' },
      { key: 'encoding.respectDprojDeclaration', label: 'Prefer the DPROJ XML encoding declaration', type: 'boolean' }
    ]
  },
  {
    title: 'Symbol coloring',
    description: 'Analyzes the active file first and merges symbols from every loaded project, source tree, and package.',
    settings: [
      { key: 'coloring.enabled', label: 'Pascal Atlas symbol coloring', type: 'boolean' },
      { key: 'coloring.typingDelayMs', label: 'Active-file typing delay', type: 'number', unit: 'ms', min: 0, max: 3000, step: 10 },
      { key: 'coloring.inactiveEditorDelayMs', label: 'Inactive-editor delay', type: 'number', unit: 'ms', min: 0, max: 5000, step: 50 },
      { key: 'coloring.persistedCache.enabled', label: 'Preserve recent file coloring across windows', type: 'boolean' },
      { key: 'coloring.colors.useDefault', label: 'Use theme semantic colors', type: 'boolean', group: 'Color palette' },
      { key: 'coloring.colors.unit', label: 'Unit names', type: 'color', colorRule: true, defaultValue: '#4EC9B0' },
      { key: 'coloring.colors.type', label: 'Types and interfaces', type: 'color', colorRule: true, defaultValue: '#4EC9B0' },
      { key: 'coloring.colors.variable', label: 'Variables and fields', type: 'color', colorRule: true, defaultValue: '#9CDCFE' },
      { key: 'coloring.colors.constant', label: 'Constants', type: 'color', colorRule: true, defaultValue: '#4FC1FF' },
      { key: 'coloring.colors.enumMember', label: 'Enum members', type: 'color', colorRule: true, defaultValue: '#4FC1FF' },
      { key: 'coloring.colors.property', label: 'Properties', type: 'color', colorRule: true, defaultValue: '#9CDCFE' },
      { key: 'coloring.colors.method', label: 'Functions and procedures', type: 'color', colorRule: true, defaultValue: '#DCDCAA' }
    ],
    actions: [
      { command: 'pascalAtlas.coloring.colors.reset', label: 'Reset default colors', icon: '↺' }
    ]
  },
  {
    title: 'Navigation and interfaces',
    description: 'Source routines prefer implementations; symbols without source can open generated interfaces recovered from packages.',
    settings: [
      { key: 'navigation.enabled', label: 'Enhanced Pascal Atlas navigation', type: 'boolean' },
      { key: 'navigation.preferImplementation', label: 'Prefer routine implementations', type: 'boolean' },
      { key: 'navigation.singleTargetByDefault', label: 'Use only the best target for normal navigation', type: 'boolean' },
      { key: 'navigation.selectTargetOnJump', label: 'Select the target identifier after navigation (may flash)', type: 'boolean' },
      {
        key: 'navigation.candidatePickerShortcut', label: 'All-candidates shortcut', type: 'select',
        options: ['altF12', 'ctrlAltF12', 'none'],
        optionLabels: ['Alt+F12', 'Ctrl+Alt+F12', 'Unassigned']
      },
      { key: 'navigation.virtualInterfaces', label: 'Open virtual interfaces when source is unavailable', type: 'boolean' },
      { key: 'navigation.isolatePlatformSources', label: 'Isolate large RTL/VCL sources to avoid blocking Vallenta', type: 'boolean' },
      { key: 'navigation.prewarmCurrentFile', label: 'Prewarm the active file and its uses', type: 'boolean' },
      { key: 'navigation.interactiveWaitMs', label: 'Maximum Ctrl-navigation wait', type: 'number', unit: 'ms', min: 0, max: 1000, step: 10 },
      { key: 'hover.enabled', label: 'Package-symbol hover information', type: 'boolean' }
    ]
  },
  {
    title: 'Class and routine navigator',
    description: 'Organizes Pascal types and routines in Explorer, with compact include targets for DPK and DPROJ files.',
    settings: [
      { key: 'classNavigator.enabled', label: 'Show Delphi class navigator in Explorer', type: 'boolean' },
      { key: 'classNavigator.showUses', label: 'Show uses nodes without listing imported Units', type: 'boolean' },
      { key: 'classNavigator.showGlobalRoutines', label: 'Show global functions and procedures', type: 'boolean' },
      { key: 'classNavigator.showInterfaces', label: 'Show interfaces', type: 'boolean' },
      { key: 'classNavigator.showRecordsAndObjects', label: 'Show records and objects', type: 'boolean' },
      { key: 'classNavigator.showProperties', label: 'Show a properties group first in each type', type: 'boolean' },
      { key: 'classNavigator.showProjectPackageEntry', label: 'Show Package Includes for DPK/DPROJ', type: 'boolean' },
      { key: 'classNavigator.showProjectFileEntry', label: 'Show File Includes for DPK/DPROJ', type: 'boolean' },
      { key: 'classNavigator.showUnitInitialization', label: 'Show Unit initialization at the bottom', type: 'boolean' },
      { key: 'classNavigator.showUnitFinalization', label: 'Show Unit finalization at the bottom', type: 'boolean' },
      {
        key: 'classNavigator.memberOrder', label: 'Member ordering', type: 'select',
        options: ['visibility', 'declaration', 'implementation'],
        optionLabels: ['Grouped order (default)', 'Declaration order', 'Implementation order']
      },
      {
        key: 'classNavigator.typeOrder', label: 'Top-level type ordering', type: 'select',
        options: ['declaration', 'alphabetical'],
        optionLabels: ['Declaration order (default)', 'Alphabetical order']
      },
      { key: 'classNavigator.followCursor', label: 'Follow editor clicks and scrolling', type: 'boolean' },
      { key: 'classNavigator.highlightRange.enabled', label: 'Mark source blocks for real navigation items', type: 'boolean' },
      { key: 'classNavigator.pauseWhenCollapsed', label: 'Pause monitoring while the navigator is collapsed', type: 'boolean' },
      { key: 'classNavigator.scrollFollowDelayMs', label: 'Scroll-follow delay', type: 'number', unit: 'ms', min: 0, max: 500, step: 5 },
      { key: 'classNavigator.scrollFollowOffsetLines', label: 'Scroll-follow line offset', type: 'number', unit: 'lines', min: -20, max: 20, step: 1 },
      { key: 'classNavigator.navigationClickHoldMs', label: 'Navigation-click anti-flicker duration', type: 'number', unit: 'ms', min: 0, max: 2000, step: 50 },
      {
        key: 'classNavigator.navigationReveal.mode', label: 'Source placement after navigator jumps', type: 'select',
        options: ['smart', 'center', 'top', 'default'],
        optionLabels: ['Smart: center fitting blocks, position large blocks proportionally (default)', 'Always center', 'Place start at top', 'VS Code default']
      },
      { key: 'classNavigator.navigationReveal.largeBlockStartPercent', label: 'Large-block start position from viewport top', type: 'number', unit: '%', min: 0, max: 50, step: 5 },
      { key: 'classNavigator.keepFocusOnNavigationClick', label: 'Keep tree focus and blue selection after navigation clicks', type: 'boolean' },
      { key: 'classNavigator.defaultOpenBelowExplorer', label: 'Initially open below the Explorer file tree', type: 'boolean' },
      { key: 'classNavigator.backgroundParsing.enabled', label: 'Parse large-file navigation in a worker', type: 'boolean' },
      { key: 'classNavigator.backgroundParsing.thresholdKb', label: 'Background parsing threshold', type: 'number', unit: 'KB', min: 64, max: 4096, step: 64 }
    ],
    actions: [
      { command: 'pascalAtlas.navigator.showClasses', label: 'Switch to class navigation', icon: '◈' },
      { command: 'pascalAtlas.classNavigator.refresh', label: 'Refresh active-file navigation', icon: '↻' }
    ]
  },
  {
    title: 'AI routine steps',
    description: 'Uses the selected OAI Compatible Copilot model to create navigable functional steps for routines.',
    settings: [
      { key: 'classNavigator.aiSteps.enabled', label: 'Enable AI routine steps', type: 'boolean' },
      {
        key: 'classNavigator.aiSteps.provider', label: 'Model provider', type: 'select',
        options: ['oaicopilot'],
        optionLabels: ['OAI Compatible Copilot']
      },
      {
        key: 'classNavigator.aiSteps.modelId', label: 'AI model', type: 'model',
        placeholder: 'Select a configured model or enter a custom model ID'
      },
      {
        key: 'classNavigator.aiSteps.reasoningEffort', label: 'AI reasoning effort', type: 'select',
        options: ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        optionLabels: ['Provider default', 'Minimal (fastest; some gateways may not support it)', 'Low (default; mapped to high by GLM-5.2)', 'Medium', 'High', 'Extra high', 'Maximum (slowest)']
      },
      {
        key: 'classNavigator.aiSteps.granularity', label: 'Functional-block granularity', type: 'select',
        options: ['coarse', 'balanced'],
        optionLabels: ['Coarse: top-level functional phases (default)', 'Balanced: preserve more implementation phases']
      },
      { key: 'classNavigator.aiSteps.maxSteps', label: 'Maximum functional blocks', type: 'number', min: 1, max: 12, step: 1 },
      { key: 'classNavigator.aiSteps.normalTargetLines', label: 'Normal-generation finest granularity', type: 'number', unit: 'lines', min: 8, max: 50, step: 1 },
      { key: 'classNavigator.aiSteps.detailedTargetLines', label: 'Detailed-generation finest granularity', type: 'number', unit: 'lines', min: 6, max: 30, step: 1 },
      { key: 'classNavigator.aiSteps.substeps.enabled', label: 'Generate substeps for complex blocks', type: 'boolean' },
      { key: 'classNavigator.aiSteps.substeps.maxPerStep', label: 'Maximum substeps per block', type: 'number', min: 2, max: 8, step: 1 },
      { key: 'classNavigator.aiSteps.substeps.minParentLines', label: 'Minimum block length eligible for refinement', type: 'number', min: 6, max: 100, step: 1 },
      { key: 'classNavigator.aiSteps.substeps.maxDepth', label: 'Maximum recursive step depth', type: 'number', min: 2, max: 5, step: 1 },
      {
        key: 'classNavigator.aiSteps.maxSourceCharacters', label: 'Maximum routine source characters',
        type: 'number', min: 2000, max: 100000, step: 1000
      },
      {
        key: 'classNavigator.aiSteps.requestTimeoutSeconds', label: 'Per-request timeout',
        type: 'number', unit: 's', min: 15, max: 600, step: 15
      },
      { key: 'classNavigator.aiSteps.cacheEnabled', label: 'Cache steps for unchanged routines', type: 'boolean' },
      { key: 'classNavigator.aiSteps.highlightRange', label: 'Mark functional blocks in the gutter', type: 'boolean' },
    ],
    actions: [
      { command: 'pascalAtlas.classNavigator.stopAiGeneration', label: 'Stop AI step generation', icon: '■' }
    ]
  },
  {
    title: 'Completion and package symbols',
    description: 'Recovers compiled members such as AppSys, Environment, and objects returned by service locators.',
    settings: [
      { key: 'completion.enabled', label: 'Member completion after dot', type: 'boolean' },
      { key: 'completion.unqualified.enabled', label: 'Complete unqualified global-symbol prefixes', type: 'boolean' },
      { key: 'completion.interactiveWaitMs', label: 'Maximum global-completion wait', type: 'number', unit: 'ms', min: 0, max: 500, step: 10 },
      { key: 'signatureHelp.enabled', label: 'Routine signature help', type: 'boolean' },
      { key: 'signatureHelp.triggerOnComma', label: 'Switch signature parameter after comma', type: 'boolean' },
      { key: 'symbols.compiled.enabled', label: 'Recover BPL/DCP symbols', type: 'boolean' },
      { key: 'symbols.compiled.parsedCache.enabled', label: 'Cache parsed BPL/DCP indexes', type: 'boolean' },
      { key: 'symbols.sourceCache.enabled', label: 'Cache workspace and RAD/VCL source indexes', type: 'boolean' },
      { key: 'symbols.compiled.initialPackageLimit', label: 'Packages checked during initial scan', type: 'number', min: 1, max: 32, step: 1 }
    ]
  },
  {
    title: 'Code formatting',
    description: 'Integrated Delphi Personal Formatter features for document, save, on-type, and structural formatting.',
    settings: [
      { key: 'formatter.enabled', label: 'Enable Pascal Atlas Formatter', type: 'boolean' },
      { key: 'formatter.executablePath', label: 'Formatter.exe path', type: 'text', target: 'global', placeholder: 'Auto-detect RAD Studio when empty' },
      { key: 'formatter.preserveInlineVariables', label: 'Preserve inline variable declarations', type: 'boolean' },
      { key: 'formatter.alignWrappedParameters', label: 'Align wrapped parameters', type: 'boolean' },
      {
        key: 'formatter.shortcut', label: 'Format-document shortcut', type: 'select',
        options: ['shiftAltF', 'ctrlAltF', 'ctrlKCtrlF', 'none'],
        optionLabels: ['Shift+Alt+F', 'Ctrl+Alt+F', 'Ctrl+K Ctrl+F', 'Unassigned']
      },
      { key: 'formatter.onType.enabled', label: 'Format while typing', type: 'boolean' },
      {
        key: 'formatter.onType.semicolon.scope', label: 'Formatting after semicolon', type: 'select',
        options: ['currentLine', 'previousLine', 'currentAndPrevious', 'disabled'],
        optionLabels: ['Current line', 'Previous line', 'Current and previous lines', 'Disabled']
      },
      {
        key: 'formatter.onType.closingParenthesis.scope', label: 'Formatting after closing parenthesis', type: 'select',
        options: ['currentLine', 'previousLine', 'currentAndPrevious', 'disabled'],
        optionLabels: ['Current line', 'Previous line', 'Current and previous lines', 'Disabled']
      },
      {
        key: 'formatter.onType.enter.scope', label: 'Formatting after Enter', type: 'select',
        options: ['currentLine', 'previousLine', 'currentAndPrevious', 'disabled'],
        optionLabels: ['Current line', 'Previous line', 'Current and previous lines', 'Disabled']
      },
      { key: 'formatter.onType.logging', label: 'Log on-type formatting', type: 'boolean' },
      { key: 'formatter.highlighting.enabled', label: 'Delphi structural highlighting', type: 'boolean' },
      {
        key: 'formatter.highlighting.blockLevelColors',
        label: 'Structural level color cycle',
        type: 'colorPalette',
        defaultValue: [...DEFAULT_BLOCK_LEVEL_COLORS],
        placeholder: '#E06C75, #D19A66, #C586C0'
      }
    ],
    actions: [
      { command: 'pascalAtlas.formatter.formatDocument', label: 'Format active file', icon: '⌁' }
    ]
  },
  {
    title: 'Explorer exclusions',
    description: 'Controls whether Delphi forms, build output, metadata, and output directories appear in Explorer.',
    settings: [
      { key: 'explorer.hideFormFiles', label: 'Hide DFM/FMX form files', type: 'boolean', target: 'global' },
      { key: 'explorer.hideSkinConfigFiles', label: 'Hide SKINCFG files', type: 'boolean', target: 'global' },
      { key: 'explorer.hideBuildArtifacts', label: 'Hide DCU/BPL/DCP/EXE output', type: 'boolean', target: 'global' },
      { key: 'explorer.hideProjectMetadata', label: 'Hide project cache and metadata', type: 'boolean', target: 'global' },
      { key: 'explorer.hideBuildDirectories', label: 'Hide Win32/Win64/bin/lib directories', type: 'boolean', target: 'global' }
    ]
  },
  {
    title: 'Formatting style',
    description: 'Use the bundled default style or edit, save, and load a custom formatting profile.',
    settings: [
      { key: 'formatter.style.useDefault', label: 'Apply bundled default syntax standard', type: 'boolean' },
      ...STYLE_RULES.map(rule => ({
        ...rule,
        key: `formatter.${rule.key}`,
        styleRule: true
      }))
    ],
    actions: [
      { command: 'pascalAtlas.formatter.style.save', label: 'Save custom style', icon: '⇩' },
      { command: 'pascalAtlas.formatter.style.load', label: 'Load custom style', icon: '⇧' }
    ]
  },
  {
    title: 'Build and run',
    description: 'Invokes Delphi MSBuild/DCC directly in VS Code without starting RAD Studio or bds.exe.',
    settings: [
      { key: 'build.enabled', label: 'Enable command-line production builds', type: 'boolean' },
      {
        key: 'build.configuration', label: 'Default configuration', type: 'select',
        options: ['auto', 'Debug', 'Release'], optionLabels: ['Project default', 'Debug', 'Release']
      },
      {
        key: 'build.platform', label: 'Default platform', type: 'select',
        options: ['auto', 'Win32', 'Win64'], optionLabels: ['Project default', 'Win32', 'Win64']
      },
      { key: 'build.saveBeforeBuild', label: 'Save target project files before building', type: 'boolean' },
      { key: 'build.showStatusBar', label: 'Show Build All, Run, platform, and configuration in the status bar', type: 'boolean' },
      {
        key: 'run.buildBeforeRun', label: 'Build before Run', type: 'select',
        options: ['always', 'ifOutdated', 'never'], optionLabels: ['Always build', 'When missing or outdated', 'Never build']
      },
      { key: 'build.stopGroupOnFailure', label: 'Stop the project group after a failure', type: 'boolean' },
      { key: 'build.terminalSummary', label: 'Show an explicit build result in the terminal', type: 'boolean' },
      { key: 'build.output.showErrors', label: 'Build output: errors', type: 'boolean' },
      { key: 'build.output.showWarnings', label: 'Build output: warnings', type: 'boolean' },
      { key: 'build.output.showOther', label: 'Build output: other messages', type: 'boolean' },
      { key: 'build.completionNotification', label: 'Show a notification when the build finishes', type: 'boolean' },
      { key: 'build.timeoutSeconds', label: 'Production build timeout', type: 'number', unit: 's', min: 30, max: 7200, step: 30 },
      { key: 'build.msbuildPath', label: 'MSBuild.exe path (empty for auto-detection)', type: 'text', target: 'global' }
    ]
  },
  {
    title: 'Delphi navigator · Project mode',
    description: 'Shares one Explorer view between class navigation and a Project/Package tree.',
    settings: [
      { key: 'projectNavigator.enabled', label: 'Allow switching to Delphi Project mode', type: 'boolean' },
      {
        key: 'projectNavigator.defaultExpansion', label: 'Default project-tree expansion', type: 'select',
        options: ['firstLevel', 'all'], optionLabels: ['Expand Project only and show all Packages', 'Expand Project and Package']
      },
      { key: 'projectNavigator.showGroupproj', label: 'Show GROUPPROJ under Project', type: 'boolean' },
      { key: 'projectNavigator.showDpr', label: 'Show DPR under Project', type: 'boolean' },
      { key: 'projectNavigator.showDpk', label: 'Show DPK under Package', type: 'boolean' },
      { key: 'projectNavigator.showDproj', label: 'Show DPROJ under Package', type: 'boolean' },
      { key: 'projectNavigator.contextMenus.enabled', label: 'Show Project/Package build and run context menus', type: 'boolean' }
    ],
    actions: [
      { command: 'pascalAtlas.navigator.toggleMode', label: 'Switch class navigation / project', icon: '⇄' },
      { command: 'pascalAtlas.projectNavigator.refresh', label: 'Refresh Delphi project tree', icon: '↻' }
    ]
  },
  {
    title: 'Projects and search paths',
    description: 'Discovers groupproj files, loads Vallenta project groups, and merges source paths from every project.',
    settings: [
      { key: 'projectGroups.autoDetect', label: 'Automatically discover and load groupproj', type: 'boolean' },
      { key: 'projectGroups.activateFirstProject', label: 'Repair and select an active project when invalid', type: 'boolean' },
      { key: 'paths.enabled', label: 'Synchronize all projects automatically', type: 'boolean' },
      { key: 'includeNestedSourceDirectories', label: 'Include nested source directories', type: 'boolean' },
      { key: 'restartActiveLsp', label: 'Restart the active Vallenta LSP after path changes', type: 'boolean' }
    ],
    actions: [
      { command: 'pascalAtlas.projects.detect', label: 'Discover Project Group now', icon: '⌕' },
      { command: 'pascalAtlas.sync', label: 'Synchronize now', icon: '↻' },
      { command: 'pascalAtlas.showPaths', label: 'Show paths', icon: '≡' }
    ]
  },
  {
    title: 'Missing uses',
    description: 'Finds symbols whose declaring Unit is not imported and offers an Add Unit fix.',
    settings: [
      { key: 'missingUnits.enabled', label: 'Add Unit fixes for compiler diagnostics', type: 'boolean' },
      { key: 'missingUnits.debounceMs', label: 'Unit index refresh delay', type: 'number', unit: 'ms', min: 50, max: 5000, step: 50 },
      { key: 'missingUnits.compiledFallback', label: 'Search all compiled packages when necessary', type: 'boolean' }
    ]
  },
  {
    title: 'Background diagnostics',
    description: 'Independent syntax checks and isolated Delphi compiler diagnostics.',
    settings: [
      { key: 'diagnostics.enabled', label: 'Enable background diagnostics', type: 'boolean' },
      { key: 'diagnostics.syntax.enabled', label: 'Immediate syntax diagnostics', type: 'boolean' },
      { key: 'diagnostics.syntax.debounceMs', label: 'Syntax diagnostic delay', type: 'number', unit: 'ms', min: 50, max: 5000, step: 50 },
      { key: 'diagnostics.compiler.enabled', label: 'Delphi compiler diagnostics', type: 'boolean' },
      { key: 'diagnostics.compiler.idleDelayMs', label: 'Compiler idle delay', type: 'number', unit: 'ms', min: 250, max: 60000, step: 250 },
      { key: 'diagnostics.compiler.startupDelayMs', label: 'Initial compiler delay after startup', type: 'number', unit: 'ms', min: 0, max: 120000, step: 1000 },
      { key: 'diagnostics.compiler.maxParallelProjects', label: 'Parallel projects', type: 'number', min: 1, max: 4, step: 1 },
      { key: 'diagnostics.compiler.timeoutSeconds', label: 'Per-run timeout', type: 'number', unit: 's', min: 10, max: 1800, step: 10 },
      { key: 'diagnostics.compiler.includeWarnings', label: 'Show compiler warnings', type: 'boolean' },
      { key: 'diagnostics.ignoreUtf8ConversionWarning', label: 'Ignore “convert to UTF-8” warnings', type: 'boolean' },
      { key: 'diagnostics.compiler.configuration', label: 'Build configuration', type: 'select', options: ['auto', 'Debug', 'Release'] },
      { key: 'diagnostics.compiler.platform', label: 'Target platform', type: 'select', options: ['auto', 'Win32', 'Win64'] }
    ],
    actions: [
      { command: 'pascalAtlas.diagnostics.runNow', label: 'Run diagnostics now', icon: '▶' },
      { command: 'pascalAtlas.diagnostics.showStatus', label: 'Show status', icon: 'ⓘ' },
      { command: 'pascalAtlas.diagnostics.clearCache', label: 'Clear cache', icon: '⌫' }
    ]
  }
];

const COMMANDS = new Set(SECTIONS.flatMap(section => section.actions || []).map(action => action.command));

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

class PascalAtlasControlCenterProvider {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.view = undefined;
  }

  register() {
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('pascalAtlas.controlCenter', this, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      vscode.commands.registerCommand('pascalAtlas.openSettings', () => this.openMainSettings()),
      vscode.commands.registerCommand('pascalAtlas.openNativeSettings', () => {
        return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:BoringLi.pascal-atlas');
      }),
      vscode.commands.registerCommand('pascalAtlas.controlCenter.refresh', () => this.refresh()),
      vscode.commands.registerCommand('pascalAtlas.coloring.colors.reset', async () => {
        await resetSymbolColors(this.output);
        this.postState();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('pascalAtlas.ui.language')) this.refresh();
        else if (event.affectsConfiguration('pascalAtlas')) this.postState();
      })
    );
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview, false);
    view.webview.onDidReceiveMessage(message => this.receive(message), undefined, this.context.subscriptions);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  configuration() {
    return vscode.workspace.getConfiguration('pascalAtlas');
  }

  language() {
    return languageCode(this.configuration().get('ui.language', 'en'));
  }

  values() {
    const configuration = this.configuration();
    const values = Object.fromEntries(SECTIONS.flatMap(section => section.settings).map(setting => [
      setting.key,
      configuration.get(setting.key, setting.defaultValue)
    ]));
    if (values['formatter.style.useDefault']) {
      for (const rule of STYLE_RULES) {
        values[`formatter.${rule.key}`] = rule.defaultValue;
      }
    }
    return values;
  }

  status() {
    const folders = vscode.workspace.workspaceFolders || [];
    const projects = folders.flatMap(folder => discoverLoadedProjects(folder.uri.fsPath));
    const managedPaths = folders.flatMap(folder => this.context.workspaceState.get(
      `pascalAtlas.managedPaths:${folder.uri.fsPath}`,
      []
    ));
    return {
      workspaces: folders.length,
      projects: new Set(projects.map(item => item.toLowerCase())).size,
      paths: new Set(managedPaths.map(item => String(item).toLowerCase())).size
    };
  }

  async receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'update') {
      const setting = SECTIONS.flatMap(section => section.settings)
        .find(item => item.key === message.key);
      if (!setting) return;
      let value = message.value;
      if (setting.type === 'number') {
        value = Math.max(setting.min, Math.min(setting.max, Number(value)));
        if (!Number.isFinite(value)) return;
      } else if (setting.type === 'boolean') {
        value = Boolean(value);
      } else if (setting.type === 'text' || setting.type === 'model') {
        value = String(value || '').trim();
      } else if (setting.type === 'color') {
        value = String(value || '');
        if (!/^#[0-9a-f]{6}$/i.test(value)) return;
      } else if (setting.type === 'colorPalette') {
        value = String(value || '').split(/[\s,;]+/).filter(Boolean);
        if (value.length < 1 || value.length > 12
          || value.some(color => !/^#[0-9a-f]{6}$/i.test(color))) return;
      } else if (setting.type === 'select' && !setting.options.includes(value)) {
        return;
      }
      const target = setting.target === 'global'
        ? vscode.ConfigurationTarget.Global
        : vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await this.configuration().update(setting.key, value, target);
      this.output.appendLine(`Control Center updated pascalAtlas.${setting.key} = ${JSON.stringify(value)}.`);
      // Language changes rebuild the complete localized webview through the
      // configuration listener. Avoid a second render/flicker here.
      if (setting.key !== 'ui.language') this.postState();
      return;
    }
    if (message.type === 'command' && COMMANDS.has(message.command)) {
      await vscode.commands.executeCommand(message.command);
      this.postState();
      return;
    }
    if (message.type === 'openSettings') {
      await vscode.commands.executeCommand('pascalAtlas.openSettings');
    }
    if (message.type === 'openNativeSettings') {
      await vscode.commands.executeCommand('pascalAtlas.openNativeSettings');
    }
  }

  openMainSettings() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'pascalAtlas.settings',
      'Pascal Atlas Settings',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview, true);
    panel.webview.onDidReceiveMessage(message => this.receive(message), undefined, this.context.subscriptions);
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
  }

  refresh() {
    if (this.view) this.view.webview.html = this.html(this.view.webview, false);
    if (this.panel) {
      this.panel.title = 'Pascal Atlas Settings';
      this.panel.webview.html = this.html(this.panel.webview, true);
    }
  }

  postState() {
    void this.view?.webview.postMessage({ type: 'state', values: this.values(), status: this.status() });
    void this.panel?.webview.postMessage({ type: 'state', values: this.values(), status: this.status() });
  }

  html(webview, fullPage) {
    const nonce = randomBytes(16).toString('base64');
    const initial = JSON.stringify({ values: this.values(), status: this.status() }).replace(/</g, '\\u003c');
    const language = this.language();
    const english = language === 'en';
    const sections = sectionsWithPages(SECTIONS, language);
    const pages = localizedPages(language);
    const cards = pages.map((page, index) => `
      <div class="page${index === 0 ? ' active' : ''}" data-page="${index}">
        ${sections.filter(section => section.pageId === page.id).map(section => `
          <section class="card">
            <h2>${escapeHtml(section.title)}</h2>
            <p class="description">${escapeHtml(section.description)}</p>
            ${section.settings.map(setting => this.settingHtml(setting)).join('')}
            ${(section.actions || []).length ? `<div class="actions">${section.actions.map(action => `
              <button type="button" data-command="${escapeHtml(action.command)}"><span>${escapeHtml(action.icon)}</span>${escapeHtml(action.label)}</button>
            `).join('')}</div>` : ''}
          </section>
        `).join('')}
      </div>
    `).join('');
    const tabs = pages.map((page, index) => `
      <button type="button" class="tab${index === 0 ? ' active' : ''}" data-tab="${index}">${escapeHtml(page.title)}</button>
    `).join('');
    return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; }
    body { padding: ${fullPage ? '18px 24px' : '10px'}; max-width: ${fullPage ? '1100px' : 'none'}; margin: ${fullPage ? '0 auto' : '0'}; color: var(--vscode-foreground); background: ${fullPage ? 'var(--vscode-editor-background)' : 'var(--vscode-sideBar-background)'}; font: var(--vscode-font-weight) var(--vscode-font-size)/1.45 var(--vscode-font-family); }
    .hero { padding: 4px 2px 12px; }
    h1 { margin: 0 0 4px; font-size: 17px; }
    .subtitle, .description { color: var(--vscode-descriptionForeground); }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 10px 0 2px; }
    .metric { padding: 7px 4px; text-align: center; border: 1px solid var(--vscode-widget-border); border-radius: 5px; background: var(--vscode-editor-background); }
    .metric strong { display: block; font-size: 16px; color: var(--vscode-textLink-foreground); }
    .metric span { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .tabs { display: flex; gap: 3px; overflow-x: auto; margin: 0 0 9px; padding-bottom: 5px; }
    .tab { flex: 0 0 auto; color: var(--vscode-foreground); background: transparent; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--vscode-textLink-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .page { display: none; }
    .page.active { display: block; }
    .card { display: block; margin: 0 0 9px; padding: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-sideBar-background); }
    h2 { margin: 0; font-size: 13px; }
    .setting-group { position: sticky; top: 0; z-index: 1; margin: 12px 0 0; padding: 7px 0 4px; color: var(--vscode-textLink-foreground); background: var(--vscode-sideBar-background); font-size: 12px; }
    .description { margin: 3px 0 8px; font-size: 11px; }
    .setting { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 28px; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 55%, transparent); }
    .setting.disabled { opacity: .48; }
    .setting label { overflow-wrap: anywhere; }
    input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--vscode-focusBorder); }
    input[type=number], input[type=text], select { width: 120px; padding: 3px 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
    input.palette-input { width: min(260px, 48vw); }
    input[type=color] { width: 46px; height: 24px; padding: 1px 2px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 3px; background: var(--vscode-input-background); }
    .color-control { display: flex; align-items: center; gap: 7px; }
    .color-control code { min-width: 62px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .number { display: flex; align-items: center; gap: 4px; }
    .unit { min-width: 18px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    button { padding: 4px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button span { margin-right: 4px; }
    .footer { width: 100%; margin: 2px 0 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  </style>
</head>
<body>
  <header class="hero">
    <h1>Pascal Atlas</h1>
    <div class="subtitle">${'Delphi workspace development control center'}</div>
    <div class="summary">
      <div class="metric"><strong id="projectCount">0</strong><span>${'Projects'}</span></div>
      <div class="metric"><strong id="pathCount">0</strong><span>${'Managed paths'}</span></div>
      <div class="metric"><strong id="workspaceCount">0</strong><span>${'Workspaces'}</span></div>
    </div>
  </header>
  <nav class="tabs">${tabs}</nav>
  ${cards}
  ${fullPage ? '' : `
  <button type="button" class="footer" id="openSettings">${'Open full settings in the editor'}</button>
  <button type="button" class="footer" id="openNativeSettings">${'Open in VS Code Settings'}</button>`}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initial = ${initial};
    function apply(state) {
      for (const [key, value] of Object.entries(state.values || {})) {
        const input = document.querySelector('[data-key="' + CSS.escape(key) + '"]');
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
        if (input.type === 'color') input.parentElement.querySelector('[data-color-value]').textContent = input.value.toUpperCase();
      }
      const useDefaultStyle = Boolean(state.values?.['formatter.style.useDefault']);
      document.querySelectorAll('[data-style-rule]').forEach(input => {
        input.disabled = useDefaultStyle;
        input.closest('.setting')?.classList.toggle('disabled', useDefaultStyle);
      });
      const useDefaultColors = Boolean(state.values?.['coloring.colors.useDefault']);
      document.querySelectorAll('[data-color-rule]').forEach(input => {
        input.disabled = useDefaultColors;
        input.closest('.setting')?.classList.toggle('disabled', useDefaultColors);
      });
      document.getElementById('projectCount').textContent = state.status?.projects ?? 0;
      document.getElementById('pathCount').textContent = state.status?.paths ?? 0;
      document.getElementById('workspaceCount').textContent = state.status?.workspaces ?? 0;
    }
    document.querySelectorAll('[data-key]').forEach(input => input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked
        : input.type === 'number' ? Number(input.value) : input.value;
      if (input.type === 'color') input.parentElement.querySelector('[data-color-value]').textContent = input.value.toUpperCase();
      vscode.postMessage({ type: 'update', key: input.dataset.key, value });
    }));
    document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => {
      vscode.postMessage({ type: 'command', command: button.dataset.command });
    }));
    document.querySelectorAll('[data-tab]').forEach(tab => tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === tab));
      document.querySelectorAll('[data-page]').forEach(page => page.classList.toggle('active', page.dataset.page === tab.dataset.tab));
    }));
    document.getElementById('openSettings')?.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('openNativeSettings')?.addEventListener('click', () => vscode.postMessage({ type: 'openNativeSettings' }));
    window.addEventListener('message', event => { if (event.data?.type === 'state') apply(event.data); });
    apply(initial);
  </script>
</body>
</html>`;
  }

  settingHtml(setting) {
    const ruleAttributes = `${setting.styleRule ? ' data-style-rule="true"' : ''}`
      + `${setting.colorRule ? ' data-color-rule="true"' : ''}`;
    let input;
    if (setting.type === 'boolean') {
      input = `<input type="checkbox" data-key="${escapeHtml(setting.key)}"${ruleAttributes} aria-label="${escapeHtml(setting.label)}">`;
    } else if (setting.type === 'select') {
      input = `<select data-key="${escapeHtml(setting.key)}"${ruleAttributes}>${setting.options.map((option, index) => `
        <option value="${escapeHtml(option)}">${escapeHtml(setting.optionLabels?.[index] || option)}</option>`).join('')}</select>`;
    } else if (setting.type === 'number') {
      input = `<span class="number"><input type="number" data-key="${escapeHtml(setting.key)}"${ruleAttributes} min="${setting.min}" max="${setting.max}" step="${setting.step}"><span class="unit">${escapeHtml(setting.unit || '')}</span></span>`;
    } else if (setting.type === 'color') {
      const defaultColor = escapeHtml(setting.defaultValue || '#000000');
      input = `<span class="color-control"><input type="color" value="${defaultColor}" data-key="${escapeHtml(setting.key)}"${ruleAttributes} aria-label="${escapeHtml(setting.label)}"><code data-color-value>${defaultColor}</code></span>`;
    } else if (setting.type === 'model') {
      const models = vscode.workspace.getConfiguration('oaicopilot').get('models', []) || [];
      const currentModelId = String(this.configuration().get(setting.key, '') || '').trim();
      const discoveredModelIds = models
        .map(model => String(model?.id || '').trim())
        .filter(id => id && !id.startsWith('__provider__'));
      // Keep useful choices available if OAI Compatible Copilot has not
      // activated yet or its configuration cannot be read in this window.
      const modelIds = [...new Set([
        ...discoveredModelIds,
        ...['deepseek-v4-pro', 'glm-5.2', currentModelId].filter(Boolean)
      ])]
        .sort((left, right) => left.localeCompare(right));
      input = `<select data-key="${escapeHtml(setting.key)}"${ruleAttributes}>
        <option value="">${'Automatic (first available model)'}</option>
        ${modelIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')}
      </select>`;
    } else {
      const inputClass = setting.type === 'colorPalette' ? ' class="palette-input"' : '';
      input = `<input type="text"${inputClass} data-key="${escapeHtml(setting.key)}"${ruleAttributes} placeholder="${escapeHtml(setting.placeholder || '')}">`;
    }
    const group = setting.group
      ? `<h3 class="setting-group">${escapeHtml(setting.group)}</h3>`
      : '';
    return `${group}<div class="setting"><label>${escapeHtml(setting.label)}</label>${input}</div>`;
  }
}

module.exports = { SECTIONS, PascalAtlasControlCenterProvider };
