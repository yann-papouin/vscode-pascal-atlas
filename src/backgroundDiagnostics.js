'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { discoverLoadedProjects, normalizeKey } = require('./projectDiscovery');
const { decodePascalBytes, decodeProcessOutput } = require('./encodingSupport');
const {
  ProjectTaskPool,
  cacheKey,
  compilerEnvironmentWithSearchPath,
  excludeManagedSourcePaths,
  parseCompilerOutput,
  readActiveProject,
  readProjectInfo,
  resolveOwningProject,
  rewritePascalPaths
} = require('./diagnosticCore');

const PASCAL_LANGUAGES = new Set(['pascal', 'objectpascal']);
const MAX_DIAGNOSTICS = 200;
const MANAGED_PATHS_KEY = 'pascalAtlas.managedPaths';
const GLOBAL_MANAGED_PATHS_KEY = 'pascalAtlas.globalManagedPaths';

function isPascalDocument(document) {
  return PASCAL_LANGUAGES.has(document.languageId) && document.uri.scheme === 'file';
}

function uniquePaths(values) {
  const result = [];
  const seen = new Set();
  for (const value of values.filter(Boolean)) {
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

function expandCompilerPaths(values, tools, project) {
  const properties = {
    ...tools.environment,
    BDS: tools.installation,
    BDSLIB: path.join(tools.installation, 'lib'),
    Platform: project?.platform || 'Win32',
    Config: project?.configuration || 'Debug'
  };
  const lookup = new Map(Object.entries(properties).map(([key, value]) => [key.toLowerCase(), String(value || '')]));
  return values.map(value => String(value || '').replace(/\$\(([^)]+)\)/g,
    (whole, name) => lookup.get(name.toLowerCase()) || whole));
}

function shortHash(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function safeFilePart(value) {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_').slice(-80);
}

function msbuildEscape(value) {
  return String(value).replace(/%/g, '%25').replace(/;/g, '%3B');
}

function documentText(document) {
  return document?.getText();
}

function utf8Source(text) {
  return text.startsWith('\uFEFF') ? text : `\uFEFF${text}`;
}

function severityForVscode(value) {
  if (value === 'warning') return vscode.DiagnosticSeverity.Warning;
  if (value === 'hint') return vscode.DiagnosticSeverity.Hint;
  return vscode.DiagnosticSeverity.Error;
}

function rangeForText(text, lineNumber, column, message) {
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

function diagnosticIdentity(item) {
  return `${item.range.start.line}:${item.range.start.character}:${item.code || ''}:${item.message.toLowerCase()}`;
}

function overlaps(left, right) {
  return Boolean(left.range.intersection(right.range));
}

function projectSetting(configuration, key, fallback) {
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

function readRsvarsEnvironment(rsvarsPath) {
  const environment = { ...process.env };
  const findValue = name => {
    const key = Object.keys(environment).find(item => item.toLowerCase() === name.toLowerCase());
    return key ? environment[key] : '';
  };
  for (const line of fs.readFileSync(rsvarsPath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*@?SET\s+([^=]+)=(.*)$/i.exec(line);
    if (!match) continue;
    environment[match[1].trim()] = match[2].replace(/%([^%]+)%/g, (_, name) => findValue(name));
  }
  return environment;
}

function execFileResult(file, args, options, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout;
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

class SyntaxWorkerClient {
  constructor(workerPath, output) {
    this.workerPath = workerPath;
    this.output = output;
    this.requests = new Map();
    this.nextId = 1;
    this.start();
  }

  start() {
    this.worker = new Worker(this.workerPath);
    this.worker.on('message', response => {
      const request = this.requests.get(response.id);
      if (!request) return;
      this.requests.delete(response.id);
      response.error ? request.reject(new Error(response.error)) : request.resolve(response);
    });
    this.worker.on('error', error => {
      this.output.appendLine(`Syntax worker failed: ${error.stack || error.message}`);
      for (const request of this.requests.values()) request.reject(error);
      this.requests.clear();
    });
  }

  analyze(document, defines) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({
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
    void this.worker.terminate();
  }
}

class BackgroundDiagnostics {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.syntaxCollection = vscode.languages.createDiagnosticCollection('pascalAtlas.syntax');
    this.compilerCollection = vscode.languages.createDiagnosticCollection('pascalAtlas.compiler');
    this.syntaxClient = new SyntaxWorkerClient(context.asAbsolutePath(path.join('src', 'syntaxWorker.js')), output);
    this.syntaxTimers = new Map();
    this.compilerTimers = new Map();
    this.rawSyntax = new Map();
    this.compilerUrisByProject = new Map();
    this.compilerCounts = new Map();
    this.requestedCompilerVersions = new Map();
    this.startupCompilerTimer = undefined;
    this.projects = [];
    this.activeProjects = new Map();
    this.environmentPromise = undefined;
    this.unavailableNotified = false;
    this.compilerSuspensions = 0;
    this.status = vscode.languages.createLanguageStatusItem('pascalAtlas.diagnostics', [
      { language: 'pascal', scheme: 'file' },
      { language: 'objectpascal', scheme: 'file' }
    ]);
    this.status.name = 'Pascal Atlas Diagnostics';
    this.status.text = '$(check) Delphi diagnostics ready';
    this.status.detail = 'Syntax worker and background compiler are ready.';
    this.rebuildPool();
    context.subscriptions.push(this.syntaxCollection, this.compilerCollection, this.status, {
      dispose: () => this.dispose()
    });
  }

  configuration(uri) {
    return vscode.workspace.getConfiguration('pascalAtlas', uri);
  }

  enabled(document) {
    return isPascalDocument(document)
      && this.configuration(document.uri).get('enabled', true)
      && projectSetting(this.configuration(document.uri), 'enabled', true);
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
          this.output.appendLine(`Diagnostic project skipped (${projectPath}): ${error.message}`);
        }
      }
    }
    this.projects = projects;
    this.output.appendLine(`Background diagnostics: ${projects.length} loaded Delphi project(s).`);
  }

  workspaceRootFor(filePath) {
    return (vscode.workspace.workspaceFolders || [])
      .filter(folder => {
        const relative = path.relative(folder.uri.fsPath, filePath);
        return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
      })
      .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0]?.uri.fsPath;
  }

  projectForDocument(document) {
    const root = this.workspaceRootFor(document.fileName);
    const active = root ? this.activeProjects.get(normalizeKey(root)) : undefined;
    return resolveOwningProject(document.fileName, this.projects, active);
  }

  scheduleSyntax(document, immediate = false) {
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

  async runSyntax(document) {
    if (document.isClosed || !this.enabled(document)) return;
    const project = this.projectForDocument(document);
    this.status.text = '$(sync~spin) Syntax checking';
    try {
      const response = await this.syntaxClient.analyze(document, project?.defines || []);
      if (document.isClosed || document.version !== response.version) return;
      const diagnostics = response.diagnostics.map(item => {
        const range = new vscode.Range(document.positionAt(item.offset), document.positionAt(item.offset + item.length));
        const value = new vscode.Diagnostic(range, item.message, severityForVscode(item.severity));
        value.source = 'Pascal Atlas Syntax';
        value.code = item.code;
        return value;
      });
      this.rawSyntax.set(document.uri.toString(), diagnostics);
      this.publishSyntax(document.uri);
      this.updateReadyStatus();
    } catch (error) {
      this.output.appendLine(`Syntax analysis failed for ${document.fileName}: ${error.message}`);
      this.status.text = '$(error) Syntax worker failed';
      this.status.detail = error.message;
    }
  }

  publishSyntax(uri) {
    const compilerDiagnostics = this.compilerCollection.get(uri) || [];
    const diagnostics = (this.rawSyntax.get(uri.toString()) || [])
      .filter(item => !compilerDiagnostics.some(compiled => overlaps(item, compiled)));
    this.syntaxCollection.set(uri, diagnostics);
  }

  scheduleCompiler(document, immediate = false) {
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

  documentPriority(document) {
    if (vscode.window.activeTextEditor?.document.uri.toString() === document.uri.toString()) return 100;
    if (vscode.window.visibleTextEditors.some(editor => editor.document.uri.toString() === document.uri.toString())) return 50;
    return 10;
  }

  preferredDocument(project, fallback) {
    const candidates = vscode.workspace.textDocuments.filter(document =>
      this.enabled(document) && (!project || this.projectForDocument(document)?.projectPath === project.projectPath));
    if (!candidates.some(document => document.uri.toString() === fallback.uri.toString())) candidates.push(fallback);
    return candidates.sort((left, right) => this.documentPriority(right) - this.documentPriority(left))[0];
  }

  async enqueueCompiler(document) {
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
    const result = await this.pool.enqueue(projectKey, this.documentPriority(focusDocument), signal =>
      this.compileDocument(focusDocument, project, version, projectKey, signal));
    if (this.requestedCompilerVersions.get(projectKey) === requestIdentity) this.requestedCompilerVersions.delete(projectKey);
    if (result?.error && !result.error.cancelled) {
      this.output.appendLine(`Background compiler task failed: ${result.error.stack || result.error.message}`);
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
    const globalPaths = this.context.globalState.get(GLOBAL_MANAGED_PATHS_KEY, []);
    const paths = Array.isArray(globalPaths) ? [...globalPaths] : [];
    for (const folder of vscode.workspace.workspaceFolders || []) {
      const workspacePaths = this.context.workspaceState.get(
        `${MANAGED_PATHS_KEY}:${folder.uri.fsPath}`,
        []
      );
      if (Array.isArray(workspacePaths)) paths.push(...workspacePaths);
    }
    return paths;
  }

  isolatedCompilerEnvironment(tools, project) {
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

  dirtyDocumentsForProject(project, focusDocument) {
    const candidates = vscode.workspace.textDocuments.filter(document =>
      isPascalDocument(document) && document.isDirty && (!project || this.projectForDocument(document)?.projectPath === project.projectPath));
    if (!candidates.some(document => document.uri.toString() === focusDocument.uri.toString())) candidates.push(focusDocument);
    return candidates;
  }

  async createShadow(project, focusDocument, tools) {
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
    const shadowByOriginal = new Map();
    const originalByShadow = new Map();
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
      await fs.promises.mkdir(path.dirname(shadow), { recursive: true });
      await fs.promises.writeFile(shadow, utf8Source(rewritePascalPaths(document.getText(), document.fileName, shadowByOriginal)), 'utf8');
    }

    let mainSource;
    if (project?.mainSource && fs.existsSync(project.mainSource)) {
      const openMain = vscode.workspace.textDocuments.find(document => normalizeKey(document.fileName) === normalizeKey(project.mainSource));
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

  async compileDocument(document, project, version, projectKey, signal) {
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
      || project.references.some(reference => normalizeKey(reference) === focusKey));
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
      if (error.cancelled) return { cancelled: true };
      this.status.text = error.timedOut ? '$(watch) Compiler timed out' : '$(error) Compiler failed';
      this.status.detail = error.message;
      this.output.appendLine(`Background compilation ${error.timedOut ? 'timed out' : 'failed'}: ${error.message}`);
      return { error };
    } finally {
      void fs.promises.rm(shadow.job, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  sourcePathForDiagnostic(item, project, focusDocument, shadow) {
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

  publishCompiler(projectKey, project, focusDocument, parsed, shadow) {
    const includeWarnings = projectSetting(this.configuration(focusDocument.uri), 'compiler.includeWarnings', true);
    const grouped = new Map();
    for (const item of parsed) {
      if (item.severity === 'hint' || (item.severity === 'warning' && !includeWarnings)) continue;
      if ([...grouped.values()].reduce((sum, values) => sum + values.length, 0) >= MAX_DIAGNOSTICS) break;
      const sourcePath = this.sourcePathForDiagnostic(item, project, focusDocument, shadow);
      const uri = vscode.Uri.file(sourcePath);
      let text = documentText(vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString()));
      if (text === undefined) {
        try { text = decodePascalBytes(fs.readFileSync(sourcePath)); } catch { text = ''; }
      }
      const value = new vscode.Diagnostic(rangeForText(text, item.line, item.column, item.message), item.message, severityForVscode(item.severity));
      value.source = 'Delphi Compiler (background)';
      value.code = item.code;
      const existing = vscode.languages.getDiagnostics(uri).filter(diagnostic =>
        diagnostic.source !== 'Delphi Compiler (background)' && diagnostic.source !== 'Pascal Atlas Syntax');
      if (existing.some(diagnostic => overlaps(diagnostic, value)
        && (diagnostic.code === value.code || diagnostic.message.toLowerCase() === value.message.toLowerCase()))) continue;
      if (!grouped.has(uri.toString())) grouped.set(uri.toString(), { uri, diagnostics: [] });
      grouped.get(uri.toString()).diagnostics.push(value);
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
      const unique = [...new Map(diagnostics.map(item => [diagnosticIdentity(item), item])).values()];
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

  clearCompilerForUri(uri) {
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
    const schedule = document => {
      if (!this.enabled(document)) return;
      this.scheduleSyntax(document);
      this.scheduleCompiler(document);
    };
    const scheduleInteractive = document => {
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
      vscode.commands.registerCommand('pascalAtlas.diagnostics.runNow', () => this.runNow()),
      vscode.commands.registerCommand('pascalAtlas.diagnostics.clear', () => this.clearDiagnostics()),
      vscode.commands.registerCommand('pascalAtlas.diagnostics.clearCache', async () => {
        await this.clearCache();
        void vscode.window.showInformationMessage('Pascal Atlas compiler cache cleared.');
      }),
      vscode.commands.registerCommand('pascalAtlas.diagnostics.showStatus', () => this.showStatus())
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

module.exports = {
  BackgroundDiagnostics,
  execFileResult,
  findDelphiInstallation,
  rangeForText,
  readRsvarsEnvironment
};
