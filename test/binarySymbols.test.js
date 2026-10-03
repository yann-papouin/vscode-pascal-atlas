'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  PASCAL_INDEX_DEREFERENCE,
  buildPascalTypeInferenceIndex,
  collectPascalInlineVariableNames,
  findPascalUsesUnitAt,
  inferPascalTypeFromIndex,
  knownCompiledMembers,
  maskPascalNonCode,
  pascalMemberChainBefore,
  parseTdumpPackageIndex,
  renderVirtualUnit,
  resolvePascalReceiverTypeChain,
  uniqueCompiledInterfaceMember
} = require('../src/binarySymbols');

test('non-code masking preserves UTF-16 offsets after supplementary characters', () => {
  const source = "unit Offset; // 😀 comment\nTRealType = class end;";
  const masked = maskPascalNonCode(source);
  assert.equal(masked.length, source.length);
  assert.equal(masked.indexOf('TRealType'), source.indexOf('TRealType'));
});

test('member chains are parsed locally without accepting comments or plain identifiers', () => {
  const source = `begin
  Body.Open.Ref.TopoBody;
  PlainIdentifier;
  // Hidden.Value
end;`;
  const code = maskPascalNonCode(source);
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('TopoBody'), code),
    ['Body', 'Open', 'Ref']
  );
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('Ref'), code),
    ['Body', 'Open']
  );
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('PlainIdentifier'), code),
    []
  );
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('Value'), code),
    []
  );
});

test('receiver type chains can cross compiled and source member metadata', async () => {
  const metadata = new Map([
    ['tcadview.document', ['TCADDocument']],
    ['tcaddocument.activenestedtubecount', ['Integer']]
  ]);
  const visited = [];
  const types = await resolvePascalReceiverTypeChain(
    ['TCADView'],
    ['Document', 'ActiveNestedTubeCount'],
    async (typeName, memberName) => {
      visited.push(`${typeName}.${memberName}`);
      return metadata.get(`${typeName}.${memberName}`.toLowerCase()) || [];
    }
  );

  assert.deepEqual(visited, [
    'TCADView.Document',
    'TCADDocument.ActiveNestedTubeCount'
  ]);
  assert.deepEqual(types, ['Integer']);
});

test('member chains retain the base type of a static generic receiver', () => {
  const source = 'TProtoBufClassList<TList<TEdge>>.Create;';
  const code = maskPascalNonCode(source);
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('Create'), code),
    ['TProtoBufClassList']
  );
});

test('member chains cross Delphi casts, calls, and indexed receivers', () => {
  const source = `begin
  TReplaceWithCrossHoleData(FTestResultManager.FTestDatas[I]).FLength_1;
  FTestResultManager.FTestDatas[I].FCasefile;
  Owner.GetData(Index).Value;
end;`;
  const code = maskPascalNonCode(source);
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('FLength_1'), code),
    ['TReplaceWithCrossHoleData']
  );
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('FCasefile'), code),
    ['FTestResultManager', 'FTestDatas', PASCAL_INDEX_DEREFERENCE]
  );
  assert.deepEqual(
    pascalMemberChainBefore(source, source.indexOf('Value'), code),
    ['Owner', 'GetData']
  );
});

test('type inference index resolves routine scope, Self, inline variables and for-in elements', () => {
  const source = `unit IndexedTypes;
interface
type
  TThing = class
    procedure Run(const Arg: TArg);
  end;
implementation
procedure TThing.Run(const Arg: TArg);
var
  Item: TItem;
  Parts: TList<TPart>;
  function Local: TResult;
  begin
    Self.Touch;
  end;
begin
  Item.Execute;
  Arg.Read;
  var Created := TCreated.Create;
  Created.Save;
  for var Part in Parts do
    Part.Draw;
end;
end.`;
  const code = maskPascalNonCode(source);
  const index = buildPascalTypeInferenceIndex(source, code);
  const typeAt = (identifier, member) => inferPascalTypeFromIndex(
    index,
    identifier,
    source.indexOf(member)
  );
  assert.equal(typeAt('Self', 'Touch'), 'TThing');
  assert.equal(typeAt('Item', 'Execute'), 'TItem');
  assert.equal(typeAt('Arg', 'Read'), 'TArg');
  assert.equal(typeAt('Created', 'Save'), 'TCreated');
  assert.equal(typeAt('Part', 'Draw'), 'TPart');
  assert.deepEqual(
    [...collectPascalInlineVariableNames(source, code)].sort(),
    ['created', 'part']
  );
});

test('dotted unit references in uses resolve as one range without capturing member chains', () => {
  const source = `unit Consumer;
interface
uses
  Josh.DB,
  CypHub.App.Services.Queries;
implementation
begin
  DataJson.I := 1;
end.`;
  const code = maskPascalNonCode(source);
  for (const identifier of ['Josh', 'DB']) {
    const match = findPascalUsesUnitAt(source, source.indexOf(identifier), undefined, code);
    assert.equal(source.slice(match.start, match.end), 'Josh.DB');
  }
  for (const identifier of ['CypHub', 'App', 'Services', 'Queries']) {
    const match = findPascalUsesUnitAt(source, source.indexOf(identifier), undefined, code);
    assert.equal(source.slice(match.start, match.end), 'CypHub.App.Services.Queries');
  }
  assert.equal(findPascalUsesUnitAt(source, source.lastIndexOf('I'), undefined, code), undefined);
});

test('compiled ABI constructors and destructors expose Pascal member names', () => {
  const info = {
    kind: 'class',
    symbol: 'TBodyDiscreteAPI',
    namespace: 'Triangulation',
    bplPath: 'bcglGeoAlgo3D.bpl',
    methods: [
      {
        name: 'TBodyDiscreteAPI',
        signature: 'Triangulation::TBodyDiscreteAPI::TBodyDiscreteAPI(TFsTopoBody*)'
      },
      {
        name: '~TBodyDiscreteAPI',
        signature: 'Triangulation::TBodyDiscreteAPI::~TBodyDiscreteAPI()'
      },
      { name: 'Perform', signature: 'Triangulation::TBodyDiscreteAPI::Perform()' }
    ],
    properties: [],
    rttiMembers: []
  };
  const members = knownCompiledMembers(info);
  assert.equal(members.get('create').kind, 'constructor');
  assert.equal(members.get('create').value.abiName, 'TBodyDiscreteAPI');
  assert.equal(members.get('destroy').kind, 'destructor');
  assert.equal(members.get('perform').kind, 'method');
  const virtualSource = renderVirtualUnit(info);
  assert.match(virtualSource, /constructor Create\(TFsTopoBody\*\)/);
  assert.match(virtualSource, /destructor Destroy\(\)/);
});

test('compiled interfaces use only a unique same-unit inherited member fallback', () => {
  const receiver = {
    kind: 'interface', symbol: 'IRequestContext', namespace: 'MVCFramework.Servlet',
    methods: [], properties: [], rttiMembers: []
  };
  const response = {
    kind: 'interface', symbol: 'IServletResponse', namespace: 'MVCFramework.Servlet',
    methods: [{ name: 'SetRespStream', signature: 'IServletResponse.SetRespStream(TStream)' }],
    properties: [], rttiMembers: []
  };
  const unrelated = {
    kind: 'interface', symbol: 'IOther', namespace: 'Other.Unit',
    methods: [{ name: 'SetRespStream', signature: 'IOther.SetRespStream(TStream)' }],
    properties: [], rttiMembers: []
  };
  const classes = new Map([
    ['irequestcontext', receiver], ['iservletresponse', response], ['iother', unrelated]
  ]);
  const resolved = uniqueCompiledInterfaceMember(receiver, classes, 'SetRespStream');
  assert.equal(resolved.info.symbol, 'IServletResponse');
  classes.set('iduplicate', {
    ...response, symbol: 'IDuplicate',
    methods: [{ name: 'SetRespStream', signature: 'IDuplicate.SetRespStream(TStream)' }]
  });
  assert.equal(uniqueCompiledInterfaceMember(receiver, classes, 'SetRespStream'), undefined);
});

test('compiled package index preserves exact namespaced servlet units and inherited methods', () => {
  const output = [
    "EXPORT ord:0001='Mvcframework.Servlet::TMvcRequest::GetHeaders(System::UnicodeString)'",
    "EXPORT ord:0002='Ucustommodule::TCustomController2::PostCustomMsg(System::UnicodeString)'",
    "EXPORT ord:0003='Mvcframework::Stereotype::initialization()'",
    "EXPORT ord:0004='Mvcframework::Stereotype::Finalization()'"
  ].join('\n');
  const index = parseTdumpPackageIndex(output, 'MVCFramework.bpl');
  assert.equal(index.units.get('mvcframework.servlet').symbol, 'Mvcframework.Servlet');
  assert.equal(index.units.get('mvcframework.stereotype').symbol, 'Mvcframework.Stereotype');
  assert.equal(
    knownCompiledMembers(index.classes.get('tcustomcontroller2')).has('postcustommsg'),
    true
  );
});

test('compiled generic specializations map back to their Pascal base type', () => {
  const output = [
    "EXPORT ord:0001='Uabstractprotobufclasses::TProtoBufClassList__1<Cadmodel3d::TEdge*>::AddFromBuf(Pbinput::TProtoBufInput*, int)'",
    "EXPORT ord:0002='Uabstractprotobufclasses::TProtoBufClassList__1<Cadmodel3d::TFace*>::SaveToBuf(Pboutput::TProtoBufOutput*, int)'"
  ].join('\n');
  const index = parseTdumpPackageIndex(output, 'Cyphub.Web.bpl');
  const info = index.classes.get('tprotobufclasslist');
  assert.equal(info.symbol, 'TProtoBufClassList');
  assert.deepEqual(info.methods.map(item => item.name).sort(), ['AddFromBuf', 'SaveToBuf']);
});
