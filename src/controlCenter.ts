import { SettingValueType } from "./shared/identifiers"
import { WebviewMessageKind, WebviewResource } from "./shared/webviewProtocols"
import type { ControlCenterState, SettingValue } from "./shared/webviewProtocols"
import { isControlCenterClientMessage } from "./shared/webviewProtocols"
import { PascalKeyword } from "./shared/pascal"
import { CommandId, ConfigurationSection, SettingKey } from "./shared/identifiers"
import * as vscode from "vscode"
import { randomBytes } from "node:crypto"
import { discoverLoadedProjects } from "./projectDiscovery"
import { STYLE_RULES } from "./formatter/styleRules"
import { DEFAULT_BLOCK_LEVEL_COLORS } from "./formatter/highlighting"
import { resetSymbolColors } from "./defaultSettings"
import { languageCode, localizedPages, sectionsWithPages } from "./controlCenterI18n"

interface SettingDefinition {
  key: string
  label: string
  type: string
  target?: string
  defaultValue?: SettingValue
  options?: readonly SettingValue[]
  optionLabels?: readonly string[]
  min?: number
  max?: number
  step?: number
  unit?: string
  styleRule?: boolean
  colorRule?: boolean
  placeholder?: string
  group?: string
}
interface SettingSection {
  title: string
  description: string
  settings: SettingDefinition[]
  actions?: { command: string; icon: string; label: string }[]
  pageId?: string
}
const SECTIONS: SettingSection[] = [
  {
    title: "Interface language",
    description: "Controls the language used by Pascal Atlas settings pages.",
    settings: [
      {
        key: SettingKey.UiLanguage,
        label: "Settings language",
        type: WebviewMessageKind.Select,
        target: "global",
        defaultValue: "en",
        options: ["en"],
        optionLabels: ["English"],
      },
    ],
  },
  {
    title: "Master switch",
    description:
      "Controls all Pascal Atlas companion features. Vallenta remains available when this is disabled.",
    settings: [
      {
        key: SettingKey.Enabled,
        label: "Enable Pascal Atlas",
        type: SettingValueType.Boolean,
      },
    ],
  },
  {
    title: "Dependencies and compatibility",
    description:
      "Keeps Vallenta Studio and debugging prerequisites available; legacy formatter and duplicate Pascal providers are not required.",
    settings: [
      {
        key: SettingKey.DependenciesAutoInstall,
        label: "Automatically install missing required extensions",
        type: SettingValueType.Boolean,
      },
    ],
    actions: [
      {
        command: CommandId.DependenciesCheck,
        label: "Check extension environment",
        icon: "✓",
      },
    ],
  },
  {
    title: "File encoding",
    description: "Use UTF-8 or UTF-8 with BOM for Delphi and other text files.",
    settings: [
      {
        key: SettingKey.EncodingEnabled,
        label: "Enable file encoding policy",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.EncodingDelphiDefault,
        label: "New or ambiguous Delphi files",
        type: WebviewMessageKind.Select,
        target: "global",
        options: ["utf8", "utf8bom"],
        optionLabels: ["UTF-8 (default)", "UTF-8 with BOM"],
      },
      {
        key: SettingKey.EncodingOtherDefault,
        label: "New or ambiguous non-Delphi files",
        type: WebviewMessageKind.Select,
        target: "global",
        options: ["utf8", "utf8bom"],
        optionLabels: ["UTF-8 (default)", "UTF-8 with BOM"],
      },
      {
        key: SettingKey.EncodingDetectExisting,
        label: "Detect and preserve existing file encoding",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.EncodingRespectDprojDeclaration,
        label: "Prefer the DPROJ XML encoding declaration",
        type: SettingValueType.Boolean,
      },
    ],
  },
  {
    title: "Symbol coloring",
    description:
      "Analyzes the active file first and merges symbols from every loaded project, source tree, and package.",
    settings: [
      {
        key: SettingKey.ColoringEnabled,
        label: "Pascal Atlas symbol coloring",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ColoringTypingDelayMs,
        label: "Active-file typing delay",
        type: SettingValueType.Number,
        unit: "ms",
        min: 0,
        max: 3000,
        step: 10,
      },
      {
        key: SettingKey.ColoringInactiveEditorDelayMs,
        label: "Inactive-editor delay",
        type: SettingValueType.Number,
        unit: "ms",
        min: 0,
        max: 5000,
        step: 50,
      },
      {
        key: SettingKey.ColoringPersistedCacheEnabled,
        label: "Preserve recent file coloring across windows",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ColoringColorsUseDefault,
        label: "Use theme semantic colors",
        type: SettingValueType.Boolean,
        group: "Color palette",
      },
      {
        key: SettingKey.ColoringColorsUnit,
        label: "Unit names",
        type: SettingValueType.Color,
        colorRule: true,
        defaultValue: "#4EC9B0",
      },
      {
        key: SettingKey.ColoringColorsType,
        label: "Types and interfaces",
        type: SettingValueType.Color,
        colorRule: true,
        defaultValue: "#4EC9B0",
      },
      {
        key: SettingKey.ColoringColorsVariable,
        label: "Variables and fields",
        type: SettingValueType.Color,
        colorRule: true,
        defaultValue: "#9CDCFE",
      },
      {
        key: SettingKey.ColoringColorsConstant,
        label: "Constants",
        type: SettingValueType.Color,
        colorRule: true,
        defaultValue: "#4FC1FF",
      },
      {
        key: SettingKey.ColoringColorsEnumMember,
        label: "Enum members",
        type: SettingValueType.Color,
        colorRule: true,
        defaultValue: "#4FC1FF",
      },
      {
        key: SettingKey.ColoringColorsProperty,
        label: "Properties",
        type: SettingValueType.Color,
        colorRule: true,
        defaultValue: "#9CDCFE",
      },
      {
        key: SettingKey.ColoringColorsMethod,
        label: "Functions and procedures",
        type: SettingValueType.Color,
        colorRule: true,
        defaultValue: "#DCDCAA",
      },
    ],
    actions: [
      {
        command: CommandId.ColoringColorsReset,
        label: "Reset default colors",
        icon: "↺",
      },
    ],
  },
  {
    title: "Navigation and interfaces",
    description:
      "Source routines prefer implementations; symbols without source can open generated interfaces recovered from packages.",
    settings: [
      {
        key: SettingKey.NavigationEnabled,
        label: "Enhanced Pascal Atlas navigation",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.NavigationPreferImplementation,
        label: "Prefer routine implementations",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.NavigationSingleTargetByDefault,
        label: "Use only the best target for normal navigation",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.NavigationSelectTargetOnJump,
        label: "Select the target identifier after navigation (may flash)",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.NavigationCandidatePickerShortcut,
        label: "All-candidates shortcut",
        type: WebviewMessageKind.Select,
        options: ["altF12", "ctrlAltF12", "none"],
        optionLabels: ["Alt+F12", "Ctrl+Alt+F12", "Unassigned"],
      },
      {
        key: SettingKey.NavigationVirtualInterfaces,
        label: "Open virtual interfaces when source is unavailable",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.NavigationIsolatePlatformSources,
        label: "Isolate large RTL/VCL sources to avoid blocking Vallenta",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.NavigationPrewarmCurrentFile,
        label: "Prewarm the active file and its uses",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.NavigationInteractiveWaitMs,
        label: "Maximum Ctrl-navigation wait",
        type: SettingValueType.Number,
        unit: "ms",
        min: 0,
        max: 1000,
        step: 10,
      },
      {
        key: SettingKey.HoverEnabled,
        label: "Package-symbol hover information",
        type: SettingValueType.Boolean,
      },
    ],
  },
  {
    title: "Class and routine navigator",
    description:
      "Organizes Pascal types and routines in Explorer, with compact include targets for DPK and DPROJ files.",
    settings: [
      {
        key: SettingKey.ClassNavigatorEnabled,
        label: "Show Delphi class navigator in Explorer",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowUses,
        label: "Show uses nodes without listing imported Units",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowGlobalRoutines,
        label: "Show global functions and procedures",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowInterfaces,
        label: "Show interfaces",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowRecordsAndObjects,
        label: "Show records and objects",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowProperties,
        label: "Show a properties group first in each type",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowProjectPackageEntry,
        label: "Show Package Includes for DPK/DPROJ",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowProjectFileEntry,
        label: "Show File Includes for DPK/DPROJ",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowUnitInitialization,
        label: "Show Unit initialization at the bottom",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorShowUnitFinalization,
        label: "Show Unit finalization at the bottom",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorMemberOrder,
        label: "Member ordering",
        type: WebviewMessageKind.Select,
        options: ["visibility", "declaration", PascalKeyword.Implementation],
        optionLabels: [
          "Grouped order (default)",
          "Declaration order",
          "Implementation order",
        ],
      },
      {
        key: SettingKey.ClassNavigatorTypeOrder,
        label: "Top-level type ordering",
        type: WebviewMessageKind.Select,
        options: ["declaration", "alphabetical"],
        optionLabels: ["Declaration order (default)", "Alphabetical order"],
      },
      {
        key: SettingKey.ClassNavigatorFollowCursor,
        label: "Follow editor clicks and scrolling",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorHighlightRangeEnabled,
        label: "Mark source blocks for real navigation items",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorPauseWhenCollapsed,
        label: "Pause monitoring while the navigator is collapsed",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorScrollFollowDelayMs,
        label: "Scroll-follow delay",
        type: SettingValueType.Number,
        unit: "ms",
        min: 0,
        max: 500,
        step: 5,
      },
      {
        key: SettingKey.ClassNavigatorScrollFollowOffsetLines,
        label: "Scroll-follow line offset",
        type: SettingValueType.Number,
        unit: "lines",
        min: -20,
        max: 20,
        step: 1,
      },
      {
        key: SettingKey.ClassNavigatorNavigationClickHoldMs,
        label: "Navigation-click anti-flicker duration",
        type: SettingValueType.Number,
        unit: "ms",
        min: 0,
        max: 2000,
        step: 50,
      },
      {
        key: SettingKey.ClassNavigatorNavigationRevealMode,
        label: "Source placement after navigator jumps",
        type: WebviewMessageKind.Select,
        options: ["smart", "center", "top", PascalKeyword.Default],
        optionLabels: [
          "Smart: center fitting blocks, position large blocks proportionally (default)",
          "Always center",
          "Place start at top",
          "VS Code default",
        ],
      },
      {
        key: SettingKey.ClassNavigatorNavigationRevealLargeBlockStartPercent,
        label: "Large-block start position from viewport top",
        type: SettingValueType.Number,
        unit: "%",
        min: 0,
        max: 50,
        step: 5,
      },
      {
        key: SettingKey.ClassNavigatorKeepFocusOnNavigationClick,
        label: "Keep tree focus and blue selection after navigation clicks",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorDefaultOpenBelowExplorer,
        label: "Initially open below the Explorer file tree",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorBackgroundParsingEnabled,
        label: "Parse large-file navigation in a worker",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorBackgroundParsingThresholdKb,
        label: "Background parsing threshold",
        type: SettingValueType.Number,
        unit: "KB",
        min: 64,
        max: 4096,
        step: 64,
      },
    ],
    actions: [
      {
        command: CommandId.NavigatorShowClasses,
        label: "Switch to class navigation",
        icon: "◈",
      },
      {
        command: CommandId.ClassNavigatorRefresh,
        label: "Refresh active-file navigation",
        icon: "↻",
      },
    ],
  },
  {
    title: "AI routine steps",
    description:
      "Uses the selected OAI Compatible Copilot model to create navigable functional steps for routines.",
    settings: [
      {
        key: SettingKey.ClassNavigatorAiStepsEnabled,
        label: "Enable AI routine steps",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsProvider,
        label: "Model provider",
        type: WebviewMessageKind.Select,
        options: ["oaicopilot"],
        optionLabels: ["OAI Compatible Copilot"],
      },
      {
        key: SettingKey.ClassNavigatorAiStepsModelId,
        label: "AI model",
        type: WebviewMessageKind.Model,
        placeholder: "Select a configured model or enter a custom model ID",
      },
      {
        key: SettingKey.ClassNavigatorAiStepsReasoningEffort,
        label: "AI reasoning effort",
        type: WebviewMessageKind.Select,
        options: ["auto", "minimal", "low", "medium", "high", "xhigh", "max"],
        optionLabels: [
          "Provider default",
          "Minimal (fastest; some gateways may not support it)",
          "Low (default; mapped to high by GLM-5.2)",
          "Medium",
          "High",
          "Extra high",
          "Maximum (slowest)",
        ],
      },
      {
        key: SettingKey.ClassNavigatorAiStepsGranularity,
        label: "Functional-block granularity",
        type: WebviewMessageKind.Select,
        options: ["coarse", "balanced"],
        optionLabels: [
          "Coarse: top-level functional phases (default)",
          "Balanced: preserve more implementation phases",
        ],
      },
      {
        key: SettingKey.ClassNavigatorAiStepsMaxSteps,
        label: "Maximum functional blocks",
        type: SettingValueType.Number,
        min: 1,
        max: 12,
        step: 1,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsNormalTargetLines,
        label: "Normal-generation finest granularity",
        type: SettingValueType.Number,
        unit: "lines",
        min: 8,
        max: 50,
        step: 1,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsDetailedTargetLines,
        label: "Detailed-generation finest granularity",
        type: SettingValueType.Number,
        unit: "lines",
        min: 6,
        max: 30,
        step: 1,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsSubstepsEnabled,
        label: "Generate substeps for complex blocks",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsSubstepsMaxPerStep,
        label: "Maximum substeps per block",
        type: SettingValueType.Number,
        min: 2,
        max: 8,
        step: 1,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsSubstepsMinParentLines,
        label: "Minimum block length eligible for refinement",
        type: SettingValueType.Number,
        min: 6,
        max: 100,
        step: 1,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsSubstepsMaxDepth,
        label: "Maximum recursive step depth",
        type: SettingValueType.Number,
        min: 2,
        max: 5,
        step: 1,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsMaxSourceCharacters,
        label: "Maximum routine source characters",
        type: SettingValueType.Number,
        min: 2000,
        max: 100000,
        step: 1000,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsRequestTimeoutSeconds,
        label: "Per-request timeout",
        type: SettingValueType.Number,
        unit: "s",
        min: 15,
        max: 600,
        step: 15,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsCacheEnabled,
        label: "Cache steps for unchanged routines",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ClassNavigatorAiStepsHighlightRange,
        label: "Mark functional blocks in the gutter",
        type: SettingValueType.Boolean,
      },
    ],
    actions: [
      {
        command: CommandId.ClassNavigatorStopAiGeneration,
        label: "Stop AI step generation",
        icon: "■",
      },
    ],
  },
  {
    title: "Completion and package symbols",
    description:
      "Recovers compiled members such as AppSys, Environment, and objects returned by service locators.",
    settings: [
      {
        key: SettingKey.CompletionEnabled,
        label: "Member completion after dot",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.CompletionUnqualifiedEnabled,
        label: "Complete unqualified global-symbol prefixes",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.CompletionInteractiveWaitMs,
        label: "Maximum global-completion wait",
        type: SettingValueType.Number,
        unit: "ms",
        min: 0,
        max: 500,
        step: 10,
      },
      {
        key: SettingKey.SignatureHelpEnabled,
        label: "Routine signature help",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.SignatureHelpTriggerOnComma,
        label: "Switch signature parameter after comma",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.SymbolsCompiledEnabled,
        label: "Recover BPL/DCP symbols",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.SymbolsCompiledParsedCacheEnabled,
        label: "Cache parsed BPL/DCP indexes",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.SymbolsSourceCacheEnabled,
        label: "Cache workspace and RAD/VCL source indexes",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.SymbolsCompiledInitialPackageLimit,
        label: "Packages checked during initial scan",
        type: SettingValueType.Number,
        min: 1,
        max: 32,
        step: 1,
      },
    ],
  },
  {
    title: "Code formatting",
    description:
      "Integrated Delphi Personal Formatter features for document, save, on-type, and structural formatting.",
    settings: [
      {
        key: SettingKey.FormatterEnabled,
        label: "Enable Pascal Atlas Formatter",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterExecutablePath,
        label: "Formatter.exe path",
        type: SettingValueType.String,
        target: "global",
        placeholder: "Auto-detect RAD Studio when empty",
      },
      {
        key: SettingKey.FormatterPreserveInlineVariables,
        label: "Preserve inline variable declarations",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterNormalizeTypeNameCapitalization,
        label: "Capitalize type names",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterNormalizeVariableNameCapitalization,
        label: "Capitalize variable names",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterNormalizeGenericTypeSpacing,
        label: "Normalize generic type spacing",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterNormalizeInlineVariableContinuations,
        label: "Align inline variable continuations",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterAlignWrappedParameters,
        label: "Align wrapped parameters",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterShortcut,
        label: "Format-document shortcut",
        type: WebviewMessageKind.Select,
        options: ["shiftAltF", "ctrlAltF", "ctrlKCtrlF", "none"],
        optionLabels: ["Shift+Alt+F", "Ctrl+Alt+F", "Ctrl+K Ctrl+F", "Unassigned"],
      },
      {
        key: SettingKey.FormatterOnTypeEnabled,
        label: "Format while typing",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterOnTypeSemicolonScope,
        label: "Formatting after semicolon",
        type: WebviewMessageKind.Select,
        options: ["currentLine", "previousLine", "currentAndPrevious", "disabled"],
        optionLabels: [
          "Current line",
          "Previous line",
          "Current and previous lines",
          "Disabled",
        ],
      },
      {
        key: SettingKey.FormatterOnTypeClosingParenthesisScope,
        label: "Formatting after closing parenthesis",
        type: WebviewMessageKind.Select,
        options: ["currentLine", "previousLine", "currentAndPrevious", "disabled"],
        optionLabels: [
          "Current line",
          "Previous line",
          "Current and previous lines",
          "Disabled",
        ],
      },
      {
        key: SettingKey.FormatterOnTypeEnterScope,
        label: "Formatting after Enter",
        type: WebviewMessageKind.Select,
        options: ["currentLine", "previousLine", "currentAndPrevious", "disabled"],
        optionLabels: [
          "Current line",
          "Previous line",
          "Current and previous lines",
          "Disabled",
        ],
      },
      {
        key: SettingKey.FormatterOnTypeLogging,
        label: "Log on-type formatting",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterHighlightingEnabled,
        label: "Delphi structural highlighting",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.FormatterHighlightingBlockLevelColors,
        label: "Structural level color cycle",
        type: SettingValueType.ColorPalette,
        defaultValue: [...DEFAULT_BLOCK_LEVEL_COLORS],
        placeholder: "#E06C75, #D19A66, #C586C0",
      },
    ],
    actions: [
      {
        command: CommandId.FormatterFormatDocument,
        label: "Format active file",
        icon: "⌁",
      },
    ],
  },
  {
    title: "Explorer exclusions",
    description:
      "Controls whether Delphi forms, build output, metadata, and output directories appear in Explorer.",
    settings: [
      {
        key: SettingKey.ExplorerHideFormFiles,
        label: "Hide DFM/FMX form files",
        type: SettingValueType.Boolean,
        target: "global",
      },
      {
        key: SettingKey.ExplorerHideSkinConfigFiles,
        label: "Hide SKINCFG files",
        type: SettingValueType.Boolean,
        target: "global",
      },
      {
        key: SettingKey.ExplorerHideBuildArtifacts,
        label: "Hide DCU/BPL/DCP/EXE output",
        type: SettingValueType.Boolean,
        target: "global",
      },
      {
        key: SettingKey.ExplorerHideProjectMetadata,
        label: "Hide project cache and metadata",
        type: SettingValueType.Boolean,
        target: "global",
      },
      {
        key: SettingKey.ExplorerHideBuildDirectories,
        label: "Hide Win32/Win64/bin/lib directories",
        type: SettingValueType.Boolean,
        target: "global",
      },
    ],
  },
  {
    title: "Formatting style",
    description:
      "Use the bundled default style or edit, save, and load a custom formatting profile.",
    settings: [
      {
        key: SettingKey.FormatterStyleUseDefault,
        label: "Apply bundled default syntax standard",
        type: SettingValueType.Boolean,
      },
      ...STYLE_RULES.map(
        /**
         * Expose each formatter rule with its full configuration key and custom-style
         * marker.
         */ (rule) => ({
          ...rule,
          key: `formatter.${rule.key}`,
          styleRule: true,
        }),
      ),
    ],
    actions: [
      { command: CommandId.FormatterStyleSave, label: "Save custom style", icon: "⇩" },
      { command: CommandId.FormatterStyleLoad, label: "Load custom style", icon: "⇧" },
    ],
  },
  {
    title: "Build and run",
    description:
      "Invokes Delphi MSBuild/DCC directly in VS Code without starting RAD Studio or bds.exe.",
    settings: [
      {
        key: SettingKey.BuildEnabled,
        label: "Enable command-line production builds",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildConfiguration,
        label: "Default configuration",
        type: WebviewMessageKind.Select,
        options: ["auto", "Debug", "Release"],
        optionLabels: ["Project default", "Debug", "Release"],
      },
      {
        key: SettingKey.BuildPlatform,
        label: "Default platform",
        type: WebviewMessageKind.Select,
        options: ["auto", "Win32", "Win64"],
        optionLabels: ["Project default", "Win32", "Win64"],
      },
      {
        key: SettingKey.BuildSaveBeforeBuild,
        label: "Save target project files before building",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildShowStatusBar,
        label: "Show Build All, Run, platform, and configuration in the status bar",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.RunBuildBeforeRun,
        label: "Build before Run",
        type: WebviewMessageKind.Select,
        options: ["always", "ifOutdated", "never"],
        optionLabels: ["Always build", "When missing or outdated", "Never build"],
      },
      {
        key: SettingKey.BuildStopGroupOnFailure,
        label: "Stop the project group after a failure",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildTerminalSummary,
        label: "Show an explicit build result in the terminal",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildOutputShowErrors,
        label: "Build output: errors",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildOutputShowWarnings,
        label: "Build output: warnings",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildOutputShowOther,
        label: "Build output: other messages",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildCompletionNotification,
        label: "Show a notification when the build finishes",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.BuildTimeoutSeconds,
        label: "Production build timeout",
        type: SettingValueType.Number,
        unit: "s",
        min: 30,
        max: 7200,
        step: 30,
      },
      {
        key: SettingKey.BuildMsbuildPath,
        label: "MSBuild.exe path (empty for auto-detection)",
        type: SettingValueType.String,
        target: "global",
      },
    ],
  },
  {
    title: "Delphi navigator · Project mode",
    description:
      "Shares one Explorer view between class navigation and a Project/Package tree.",
    settings: [
      {
        key: SettingKey.ProjectNavigatorEnabled,
        label: "Allow switching to Delphi Project mode",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ProjectNavigatorDefaultExpansion,
        label: "Default project-tree expansion",
        type: WebviewMessageKind.Select,
        options: ["firstLevel", "all"],
        optionLabels: [
          "Expand Project only and show all Packages",
          "Expand Project and Package",
        ],
      },
      {
        key: SettingKey.ProjectNavigatorShowGroupproj,
        label: "Show GROUPPROJ under Project",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ProjectNavigatorShowDpr,
        label: "Show DPR under Project",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ProjectNavigatorShowDpk,
        label: "Show DPK under Package",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ProjectNavigatorShowDproj,
        label: "Show DPROJ under Package",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ProjectNavigatorContextMenusEnabled,
        label: "Show Project/Package build and run context menus",
        type: SettingValueType.Boolean,
      },
    ],
    actions: [
      {
        command: CommandId.NavigatorToggleMode,
        label: "Switch class navigation / project",
        icon: "⇄",
      },
      {
        command: CommandId.ProjectNavigatorRefresh,
        label: "Refresh Delphi project tree",
        icon: "↻",
      },
    ],
  },
  {
    title: "Projects and search paths",
    description:
      "Discovers groupproj files, loads Vallenta project groups, and merges source paths from every project.",
    settings: [
      {
        key: SettingKey.ProjectGroupsAutoDetect,
        label: "Automatically discover and load groupproj",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.ProjectGroupsActivateFirstProject,
        label: "Repair and select an active project when invalid",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.PathsEnabled,
        label: "Synchronize all projects automatically",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.IncludeNestedSourceDirectories,
        label: "Include nested source directories",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.RestartActiveLsp,
        label: "Restart the active Vallenta LSP after path changes",
        type: SettingValueType.Boolean,
      },
    ],
    actions: [
      {
        command: CommandId.ProjectsDetect,
        label: "Discover Project Group now",
        icon: "⌕",
      },
      { command: CommandId.Sync, label: "Synchronize now", icon: "↻" },
      { command: CommandId.ShowPaths, label: "Show paths", icon: "≡" },
    ],
  },
  {
    title: "Missing uses",
    description:
      "Finds symbols whose declaring Unit is not imported and offers an Add Unit fix.",
    settings: [
      {
        key: SettingKey.MissingUnitsEnabled,
        label: "Add Unit fixes for compiler diagnostics",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.MissingUnitsDebounceMs,
        label: "Unit index refresh delay",
        type: SettingValueType.Number,
        unit: "ms",
        min: 50,
        max: 5000,
        step: 50,
      },
      {
        key: SettingKey.MissingUnitsCompiledFallback,
        label: "Search all compiled packages when necessary",
        type: SettingValueType.Boolean,
      },
    ],
  },
  {
    title: "Background diagnostics",
    description: "Independent syntax checks and isolated Delphi compiler diagnostics.",
    settings: [
      {
        key: SettingKey.DiagnosticsEnabled,
        label: "Enable background diagnostics",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.DiagnosticsSyntaxEnabled,
        label: "Immediate syntax diagnostics",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.DiagnosticsSyntaxDebounceMs,
        label: "Syntax diagnostic delay",
        type: SettingValueType.Number,
        unit: "ms",
        min: 50,
        max: 5000,
        step: 50,
      },
      {
        key: SettingKey.DiagnosticsCompilerEnabled,
        label: "Delphi compiler diagnostics",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.DiagnosticsCompilerIdleDelayMs,
        label: "Compiler idle delay",
        type: SettingValueType.Number,
        unit: "ms",
        min: 250,
        max: 60000,
        step: 250,
      },
      {
        key: SettingKey.DiagnosticsCompilerStartupDelayMs,
        label: "Initial compiler delay after startup",
        type: SettingValueType.Number,
        unit: "ms",
        min: 0,
        max: 120000,
        step: 1000,
      },
      {
        key: SettingKey.DiagnosticsCompilerMaxParallelProjects,
        label: "Parallel projects",
        type: SettingValueType.Number,
        min: 1,
        max: 4,
        step: 1,
      },
      {
        key: SettingKey.DiagnosticsCompilerTimeoutSeconds,
        label: "Per-run timeout",
        type: SettingValueType.Number,
        unit: "s",
        min: 10,
        max: 1800,
        step: 10,
      },
      {
        key: SettingKey.DiagnosticsCompilerIncludeWarnings,
        label: "Show compiler warnings",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.DiagnosticsIgnoreUtf8ConversionWarning,
        label: "Ignore “convert to UTF-8” warnings",
        type: SettingValueType.Boolean,
      },
      {
        key: SettingKey.DiagnosticsCompilerConfiguration,
        label: "Build configuration",
        type: WebviewMessageKind.Select,
        options: ["auto", "Debug", "Release"],
      },
      {
        key: SettingKey.DiagnosticsCompilerPlatform,
        label: "Target platform",
        type: WebviewMessageKind.Select,
        options: ["auto", "Win32", "Win64"],
      },
    ],
    actions: [
      {
        command: CommandId.DiagnosticsRunNow,
        label: "Run diagnostics now",
        icon: "▶",
      },
      { command: CommandId.DiagnosticsShowStatus, label: "Show status", icon: "ⓘ" },
      { command: CommandId.DiagnosticsClearCache, label: "Clear cache", icon: "⌫" },
    ],
  },
]

const COMMANDS = new Set(
  SECTIONS.flatMap(
    /** Collect settings-page actions for the browser command allowlist. */ (section) =>
      section.actions || [],
  ).map(
    /** Allow the host command declared by this settings action. */ (action) =>
      action.command,
  ),
)

/**
 * Escape text and attribute values used in generated settings markup so configuration
 * or labels cannot inject HTML.
 */
function escapeHtml(value: unknown) {
  return String(value).replace(
    /[&<>"']/g,
    /** Replace markup delimiters with entities before inserting text into HTML. */ (
      character,
    ) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character] || character,
  )
}

class PascalAtlasControlCenterProvider {
  context: vscode.ExtensionContext
  output
  view: vscode.WebviewView | undefined
  panel: vscode.WebviewPanel | undefined

  /**
   * Create the settings webview provider with extension resource context, output
   * logging, and editor-panel tracking.
   */
  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.context = context
    this.output = output
    this.view = undefined
  }

  /**
   * Register settings views and commands, and refresh affected UI state when
   * configuration changes.
   */
  register() {
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("pascalAtlas.controlCenter", this, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.commands.registerCommand(
        CommandId.OpenSettings,
        /**
         * Execute the CommandId.OpenSettings action against the current extension state.
         */ () => this.openMainSettings(),
      ),
      vscode.commands.registerCommand(
        CommandId.OpenNativeSettings,
        /**
         * Execute the CommandId.OpenNativeSettings action against the current extension
         * state.
         */ () => {
          return vscode.commands.executeCommand(
            "workbench.action.openSettings",
            "@ext:yannpapouin.pascal-atlas",
          )
        },
      ),
      vscode.commands.registerCommand(
        CommandId.ControlCenterRefresh,
        /**
         * Execute the CommandId.ControlCenterRefresh action against the current
         * extension state.
         */ () => this.refresh(),
      ),
      vscode.commands.registerCommand(
        CommandId.ColoringColorsReset,
        /**
         * Execute the CommandId.ColoringColorsReset action against the current extension
         * state.
         */ async () => {
          await resetSymbolColors(this.output)
          this.postState()
        },
      ),
      vscode.workspace.onDidChangeConfiguration(
        /**
         * Rebuild markup for language changes; send current values for other settings
         * changes.
         */ (event) => {
          if (event.affectsConfiguration("pascalAtlas.ui.language")) this.refresh()
          else if (event.affectsConfiguration(ConfigurationSection)) this.postState()
        },
      ),
    )
  }

  /**
   * Resolve the sidebar settings webview with local browser resources, message
   * handling, and view disposal tracking.
   */
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, WebviewResource.ScriptDirectory),
      ],
    }
    view.webview.html = this.html(view.webview, false)
    view.webview.onDidReceiveMessage(
      /** Validate and handle requests from the sidebar settings browser. */ (
        message: unknown,
      ) => this.receive(message),
      undefined,
      this.context.subscriptions,
    )
    view.onDidDispose(
      /** Forget this sidebar view when it is disposed. */ () => {
        if (this.view === view) this.view = undefined
      },
    )
  }

  /** Read the Pascal Atlas configuration for settings rendering and updates. */
  configuration() {
    return vscode.workspace.getConfiguration(ConfigurationSection)
  }

  /**
   * Select the supported control-center display language from the configured
   * preference.
   */
  language() {
    return languageCode(this.configuration().get(SettingKey.UiLanguage, "en"))
  }

  /**
   * Collect displayed setting values, projecting bundled style defaults when the
   * default formatter profile is active.
   */
  values(): ControlCenterState["values"] {
    const configuration = this.configuration()
    const values: ControlCenterState["values"] = Object.fromEntries(
      SECTIONS.flatMap(
        /** Collect every settings definition for the state payload. */ (section) =>
          section.settings,
      ).map(
        /** Read the current value with the definition fallback when one is provided. */ (
          setting,
        ) => [
          setting.key,
          setting.defaultValue === undefined
            ? configuration.get<SettingValue>(setting.key)
            : configuration.get<SettingValue>(setting.key, setting.defaultValue),
        ],
      ),
    )
    if (values["formatter.style.useDefault"]) {
      for (const rule of STYLE_RULES) {
        values[`formatter.${rule.key}`] = rule.defaultValue
      }
    }
    return values
  }

  /**
   * Count open workspaces, unique loaded projects, and managed navigation paths for
   * the control-center overview.
   */
  status() {
    const folders = vscode.workspace.workspaceFolders || []
    const projects = folders.flatMap(
      /** Discover loaded projects across all workspace folders. */ (folder) =>
        discoverLoadedProjects(folder.uri.fsPath),
    )
    const managedPaths = folders.flatMap(
      /** Read the managed search paths saved for each workspace folder. */ (folder) =>
        this.context.workspaceState.get<string[]>(
          `pascalAtlas.managedPaths:${folder.uri.fsPath}`,
          [],
        ),
    )
    return {
      workspaces: folders.length,
      projects: new Set(
        projects.map(
          /** Normalize project identities before counting distinct loaded projects. */ (
            item,
          ) => item.toLowerCase(),
        ),
      ).size,
      paths: new Set(
        managedPaths.map(
          /**
           * Normalize path identities before counting distinct managed search paths.
           */ (item) => String(item).toLowerCase(),
        ),
      ).size,
    }
  }

  /**
   * Validate browser commands/setting updates, normalize supported values, choose the
   * allowed configuration scope, and refresh state after changes.
   */
  async receive(value: unknown) {
    if (!isControlCenterClientMessage(value)) return
    const message = value
    if (message.type === WebviewMessageKind.Update) {
      const setting = SECTIONS.flatMap(
        /** Search all settings definitions before accepting a browser update. */ (
          section,
        ) => section.settings,
      ).find(
        /**
         * Find the declared setting corresponding to the requested configuration key.
         */ (item) => item.key === message.key,
      )
      if (!setting) return
      if (
        setting.styleRule &&
        this.configuration().get(SettingKey.FormatterStyleUseDefault, true)
      )
        return
      let value = message.value
      if (setting.type === SettingValueType.Number) {
        value = Math.max(
          setting.min ?? -Infinity,
          Math.min(setting.max ?? Infinity, Number(value)),
        )
        if (!Number.isFinite(value)) return
      } else if (setting.type === SettingValueType.Boolean) {
        value = Boolean(value)
      } else if (
        setting.type === SettingValueType.String ||
        setting.type === SettingValueType.Model
      ) {
        value = String(value || "").trim()
      } else if (setting.type === SettingValueType.Color) {
        value = String(value || "")
        if (!/^#[0-9a-f]{6}$/i.test(value)) return
      } else if (setting.type === SettingValueType.ColorPalette) {
        value = String(value || "")
          .split(/[\s,;]+/)
          .filter(Boolean)
        if (
          value.length < 1 ||
          value.length > 12 ||
          value.some(
            /**
             * Reject a palette containing a value outside the supported hexadecimal
             * color format.
             */ (color: string) => !/^#[0-9a-f]{6}$/i.test(color),
          )
        )
          return
      } else if (
        setting.type === SettingValueType.Select &&
        !(setting.options || []).includes(value)
      ) {
        return
      }
      const target =
        setting.target === "global"
          ? vscode.ConfigurationTarget.Global
          : vscode.workspace.workspaceFolders?.length
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global
      await this.configuration().update(setting.key, value, target)
      this.output.appendLine(
        `Control Center updated pascalAtlas.${setting.key} = ${JSON.stringify(value)}.`,
      )
      // Language changes rebuild the complete localized webview through the
      // configuration listener. Avoid a second render/flicker here.
      if (setting.key !== SettingKey.UiLanguage) this.postState()
      return
    }
    if (message.type === WebviewMessageKind.Command && COMMANDS.has(message.command)) {
      await vscode.commands.executeCommand(message.command)
      this.postState()
      return
    }
    if (message.type === WebviewMessageKind.OpenSettings) {
      await vscode.commands.executeCommand(CommandId.OpenSettings)
    }
    if (message.type === WebviewMessageKind.OpenNativeSettings) {
      await vscode.commands.executeCommand(CommandId.OpenNativeSettings)
    }
  }

  /**
   * Open or reveal the full settings editor panel with safe local resources and the
   * same typed state/message protocol as the sidebar.
   */
  openMainSettings() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One)
      return
    }
    const panel = vscode.window.createWebviewPanel(
      "pascalAtlas.settings",
      "Pascal Atlas Settings",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(
            this.context.extensionUri,
            WebviewResource.ScriptDirectory,
          ),
        ],
      },
    )
    this.panel = panel
    panel.webview.html = this.html(panel.webview, true)
    panel.webview.onDidReceiveMessage(
      /** Validate and handle requests from the editor settings browser. */ (message) =>
        this.receive(message),
      undefined,
      this.context.subscriptions,
    )
    panel.onDidDispose(
      /** Forget this settings panel when it is disposed. */ () => {
        if (this.panel === panel) this.panel = undefined
      },
    )
  }

  /**
   * Regenerate active control-center markup after changes that affect section layout
   * or language.
   */
  refresh() {
    if (this.view) this.view.webview.html = this.html(this.view.webview, false)
    if (this.panel) {
      this.panel.title = "Pascal Atlas Settings"
      this.panel.webview.html = this.html(this.panel.webview, true)
    }
  }

  /**
   * Publish current setting values and overview counts to all active settings
   * webviews.
   */
  postState() {
    void this.view?.webview.postMessage({
      type: WebviewMessageKind.State,
      values: this.values(),
      status: this.status(),
    })
    void this.panel?.webview.postMessage({
      type: WebviewMessageKind.State,
      values: this.values(),
      status: this.status(),
    })
  }

  /**
   * Render sidebar or full-page settings markup with escaped controls,
   * nonce-restricted local scripts, and serialized bootstrap state.
   */
  html(webview: vscode.Webview, fullPage: boolean) {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        WebviewResource.ControlCenterScript,
      ),
    )
    const nonce = randomBytes(16).toString("base64")
    const initial = JSON.stringify({
      values: this.values(),
      status: this.status(),
    }).replace(/</g, "\\u003c")
    const language = this.language()
    const english = language === "en"
    const sections = sectionsWithPages(SECTIONS, language)
    const pages = localizedPages(language)
    const cards = pages
      .map(
        /** Render each page container, showing the first page initially. */ (
          page,
          index,
        ) => `
      <div class="page${index === 0 ? " active" : ""}" data-page="${index}">
        ${sections
          .filter(
            /** Include only sections assigned to the current settings page. */ (
              section,
            ) => section.pageId === page.id,
          )
          .map(
            /** Render the section heading, controls, and permitted action buttons. */ (
              section,
            ) => `
          <section class="card">
            <h2>${escapeHtml(section.title)}</h2>
            <p class="description">${escapeHtml(section.description)}</p>
            ${section.settings.map(/** Render the control appropriate to each setting definition. */ (setting) => this.settingHtml(setting)).join("")}
            ${
              (section.actions || []).length
                ? `<div class="actions">${(section.actions || [])
                    .map(
                      /**
                       * Render a settings action with its escaped command, icon, and
                       * label.
                       */ (action) => `
              <button type="button" data-command="${escapeHtml(action.command)}"><span>${escapeHtml(action.icon)}</span>${escapeHtml(action.label)}</button>
            `,
                    )
                    .join("")}</div>`
                : ""
            }
          </section>
        `,
          )
          .join("")}
      </div>
    `,
      )
      .join("")
    const tabs = pages
      .map(
        /** Render the tab button for each settings page. */ (page, index) => `
      <button type="button" class="tab${index === 0 ? " active" : ""}" data-tab="${index}">${escapeHtml(page.title)}</button>
    `,
      )
      .join("")
    return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; }
    body { padding: ${fullPage ? "18px 24px" : "10px"}; max-width: ${fullPage ? "1100px" : "none"}; margin: ${fullPage ? "0 auto" : "0"}; color: var(--vscode-foreground); background: ${fullPage ? "var(--vscode-editor-background)" : "var(--vscode-sideBar-background)"}; font: var(--vscode-font-weight) var(--vscode-font-size)/1.45 var(--vscode-font-family); }
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
    <div class="subtitle">${"Delphi workspace development control center"}</div>
    <div class="summary">
      <div class="metric"><strong id="projectCount">0</strong><span>${"Projects"}</span></div>
      <div class="metric"><strong id="pathCount">0</strong><span>${"Managed paths"}</span></div>
      <div class="metric"><strong id="workspaceCount">0</strong><span>${"Workspaces"}</span></div>
    </div>
  </header>
  <nav class="tabs">${tabs}</nav>
  ${cards}
  ${
    fullPage
      ? ""
      : `
  <button type="button" class="footer" id="openSettings">${"Open full settings in the editor"}</button>
  <button type="button" class="footer" id="openNativeSettings">${"Open in VS Code Settings"}</button>`
  }
  <script type="application/json" id="initial-state">${initial.replace(/</g, "\\u003c")}</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`
  }

  /**
   * Render a setting control for its supported value kind, including defaults, labels,
   * model choices, and style/color rule metadata.
   */
  settingHtml(setting: SettingDefinition) {
    const ruleAttributes =
      `${setting.styleRule ? ' data-style-rule="true"' : ""}` +
      `${setting.colorRule ? ' data-color-rule="true"' : ""}`
    let input
    if (setting.type === SettingValueType.Boolean) {
      input = `<input type="checkbox" data-key="${escapeHtml(setting.key)}"${ruleAttributes} aria-label="${escapeHtml(setting.label)}">`
    } else if (setting.type === SettingValueType.Select) {
      input = `<select data-key="${escapeHtml(setting.key)}"${ruleAttributes}>${(
        setting.options || []
      )
        .map(
          /** Render a supported option using its display label when available. */ (
            option,
            index,
          ) => `
        <option value="${escapeHtml(option)}">${escapeHtml(setting.optionLabels?.[index] || option)}</option>`,
        )
        .join("")}</select>`
    } else if (setting.type === SettingValueType.Number) {
      input = `<span class="number"><input type="number" data-key="${escapeHtml(setting.key)}"${ruleAttributes} min="${setting.min}" max="${setting.max}" step="${setting.step}"><span class="unit">${escapeHtml(setting.unit || "")}</span></span>`
    } else if (setting.type === SettingValueType.Color) {
      const defaultColor = escapeHtml(setting.defaultValue || "#000000")
      input = `<span class="color-control"><input type="color" value="${defaultColor}" data-key="${escapeHtml(setting.key)}"${ruleAttributes} aria-label="${escapeHtml(setting.label)}"><code data-color-value>${defaultColor}</code></span>`
    } else if (setting.type === SettingValueType.Model) {
      const models =
        vscode.workspace
          .getConfiguration("oaicopilot")
          .get<{ id?: string }[]>("models", []) || []
      const currentModelId = String(
        this.configuration().get(setting.key, "") || "",
      ).trim()
      const discoveredModelIds = models
        .map(
          /** Read usable model IDs from the configured provider models. */ (model) =>
            String(model?.id || "").trim(),
        )
        .filter(
          /**
           * Exclude empty IDs and provider placeholder entries from the model picker.
           */ (id) => id && !id.startsWith("__provider__"),
        )
      // Keep useful choices available if OAI Compatible Copilot has not
      // activated yet or its configuration cannot be read in this window.
      const modelIds = [
        ...new Set([
          ...discoveredModelIds,
          ...["deepseek-v4-pro", "glm-5.2", currentModelId].filter(Boolean),
        ]),
      ].sort(
        /** Order model IDs alphabetically for a stable picker. */ (left, right) =>
          left.localeCompare(right),
      )
      input = `<select data-key="${escapeHtml(setting.key)}"${ruleAttributes}>
        <option value="">${"Automatic (first available model)"}</option>
        ${modelIds.map(/** Render an escaped model ID as a selectable option. */ (id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join("")}
      </select>`
    } else {
      const inputClass =
        setting.type === SettingValueType.ColorPalette ? ' class="palette-input"' : ""
      input = `<input type="text"${inputClass} data-key="${escapeHtml(setting.key)}"${ruleAttributes} placeholder="${escapeHtml(setting.placeholder || "")}">`
    }
    const group = setting.group
      ? `<h3 class="setting-group">${escapeHtml(setting.group)}</h3>`
      : ""
    return `${group}<div class="setting"><label>${escapeHtml(setting.label)}</label>${input}</div>`
  }
}

export { SECTIONS, PascalAtlasControlCenterProvider }
