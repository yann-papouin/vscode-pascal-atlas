/** Navigation identifiers shared by the host, parser workers, and browser clients. */
export const NavigatorConfigurationSection = "pascalAtlas.classNavigator"
export const NavigatorViewId = "pascalAtlas.classNavigator"
export const NavigatorCommandId = {
  Open: "pascalAtlas.classNavigator.open",
  Focus: "pascalAtlas.classNavigator.focus",
  ContextPrefix: "pascalAtlas.classNavigator.context.",
} as const
export const NavigatorContextKey = {
  WebviewFocused: "pascalAtlas.classNavigator.webviewFocused",
  AiGenerating: "pascalAtlas.classNavigator.aiGenerating",
  Mode: "pascalAtlas.navigator.mode",
  NodePrefix: "pascalAtlas.classNavigator.",
} as const
export const NavigatorStateKey = {
  ExplorerLayout: "pascalAtlas.classNavigator.explorerLayoutVersion",
  Mode: "pascalAtlas.navigator.mode",
  ExpandedRoutines: "pascalAtlas.classNavigator.expandedRoutines",
  SearchOptions: "pascalAtlas.classNavigator.searchOptions",
  AiSteps: "pascalAtlas.classNavigator.aiSteps.cache.v1",
  AiStepChunks: "pascalAtlas.classNavigator.aiSteps.chunkCache.v1",
} as const
export const NavigatorResource = {
  Worker: "classNavigatorWorker.js",
  RangeMarker: "media/ai-step-range.svg",
} as const

export const NavigatorMode = Object.freeze({
  Class: "class",
  Project: "project",
} as const)
export const NavigatorItemKind = Object.freeze({ File: "file" } as const)
