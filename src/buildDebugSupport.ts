import { UriScheme } from "./shared/identifiers"
import type {
  ProjectDescriptor,
  DetailedProjectDescriptor,
  GroupDescriptor,
} from "./delphiProjectModel"
import type { ProjectOverrides } from "./diagnosticCore"
import { isRecord } from "./shared/guards"
import { errorMessage, isInteger } from "./shared/guards"
import { PascalKeyword } from "./shared/pascal"
import { CommandId, ConfigurationSection, SettingKey } from "./shared/identifiers"
import * as vscode from "vscode"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn } from "node:child_process"
import {
  BackgroundDiagnostics,
  findDelphiInstallation,
  readRsvarsEnvironment,
} from "./backgroundDiagnostics"
import { normalizeKey } from "./projectDiscovery"
import {
  DelphiProjectModel,
  minimalProjectDescriptor,
  projectDescriptor,
  statSignature,
} from "./delphiProjectModel"
import { evaluateProjectProperties, readProjectInfo } from "./diagnosticCore"
import { ProjectNavigatorProvider } from "./projectNavigator"
import { ChildProcessByStdio } from "child_process"
import { Readable } from "stream"

const STARTUP_KEY = "pascalAtlas.run.groupStartupProjects"
const SELECTION_KEY = "pascalAtlas.build.selections"
const DETAILS_KEY = "pascalAtlas.delphiProjectDetails.v1"
// CSI 2 J clears the visible viewport; CSI 3 J also drops xterm's scrollback.
// Both are needed when a filter changes, otherwise hidden lines remain visible
// after the user scrolls upward even though the current viewport was redrawn.
const CLEAR_ENTIRE_TERMINAL = "\x1b[2J\x1b[3J\x1b[H"

function uniquePaths(values: (string | undefined)[]) {
  const seen = new Set()
  const result = []
  for (const value of values.filter((value): value is string => Boolean(value))) {
    const resolved = path.resolve(value)
    const key = normalizeKey(resolved)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(resolved)
    }
  }
  return result
}

function parseCommandLine(value: string) {
  const result = []
  for (const match of String(value || "").matchAll(
    /"((?:\\"|[^"])*)"|'((?:''|[^'])*)'|([^\s]+)/g,
  )) {
    result.push(
      (match[1] ?? match[2] ?? match[3]).replace(/\\"/g, '"').replace(/''/g, "'"),
    )
  }
  return result
}

function parseBuildDiagnosticLine(value: string, cwd = "") {
  let line = String(value || "").trim()
  line = line.replace(/^\[(?:ERROR|WARN)\]\s+/, "")
  line = line.replace(/\s+\[[^\]]+\.dproj\]\s*$/i, "")

  let match =
    /^\[dcc\w*\s+(fatal error|fatal|error|warning|hint)\]\s+(.+?)\((\d+)(?:,(\d+))?\):\s*([FEWH]\d{4})?\s*:?[ \t]*(.*)$/i.exec(
      line,
    )
  let severity
  let fileName
  let lineNumber
  let columnNumber
  let code
  let message
  if (match) {
    ;[, severity, fileName, lineNumber, columnNumber, code, message] = match
  } else {
    match =
      /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(?:(fatal error|fatal|error|warning|hint)\s+)?([FEWH]\d{4})?\s*:?[ \t]*(.*)$/i.exec(
        line,
      )
    if (!match || (!match[4] && !match[5])) return undefined
    ;[, fileName, lineNumber, columnNumber, severity, code, message] = match
  }

  const severityText = String(severity || "").toLowerCase()
  const codePrefix = String(code || "")
    .charAt(0)
    .toUpperCase()
  const kind =
    severityText.includes("warning") || codePrefix === "W"
      ? "warning"
      : severityText.includes("hint") || codePrefix === "H"
        ? "hint"
        : "error"
  const cleanFileName = String(fileName || "")
    .trim()
    .replace(/^"|"$/g, "")
  return {
    filePath: path.isAbsolute(cleanFileName)
      ? cleanFileName
      : path.resolve(cwd || ".", cleanFileName),
    line: Math.max(0, Number.parseInt(lineNumber, 10) - 1),
    column: Math.max(0, Number.parseInt(columnNumber || "1", 10) - 1),
    severity: kind,
    code: code || undefined,
    message: String(message || "").trim(),
  }
}

function buildOutputCategory(line: string): BuildOutputCategory {
  if (/^\s*\[ERROR\]/i.test(line)) return "errors"
  if (/^\s*\[WARN\]/i.test(line)) return "warnings"
  return "other"
}

function colorBuildOutputLine(line: string, category: string) {
  if (category === "errors" || /BUILD FAILED/i.test(line))
    return `\x1b[31m${line}\x1b[0m`
  if (category === "warnings") return `\x1b[33m${line}\x1b[0m`
  if (/BUILD SUCCEEDED/i.test(line)) return `\x1b[32m${line}\x1b[0m`
  if (/^Build\s+/i.test(line)) return `\x1b[36m${line}\x1b[0m`
  return line
}

export interface BuildOutputFilters {
  errors: boolean
  warnings: boolean
  other: boolean
}
type BuildOutputCategory = keyof BuildOutputFilters
interface BuildTarget {
  fsPath?: string
  projectPath?: string
  groupPath?: string
  projectPaths?: string[]
}
interface BuildOverrides extends ProjectOverrides {
  msbuildProperties?: Record<string, string | number | boolean | undefined>
}
export interface RunProtocolMessage {
  type: "response" | "event"
  seq: number
  body: Record<string, unknown>
  request_seq?: number
  success?: boolean
  command?: string
  event?: string
}
class RunDebugAdapter {
  configuration
  sequence
  started
  finished
  process: ChildProcessByStdio<null, Readable, Readable> | undefined
  sendEmitter
  onDidSendMessage
  completed
  resolveCompleted: (value: number) => void = () => {}

  constructor(configuration: vscode.DebugConfiguration) {
    this.configuration = configuration
    this.sequence = 1
    this.started = false
    this.finished = false
    this.process = undefined
    this.sendEmitter = new vscode.EventEmitter<RunProtocolMessage>()
    this.onDidSendMessage = this.sendEmitter.event
    this.completed = new Promise<number>((resolve) => {
      this.resolveCompleted = resolve
    })
  }

  sendResponse(
    request: { seq: number; command: string },
    body: Record<string, unknown> = {},
  ) {
    this.sendEmitter.fire({
      type: "response",
      seq: this.sequence++,
      request_seq: request.seq,
      success: true,
      command: request.command,
      body,
    })
  }

  sendEvent(event: string, body: Record<string, unknown> = {}) {
    this.sendEmitter.fire({ type: "event", seq: this.sequence++, event, body })
  }

  handleMessage(value: unknown) {
    if (
      !isRecord(value) ||
      typeof value.seq !== "number" ||
      typeof value.command !== "string"
    )
      return
    const message = { seq: value.seq, command: value.command, type: value.type }
    if (message.type !== "request") return
    switch (message.command) {
      case "initialize":
        this.sendResponse(message, {
          supportsConfigurationDoneRequest: true,
          supportsTerminateRequest: true,
        })
        this.sendEvent("initialized")
        break
      case "launch":
        this.sendResponse(message)
        this.start()
        break
      case "setBreakpoints":
      case "setFunctionBreakpoints":
        this.sendResponse(message, { breakpoints: [] })
        break
      case "threads":
        this.sendResponse(message, { threads: [] })
        break
      case "disconnect":
      case "terminate":
        this.sendResponse(message)
        this.terminate()
        break
      default:
        this.sendResponse(message)
        break
    }
  }

  start() {
    if (this.started) return
    this.started = true
    const {
      program,
      args = [],
      cwd,
      env = {},
      displayName = path.basename(program),
    } = this.configuration
    this.sendEvent("output", {
      category: "console",
      output: `Run ${displayName}\n  ${program}${args.length ? ` ${args.join(" ")}` : ""}\n`,
    })
    try {
      const child = spawn(program, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      this.process = child
      const stdoutDecoder = new TextDecoder("utf-8")
      const stderrDecoder = new TextDecoder("utf-8")
      child.stdout.on("data", (chunk) => {
        const output = stdoutDecoder.decode(chunk, { stream: true })
        if (output) this.sendEvent("output", { category: "stdout", output })
      })
      child.stderr.on("data", (chunk) => {
        const output = stderrDecoder.decode(chunk, { stream: true })
        if (output) this.sendEvent("output", { category: "stderr", output })
      })
      child.once("error", (error) => {
        this.sendEvent("output", {
          category: "stderr",
          output: `[ERROR] ${error.message}\n`,
        })
        this.finish(1)
      })
      child.once("close", (code) => {
        const stdoutTail = stdoutDecoder.decode()
        const stderrTail = stderrDecoder.decode()
        if (stdoutTail)
          this.sendEvent("output", { category: "stdout", output: stdoutTail })
        if (stderrTail)
          this.sendEvent("output", { category: "stderr", output: stderrTail })
        this.finish(code ?? 1)
      })
    } catch (error) {
      this.sendEvent("output", {
        category: "stderr",
        output: `[ERROR] ${errorMessage(error)}\n`,
      })
      this.finish(1)
    }
  }

  finish(exitCode: number) {
    if (this.finished) return
    this.finished = true
    this.process = undefined
    this.sendEvent("output", {
      category: "console",
      output: `\nProcess exited with code ${exitCode}.\n`,
    })
    this.sendEvent("exited", { exitCode })
    this.sendEvent("terminated")
    this.resolveCompleted(exitCode)
  }

  terminate() {
    const child = this.process
    if (!child || child.killed) return this.finish(1)
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      })
      killer.on("error", () => child.kill())
    } else {
      child.kill("SIGTERM")
    }
  }

  dispose() {
    this.terminate()
    this.sendEmitter.dispose()
  }
}

class BuildTerminalSession {
  filters
  onClosed
  lines: string[]
  partial
  opened
  closed
  process: ChildProcessByStdio<null, Readable, Readable> | undefined
  runPrepared
  writeEmitter
  onDidWrite

  constructor(filters: BuildOutputFilters, onClosed?: () => void) {
    this.filters = { ...filters }
    this.onClosed = onClosed
    this.lines = []
    this.partial = ""
    this.opened = false
    this.closed = false
    this.process = undefined
    this.runPrepared = false
    this.writeEmitter = new vscode.EventEmitter<string>()
    this.onDidWrite = this.writeEmitter.event
  }

  open() {
    this.opened = true
    this.rerender()
  }

  close() {
    this.closed = true
    this.terminate()
    this.writeEmitter.dispose()
    this.onClosed?.()
  }

  handleInput(data: string) {
    if (data === "\x03") this.terminate()
  }

  setFilters(filters: { errors: boolean; warnings: boolean; other: boolean }) {
    this.filters = { ...filters }
    this.rerender()
  }

  visible(line: string) {
    return this.filters[buildOutputCategory(line)] !== false
  }

  emitLine(line: string) {
    const clean = String(line || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    this.lines.push(clean)
    if (!this.opened || !this.visible(clean)) return
    const category = buildOutputCategory(clean)
    this.writeEmitter.fire(`${colorBuildOutputLine(clean, category)}\r\n`)
  }

  acceptChunk(chunk: string | Uint8Array) {
    const text =
      this.partial +
      String(chunk || "")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n")
    const lines = text.split("\n")
    this.partial = lines.pop() || ""
    for (const line of lines) this.emitLine(line)
  }

  rerender() {
    if (!this.opened || this.closed) return
    const rendered = this.lines
      .filter((line) => this.visible(line))
      .map((line) => colorBuildOutputLine(line, buildOutputCategory(line)))
      .join("\r\n")
    this.writeEmitter.fire(
      `${CLEAR_ENTIRE_TERMINAL}${rendered}${rendered ? "\r\n" : ""}`,
    )
  }

  reset(filters: BuildOutputFilters) {
    this.filters = { ...filters }
    this.lines = []
    this.partial = ""
    this.rerender()
  }

  beginRun(filters: { errors: boolean; warnings: boolean; other: boolean }) {
    this.reset(filters)
    this.runPrepared = true
  }

  run(
    executable: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) {
    if (!this.runPrepared) this.reset(this.filters)
    this.runPrepared = false
    return new Promise<number>((resolve) => {
      let settled = false
      const finish = (code: number | null) => {
        if (settled) return
        settled = true
        if (this.partial) this.emitLine(this.partial)
        this.partial = ""
        this.process = undefined
        resolve(isInteger(code) ? code : 1)
      }
      try {
        const child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
        this.process = child
        child.stdout.on("data", (chunk) => this.acceptChunk(chunk))
        child.stderr.on("data", (chunk) => this.acceptChunk(chunk))
        child.on("error", (error) => {
          this.emitLine(`[ERROR] ${error.message}`)
          finish(1)
        })
        child.on("close", (code) => finish(code))
      } catch (error) {
        this.emitLine(`[ERROR] ${errorMessage(error)}`)
        finish(1)
      }
    })
  }

  terminate() {
    const child = this.process
    if (!child || child.killed) return
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      })
      killer.on("error", () => child.kill())
    } else {
      child.kill("SIGTERM")
    }
  }
}

function formatBuildDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 100) / 10)
  return `${seconds.toFixed(1)}s`
}

function resolvedBuildSelection(projectPath: string, selection: ProjectOverrides = {}) {
  const fallback = {
    configuration:
      selection.configuration && selection.configuration !== "auto"
        ? selection.configuration
        : "Debug",
    platform:
      selection.platform && selection.platform !== "auto"
        ? selection.platform
        : "Win32",
  }
  if (!projectPath) return fallback
  try {
    const properties = evaluateProjectProperties(
      fs.readFileSync(projectPath, "utf8"),
      selection,
    )
    return {
      configuration: properties.config || fallback.configuration,
      platform: properties.platform || fallback.platform,
    }
  } catch {
    return fallback
  }
}

function appendMsbuildProperties(
  args: string[],
  properties: BuildOverrides["msbuildProperties"] = {},
) {
  for (const [name, value] of Object.entries(properties || {})) {
    if (value === undefined || value === null || value === "") continue
    args.push(`/p:${name}=${value}`)
  }
  return args
}

function formalBuildEnvironment(
  environment: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === "dcc_unitsearchpath") delete result[name]
  }
  return result
}

function isInside(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function artifactTimestamp(descriptor: { output: fs.PathLike }) {
  try {
    return fs.statSync(descriptor.output).mtimeMs
  } catch {
    return 0
  }
}

class BuildDebugSupport {
  context: vscode.ExtensionContext
  output
  backgroundDiagnostics
  model
  projectNavigator
  queue: Promise<unknown>
  toolsPromise:
    | Promise<{
        installation: string
        environment: { [key: string]: string | undefined; TZ?: string }
        msbuild: string
        dcc32: string
        dcc64: string
      }>
    | undefined
  statusItems
  buildInProgress
  runInProgress
  runLaunchInProgress
  activeRunAdapter: RunDebugAdapter | undefined
  activeRunSession: vscode.DebugSession | undefined
  lastBuildResult: string | undefined
  buildTerminal: vscode.Terminal | undefined
  buildTerminalSession: BuildTerminalSession | undefined
  buildDiagnostics
  runAdapters

  constructor(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    backgroundDiagnostics: BackgroundDiagnostics,
  ) {
    this.context = context
    this.output = output
    this.backgroundDiagnostics = backgroundDiagnostics
    this.model = new DelphiProjectModel(
      context,
      output,
      (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath),
    )
    this.projectNavigator = new ProjectNavigatorProvider(this.model)
    this.queue = Promise.resolve()
    this.toolsPromise = undefined
    this.statusItems = {
      build: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 39),
      run: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 38),
      stop: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 38),
      platform: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 36),
      configuration: vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Left,
        35,
      ),
    }
    this.statusItems.build.name = "Pascal Atlas Build All"
    this.statusItems.build.command = CommandId.BuildBuildGroup
    this.statusItems.run.name = "Pascal Atlas Run"
    this.statusItems.run.command = CommandId.RunGroup
    this.statusItems.stop.name = "Pascal Atlas Stop"
    this.statusItems.platform.name = "Pascal Atlas Platform"
    this.statusItems.platform.command = CommandId.BuildSelectPlatform
    this.statusItems.configuration.name = "Pascal Atlas Build Configuration"
    this.statusItems.configuration.command = CommandId.BuildSelectConfiguration
    this.buildInProgress = false
    this.runInProgress = false
    this.runLaunchInProgress = false
    this.activeRunAdapter = undefined
    this.activeRunSession = undefined
    this.lastBuildResult = undefined
    this.buildTerminal = undefined
    this.buildTerminalSession = undefined
    this.buildDiagnostics =
      vscode.languages.createDiagnosticCollection("pascalAtlas.build")
    this.runAdapters = new Map<string, RunDebugAdapter>()
  }

  register() {
    this.model.restore()
    // The provider is constructed before cached project data is restored.
    // Publish that cache immediately so Reload Window does not leave the tree
    // empty while the background freshness scan is running.
    this.projectNavigator.refresh()
    this.updateContexts()
    this.updateBuildTerminalContext()
    this.refreshStatusBar()
    this.context.subscriptions.push(
      ...Object.values(this.statusItems),
      this.buildDiagnostics,
      this.projectNavigator,
      this.model.onDidChange(() => {
        this.updateContexts()
        this.projectNavigator.refresh()
        this.refreshStatusBar()
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatusBar()),
      vscode.window.onDidChangeActiveTerminal((terminal) =>
        this.updateBuildTerminalContext(terminal),
      ),
      vscode.window.onDidCloseTerminal((terminal) => {
        if (terminal !== this.buildTerminal) return
        this.buildTerminal = undefined
        this.buildTerminalSession = undefined
        this.updateBuildTerminalContext()
      }),
      vscode.tasks.registerTaskProvider("pascal-atlas", {
        provideTasks: () => this.provideTasks(),
        resolveTask: () => undefined,
      }),
      vscode.debug.onDidStartDebugSession((session) => {
        if (session.type === "pascal-atlas-run") this.activeRunSession = session
        this.refreshStatusBar()
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        if (session === this.activeRunSession) this.activeRunSession = undefined
        this.refreshStatusBar()
      }),
      vscode.debug.registerDebugAdapterDescriptorFactory("pascal-atlas-run", {
        createDebugAdapterDescriptor: (session) => {
          const adapter =
            this.runAdapters.get(session.configuration.runId) ||
            new RunDebugAdapter(session.configuration)
          return new vscode.DebugAdapterInlineImplementation(adapter)
        },
      }),
    )
    this.registerCommands()
    this.registerWatchers()
    void this.model
      .refresh()
      .catch((error) =>
        this.output.appendLine(
          `Delphi project model refresh failed: ${error.stack || error.message}`,
        ),
      )
  }

  updateContexts() {
    void vscode.commands.executeCommand(
      "setContext",
      "pascalAtlas.hasProjectGroups",
      this.model.groups.size > 0,
    )
  }

  updateBuildTerminalContext(terminal = vscode.window.activeTerminal) {
    void vscode.commands.executeCommand(
      "setContext",
      "pascalAtlas.buildTerminalActive",
      Boolean(this.buildTerminal && terminal === this.buildTerminal),
    )
  }

  registerWatchers() {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      for (const pattern of ["**/*.groupproj", "**/*.dproj", "**/*.dpk"]) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, pattern),
        )
        let timer: string | number | NodeJS.Timeout | undefined
        const changed = () => {
          clearTimeout(timer)
          timer = setTimeout(() => void this.model.refresh(), 250)
        }
        watcher.onDidCreate(changed)
        watcher.onDidChange(changed)
        watcher.onDidDelete(changed)
        this.context.subscriptions.push(watcher, { dispose: () => clearTimeout(timer) })
      }
    }
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pascalAtlas.projectNavigator"))
          this.projectNavigator.refresh()
        if (event.affectsConfiguration("pascalAtlas.build")) this.refreshStatusBar()
        if (event.affectsConfiguration("pascalAtlas.build.output"))
          this.refreshBuildTerminalFilters()
      }),
    )
  }

  statusGroup() {
    const groups = [...this.model.groups.values()]
    if (!groups.length) return undefined
    const activeFile =
      vscode.window.activeTextEditor?.document?.uri?.scheme === UriScheme.File
        ? vscode.window.activeTextEditor.document.uri.fsPath
        : ""
    if (activeFile) {
      const activeGroup = groups
        .filter((group) => isInside(group.groupDir, activeFile))
        .sort((left, right) => right.groupDir.length - left.groupDir.length)[0]
      if (activeGroup) return activeGroup
    }
    return groups[0]
  }

  refreshStatusBar() {
    const items = Object.values(this.statusItems)
    const group = this.statusGroup()
    const enabled = vscode.workspace
      .getConfiguration(ConfigurationSection)
      .get(SettingKey.BuildShowStatusBar, true)
    if (!enabled || !group) {
      for (const item of items) item.hide()
      return
    }
    const fallback = this.model.project(group.projectPaths[0]) || {}
    const selected = this.selection(group.groupDir, fallback)
    const resolved = resolvedBuildSelection(group.projectPaths[0], selected)
    const groupLabel = path.basename(group.groupPath)
    this.statusItems.build.text = this.buildInProgress
      ? "$(sync~spin) Building"
      : "$(tools) Build All"
    this.statusItems.build.tooltip =
      this.lastBuildResult || `Build entire project group: ${groupLabel}`
    const runActive = this.runInProgress || this.runLaunchInProgress
    this.statusItems.run.command = CommandId.RunGroup
    this.statusItems.run.text = this.runLaunchInProgress
      ? "$(sync~spin) Starting"
      : "$(run) Run"
    this.statusItems.run.tooltip = this.runInProgress
      ? "Startup project is running; program output is shown in the Debug Console"
      : this.runLaunchInProgress
        ? "Preparing to start the startup project"
        : `Run the startup project in ${groupLabel} without attaching the debugger`
    const debugActive = Boolean(
      vscode.debug.activeDebugSession &&
        vscode.debug.activeDebugSession.type !== "pascal-atlas-run",
    )
    const executionActive = this.runInProgress || debugActive
    this.statusItems.stop.text = "$(debug-stop) Stop"
    this.statusItems.stop.command = this.runInProgress
      ? CommandId.RunStop
      : "workbench.action.debug.stop"
    this.statusItems.stop.tooltip = this.runInProgress
      ? "Stop the current Run process (Shift+F5)"
      : "Stop the current Debug session (Shift+F5)"
    this.statusItems.platform.text = `$(device-desktop) ${resolved.platform}`
    this.statusItems.platform.tooltip = `Target platform: ${resolved.platform} (click to change)`
    this.statusItems.configuration.text = `$(symbol-enum) ${resolved.configuration}`
    this.statusItems.configuration.tooltip = `Build configuration: ${resolved.configuration} (click to change)`
    void vscode.commands.executeCommand(
      "setContext",
      "pascalAtlas.runInProgress",
      this.runInProgress,
    )
    void vscode.commands.executeCommand(
      "setContext",
      "pascalAtlas.executionBusy",
      Boolean(runActive || vscode.debug.activeDebugSession),
    )
    this.statusItems.build.show()
    this.statusItems.platform.show()
    this.statusItems.configuration.show()
    if (executionActive) {
      this.statusItems.run.hide()
      this.statusItems.stop.show()
    } else {
      this.statusItems.stop.hide()
      this.statusItems.run.show()
    }
  }

  registerCommands() {
    const command = (
      name: string,
      handler: (uri?: BuildTarget, selected?: BuildTarget[]) => unknown,
    ) => this.context.subscriptions.push(vscode.commands.registerCommand(name, handler))
    command(CommandId.BuildCompilePackage, (uri, selected) =>
      this.runPackageCommand("Make", uri, selected),
    )
    command(CommandId.BuildBuildPackage, (uri, selected) =>
      this.runPackageCommand("Build", uri, selected),
    )
    command(CommandId.BuildCleanPackage, (uri, selected) =>
      this.runPackageCommand("Clean", uri, selected),
    )
    command(CommandId.BuildCompileGroup, (uri) => this.runGroupCommand("Make", uri))
    command(CommandId.BuildBuildGroup, (uri) => this.runGroupCommand("Build", uri))
    command(CommandId.BuildCleanGroup, (uri) => this.runGroupCommand("Clean", uri))
    command(CommandId.BuildSelectConfiguration, (uri) =>
      this.selectBuildValue(uri, "configuration"),
    )
    command(CommandId.BuildSelectPlatform, (uri) =>
      this.selectBuildValue(uri, PascalKeyword.Platform),
    )
    command(CommandId.BuildSelectOutputFilters, () => this.selectBuildOutputFilters())
    command(CommandId.BuildToggleErrors, () => this.toggleBuildOutput("errors"))
    command(CommandId.BuildToggleWarnings, () => this.toggleBuildOutput("warnings"))
    command(CommandId.BuildToggleOther, () => this.toggleBuildOutput("other"))
    command(CommandId.BuildToggleErrorsChecked, () => this.toggleBuildOutput("errors"))
    command(CommandId.BuildToggleWarningsChecked, () =>
      this.toggleBuildOutput("warnings"),
    )
    command(CommandId.BuildToggleOtherChecked, () => this.toggleBuildOutput("other"))
    command(CommandId.RunSelectStartupProject, (uri) =>
      this.selectStartupProjectForUri(uri, true),
    )
    command(CommandId.RunGroup, (uri) => this.startRunCommand(uri))
    command(CommandId.RunStop, () => this.stopRun())
    command(CommandId.ProjectNavigatorActions, (uri) => this.showProjectActions(uri))
    command(CommandId.ProjectNavigatorRefresh, () => this.model.refresh())
  }

  executionBusyMessage() {
    if (this.runInProgress || this.runLaunchInProgress)
      return "A Run process is starting or already running. Stop it first."
    if (vscode.debug.activeDebugSession)
      return "A Debug session is already running. Stop it first."
    return ""
  }

  async startRunCommand(uri?: BuildTarget) {
    const busy = this.executionBusyMessage()
    if (busy) return void vscode.window.showInformationMessage(`Pascal Atlas：${busy}`)
    this.runLaunchInProgress = true
    this.refreshStatusBar()
    try {
      await this.runGroup(uri)
    } finally {
      this.runLaunchInProgress = false
      this.refreshStatusBar()
    }
  }

  async stopRun() {
    if (!this.runInProgress) return
    const session =
      this.activeRunSession ||
      (vscode.debug.activeDebugSession?.type === "pascal-atlas-run"
        ? vscode.debug.activeDebugSession
        : undefined)
    if (session) await vscode.debug.stopDebugging(session)
    else this.activeRunAdapter?.terminate()
  }

  buildOutputFilters() {
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection)
    return {
      errors: configuration.get(SettingKey.BuildOutputShowErrors, true),
      warnings: configuration.get(SettingKey.BuildOutputShowWarnings, true),
      other: configuration.get(SettingKey.BuildOutputShowOther, true),
    }
  }

  refreshBuildTerminalFilters() {
    this.buildTerminalSession?.setFilters(this.buildOutputFilters())
  }

  async toggleBuildOutput(category: BuildOutputCategory) {
    const keys = {
      errors: SettingKey.BuildOutputShowErrors,
      warnings: SettingKey.BuildOutputShowWarnings,
      other: SettingKey.BuildOutputShowOther,
    }
    const key = keys[category]
    if (!key) return
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection)
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global
    await configuration.update(key, !configuration.get(key, true), target)
    this.refreshBuildTerminalFilters()
  }

  selectBuildOutputFilters() {
    const filters = this.buildOutputFilters()
    const items: (vscode.QuickPickItem & { category: BuildOutputCategory })[] = [
      {
        category: "errors",
        label: "Errors",
        description: "Delphi fatal/error diagnostics",
      },
      {
        category: "warnings",
        label: "Warnings",
        description: "Delphi warning diagnostics",
      },
      {
        category: "other",
        label: "Other",
        description: "General output, build targets, and final summary",
      },
    ]
    const picker = vscode.window.createQuickPick<
      vscode.QuickPickItem & { category: BuildOutputCategory }
    >()
    picker.canSelectMany = true
    picker.title = "Pascal Atlas: Build Output"
    picker.placeholder =
      "Select the items to show. Changes take effect immediately; no confirmation needed."
    picker.items = items
    picker.selectedItems = items.filter((item) => filters[item.category])

    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global
    let current = { ...filters }
    let updateQueue = Promise.resolve()
    const disposables: vscode.Disposable[] = []

    disposables.push(
      picker.onDidChangeSelection((selection) => {
        const selected = new Set(selection.map((item) => item.category))
        const next: BuildOutputFilters = {
          errors: selected.has("errors"),
          warnings: selected.has("warnings"),
          other: selected.has("other"),
        }

        // Redraw first so checking a box feels immediate. Persist only the values
        // that changed, in order, so rapid clicks cannot restore an older state.
        this.buildTerminalSession?.setFilters(next)
        const changed = items.filter(
          (item) => current[item.category] !== next[item.category],
        )
        current = next
        if (!changed.length) return
        updateQueue = updateQueue
          .then(async () => {
            const configuration =
              vscode.workspace.getConfiguration(ConfigurationSection)
            for (const item of changed) {
              const suffix =
                item.category.charAt(0).toUpperCase() + item.category.slice(1)
              await configuration.update(
                `build.output.show${suffix}`,
                next[item.category],
                target,
              )
            }
          })
          .catch((error) => {
            console.error("Pascal Atlas: failed to persist build output filters", error)
          })
      }),
    )
    disposables.push(picker.onDidAccept(() => picker.hide()))
    disposables.push(
      picker.onDidHide(() => {
        for (const disposable of disposables) disposable.dispose()
        picker.dispose()
      }),
    )
    picker.show()
  }

  ensureBuildTerminal() {
    if (
      this.buildTerminal &&
      this.buildTerminalSession &&
      !this.buildTerminalSession.closed
    ) {
      return this.buildTerminalSession
    }
    const session = new BuildTerminalSession(this.buildOutputFilters(), () => {
      if (this.buildTerminalSession !== session) return
      this.buildTerminalSession = undefined
      this.buildTerminal = undefined
    })
    this.buildTerminalSession = session
    this.buildTerminal = vscode.window.createTerminal({
      name: "Pascal Atlas Build",
      pty: session,
    })
    this.updateBuildTerminalContext()
    return session
  }

  async loadBuildDiagnostics(diagnosticsPath: string, cwd: string | undefined) {
    let contents = ""
    try {
      contents = await fs.promises.readFile(diagnosticsPath, "utf8")
    } catch {
      return
    }
    const grouped = new Map()
    for (const line of contents.split(/\r?\n/)) {
      const item = parseBuildDiagnosticLine(line, cwd)
      if (!item) continue
      const uri = vscode.Uri.file(item.filePath)
      const key = uri.toString()
      const severity =
        item.severity === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : item.severity === "hint"
            ? vscode.DiagnosticSeverity.Hint
            : vscode.DiagnosticSeverity.Error
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(item.line, item.column, item.line, item.column + 1),
        item.message,
        severity,
      )
      diagnostic.source = "Pascal Atlas Build"
      if (item.code) diagnostic.code = item.code
      const entry = grouped.get(key) || { uri, diagnostics: [] }
      entry.diagnostics.push(diagnostic)
      grouped.set(key, entry)
    }
    this.buildDiagnostics.set(
      [...grouped.values()].map((entry) => [entry.uri, entry.diagnostics]),
    )
  }

  async showProjectActions(uri?: BuildTarget) {
    const group = this.groupFromTarget(uri) || (await this.pickGroup(uri?.fsPath || ""))
    if (!group)
      return void vscode.window.showWarningMessage(
        "There is no Delphi Project Group to operate on in the current workspace.",
      )
    const picked = await vscode.window.showQuickPick(
      [
        {
          label: "$(tools) Build All",
          description: group.name,
          action: () => this.runGroupCommand("Build", group),
        },
        {
          label: "$(run-all) Compile All",
          description: group.name,
          action: () => this.runGroupCommand("Make", group),
        },
        {
          label: "$(trash) Clean All",
          description: group.name,
          action: () => this.runGroupCommand("Clean", group),
        },
        {
          label: "$(run) Run",
          description: group.name,
          action: () => vscode.commands.executeCommand(CommandId.RunGroup, group),
        },
        {
          label: "$(list-selection) Select Startup Project",
          description: group.name,
          action: () => this.selectStartupProject(group, true),
        },
        {
          label: "$(settings-gear) Select Build Configuration",
          description: group.name,
          action: () =>
            this.selectBuildValue(vscode.Uri.file(group.groupDir), "configuration"),
        },
        {
          label: "$(symbol-enum) Select Build Platform",
          description: group.name,
          action: () =>
            this.selectBuildValue(
              vscode.Uri.file(group.groupDir),
              PascalKeyword.Platform,
            ),
        },
      ],
      {
        title: `Pascal Atlas：${group.name}`,
        placeHolder: "Select a project group action",
      },
    )
    if (picked) await picked.action()
  }

  async tools() {
    if (this.toolsPromise) return this.toolsPromise
    this.toolsPromise = Promise.resolve().then(() => {
      const installation = findDelphiInstallation()
      if (!installation)
        throw new Error("Delphi/RAD Studio command-line tools were not found.")
      const rsvars = path.join(installation, "bin", "rsvars.bat")
      const environment = readRsvarsEnvironment(rsvars)
      const frameworkDir =
        environment.FrameworkDir ||
        path.join(
          process.env.WINDIR || "C:\\Windows",
          "Microsoft.NET",
          "Framework",
          "v4.0.30319",
        )
      const msbuild =
        vscode.workspace
          .getConfiguration(ConfigurationSection)
          .get(SettingKey.BuildMsbuildPath, "") ||
        vscode.workspace.getConfiguration("vallenta.studio").get("msbuildPath", "") ||
        path.join(frameworkDir, "MSBuild.exe")
      return {
        installation,
        environment,
        msbuild,
        dcc32: path.join(installation, "bin", "dcc32.exe"),
        dcc64: fs.existsSync(path.join(installation, "bin64", "dcc64.exe"))
          ? path.join(installation, "bin64", "dcc64.exe")
          : path.join(installation, "bin", "dcc64.exe"),
      }
    })
    return this.toolsPromise
  }

  selectionKey(targetPath: string) {
    return normalizeKey(targetPath)
  }

  selection(targetPath: string, fallback: ProjectOverrides = {}) {
    const all = this.context.workspaceState.get<Record<string, ProjectOverrides>>(
      SELECTION_KEY,
      {},
    )
    const saved = all[this.selectionKey(targetPath)] || {}
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection)
    return {
      configuration:
        saved.configuration ||
        configuration.get(SettingKey.BuildConfiguration, "auto") ||
        fallback.configuration ||
        "auto",
      platform:
        saved.platform ||
        configuration.get(SettingKey.BuildPlatform, "auto") ||
        fallback.platform ||
        "auto",
    }
  }

  async selectBuildValue(
    uri: BuildTarget | undefined,
    kind: "configuration" | "platform",
  ) {
    const targetGroup =
      this.groupFromTarget(uri) || (!uri?.fsPath ? this.statusGroup() : undefined)
    const target =
      targetGroup?.groupDir ||
      uri?.fsPath ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!target) return
    const choices =
      kind === PascalKeyword.Platform
        ? ["auto", "Win32", "Win64"]
        : ["auto", "Debug", "Release"]
    const picked = await vscode.window.showQuickPick(choices, {
      placeHolder:
        kind === PascalKeyword.Platform
          ? "Select a Delphi target platform"
          : "Select a Delphi build configuration",
    })
    if (!picked) return
    const all = this.context.workspaceState.get<Record<string, ProjectOverrides>>(
      SELECTION_KEY,
      {},
    )
    const key = this.selectionKey(target)
    all[key] = { ...all[key], [kind]: picked }
    await this.context.workspaceState.update(SELECTION_KEY, all)
    this.refreshStatusBar()
  }

  uriDirectories(uri?: BuildTarget, selected?: BuildTarget[]) {
    const values = Array.isArray(selected) && selected.length ? selected : [uri]
    return uniquePaths(
      values
        .filter((value): value is BuildTarget => Boolean(value))
        .map((value) => value.fsPath),
    )
  }

  async pickPackage(directory: string) {
    const projects = this.model.packageProjects(directory)
    if (projects.length === 1) return projects[0]
    if (!projects.length) return undefined
    const picked = await vscode.window.showQuickPick(
      projects.map((project) => ({
        label: project.name,
        description: project.projectPath,
        project,
      })),
      { placeHolder: "Select a Delphi package to process" },
    )
    return picked?.project
  }

  async pickGroup(directory: string) {
    const groups = directory
      ? this.model.groupsAt(directory)
      : [...this.model.groups.values()]
    if (groups.length === 1) return groups[0]
    if (!groups.length) return undefined
    const picked = await vscode.window.showQuickPick(
      groups.map((group) => ({
        label: group.name,
        description: group.groupPath,
        group,
      })),
      { placeHolder: "Select a Delphi Project Group" },
    )
    return picked?.group
  }

  projectFromTarget(target: BuildTarget | undefined) {
    if (!target?.projectPath) return undefined
    return (
      this.model.project(target.projectPath) ||
      minimalProjectDescriptor(target.projectPath)
    )
  }

  groupFromTarget(target: BuildTarget | undefined) {
    if (!target?.groupPath) return undefined
    return this.model.groups.get(normalizeKey(target.groupPath))
  }

  groupForProject(projectPath: string) {
    const key = normalizeKey(projectPath)
    return [...this.model.groups.values()].find((group) =>
      group.projectPaths.some((item) => normalizeKey(item) === key),
    )
  }

  async runPackageCommand(target: string, uri?: BuildTarget, selected?: BuildTarget[]) {
    const exactProject = this.projectFromTarget(uri)
    if (exactProject) {
      await this.enqueue(() => this.buildProject(exactProject, target))
      return
    }
    const directories = this.uriDirectories(uri, selected)
    const projects = []
    for (const directory of directories) {
      const project = await this.pickPackage(directory)
      if (project) projects.push(project)
    }
    if (!projects.length)
      return void vscode.window.showWarningMessage(
        "The selected directory is not a recognized Delphi package root.",
      )
    projects.sort((left, right) => {
      const group = this.groupForProject(left.projectPath)
      if (!group || group !== this.groupForProject(right.projectPath))
        return left.projectPath.localeCompare(right.projectPath)
      return (
        group.projectPaths.findIndex(
          (item) => normalizeKey(item) === normalizeKey(left.projectPath),
        ) -
        group.projectPaths.findIndex(
          (item) => normalizeKey(item) === normalizeKey(right.projectPath),
        )
      )
    })
    for (const project of projects) {
      const result = await this.enqueue(() => this.buildProject(project, target))
      if (result !== 0) break
    }
  }

  async runGroupCommand(target: string, uri?: BuildTarget) {
    if (Array.isArray(uri?.projectPaths) && !uri.groupPath) {
      for (const projectPath of uri.projectPaths) {
        const project =
          this.model.project(projectPath) || minimalProjectDescriptor(projectPath)
        const result = await this.enqueue(() => this.buildProject(project, target))
        if (
          result !== 0 &&
          vscode.workspace
            .getConfiguration(ConfigurationSection)
            .get(SettingKey.BuildStopGroupOnFailure, true)
        )
          break
      }
      return
    }
    const group = this.groupFromTarget(uri) || (await this.pickGroup(uri?.fsPath || ""))
    if (!group)
      return void vscode.window.showWarningMessage(
        "The selected directory is not a recognized Delphi Project Group root.",
      )
    await this.enqueue(() => this.buildGroup(group, target))
  }

  enqueue<T>(action: () => T | PromiseLike<T>) {
    const run = this.queue.then(action, action)
    this.queue = run.catch(() => undefined)
    return run
  }

  async saveForProjects(projectPaths: string[]) {
    if (
      !vscode.workspace
        .getConfiguration(ConfigurationSection)
        .get(SettingKey.BuildSaveBeforeBuild, true)
    )
      return true
    const roots = projectPaths.map((projectPath) => path.dirname(projectPath))
    const projectFiles = new Set(projectPaths.map(normalizeKey))
    for (const projectPath of projectPaths) {
      try {
        const info = readProjectInfo(projectPath)
        for (const filePath of [info.mainSource, ...info.references].filter(Boolean))
          projectFiles.add(normalizeKey(filePath || ""))
      } catch {}
    }
    const documents = vscode.workspace.textDocuments.filter(
      (document) =>
        document.isDirty &&
        document.uri.scheme === UriScheme.File &&
        (projectFiles.has(normalizeKey(document.fileName)) ||
          roots.some((root) => isInside(root, document.fileName))),
    )
    const results = await Promise.all(documents.map((document) => document.save()))
    if (results.some((result) => !result)) {
      void vscode.window.showErrorMessage(
        "Some Delphi source files could not be saved. The build was cancelled.",
      )
      return false
    }
    return true
  }

  async buildProject(
    project: ProjectDescriptor,
    target: string,
    overrides: BuildOverrides = {},
  ) {
    if (
      !vscode.workspace
        .getConfiguration(ConfigurationSection)
        .get(SettingKey.BuildEnabled, true)
    ) {
      void vscode.window.showWarningMessage(
        "Pascal Atlas production builds are disabled in settings.",
      )
      return 1
    }
    if (!(await this.saveForProjects([project.projectPath]))) return 1
    const tools = await this.tools().catch((error) => {
      void vscode.window.showErrorMessage(`Pascal Atlas：${error.message}`)
      return undefined
    })
    if (!tools) return 1
    const selected = { ...this.selection(project.projectDir), ...overrides }
    const descriptor = projectDescriptor(
      project.projectPath,
      selected,
      tools.environment,
    )
    const args = [
      descriptor.projectPath,
      "/nologo",
      "/v:minimal",
      `/t:${target}`,
      `/p:Config=${descriptor.configuration}`,
      `/p:Platform=${descriptor.platform}`,
    ]
    appendMsbuildProperties(args, overrides.msbuildProperties)
    return this.executeBuild(
      `${target} ${descriptor.name}`,
      tools.msbuild,
      args,
      descriptor.projectDir,
      tools.environment,
    )
  }

  async buildGroup(
    group: GroupDescriptor,
    target: string,
    overrides: BuildOverrides = {},
  ) {
    if (
      !vscode.workspace
        .getConfiguration(ConfigurationSection)
        .get(SettingKey.BuildEnabled, true)
    ) {
      void vscode.window.showWarningMessage(
        "Pascal Atlas production builds are disabled in settings.",
      )
      return 1
    }
    if (
      !vscode.workspace
        .getConfiguration(ConfigurationSection)
        .get(SettingKey.BuildStopGroupOnFailure, true)
    ) {
      let finalExitCode = 0
      for (const projectPath of group.projectPaths) {
        const project =
          this.model.project(projectPath) || minimalProjectDescriptor(projectPath)
        const exitCode = await this.buildProject(project, target, overrides)
        if (exitCode !== 0) finalExitCode = exitCode
      }
      return finalExitCode
    }
    if (!(await this.saveForProjects(group.projectPaths))) return 1
    const tools = await this.tools().catch((error) => {
      void vscode.window.showErrorMessage(`Pascal Atlas：${error.message}`)
      return undefined
    })
    if (!tools) return 1
    const fallback = this.model.project(group.projectPaths[0]) || {}
    const selected = { ...this.selection(group.groupDir, fallback), ...overrides }
    const args = [group.groupPath, "/nologo", "/v:minimal", `/t:${target}`]
    if (selected.configuration !== "auto")
      args.push(`/p:Config=${selected.configuration}`)
    if (selected.platform !== "auto") args.push(`/p:Platform=${selected.platform}`)
    appendMsbuildProperties(args, overrides.msbuildProperties)
    return this.executeBuild(
      `${target} ${group.name}`,
      tools.msbuild,
      args,
      group.groupDir,
      tools.environment,
    )
  }

  async executeBuild(
    label: string,
    executable: string,
    args: string[],
    cwd: string,
    environment: NodeJS.ProcessEnv | undefined,
  ) {
    if (!fs.existsSync(executable)) {
      void vscode.window.showErrorMessage(
        `Pascal Atlas: Build tool not found: ${executable}`,
      )
      return 1
    }
    this.backgroundDiagnostics?.suspendCompiler?.("foreground build")
    this.buildInProgress = true
    this.lastBuildResult = undefined
    this.refreshStatusBar()
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))
    const configuration = vscode.workspace.getConfiguration(ConfigurationSection)
    const terminalSummary = configuration.get(SettingKey.BuildTerminalSummary, true)
    const powershell = path.join(
      process.env.SystemRoot || process.env.WINDIR || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    )
    const runnerPath = path.join(
      this.context.extensionPath,
      "resources",
      "pascal-atlas-build-runner.ps1",
    )
    const useRunner = fs.existsSync(powershell) && fs.existsSync(runnerPath)
    const preparedTerminalSession = useRunner ? this.ensureBuildTerminal() : undefined
    if (preparedTerminalSession) {
      preparedTerminalSession.beginRun(this.buildOutputFilters())
      this.buildTerminal?.show(true)
    }
    const resultDirectory = this.context.globalStorageUri.fsPath
    if (useRunner) await fs.promises.mkdir(resultDirectory, { recursive: true })
    const resultPath = useRunner
      ? path.join(
          resultDirectory,
          `build-result-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
        )
      : ""
    const diagnosticsPath = useRunner
      ? path.join(
          resultDirectory,
          `build-diagnostics-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
        )
      : ""
    this.buildDiagnostics.clear()
    const buildEnvironment = formalBuildEnvironment(environment)
    const executionEnvironment = useRunner
      ? {
          ...buildEnvironment,
          PASCAL_ATLAS_BUILD_TOOL: executable,
          PASCAL_ATLAS_BUILD_ARGS: Buffer.from(JSON.stringify(args), "utf8").toString(
            "base64",
          ),
          PASCAL_ATLAS_BUILD_LABEL: label,
          PASCAL_ATLAS_BUILD_RESULT: resultPath,
          PASCAL_ATLAS_BUILD_DIAGNOSTICS: diagnosticsPath,
          PASCAL_ATLAS_BUILD_SUMMARY: String(terminalSummary),
        }
      : buildEnvironment
    this.output.appendLine(`Foreground build: ${executable} ${args.join(" ")}`)
    const startedAt = Date.now()
    try {
      const timeoutSeconds = vscode.workspace
        .getConfiguration(ConfigurationSection)
        .get(SettingKey.BuildTimeoutSeconds, 1800)
      let taskExitCode
      if (useRunner) {
        const session = preparedTerminalSession
        if (!session) throw new Error("Missing build terminal session")
        session.setFilters(this.buildOutputFilters())
        let timeout
        taskExitCode = await Promise.race([
          session.run(
            powershell,
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-File",
              runnerPath,
            ],
            { cwd, env: executionEnvironment },
          ),
          new Promise<number>((resolve) => {
            timeout = setTimeout(() => {
              session.emitLine("[ERROR] Build timed out and was terminated.")
              session.terminate()
              resolve(1)
            }, timeoutSeconds * 1000)
          }),
        ])
        clearTimeout(timeout)
      } else {
        const processExecution = new vscode.ProcessExecution(executable, args, {
          cwd,
          env: buildEnvironment,
        })
        const task = new vscode.Task(
          { type: "pascal-atlas", label },
          folder || vscode.TaskScope.Workspace,
          label,
          "Pascal Atlas",
          processExecution,
          ["$pascalAtlasDelphi", "$pascalAtlasDelphiClassic"],
        )
        task.group = vscode.TaskGroup.Build
        task.presentationOptions = {
          reveal: vscode.TaskRevealKind.Always,
          panel: vscode.TaskPanelKind.Dedicated,
          clear: true,
          focus: false,
          echo: false,
          showReuseMessage: false,
        }
        const execution = await vscode.tasks.executeTask(task)
        taskExitCode = await new Promise<number>((resolve) => {
          const timeout = setTimeout(() => {
            execution.terminate()
            resolve(1)
          }, timeoutSeconds * 1000)
          const disposable = vscode.tasks.onDidEndTaskProcess((event) => {
            if (event.execution !== execution) return
            clearTimeout(timeout)
            disposable.dispose()
            resolve(event.exitCode ?? 1)
          })
        })
      }
      let exitCode = taskExitCode
      if (useRunner) {
        try {
          const recorded = Number.parseInt(
            await fs.promises.readFile(resultPath, "ascii"),
            10,
          )
          if (isInteger(recorded)) exitCode = recorded
        } catch {
          if (taskExitCode === 0) exitCode = 1
        } finally {
          void fs.promises.unlink(resultPath).catch(() => undefined)
        }
        await this.loadBuildDiagnostics(diagnosticsPath, cwd)
        void fs.promises.unlink(diagnosticsPath).catch(() => undefined)
      }
      const duration = formatBuildDuration(Date.now() - startedAt)
      const succeeded = exitCode === 0
      this.lastBuildResult = `${label}: ${succeeded ? "succeeded" : "failed"}; exit code ${exitCode}; duration ${duration}`
      this.output.appendLine(
        `${label}: ${succeeded ? "BUILD SUCCEEDED" : "BUILD FAILED"} (exit ${exitCode}, ${duration}).`,
      )
      if (configuration.get(SettingKey.BuildCompletionNotification, true)) {
        if (succeeded)
          void vscode.window.showInformationMessage(
            `Pascal Atlas: ${label} build succeeded in ${duration}.`,
          )
        else
          void vscode.window.showErrorMessage(
            `Pascal Atlas: ${label} build failed with exit code ${exitCode} in ${duration}.`,
          )
      }
      return exitCode
    } finally {
      this.buildInProgress = false
      this.refreshStatusBar()
      this.backgroundDiagnostics?.resumeCompiler?.("foreground build")
    }
  }

  async detailedProject(projectPath: string, overrides: ProjectOverrides = {}) {
    const tools = await this.tools()
    const minimal = this.model.project(projectPath)
    const selected = {
      ...this.selection(minimal?.projectDir || path.dirname(projectPath)),
      ...overrides,
    }
    const cache = this.context.workspaceState.get<
      Record<string, { signature: string; descriptor: DetailedProjectDescriptor }>
    >(DETAILS_KEY, {})
    const key = `${normalizeKey(projectPath)}|${selected.configuration}|${selected.platform}`
    const signature = `${statSignature(projectPath)}|${minimal?.mainSource ? statSignature(minimal.mainSource) : ""}`
    if (cache[key]?.signature === signature) return cache[key].descriptor
    const descriptor = projectDescriptor(projectPath, selected, tools.environment)
    cache[key] = { signature, descriptor }
    const entries = Object.entries(cache)
    if (entries.length > 256) {
      for (const [oldKey] of entries.slice(0, entries.length - 256))
        delete cache[oldKey]
    }
    await this.context.workspaceState.update(DETAILS_KEY, cache)
    return descriptor
  }

  async selectStartupProject(group: GroupDescriptor, force = false) {
    const saved = this.context.workspaceState.get<Record<string, string>>(
      STARTUP_KEY,
      {},
    )
    const key = normalizeKey(group.groupPath)
    const candidates = group.projectPaths
      .map((projectPath) => this.model.project(projectPath))
      .filter(
        (project): project is ProjectDescriptor => project?.kind === "application",
      )
    if (!force) {
      const existing = candidates.find(
        (project) =>
          normalizeKey(project.projectPath) === normalizeKey(saved[key] || ""),
      )
      if (existing) return existing
    }
    const picked = await vscode.window.showQuickPick(
      candidates.map((project) => ({
        label: project.name,
        description: project.projectPath,
        project,
      })),
      { placeHolder: "Select the startup project for this Project Group" },
    )
    if (!picked) return undefined
    saved[key] = picked.project.projectPath
    await this.context.workspaceState.update(STARTUP_KEY, saved)
    return picked.project
  }

  async selectStartupProjectForUri(uri: BuildTarget | undefined, force?: boolean) {
    const group = this.groupFromTarget(uri) || (await this.pickGroup(uri?.fsPath || ""))
    if (group) await this.selectStartupProject(group, force)
  }

  shouldBuildBeforeRun(descriptors: DetailedProjectDescriptor[]) {
    const mode = vscode.workspace
      .getConfiguration(ConfigurationSection)
      .get<string>(SettingKey.RunBuildBeforeRun, "ifOutdated")
    if (mode === "always") return true
    if (mode === "never") return false
    return descriptors.some((descriptor) => {
      const outputTime = artifactTimestamp(descriptor)
      if (!outputTime) return true
      return uniquePaths([
        descriptor.projectPath,
        descriptor.mainSource,
        ...(descriptor.references || []),
      ]).some((filePath) => {
        try {
          return fs.statSync(filePath).mtimeMs > outputTime
        } catch {
          return false
        }
      })
    })
  }

  async runGroup(uri?: BuildTarget) {
    if (this.runInProgress) {
      return void vscode.window.showInformationMessage(
        "Pascal Atlas: A Run process is already running.",
      )
    }
    const group = this.groupFromTarget(uri) || (await this.pickGroup(uri?.fsPath || ""))
    if (!group)
      return void vscode.window.showWarningMessage(
        "There is no runnable Delphi Project Group in the current workspace.",
      )
    const startup = await this.selectStartupProject(group, false)
    if (!startup) return
    const fallback = this.model.project(group.projectPaths[0]) || {}
    const selected = this.selection(group.groupDir, fallback)
    let descriptors = []
    for (const projectPath of group.projectPaths) {
      try {
        descriptors.push(await this.detailedProject(projectPath, selected))
      } catch (error) {
        this.output.appendLine(
          `Run project description failed (${projectPath}): ${errorMessage(error)}`,
        )
      }
    }
    if (this.shouldBuildBeforeRun(descriptors)) {
      const exitCode = await this.enqueue(() =>
        this.buildGroup(group, "Build", selected),
      )
      if (exitCode !== 0) return
      descriptors = []
      for (const projectPath of group.projectPaths) {
        try {
          descriptors.push(await this.detailedProject(projectPath, selected))
        } catch (error) {
          this.output.appendLine(
            `Run project description failed (${projectPath}): ${errorMessage(error)}`,
          )
        }
      }
    }
    const descriptor = descriptors.find(
      (item) => normalizeKey(item.projectPath) === normalizeKey(startup.projectPath),
    )
    if (!descriptor || !fs.existsSync(descriptor.output)) {
      return void vscode.window.showErrorMessage(
        `Startup project output does not exist: ${descriptor?.output || startup.projectPath}`,
      )
    }
    const tools = await this.tools().catch(() => undefined)
    const args = parseCommandLine(descriptor.runParams)
    this.output.appendLine(
      `Run without debugging: ${descriptor.output} ${args.join(" ")}`,
    )
    this.runInProgress = true
    this.refreshStatusBar()
    try {
      await this.runInDebugConsole(descriptor, args, tools?.environment || {})
    } catch (error) {
      void vscode.window.showErrorMessage(
        `Pascal Atlas: Run failed: ${errorMessage(error)}`,
      )
    } finally {
      this.runInProgress = false
      this.refreshStatusBar()
    }
  }

  async runInDebugConsole(
    descriptor: DetailedProjectDescriptor,
    args: string[],
    environment: NodeJS.ProcessEnv,
  ) {
    const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const configuration = {
      type: "pascal-atlas-run",
      request: "launch",
      name: `Run ${descriptor.name}`,
      displayName: descriptor.name,
      program: descriptor.output,
      args,
      cwd: descriptor.projectDir,
      env: environment,
      runId,
      noDebug: true,
      internalConsoleOptions: "openOnSessionStart",
    }
    const adapter = new RunDebugAdapter(configuration)
    this.activeRunAdapter = adapter
    this.runAdapters.set(runId, adapter)
    const folder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.file(descriptor.projectPath),
    )
    const started = await vscode.debug.startDebugging(folder, configuration, {
      noDebug: true,
      suppressDebugToolbar: true,
      suppressDebugView: true,
    })
    if (!started) {
      this.runAdapters.delete(runId)
      if (this.activeRunAdapter === adapter) this.activeRunAdapter = undefined
      adapter.dispose()
      throw new Error("Could not start the internal Run session.")
    }
    await vscode.commands.executeCommand("workbench.debug.action.focusRepl")
    const exitCode = await adapter.completed
    this.runAdapters.delete(runId)
    if (this.activeRunAdapter === adapter) this.activeRunAdapter = undefined
    this.output.appendLine(
      `Run ${descriptor.name}: process exited with code ${exitCode}.`,
    )
  }

  async provideTasks() {
    const tools = await this.tools().catch(() => undefined)
    if (!tools) return []
    const tasks = []
    for (const group of this.model.groups.values()) {
      for (const target of ["Make", "Build"]) {
        const selected = this.selection(group.groupDir)
        const args = [group.groupPath, "/nologo", "/v:minimal", `/t:${target}`]
        if (selected.configuration !== "auto")
          args.push(`/p:Config=${selected.configuration}`)
        if (selected.platform !== "auto") args.push(`/p:Platform=${selected.platform}`)
        const folder = vscode.workspace.getWorkspaceFolder(
          vscode.Uri.file(group.groupPath),
        )
        const task = new vscode.Task(
          { type: "pascal-atlas", target, group: group.groupPath },
          folder || vscode.TaskScope.Workspace,
          `${target} ${group.name}`,
          "Pascal Atlas",
          new vscode.ProcessExecution(tools.msbuild, args, {
            cwd: group.groupDir,
            env: formalBuildEnvironment(tools.environment),
          }),
          ["$pascalAtlasDelphi", "$pascalAtlasDelphiClassic"],
        )
        task.group = vscode.TaskGroup.Build
        tasks.push(task)
      }
    }
    return tasks
  }
}

export {
  BuildTerminalSession,
  BuildDebugSupport,
  DETAILS_KEY,
  SELECTION_KEY,
  STARTUP_KEY,
  artifactTimestamp,
  appendMsbuildProperties,
  formalBuildEnvironment,
  formatBuildDuration,
  buildOutputCategory,
  parseBuildDiagnosticLine,
  resolvedBuildSelection,
  parseCommandLine,
}
