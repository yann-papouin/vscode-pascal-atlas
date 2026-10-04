'use strict';

const STATE_KEY = 'pascalAtlas.encoding.managedSettings.v1';
const DPROJ_LANGUAGE_ID = 'pascal-atlas-dproj';
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
    'utf-8': 'utf8', utf8: 'utf8', 'utf-8-bom': 'utf8bom', utf8bom: 'utf8bom'
  })[normalized];
}

function supportedEncoding(value, fallback = 'utf8') {
  if (value === 'utf8' || value === 'utf8bom') return value;
  return fallback === 'utf8bom' ? 'utf8bom' : 'utf8';
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
  if (!bytes || bytes.length < 3) return undefined;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf8bom';
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

function decodePascalBytes(bytes) {
  if (!bytes?.length) return '';
  return new TextDecoder('utf-8').decode(bytes);
}

function decodeProcessOutput(value) {
  if (typeof value === 'string') return value;
  return decodePascalBytes(value);
}

function reconciledEncoding(bytes, fallback, explicitEncoding) {
  const explicit = normalizeXmlEncoding(explicitEncoding);
  if (explicit) return explicit;
  const bom = bomEncoding(bytes);
  if (bom) return bom;
  if (isAscii(bytes)) return supportedEncoding(fallback);
  return isValidUtf8(bytes) ? 'utf8' : supportedEncoding(fallback);
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
        if (event.affectsConfiguration('pascalAtlas.encoding')
          || event.affectsConfiguration('pascalAtlas.enabled')) void this.sync();
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
    const pa = vscode.workspace.getConfiguration('pascalAtlas');
    const enabled = pa.get('enabled', true) && pa.get('encoding.enabled', true);
    if (!enabled) return this.restore();

    const delphiEncoding = supportedEncoding(pa.get('encoding.delphiDefault', 'utf8'));
    const otherEncoding = supportedEncoding(pa.get('encoding.otherDefault', 'utf8'));
    const target = configurationTarget(vscode);
    const store = target.id === 'workspace' ? this.context.workspaceState : this.context.globalState;
    let state = store.get(STATE_KEY);
    if (!state || state.target !== target.id) state = this.capture(target);

    const globalFiles = vscode.workspace.getConfiguration('files');
    const previousAutoGuess = state.previous?.autoGuessEncoding;
    const previousLanguageAutoGuess = Object.values(state.previous?.languages || {}).some(value => value.autoGuessEncoding);
    if (previousAutoGuess || previousLanguageAutoGuess) {
      await globalFiles.update(
        'autoGuessEncoding',
        previousAutoGuess?.exists ? previousAutoGuess.value : undefined,
        target.value,
        false
      );
      for (const languageId of DELPHI_LANGUAGE_IDS) {
        const previous = state.previous.languages?.[languageId]?.autoGuessEncoding;
        const files = vscode.workspace.getConfiguration('files', configurationScope(vscode, languageId));
        await files.update('autoGuessEncoding', previous?.exists ? previous.value : undefined, target.value, true);
      }
      delete state.previous.autoGuessEncoding;
      for (const previous of Object.values(state.previous.languages || {})) delete previous.autoGuessEncoding;
    }
    await globalFiles.update('encoding', otherEncoding, target.value, false);
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const files = vscode.workspace.getConfiguration('files', configurationScope(vscode, languageId));
      await files.update('encoding', delphiEncoding, target.value, true);
    }

    const associations = { ...(targetValue(globalFiles.inspect('associations'), target.id, false) || {}) };
    for (const pattern of DPROJ_ASSOCIATIONS) associations[pattern] = DPROJ_LANGUAGE_ID;
    await globalFiles.update('associations', associations, target.value, false);
    state.applied = { delphiEncoding, otherEncoding };
    await store.update(STATE_KEY, state);
    this.output?.appendLine(
      `Encoding policy active (${target.id}): Delphi fallback=${delphiEncoding}, `
      + `other fallback=${otherEncoding}.`
    );
  }

  capture(target) {
    const vscode = this.vscode;
    const globalFiles = vscode.workspace.getConfiguration('files');
    const languages = {};
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const files = vscode.workspace.getConfiguration('files', configurationScope(vscode, languageId));
      languages[languageId] = {
        encoding: valueSlot(targetValue(files.inspect('encoding'), target.id, true))
      };
    }
    const associationValues = targetValue(globalFiles.inspect('associations'), target.id, false) || {};
    return {
      target: target.id,
      previous: {
        encoding: valueSlot(targetValue(globalFiles.inspect('encoding'), target.id, false)),
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
    for (const languageId of DELPHI_LANGUAGE_IDS) {
      const previous = state.previous.languages[languageId];
      const files = vscode.workspace.getConfiguration('files', configurationScope(vscode, languageId));
      await files.update('encoding', previous.encoding.exists ? previous.encoding.value : undefined, target.value, true);
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
    const pa = this.vscode.workspace.getConfiguration('pascalAtlas', document.uri);
    if (!pa.get('enabled', true)
      || !pa.get('encoding.enabled', true)
      || !pa.get('encoding.respectDprojDeclaration', true)) return;
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
    const pa = this.vscode.workspace.getConfiguration('pascalAtlas', document.uri);
    if (!pa.get('enabled', true) || !pa.get('encoding.enabled', true)) return;
    if (!pa.get('encoding.detectExisting', true)) return;
    if (isDprojDocument(document) && pa.get('encoding.respectDprojDeclaration', true)) {
      await this.honorDprojDeclaration(document);
      if (document.isClosed || document.isDirty) return;
    }
    if (typeof document.encoding !== 'string') return;
    const fileName = document.uri.fsPath || document.fileName || '';
    const delphi = /\.(?:pas|dpr|dpk|dproj)$/i.test(fileName);
    const fallback = supportedEncoding(pa.get(delphi ? 'encoding.delphiDefault' : 'encoding.otherDefault', 'utf8'));
    const key = document.uri.toString();
    if (this.reopening.has(key)) return;
    try {
      const bytes = await this.vscode.workspace.fs.readFile(document.uri);
      const explicit = bomEncoding(bytes)
        || (isDprojDocument(document) ? declaredXmlEncoding(bytes) : undefined);
      const desired = reconciledEncoding(bytes, fallback, explicit);
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
  registerEncodingSupport,
  supportedEncoding
};
