'use strict';

const vscode = require('vscode');

const LEGACY_PATTERN = '**/*.{dfm,fmx,groupproj,res,rc,map,dcu,bpl,dcp,exe,lib,obj,o,ppu,identcache,local,stat,vsdcache,delphilsp.json,vallenta,encoding-backup*}';
const LEGACY_BUILD_ARTIFACT_PATTERN = '**/*.{res,rc,map,dcu,bpl,dcp,exe,lib,obj,o,ppu}';
const LEGACY_DIRECTORY_PATTERNS = Object.freeze([
  '**/__history', '**/__recovery', '**/Win32', '**/Win64', '**/Debug',
  '**/Release', '**/bin', '**/lib', '**/tmp'
]);
const LEGACY_PROJECT_METADATA_PATTERN = '**/*.{groupproj,identcache,local,stat,vsdcache,delphilsp.json,vallenta,encoding-backup*}';
const GROUPS = Object.freeze({
  'explorer.hideFormFiles': '**/*.{dfm,fmx}',
  'explorer.hideSkinConfigFiles': '**/*.skincfg',
  'explorer.hideBuildArtifacts': '**/*.{res,rc,map,mes,dcu,bpl,dcp,exe,lib,obj,o,ppu}',
  // `.groupproj` is an actionable source project file, not disposable metadata.
  // Keep it visible so its dedicated project-file decoration can be rendered.
  'explorer.hideProjectMetadata': '**/*.{identcache,local,stat,vsdcache,delphilsp.json,vallenta,encoding-backup*}',
  'explorer.hideBuildDirectories': '**/{__history,__recovery,Win32,Win64,Debug,Release,bin,lib,tmp}'
});

function stableObject(value) {
  return JSON.stringify(Object.entries(value || {}).sort(([left], [right]) => left.localeCompare(right)));
}

async function syncExplorerExcludes(output) {
  const pa = vscode.workspace.getConfiguration('pascalAtlas');
  const files = vscode.workspace.getConfiguration('files');
  const inspected = files.inspect('exclude') || {};
  const current = { ...(inspected.globalValue || {}) };
  const next = { ...current };

  // Migrate the previous all-in-one rule so each category can be controlled
  // independently from Pascal Atlas settings.
  const hasLegacyLayout = Object.prototype.hasOwnProperty.call(next, LEGACY_PATTERN);
  delete next[LEGACY_PATTERN];
  if (hasLegacyLayout) {
    for (const pattern of LEGACY_DIRECTORY_PATTERNS) delete next[pattern];
  }
  // Migrate the previously managed metadata rule that also hid groupproj.
  delete next[LEGACY_PROJECT_METADATA_PATTERN];
  delete next[LEGACY_BUILD_ARTIFACT_PATTERN];
  for (const pattern of Object.values(GROUPS)) delete next[pattern];
  for (const [setting, pattern] of Object.entries(GROUPS)) {
    if (pa.get(setting, true)) next[pattern] = true;
  }
  if (stableObject(current) === stableObject(next)) return;
  await files.update('exclude', next, vscode.ConfigurationTarget.Global);
  output.appendLine('Synchronized configurable Delphi Explorer exclusion groups.');
}

function registerExplorerSupport(context, output) {
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('pascalAtlas.explorer')) return;
    void syncExplorerExcludes(output).catch(error => {
      output.appendLine(`Explorer exclusion synchronization failed: ${error.message}`);
    });
  }));
  void syncExplorerExcludes(output).catch(error => {
    output.appendLine(`Explorer exclusion synchronization failed: ${error.message}`);
  });
}

module.exports = {
  GROUPS,
  LEGACY_BUILD_ARTIFACT_PATTERN,
  LEGACY_DIRECTORY_PATTERNS,
  LEGACY_PROJECT_METADATA_PATTERN,
  LEGACY_PATTERN,
  registerExplorerSupport,
  syncExplorerExcludes
};
