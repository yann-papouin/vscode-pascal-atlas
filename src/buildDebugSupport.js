'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { findDelphiInstallation, readRsvarsEnvironment } = require('./backgroundDiagnostics');
const { normalizeKey } = require('./projectDiscovery');
const {
  DelphiProjectModel,
  minimalProjectDescriptor,
  projectDescriptor,
  statSignature
} = require('./delphiProjectModel');
const { evaluateProjectProperties, readProjectInfo } = require('./diagnosticCore');
const { debuggerNeedsBundledUpgrade, installRequiredExtension } = require('./dependencySupport');
const { ProjectNavigatorProvider } = require('./projectNavigator');

const STARTUP_KEY = 'pascalUnion.debug.groupStartupProjects';
const HOST_KEY = 'pascalUnion.debug.packageHosts';
const SELECTION_KEY = 'pascalUnion.build.selections';
const DETAILS_KEY = 'pascalUnion.delphiProjectDetails.v1';
const DEBUGGER_ID = 'mca-software.delphi-debugger';
const LEGACY_DEBUGGER_ID = 'local.delphi-win64-debug';
// CSI 2 J clears the visible viewport; CSI 3 J also drops xterm's scrollback.
// Both are needed when a filter changes, otherwise hidden lines remain visible
// after the user scrolls upward even though the current viewport was redrawn.
const CLEAR_ENTIRE_TERMINAL = '\x1b[2J\x1b[3J\x1b[H';

function uniquePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values.filter(Boolean)) {
    const resolved = path.resolve(value);
    const key = normalizeKey(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}

function parseCommandLine(value) {
  const result = [];
  for (const match of String(value || '').matchAll(/"((?:\\"|[^"])*)"|'((?:''|[^'])*)'|([^\s]+)/g)) {
    result.push((match[1] ?? match[2] ?? match[3]).replace(/\\"/g, '"').replace(/''/g, "'"));
  }
  return result;
}

function parseBuildDiagnosticLine(value, cwd = '') {
  let line = String(value || '').trim();
  line = line.replace(/^\[(?:ERROR|WARN)\]\s+/, '');
  line = line.replace(/\s+\[[^\]]+\.dproj\]\s*$/i, '');

  let match = /^\[dcc\w*\s+(fatal error|fatal|error|warning|hint)\]\s+(.+?)\((\d+)(?:,(\d+))?\):\s*([FEWH]\d{4})?\s*:?[ \t]*(.*)$/i.exec(line);
  let severity;
  let fileName;
  let lineNumber;
  let columnNumber;
  let code;
  let message;
  if (match) {
    [, severity, fileName, lineNumber, columnNumber, code, message] = match;
  } else {
    match = /^(.+?)\((\d+)(?:,(\d+))?\)\s*:\s*(?:(fatal error|fatal|error|warning|hint)\s+)?([FEWH]\d{4})?\s*:?[ \t]*(.*)$/i.exec(line);
    if (!match || (!match[4] && !match[5])) return undefined;
    [, fileName, lineNumber, columnNumber, severity, code, message] = match;
  }

  const severityText = String(severity || '').toLowerCase();
  const codePrefix = String(code || '').charAt(0).toUpperCase();
  const kind = severityText.includes('warning') || codePrefix === 'W'
    ? 'warning'
    : severityText.includes('hint') || codePrefix === 'H'
      ? 'hint'
      : 'error';
  const cleanFileName = String(fileName || '').trim().replace(/^"|"$/g, '');
  return {
    filePath: path.isAbsolute(cleanFileName) ? cleanFileName : path.resolve(cwd || '.', cleanFileName),
    line: Math.max(0, Number.parseInt(lineNumber, 10) - 1),
    column: Math.max(0, Number.parseInt(columnNumber || '1', 10) - 1),
    severity: kind,
    code: code || undefined,
    message: String(message || '').trim()
  };
}

function buildOutputCategory(line) {
  if (/^\s*\[ERROR\]/i.test(line)) return 'errors';
  if (/^\s*\[WARN\]/i.test(line)) return 'warnings';
  return 'other';
}

function colorBuildOutputLine(line, category) {
  if (category === 'errors' || /BUILD FAILED/i.test(line)) return `\x1b[31m${line}\x1b[0m`;
  if (category === 'warnings') return `\x1b[33m${line}\x1b[0m`;
  if (/BUILD SUCCEEDED/i.test(line)) return `\x1b[32m${line}\x1b[0m`;
  if (/^Build\s+/i.test(line)) return `\x1b[36m${line}\x1b[0m`;
  return line;
}

function processOutputDecoder() {
  try { return new TextDecoder('gbk'); }
  catch { return new TextDecoder('utf-8'); }
}

class RunDebugAdapter {
  constructor(configuration) {
    this.configuration = configuration;
    this.sequence = 1;
    this.started = false;
    this.finished = false;
    this.process = undefined;
    this.sendEmitter = new vscode.EventEmitter();
    this.onDidSendMessage = this.sendEmitter.event;
    this.completed = new Promise(resolve => { this.resolveCompleted = resolve; });
  }

  sendResponse(request, body = {}) {
    this.sendEmitter.fire({
      type: 'response',
      seq: this.sequence++,
      request_seq: request.seq,
      success: true,
      command: request.command,
      body
    });
  }

  sendEvent(event, body = {}) {
    this.sendEmitter.fire({ type: 'event', seq: this.sequence++, event, body });
  }

  handleMessage(message) {
    if (message.type !== 'request') return;
    switch (message.command) {
      case 'initialize':
        this.sendResponse(message, { supportsConfigurationDoneRequest: true, supportsTerminateRequest: true });
        this.sendEvent('initialized');
        break;
      case 'launch':
        this.sendResponse(message);
        this.start();
        break;
      case 'setBreakpoints':
      case 'setFunctionBreakpoints':
        this.sendResponse(message, { breakpoints: [] });
        break;
      case 'threads':
        this.sendResponse(message, { threads: [] });
        break;
      case 'disconnect':
      case 'terminate':
        this.sendResponse(message);
        this.terminate();
        break;
      default:
        this.sendResponse(message);
        break;
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    const { program, args = [], cwd, env = {}, displayName = path.basename(program) } = this.configuration;
    this.sendEvent('output', { category: 'console', output: `Run ${displayName}\n  ${program}${args.length ? ` ${args.join(' ')}` : ''}\n` });
    try {
      const child = spawn(program, args, {
        cwd,
        env: { ...process.env, ...env },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.process = child;
      const stdoutDecoder = processOutputDecoder();
      const stderrDecoder = processOutputDecoder();
      child.stdout.on('data', chunk => {
        const output = stdoutDecoder.decode(chunk, { stream: true });
        if (output) this.sendEvent('output', { category: 'stdout', output });
      });
      child.stderr.on('data', chunk => {
        const output = stderrDecoder.decode(chunk, { stream: true });
        if (output) this.sendEvent('output', { category: 'stderr', output });
      });
      child.once('error', error => {
        this.sendEvent('output', { category: 'stderr', output: `[ERROR] ${error.message}\n` });
        this.finish(1);
      });
      child.once('close', code => {
        const stdoutTail = stdoutDecoder.decode();
        const stderrTail = stderrDecoder.decode();
        if (stdoutTail) this.sendEvent('output', { category: 'stdout', output: stdoutTail });
        if (stderrTail) this.sendEvent('output', { category: 'stderr', output: stderrTail });
        this.finish(code ?? 1);
      });
    } catch (error) {
      this.sendEvent('output', { category: 'stderr', output: `[ERROR] ${error.message}\n` });
      this.finish(1);
    }
  }

  finish(exitCode) {
    if (this.finished) return;
    this.finished = true;
    this.process = undefined;
    this.sendEvent('output', { category: 'console', output: `\nProcess exited with code ${exitCode}.\n` });
    this.sendEvent('exited', { exitCode });
    this.sendEvent('terminated');
    this.resolveCompleted(exitCode);
  }

  terminate() {
    const child = this.process;
    if (!child || child.killed) return this.finish(1);
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      child.kill('SIGTERM');
    }
  }

  dispose() {
    this.terminate();
    this.sendEmitter.dispose();
  }
}

class BuildTerminalSession {
  constructor(filters, onClosed) {
    this.filters = { ...filters };
    this.onClosed = onClosed;
    this.lines = [];
    this.partial = '';
    this.opened = false;
    this.closed = false;
    this.process = undefined;
    this.runPrepared = false;
    this.writeEmitter = new vscode.EventEmitter();
    this.onDidWrite = this.writeEmitter.event;
  }

  open() {
    this.opened = true;
    this.rerender();
  }

  close() {
    this.closed = true;
    this.terminate();
    this.writeEmitter.dispose();
    this.onClosed?.();
  }

  handleInput(data) {
    if (data === '\x03') this.terminate();
  }

  setFilters(filters) {
    this.filters = { ...filters };
    this.rerender();
  }

  visible(line) {
    return this.filters[buildOutputCategory(line)] !== false;
  }

  emitLine(line) {
    const clean = String(line || '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
    this.lines.push(clean);
    if (!this.opened || !this.visible(clean)) return;
    const category = buildOutputCategory(clean);
    this.writeEmitter.fire(`${colorBuildOutputLine(clean, category)}\r\n`);
  }

  acceptChunk(chunk) {
    const text = this.partial + String(chunk || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const lines = text.split('\n');
    this.partial = lines.pop() || '';
    for (const line of lines) this.emitLine(line);
  }

  rerender() {
    if (!this.opened || this.closed) return;
    const rendered = this.lines
      .filter(line => this.visible(line))
      .map(line => colorBuildOutputLine(line, buildOutputCategory(line)))
      .join('\r\n');
    this.writeEmitter.fire(`${CLEAR_ENTIRE_TERMINAL}${rendered}${rendered ? '\r\n' : ''}`);
  }

  reset(filters) {
    this.filters = { ...filters };
    this.lines = [];
    this.partial = '';
    this.rerender();
  }

  beginRun(filters) {
    this.reset(filters);
    this.runPrepared = true;
  }

  run(executable, args, options) {
    if (!this.runPrepared) this.reset(this.filters);
    this.runPrepared = false;
    return new Promise(resolve => {
      let settled = false;
      const finish = code => {
        if (settled) return;
        settled = true;
        if (this.partial) this.emitLine(this.partial);
        this.partial = '';
        this.process = undefined;
        resolve(Number.isInteger(code) ? code : 1);
      };
      try {
        const child = spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        });
        this.process = child;
        child.stdout.on('data', chunk => this.acceptChunk(chunk));
        child.stderr.on('data', chunk => this.acceptChunk(chunk));
        child.on('error', error => {
          this.emitLine(`[ERROR] ${error.message}`);
          finish(1);
        });
        child.on('close', code => finish(code));
      } catch (error) {
        this.emitLine(`[ERROR] ${error.message}`);
        finish(1);
      }
    });
  }

  terminate() {
    const child = this.process;
    if (!child || child.killed) return;
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      killer.on('error', () => child.kill());
    } else {
      child.kill('SIGTERM');
    }
  }
}

function debugOutputConfiguration(configuration, request = 'launch') {
  const programConsole = configuration.get('debugger.programConsole', 'external');
  const captureOutput = request === 'launch' && programConsole === 'debugConsole';
  const externalConsole = request === 'launch' && programConsole === 'external';
  return {
    captureOutput,
    externalConsole,
    internalConsoleOptions: captureOutput && configuration.get('debugger.revealOutputOnStart', true)
      ? 'openOnSessionStart'
      : 'neverOpen'
  };
}

function formatBuildDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 100) / 10);
  return `${seconds.toFixed(1)}s`;
}

function resolvedBuildSelection(projectPath, selection = {}) {
  const fallback = {
    configuration: selection.configuration && selection.configuration !== 'auto' ? selection.configuration : 'Debug',
    platform: selection.platform && selection.platform !== 'auto' ? selection.platform : 'Win32'
  };
  if (!projectPath) return fallback;
  try {
    const properties = evaluateProjectProperties(fs.readFileSync(projectPath, 'utf8'), selection);
    return {
      configuration: properties.config || fallback.configuration,
      platform: properties.platform || fallback.platform
    };
  } catch {
    return fallback;
  }
}

function debugMsbuildProperties() {
  return {
    DCC_MapFile: 3,
    DCC_Optimize: false,
    DCC_GenerateStackFrames: true,
    DCC_DebugInfoInExe: true,
    DCC_LocalDebugSymbols: true,
    DCC_SymbolReferenceInfo: 2
  };
}

function appendMsbuildProperties(args, properties = {}) {
  for (const [name, value] of Object.entries(properties || {})) {
    if (value === undefined || value === null || value === '') continue;
    args.push(`/p:${name}=${value}`);
  }
  return args;
}

function formalBuildEnvironment(environment = {}) {
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (name.toLowerCase() === 'dcc_unitsearchpath') delete result[name];
  }
  return result;
}

function supportsPlatform(project, platform) {
  const mask = Number(project?.targetedPlatforms || project?.properties?.targetedplatforms || 0);
  if (!mask || !platform || platform === 'auto') return true;
  if (platform === 'Win32') return Boolean(mask & 1);
  if (platform === 'Win64') return Boolean(mask & 2);
  return true;
}

function compatiblePlatform(projects, requested) {
  if (!requested || requested === 'auto' || projects.every(project => supportsPlatform(project, requested))) {
    return requested || 'auto';
  }
  for (const candidate of ['Win32', 'Win64']) {
    if (projects.every(project => supportsPlatform(project, candidate))) return candidate;
  }
  return requested;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function artifactTimestamp(descriptor) {
  try { return fs.statSync(descriptor.output).mtimeMs; } catch { return 0; }
}

function peMetadataFromBuffer(buffer) {
  if (buffer.length < 64 || buffer.readUInt16LE(0) !== 0x5A4D) return undefined;
  const pe = buffer.readUInt32LE(0x3C);
  if (pe + 24 > buffer.length || buffer.toString('ascii', pe, pe + 4) !== 'PE\0\0') return undefined;
  const machineValue = buffer.readUInt16LE(pe + 4);
  const machine = machineValue === 0x014C ? 'Win32'
    : machineValue === 0x8664 ? 'Win64'
      : `0x${machineValue.toString(16)}`;
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const optionalHeaderSize = buffer.readUInt16LE(pe + 20);
  const sectionTable = pe + 24 + optionalHeaderSize;
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionTable + index * 40;
    if (offset + 40 > buffer.length) break;
    sections.push(buffer.subarray(offset, offset + 8).toString('ascii').replace(/\0.*$/, ''));
  }
  return { machine, sections };
}

function readPeMetadata(filePath) {
  try {
    const buffer = Buffer.alloc(65536);
    const handle = fs.openSync(filePath, 'r');
    const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
    fs.closeSync(handle);
    return peMetadataFromBuffer(buffer.subarray(0, count));
  } catch {
    return undefined;
  }
}

function peMachine(filePath) {
  return readPeMetadata(filePath)?.machine;
}

function hasEmbeddedTd32(filePath) {
  return readPeMetadata(filePath)?.sections.some(section => section.toLowerCase() === '.debug') || false;
}

class BuildDebugSupport {
  constructor(context, output, backgroundDiagnostics) {
    this.context = context;
    this.output = output;
    this.backgroundDiagnostics = backgroundDiagnostics;
    this.model = new DelphiProjectModel(
      context,
      output,
      (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath)
    );
    this.projectNavigator = new ProjectNavigatorProvider(this.model);
    this.queue = Promise.resolve();
    this.toolsPromise = undefined;
    this.statusItems = {
      build: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 39),
      run: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 38),
      stop: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 38),
      debug: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 37),
      platform: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 36),
      configuration: vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 35)
    };
    this.statusItems.build.name = 'Pascal Union Build All';
    this.statusItems.build.command = 'pascalUnion.build.buildGroup';
    this.statusItems.run.name = 'Pascal Union Run';
    this.statusItems.run.command = 'pascalUnion.run.group';
    this.statusItems.stop.name = 'Pascal Union Stop';
    this.statusItems.debug.name = 'Pascal Union Debug';
    this.statusItems.debug.command = 'pascalUnion.debug.buildAndDebugGroup';
    this.statusItems.platform.name = 'Pascal Union Platform';
    this.statusItems.platform.command = 'pascalUnion.build.selectPlatform';
    this.statusItems.configuration.name = 'Pascal Union Build Configuration';
    this.statusItems.configuration.command = 'pascalUnion.build.selectConfiguration';
    this.buildInProgress = false;
    this.runInProgress = false;
    this.runLaunchInProgress = false;
    this.debugLaunchInProgress = false;
    this.activeRunAdapter = undefined;
    this.activeRunSession = undefined;
    this.lastBuildResult = undefined;
    this.buildTerminal = undefined;
    this.buildTerminalSession = undefined;
    this.buildDiagnostics = vscode.languages.createDiagnosticCollection('pascalUnion.build');
    this.runAdapters = new Map();
  }

  register() {
    this.model.restore();
    // The provider is constructed before cached project data is restored.
    // Publish that cache immediately so Reload Window does not leave the tree
    // empty while the background freshness scan is running.
    this.projectNavigator.refresh();
    this.updateContexts();
    this.updateBuildTerminalContext();
    this.refreshStatusBar();
    this.context.subscriptions.push(
      ...Object.values(this.statusItems),
      this.buildDiagnostics,
      this.projectNavigator,
      this.model.onDidChange(() => {
        this.updateContexts();
        this.projectNavigator.refresh();
        this.refreshStatusBar();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshStatusBar()),
      vscode.window.onDidChangeActiveTerminal(terminal => this.updateBuildTerminalContext(terminal)),
      vscode.window.onDidCloseTerminal(terminal => {
        if (terminal !== this.buildTerminal) return;
        this.buildTerminal = undefined;
        this.buildTerminalSession = undefined;
        this.updateBuildTerminalContext();
      }),
      vscode.tasks.registerTaskProvider('pascal-union', {
        provideTasks: () => this.provideTasks(),
        resolveTask: () => undefined
      }),
      vscode.debug.registerDebugConfigurationProvider('delphi', {
        provideDebugConfigurations: folder => this.provideDebugConfigurations(folder)
      }),
      vscode.debug.onDidStartDebugSession(session => {
        if (session.type === 'pascal-union-run') this.activeRunSession = session;
        this.refreshStatusBar();
      }),
      vscode.debug.onDidTerminateDebugSession(session => {
        if (session === this.activeRunSession) this.activeRunSession = undefined;
        this.refreshStatusBar();
      }),
      vscode.debug.registerDebugAdapterDescriptorFactory('pascal-union-run', {
        createDebugAdapterDescriptor: session => {
          const adapter = this.runAdapters.get(session.configuration.runId)
            || new RunDebugAdapter(session.configuration);
          return new vscode.DebugAdapterInlineImplementation(adapter);
        }
      })
    );
    this.registerCommands();
    this.registerWatchers();
    void this.model.refresh().catch(error => this.output.appendLine(`Delphi project model refresh failed: ${error.stack || error.message}`));
  }

  updateContexts() {
    void vscode.commands.executeCommand('setContext', 'pascalUnion.hasProjectGroups', this.model.groups.size > 0);
  }

  updateBuildTerminalContext(terminal = vscode.window.activeTerminal) {
    void vscode.commands.executeCommand(
      'setContext',
      'pascalUnion.buildTerminalActive',
      Boolean(this.buildTerminal && terminal === this.buildTerminal)
    );
  }

  registerWatchers() {
    for (const folder of vscode.workspace.workspaceFolders || []) {
      for (const pattern of ['**/*.groupproj', '**/*.dproj', '**/*.dpk']) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
        let timer;
        const changed = () => {
          clearTimeout(timer);
          timer = setTimeout(() => void this.model.refresh(), 250);
        };
        watcher.onDidCreate(changed);
        watcher.onDidChange(changed);
        watcher.onDidDelete(changed);
        this.context.subscriptions.push(watcher, { dispose: () => clearTimeout(timer) });
      }
    }
    this.context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('pascalUnion.projectNavigator')) this.projectNavigator.refresh();
      if (event.affectsConfiguration('pascalUnion.build')) this.refreshStatusBar();
      if (event.affectsConfiguration('pascalUnion.build.output')) this.refreshBuildTerminalFilters();
    }));
  }

  statusGroup() {
    const groups = [...this.model.groups.values()];
    if (!groups.length) return undefined;
    const activeFile = vscode.window.activeTextEditor?.document?.uri?.scheme === 'file'
      ? vscode.window.activeTextEditor.document.uri.fsPath
      : '';
    if (activeFile) {
      const activeGroup = groups.filter(group => isInside(group.groupDir, activeFile))
        .sort((left, right) => right.groupDir.length - left.groupDir.length)[0];
      if (activeGroup) return activeGroup;
    }
    return groups[0];
  }

  refreshStatusBar() {
    const items = Object.values(this.statusItems);
    const group = this.statusGroup();
    const enabled = vscode.workspace.getConfiguration('pascalUnion').get('build.showStatusBar', true);
    if (!enabled || !group) {
      for (const item of items) item.hide();
      return;
    }
    const fallback = this.model.project(group.projectPaths[0]) || {};
    const selected = this.selection(group.groupDir, fallback);
    const resolved = resolvedBuildSelection(group.projectPaths[0], selected);
    const groupLabel = path.basename(group.groupPath);
    this.statusItems.build.text = this.buildInProgress ? '$(sync~spin) Building' : '$(tools) Build All';
    this.statusItems.build.tooltip = this.lastBuildResult || `构建整个工程组：${groupLabel}`;
    const runActive = this.runInProgress || this.runLaunchInProgress;
    this.statusItems.run.command = 'pascalUnion.run.group';
    this.statusItems.run.text = this.runLaunchInProgress
        ? '$(sync~spin) Starting'
        : '$(run) Run';
    this.statusItems.run.tooltip = this.runInProgress
      ? '启动工程正在运行；程序输出显示在 Debug Console'
      : this.runLaunchInProgress
        ? '正在准备启动工程'
      : `不附加调试器运行 ${groupLabel} 的启动工程`;
    const debugActive = Boolean(vscode.debug.activeDebugSession
      && vscode.debug.activeDebugSession.type !== 'pascal-union-run');
    this.statusItems.debug.command = debugActive
      ? 'workbench.action.debug.stop'
      : 'pascalUnion.debug.buildAndDebugGroup';
    this.statusItems.debug.text = debugActive
      ? '$(debug-stop) Stop'
      : this.debugLaunchInProgress
        ? '$(sync~spin) Starting'
        : '$(debug-start) Debug';
    this.statusItems.debug.tooltip = debugActive
      ? 'Delphi 调试正在运行；点击停止（Shift+F5）'
      : this.debugLaunchInProgress
        ? '正在准备 Delphi 调试会话'
        : `以 Delphi 调试器启动 ${groupLabel}`;
    const executionActive = this.runInProgress || debugActive;
    this.statusItems.stop.text = '$(debug-stop) Stop';
    this.statusItems.stop.command = this.runInProgress
      ? 'pascalUnion.run.stop'
      : 'workbench.action.debug.stop';
    this.statusItems.stop.tooltip = this.runInProgress
      ? '停止当前 Run 进程（Shift+F5）'
      : '停止当前 Debug 会话（Shift+F5）';
    this.statusItems.platform.text = `$(device-desktop) ${resolved.platform}`;
    this.statusItems.platform.tooltip = `目标平台：${resolved.platform}（点击切换）`;
    this.statusItems.configuration.text = `$(symbol-enum) ${resolved.configuration}`;
    this.statusItems.configuration.tooltip = `构建模式：${resolved.configuration}（点击切换）`;
    void vscode.commands.executeCommand('setContext', 'pascalUnion.runInProgress', this.runInProgress);
    void vscode.commands.executeCommand('setContext', 'pascalUnion.executionBusy', Boolean(
      runActive || this.debugLaunchInProgress || vscode.debug.activeDebugSession
    ));
    this.statusItems.build.show();
    this.statusItems.platform.show();
    this.statusItems.configuration.show();
    if (executionActive) {
      this.statusItems.run.hide();
      this.statusItems.debug.hide();
      this.statusItems.stop.show();
    } else {
      this.statusItems.stop.hide();
      this.statusItems.run.show();
      this.statusItems.debug.show();
    }
  }

  registerCommands() {
    const command = (name, handler) => this.context.subscriptions.push(vscode.commands.registerCommand(name, handler));
    command('pascalUnion.build.compilePackage', (uri, selected) => this.runPackageCommand('Make', uri, selected));
    command('pascalUnion.build.buildPackage', (uri, selected) => this.runPackageCommand('Build', uri, selected));
    command('pascalUnion.build.cleanPackage', (uri, selected) => this.runPackageCommand('Clean', uri, selected));
    command('pascalUnion.build.compileGroup', uri => this.runGroupCommand('Make', uri));
    command('pascalUnion.build.buildGroup', uri => this.runGroupCommand('Build', uri));
    command('pascalUnion.build.cleanGroup', uri => this.runGroupCommand('Clean', uri));
    command('pascalUnion.build.selectConfiguration', uri => this.selectBuildValue(uri, 'configuration'));
    command('pascalUnion.build.selectPlatform', uri => this.selectBuildValue(uri, 'platform'));
    command('pascalUnion.build.selectOutputFilters', () => this.selectBuildOutputFilters());
    command('pascalUnion.build.toggleErrors', () => this.toggleBuildOutput('errors'));
    command('pascalUnion.build.toggleWarnings', () => this.toggleBuildOutput('warnings'));
    command('pascalUnion.build.toggleOther', () => this.toggleBuildOutput('other'));
    command('pascalUnion.build.toggleErrorsChecked', () => this.toggleBuildOutput('errors'));
    command('pascalUnion.build.toggleWarningsChecked', () => this.toggleBuildOutput('warnings'));
    command('pascalUnion.build.toggleOtherChecked', () => this.toggleBuildOutput('other'));
    command('pascalUnion.debug.selectStartupProject', uri => this.selectStartupProjectForUri(uri, true));
    command('pascalUnion.debug.debugPackage', uri => this.startDebugCommand(() => this.debugPackage(uri)));
    command('pascalUnion.debug.attachPackage', uri => this.startDebugCommand(() => this.attachPackage(uri)));
    command('pascalUnion.debug.buildAndDebugGroup', uri => this.startDebugCommand(() => this.buildAndDebugGroup(uri)));
    command('pascalUnion.run.group', uri => this.startRunCommand(uri));
    command('pascalUnion.run.stop', () => this.stopRun());
    command('pascalUnion.projectNavigator.actions', uri => this.showProjectActions(uri));
    command('pascalUnion.projectNavigator.refresh', () => this.model.refresh());
  }

  executionBusyMessage() {
    if (this.runInProgress || this.runLaunchInProgress) return '已有一个 Run 正在启动或运行，请先停止。';
    if (this.debugLaunchInProgress) return '已有一个 Debug 正在准备启动。';
    if (vscode.debug.activeDebugSession) return '已有一个 Debug 会话正在运行，请先停止。';
    return '';
  }

  async startRunCommand(uri) {
    const busy = this.executionBusyMessage();
    if (busy) return void vscode.window.showInformationMessage(`Pascal Union：${busy}`);
    this.runLaunchInProgress = true;
    this.refreshStatusBar();
    try {
      await this.runGroup(uri);
    } finally {
      this.runLaunchInProgress = false;
      this.refreshStatusBar();
    }
  }

  async startDebugCommand(action) {
    const busy = this.executionBusyMessage();
    if (busy) return void vscode.window.showInformationMessage(`Pascal Union：${busy}`);
    this.debugLaunchInProgress = true;
    this.refreshStatusBar();
    try {
      await action();
    } finally {
      this.debugLaunchInProgress = false;
      this.refreshStatusBar();
    }
  }

  async stopRun() {
    if (!this.runInProgress) return;
    const session = this.activeRunSession
      || (vscode.debug.activeDebugSession?.type === 'pascal-union-run' ? vscode.debug.activeDebugSession : undefined);
    if (session) await vscode.debug.stopDebugging(session);
    else this.activeRunAdapter?.terminate();
  }

  buildOutputFilters() {
    const configuration = vscode.workspace.getConfiguration('pascalUnion');
    return {
      errors: configuration.get('build.output.showErrors', true),
      warnings: configuration.get('build.output.showWarnings', true),
      other: configuration.get('build.output.showOther', true)
    };
  }

  refreshBuildTerminalFilters() {
    this.buildTerminalSession?.setFilters(this.buildOutputFilters());
  }

  async toggleBuildOutput(category) {
    const keys = {
      errors: 'build.output.showErrors',
      warnings: 'build.output.showWarnings',
      other: 'build.output.showOther'
    };
    const key = keys[category];
    if (!key) return;
    const configuration = vscode.workspace.getConfiguration('pascalUnion');
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    await configuration.update(key, !configuration.get(key, true), target);
    this.refreshBuildTerminalFilters();
  }

  selectBuildOutputFilters() {
    const filters = this.buildOutputFilters();
    const items = [
      { category: 'errors', label: '错误', description: 'Delphi fatal/error 诊断' },
      { category: 'warnings', label: '警告', description: 'Delphi warning 诊断' },
      { category: 'other', label: '其他', description: '普通输出、构建目标和最终统计' }
    ];
    const picker = vscode.window.createQuickPick();
    picker.canSelectMany = true;
    picker.title = 'Pascal Union：构建输出';
    picker.placeholder = '直接勾选要显示的内容，修改立即生效；无需确认';
    picker.items = items;
    picker.selectedItems = items.filter(item => filters[item.category]);

    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    let current = { ...filters };
    let updateQueue = Promise.resolve();
    const disposables = [];

    disposables.push(picker.onDidChangeSelection(selection => {
      const selected = new Set(selection.map(item => item.category));
      const next = Object.fromEntries(items.map(item => [item.category, selected.has(item.category)]));

      // Redraw first so checking a box feels immediate. Persist only the values
      // that changed, in order, so rapid clicks cannot restore an older state.
      this.buildTerminalSession?.setFilters(next);
      const changed = items.filter(item => current[item.category] !== next[item.category]);
      current = next;
      if (!changed.length) return;
      updateQueue = updateQueue.then(async () => {
        const configuration = vscode.workspace.getConfiguration('pascalUnion');
        for (const item of changed) {
          const suffix = item.category.charAt(0).toUpperCase() + item.category.slice(1);
          await configuration.update(`build.output.show${suffix}`, next[item.category], target);
        }
      }).catch(error => {
        console.error('Pascal Union: failed to persist build output filters', error);
      });
    }));
    disposables.push(picker.onDidAccept(() => picker.hide()));
    disposables.push(picker.onDidHide(() => {
      for (const disposable of disposables) disposable.dispose();
      picker.dispose();
    }));
    picker.show();
  }

  ensureBuildTerminal() {
    if (this.buildTerminal && this.buildTerminalSession && !this.buildTerminalSession.closed) {
      return this.buildTerminalSession;
    }
    const session = new BuildTerminalSession(this.buildOutputFilters(), () => {
      if (this.buildTerminalSession !== session) return;
      this.buildTerminalSession = undefined;
      this.buildTerminal = undefined;
    });
    this.buildTerminalSession = session;
    this.buildTerminal = vscode.window.createTerminal({ name: 'Pascal Union Build', pty: session });
    this.updateBuildTerminalContext();
    return session;
  }

  async loadBuildDiagnostics(diagnosticsPath, cwd) {
    let contents = '';
    try {
      contents = await fs.promises.readFile(diagnosticsPath, 'utf8');
    } catch {
      return;
    }
    const grouped = new Map();
    for (const line of contents.split(/\r?\n/)) {
      const item = parseBuildDiagnosticLine(line, cwd);
      if (!item) continue;
      const uri = vscode.Uri.file(item.filePath);
      const key = uri.toString();
      const severity = item.severity === 'warning'
        ? vscode.DiagnosticSeverity.Warning
        : item.severity === 'hint'
          ? vscode.DiagnosticSeverity.Hint
          : vscode.DiagnosticSeverity.Error;
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(item.line, item.column, item.line, item.column + 1),
        item.message,
        severity
      );
      diagnostic.source = 'Pascal Union Build';
      if (item.code) diagnostic.code = item.code;
      const entry = grouped.get(key) || { uri, diagnostics: [] };
      entry.diagnostics.push(diagnostic);
      grouped.set(key, entry);
    }
    this.buildDiagnostics.set([...grouped.values()].map(entry => [entry.uri, entry.diagnostics]));
  }

  async showProjectActions(uri) {
    const group = this.groupFromTarget(uri) || await this.pickGroup(uri?.fsPath || '');
    if (!group) return void vscode.window.showWarningMessage('当前工作区没有可操作的 Delphi Project Group。');
    const picked = await vscode.window.showQuickPick([
      { label: '$(tools) Build All', description: group.name, action: () => this.runGroupCommand('Build', group) },
      { label: '$(run-all) Compile All', description: group.name, action: () => this.runGroupCommand('Make', group) },
      { label: '$(trash) Clean All', description: group.name, action: () => this.runGroupCommand('Clean', group) },
      { label: '$(run) Run', description: group.name, action: () => vscode.commands.executeCommand('pascalUnion.run.group', group) },
      { label: '$(debug-start) Debug', description: group.name, action: () => vscode.commands.executeCommand('pascalUnion.debug.buildAndDebugGroup', group) },
      { label: '$(list-selection) Select Startup Project', description: group.name, action: () => this.selectStartupProject(group, true) },
      { label: '$(settings-gear) Select Build Configuration', description: group.name, action: () => this.selectBuildValue(vscode.Uri.file(group.groupDir), 'configuration') },
      { label: '$(symbol-enum) Select Build Platform', description: group.name, action: () => this.selectBuildValue(vscode.Uri.file(group.groupDir), 'platform') }
    ], {
      title: `Pascal Union：${group.name}`,
      placeHolder: '选择工程组操作'
    });
    if (picked) await picked.action();
  }

  async tools() {
    if (this.toolsPromise) return this.toolsPromise;
    this.toolsPromise = Promise.resolve().then(() => {
      const installation = findDelphiInstallation();
      if (!installation) throw new Error('未找到 Delphi/RAD Studio 命令行工具链。');
      const rsvars = path.join(installation, 'bin', 'rsvars.bat');
      const environment = readRsvarsEnvironment(rsvars);
      const frameworkDir = environment.FrameworkDir
        || path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319');
      const msbuild = vscode.workspace.getConfiguration('pascalUnion').get('build.msbuildPath', '')
        || vscode.workspace.getConfiguration('vallenta.studio').get('msbuildPath', '')
        || path.join(frameworkDir, 'MSBuild.exe');
      return {
        installation,
        environment,
        msbuild,
        dcc32: path.join(installation, 'bin', 'dcc32.exe'),
        dcc64: fs.existsSync(path.join(installation, 'bin64', 'dcc64.exe'))
          ? path.join(installation, 'bin64', 'dcc64.exe')
          : path.join(installation, 'bin', 'dcc64.exe')
      };
    });
    return this.toolsPromise;
  }

  selectionKey(targetPath) {
    return normalizeKey(targetPath);
  }

  selection(targetPath, fallback = {}) {
    const all = this.context.workspaceState.get(SELECTION_KEY, {});
    const saved = all[this.selectionKey(targetPath)] || {};
    const configuration = vscode.workspace.getConfiguration('pascalUnion');
    return {
      configuration: saved.configuration || configuration.get('build.configuration', 'auto') || fallback.configuration || 'auto',
      platform: saved.platform || configuration.get('build.platform', 'auto') || fallback.platform || 'auto'
    };
  }

  async selectBuildValue(uri, kind) {
    const targetGroup = this.groupFromTarget(uri) || (!uri?.fsPath ? this.statusGroup() : undefined);
    const target = targetGroup?.groupDir || uri?.fsPath || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!target) return;
    const choices = kind === 'platform' ? ['auto', 'Win32', 'Win64'] : ['auto', 'Debug', 'Release'];
    const picked = await vscode.window.showQuickPick(choices, { placeHolder: kind === 'platform' ? '选择 Delphi 目标平台' : '选择 Delphi 构建配置' });
    if (!picked) return;
    const all = this.context.workspaceState.get(SELECTION_KEY, {});
    const key = this.selectionKey(target);
    all[key] = { ...(all[key] || {}), [kind]: picked };
    await this.context.workspaceState.update(SELECTION_KEY, all);
    this.refreshStatusBar();
  }

  uriDirectories(uri, selected) {
    const values = Array.isArray(selected) && selected.length ? selected : [uri];
    return uniquePaths(values.filter(Boolean).map(value => value.fsPath));
  }

  async pickPackage(directory) {
    const projects = this.model.packageProjects(directory);
    if (projects.length === 1) return projects[0];
    if (!projects.length) return undefined;
    const picked = await vscode.window.showQuickPick(projects.map(project => ({ label: project.name, description: project.projectPath, project })), { placeHolder: '选择要处理的 Delphi 包' });
    return picked?.project;
  }

  async pickGroup(directory) {
    const groups = directory ? this.model.groupsAt(directory) : [...this.model.groups.values()];
    if (groups.length === 1) return groups[0];
    if (!groups.length) return undefined;
    const picked = await vscode.window.showQuickPick(groups.map(group => ({ label: group.name, description: group.groupPath, group })), { placeHolder: '选择 Delphi Project Group' });
    return picked?.group;
  }

  projectFromTarget(target) {
    if (!target?.projectPath) return undefined;
    return this.model.project(target.projectPath) || minimalProjectDescriptor(target.projectPath);
  }

  groupFromTarget(target) {
    if (!target?.groupPath) return undefined;
    return this.model.groups.get(normalizeKey(target.groupPath));
  }

  groupForProject(projectPath) {
    const key = normalizeKey(projectPath);
    return [...this.model.groups.values()].find(group => group.projectPaths.some(item => normalizeKey(item) === key));
  }

  async runPackageCommand(target, uri, selected) {
    const exactProject = this.projectFromTarget(uri);
    if (exactProject) {
      await this.enqueue(() => this.buildProject(exactProject, target));
      return;
    }
    const directories = this.uriDirectories(uri, selected);
    const projects = [];
    for (const directory of directories) {
      const project = await this.pickPackage(directory);
      if (project) projects.push(project);
    }
    if (!projects.length) return void vscode.window.showWarningMessage('所选目录不是 Pascal Union 已识别的 Delphi 包根。');
    projects.sort((left, right) => {
      const group = this.groupForProject(left.projectPath);
      if (!group || group !== this.groupForProject(right.projectPath)) return left.projectPath.localeCompare(right.projectPath);
      return group.projectPaths.findIndex(item => normalizeKey(item) === normalizeKey(left.projectPath))
        - group.projectPaths.findIndex(item => normalizeKey(item) === normalizeKey(right.projectPath));
    });
    for (const project of projects) {
      const result = await this.enqueue(() => this.buildProject(project, target));
      if (result !== 0) break;
    }
  }

  async runGroupCommand(target, uri) {
    if (Array.isArray(uri?.projectPaths) && !uri.groupPath) {
      for (const projectPath of uri.projectPaths) {
        const project = this.model.project(projectPath) || minimalProjectDescriptor(projectPath);
        const result = await this.enqueue(() => this.buildProject(project, target));
        if (result !== 0 && vscode.workspace.getConfiguration('pascalUnion').get('build.stopGroupOnFailure', true)) break;
      }
      return;
    }
    const group = this.groupFromTarget(uri) || await this.pickGroup(uri?.fsPath || '');
    if (!group) return void vscode.window.showWarningMessage('所选目录不是 Pascal Union 已识别的 Delphi Project Group 根目录。');
    await this.enqueue(() => this.buildGroup(group, target));
  }

  enqueue(action) {
    const run = this.queue.then(action, action);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async saveForProjects(projectPaths) {
    if (!vscode.workspace.getConfiguration('pascalUnion').get('build.saveBeforeBuild', true)) return true;
    const roots = projectPaths.map(projectPath => path.dirname(projectPath));
    const projectFiles = new Set(projectPaths.map(normalizeKey));
    for (const projectPath of projectPaths) {
      try {
        const info = readProjectInfo(projectPath);
        for (const filePath of [info.mainSource, ...info.references].filter(Boolean)) projectFiles.add(normalizeKey(filePath));
      } catch {}
    }
    const documents = vscode.workspace.textDocuments.filter(document => document.isDirty
      && document.uri.scheme === 'file'
      && (projectFiles.has(normalizeKey(document.fileName)) || roots.some(root => isInside(root, document.fileName))));
    const results = await Promise.all(documents.map(document => document.save()));
    if (results.some(result => !result)) {
      void vscode.window.showErrorMessage('存在无法保存的 Delphi 源文件，构建已取消。');
      return false;
    }
    return true;
  }

  async buildProject(project, target, overrides = {}) {
    if (!vscode.workspace.getConfiguration('pascalUnion').get('build.enabled', true)) {
      void vscode.window.showWarningMessage('Pascal Union 正式编译已在设置中关闭。');
      return 1;
    }
    if (!await this.saveForProjects([project.projectPath])) return 1;
    const tools = await this.tools().catch(error => {
      void vscode.window.showErrorMessage(`Pascal Union：${error.message}`);
      return undefined;
    });
    if (!tools) return 1;
    const selected = { ...this.selection(project.projectDir), ...overrides };
    const descriptor = projectDescriptor(project.projectPath, selected, tools.environment);
    const args = [
      descriptor.projectPath,
      '/nologo',
      '/v:minimal',
      `/t:${target}`,
      `/p:Config=${descriptor.configuration}`,
      `/p:Platform=${descriptor.platform}`
    ];
    appendMsbuildProperties(args, overrides.msbuildProperties);
    return this.executeBuild(`${target} ${descriptor.name}`, tools.msbuild, args, descriptor.projectDir, tools.environment);
  }

  async buildGroup(group, target, overrides = {}) {
    if (!vscode.workspace.getConfiguration('pascalUnion').get('build.enabled', true)) {
      void vscode.window.showWarningMessage('Pascal Union 正式编译已在设置中关闭。');
      return 1;
    }
    if (!vscode.workspace.getConfiguration('pascalUnion').get('build.stopGroupOnFailure', true)) {
      let finalExitCode = 0;
      for (const projectPath of group.projectPaths) {
        const project = this.model.project(projectPath) || minimalProjectDescriptor(projectPath);
        const exitCode = await this.buildProject(project, target, overrides);
        if (exitCode !== 0) finalExitCode = exitCode;
      }
      return finalExitCode;
    }
    if (!await this.saveForProjects(group.projectPaths)) return 1;
    const tools = await this.tools().catch(error => {
      void vscode.window.showErrorMessage(`Pascal Union：${error.message}`);
      return undefined;
    });
    if (!tools) return 1;
    const fallback = this.model.project(group.projectPaths[0]) || {};
    const selected = { ...this.selection(group.groupDir, fallback), ...overrides };
    const args = [group.groupPath, '/nologo', '/v:minimal', `/t:${target}`];
    if (selected.configuration !== 'auto') args.push(`/p:Config=${selected.configuration}`);
    if (selected.platform !== 'auto') args.push(`/p:Platform=${selected.platform}`);
    appendMsbuildProperties(args, overrides.msbuildProperties);
    return this.executeBuild(`${target} ${group.name}`, tools.msbuild, args, group.groupDir, tools.environment);
  }

  async executeBuild(label, executable, args, cwd, environment) {
    if (!fs.existsSync(executable)) {
      void vscode.window.showErrorMessage(`Pascal Union：找不到构建工具 ${executable}`);
      return 1;
    }
    this.backgroundDiagnostics?.suspendCompiler?.('foreground build');
    this.buildInProgress = true;
    this.lastBuildResult = undefined;
    this.refreshStatusBar();
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
    const configuration = vscode.workspace.getConfiguration('pascalUnion');
    const terminalSummary = configuration.get('build.terminalSummary', true);
    const powershell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const runnerPath = path.join(this.context.extensionPath, 'resources', 'pascal-union-build-runner.ps1');
    const useRunner = fs.existsSync(powershell) && fs.existsSync(runnerPath);
    const preparedTerminalSession = useRunner ? this.ensureBuildTerminal() : undefined;
    if (preparedTerminalSession) {
      preparedTerminalSession.beginRun(this.buildOutputFilters());
      this.buildTerminal.show(true);
    }
    const resultDirectory = this.context.globalStorageUri.fsPath;
    if (useRunner) await fs.promises.mkdir(resultDirectory, { recursive: true });
    const resultPath = useRunner
      ? path.join(resultDirectory, `build-result-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
      : '';
    const diagnosticsPath = useRunner
      ? path.join(resultDirectory, `build-diagnostics-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`)
      : '';
    this.buildDiagnostics.clear();
    const buildEnvironment = formalBuildEnvironment(environment);
    const executionEnvironment = useRunner
      ? {
          ...buildEnvironment,
          PASCAL_UNION_BUILD_TOOL: executable,
          PASCAL_UNION_BUILD_ARGS: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
          PASCAL_UNION_BUILD_LABEL: label,
          PASCAL_UNION_BUILD_RESULT: resultPath,
          PASCAL_UNION_BUILD_DIAGNOSTICS: diagnosticsPath,
          PASCAL_UNION_BUILD_SUMMARY: terminalSummary ? 'true' : 'false'
        }
      : buildEnvironment;
    this.output.appendLine(`Foreground build: ${executable} ${args.join(' ')}`);
    const startedAt = Date.now();
    try {
      const timeoutSeconds = vscode.workspace.getConfiguration('pascalUnion').get('build.timeoutSeconds', 1800);
      let taskExitCode;
      if (useRunner) {
        const session = preparedTerminalSession;
        session.setFilters(this.buildOutputFilters());
        let timeout;
        taskExitCode = await Promise.race([
          session.run(
            powershell,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', runnerPath],
            { cwd, env: executionEnvironment }
          ),
          new Promise(resolve => {
            timeout = setTimeout(() => {
              session.emitLine('[ERROR] Build timed out and was terminated.');
              session.terminate();
              resolve(1);
            }, timeoutSeconds * 1000);
          })
        ]);
        clearTimeout(timeout);
      } else {
        const processExecution = new vscode.ProcessExecution(executable, args, { cwd, env: buildEnvironment });
        const task = new vscode.Task(
          { type: 'pascal-union', label },
          folder || vscode.TaskScope.Workspace,
          label,
          'Pascal Union',
          processExecution,
          ['$pascalUnionDelphi', '$pascalUnionDelphiClassic']
        );
        task.group = vscode.TaskGroup.Build;
        task.presentationOptions = {
          reveal: vscode.TaskRevealKind.Always,
          panel: vscode.TaskPanelKind.Dedicated,
          clear: true,
          focus: false,
          echo: false,
          showReuseMessage: false
        };
        const execution = await vscode.tasks.executeTask(task);
        taskExitCode = await new Promise(resolve => {
          const timeout = setTimeout(() => {
            execution.terminate();
            resolve(1);
          }, timeoutSeconds * 1000);
          const disposable = vscode.tasks.onDidEndTaskProcess(event => {
            if (event.execution !== execution) return;
            clearTimeout(timeout);
            disposable.dispose();
            resolve(event.exitCode ?? 1);
          });
        });
      }
      let exitCode = taskExitCode;
      if (useRunner) {
        try {
          const recorded = Number.parseInt(await fs.promises.readFile(resultPath, 'ascii'), 10);
          if (Number.isInteger(recorded)) exitCode = recorded;
        } catch {
          if (taskExitCode === 0) exitCode = 1;
        } finally {
          void fs.promises.unlink(resultPath).catch(() => undefined);
        }
        await this.loadBuildDiagnostics(diagnosticsPath, cwd);
        void fs.promises.unlink(diagnosticsPath).catch(() => undefined);
      }
      const duration = formatBuildDuration(Date.now() - startedAt);
      const succeeded = exitCode === 0;
      this.lastBuildResult = `${label}：${succeeded ? '成功' : '失败'}；退出码 ${exitCode}；用时 ${duration}`;
      this.output.appendLine(`${label}: ${succeeded ? 'BUILD SUCCEEDED' : 'BUILD FAILED'} (exit ${exitCode}, ${duration}).`);
      if (configuration.get('build.completionNotification', true)) {
        if (succeeded) void vscode.window.showInformationMessage(`Pascal Union：${label} 构建成功，用时 ${duration}。`);
        else void vscode.window.showErrorMessage(`Pascal Union：${label} 构建失败，退出码 ${exitCode}，用时 ${duration}。`);
      }
      return exitCode;
    } finally {
      this.buildInProgress = false;
      this.refreshStatusBar();
      this.backgroundDiagnostics?.resumeCompiler?.('foreground build');
    }
  }

  async ensureDebugger() {
    const installedDebugger = vscode.extensions.getExtension(DEBUGGER_ID);
    if (installedDebugger && !debuggerNeedsBundledUpgrade(installedDebugger)) return true;
    if (!vscode.workspace.getConfiguration('pascalUnion').get('debugger.autoInstall', true)) {
      void vscode.window.showErrorMessage('缺少 Delphi Debugger 扩展，请先运行“检查并安装必要扩展”。');
      return false;
    }
    try {
      await installRequiredExtension(
        { id: DEBUGGER_ID, name: 'Delphi Debugger' },
        this.output,
        this.context.globalStorageUri.fsPath
      );
      void vscode.window.showInformationMessage('Delphi Debugger 已安装或升级，请 Reload Window 后开始调试。');
    } catch (error) {
      void vscode.window.showErrorMessage(`Delphi Debugger 安装失败：${error.message}`);
    }
    return false;
  }

  async detailedProject(projectPath, overrides = {}) {
    const tools = await this.tools();
    const minimal = this.model.project(projectPath);
    const selected = { ...this.selection(minimal?.projectDir || path.dirname(projectPath)), ...overrides };
    const cache = this.context.workspaceState.get(DETAILS_KEY, {});
    const key = `${normalizeKey(projectPath)}|${selected.configuration}|${selected.platform}`;
    const signature = `${statSignature(projectPath)}|${minimal?.mainSource ? statSignature(minimal.mainSource) : ''}`;
    if (cache[key]?.signature === signature) return cache[key].descriptor;
    const descriptor = projectDescriptor(projectPath, selected, tools.environment);
    cache[key] = { signature, descriptor };
    const entries = Object.entries(cache);
    if (entries.length > 256) {
      for (const [oldKey] of entries.slice(0, entries.length - 256)) delete cache[oldKey];
    }
    await this.context.workspaceState.update(DETAILS_KEY, cache);
    return descriptor;
  }

  async selectStartupProject(group, force = false) {
    const saved = this.context.workspaceState.get(STARTUP_KEY, {});
    const key = normalizeKey(group.groupPath);
    const candidates = group.projectPaths
      .map(projectPath => this.model.project(projectPath))
      .filter(project => project?.kind === 'application');
    if (!force) {
      const existing = candidates.find(project => normalizeKey(project.projectPath) === normalizeKey(saved[key] || ''));
      if (existing) return existing;
    }
    const picked = await vscode.window.showQuickPick(candidates.map(project => ({ label: project.name, description: project.projectPath, project })), { placeHolder: '选择该 Project Group 的启动工程' });
    if (!picked) return undefined;
    saved[key] = picked.project.projectPath;
    await this.context.workspaceState.update(STARTUP_KEY, saved);
    return picked.project;
  }

  async selectStartupProjectForUri(uri, force) {
    const group = this.groupFromTarget(uri) || await this.pickGroup(uri?.fsPath || '');
    if (group) await this.selectStartupProject(group, force);
  }

  async packageHost(descriptor) {
    if (descriptor.debugHost && fs.existsSync(descriptor.debugHost)) return descriptor.debugHost;
    const saved = this.context.workspaceState.get(HOST_KEY, {});
    const key = normalizeKey(descriptor.projectPath);
    if (saved[key] && fs.existsSync(saved[key])) return saved[key];
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false, filters: { 'Windows executable': ['exe'] }, title: `选择 ${descriptor.name} 的宿主程序` });
    if (!picked?.[0]) return undefined;
    saved[key] = picked[0].fsPath;
    await this.context.workspaceState.update(HOST_KEY, saved);
    return picked[0].fsPath;
  }

  moduleFor(descriptor) {
    return {
      name: path.basename(descriptor.output),
      ...(fs.existsSync(descriptor.mapFile) ? { map: descriptor.mapFile } : {}),
      ...(fs.existsSync(descriptor.rsmFile) ? { rsm: descriptor.rsmFile } : {}),
      ...(descriptor.dcpFile && fs.existsSync(descriptor.dcpFile) ? { dcp: descriptor.dcpFile } : {})
    };
  }

  sourcePaths(descriptors) {
    return uniquePaths(descriptors.flatMap(project => [
      project.projectDir,
      ...(project.references || []).map(path.dirname),
      ...(project.searchPaths || [])
    ])).filter(item => fs.existsSync(item));
  }

  debugConfiguration(program, descriptor, descriptors, modules, request = 'launch') {
    const configuration = vscode.workspace.getConfiguration('pascalUnion');
    const sourcePaths = this.sourcePaths(descriptors);
    return {
      type: 'delphi',
      request,
      name: `Pascal Union: ${descriptor.name}`,
      program,
      mapFile: request === 'launch' && descriptor.kind !== 'package' && fs.existsSync(descriptor.mapFile) ? descriptor.mapFile : undefined,
      rsmFile: request === 'launch' && descriptor.kind !== 'package' && fs.existsSync(descriptor.rsmFile) ? descriptor.rsmFile : undefined,
      sourceRoot: sourcePaths[0] || descriptor.projectDir,
      sourceSearchPaths: sourcePaths.slice(1),
      modules,
      args: parseCommandLine(descriptor.runParams),
      delphiProjectFile: descriptor.projectPath,
      stopAtEntry: configuration.get('debugger.stopAtEntry', true),
      stepIsolation: configuration.get('debugger.stepIsolation', 'auto'),
      stepIsolationReleaseMs: configuration.get('debugger.stepIsolationReleaseMs', 3000),
      ...debugOutputConfiguration(configuration, request),
      diagnosticsLocation: 'outputChannel'
    };
  }

  async confirmSymbols(descriptor, modules, program = descriptor.output, moduleDescriptors = []) {
    if (!vscode.workspace.getConfiguration('pascalUnion').get('debugger.validateSymbols', true)) return true;
    const missing = [];
    if (!fs.existsSync(descriptor.output)) missing.push(descriptor.output);
    if (program && !fs.existsSync(program)) missing.push(program);
    if (descriptor.kind === 'application'
      && !fs.existsSync(descriptor.mapFile)
      && !fs.existsSync(descriptor.rsmFile)
      && !hasEmbeddedTd32(descriptor.output)) {
      missing.push(`${descriptor.name} 的 MAP/RSM/内嵌 TD32`);
    }
    const outputTime = artifactTimestamp(descriptor);
    for (const symbol of [descriptor.mapFile, descriptor.rsmFile, descriptor.dcpFile].filter(item => item && fs.existsSync(item))) {
      try { if (outputTime && fs.statSync(symbol).mtimeMs + 1000 < outputTime) missing.push(`${path.basename(symbol)} 已过期`); } catch {}
    }
    if (String(descriptor.properties?.dcc_optimize || '').toLowerCase() === 'true') missing.push(`${descriptor.name} 开启了编译优化`);
    const programMachine = program && peMachine(program);
    const moduleMachine = peMachine(descriptor.output);
    if (programMachine && moduleMachine && programMachine !== moduleMachine) {
      missing.push(`宿主为 ${programMachine}，${descriptor.name} 为 ${moduleMachine}`);
    }
    for (const module of modules) {
      const moduleDescriptor = moduleDescriptors.find(item => path.basename(item.output).toLowerCase() === module.name.toLowerCase());
      if (!module.map && !module.rsm && !module.dcp && !hasEmbeddedTd32(moduleDescriptor?.output || '')) {
        missing.push(`${module.name} 的 MAP/RSM/DCP/内嵌 TD32`);
      }
    }
    if (!missing.length) return true;
    const choice = await vscode.window.showWarningMessage(
      `调试信息不完整：${missing.slice(0, 4).join('；')}${missing.length > 4 ? '…' : ''}`,
      { modal: true },
      '继续调试',
      '打开工程'
    );
    if (choice === '打开工程') await vscode.window.showTextDocument(vscode.Uri.file(descriptor.projectPath));
    return choice === '继续调试';
  }

  shouldBuildBeforeDebug(descriptors) {
    const mode = vscode.workspace.getConfiguration('pascalUnion').get('debugger.buildBeforeDebug', 'ifOutdated');
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return descriptors.some(descriptor => {
      const outputTime = artifactTimestamp(descriptor);
      if (!outputTime) return true;
      if (vscode.workspace.getConfiguration('pascalUnion').get('debugger.generateDetailedMap', true)) {
        try {
          if (!descriptor.mapFile || fs.statSync(descriptor.mapFile).mtimeMs + 1000 < outputTime) return true;
        } catch {
          return true;
        }
      }
      return uniquePaths([descriptor.projectPath, descriptor.mainSource, ...(descriptor.references || [])]).some(filePath => {
        try { return fs.statSync(filePath).mtimeMs > outputTime; } catch { return false; }
      });
    });
  }

  shouldBuildBeforeRun(descriptors) {
    const mode = vscode.workspace.getConfiguration('pascalUnion').get('run.buildBeforeRun', 'ifOutdated');
    if (mode === 'always') return true;
    if (mode === 'never') return false;
    return descriptors.some(descriptor => {
      const outputTime = artifactTimestamp(descriptor);
      if (!outputTime) return true;
      return uniquePaths([descriptor.projectPath, descriptor.mainSource, ...(descriptor.references || [])]).some(filePath => {
        try { return fs.statSync(filePath).mtimeMs > outputTime; } catch { return false; }
      });
    });
  }

  async runGroup(uri) {
    if (this.runInProgress) {
      return void vscode.window.showInformationMessage('Pascal Union：已有一个 Run 进程正在运行。');
    }
    const group = this.groupFromTarget(uri) || await this.pickGroup(uri?.fsPath || '');
    if (!group) return void vscode.window.showWarningMessage('当前工作区没有可运行的 Delphi Project Group。');
    const startup = await this.selectStartupProject(group, false);
    if (!startup) return;
    const fallback = this.model.project(group.projectPaths[0]) || {};
    const selected = this.selection(group.groupDir, fallback);
    let descriptors = [];
    for (const projectPath of group.projectPaths) {
      try { descriptors.push(await this.detailedProject(projectPath, selected)); }
      catch (error) { this.output.appendLine(`Run project description failed (${projectPath}): ${error.message}`); }
    }
    if (this.shouldBuildBeforeRun(descriptors)) {
      const exitCode = await this.enqueue(() => this.buildGroup(group, 'Build', selected));
      if (exitCode !== 0) return;
      descriptors = [];
      for (const projectPath of group.projectPaths) {
        try { descriptors.push(await this.detailedProject(projectPath, selected)); }
        catch (error) { this.output.appendLine(`Run project description failed (${projectPath}): ${error.message}`); }
      }
    }
    const descriptor = descriptors.find(item => normalizeKey(item.projectPath) === normalizeKey(startup.projectPath));
    if (!descriptor || !fs.existsSync(descriptor.output)) {
      return void vscode.window.showErrorMessage(`启动工程输出不存在：${descriptor?.output || startup.projectPath}`);
    }
    const tools = await this.tools().catch(() => undefined);
    const args = parseCommandLine(descriptor.runParams);
    this.output.appendLine(`Run without debugging: ${descriptor.output} ${args.join(' ')}`);
    this.runInProgress = true;
    this.refreshStatusBar();
    try {
      await this.runInDebugConsole(descriptor, args, tools?.environment || {});
    } catch (error) {
      void vscode.window.showErrorMessage(`Pascal Union：运行失败：${error.message}`);
    } finally {
      this.runInProgress = false;
      this.refreshStatusBar();
    }
  }

  async runInDebugConsole(descriptor, args, environment) {
    const runId = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const configuration = {
      type: 'pascal-union-run',
      request: 'launch',
      name: `Run ${descriptor.name}`,
      displayName: descriptor.name,
      program: descriptor.output,
      args,
      cwd: descriptor.projectDir,
      env: environment,
      runId,
      noDebug: true,
      internalConsoleOptions: 'openOnSessionStart'
    };
    const adapter = new RunDebugAdapter(configuration);
    this.activeRunAdapter = adapter;
    this.runAdapters.set(runId, adapter);
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(descriptor.projectPath));
    const started = await vscode.debug.startDebugging(folder, configuration, {
      noDebug: true,
      suppressDebugToolbar: true,
      suppressDebugView: true
    });
    if (!started) {
      this.runAdapters.delete(runId);
      if (this.activeRunAdapter === adapter) this.activeRunAdapter = undefined;
      adapter.dispose();
      throw new Error('无法启动内部 Run 会话。');
    }
    await vscode.commands.executeCommand('workbench.debug.action.focusRepl');
    const exitCode = await adapter.completed;
    this.runAdapters.delete(runId);
    if (this.activeRunAdapter === adapter) this.activeRunAdapter = undefined;
    this.output.appendLine(`Run ${descriptor.name}: process exited with code ${exitCode}.`);
  }

  async debugPackage(uri) {
    if (!vscode.workspace.getConfiguration('pascalUnion').get('debugger.enabled', true)) {
      return void vscode.window.showWarningMessage('Pascal Union Delphi 调试器已在设置中关闭。');
    }
    if (!await this.ensureDebugger()) return;
    const project = this.projectFromTarget(uri) || await this.pickPackage(uri?.fsPath || '');
    if (!project) return;
    const requestedPlatform = this.selection(project.projectDir, project).platform;
    const platform = compatiblePlatform([project], requestedPlatform);
    if (platform !== requestedPlatform) {
      void vscode.window.showInformationMessage(`Pascal Union：${project.name} 不支持 ${requestedPlatform}，调试已改用 ${platform}。`);
    }
    const debugOverrides = {
      configuration: 'Debug',
      platform,
      msbuildProperties: vscode.workspace.getConfiguration('pascalUnion').get('debugger.generateDetailedMap', true)
        ? debugMsbuildProperties()
        : undefined
    };
    let descriptor = await this.detailedProject(project.projectPath, debugOverrides);
    if (this.shouldBuildBeforeDebug([descriptor])) {
      const exitCode = await this.enqueue(() => this.buildProject(project, 'Make', debugOverrides));
      if (exitCode !== 0) return;
      descriptor = await this.detailedProject(project.projectPath, debugOverrides);
    }
    const host = await this.packageHost(descriptor);
    if (!host) return;
    const descriptors = [descriptor];
    const group = this.groupForProject(project.projectPath);
    if (group) {
      for (const projectPath of group.projectPaths) {
        if (normalizeKey(projectPath) === normalizeKey(project.projectPath)) continue;
        try { descriptors.push(await this.detailedProject(projectPath, { configuration: 'Debug', platform: descriptor.platform })); }
        catch {}
      }
    }
    const modules = descriptors
      .filter(item => ['package', 'library'].includes(item.kind) && fs.existsSync(item.output))
      .map(item => this.moduleFor(item));
    if (!modules.some(module => module.name.toLowerCase() === path.basename(descriptor.output).toLowerCase())) {
      modules.unshift(this.moduleFor(descriptor));
    }
    if (!await this.confirmSymbols(descriptor, modules, host, descriptors)) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.projectPath));
    const started = await vscode.debug.startDebugging(folder, this.debugConfiguration(host, descriptor, descriptors, modules));
    if (!started) void vscode.window.showErrorMessage('Pascal Union：Delphi 调试会话未能启动，请查看“Delphi Debugger”输出。');
  }

  async attachPackage(uri) {
    if (!vscode.workspace.getConfiguration('pascalUnion').get('debugger.enabled', true)) {
      return void vscode.window.showWarningMessage('Pascal Union Delphi 调试器已在设置中关闭。');
    }
    if (!await this.ensureDebugger()) return;
    const project = this.projectFromTarget(uri) || await this.pickPackage(uri?.fsPath || '');
    if (!project) return;
    const descriptor = await this.detailedProject(project.projectPath, { configuration: 'Debug' });
    const host = await this.packageHost(descriptor);
    if (!host) return;
    const modules = [this.moduleFor(descriptor)];
    if (!await this.confirmSymbols(descriptor, modules, host, [descriptor])) return;
    const config = this.debugConfiguration(host, descriptor, [descriptor], modules, 'attach');
    config.processName = path.basename(host);
    config.processId = '${command:delphi-win64.pickProcess}';
    delete config.args;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(project.projectPath));
    await vscode.debug.startDebugging(folder, config);
  }

  async buildAndDebugGroup(uri) {
    if (!vscode.workspace.getConfiguration('pascalUnion').get('debugger.enabled', true)) {
      return void vscode.window.showWarningMessage('Pascal Union Delphi 调试器已在设置中关闭。');
    }
    if (!await this.ensureDebugger()) return;
    const group = this.groupFromTarget(uri) || await this.pickGroup(uri?.fsPath || '');
    if (!group) return;
    const startup = await this.selectStartupProject(group, false);
    if (!startup) return;
    const projects = group.projectPaths.map(projectPath => this.model.project(projectPath) || minimalProjectDescriptor(projectPath));
    const requestedPlatform = this.selection(group.groupDir).platform;
    const platform = compatiblePlatform(projects, requestedPlatform);
    if (platform !== requestedPlatform) {
      void vscode.window.showInformationMessage(`Pascal Union：该工程组不支持 ${requestedPlatform}，调试已改用 ${platform}。`);
    }
    const debugOverrides = {
      configuration: 'Debug',
      platform,
      msbuildProperties: vscode.workspace.getConfiguration('pascalUnion').get('debugger.generateDetailedMap', true)
        ? debugMsbuildProperties()
        : undefined
    };
    let descriptors = [];
    for (const projectPath of group.projectPaths) {
      try { descriptors.push(await this.detailedProject(projectPath, debugOverrides)); }
      catch (error) { this.output.appendLine(`Debug project description failed (${projectPath}): ${error.message}`); }
    }
    if (this.shouldBuildBeforeDebug(descriptors)) {
      const exitCode = await this.enqueue(() => this.buildGroup(group, 'Build', debugOverrides));
      if (exitCode !== 0) return;
      descriptors = [];
      for (const projectPath of group.projectPaths) {
        try { descriptors.push(await this.detailedProject(projectPath, debugOverrides)); }
        catch (error) { this.output.appendLine(`Debug project description failed (${projectPath}): ${error.message}`); }
      }
    }
    const descriptor = descriptors.find(item => normalizeKey(item.projectPath) === normalizeKey(startup.projectPath));
    if (!descriptor || !fs.existsSync(descriptor.output)) {
      return void vscode.window.showErrorMessage(`启动工程输出不存在：${descriptor?.output || startup.projectPath}`);
    }
    const modules = vscode.workspace.getConfiguration('pascalUnion').get('debugger.loadGroupModules', true)
      ? descriptors.filter(item => ['package', 'library'].includes(item.kind) && fs.existsSync(item.output)).map(item => this.moduleFor(item))
      : [];
    if (!await this.confirmSymbols(descriptor, modules, descriptor.output, descriptors)) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(group.groupPath));
    this.output.appendLine(`Starting Delphi debugger: ${descriptor.output} (${descriptor.configuration}/${descriptor.platform}), modules=${modules.length}, map=${fs.existsSync(descriptor.mapFile) ? descriptor.mapFile : 'missing'}, rsm=${fs.existsSync(descriptor.rsmFile) ? descriptor.rsmFile : 'missing'}.`);
    const started = await vscode.debug.startDebugging(folder, this.debugConfiguration(descriptor.output, descriptor, descriptors, modules));
    if (!started) void vscode.window.showErrorMessage('Pascal Union：Delphi 调试会话未能启动，请查看“Delphi Debugger”输出。');
  }

  async provideDebugConfigurations(folder) {
    const groups = [...this.model.groups.values()].filter(group => !folder || isInside(folder.uri.fsPath, group.groupPath));
    const result = [];
    for (const group of groups) {
      const descriptors = [];
      for (const projectPath of group.projectPaths) {
        try { descriptors.push(await this.detailedProject(projectPath, { configuration: 'Debug' })); }
        catch {}
      }
      const modules = descriptors
        .filter(item => ['package', 'library'].includes(item.kind) && fs.existsSync(item.output))
        .map(item => this.moduleFor(item));
      for (const descriptor of descriptors.filter(item => item.kind === 'application')) {
        const config = this.debugConfiguration(descriptor.output, descriptor, descriptors, modules);
        config.name = `Pascal Union: ${group.name} / ${descriptor.name}`;
        result.push(config);
      }
    }
    return result;
  }

  async provideTasks() {
    const tools = await this.tools().catch(() => undefined);
    if (!tools) return [];
    const tasks = [];
    for (const group of this.model.groups.values()) {
      for (const target of ['Make', 'Build']) {
        const selected = this.selection(group.groupDir);
        const args = [group.groupPath, '/nologo', '/v:minimal', `/t:${target}`];
        if (selected.configuration !== 'auto') args.push(`/p:Config=${selected.configuration}`);
        if (selected.platform !== 'auto') args.push(`/p:Platform=${selected.platform}`);
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(group.groupPath));
        const task = new vscode.Task(
          { type: 'pascal-union', target, group: group.groupPath },
          folder || vscode.TaskScope.Workspace,
          `${target} ${group.name}`,
          'Pascal Union',
          new vscode.ProcessExecution(tools.msbuild, args, {
            cwd: group.groupDir,
            env: formalBuildEnvironment(tools.environment)
          }),
          ['$pascalUnionDelphi', '$pascalUnionDelphiClassic']
        );
        task.group = vscode.TaskGroup.Build;
        tasks.push(task);
      }
    }
    return tasks;
  }

  legacyDebuggerConflict() {
    return Boolean(vscode.extensions.getExtension(DEBUGGER_ID) && vscode.extensions.getExtension(LEGACY_DEBUGGER_ID));
  }
}

module.exports = {
  BuildTerminalSession,
  BuildDebugSupport,
  DEBUGGER_ID,
  DETAILS_KEY,
  HOST_KEY,
  LEGACY_DEBUGGER_ID,
  SELECTION_KEY,
  STARTUP_KEY,
  artifactTimestamp,
  appendMsbuildProperties,
  compatiblePlatform,
  debugOutputConfiguration,
  debugMsbuildProperties,
  formalBuildEnvironment,
  formatBuildDuration,
  buildOutputCategory,
  parseBuildDiagnosticLine,
  resolvedBuildSelection,
  hasEmbeddedTd32,
  peMetadataFromBuffer,
  peMachine,
  parseCommandLine
};
