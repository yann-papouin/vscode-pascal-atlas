import { ConfigurationSection } from "./shared/identifiers"
import * as vscode from "vscode"

const LEGACY_PATTERN =
  "**/*.{dfm,fmx,groupproj,res,rc,map,dcu,bpl,dcp,exe,lib,obj,o,ppu,identcache,local,stat,vsdcache,delphilsp.json,vallenta,encoding-backup*}"
const LEGACY_BUILD_ARTIFACT_PATTERN = "**/*.{res,rc,map,dcu,bpl,dcp,exe,lib,obj,o,ppu}"
const LEGACY_DIRECTORY_PATTERNS = Object.freeze([
  "**/__history",
  "**/__recovery",
  "**/Win32",
  "**/Win64",
  "**/Debug",
  "**/Release",
  "**/bin",
  "**/lib",
  "**/tmp",
])
const LEGACY_PROJECT_METADATA_PATTERN =
  "**/*.{groupproj,identcache,local,stat,vsdcache,delphilsp.json,vallenta,encoding-backup*}"
const GROUPS = Object.freeze({
  "explorer.hideFormFiles": "**/*.{dfm,fmx}",
  "explorer.hideSkinConfigFiles": "**/*.skincfg",
  "explorer.hideBuildArtifacts": "**/*.{res,rc,map,mes,dcu,bpl,dcp,exe,lib,obj,o,ppu}",
  // `.groupproj` is an actionable source project file, not disposable metadata.
  // Keep it visible so its dedicated project-file decoration can be rendered.
  "explorer.hideProjectMetadata":
    "**/*.{identcache,local,stat,vsdcache,delphilsp.json,vallenta,encoding-backup*}",
  "explorer.hideBuildDirectories":
    "**/{__history,__recovery,Win32,Win64,Debug,Release,bin,lib,tmp}",
})

/**
 * Serialize an object in key order for stable comparison of Explorer exclusion
 * settings.
 */
function stableObject(value: Record<string, unknown>) {
  return JSON.stringify(
    Object.entries(value || {}).sort(
      /** Sort explorer exclusion entries for deterministic persisted settings. */ (
        [left],
        [right],
      ) => left.localeCompare(right),
    ),
  )
}

/**
 * Migrate older managed exclusion patterns and synchronize enabled Delphi file
 * categories while retaining unrelated global exclusions.
 */
async function syncExplorerExcludes(output: { appendLine: (arg0: string) => void }) {
  const pa = vscode.workspace.getConfiguration(ConfigurationSection)
  const files = vscode.workspace.getConfiguration("files")
  const inspected = files.inspect<Record<string, boolean | { when: string }>>("exclude")
  const current = { ...inspected?.globalValue }
  const next = { ...current }

  // Migrate the previous all-in-one rule so each category can be controlled
  // independently from Pascal Atlas settings.
  const hasLegacyLayout = Object.prototype.hasOwnProperty.call(next, LEGACY_PATTERN)
  delete next[LEGACY_PATTERN]
  if (hasLegacyLayout) {
    for (const pattern of LEGACY_DIRECTORY_PATTERNS) delete next[pattern]
  }
  // Migrate the previously managed metadata rule that also hid groupproj.
  delete next[LEGACY_PROJECT_METADATA_PATTERN]
  delete next[LEGACY_BUILD_ARTIFACT_PATTERN]
  for (const pattern of Object.values(GROUPS)) delete next[pattern]
  for (const [setting, pattern] of Object.entries(GROUPS)) {
    if (pa.get(setting, true)) next[pattern] = true
  }
  if (stableObject(current) === stableObject(next)) return
  await files.update("exclude", next, vscode.ConfigurationTarget.Global)
  output.appendLine("Synchronized configurable Delphi Explorer exclusion groups.")
}

/**
 * Synchronize Explorer exclusions at startup and on relevant settings changes,
 * retaining the subscription and logging refresh failures.
 */
function registerExplorerSupport(
  context: { subscriptions: vscode.Disposable[] },
  output: vscode.OutputChannel,
) {
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(
      /** Resynchronize explorer exclusions when their Pascal Atlas settings change. */ (
        event,
      ) => {
        if (!event.affectsConfiguration("pascalAtlas.explorer")) return
        void syncExplorerExcludes(output).catch(
          /** Log a failed explorer exclusion refresh. */ (error) => {
            output.appendLine(
              `Explorer exclusion synchronization failed: ${error.message}`,
            )
          },
        )
      },
    ),
  )
  void syncExplorerExcludes(output).catch(
    /** Log a failed initial explorer exclusion synchronization. */ (error) => {
      output.appendLine(`Explorer exclusion synchronization failed: ${error.message}`)
    },
  )
}

export {
  GROUPS,
  LEGACY_BUILD_ARTIFACT_PATTERN,
  LEGACY_DIRECTORY_PATTERNS,
  LEGACY_PROJECT_METADATA_PATTERN,
  LEGACY_PATTERN,
  registerExplorerSupport,
  syncExplorerExcludes,
}
