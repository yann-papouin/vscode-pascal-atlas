import { WorkerEvent, UriScheme } from './shared/identifiers';
import { workerPath } from './runtimePaths';
import type { ProjectInfo } from './diagnosticCore';
import type { SyntaxResponse } from './syntaxWorker';
import { isRecord } from './shared/guards';
import { errorMessage } from './shared/guards';
import { PascalKeyword } from './shared/pascal';
import { CommandId, ConfigurationSection, LanguageId, SettingKey } from './shared/identifiers';
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { discoverLoadedProjects, normalizeKey } from './projectDiscovery';
import { decodePascalBytes, decodeProcessOutput } from './encodingSupport';
import { ProjectTaskPool, cacheKey, compilerEnvironmentWithSearchPath, excludeManagedSourcePaths, parseCompilerOutput, readActiveProject, readProjectInfo, resolveOwningProject, rewritePascalPaths } from './diagnosticCore';
import { BinaryLike } from 'crypto';
import { ExecFileOptionsWithBufferEncoding } from 'child_process';

const PASCAL_LANGUAGES = new Set<string>([LanguageId.Pascal, LanguageId.ObjectPascal]);
const MAX_DIAGNOSTICS = 200;
const MANAGED_PATHS_KEY = 'pascalAtlas.managedPaths';
const GLOBAL_MANAGED_PATHS_KEY = 'pascalAtlas.globalManagedPaths';

function isPascalDocument(document: vscode.TextDocument) {
  return PASCAL_LANGUAGES.has(document.languageId) && document.uri.scheme === UriScheme.File;
}

function uniquePaths(values: (string | undefined)[]) {
  const result = [];
  const seen = new Set();
  for (const value of values.filter((value): value is string => Boolean(value))) {
    if (/\$\([^)]+\)/.test(value)) continue;
    const resolved = path.resolve(value);
    const key = normalizeKey(resolved);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(resolved);
    }
  }
  return result;
}

function expandCompilerPaths(values: string[], tools: CompilerTools, project: ProjectInfo | undefined) {
  const properties = {
    ...tools.environment,
    BDS: tools.installation,
    BDSLIB: path.join(tools.installation, 'lib'),
    Platform: project?.platform || 'Win32',
    Config: project?.configuration || 'Debug'
  };
  const lookup = new Map(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), String(value || '')]));
  return values.map((value) => String(value || '').replace(/\$\(([^)]+)\)/g,
    (whole, name) => lookup.get(name.toLowerCase()) || whole));
}

function shortHash(value: BinaryLike) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeFilePart(value: string) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(-80);
}

function msbuildEscape(value: string) {
  return String(value).replace(/%/g, '%25').replace(/;/g, '%3B');
}

function documentText(document: vscode.TextDocument|undefined) {
  return document?.getText();
}

function utf8Source(text: string) {
  return text.startsWith('\uFEFF') ? text : `\uFEFF${text}`;
}

function severityForVscode(value: string) {
  if (value === 'warning') return vscode.DiagnosticSeverity.Warning;
  if (value === 'hint') return vscode.DiagnosticSeverity.Hint;
  return vscode.DiagnosticSeverity.Error;
}

function rangeForText(text: string, lineNumber: number, column: number, message: string) {
  const lines = text.split(/\r?\n/);
  const line = Math.max(0, Math.min(lines.length - 1, (lineNumber || 1) - 1));
  const lineText = lines[line] || '';
  let start = column > 0 ? Math.min(lineText.length, column - 1) : -1;
  if (start < 0) {
    const quoted = /['"]([A-Za-z_][A-Za-z0-9_]*)['"]/.exec(message || '')?.[1];
    if (quoted) start = lineText.toLowerCase().indexOf(quoted.toLowerCase());
  }
  if (start < 0) start = lineText.search(/\S/);
  if (start < 0) start = 0;
  const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(lineText.slice(start))?.[0];
  const length = Math.max(1, word?.length || 1);
  return new vscode.Range(line, start, line, Math.min(lineText.length, start + length));
}

function diagnosticIdentity(item: vscode.Diagnostic) {
  return `${item.range.start.line}:${item.range.start.character}:${item.code || ''}:${item.message.toLowerCase()}`;
}

function overlaps(left: vscode.Diagnostic, right: vscode.Diagnostic) {
  return Boolean(left.range.intersection(right.range));
}

function projectSetting<T>(configuration: vscode.WorkspaceConfiguration, key: string, fallback: T): T {
  return configuration.get(`diagnostics.${key}`, fallback);
}

function findDelphiInstallation() {
  const configured = vscode.workspace.getConfiguration('vallenta.studio').get('installationPath', '');
  if (configured && fs.existsSync(configured)) return configured;
  const root = process.env['ProgramFiles(x86)']
    ? path.join(process.env['ProgramFiles(x86)'], 'Embarcadero', 'Studio')
    : undefined;
  if (!root || !fs.existsSync(root)) return undefined;
  const versions = fs.readdirSync(root, { withFileTypes: true })
    .filter(item => item.isDirectory())
    .map(item => item.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  return versions.map(item => path.join(root, item)).find(item => fs.existsSync(path.join(item, 'bin', 'rsvars.bat')));
}

function readRsvarsEnvironment(rsvarsPath: string) {
  const environment = { ...process.env };
  const findValue = (name: string) => {
    const key = Object.keys(environment).find(item => item.toLowerCase() === name.toLowerCase());
    return key ? environment[key] : '';
  };
  for (const line of fs.readFileSync(rsvarsPath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*@?SET\s+([^=]+)=(.*)$/i.exec(line);
    if (!match) continue;
    environment[match[1].trim()] = match[2].replace(/%([^%]+)%/g, (_, name) => findValue(name) || '');
  }
  return environment;
}

function execFileResult(file: string, args: readonly string[], options: ExecFileOptionsWithBufferEncoding, signal: AbortSignal | undefined, timeoutMs: number | undefined) {
  return new Promise<CompilerProcessResult>((resolve, reject) => {
    let settled = false;
    let timeout: string|number|NodeJS.Timeout|undefined;
    const child = execFile(file, args, {
      ...options,
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      resolve({ error, stdout: stdout || '', stderr: stderr || '', exitCode: error?.code ?? 0 });
    });
    const terminate = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      } else {
        child.kill('SIGTERM');
      }
    };
    const abort = () => {
      terminate();
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(Object.assign(new Error('Background compilation cancelled.'), { cancelled: true }));
      }
    };
    signal?.addEventListener('abort', abort, { once: true });
    timeout = setTimeout(() => {
      terminate();
      if (!settled) {
        settled = true;
        signal?.removeEventListener('abort', abort);
        reject(Object.assign(new Error('Background compilation timed out.'), { timedOut: true }));
      }
    }, timeoutMs);
    if (signal?.aborted) abort();
  });
}

interface CompilerTools { installation: string; environment: NodeJS.ProcessEnv; msbuild: string; dcc32: string; dcc64: string; }
interface CompilerProcessResult { error: Error | null; stdout: string | Uint8Array; stderr: string | Uint8Array; exitCode: string | number; }
interface CompilerTaskResult { cancelled?: boolean; unavailable?: boolean; stale?: boolean; diagnostics?: number; exitCode?: string | number; error?: unknown; }
type SyntaxSuccess = Extract<SyntaxResponse, { diagnostics: unknown }>;
type CompilerDiagnostic = ReturnType<typeof parseCompilerOutput>[number];
class SyntaxWorkerClient {
  workerPath;
  output;
  requests;
  nextId;
  worker: Worker | undefined;

  constructor(workerPath: string, output: Pick<vscode.OutputChannel, "appendLine">) {
    this.workerPath = workerPath;
    this.output = output;
    this.requests = new Map<number, { resolve: (response: SyntaxSuccess) => void; reject: (error: unknown) => void }>();
    this.nextId = 1;
    this.start();
  }

  start() {
    this.worker = new Worker(this.workerPath);
    this.worker.on(WorkerEvent.Message, (response: SyntaxResponse) => {
      const request = this.requests.get(response.id);
      if (!request) return;
      this.requests.delete(response.id);
      if ('error' in response && response.error !== undefined) request.reject(new Error(response.error)); else if (response.diagnostics) request.resolve(response);
    });
    this.worker.on(WorkerEvent.Error, (error) => {
      this.output.appendLine(`Syntax worker failed: ${error.stack || error.message}`);
      for (const request of this.requests.values()) request.reject(error);
      this.requests.clear();
    });
  }

  analyze(document: Pick<vscode.TextDocument, "uri" | "version" | "getText">, defines: string[]) {
    const id = this.nextId++;
    return new Promise<SyntaxSuccess>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.worker?.postMessage({
        id,
        uri: document.uri.toString(),
        version: document.version,
        text: document.getText(),
        defines
      });
    });
  }

  dispose() {
    for (const request of this.requests.values()) request.reject(new Error('Syntax worker disposed.'));
    this.requests.clear();
    void this.worker?.terminate();
  }
}

class BackgroundDiagnostics {
  context: vscode.ExtensionContext;
  output;
  syntaxCollection;
  compilerCollection;
  syntaxClient;
  syntaxTimers;
  compilerTimers;
  rawSyntax;
  compilerUrisByProject;
  compilerCounts;
  requestedCompilerVersions;
  startupCompilerTimer: string|number|NodeJS.Timeout|undefined;
  projects: ProjectInfo[];
  activeProjects;
  environmentPromise: Promise<{ installation: string; environment: { [key: string]: string|undefined; TZ?: string; }; msbuild: string; dcc32: string; dcc64: string; }|undefined>|undefined;
  unavailableNotified;
  compilerSuspensions;
  status;
  pool: ProjectTaskPool<CompilerTaskResult> = new ProjectTaskPool(2);
  disposed = false;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.context = context;
    this.output = output;
    this.syntaxCollection = vscode.languages.createDiagnosticCollection('pascalAtlas.syntax');
    this.compilerCollection = vscode.languages.createDiagnosticCollection('pascalAtlas.compiler');
    this.syntaxClient = new SyntaxWorkerClient(workerPath('syntaxWorker.js'), output);
    this.syntaxTimers = new Map<string, ReturnType<typeof setTimeout>>();
    this.compilerTimers = new Map<string, ReturnType<typeof setTimeout>>();
    this.rawSyntax = new Map<string, vscode.Diagnostic[]>();
    this.compilerUrisByProject = new Map<string, Set<string>>();
    this.compilerCounts = new Map<string, number>();
    this.requestedCompilerVersions = new Map<string, string>();
    this.startupCompilerTimer = undefined;
    this.projects = [];
    this.activeProjects = new Map<string, string | undefined>();
    this.environmentPromise = undefined;
    this.unavailableNotified = false;
    this.compilerSuspensions = 0;
    this.status = vscode.languages.createLanguageStatusItem('pascalAtlas.diagnostics', [
      { language: LanguageId.Pascal, scheme: UriScheme.File },
      { language: LanguageId.ObjectPascal, scheme: UriScheme.File }
    ]);
    this.status.name = 'Pascal Atlas Diagnostics';
    this.status.text = '$(check) Delphi diagnostics ready';
    this.status.detail = 'Syntax worker and background compiler are ready.';
    this.rebuildPool();
    context.subscriptions.push(this.syntaxCollection, this.compilerCollection, this.status, {
      dispose: () => this.dispose()
    });
  }

  configuration(uri?: vscode.ConfigurationScope | null) {
    return vscode.workspace.getConfiguration(ConfigurationSection, uri);
  }

  enabled(document: vscode.TextDocument) {
    return isPascalDocument(document)
      && this.configuration(document.uri).get(SettingKey.Enabled, true)
      && projectSetting(this.configuration(document.uri), SettingKey.Enabled, true);
  }

  rebuildPool() {
    this.pool?.cancelAll('configuration changed');
    const maximum = projectSetting(this.configuration(), 'compiler.maxParallelProjects', 2);
    this.pool = new ProjectTaskPool(maximum);
  }

  refreshProjects() {
    const configuration = this.configuration();
    const requestedConfiguration = projectSetting(configuration, 'compiler.configuration', 'auto');
    const requestedPlatform = projectSetting(configuration, 'compiler.platform', 'auto');
    const projects = [];
    this.activeProjects.clear();
    for (const folder of vscode.workspace.workspaceFolders || []) {
      this.activeProjects.set(normalizeKey(folder.uri.fsPath), readActiveProject(folder.uri.fsPath));
      for (const projectPath of discoverLoadedProjects(folder.uri.fsPath)) {
        try {
          projects.push(readProjectInfo(projectPath, {
            configuration: requestedConfiguration,
            platform: requestedPlatform
          }));
        } catch (error) {
          this.output.appendLine(`Diagnostic project skipped (${projectPath}): ${errorMessage(error)}`);
        }
      }
    }
    this.projects = projects;
    this.output.appendLine(`Background diagnostics: ${projects.length} loaded Delphi project(s).`);
  }

  workspaceRootFor(filePath: string) {
    return (vscode.workspace.workspaceFolders || [])
      .filter(folder => {
        const relative = path.relative(folder.uri.fsPath, filePath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      })
      .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0]?.uri.fsPath;
  }

  projectForDocument(document: vscode.TextDocument) {
    const root = this.workspaceRootFor(document.fileName);
    const active = root ? this.activeProjects.get(normalizeKey(root)) : undefined;
    return resolveOwningProject(document.fileName, this.projects, active);
  }

  scheduleSyntax(document: vscode.TextDocument, immediate = false) {
    if (!this.enabled(document)) return;
    const configuration = this.configuration(document.uri);
    if (!projectSetting(configuration, 'syntax.enabled', true)) return;
    const key = document.uri.toString();
    clearTimeout(this.syntaxTimers.get(key));
    const delay = immediate ? 0 : projectSetting(configuration, 'syntax.debounceMs', 300);
    this.syntaxTimers.set(key, setTimeout(() => {
      this.syntaxTimers.delete(key);
      void this.runSyntax(document);
    }, delay));
  }

  async runSyntax(document: vscode.TextDocument) {
    if (document.isClosed || !this.enabled(document)) return;
    const project = this.projectForDocument(document);
    this.status.text = '$(sync~spin) Syntax checking';
    try {
      const response = await this.syntaxClient.analyze(document, project?.defines || []);
      if (document.isClosed || document.version !== response.version) return;
      const diagnostics = response.diagnostics.map((item) => {
        const range = new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length));
        const value = new vscode.Diagnostic(range, item.message, severityForVscode(item.severity || 'error'));
        value.source = 'Pascal Atlas Syntax';
        value.code = item.code;
        return value;
      });
      this.rawSyntax.set(document.uri.toString(), diagnostics);
      this.publishSyntax(document.uri);
      this.updateReadyStatus();
    } catch (error) {
      this.output.appendLine(`Syntax analysis failed for ${document.fileName}: ${errorMessage(error)}`);
      this.status.text = '$(error) Syntax worker failed';
      this.status.detail = errorMessage(error);
    }
  }

  publishSyntax(uri: vscode.Uri) {
    const compilerDiagnostics = this.compilerCollection.get(uri) || [];
    const diagnostics = (this.rawSyntax.get(uri.toString()) || [])
      .filter((item) => !compilerDiagnostics.some(compiled => overlaps(item, compiled)));
    this.syntaxCollection.set(uri, diagnostics);
  }

  scheduleCompiler(document: vscode.TextDocument, immediate = false) {
    clearTimeout(this.startupCompilerTimer);
    this.startupCompilerTimer = undefined;
    if (!this.enabled(document) || this.compilerSuspensions > 0) return;
    // Do not launch a standalone Delphi compile for RTL/VCL or generated
    // virtual documents opened outside the workspace. Besides producing false
    // "Unit not found" errors, those jobs compete with current-file symbol
    // indexing during the first seconds after a window reload.
    if (!this.workspaceRootFor(document.fileName) && !this.projectForDocument(document)) return;
    const configuration = this.configuration(document.uri);
    if (!projectSetting(configuration, 'compiler.enabled', true)) return;
    const key = document.uri.toString();
    clearTimeout(this.compilerTimers.get(key));
    const delay = immediate ? 0 : projectSetting(configuration, 'compiler.idleDelayMs', 1500);
    this.compilerTimers.set(key, setTimeout(() => {
      this.compilerTimers.delete(key);
      void this.enqueueCompiler(document);
    }, delay));
  }

  documentPriority(document: vscode.TextDocument) {
    if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) return 100;
    if (vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString() === document.uri.toString())) return 50;
    return 10;
  }

  preferredDocument(project: ProjectInfo | undefined, fallback: vscode.TextDocument) {
    const candidates = vscode.workspace.textDocuments.filter(document =>
      this.enabled(document) && (!project || this.projectForDocument(document)?.projectPath === project.projectPath));
    if (!candidates.some(document => document.uri.toString() === fallback.uri.toString())) candidates.push(fallback);
    return candidates.sort((left, right) => this.documentPriority(right) - this.documentPriority(left))[0];
  }

  async enqueueCompiler(document: vscode.TextDocument) {
    if (document.isClosed || !this.enabled(document) || this.compilerSuspensions > 0) return;
    const project = this.projectForDocument(document);
    const focusDocument = this.preferredDocument(project, document);
    const projectKey = normalizeKey(project?.projectPath || focusDocument.fileName);
    const version = focusDocument.version;
    const requestIdentity = `${focusDocument.uri}:${version}`;
    if (this.requestedCompilerVersions.get(projectKey) === requestIdentity
      && (this.pool.running.has(projectKey) || this.pool.queued.has(projectKey))) return;
    this.requestedCompilerVersions.set(projectKey, requestIdentity);
    this.pool.cancel(projectKey, 'superseded by a newer document version');
    this.status.text = '$(clock) Compiler queued';
    this.status.detail = project ? `${path.basename(project.projectPath)} ${project.configuration}/${project.platform}` : path.basename(document.fileName);
    const result = await this.pool.enqueue(projectKey, this.documentPriority(focusDocument), (signal) =>
      this.compileDocument(focusDocument, project, version, projectKey, signal));
    if (this.requestedCompilerVersions.get(projectKey) === requestIdentity) this.requestedCompilerVersions.delete(projectKey);
    if ('error' in result && result.error && !(isRecord(result.error) && result.error.cancelled)) {
      this.output.appendLine(`Background compiler task failed: ${errorMessage(result.error)}`);
    }
  }

  storageRoot() {
    return this.context.storageUri?.fsPath || this.context.globalStorageUri.fsPath;
  }

  async compilerEnvironment() {
    if (this.environmentPromise) return this.environmentPromise;
    this.environmentPromise = (async () => {
      const installation = findDelphiInstallation();
      if (!installation) return undefined;
      const rsvars = path.join(installation, 'bin', 'rsvars.bat');
      const environment = readRsvarsEnvironment(rsvars);
      const frameworkDir = environment.FrameworkDir || path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework', 'v4.0.30319');
      return {
        installation,
        environment,
        msbuild: vscode.workspace.getConfiguration('vallenta.studio').get('msbuildPath', '')
          || path.join(frameworkDir, 'MSBuild.exe'),
        dcc32: path.join(installation, 'bin', 'dcc32.exe'),
        dcc64: path.join(installation, 'bin', 'dcc64.exe')
      };
    })();
    return this.environmentPromise;
  }

  managedNavigationPaths() {
    const globalPaths = this.context.globalState.get<string[]>(GLOBAL_MANAGED_PATHS_KEY, []);
    const paths = Array.isArray(globalPaths) ? [...globalPaths] : [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const workspacePaths = this.context.workspaceState.get<string[]>(
        `${MANAGED_PATHS_KEY}:${folder.uri.fsPath}`,
        []
      );
      if (Array.isArray(workspacePaths)) paths.push(...workspacePaths);
    }
    return paths;
  }

  isolatedCompilerEnvironment(tools: CompilerTools, project: ProjectInfo | undefined) {
    const environmentEntry = Object.entries(tools.environment || {})
      .find(([key]) => key.toLowerCase() === 'dcc_unitsearchpath');
    const inherited = expandCompilerPaths(
      String(environmentEntry?.[1] || '').split(';'),
      tools,
      project
    );
    const retained = excludeManagedSourcePaths(inherited, this.managedNavigationPaths());
    return {
      environment: compilerEnvironmentWithSearchPath(tools.environment, retained),
      paths: retained,
      excludedCount: Math.max(0, inherited.filter(Boolean).length - retained.length)
    };
  }

  dirtyDocumentsForProject(project: ProjectInfo | undefined, focusDocument: vscode.TextDocument) {
    const candidates = vscode.workspace.textDocuments.filter(document =>
      isPascalDocument(document) && document.isDirty && (!project || this.projectForDocument(document)?.projectPath === project.projectPath));
    if (!candidates.some(document => document.uri.toString() === focusDocument.uri.toString())) candidates.push(focusDocument);
    return candidates;
  }

  async createShadow(project: ProjectInfo | undefined, focusDocument: vscode.TextDocument, tools: CompilerTools) {
    const projectIdentity = project?.projectPath || focusDocument.fileName;
    const cache = path.join(this.storageRoot(), 'compiler-cache', cacheKey(project || {
      projectPath: focusDocument.fileName,
      configuration: 'Debug',
      platform: 'Win32',
      defines: [],
      searchPaths: []
    }, project?.platform === 'Win64' ? tools.dcc64 : tools.dcc32));
    const job = path.join(this.storageRoot(), 'jobs', `${shortHash(projectIdentity)}-${Date.now()}`);
    await fs.promises.mkdir(job, { recursive: true });
    await fs.promises.mkdir(path.join(cache, 'dcu'), { recursive: true });
    await fs.promises.mkdir(path.join(cache, 'bin'), { recursive: true });

    const dirty = this.dirtyDocumentsForProject(project, focusDocument);
    const shadowByOriginal = new Map<string, string>();
    const originalByShadow = new Map<string, string>();
    for (const document of dirty) {
      // Preserve the source basename. Delphi resolves an ordinary `uses UnitName`
      // by filename, so a hash-prefixed filename silently falls back to the
      // original source or a cached DCU instead of compiling unsaved text.
      const shadow = path.join(job, 'sources', shortHash(path.dirname(document.fileName)), path.basename(document.fileName));
      shadowByOriginal.set(normalizeKey(document.fileName), shadow);
      originalByShadow.set(normalizeKey(shadow), document.fileName);
    }
    for (const document of dirty) {
      const shadow = shadowByOriginal.get(normalizeKey(document.fileName));
      if (!shadow) throw new Error('Missing shadow source for ' + document.fileName);
      await fs.promises.mkdir(path.dirname(shadow), { recursive: true });
      await fs.promises.writeFile(shadow, utf8Source(rewritePascalPaths(document.getText(), document.fileName, shadowByOriginal)), 'utf8');
    }

    let mainSource;
    if (project?.mainSource && fs.existsSync(project.mainSource)) {
      const openMain = vscode.workspace.textDocuments.find(document => normalizeKey(document.fileName) === normalizeKey(project.mainSource || ''));
      const mainText = openMain
        ? openMain.getText()
        : decodePascalBytes(await fs.promises.readFile(project.mainSource));
      mainSource = path.join(job, `main-${safeFilePart(path.basename(project.mainSource))}`);
      shadowByOriginal.set(normalizeKey(project.mainSource), mainSource);
      originalByShadow.set(normalizeKey(mainSource), project.mainSource);
      await fs.promises.writeFile(mainSource, utf8Source(rewritePascalPaths(mainText, project.mainSource, shadowByOriginal)), 'utf8');
    }
    return { job, cache, mainSource, shadowByOriginal, originalByShadow, dirty };
  }

  async compileDocument(document: vscode.TextDocument, project: ProjectInfo | undefined, version: number, projectKey: string, signal: AbortSignal): Promise<CompilerTaskResult> {
    if (signal.aborted) return { cancelled: true };
    const tools = await this.compilerEnvironment();
    if (!tools || (!fs.existsSync(tools.msbuild) && !fs.existsSync(tools.dcc32))) {
      if (!this.unavailableNotified) {
        this.unavailableNotified = true;
        void vscode.window.showWarningMessage('Pascal Atlas: Delphi compiler unavailable; syntax diagnostics remain active.');
      }
      this.status.text = '$(warning) Delphi compiler unavailable';
      return { unavailable: true };
    }
    if (signal.aborted) return { cancelled: true };
    const shadow = await this.createShadow(project, document, tools);
    if (signal.aborted) {
      void fs.promises.rm(shadow.job, { recursive: true, force: true }).catch(() => undefined);
      return { cancelled: true };
    }
    const configuration = this.configuration(document.uri);
    const timeoutMs = projectSetting(configuration, 'compiler.timeoutSeconds', 120) * 1000;
    this.status.text = '$(sync~spin) Compiling';
    this.status.detail = project ? `${path.basename(project.projectPath)} ${project.configuration}/${project.platform}` : path.basename(document.fileName);
    let executable;
    let args;
    let cwd;
    const isolatedCompiler = this.isolatedCompilerEnvironment(tools, project);
    const focusKey = normalizeKey(document.fileName);
    const directlyIncluded = project && (project.mainSource && normalizeKey(project.mainSource) === focusKey
      || project.references.some((reference) => normalizeKey(reference) === focusKey));
    if (project && directlyIncluded && shadow.mainSource && fs.existsSync(tools.msbuild)) {
      executable = tools.msbuild;
      cwd = shadow.job;
      const searchPaths = uniquePaths([
        ...[...shadow.shadowByOriginal.values()].map(path.dirname),
        project.projectDir,
        ...project.references.map(path.dirname),
        ...project.searchPaths,
        ...isolatedCompiler.paths
      ]);
      args = [
        project.projectPath,
        '/nologo',
        '/v:minimal',
        '/t:Build',
        `/p:Config=${msbuildEscape(project.configuration)}`,
        `/p:Platform=${msbuildEscape(project.platform)}`,
        `/p:MainSource=${msbuildEscape(shadow.mainSource)}`,
        `/p:DCC_DcuOutput=${msbuildEscape(path.join(shadow.cache, 'dcu'))}`,
        `/p:DCC_ExeOutput=${msbuildEscape(path.join(shadow.cache, 'bin'))}`,
        `/p:DCC_BplOutput=${msbuildEscape(path.join(shadow.cache, 'bin'))}`,
        `/p:DCC_DcpOutput=${msbuildEscape(path.join(shadow.cache, 'dcu'))}`,
        `/p:DCC_ObjOutput=${msbuildEscape(path.join(shadow.cache, 'obj'))}`,
        `/p:DCC_HppOutput=${msbuildEscape(path.join(shadow.cache, 'hpp'))}`,
        `/p:DCC_ResourceOutput=${msbuildEscape(path.join(shadow.cache, 'res'))}`,
        `/p:BRCC_OutputDir=${msbuildEscape(path.join(shadow.cache, 'res'))}`,
        `/p:DCC_UnitSearchPath=${msbuildEscape(searchPaths.join(';'))}`,
        `/p:DCC_IncludePath=${msbuildEscape(uniquePaths([project.projectDir, ...project.searchPaths]).join(';'))}`,
        `/p:DCC_ResourcePath=${msbuildEscape(uniquePaths([project.projectDir, ...project.searchPaths]).join(';'))}`
      ];
    } else {
      executable = project?.platform === 'Win64' && fs.existsSync(tools.dcc64) ? tools.dcc64 : tools.dcc32;
      cwd = path.dirname(document.fileName);
      const shadowUnit = shadow.shadowByOriginal.get(normalizeKey(document.fileName));
      if (!shadowUnit) throw new Error('Missing compiler shadow source');
      const unitPaths = uniquePaths([
        ...[...shadow.shadowByOriginal.values()].map(path.dirname),
        cwd,
        project?.projectDir,
        ...(project?.references || []).map(path.dirname),
        ...(project?.searchPaths || []),
        ...isolatedCompiler.paths
      ]);
      args = [
        '-Q',
        `-NU${path.join(shadow.cache, 'dcu')}`,
        `-U${unitPaths.join(';')}`,
        `-I${unitPaths.join(';')}`,
        `-R${unitPaths.join(';')}`,
        ...(project?.defines?.length ? [`-D${project.defines.join(';')}`] : []),
        shadowUnit
      ];
    }
    this.output.appendLine(
      `Background compiler path isolation: excluded ${isolatedCompiler.excludedCount} `
      + `navigation/LSP source path(s); retained ${isolatedCompiler.paths.length} compiler path(s).`
    );
    this.output.appendLine(`Background compile: ${executable} ${args.join(' ')}`);
    try {
      const result = await execFileResult(
        executable,
        args,
        // Keep output as bytes until it is decoded as UTF-8 for diagnostic parsing.
        { cwd, env: isolatedCompiler.environment, encoding: 'buffer' },
        signal,
        timeoutMs
      );
      if (document.isClosed || document.version !== version || signal.aborted) return { stale: true };
      const compilerOutput = `${decodeProcessOutput(result.stdout)}\n${decodeProcessOutput(result.stderr)}`;
      const parsed = parseCompilerOutput(compilerOutput);
      if (result.exitCode !== 0 && parsed.length === 0) {
        const meaningful = compilerOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        const summary = (meaningful.find(line => /(?:error|fatal|MSB\d+)/i.test(line))
          || meaningful[meaningful.length - 1]
          || `Compiler exited with code ${result.exitCode}.`).slice(0, 500);
        parsed.push({
          severity: 'error',
          file: project?.mainSource || document.fileName,
          line: 1,
          column: 0,
          code: 'BUILD_FAILED',
          raw: summary,
          message: `Background compiler failed: ${summary}`
        });
      }
      this.output.appendLine(`Background compile completed: exit=${result.exitCode}, diagnostics=${parsed.length}.`);
      if (result.exitCode !== 0) {
        this.output.appendLine('Background compiler output:');
        this.output.appendLine(compilerOutput.trim() || '(no output)');
      }
      this.publishCompiler(projectKey, project, document, parsed, shadow);
      this.updateReadyStatus();
      return { diagnostics: parsed.length, exitCode: result.exitCode };
    } catch (error) {
      if (isRecord(error) && error.cancelled) return { cancelled: true };
      this.status.text = (isRecord(error) && error.timedOut) ? '$(watch) Compiler timed out' : '$(error) Compiler failed';
      this.status.detail = errorMessage(error);
      this.output.appendLine(`Background compilation ${(isRecord(error) && error.timedOut) ? 'timed out' : 'failed'}: ${errorMessage(error)}`);
      return { error };
    } finally {
      void fs.promises.rm(shadow.job, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  sourcePathForDiagnostic(item: Pick<CompilerDiagnostic, "file">, project: ProjectInfo | undefined, focusDocument: Pick<vscode.TextDocument, "fileName">, shadow: { originalByShadow: Map<string, string> }) {
    if (!item.file) return project?.mainSource || focusDocument.fileName;
    let candidate = item.file.replace(/^"|"$/g, '');
    const mapped = shadow.originalByShadow.get(normalizeKey(candidate));
    if (mapped) return mapped;
    if (!path.isAbsolute(candidate) && project) candidate = path.resolve(project.projectDir, candidate);
    if (fs.existsSync(candidate)) return candidate;
    const basename = path.basename(candidate).toLowerCase();
    const possible = uniquePaths([
      focusDocument.fileName,
      project?.mainSource,
      ...(project?.references || [])
    ]).filter(value => path.basename(value).toLowerCase() === basename);
    return possible.length === 1 ? possible[0] : project?.mainSource || focusDocument.fileName;
  }

  publishCompiler(projectKey: string, project: ProjectInfo | undefined, focusDocument: vscode.TextDocument, parsed: CompilerDiagnostic[], shadow: Awaited<ReturnType<BackgroundDiagnostics["createShadow"]>>) {
    const includeWarnings = projectSetting(this.configuration(focusDocument.uri), 'compiler.includeWarnings', true);
    const grouped = new Map<string, { uri: vscode.Uri; diagnostics: vscode.Diagnostic[] }>();
    for (const item of parsed) {
      if (item.severity === 'hint' || (item.severity === 'warning' && !includeWarnings)) continue;
      if ([...grouped.values()].reduce((sum, values) => sum + values.diagnostics.length, 0) >= MAX_DIAGNOSTICS) break;
      const sourcePath = this.sourcePathForDiagnostic(item, project, focusDocument, shadow);
      const uri = vscode.Uri.file(sourcePath);
      let text = documentText(vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString()));
      if (text === undefined) {
        try { text = decodePascalBytes(fs.readFileSync(sourcePath)); } catch { text = ''; }
      }
      const value = new vscode.Diagnostic(rangeForText(text, item.line, item.column, item.message), item.message, severityForVscode(item.severity || 'error'));
      value.source = 'Delphi Compiler (background)';
      value.code = item.code;
      const existing = vscode.languages.getDiagnostics(uri).filter(diagnostic =>
        diagnostic.source !== 'Delphi Compiler (background)' && diagnostic.source !== 'Pascal Atlas Syntax');
      if (existing.some(diagnostic => overlaps(diagnostic, value)
        && (diagnostic.code === value.code || diagnostic.message.toLowerCase() === value.message.toLowerCase()))) continue;
      if (!grouped.has(uri.toString())) grouped.set(uri.toString(), { uri, diagnostics: [] });
      grouped.get(uri.toString())?.diagnostics.push(value);
    }

    const previousUris = this.compilerUrisByProject.get(projectKey) || new Set();
    const nextUris = new Set(grouped.keys());
    for (const previous of previousUris) {
      if (!nextUris.has(previous)) {
        this.compilerCollection.delete(vscode.Uri.parse(previous));
        this.compilerCounts.delete(previous);
      }
    }
    for (const { uri, diagnostics } of grouped.values()) {
      const unique = [...new Map(diagnostics.map((item) => [diagnosticIdentity(item), item])).values()];
      this.compilerCollection.set(uri, unique);
      this.compilerCounts.set(uri.toString(), unique.length);
      this.publishSyntax(uri);
    }
    this.compilerUrisByProject.set(projectKey, nextUris);
    if (parsed.length > MAX_DIAGNOSTICS) this.output.appendLine(`Background compiler diagnostics truncated at ${MAX_DIAGNOSTICS}.`);
  }

  updateReadyStatus() {
    const count = [...this.compilerCounts.values()].reduce((sum, value) => sum + value, 0);
    this.status.text = count > 0 ? `$(error) Delphi diagnostics: ${count}` : '$(check) Delphi diagnostics ready';
    this.status.detail = count > 0 ? `${count} background compiler issue(s).` : 'No background compiler errors or warnings.';
  }

  clearDiagnostics() {
    this.syntaxCollection.clear();
    this.compilerCollection.clear();
    this.rawSyntax.clear();
    this.compilerUrisByProject.clear();
    this.compilerCounts.clear();
    this.requestedCompilerVersions.clear();
    this.updateReadyStatus();
  }

  clearCompilerForUri(uri: vscode.Uri) {
    const key = uri.toString();
    this.compilerCollection.delete(uri);
    this.compilerCounts.delete(key);
    for (const uris of this.compilerUrisByProject.values()) uris.delete(key);
    this.publishSyntax(uri);
    this.updateReadyStatus();
  }

  async clearCache() {
    this.pool.cancelAll('cache cleared');
    const cacheRoot = path.join(this.storageRoot(), 'compiler-cache');
    const resolvedStorage = path.resolve(this.storageRoot());
    const resolvedCache = path.resolve(cacheRoot);
    if (!resolvedCache.startsWith(`${resolvedStorage}${path.sep}`)) throw new Error('Refusing to clear compiler cache outside extension storage.');
    await fs.promises.rm(resolvedCache, { recursive: true, force: true });
    this.output.appendLine(`Cleared background compiler cache: ${resolvedCache}`);
  }

  suspendCompiler(reason = 'suspended') {
    this.compilerSuspensions += 1;
    if (this.compilerSuspensions === 1) {
      clearTimeout(this.startupCompilerTimer);
      this.startupCompilerTimer = undefined;
      for (const timer of this.compilerTimers.values()) clearTimeout(timer);
      this.compilerTimers.clear();
      this.pool.cancelAll(reason);
      this.output.appendLine(`Background compiler suspended: ${reason}.`);
    }
  }

  resumeCompiler(reason = 'resumed') {
    this.compilerSuspensions = Math.max(0, this.compilerSuspensions - 1);
    if (this.compilerSuspensions === 0) {
      this.output.appendLine(`Background compiler resumed: ${reason}.`);
    }
  }

  async cleanupOldJobs() {
    const jobs = path.join(this.storageRoot(), 'jobs');
    let entries;
    try { entries = await fs.promises.readdir(jobs, { withFileTypes: true }); } catch { return; }
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.resolve(jobs, entry.name);
      if (!target.startsWith(`${path.resolve(jobs)}${path.sep}`)) continue;
      try {
        const stat = await fs.promises.stat(target);
        if (stat.mtimeMs < cutoff) await fs.promises.rm(target, { recursive: true, force: true });
      } catch {}
    }
  }

  async runNow() {
    const document = vscode.window.activeTextEditor?.document;
    if (!document || !isPascalDocument(document)) return;
    this.scheduleSyntax(document, true);
    this.scheduleCompiler(document, true);
  }

  showStatus() {
    this.output.show(true);
    this.output.appendLine(`Diagnostic status: ${this.status.text} — ${this.status.detail || ''}`);
    this.output.appendLine(`Projects: ${this.projects.length}; compiler jobs running=${this.pool.running.size}, queued=${this.pool.queued.size}.`);
  }

  register() {
    this.refreshProjects();
    void this.cleanupOldJobs();
    const schedule = (document: vscode.TextDocument) => {
      if (!this.enabled(document)) return;
      this.scheduleSyntax(document);
      this.scheduleCompiler(document);
    };
    const scheduleInteractive = (document: vscode.TextDocument) => {
      if (!this.enabled(document)) return;
      // Opening or focusing a clean file changes neither the project nor its
      // compiler inputs. Lightweight syntax diagnostics can refresh, but a
      // full MSBuild here only steals I/O/CPU from navigation and coloring.
      this.scheduleSyntax(document);
    };
    this.context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(scheduleInteractive),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (isPascalDocument(event.document)) this.clearCompilerForUri(event.document.uri);
        schedule(event.document);
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        const key = document.uri.toString();
        clearTimeout(this.syntaxTimers.get(key));
        clearTimeout(this.compilerTimers.get(key));
        this.syntaxTimers.delete(key);
        this.compilerTimers.delete(key);
        this.rawSyntax.delete(key);
        this.syntaxCollection.delete(document.uri);
      }),
      vscode.window.onDidChangeActiveTextEditor(editor => {
        if (!editor || !this.enabled(editor.document)) return;
        scheduleInteractive(editor.document);
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (!event.affectsConfiguration('pascalAtlas.diagnostics')
          && !event.affectsConfiguration('pascalAtlas.enabled')) return;
        this.rebuildPool();
        this.refreshProjects();
        this.clearDiagnostics();
        for (const document of vscode.workspace.textDocuments) schedule(document);
      }),
      vscode.commands.registerCommand(CommandId.DiagnosticsRunNow, () => this.runNow()),
      vscode.commands.registerCommand(CommandId.DiagnosticsClear, () => this.clearDiagnostics()),
      vscode.commands.registerCommand(CommandId.DiagnosticsClearCache, async () => {
        await this.clearCache();
        void vscode.window.showInformationMessage('Pascal Atlas compiler cache cleared.');
      }),
      vscode.commands.registerCommand(CommandId.DiagnosticsShowStatus, () => this.showStatus())
    );
    for (const folder of vscode.workspace.workspaceFolders || []) {
      for (const pattern of ['.vallenta/projects.json', '.vallenta/projects.local.json', '**/*.groupproj', '**/*.dproj']) {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
        const changed = () => {
          this.pool.cancelAll('project configuration changed');
          this.refreshProjects();
          for (const document of vscode.workspace.textDocuments) schedule(document);
        };
        watcher.onDidCreate(changed);
        watcher.onDidChange(changed);
        watcher.onDidDelete(changed);
        this.context.subscriptions.push(watcher);
      }
    }
    // Syntax analysis is cheap enough for every open document. Compilation is
    // intentionally started only for the active one; changed/opened documents
    // are scheduled by the listeners above. This keeps reload from launching a
    // compiler queue for every old tab before navigation and coloring are warm.
    for (const document of vscode.workspace.textDocuments) this.scheduleSyntax(document);
    const activeDocument = vscode.window.activeTextEditor?.document;
    if (activeDocument) {
      const startupDelay = projectSetting(
        this.configuration(activeDocument.uri),
        'compiler.startupDelayMs',
        20000
      );
      this.startupCompilerTimer = setTimeout(() => {
        this.startupCompilerTimer = undefined;
        this.scheduleCompiler(activeDocument, true);
      }, startupDelay);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.startupCompilerTimer);
    for (const timer of this.syntaxTimers.values()) clearTimeout(timer);
    for (const timer of this.compilerTimers.values()) clearTimeout(timer);
    this.pool.cancelAll('extension disposed');
    this.syntaxClient.dispose();
  }
}

export {
  BackgroundDiagnostics,
  execFileResult,
  findDelphiInstallation,
  rangeForText,
  readRsvarsEnvironment
};
