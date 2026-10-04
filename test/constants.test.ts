import { matchingBasicSnippets, plainControlExpansion } from '../src/basicSnippets';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { PascalKeyword, CompilerDirective, keywordAlternation } from '../src/shared/pascal';
import { CommandId, ConfigurationSection, SettingKey, WorkerEvent, UriScheme, SettingValueType } from '../src/shared/identifiers';
import { isRecord } from '../src/shared/guards';
import { isPascalNonNavigableIdentifierAt, isPascalVisibilityDirectiveAt } from '../src/syntacticColoring';
import { projectRoot } from './helpers';

test('public command and setting constants retain the manifest identifiers', () => {
 const manifest: unknown = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
 assert.ok(isRecord(manifest) && isRecord(manifest.contributes));
 const contributes = manifest.contributes;
 assert.ok(Array.isArray(contributes.commands));
 const commands = new Set(contributes.commands.map((command: unknown) => { assert.ok(isRecord(command) && typeof command.command === 'string'); return command.command; }));
 for (const command of Object.values(CommandId)) assert.ok(commands.has(command), `Missing command ${command}`);
 assert.ok(isRecord(contributes.configuration) && isRecord(contributes.configuration.properties));
 const properties = contributes.configuration.properties;
 for (const key of Object.values(SettingKey)) assert.ok(Object.hasOwn(properties, `${ConfigurationSection}.${key}`), `Missing setting ${key}`);
});

test('keyword regex alternatives preserve capture numbering, flags, and mixed casing', () => {
 const pattern = new RegExp(String.raw`\b(${keywordAlternation([PascalKeyword.Procedure, PascalKeyword.Function])})\s+([A-Za-z_]\w*)`, 'gi');
 const source = 'PrOcEdUrE First; FUNCTION Second;';
 assert.deepEqual([...source.matchAll(pattern)].map(match => [match[1], match[2], match.index]), [
  ['PrOcEdUrE', 'First', 0], ['FUNCTION', 'Second', 17]
 ]);
 assert.equal(keywordAlternation(['a.b', 'c+d', '[word]']), String.raw`a\.b|c\+d|\[word\]`);
});

test('shared vocabulary preserves contextual visibility and escaped or qualified symbols', () => {
 const enumeration = 'Public, Published)';
 assert.equal(isPascalVisibilityDirectiveAt(enumeration, 0, 'Public'), false);
 assert.equal(isPascalVisibilityDirectiveAt('  strict private\n    procedure Run;', 2, 'strict'), true);
 for (const source of ['Obj.Begin', '&Begin']) {
  const offset = source.indexOf('Begin');
  assert.equal(isPascalNonNavigableIdentifierAt(source, offset, 'Begin'), false);
 }
 assert.equal(isPascalNonNavigableIdentifierAt('BeGiN', 0, 'BeGiN'), true);
});

test('compiler directives and infrastructure values retain their own registries', () => {
 assert.equal(CompilerDirective.IFDEF, 'IFDEF');
 assert.equal(PascalKeyword.If, 'if');
 assert.equal(WorkerEvent.Message, 'message');
 assert.equal(UriScheme.File, 'file');
 assert.equal(SettingValueType.Boolean, 'boolean');
});


test('constant-based snippet templates retain literal placeholder syntax', () => {
 assert.equal(matchingBasicSnippets('begin')[0].body, 'begin\n\t$0\nend;');
 assert.equal(matchingBasicSnippets('if')[0].body, 'if ${1:Condition} then\nbegin\n\t$0\nend;');
 assert.equal(plainControlExpansion('forin', '', { tabSize: 2, insertSpaces: true })?.text, 'for Item in Items do\nbegin\n  \nend;');
});
