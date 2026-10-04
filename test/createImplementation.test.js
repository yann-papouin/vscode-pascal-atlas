'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildClassNavigatorModel, implementationRoutineForest } = require('../src/classNavigator');
const { maskPascalNonCode } = require('../src/binarySymbols');
const { createImplementationCommand, planRoutineImplementation } = require('../src/implementationCore');

const body = name => `procedure ${name};\nbegin\nend;`;
const unit = (declarations, bodies = [], tail = 'end.') => `unit CreateSample;
interface
type
  TDemo = class
  public
${declarations.map(heading => '    ' + heading).join('\n')}
  end;
implementation
${bodies.join('\n\n')}
${tail}`;
const modelFor = source => buildClassNavigatorModel(source, 'CreateSample.pas');
function generate(source, name = 'Missing', options = {}) {
  const model = modelFor(source);
  const target = model.routineNodes.find(node => node.name === name);
  const plan = planRoutineImplementation(source, model, target.declarationStartOffset, options);
  assert.equal(plan.reason, undefined, plan.reason);
  const result = source.slice(0, plan.offset) + plan.text + source.slice(plan.offset);
  const after = modelFor(result);
  const implemented = after.routineNodes.find(node => node.id === target.id);
  assert.ok(Number.isInteger(implemented?.implementationOffset), 'Generated heading must match its declaration');
  assert.equal(implemented.missingCounterpart, undefined);
  return { result, plan, after, target };
}
const order = source => implementationRoutineForest(maskPascalNonCode(source))
  .map(routine => [routine.header.owner, routine.header.name].filter(Boolean).join('.'));

const neighbors = ['procedure Before;', 'procedure Missing;', 'procedure After;'];
for (const [description, bodies, expected] of [
  ['adjacent bodies', ['TDemo.Before', 'TDemo.After'], ['TDemo.Before', 'TDemo.Missing', 'TDemo.After']],
  ['reversed adjacent bodies', ['TDemo.After', 'TDemo.Before'], ['TDemo.After', 'TDemo.Missing', 'TDemo.Before']],
  ['separated bodies', ['TDemo.Before', 'TOther.Work', 'TDemo.After'], ['TDemo.Before', 'TDemo.Missing', 'TOther.Work', 'TDemo.After']],
  ['previous body only', ['TDemo.Before'], ['TDemo.Before', 'TDemo.Missing']],
  ['next body only', ['TDemo.After'], ['TDemo.Missing', 'TDemo.After']]
]) {
  test(`implementation placement uses ${description}`, () => {
    assert.deepEqual(order(generate(unit(neighbors, bodies.map(body))).result), expected);
  });
}

test('missing immediate neighbors use alphabetical placement without searching outward', () => {
  const source = unit(['procedure Alpha;', 'procedure UnimplementedPrev;', 'procedure Missing;',
    'procedure UnimplementedNext;', 'procedure Zeta;'], [body('TDemo.Zeta'), body('TDemo.Alpha')]);
  assert.deepEqual(order(generate(source).result), ['TDemo.Missing', 'TDemo.Zeta', 'TDemo.Alpha']);
});

test('alphabetical fallback compares only the owning class and appends after its last body', () => {
  const source = unit(['procedure Missing;'], [body('TDemo.Alpha'), body('TOther.Zeta'), body('TDemo.Beta'), body('TOther.Last')]);
  assert.deepEqual(order(generate(source).result), ['TDemo.Alpha', 'TOther.Zeta', 'TDemo.Beta', 'TDemo.Missing', 'TOther.Last']);
});

test('alphabetical fallback keeps overload bodies together', () => {
  const source = unit(['procedure Run(Value: Integer); overload;'],
    ['procedure TDemo.Run(Value: string);\nbegin\nend;']);
  const { result } = generate(source, 'Run');
  assert.ok(result.indexOf('procedure TDemo.Run(Value: Integer)') > result.indexOf('procedure TDemo.Run(Value: string)'));
});

test('a class without bodies appends before lifecycle sections', () => {
  const source = unit(['procedure Missing;'], [body('TOther.Last')], 'initialization\n  StartUp;\nfinalization\n  ShutDown;\nend.');
  const { result } = generate(source);
  assert.deepEqual(order(result), ['TOther.Last', 'TDemo.Missing']);
  assert.ok(result.indexOf('procedure TDemo.Missing;') < result.indexOf('initialization'));
  assert.ok(result.includes('initialization\n  StartUp;\nfinalization\n  ShutDown;\nend.'));
});

test('an empty implementation preserves uses, type, const and var declarations', () => {
  const source = unit(['procedure Missing;'], [], 'uses SysUtils;\ntype TLocal = Integer;\nconst Value = 1;\nvar Count: Integer;\nend.');
  const { result } = generate(source);
  assert.ok(result.indexOf('procedure TDemo.Missing;') > result.indexOf('var Count: Integer;'));
  assert.match(result, /procedure TDemo\.Missing;\nbegin\n  \nend;\n\nend\./);
});

test('standalone globals use global neighbors and exact overload matching', () => {
  const source = `unit CreateSample;
interface
procedure Before;
function Missing(const Caption: string = 'default'; Value: Integer = 10): Boolean;
procedure After;
implementation
${body('Before')}

${body('TOther.Work')}

${body('After')}
end.`;
  const { result } = generate(source);
  assert.deepEqual(order(result), ['Before', 'Missing', 'TOther.Work', 'After']);
  assert.match(result, /function Missing\(const Caption: string; Value: Integer\): Boolean;/);
  const overloaded = `unit CreateSample;
interface
procedure Run(Value: Integer); overload;
implementation
procedure Run(Value: string);
begin
end;
end.`;
  assert.ok(generate(overloaded, 'Run').result.includes('procedure Run(Value: Integer);\nbegin'));
});

test('global alphabetical fallback ignores class bodies', () => {
  const source = `unit CreateSample;
interface
procedure Missing;
implementation
${body('Zeta')}

${body('TOther.Alpha')}
end.`;
  assert.deepEqual(order(generate(source).result), ['Missing', 'Zeta', 'TOther.Alpha']);
});

test('multiline headings keep types and case, omit defaults/directives and place the caret after begin', () => {
  const source = unit(["FUNCTION Missing(\n      const Caption: string = 'a; begin end';\n      A, B: Integer = 1\n    ): Boolean; virtual;"], []);
  const model = modelFor(source);
  const target = model.routineNodes.find(node => node.name === 'Missing');
  const plan = planRoutineImplementation(source, model, source.indexOf('A, B: Integer'));
  assert.equal(plan.reason, undefined);
  assert.match(plan.text, /FUNCTION TDemo\.Missing\(const Caption: string; A, B: Integer\): Boolean;\nBEGIN\n  \nEND;/);
  assert.equal(plan.text.includes('virtual'), false);
  const result = source.slice(0, plan.offset) + plan.text + source.slice(plan.offset);
  assert.equal(result.slice(plan.caretOffset - 8, plan.caretOffset), 'BEGIN\n  ');
  assert.equal(result.slice(plan.caretOffset, plan.caretOffset + 5), '\nEND;');
  assert.equal(modelFor(result).routineNodes.find(node => node.id === target.id).missingCounterpart, undefined);
});

test('generic owner names omit constraints and nested owners retain their parameters', () => {
  const source = `unit CreateSample;
interface
type
  TOuter<T: class, constructor> = class
  type
    TInner<U: record> = class
    public
      class function Missing<V: class; W: record>(const Value: V): U; static;
    end;
  end;
implementation
end.`;
  const { result } = generate(source);
  assert.match(result, /class function TOuter<T>\.TInner<U>\.Missing<V, W>\(const Value: V\): U;/);
});

test('CRLF and tabs follow the anchor heading indentation and editor settings', () => {
  const source = unit(['procedure Before;', 'procedure Missing;'],
    ['\tprocedure TDemo.Before;\n\tbegin\n\tend;']).replace(/\n/g, '\r\n');
  const { plan, result } = generate(source, 'Missing', { insertSpaces: false, tabSize: 4 });
  assert.match(plan.text, /\tprocedure TDemo\.Missing;\r\n\tbegin\r\n\t\t\r\n\tend;/);
  assert.equal(result.slice(plan.caretOffset - 2, plan.caretOffset), '\t\t');
  assert.equal(/(?<!\r)\n/.test(plan.text), false);
});

test('after insertion keeps trailing comments and before insertion keeps attached documentation', () => {
  const source = unit(neighbors, [body('TDemo.Before') + ' // trailing note',
    '// After documentation\n' + body('TDemo.After')]);
  const { result } = generate(source);
  assert.ok(result.includes('end; // trailing note\n\nprocedure TDemo.Missing;'));
  assert.ok(result.includes('// After documentation\nprocedure TDemo.After;'));
  const nextOnly = unit(['procedure Missing;', 'procedure After;'],
    ['(* Attached\n   documentation *)\n' + body('TDemo.After')]);
  const inserted = generate(nextOnly).result;
  assert.ok(inserted.indexOf('procedure TDemo.Missing;') < inserted.indexOf('(* Attached'));
  assert.ok(inserted.includes('documentation *)\nprocedure TDemo.After;'));
});

test('local routines, compound blocks and assembly bodies provide complete top-level anchors', () => {
  const previous = `procedure TDemo.Before;
  procedure Local;
  begin
    case Value of
      1: begin Work; end;
    end;
  end;
begin
  try
    Local;
  except
    HandleError;
  end;
end;`;
  const source = unit(neighbors, [previous, 'procedure TDemo.After;\nasm\n  MOV EAX, 0\nend;']);
  const { result } = generate(source);
  assert.deepEqual(order(result), ['TDemo.Before', 'TDemo.Missing', 'TDemo.After']);
  assert.ok(result.includes(previous + '\n\nprocedure TDemo.Missing;'));
});

test('existing, abstract, external and interface methods do not produce edits', () => {
  for (const source of [
    unit(['procedure Missing;'], [body('TDemo.Missing')]),
    unit(['procedure Missing; virtual; abstract;']),
    unit(["procedure Missing; external 'library.dll';"]),
    'unit CreateSample;\ninterface\ntype\n  IContract = interface\n    procedure Missing;\n  end;\nimplementation\nend.'
  ]) {
    const model = modelFor(source);
    const target = model.routineNodes.find(node => node.name === 'Missing');
    assert.ok(planRoutineImplementation(source, model, target.declarationStartOffset).reason);
  }
});

test('incomplete declarations, malformed bodies and missing section boundaries reject edits', () => {
  for (const source of [
    unit(['procedure Missing']),
    unit(neighbors, ['procedure TDemo.Before;\nbegin\n  Work;']),
    unit(['procedure Missing;']).replace('implementation', ''),
    unit(['procedure Missing;']).replace('end.', '')
  ]) {
    const model = modelFor(source);
    const target = model.routineNodes.find(node => node.name === 'Missing');
    assert.ok(planRoutineImplementation(source, model, target?.declarationStartOffset ?? source.indexOf('Missing')).reason);
  }
});

/** Exercise the command with a real model and an editable VS Code-shaped document. */
function editorHarness(initial) {
  let source = initial;
  const infos = [];
  const edits = [];
  const undo = [];
  class Position { constructor(line, character) { this.line = line; this.character = character; } }
  class Range { constructor(start, end) { this.start = start; this.end = end; } }
  class Selection extends Range {
    constructor(start, end) { super(start, end); this.active = end; this.isEmpty = start.line === end.line && start.character === end.character; }
  }
  const document = {
    uri: { toString: () => 'file:///CreateSample.pas' }, languageId: 'pascal', version: 1, eol: 1,
    getText: () => source,
    positionAt: offset => { const lines = source.slice(0, offset).split('\n'); return new Position(lines.length - 1, lines.at(-1).length); },
    offsetAt: position => source.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character
  };
  const position = document.positionAt(source.indexOf('Missing'));
  const selection = new Selection(position, position);
  const editor = {
    document, selection, selections: [selection], options: { tabSize: 2, insertSpaces: true }, acceptEdits: true,
    revealRange(range) { this.revealed = range; },
    async edit(callback, options) {
      if (!this.acceptEdits) return false;
      const insertions = [];
      callback({ insert: (position, text) => insertions.push({ offset: document.offsetAt(position), text }) });
      if (!insertions.length) return false;
      undo.push(source); edits.push({ insertions, options });
      for (const insertion of insertions.sort((left, right) => right.offset - left.offset)) {
        source = source.slice(0, insertion.offset) + insertion.text + source.slice(insertion.offset);
      }
      document.version += 1;
      return true;
    }
  };
  const vscode = {
    window: { activeTextEditor: editor, showInformationMessage: message => infos.push(message), showErrorMessage: message => infos.push(message) },
    workspace: { getConfiguration: () => ({ get: () => true }) },
    Selection, Range, EndOfLine: { LF: 1, CRLF: 2 }, TextEditorRevealType: { InCenterIfOutsideViewport: 4 }
  };
  return { vscode, document, editor, infos, edits,
    readyModel: async () => modelFor(source),
    undo: () => { source = undo.pop(); document.version += 1; },
    change: text => { source = text; document.version += 1; } };
}

test('the editor command creates one undoable implementation and moves the caret into its blank body', async () => {
  const original = unit(neighbors, [body('TDemo.Before'), body('TDemo.After')]);
  const env = editorHarness(original);
  let updated = 0;
  const command = createImplementationCommand(env.vscode, { readyModel: env.readyModel, onCreated: () => { updated += 1; } });
  assert.equal(await command(), true);
  assert.equal(env.edits.length, 1);
  assert.equal(env.edits[0].insertions.length, 1);
  assert.deepEqual(env.edits[0].options, { undoStopBefore: true, undoStopAfter: true });
  const caret = env.document.offsetAt(env.editor.selection.active);
  assert.equal(env.document.getText().slice(caret - 8, caret), 'begin\n  ');
  assert.equal(env.document.getText().slice(caret, caret + 5), '\nend;');
  assert.equal(env.editor.revealed.start, env.editor.selection.active);
  assert.equal(updated, 1);
  const declaration = env.document.positionAt(env.document.getText().indexOf('Missing'));
  env.editor.selection = new env.vscode.Selection(declaration, declaration);
  assert.equal(await command(), false);
  assert.match(env.infos.at(-1), /already has an implementation/);
  assert.equal(env.edits.length, 1);
  env.undo();
  assert.equal(env.document.getText(), original);
});

test('the command rejects concurrent requests and source changes during asynchronous parsing', async () => {
  const original = unit(['procedure Missing;']);
  const env = editorHarness(original);
  let resolve;
  const model = modelFor(original);
  const ready = new Promise(done => { resolve = done; });
  const command = createImplementationCommand(env.vscode, { readyModel: () => ready });
  const first = command();
  assert.equal(await command(), false);
  assert.match(env.infos.at(-1), /already being created/);
  env.change(original + '\n// typed while waiting');
  resolve(model);
  assert.equal(await first, false);
  assert.match(env.infos.at(-1), /document, caret or active editor changed/);
  assert.equal(env.edits.length, 0);
});

test('the command respects selection, editor changes and rejected document edits', async () => {
  const env = editorHarness(unit(['procedure Missing;']));
  const command = createImplementationCommand(env.vscode, { readyModel: env.readyModel });
  env.editor.selections.push(env.editor.selection);
  assert.equal(await command(), false);
  env.editor.selections.pop();
  env.editor.selection.isEmpty = false;
  assert.equal(await command(), false);
  env.editor.selection.isEmpty = true;
  env.editor.acceptEdits = false;
  assert.equal(await command(), false);
  assert.equal(env.edits.length, 0);
  env.editor.acceptEdits = true;
  const switchEditor = createImplementationCommand(env.vscode, { readyModel: async () => {
    env.vscode.window.activeTextEditor = { ...env.editor };
    return env.readyModel();
  } });
  assert.equal(await switchEditor(), false);
  assert.equal(env.edits.length, 0);
});

test('the manifest exposes Ctrl+Shift+C independently of Navigator visibility or mode', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const command = manifest.contributes.commands.find(item => item.command === 'pascalAtlas.createImplementation');
  assert.equal(command.title, 'Pascal Atlas: Create Routine Implementation');
  const binding = manifest.contributes.keybindings.find(item => item.command === command.command);
  assert.equal(binding.key, 'ctrl+shift+c');
  assert.match(binding.when, /editorTextFocus.*!editorReadonly/);
  assert.match(binding.when, /pascal\|objectpascal/);
  assert.doesNotMatch(binding.when, /classNavigator|navigator\.mode/);
});

test('default strings containing directive text do not affect safe insertion checks', () => {
  const source = unit(["procedure Earlier(Value: string = '{$IFDEF EXAMPLE}');", 'procedure Missing;']);
  assert.equal(generate(source).plan.reason, undefined);
  const guarded = unit(['{$IFDEF EXAMPLE}', 'procedure Missing;', '{$ENDIF}']);
  const model = modelFor(guarded);
  const target = model.routineNodes.find(node => node.name === 'Missing');
  assert.match(planRoutineImplementation(guarded, model, target.declarationStartOffset).reason, /safely resolved/);
});

test('same-line implementation/end boundaries remain usable in an otherwise complete unit', () => {
  const source = unit(['procedure Missing;']).replace(/implementation\s+end\./, 'implementation end.');
  const { result } = generate(source);
  assert.match(result, /implementation \n\nprocedure TDemo\.Missing;\nbegin\n  \nend;\n\nend\./);
});

test('generic overload arity prevents accepting another overload as the missing body', () => {
  const source = unit(['procedure Run<T>(Value: T); overload;', 'procedure Run<T, U>(Value: T); overload;'],
    ['procedure TDemo.Run<T, U>(Value: T);\nbegin\nend;']);
  const model = modelFor(source);
  const target = model.routineNodes.find(node => node.signature.includes('Run<T>('));
  const plan = planRoutineImplementation(source, model, target.declarationStartOffset);
  assert.equal(plan.reason, undefined);
  assert.match(plan.text, /procedure TDemo\.Run<T>\(Value: T\);/);
  const result = source.slice(0, plan.offset) + plan.text + source.slice(plan.offset);
  assert.equal(modelFor(result).routineNodes.filter(node => node.missingCounterpart).length, 0);
});

test('a caret move during parsing and read-only file systems reject the command without changes', async () => {
  const env = editorHarness(unit(['procedure Missing;']));
  env.vscode.workspace.fs = { isWritableFileSystem: () => false };
  const readOnly = createImplementationCommand(env.vscode, { readyModel: env.readyModel });
  assert.equal(await readOnly(), false);
  assert.match(env.infos.at(-1), /read-only/);
  env.vscode.workspace.fs = undefined;
  const moved = createImplementationCommand(env.vscode, { readyModel: async () => {
    const next = env.document.positionAt(env.document.getText().indexOf('implementation'));
    env.editor.selection = new env.vscode.Selection(next, next);
    return env.readyModel();
  } });
  assert.equal(await moved(), false);
  assert.equal(env.edits.length, 0);
});

test('declaration source order wins over Navigator visibility sorting and lifecycle ranking', () => {
  const source = unit(['private', 'constructor Create;', 'public', 'procedure Missing;',
    'protected', 'destructor Destroy;'], [
    'constructor TDemo.Create;\nbegin\nend;', 'destructor TDemo.Destroy;\nbegin\nend;'
  ]);
  assert.deepEqual(order(generate(source).result), ['TDemo.Create', 'TDemo.Missing', 'TDemo.Destroy']);
});

test('standalone compiler directives remain with the existing implementation code', () => {
  const source = unit(['procedure Missing;', 'procedure After;'],
    ["{$R 'forms.dfm'}\n// Documentation\n" + body('TDemo.After')]);
  const { result } = generate(source);
  assert.ok(result.indexOf("{$R 'forms.dfm'}") < result.indexOf('procedure TDemo.Missing;'));
  assert.ok(result.includes('// Documentation\nprocedure TDemo.After;'));
});

test('routine names on the following line still expose the entire declaration heading', () => {
  const source = unit(['class function\n      Missing(\n        Value: Integer\n      ): Integer; static;']);
  const { result } = generate(source);
  assert.match(result, /class function TDemo\.Missing\(Value: Integer\): Integer;/);
});
