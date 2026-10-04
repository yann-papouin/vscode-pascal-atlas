'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const {
  buildClassNavigatorModel, ClassNavigatorProvider, serializeNavigatorNode
} = require('../src/classNavigator');
const { ClassNavigatorWebview, navigatorWebviewHtml } = require('../src/classNavigatorWebview');
const { planRoutineImplementation } = require('../src/implementationCore');

class Emitter {
  listeners = new Set();
  event = listener => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

const SOURCE = `unit Updates;
interface
type
  TDemo = class
  public
    procedure First;
    procedure Last;
  end;
implementation
procedure TDemo.First;
begin
end;
procedure TDemo.Last;
begin
end;
end.`;
const FILE = 'Updates.pas';
const modelFor = text => buildClassNavigatorModel(text, FILE, { memberOrder: 'declaration' });

test('body edits update navigation offsets without posting a tree update', async () => {
  let model = modelFor(SOURCE);
  const messages = [];
  let opened;
  const tree = new ClassNavigatorWebview({ EventEmitter: Emitter }, 'test', {
    getRoots: () => model.roots,
    serializeNode: serializeNavigatorNode,
    onOpen: node => { opened = node; }
  });
  tree.webview = { postMessage: message => { messages.push(message); return Promise.resolve(true); } };
  tree.handleMessage({ type: 'ready' });
  assert.equal(messages[0].type, 'model');
  const selected = model.routineNodes.find(node => node.name === 'Last');
  await tree.reveal(selected, { select: true });
  messages.length = 0;

  model = modelFor(SOURCE.replace('begin\nend;', 'begin\n  Writeln(42);\nend;'));
  const current = model.routineNodes.find(node => node.name === 'Last');
  assert.equal(current.id, selected.id);
  assert.ok(current.implementationOffset > selected.implementationOffset);
  tree.refresh();
  assert.deepEqual(messages, []);
  assert.equal(tree.selection[0], current);
  tree.handleMessage({ type: 'open', id: selected.id });
  assert.equal(opened, current);

  tree.message = undefined;
  tree.refresh(); // Repeated provider/save notifications are also a no-op.
  assert.deepEqual(messages, []);
  tree.handleMessage({ type: 'ready' });
  assert.equal(messages.at(-1).type, 'model'); // A reloaded client gets a baseline.
});

test('inserting and deleting declarations sends only changed siblings and rebinds selection', async () => {
  let model = modelFor(SOURCE);
  const messages = [];
  const tree = new ClassNavigatorWebview({ EventEmitter: Emitter }, 'test', {
    getRoots: () => model.roots, serializeNode: serializeNavigatorNode
  });
  tree.webview = { postMessage: message => { messages.push(message); return Promise.resolve(true); } };
  tree.handleMessage({ type: 'ready' });
  const oldIds = model.roots[0].children.map(node => node.id);
  model = modelFor(SOURCE.replace('    procedure Last;', '    procedure Middle;\n    procedure Last;'));
  tree.refresh();
  const patch = messages.at(-1);
  assert.equal(patch.type, 'patch');
  assert.deepEqual(patch.removed, []);
  assert.equal(patch.upsert.length, 2); // Parent child list and the new declaration.
  const parent = patch.upsert.find(node => node.kind === 'type');
  const middle = model.routineNodes.find(node => node.name === 'Middle');
  assert.deepEqual(parent.children, [oldIds[0], middle.id, oldIds[1]]);
  await tree.reveal(middle, { select: true });
  model = modelFor(SOURCE);
  tree.refresh();
  assert.deepEqual(messages.at(-1).removed, [middle.id]);
  assert.equal(tree.selection[0], model.roots[0]);
  assert.equal(messages.at(-1).selectedId, model.roots[0].id);
});

test('identities survive offset shifts and distinguish documents and overloads', () => {
  const overloaded = SOURCE.replace('    procedure Last;',
    '    procedure Last(Value: Integer); overload;\n    procedure Last(Value: string); overload;');
  const before = modelFor(overloaded);
  const after = modelFor('{ inserted above all declarations }\n' + overloaded);
  assert.deepEqual(after.nodes.map(node => node.id), before.nodes.map(node => node.id));
  assert.equal(new Set(before.nodes.map(node => node.id)).size, before.nodes.length);
  const other = buildClassNavigatorModel(overloaded, 'Other.pas');
  assert.notEqual(before.roots[0].id, other.roots[0].id);
});

test('background reparsing retains rows while readyModel waits for current offsets', async () => {
  let text = SOURCE + '\n{' + ' padding '.repeat(9000) + '}';
  const document = {
    uri: { toString: () => 'file:///Updates.pas' }, version: 1,
    fileName: FILE, languageId: 'pascal', getText: () => text
  };
  const provider = new ClassNavigatorProvider({
    EventEmitter: Emitter,
    window: { activeTextEditor: { document } },
    workspace: { getConfiguration: () => ({
      get: (key, fallback) => key === 'backgroundParsing.thresholdKb' ? 64 : fallback
    }) }
  });
  try {
    const first = await provider.readyModel();
    assert.equal(first.roots[0].label, 'TDemo');
    document.version += 1;
    text = '// shifts source offsets\n' + text;
    assert.equal(provider.model(), first);
    assert.equal(provider.cache.pending, true);
    const next = await provider.readyModel();
    assert.notEqual(next, first);
    assert.equal(next.roots[0].id, first.roots[0].id);
    assert.ok(next.roots[0].offset > first.roots[0].offset);
    assert.equal(provider.cache.pending, undefined);
  } finally { provider.dispose(); }
});

/** A small DOM harness runs the shipped webview script and tracks row mutations. */
function clientHarness() {
  let created = 0;
  let structuralChanges = 0;
  let document;
  const descendants = root => root.children.flatMap(child => [child, ...descendants(child)]);
  class Element {
    children = [];
    dataset = {};
    style = {};
    attributes = {};
    listeners = new Map();
    className = '';
    textContent = '';
    scrollTop = 0;
    classList = {
      contains: name => this.className.split(' ').includes(name),
      add: name => this.classList.toggle(name, true),
      remove: name => this.classList.toggle(name, false),
      toggle: (name, force) => {
        const names = new Set(this.className.split(' ').filter(Boolean));
        if (force ?? !names.has(name)) names.add(name); else names.delete(name);
        this.className = [...names].join(' ');
      }
    };
    constructor() { created += 1; }
    get isConnected() { return this === document.body || Boolean(this.parentElement?.isConnected); }
    get offsetParent() {
      for (let node = this; node; node = node.parentElement) {
        if (node.hidden || node.classList.contains('collapsed')) return null;
      }
      return this.isConnected ? document.body : null;
    }
    appendChild(child) { return this.insertBefore(child, null); }
    insertBefore(child, before) {
      if (child.parentElement) child.remove();
      const index = before ? this.children.indexOf(before) : this.children.length;
      assert.ok(index >= 0);
      this.children.splice(index, 0, child); child.parentElement = this;
      structuralChanges += 1;
      return child;
    }
    remove() {
      if (!this.parentElement) return;
      if (this.contains(document.activeElement)) document.activeElement = document.body;
      this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = undefined;
      structuralChanges += 1;
    }
    replaceChildren() { throw new Error('The tree must not be rebuilt'); }
    contains(node) { return node === this || descendants(this).includes(node); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getAttribute(key) { return this.attributes[key] ?? null; }
    removeAttribute(key) { delete this.attributes[key]; }
    querySelectorAll(selector) {
      return descendants(this).filter(node => selector.startsWith('.') && node.classList.contains(selector.slice(1)));
    }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    focus() { document.activeElement = this; }
    scrollIntoView() {}
    getBoundingClientRect() {
      const tree = document.getElementById('tree');
      const rows = tree?.querySelectorAll('.row').filter(row => row.offsetParent !== null) || [];
      const top = this.classList.contains('row') ? rows.indexOf(this) * 22 - tree.scrollTop : 0;
      return { top, bottom: top + 22, left: 0 };
    }
  }
  document = {
    body: new Element(), activeElement: undefined,
    createElement: () => new Element(),
    getElementById: id => descendants(document.body).find(node => node.id === id),
    addEventListener() {}, hasFocus: () => false,
    querySelector: selector => {
      const id = /data-id="([^"]+)"/.exec(selector)?.[1];
      return descendants(document.body).find(node => node.dataset.id === id);
    }
  };
  for (const id of ['tree', 'results', 'search', 'sort-panel', 'query', 'search-status',
    'scope', 'kind-types', 'kind-files', 'kind-routines', 'navigation', 'member-order',
    'type-order', 'close-search', 'close-sort']) {
    const node = new Element(); node.id = id; document.body.appendChild(node);
  }
  const listeners = new Map();
  const sent = [];
  let saved;
  const html = navigatorWebviewHtml({ cspSource: 'test' });
  const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(html)[1];
  vm.runInNewContext(script, {
    document, window: { addEventListener: (name, callback) => listeners.set(name, callback) },
    acquireVsCodeApi: () => ({
      getState: () => saved, setState: value => { saved = value; }, postMessage: value => sent.push(value)
    }),
    setTimeout, clearTimeout, requestAnimationFrame: callback => callback(),
    CSS: { escape: value => value }
  });
  return {
    document, sent,
    send: data => listeners.get('message')({ data }),
    row: id => descendants(document.body).find(node => node.dataset.id === id),
    counts: () => [created, structuralChanges]
  };
}

const clientNode = (id, children = []) => ({ id, kind: 'routine', label: id, icon: 'symbol-method', children, jumpable: true });

test('selection and data patches retain actual rows, focus, expansion and scroll anchor', () => {
  const client = clientHarness();
  const first = clientNode('first');
  const last = clientNode('last');
  const parent = { ...clientNode('parent', ['first', 'last']), initialExpanded: true };
  client.send({ type: 'model', nodes: [parent, first, last], rootIds: ['parent'] });
  const originalFirst = client.row('first');
  const originalLast = client.row('last');
  originalLast.focus();
  const tree = client.document.getElementById('tree');
  tree.scrollTop = 44;
  const beforeSelection = client.counts();
  client.send({ type: 'select', id: 'last', path: ['parent'], select: true });
  assert.deepEqual(client.counts(), beforeSelection);
  assert.equal(client.row('last'), originalLast);

  client.send({ type: 'patch', upsert: [{ ...parent, children: ['first', 'middle', 'last'] }, clientNode('middle')], removed: [] });
  assert.equal(client.row('first'), originalFirst);
  assert.equal(client.row('last'), originalLast);
  const children = originalLast.parentElement.parentElement.children;
  assert.deepEqual(children.map(wrapper => wrapper.dataset.nodeId), ['first', 'middle', 'last']);
  assert.equal(client.document.activeElement, originalLast);
  assert.equal(tree.scrollTop, 66); // Keep Last at the top after insertion above it.
  assert.equal(originalLast.classList.contains('selected'), true);
  assert.equal(client.row('parent').getAttribute('aria-expanded'), 'true');

  const beforeLabel = client.counts();
  client.send({ type: 'patch', upsert: [{ ...last, label: 'Updated', access: 'private', jumpable: false }], removed: [] });
  assert.deepEqual(client.counts(), beforeLabel);
  assert.equal(originalLast.children[2].textContent, 'Updated');
  client.sent.length = 0;
  originalLast.listeners.get('click')();
  assert.equal(client.sent.some(message => message.type === 'open'), false); // Handlers read fresh data.

  client.send({ type: 'select', id: 'first', select: false });
  assert.equal(originalLast.classList.contains('selected'), true);
  const beforeCollapse = client.counts();
  client.row('parent').children[0].listeners.get('click')({ stopPropagation() {} });
  client.send({ type: 'patch', upsert: [{ ...first, label: 'First updated' }], removed: [] });
  assert.deepEqual(client.counts(), beforeCollapse);
  assert.equal(client.row('parent').getAttribute('aria-expanded'), 'false');
});

test('sort and deletion patches move retained rows and remove only deleted rows', () => {
  const client = clientHarness();
  client.send({ type: 'model', nodes: [clientNode('a'), clientNode('b')], rootIds: ['a', 'b'] });
  const a = client.row('a');
  const b = client.row('b');
  b.focus();
  const before = client.counts()[0];
  client.send({ type: 'patch', upsert: [], removed: [], rootIds: ['b', 'a'] });
  assert.equal(client.counts()[0], before);
  assert.equal(client.row('a'), a);
  assert.equal(client.row('b'), b);
  assert.equal(client.document.activeElement, b);
  client.send({ type: 'patch', upsert: [], removed: ['a'], rootIds: ['b'] });
  assert.equal(client.row('a'), undefined);
  assert.equal(client.row('b'), b);
});

test('mode and search-state changes update retained rows without rebuilding the tree', () => {
  const client = clientHarness();
  client.send({ type: 'model', nodes: [{ ...clientNode('package'), kind: 'package' }, clientNode('routine')],
    rootIds: ['package', 'routine'], mode: 'class' });
  const row = client.row('package');
  const before = client.counts();
  client.send({ type: 'patch', upsert: [], removed: [], mode: 'project' });
  assert.equal(JSON.parse(row.dataset.vscodeContext).webviewSection, 'projectPackage');
  client.send({ type: 'select', id: 'routine', select: true });
  client.send({ type: 'restoreSearchState', state: {
    selectedId: 'package', expanded: [], initialized: ['package', 'routine'], scrollTop: 12
  } });
  assert.equal(row.classList.contains('selected'), true);
  assert.equal(client.row('routine').classList.contains('selected'), false);
  assert.equal(client.document.activeElement, row);
  assert.equal(client.document.getElementById('tree').scrollTop, 12);
  client.send({ type: 'patch', upsert: [], removed: [], mode: 'class' });
  assert.equal(row.dataset.vscodeContext, undefined);
  assert.deepEqual(client.counts(), before);
});

test('counterpart repairs clear red styling through a patch and retain the selected row', async () => {
  const declaration = SOURCE.replace('    procedure Last;', '    procedure Missing;\n    procedure Last;');
  const body = SOURCE.replace('end.', 'procedure TDemo.Missing;\nbegin\nend;\nend.');
  const complete = declaration.replace('end.', 'procedure TDemo.Missing;\nbegin\nend;\nend.');
  for (const [before, missing] of [[declaration, 'implementation'], [body, 'declaration']]) {
    const client = clientHarness();
    const messages = [];
    let model = modelFor(before);
    const tree = new ClassNavigatorWebview({ EventEmitter: Emitter }, 'test', {
      getRoots: () => model.roots, serializeNode: serializeNavigatorNode
    });
    tree.webview = { postMessage: message => {
      // Exercise the actual transport shape, including omitted undefined fields.
      const payload = JSON.parse(JSON.stringify(message));
      messages.push(payload); client.send(payload); return Promise.resolve(true);
    } };
    tree.handleMessage({ type: 'ready' });
    const routine = model.routineNodes.find(node => node.name === 'Missing');
    assert.equal(routine.missingCounterpart, missing);
    await tree.reveal(routine, { select: true });
    const row = client.row(routine.id);
    row.focus();
    assert.equal(row.classList.contains('missing-counterpart'), true);
    assert.equal(row.children[1].style.color, 'var(--vscode-errorForeground, #f14c4c)');
    assert.match(row.title, missing === 'implementation' ? /Missing implementation/ : /Missing declaration/);
    const created = client.counts()[0];
    model = modelFor(complete);
    tree.refresh();
    assert.equal(messages.at(-1).type, 'patch');
    assert.equal(messages.at(-1).removed.length, 0);
    assert.equal(client.counts()[0], created);
    assert.equal(client.row(routine.id), row);
    assert.equal(row.classList.contains('missing-counterpart'), false);
    assert.equal(row.children[1].style.color, 'var(--vscode-charts-green, #89d185)');
    assert.equal(row.classList.contains('selected'), true);
    assert.equal(client.document.activeElement, row);
    assert.doesNotMatch(row.title, /Missing (implementation|declaration)/);
  }
});

test('generated implementations repair the selected Navigator row through a data patch', async () => {
  const client = clientHarness();
  let source = SOURCE.replace('    procedure Last;', '    procedure Missing;\n    procedure Last;');
  let model = modelFor(source);
  const messages = [];
  const tree = new ClassNavigatorWebview({ EventEmitter: Emitter }, 'test', {
    getRoots: () => model.roots, serializeNode: serializeNavigatorNode,
    nodePath: node => node?.parent ? [node.parent.id] : []
  });
  tree.webview = { postMessage: message => {
    const payload = JSON.parse(JSON.stringify(message));
    messages.push(payload); client.send(payload); return Promise.resolve(true);
  } };
  tree.handleMessage({ type: 'ready' });
  const routine = model.routineNodes.find(node => node.name === 'Missing');
  await tree.reveal(routine, { select: true });
  const row = client.row(routine.id);
  row.focus();
  const before = client.counts();
  const plan = planRoutineImplementation(source, model, routine.declarationStartOffset);
  assert.equal(plan.reason, undefined);
  source = source.slice(0, plan.offset) + plan.text + source.slice(plan.offset);
  model = modelFor(source);
  tree.refresh();
  assert.equal(messages.at(-1).type, 'patch');
  assert.equal(messages.at(-1).upsert.length, 1);
  assert.equal(client.row(routine.id), row);
  assert.equal(row.classList.contains('missing-counterpart'), false);
  assert.equal(row.classList.contains('selected'), true);
  assert.equal(client.document.activeElement, row);
  assert.equal(client.row(routine.parent.id).getAttribute('aria-expanded'), 'true');
  assert.deepEqual(client.counts(), before);
});
