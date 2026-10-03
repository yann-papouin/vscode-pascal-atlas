'use strict';

const vscode = require('vscode');

const PLATFORM_LANGUAGE_ID = 'pascal-union-platform';
const MANAGED_ASSOCIATION_VALUE = PLATFORM_LANGUAGE_ID;

function platformSourceAssociationPatterns(installationPath) {
  const normalized = String(installationPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const version = normalized.match(/\/Embarcadero\/Studio\/([^/]+)$/i)?.[1];
  if (version) {
    return [
      `**/Embarcadero/Studio/${version}/source/rtl/**/*.pas`,
      `**/Embarcadero/Studio/${version}/source/vcl/**/*.pas`
    ];
  }
  return [
    '**/Embarcadero/Studio/*/source/rtl/**/*.pas',
    '**/Embarcadero/Studio/*/source/vcl/**/*.pas'
  ];
}

function mergedAssociations(existing, patterns, enabled) {
  const result = { ...(existing && typeof existing === 'object' ? existing : {}) };
  let changed = false;
  for (const pattern of patterns) {
    if (enabled) {
      if (result[pattern] === MANAGED_ASSOCIATION_VALUE) continue;
      result[pattern] = MANAGED_ASSOCIATION_VALUE;
      changed = true;
    } else if (result[pattern] === MANAGED_ASSOCIATION_VALUE) {
      delete result[pattern];
      changed = true;
    }
  }
  return { associations: result, changed };
}

async function synchronizePlatformSourceIsolation(output) {
  const enabled = vscode.workspace.getConfiguration('pascalUnion')
    .get('navigation.isolatePlatformSources', true);
  const installationPath = vscode.workspace.getConfiguration('vallenta.studio')
    .get('installationPath', '');
  const patterns = platformSourceAssociationPatterns(installationPath);
  const configuration = vscode.workspace.getConfiguration('files');
  const inspected = configuration.inspect('associations') || {};
  const existing = inspected.globalValue || {};
  const merged = mergedAssociations(existing, patterns, enabled);
  if (!merged.changed) return false;
  await configuration.update(
    'associations',
    merged.associations,
    vscode.ConfigurationTarget.Global
  );
  output?.appendLine(
    `${enabled ? 'Enabled' : 'Disabled'} isolated Delphi platform source mode `
    + `for ${patterns.length} source pattern(s).`
  );
  return true;
}

function registerPlatformSourceIsolation(context, output) {
  void synchronizePlatformSourceIsolation(output).catch(error => {
    output.appendLine(`Platform source isolation setup failed: ${error.message}`);
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (!event.affectsConfiguration('pascalUnion.navigation.isolatePlatformSources')
      && !event.affectsConfiguration('vallenta.studio.installationPath')) return;
    void synchronizePlatformSourceIsolation(output).catch(error => {
      output.appendLine(`Platform source isolation refresh failed: ${error.message}`);
    });
  }));
}

module.exports = {
  MANAGED_ASSOCIATION_VALUE,
  PLATFORM_LANGUAGE_ID,
  mergedAssociations,
  platformSourceAssociationPatterns,
  registerPlatformSourceIsolation,
  synchronizePlatformSourceIsolation
};
