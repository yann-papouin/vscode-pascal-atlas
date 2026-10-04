'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VALLENTA_COMMAND_PREFIX = 'vallenta.studio.';
const BACKUP_FILE = 'package.json.pascal-atlas-editor-context-backup';

function removeVallentaEditorContextMenus(manifest) {
  const editorContext = manifest?.contributes?.menus?.['editor/context'];
  if (!Array.isArray(editorContext)) return [];
  const removed = editorContext.filter(item =>
    typeof item?.command === 'string' && item.command.startsWith(VALLENTA_COMMAND_PREFIX));
  manifest.contributes.menus['editor/context'] = editorContext.filter(item => !removed.includes(item));
  return removed;
}

function removeVallentaForcedKeywordBold(manifest) {
  const defaults = manifest?.contributes?.configurationDefaults;
  const customizations = defaults?.['editor.tokenColorCustomizations'];
  const rules = customizations?.textMateRules;
  if (!Array.isArray(rules)) return [];
  const removed = rules.filter(rule =>
    rule?.name === 'Pascal: bold reserved words'
    || (/(?:^|\s)bold(?:\s|$)/i.test(rule?.settings?.fontStyle || '')
      && /keyword\.control\.pascal/i.test(String(rule?.scope || ''))
      && /storage\.type\.class\.pascal/i.test(String(rule?.scope || ''))));
  customizations.textMateRules = rules.filter(rule => !removed.includes(rule));
  if (customizations.textMateRules.length === 0) {
    delete defaults['editor.tokenColorCustomizations'];
  }
  return removed;
}

async function patchVallentaManifest(extensionPath, options = {}) {
  if (!extensionPath) return { changed: false, removed: [], removedKeywordStyles: [] };
  const manifestPath = path.join(extensionPath, 'package.json');
  const source = await fs.promises.readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(source.replace(/^\uFEFF/, ''));
  const removed = options.removeEditorContextMenus === false
    ? []
    : removeVallentaEditorContextMenus(manifest);
  const removedKeywordStyles = options.removeForcedKeywordBold === false
    ? []
    : removeVallentaForcedKeywordBold(manifest);
  if (removed.length === 0 && removedKeywordStyles.length === 0) {
    return { changed: false, removed, removedKeywordStyles };
  }

  const backupPath = path.join(extensionPath, BACKUP_FILE);
  try {
    await fs.promises.access(backupPath);
  } catch {
    await fs.promises.writeFile(backupPath, source, 'utf8');
  }
  const indentation = /^\t/m.test(source) ? '\t' : 2;
  await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, indentation)}\n`, 'utf8');
  return { changed: true, removed, removedKeywordStyles, manifestPath, backupPath };
}

async function suppressVallentaEditorContextMenus(extensionPath) {
  return patchVallentaManifest(extensionPath);
}

module.exports = {
  BACKUP_FILE,
  patchVallentaManifest,
  removeVallentaEditorContextMenus,
  removeVallentaForcedKeywordBold,
  suppressVallentaEditorContextMenus
};
