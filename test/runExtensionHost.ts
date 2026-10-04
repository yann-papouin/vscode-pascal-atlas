import * as fs from "node:fs"
import * as path from "node:path"
import { runTests } from "@vscode/test-electron"
import { projectRoot } from "./helpers"

async function main(): Promise<void> {
  const version = process.env.VSCODE_VERSION
  const executable =
    process.env.VSCODE_EXECUTABLE ||
    (process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe")
      : undefined)
  if (!version && (!executable || !fs.existsSync(executable)))
    throw new Error(
      "Set VSCODE_EXECUTABLE to a local VS Code executable or VSCODE_VERSION to an official release for the isolated smoke test.",
    )
  const testRoot = path.resolve(projectRoot, ".vscode-test")
  await fs.promises.mkdir(testRoot, { recursive: true })
  const runRoot = await fs.promises.mkdtemp(path.join(testRoot, "atlas-smoke-"))
  const workspace = path.join(runRoot, "workspace")
  const profile = path.join(runRoot, "user-data")
  const extensions = path.join(runRoot, "extensions")
  await fs.promises.cp(
    path.join(projectRoot, "test", "fixtures", "host", "workspace"),
    workspace,
    { recursive: true },
  )
  await Promise.all([
    fs.promises.mkdir(path.join(profile, "User"), { recursive: true }),
    fs.promises.mkdir(extensions),
  ])
  // User-scope settings ensure eager activation cannot install tools before the workspace is ready.
  await fs.promises.copyFile(
    path.join(workspace, ".vscode", "settings.json"),
    path.join(profile, "User", "settings.json"),
  )
  const reportPath = path.join(runRoot, "report.json")
  console.log("Isolated Extension Host artifacts: " + runRoot)
  const hostLog = fs.createWriteStream(path.join(runRoot, "extension-host.log"))
  try {
    await runTests({
      ...(version
        ? { version, cachePath: testRoot }
        : { vscodeExecutablePath: executable }),
      stdout: hostLog,
      stderr: hostLog,
      reuseMachineInstall: false,
      extensionDevelopmentPath: [
        projectRoot,
        path.join(projectRoot, "test", "fixtures", "host", "language-support"),
      ],
      extensionTestsPath: path.join(
        projectRoot,
        "out",
        "test",
        "extensionHostSmoke.js",
      ),
      extensionTestsEnv: {
        PASCAL_ATLAS_SMOKE_REPORT: reportPath,
        ELECTRON_RUN_AS_NODE: undefined,
      },
      launchArgs: [
        workspace,
        "--new-window",
        "--user-data-dir=" + profile,
        "--extensions-dir=" + extensions,
        "--disable-workspace-trust",
        "--disable-updates",
        "--skip-welcome",
        "--skip-release-notes",
        "--disable-telemetry",
        "--disable-extensions",
      ],
    })
  } finally {
    hostLog.end()
  }
  console.log(await fs.promises.readFile(reportPath, "utf8"))
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
