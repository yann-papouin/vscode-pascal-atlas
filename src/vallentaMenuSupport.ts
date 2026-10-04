import { PascalKeyword } from "./shared/pascal";
﻿import * as fs from 'node:fs';
import * as path from 'node:path';
import { isRecord } from './shared/guards';
const VALLENTA_COMMAND_PREFIX = 'vallenta.studio.';
const BACKUP_FILE = 'package.json.pascal-atlas-editor-context-backup';
function removeVallentaEditorContextMenus(manifest: Record<string, unknown>): unknown[] {
 const contributes = isRecord(manifest.contributes) ? manifest.contributes : undefined;
 const menus = contributes && isRecord(contributes.menus) ? contributes.menus : undefined;
 const editorContext = menus?.['editor/context'];
 if (!menus || !Array.isArray(editorContext)) return [];
 const items: unknown[] = editorContext;
 const removed = items.filter(item => isRecord(item) && typeof item.command === 'string' && item.command.startsWith(VALLENTA_COMMAND_PREFIX));
 menus['editor/context'] = items.filter(item => !removed.includes(item));
 return removed;
}
function removeVallentaForcedKeywordBold(manifest: Record<string, unknown>): unknown[] {
 const contributes = isRecord(manifest.contributes) ? manifest.contributes : undefined;
 const defaults = contributes && isRecord(contributes.configurationDefaults) ? contributes.configurationDefaults : undefined;
 const customizations = defaults && isRecord(defaults['editor.tokenColorCustomizations']) ? defaults['editor.tokenColorCustomizations'] : undefined;
 const rules = customizations?.textMateRules;
 if (!defaults || !customizations || !Array.isArray(rules)) return [];
 const items: unknown[] = rules;
 const removed = items.filter(rule => {
  if (!isRecord(rule)) return false;
  const settings = isRecord(rule.settings) ? rule.settings : undefined;
  return rule.name === 'Pascal: bold reserved words'
   || (/(?:^|\s)bold(?:\s|$)/i.test(String(settings?.fontStyle || ''))
    && /keyword\.control\.pascal/i.test(String(rule.scope || ''))
    && new RegExp(String.raw`storage\.${PascalKeyword.Type}\.${PascalKeyword.Class}\.pascal`, "i").test(String(rule.scope || '')));
 });
 const remaining = items.filter(rule => !removed.includes(rule));
 customizations.textMateRules = remaining;
 if (remaining.length === 0) delete defaults['editor.tokenColorCustomizations'];
 return removed;
}
interface ManifestPatchOptions { removeEditorContextMenus?: boolean; removeForcedKeywordBold?: boolean; }
async function patchVallentaManifest(extensionPath: string | undefined, options: ManifestPatchOptions = {}) {
 if (!extensionPath) return { changed: false, removed: [], removedKeywordStyles: [] };
 const manifestPath = path.join(extensionPath, 'package.json');
 const source = await fs.promises.readFile(manifestPath, 'utf8');
 const manifest: unknown = JSON.parse(source.replace(/^\uFEFF/, ''));
 if (!isRecord(manifest)) throw new Error('The extension manifest must be a JSON object.');
 const removed = options.removeEditorContextMenus === false ? [] : removeVallentaEditorContextMenus(manifest);
 const removedKeywordStyles = options.removeForcedKeywordBold === false ? [] : removeVallentaForcedKeywordBold(manifest);
 if (!removed.length && !removedKeywordStyles.length) return { changed: false, removed, removedKeywordStyles };
 const backupPath = path.join(extensionPath, BACKUP_FILE);
 try { await fs.promises.access(backupPath); } catch { await fs.promises.writeFile(backupPath, source, 'utf8'); }
 const indentation = /^\t/m.test(source) ? '\t' : 2;
 await fs.promises.writeFile(manifestPath, `${JSON.stringify(manifest, null, indentation)}\n`, 'utf8');
 return { changed: true, removed, removedKeywordStyles, manifestPath, backupPath };
}
async function suppressVallentaEditorContextMenus(extensionPath: string | undefined) { return patchVallentaManifest(extensionPath); }
export { BACKUP_FILE, patchVallentaManifest, removeVallentaEditorContextMenus, removeVallentaForcedKeywordBold, suppressVallentaEditorContextMenus };
