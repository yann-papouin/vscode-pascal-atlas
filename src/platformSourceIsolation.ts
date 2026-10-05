import { PascalKeyword } from "./shared/pascal"
import { ConfigurationSection, LanguageId, SettingKey } from "./shared/identifiers"
import * as vscode from "vscode"

const PLATFORM_LANGUAGE_ID = LanguageId.Platform
const MANAGED_ASSOCIATION_VALUE = PLATFORM_LANGUAGE_ID

/**
 * Build RTL/VCL source globs for the configured RAD Studio version, falling back to
 * version-independent installation globs.
 */
function platformSourceAssociationPatterns(installationPath: string) {
  const normalized = String(installationPath || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
  const version = normalized.match(/\/Embarcadero\/Studio\/([^/]+)$/i)?.[1]
  if (version) {
    return [
      `**/Embarcadero/Studio/${version}/source/rtl/**/*.pas`,
      `**/Embarcadero/Studio/${version}/source/vcl/**/*.pas`,
    ]
  }
  return [
    "**/Embarcadero/Studio/*/source/rtl/**/*.pas",
    "**/Embarcadero/Studio/*/source/vcl/**/*.pas",
  ]
}

/**
 * Add or remove only Pascal Atlas-owned platform-source associations, returning a
 * copied map and whether a settings write is required.
 */
function mergedAssociations(
  existing: Record<string, string>,
  patterns: string[],
  enabled: boolean,
) {
  const result = { ...(existing && typeof existing === "object" ? existing : {}) }
  let changed = false
  for (const pattern of patterns) {
    if (enabled) {
      if (result[pattern] === MANAGED_ASSOCIATION_VALUE) continue
      result[pattern] = MANAGED_ASSOCIATION_VALUE
      changed = true
      // Disable only associations still owned by Pascal Atlas; a user-replaced language association must survive.
    } else if (result[pattern] === MANAGED_ASSOCIATION_VALUE) {
      delete result[pattern]
      changed = true
    }
  }
  return { associations: result, changed }
}

/**
 * Reconcile global file associations with platform-isolation settings and the selected
 * installation, writing only when managed entries differ.
 */
async function synchronizePlatformSourceIsolation(output: {
  appendLine: (arg0: string) => void
}) {
  const enabled = vscode.workspace
    .getConfiguration(ConfigurationSection)
    .get(SettingKey.NavigationIsolatePlatformSources, true)
  const installationPath = vscode.workspace
    .getConfiguration("vallenta.studio")
    .get("installationPath", "")
  const patterns = platformSourceAssociationPatterns(installationPath)
  const configuration = vscode.workspace.getConfiguration("files")
  const inspected = configuration.inspect<Record<string, string>>("associations")
  const existing = inspected?.globalValue || {}
  const merged = mergedAssociations(existing, patterns, enabled)
  if (!merged.changed) return false
  await configuration.update(
    "associations",
    merged.associations,
    vscode.ConfigurationTarget.Global,
  )
  output?.appendLine(
    `${enabled ? "Enabled" : "Disabled"} isolated Delphi platform source mode ` +
      `for ${patterns.length} source pattern(s).`,
  )
  return true
}

/**
 * Refresh managed platform associations at startup and when isolation or installation
 * settings change, logging asynchronous failures.
 */
function registerPlatformSourceIsolation(
  context: { subscriptions: vscode.Disposable[] },
  output: vscode.OutputChannel,
) {
  void synchronizePlatformSourceIsolation(output).catch(
    /** Log a failed initial platform-source isolation setup. */ (error) => {
      output.appendLine(`Platform source isolation setup failed: ${error.message}`)
    },
  )
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(
      /**
       * Resynchronize platform-source isolation when its policy or Delphi installation
       * path changes.
       */ (event) => {
        if (
          !event.affectsConfiguration(
            "pascalAtlas.navigation.isolatePlatformSources",
          ) &&
          !event.affectsConfiguration("vallenta.studio.installationPath")
        )
          return
        void synchronizePlatformSourceIsolation(output).catch(
          /** Log a failed platform-source isolation refresh. */ (error) => {
            output.appendLine(
              `Platform source isolation refresh failed: ${error.message}`,
            )
          },
        )
      },
    ),
  )
}

export {
  MANAGED_ASSOCIATION_VALUE,
  PLATFORM_LANGUAGE_ID,
  mergedAssociations,
  platformSourceAssociationPatterns,
  registerPlatformSourceIsolation,
  synchronizePlatformSourceIsolation,
}
