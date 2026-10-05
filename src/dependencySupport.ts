import { errorMessage } from "./shared/guards"
import { CommandId } from "./shared/identifiers"
import * as vscode from "vscode"
import * as fs from "node:fs"
import * as path from "node:path"
import { findFormatterExecutable } from "./formatter/formatterSupport"
import { patchVallentaManifest } from "./vallentaMenuSupport"

const REQUIRED_EXTENSIONS = [
  {
    id: "VallentaStudio.vallenta-studio",
    name: "Vallenta Studio",
    reason:
      "Provides Delphi/Pascal language support, LSP, project management, compilation, and debugging.",
  },
  {
    id: "ms-vscode.cpptools",
    name: "Microsoft C/C++",
    reason: "A debugging prerequisite declared by Vallenta Studio.",
  },
]

const REDUNDANT_EXTENSIONS = [
  {
    id: "local.pascal-on-type-formatter",
    name: "Delphi Personal Formatter",
    reason: "Its complete implementation is already included in Pascal Atlas.",
  },
  {
    id: "alefragnani.pascal-formatter",
    name: "Pascal Formatter",
    reason:
      "Pascal Atlas uses RAD Studio Formatter.exe directly and does not call this extension.",
  },
  {
    id: "alefragnani.pascal",
    name: "Pascal",
    reason:
      "Vallenta already provides language, syntax, and navigation support, while Pascal Atlas provides common snippets. Enabling both may create duplicate providers.",
  },
]

/**
 * Check whether VS Code can locate an installed extension with the requested
 * Marketplace identifier.
 */
function extensionInstalled(id: string) {
  const wanted = id.toLowerCase()
  return vscode.extensions.all.some(
    /** Find the requested extension using its case-insensitive identifier. */ (
      extension,
    ) => extension.id.toLowerCase() === wanted,
  )
}

/**
 * Ask VS Code to install and enable a required extension; propagate installation
 * errors to the dependency checker.
 */
async function installRequiredExtension(extension: {
  id: string
  name?: string
  reason?: string
}) {
  await vscode.commands.executeCommand(
    "workbench.extensions.installExtension",
    extension.id,
    { enable: true },
  )
}

/**
 * Inspect required/conflicting extensions and local RAD Studio tools, optionally
 * install missing dependencies, and report failures or requested status notifications.
 */
async function checkDependencies(
  output: { appendLine: (arg0: string) => void },
  options: { notify?: boolean; autoInstall?: boolean } = {},
) {
  const configuration = vscode.workspace.getConfiguration("pascalAtlas.dependencies")
  const autoInstall = options.autoInstall ?? configuration.get("autoInstall", true)
  const notify = options.notify === true
  const missing = REQUIRED_EXTENSIONS.filter(
    /** Select required extensions that are not installed. */ (extension) =>
      !extensionInstalled(extension.id),
  )
  const installed = []
  const failed = []

  for (const extension of missing) {
    // Automatic installation is a configured opt-in path; a status check still reports missing dependencies when it is disabled.
    if (!autoInstall) continue
    output.appendLine(
      `Installing required extension ${extension.id}: ${extension.reason}.`,
    )
    try {
      await installRequiredExtension(extension)
      installed.push(extension)
    } catch (error) {
      failed.push({ extension, error })
      output.appendLine(
        `Required extension installation failed for ${extension.id}: ${errorMessage(error)}`,
      )
    }
  }

  const redundant = REDUNDANT_EXTENSIONS.filter(
    /** Select redundant extensions that are actually installed. */ (extension) =>
      extensionInstalled(extension.id),
  )
  const activeDocument = vscode.window.activeTextEditor?.document
  const formatterPath = findFormatterExecutable(activeDocument)
  const installationPath = vscode.workspace
    .getConfiguration("vallenta.studio")
    .get("installationPath", "")
  const tools = {
    formatter: Boolean(formatterPath && fs.existsSync(formatterPath)),
    tdump64: Boolean(
      installationPath &&
        fs.existsSync(path.join(installationPath, "bin", "tdump64.exe")),
    ),
  }
  output.appendLine(
    `Dependency check: ${REQUIRED_EXTENSIONS.length - missing.length}/${REQUIRED_EXTENSIONS.length} ` +
      `required extension(s) already installed; ${installed.length} installed now; ` +
      `${redundant.length} redundant/conflicting extension(s) detected.`,
  )
  output.appendLine(
    `Delphi tool check: Formatter.exe=${tools.formatter ? "ready" : "missing"}, ` +
      `tdump64.exe=${tools.tdump64 ? "ready" : "missing"}.`,
  )

  if (failed.length > 0) {
    void vscode.window.showErrorMessage(
      `Pascal Atlas could not install required extensions: ${failed.map(/** List extension names whose automatic installation failed. */ (item) => item.extension.name).join(", ")}.`,
    )
  } else if (notify) {
    const requiredStatus =
      missing.length === 0
        ? "All required extensions are installed"
        : installed.length === missing.length
          ? `Installed ${installed.map(/** List extensions successfully installed during setup. */ (item) => item.name).join(", ")}; reload to apply`
          : `Missing ${missing.map(/** List required extension names still missing after setup. */ (item) => item.name).join(", ")} (automatic installation is disabled)`
    const redundantStatus =
      redundant.length > 0
        ? `; duplicate extensions can be disabled: ${redundant.map(/** List installed extensions that duplicate provided functionality. */ (item) => item.name).join(", ")}`
        : ""
    const toolStatus =
      tools.formatter && tools.tdump64
        ? "; RAD Studio formatting and package symbol tools are ready"
        : `; missing${[!tools.formatter && " Formatter.exe", !tools.tdump64 && " tdump64.exe"].filter(Boolean).join(", ")}`
    void vscode.window.showInformationMessage(
      `${requiredStatus}${toolStatus}${redundantStatus}。`,
    )
  }

  return { missing, installed, failed, redundant, tools }
}

/**
 * Register dependency diagnostics, run the configured startup check, and normalize
 * installed Vallenta editor contributions with a backup.
 */
function registerDependencySupport(
  context: { subscriptions: vscode.Disposable[] },
  output: vscode.OutputChannel,
) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      CommandId.DependenciesCheck,
      /** Check required extensions and show the dependency status to the user. */ () =>
        checkDependencies(output, { notify: true }),
    ),
  )
  void checkDependencies(output).catch(
    /** Log dependency setup failures without rejecting extension activation. */ (
      error,
    ) => {
      output.appendLine(`Dependency check failed: ${error.stack || error.message}`)
    },
  )
  const hideEditorContextMenus = vscode.workspace
    .getConfiguration("pascalAtlas.navigation")
    .get("hideVallentaEditorContextMenus", true)
  const vallenta = vscode.extensions.getExtension("VallentaStudio.vallenta-studio")
  void patchVallentaManifest(vallenta?.extensionPath, {
    removeEditorContextMenus: hideEditorContextMenus,
    removeForcedKeywordBold: true,
  })
    .then(
      /** Report integration cleanup only when editor settings were changed. */ (
        result,
      ) => {
        if (!result.changed) return
        output.appendLine(
          `Normalized Vallenta editor integration: removed ${result.removed.length} context command(s) ` +
            `and ${result.removedKeywordStyles.length} forced keyword-bold rule(s); backup: ${result.backupPath}.`,
        )
        void vscode.window.showInformationMessage(
          "Pascal keyword font weights were normalized and Vallenta editor integration was updated. Fully quit all VS Code windows, then reopen the editor.",
        )
      },
    )
    .catch(
      /** Log integration cleanup failures without rejecting extension activation. */ (
        error,
      ) => {
        output.appendLine(
          `Unable to normalize Vallenta editor integration: ${error.stack || error.message}`,
        )
      },
    )
}

export {
  REDUNDANT_EXTENSIONS,
  REQUIRED_EXTENSIONS,
  checkDependencies,
  installRequiredExtension,
  registerDependencySupport,
}
