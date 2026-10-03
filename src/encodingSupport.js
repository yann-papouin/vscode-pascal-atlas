'use strict';

const STATE_KEY = 'pascalUnion.encoding.managedSettings.v1';
const DPROJ_LANGUAGE_ID = 'pascal-union-dproj';
const DELPHI_LANGUAGE_IDS = Object.freeze(['pascal', 'objectpascal', DPROJ_LANGUAGE_ID]);
const DPROJ_ASSOCIATIONS = Object.freeze(['*.dproj', '*.DPROJ']);

function valueSlot(value) {
  return value === undefined ? { exists: false } : { exists: true, value };
}

function targetValue(inspected, target, languageOverride) {
  if (!inspected) return undefined;
  if (target === 'workspace') {
    return languageOverride ? inspected.workspaceLanguageValue : inspected.workspaceValue;
  }
  return languageOverride ? inspected.globalLanguageValue : inspected.globalValue;
}

function configurationTarget(vscode) {
  return vscode.workspace.workspaceFolders?.length
    ? { id: 'workspace', value: vscode.ConfigurationTarget.Workspace }
    : { id: 'global', value: vscode.ConfigurationTarget.Global };
}

function configurationScope(vscode, languageId) {
  return { uri: vscode.workspace.workspaceFolders?.[0]?.uri, languageId };
}

function normalizeXmlEncoding(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/[_\s]/g, '-');
  return ({
    'utf-8': 'utf8', utf8: 'utf8', 'utf-8-bom': 'utf8bom',
    gb2312: 'gb2312', 'gb-2312': 'gb2312', gbk: 'gbk', cp936: 'gbk',
    gb18030: 'gb18030', 'utf-16': 'utf16le', 'utf-16le': 'utf16le',
    'utf-16be': 'utf16be'
  })[normalized];
}

function declaredXmlEncoding(bytes) {
  if (!bytes?.length) return undefined;
  const prefix = Array.from(bytes.subarray(0, Math.min(bytes.length, 1024)), byte =>
    byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : ' '
  ).join('');
  const match = prefix.match(/<\?xml\b[^>]*\bencoding\s*=\s*['"]([^'"]+)['"]/i);
  return normalizeXmlEncoding(match?.[1]);
}

function bomEncoding(bytes) {
  if (!bytes || bytes.length < 2) return undefined;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf8bom';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf16be';
  return undefined;
}

function isAscii(bytes) {
  return Boolean(bytes) && bytes.every(byte => byte < 0x80);
}

function isValidUtf8(bytes) {
  if (!bytes) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function decodePascalBytes(bytes, fallback = 'gb18030') {
  if (!bytes?.length) return '';
  const bom = bomEncoding(bytes);
  let encoding = bom || (isValidUtf8(bytes) ? 'utf8' : normalizeXmlEncoding(fallback) || fallback);
  if (encoding === 'utf8bom') encoding = 'utf8';
  const labels = {
    utf8: 'utf-8',
    utf16le: 'utf-16le',
    utf16be: 'utf-16be',
    gb2312: 'gb18030',
    gbk: 'gb18030'
  };
  try {
    return new TextDecoder(labels[encoding] || encoding).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

function decodeProcessOutput(value, fallback = 'gb18030') {
  if (typeof value === 'string') return value;
  return decodePascalBytes(value, fallback);
}

function reconciledEncoding(bytes, currentEncoding, fallback, pasFile, explicitEncoding) {
  if (explicitEncoding) return explicitEncoding;
  if (!pasFile && currentEncoding !== 'utf8') return currentEncoding;
  if (isAscii(bytes)) return fallback;
  return isValidUtf8(bytes) ? 'utf8' : fallback;
}

function isDprojDocument(document) {
  return document?.uri?.scheme === 'file' && /\.dproj$/i.test(document.uri.fsPath || document.fileName || '');
}

class EncodingPolicy {
  constructor(context, output, vscodeApi) {
    this.context = context;
    this.output = output;
    this.vscode = vscodeApi || require('vscode');
    this.applying = Promise.resolve();
    this.reopening = new Set();
  }

  register() {
    const vscode = this.vscode;
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('pascalUnion.encoding')
          || event.affectsConfiguration('pascalUnion.enabled')) void this.sync();
      }),
      vscode.workspace.onDidOpenTextDocument(document => {
        void this.applying.then(() => this.reconcileOpenDocument(document));
      })
    );
    void this.sync().then(() => Promise.all(
      (vscode.workspace.textDocuments || []).map(document => this.reconcileOpenDocument(document))
    ));
  }

  sync() {
    this.applying = this.applying
      .then(() => this.applyCurrentConfiguration())
      .catch(error => this.output?.appendLine(`Encoding policy update failed: ${error.stack || error.message}`));
    return this.applying;
  }

  async applyCurrentConfiguration() {
    const vscode = this.vscode;
    const union = vscode.workspace.getConfiguration('pascalUnion');
    const enabled = union.get('enabled', true) && union.get('encoding.enabled', true);
    if (!enabled) return this.restore();

    const delphiEncoding = union.get('encoding.delphiDefault', 'gb2312');
    const otherEncoding = union.get('encoding.otherDefault', 'utf8');
    const detectExisting = union.get('encoding.detectExisting', true);
    const target = configurationTarget(vscode);
    const store = target.id === 'workspace' ? this.context.workspaceState : this.context.globalState;
    let state = store.get(STATE_KEY);
    if (!state || state.target !== target.id) state = this.capture(target);

    const globalFiles = vscode.workspace.getConfiguration('files');
    await globalFiles.update('encoding', otherEncoding, target.value, false);
    await globalFiles.update('autoGuessEncoding', detectExisting, target.value, false);
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const files = vscode.workspace.getConfiguration('files', configurationScope(vscode, languageId));
      await files.update('encoding', delphiEncoding, target.value, true);
      await files.update('autoGuessEncoding', detectExisting, target.value, true);
    }

    const associations = { ...(targetValue(globalFiles.inspect('associations'), target.id, false) || {}) };
    for (const pattern of DPROJ_ASSOCIATIONS) associations[pattern] = DPROJ_LANGUAGE_ID;
    await globalFiles.update('associations', associations, target.value, false);
    state.applied = { delphiEncoding, otherEncoding, detectExisting };
    await store.update(STATE_KEY, state);
    this.output?.appendLine(
      `Encoding policy active (${target.id}): Delphi fallback=${delphiEncoding}, `
      + `other fallback=${otherEncoding}, detect existing=${detectExisting}.`
    );
  }

  capture(target) {
    const vscode = this.vscode;
    const globalFiles = vscode.workspace.getConfiguration('files');
    const languages = {};
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const files = vscode.workspace.getConfiguration('files', configurationScope(vscode, languageId));
      languages[languageId] = {
        encoding: valueSlot(targetValue(files.inspect('encoding'), target.id, true)),
        autoGuessEncoding: valueSlot(targetValue(files.inspect('autoGuessEncoding'), target.id, true))
      };
    }
    const associationValues = targetValue(globalFiles.inspect('associations'), target.id, false) || {};
    return {
      target: target.id,
      previous: {
        encoding: valueSlot(targetValue(globalFiles.inspect('encoding'), target.id, false)),
        autoGuessEncoding: valueSlot(targetValue(globalFiles.inspect('autoGuessEncoding'), target.id, false)),
        associations: Object.fromEntries(DPROJ_ASSOCIATIONS.map(pattern => [pattern, valueSlot(associationValues[pattern])])),
        languages
      }
    };
  }

  async restore() {
    const vscode = this.vscode;
    const target = configurationTarget(vscode);
    const store = target.id === 'workspace' ? this.context.workspaceState : this.context.globalState;
    const state = store.get(STATE_KEY);
    if (!state || state.target !== target.id) return;
    const globalFiles = vscode.workspace.getConfiguration('files');
    await globalFiles.update('encoding', state.previous.encoding.exists ? state.previous.encoding.value : undefined, target.value, false);
    await globalFiles.update(
      'autoGuessEncoding',
      state.previous.autoGuessEncoding.exists ? state.previous.autoGuessEncoding.value : undefined,
      target.value,
      false
    );
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const previous = state.previous.languages[languageId];
      const files = vscode.workspace.getConfiguration('files', configurationScope(vscode, languageId));
      await files.update('encoding', previous.encoding.exists ? previous.encoding.value : undefined, target.value, true);
      await files.update(
        'autoGuessEncoding',
        previous.autoGuessEncoding.exists ? previous.autoGuessEncoding.value : undefined,
        target.value,
        true
      );
    }
    const associations = { ...(targetValue(globalFiles.inspect('associations'), target.id, false) || {}) };
    for (const pattern of DPROJ_ASSOCIATIONS) {
      const previous = state.previous.associations[pattern];
      if (previous.exists) associations[pattern] = previous.value;
      else if (associations[pattern] === DPROJ_LANGUAGE_ID) delete associations[pattern];
    }
    await globalFiles.update('associations', Object.keys(associations).length ? associations : undefined, target.value, false);
    await store.update(STATE_KEY, undefined);
    this.output?.appendLine(`Encoding policy disabled; restored previous ${target.id} encoding settings.`);
  }

  async honorDprojDeclaration(document) {
    if (!isDprojDocument(document) || document.isDirty || typeof document.encoding !== 'string') return;
    const key = document.uri.toString();
    if (this.reopening.has(key)) return;
    const union = this.vscode.workspace.getConfiguration('pascalUnion', document.uri);
    if (!union.get('enabled', true)
      || !union.get('encoding.enabled', true)
      || !union.get('encoding.respectDprojDeclaration', true)) return;
    try {
      const bytes = await this.vscode.workspace.fs.readFile(document.uri);
      const declared = declaredXmlEncoding(bytes);
      if (!declared || declared === document.encoding) return;
      this.reopening.add(key);
      await this.vscode.workspace.openTextDocument(document.uri, { encoding: declared });
      this.output?.appendLine(`Reopened ${document.uri.fsPath} as ${declared} to honor its XML encoding declaration.`);
    } catch (error) {
      this.output?.appendLine(`Could not honor DPROJ encoding declaration: ${error.message}`);
    } finally {
      this.reopening.delete(key);
    }
  }

  async reconcileOpenDocument(document) {
    if (!document || document.uri?.scheme !== 'file' || document.isDirty) return;
    const union = this.vscode.workspace.getConfiguration('pascalUnion', document.uri);
    if (!union.get('enabled', true) || !union.get('encoding.enabled', true)) return;
    if (isDprojDocument(document) && union.get('encoding.respectDprojDeclaration', true)) {
      await this.honorDprojDeclaration(document);
      if (document.isClosed || document.isDirty) return;
    }
    if (typeof document.encoding !== 'string') return;
    const fileName = document.uri.fsPath || document.fileName || '';
    const pasFile = /\.pas$/i.test(fileName);
    // For .pas, only a positive UTF-8 check or an explicit encoding marker
    // may override the Delphi fallback. Guesses such as GBK/windows-1252 are
    // deliberately normalized back to GB2312 when the bytes are ambiguous.
    if (!pasFile && document.encoding !== 'utf8') return;

    const delphi = /\.(?:pas|dpr|dpk|dproj)$/i.test(fileName);
    const fallback = union.get(delphi ? 'encoding.delphiDefault' : 'encoding.otherDefault', delphi ? 'gb2312' : 'utf8');
    if (fallback === 'utf8') return;
    const key = document.uri.toString();
    if (this.reopening.has(key)) return;
    try {
      const bytes = await this.vscode.workspace.fs.readFile(document.uri);
      const explicit = bomEncoding(bytes)
        || (isDprojDocument(document) ? declaredXmlEncoding(bytes) : undefined);
      const desired = reconciledEncoding(bytes, document.encoding, fallback, pasFile, explicit);
      if (!desired || desired === document.encoding) return;
      this.reopening.add(key);
      await this.vscode.workspace.openTextDocument(document.uri, { encoding: desired });
      this.output?.appendLine(`Reopened ${document.uri.fsPath} as ${desired} after encoding-policy startup reconciliation.`);
    } catch (error) {
      this.output?.appendLine(`Could not reconcile document encoding: ${error.message}`);
    } finally {
      this.reopening.delete(key);
    }
  }
}

function registerEncodingSupport(context, output, vscodeApi) {
  const policy = new EncodingPolicy(context, output, vscodeApi);
  policy.register();
  return policy;
}

module.exports = {
  DELPHI_LANGUAGE_IDS,
  DPROJ_LANGUAGE_ID,
  EncodingPolicy,
  bomEncoding,
  decodePascalBytes,
  decodeProcessOutput,
  declaredXmlEncoding,
  isAscii,
  isValidUtf8,
  normalizeXmlEncoding,
  reconciledEncoding,
  registerEncodingSupport
};
