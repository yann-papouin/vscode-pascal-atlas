import { WebviewMessageKind } from '../src/shared/webviewProtocols';
import type { NavigatorNode } from '../src/shared/models';
import type { SourceDefinition } from '../src/shared/sourceModels';
import { required, readBrowserScript } from './helpers';
import * as assert from 'node:assert/strict';
import { test as test } from 'node:test';
import * as vm from 'node:vm';
import { navigatorWebviewHtml } from '../src/classNavigatorWebview';
import { accessColorId, aiRetryReasoningEffort, activeFollowNodeAt, activeNodeAt, buildClassNavigatorModel, buildDprojNavigatorModel, findNavigatorEntries, findNavigatorEntry, highlightNodeForExpandedSteps, implementationRoutineForest, navigationRevealPlan, navigatorNodeById, navigatorIconName, navigatorSearchResultsForIndex, navigatorSearchResultsForModel, navigatorNodeForSearchResult, normalizeNavigatorSearchOptions, nodeSourceRanges, serializeNavigatorNode, routineIconName, viewportFollowLine } from '../src/classNavigator';
test('minimal AI requests retry once with the reliable low effort', () => {
    assert.equal(aiRetryReasoningEffort('minimal'), 'low');
    assert.equal(aiRetryReasoningEffort('low'), 'low');
    assert.equal(aiRetryReasoningEffort('high'), 'high');
    assert.equal(aiRetryReasoningEffort('auto'), 'auto');
});
test('DPK, DPR, and DPROJ files share an icon distinct from project nodes', () => {
    assert.equal(navigatorIconName({ kind: 'project' }), 'project');
    assert.equal(navigatorIconName({ kind: 'package' }), 'package');
    for (const extension of ['dpk', 'dpr', 'dproj']) {
        assert.equal(navigatorIconName({ kind: 'file', filePath: `D:\\Demo\\Core.${extension}` }), 'project-file');
    }
    assert.equal(navigatorIconName({ kind: 'file', filePath: 'D:\\Demo\\Demo.groupproj' }), 'file');
});
test('navigation reveal centers fitting blocks and places large blocks at the configured height', () => {
    assert.deepEqual(navigationRevealPlan(100, 119, 40, 'smart', 25), {
        kind: 'center', startLine: 100, endLine: 119
    });
    assert.deepEqual(navigationRevealPlan(100, 180, 40, 'smart', 25), {
        kind: 'anchor', startLine: 100, endLine: 180, anchorLine: 90
    });
    assert.equal(navigationRevealPlan(4, 80, 40, 'smart', 25).anchorLine, 0);
    assert.equal(navigationRevealPlan(100, 180, 40, 'center', 25).kind, 'center');
    assert.equal(navigationRevealPlan(100, 180, 40, 'top', 25).anchorLine, 100);
    assert.equal(navigationRevealPlan(100, 180, 40, 'default', 25).kind, 'default');
});
test('viewport follow point is biased one line below the visual center', () => {
    assert.equal(viewportFollowLine(10, 30), 21);
    assert.equal(viewportFollowLine(10, 30, 0), 20);
    assert.equal(viewportFollowLine(10, 30, 3), 23);
    assert.equal(viewportFollowLine(10, 10, 3), 10);
});
const SOURCE = `unit NavigatorSample;

interface

uses
  System.SysUtils, Unit.Contracts;

type
  TFoo = class
  private
    FValue: Integer;
  public
    procedure Run;
    function Calculate(AValue: Integer): Integer;
    property Value: Integer read FValue;
  end;

  IWorker = interface
    procedure Work;
  end;

const
  HiddenConstant = 1;

var
  HiddenVariable: Integer;

procedure GlobalRun;

implementation

uses Unit.Runtime;

procedure TFoo.Run;
begin
  FValue := Calculate(1);
end;

function TFoo.Calculate(AValue: Integer): Integer;
begin
  Result := AValue;
end;

procedure GlobalRun;
begin
end;

procedure IWorker.Work;
begin
end;

end.
`;
test('class navigator groups uses, global routines and routines by type', () => {
    const model = buildClassNavigatorModel(SOURCE, 'NavigatorSample.pas');
    assert.deepEqual(model.roots.map(node => node.label), ['uses', 'global', 'TFoo', 'IWorker']);
    const uses = model.roots[0];
    assert.deepEqual(uses.children.map(node => node.label), ['uses1', 'uses2']);
    assert.deepEqual(uses.children.map(node => node.children), [[], []]);
    const global = model.roots[1];
    assert.deepEqual(global.children.map(node => node.label), ['GlobalRun']);
    const foo = model.roots[2];
    assert.deepEqual(foo.children.map(node => node.label), ['properties', 'Run', 'Calculate']);
    assert.deepEqual(foo.children[0].children.map(node => node.label), ['Value']);
    assert.equal(foo.children.some(node => node.label === 'FValue'), false);
    const calculate = foo.children[2];
    assert.equal(SOURCE.slice(required(calculate.implementationOffset) - 14, required(calculate.implementationOffset)), 'function TFoo.');
});
test('class navigator options independently hide uses, globals, interfaces and records', () => {
    const model = buildClassNavigatorModel(SOURCE, 'NavigatorSample.pas', {
        showUses: false,
        showGlobalRoutines: false,
        showInterfaces: false,
        showRecordsAndObjects: false,
        showProperties: false
    });
    assert.deepEqual(model.roots.map(node => node.label), ['TFoo']);
    assert.deepEqual(model.roots[0].children.map(node => node.label), ['Run', 'Calculate']);
});
test('active routine follows the implementation body', () => {
    const model = buildClassNavigatorModel(SOURCE, 'NavigatorSample.pas');
    const offset = SOURCE.indexOf('FValue := Calculate');
    const active = required(activeNodeAt(model, offset));
    assert.equal(active.label, 'Run');
    assert.equal(active.owner, 'TFoo');
});
test('active type follows the class declaration body outside routine lines', () => {
    const model = buildClassNavigatorModel(SOURCE, 'NavigatorSample.pas');
    const offset = SOURCE.indexOf('FValue: Integer');
    const active = required(activeNodeAt(model, offset));
    assert.equal(active.label, 'TFoo');
    assert.equal(active.kind, 'type');
});
test('source ranges cover real navigator items and exclude virtual groups', () => {
    const model = buildClassNavigatorModel(SOURCE, 'NavigatorSample.pas');
    const uses = required(model.roots.find(node => node.kind === 'uses-group'));
    const implementationUsesOffset = SOURCE.indexOf('Unit.Runtime');
    const usesRanges = nodeSourceRanges(SOURCE, uses, implementationUsesOffset);
    assert.equal(usesRanges.length, 1);
    assert.equal(implementationUsesOffset >= usesRanges[0][0]
        && implementationUsesOffset < usesRanges[0][1], true);
    const implementationUses = required(activeNodeAt(model, implementationUsesOffset));
    assert.equal(implementationUses.kind, 'uses-section');
    assert.equal(implementationUses.label, 'uses2');
    assert.equal(SOURCE.slice(...nodeSourceRanges(SOURCE, implementationUses, implementationUsesOffset)[0]).includes('uses Unit.Runtime;'), true);
    const foo = required(model.roots.find(node => node.label === 'TFoo'));
    const typeRanges = nodeSourceRanges(SOURCE, foo, SOURCE.indexOf('FValue: Integer'));
    assert.equal(typeRanges.length, 1);
    assert.equal(SOURCE.slice(...typeRanges[0]).includes('property Value'), true);
    const run = required(foo.children.find(node => node.label === 'Run'));
    const implementationOffset = SOURCE.indexOf('FValue := Calculate');
    const implementationRanges = nodeSourceRanges(SOURCE, run, implementationOffset);
    assert.equal(implementationRanges.length, 1);
    assert.equal(implementationOffset >= implementationRanges[0][0]
        && implementationOffset < implementationRanges[0][1], true);
    const declarationRanges = nodeSourceRanges(SOURCE, run, SOURCE.indexOf('procedure Run'));
    assert.equal(declarationRanges.length, 1);
    assert.equal(SOURCE.slice(...declarationRanges[0]).includes('procedure Run'), true);
    const propertyOffset = SOURCE.indexOf('property Value');
    const property = required(activeNodeAt(model, propertyOffset));
    assert.equal(property.kind, 'property');
    assert.equal(property.label, 'Value');
    assert.equal(SOURCE.slice(...nodeSourceRanges(SOURCE, property, propertyOffset)[0])
        .includes('property Value'), true);
    assert.deepEqual(nodeSourceRanges(SOURCE, model.roots.find(node => node.kind === 'global-group')), []);
});
test('expanded routine steps replace the whole-routine follow highlight', () => {
    const model = buildClassNavigatorModel(SOURCE, 'NavigatorSample.pas');
    const routine = required(required(model.roots.find(node => node.label === 'TFoo')).children.find(node => node.label === 'Run'));
    const bodyOffset = SOURCE.indexOf('FValue := Calculate');
    const bodyLine = SOURCE.slice(0, bodyOffset).split('\n').length;
    const step: NavigatorNode = {
        id: 'ai-step:run-body',
        kind: 'ai-step',
        label: '1. Evaluate calculation',
        startLine: bodyLine,
        endLine: bodyLine,
        children: [],
        parent: routine
    };
    const substep: NavigatorNode = {
        id: 'ai-step:run-detail',
        kind: 'ai-step',
        label: '1.1. Update field',
        startLine: bodyLine,
        endLine: bodyLine,
        children: [],
        parent: step
    };
    const deepStep: NavigatorNode = {
        id: 'ai-step:run-deep-detail',
        kind: 'ai-step',
        label: '1.1.1. Write field',
        startLine: bodyLine,
        endLine: bodyLine,
        children: [],
        parent: substep
    };
    substep.children.push(deepStep);
    step.children.push(substep);
    routine.children.push(step);
    assert.equal(highlightNodeForExpandedSteps(SOURCE, routine, bodyOffset, new Set()), routine);
    assert.equal(highlightNodeForExpandedSteps(SOURCE, routine, bodyOffset, new Set<string>([routine.id])), step);
    assert.equal(activeFollowNodeAt(SOURCE, model, bodyOffset, new Set<string>([routine.id, step.id])), substep);
    assert.equal(activeFollowNodeAt(SOURCE, model, bodyOffset, new Set<string>([routine.id, step.id, substep.id])), deepStep);
    // A collapsed third level must keep the nearest visible second-level item
    // selected instead of revealing or selecting its hidden descendant.
    assert.equal(activeFollowNodeAt(SOURCE, model, bodyOffset, new Set<string>([routine.id, step.id])), substep);
    assert.equal(activeFollowNodeAt(SOURCE, model, bodyOffset, new Set()), routine);
    // Expanding only the routine exposes the parent step but not its children,
    // so cursor following must select that nearest visible parent step.
    assert.equal(activeFollowNodeAt(SOURCE, model, bodyOffset, new Set<string>([routine.id])), step);
    assert.equal(highlightNodeForExpandedSteps(SOURCE, routine, required(routine.declarationOffset), new Set<string>([routine.id])), routine);
});
test('unit initialization and finalization are bottom-level lifecycle jump entries', () => {
    const source = `unit LifecycleSample;
interface
uses System.SysUtils;
type
  TRunner = class
  public
    procedure Run;
  end;
implementation
procedure TRunner.Run;
begin
end;
initialization
  RegisterClass(TRunner);
finalization
  UnRegisterClass(TRunner);
end.
`;
    const model = buildClassNavigatorModel(source, 'LifecycleSample.pas');
    assert.equal(model.roots[0].label, 'uses');
    assert.deepEqual(model.roots.slice(-2).map(node => node.label), [
        'initialization',
        'finalization'
    ]);
    assert.deepEqual(model.roots.slice(-2).map(node => node.children), [[], []]);
    assert.equal(required(activeNodeAt(model, source.indexOf('RegisterClass'))).label, 'initialization');
    assert.equal(required(activeNodeAt(model, source.indexOf('UnRegisterClass'))).label, 'finalization');
    const hidden = buildClassNavigatorModel(source, 'LifecycleSample.pas', {
        showUnitInitialization: false,
        showUnitFinalization: false
    });
    assert.equal(hidden.roots.some(node => /^unit-/.test(node.kind)), false);
});
test('non-unit Pascal modules still expose uses and global routines', () => {
    const source = `program Demo;\nuses System.SysUtils;\nprocedure Start;\nbegin\nend;\nbegin\n  Start;\nend.\n`;
    const model = buildClassNavigatorModel(source, 'Demo.dpr');
    assert.deepEqual(model.roots.map(node => node.label), ['uses', 'global']);
    assert.deepEqual(model.roots[1].children.map(node => node.label), ['Start']);
});
test('DPK navigator adds one top-level jump entry for packages and one for files', () => {
    const source = `package Demo;
requires
  rtl,
  vcl;
contains
  Unit.One in 'Unit.One.pas',
  Unit.Two in 'Unit.Two.pas';
end.
`;
    const model = buildClassNavigatorModel(source, 'Demo.dpk');
    assert.deepEqual(model.roots.slice(0, 2).map(node => node.label), [
        'Package Includes',
        'File Includes'
    ]);
    assert.deepEqual(model.roots.slice(0, 2).map(node => node.children), [[], []]);
    assert.equal(source.slice(required(model.roots[0].offset), required(model.roots[0].offset) + 8), 'requires');
    assert.equal(source.slice(required(model.roots[1].offset), required(model.roots[1].offset) + 8), 'contains');
    assert.equal(required(activeNodeAt(model, source.indexOf('rtl'))).kind, 'project-package-section');
    assert.equal(required(activeNodeAt(model, source.indexOf('Unit.One'))).kind, 'project-file-section');
});
test('DPROJ navigator groups all DCCReference items into two non-expandable jump entries', () => {
    const source = `<Project>
  <ItemGroup>
    <DelphiCompile Include="$(MainSource)"><MainSource>MainSource</MainSource></DelphiCompile>
    <DCCReference Include="rtl.dcp"/>
    <DCCReference Include="vcl.dcp"/>
    <DCCReference Include="Unit.One.pas"/>
    <DCCReference Include="Unit.Two.pas"/>
  </ItemGroup>
</Project>`;
    const model = buildDprojNavigatorModel(source, 'Demo.dproj');
    assert.deepEqual(model.roots.map(node => node.label), [
        'Package Includes',
        'File Includes'
    ]);
    assert.deepEqual(model.roots.map(node => node.children), [[], []]);
    assert.equal(source.slice(required(model.roots[0].offset), required(model.roots[0].offset) + 13), '<DCCReference');
    assert.equal(source.indexOf('Unit.One.pas') > required(model.roots[1].offset), true);
    assert.equal(activeNodeAt(model, source.indexOf('<DCCReference Include="vcl')), model.roots[0]);
});
test('application DPROJ package entry targets the last DCC_UsePackage block', () => {
    const source = `<Project>
  <PropertyGroup><DCC_UsePackage>rtl;vcl</DCC_UsePackage></PropertyGroup>
  <PropertyGroup Condition="'$(Base)'!=''"><DCC_UsePackage>AppBase;MvcEnv</DCC_UsePackage></PropertyGroup>
  <ItemGroup><DCCReference Include="MainForm.pas"/></ItemGroup>
</Project>`;
    const model = buildDprojNavigatorModel(source, 'Demo.dproj');
    const packages = model.roots[0];
    assert.equal(packages.label, 'Package Includes');
    assert.equal(source.slice(required(packages.offset), required(packages.offset) + 15), '<DCC_UsePackage');
    assert.equal(required(packages.offset), source.lastIndexOf('<DCC_UsePackage'));
});
test('local routines are recursively nested below their containing routine', () => {
    const source = `unit NestedSample;
interface
type
  TRunner = class
  public
    procedure Execute;
  end;
implementation
procedure TRunner.Execute;
  procedure ImportFile;
    function Accept: Boolean;
    begin
      Result := True;
    end;
  begin
    if Accept then Exit;
  end;
begin
  ImportFile;
end;
end.
`;
    const model = buildClassNavigatorModel(source, 'NestedSample.pas');
    assert.equal(model.roots.some(node => node.kind === 'global-group'), false);
    const execute = required(model.roots.find(node => node.label === 'TRunner')).children[0];
    assert.deepEqual(execute.children.map(node => node.label), ['ImportFile']);
    assert.deepEqual(execute.children[0].children.map(node => node.label), ['Accept']);
    assert.equal(execute.children[0].routineFlavor, 'local');
    assert.equal(execute.children[0].children[0].routineFlavor, 'local');
    assert.equal(required(activeNodeAt(model, source.lastIndexOf('ImportFile;'))).label, 'Execute');
});
test('implementation helper type declarations are not treated as nested routines', () => {
    const source = `unit HelperTypeSample;
interface
implementation
type
  TWriter = class
  private
    procedure DeclaredOnly;
  public
    constructor Create;
  end;

constructor TWriter.Create;
begin
end;

procedure TWriter.DeclaredOnly;
begin
end;

procedure GlobalRun;
begin
end;
end.
`;
    const forest = implementationRoutineForest(source);
    assert.deepEqual(forest.map(node => node.header.name), ['Create', 'DeclaredOnly', 'GlobalRun']);
    assert.deepEqual(forest.map(node => node.children.length), [0, 0, 0]);
    assert.doesNotThrow(() => buildClassNavigatorModel(source, 'HelperTypeSample.pas'));
});
test('metaclass aliases are not parsed as class bodies', () => {
    const source = `unit MetaClassSample;
interface
type
  TWidgetClass = class of TWidget;
  TWidget = class
  public
    procedure Run;
  end;
implementation
procedure TWidget.Run;
begin
end;
end.
`;
    const model = buildClassNavigatorModel(source, 'MetaClassSample.pas');
    assert.equal(model.roots.some(node => node.label === 'TWidgetClass'), false);
    const widget = required(model.roots.find(node => node.label === 'TWidget'));
    assert.deepEqual(widget.children.map(node => node.label), ['Run']);
});
test('nested Delphi types stay under their nearest declaring type', () => {
    const source = `unit NestedTypeSample;
interface
type
  TOuter = class
  strict private
  type
    TCornerData = record
      EnterId: Integer;
      LeaveId: Integer;
    end;
  public
    procedure Run;
  end;

  TUnitLevel = record
    Value: Integer;
  end;
implementation
procedure TOuter.Run;
begin
end;
end.`;
    const model = buildClassNavigatorModel(source, 'NestedTypeSample.pas');
    const rootTypes = model.roots.filter(node => node.kind === 'type');
    assert.deepEqual(rootTypes.map(node => node.label), ['TOuter', 'TUnitLevel']);
    const outer = rootTypes[0];
    const nested = required(outer.children.find(node => node.kind === 'type'));
    assert.equal(nested?.label, 'TCornerData');
    assert.equal(nested?.owner, 'TOuter');
    assert.equal(nested?.parent, outer);
    assert.equal(model.typeNodes.includes(nested), true);
    assert.equal(required(activeNodeAt(model, source.indexOf('TCornerData'))).label, 'TCornerData');
    assert.equal(required(activeNodeAt(model, source.indexOf('EnterId'))).label, 'TCornerData');
});
test('forward class declarations remain siblings and yield to their real bodies', () => {
    const source = `unit ForwardTypeSample;
interface
type
  TAlpha = class;
  TBeta = class;
  EFirst = class(Exception);
  ESecond = class(Exception);

  TAlpha = class
  public
    procedure Run;
  end;

  TBeta = class
  public
    procedure Stop;
  end;
implementation
procedure TAlpha.Run;
begin
end;
procedure TBeta.Stop;
begin
end;
end.`;
    const model = buildClassNavigatorModel(source, 'ForwardTypeSample.pas');
    const rootTypes = model.roots.filter(node => node.kind === 'type');
    assert.deepEqual(rootTypes.map(node => node.label), ['EFirst', 'ESecond', 'TAlpha', 'TBeta']);
    const alpha = required(rootTypes.find(node => node.label === 'TAlpha'));
    const beta = required(rootTypes.find(node => node.label === 'TBeta'));
    assert.equal(alpha.offset, source.indexOf('TAlpha = class\n'));
    assert.equal(beta.offset, source.indexOf('TBeta = class\n'));
    assert.deepEqual(alpha.children.map(node => node.label), ['Run']);
    assert.deepEqual(beta.children.map(node => node.label), ['Stop']);
    assert.equal(rootTypes.some(node => node.children.some(child => child.kind === 'type')), false);
});
test('external global routines remain siblings instead of becoming nested routines', () => {
    const source = `unit ExternalSample;
interface
implementation
function Fs_Export_Step_Stream(AData: Pointer): Integer; cdecl; external 'FsKernel.dll';
function Fs_Export_Step_File(AData: Pointer): Integer; cdecl; external 'FsKernel.dll';
procedure Fs_SetAlgoType(AType: Integer); cdecl;
  external 'FsKernel.dll' name 'Fs_SetAlgoType';
function ManagedWrapper: Integer;
begin
  Result := Fs_Export_Step_File(nil);
end;
end.
`;
    const forest = implementationRoutineForest(source);
    assert.deepEqual(forest.map(node => [node.header.name, node.children.length]), [
        ['Fs_Export_Step_Stream', 0],
        ['Fs_Export_Step_File', 0],
        ['Fs_SetAlgoType', 0],
        ['ManagedWrapper', 0]
    ]);
    const model = buildClassNavigatorModel(source, 'ExternalSample.pas');
    const globals = required(model.roots.find(node => node.kind === 'global-group'));
    assert.deepEqual(globals.children.map(node => node.label), [
        'Fs_Export_Step_Stream',
        'Fs_Export_Step_File',
        'Fs_SetAlgoType',
        'ManagedWrapper'
    ]);
    assert.equal(globals.children.every(node => node.routineFlavor === 'global'), true);
});
test('property group is first, properties keep visibility and jump offsets', () => {
    const source = `unit PropertySample;
interface
type
  TWidget = class
  strict private
    property Secret: Integer read FSecret;
  protected
    procedure Work;
  public
    property Caption: string read FCaption;
    procedure Run;
  end;
implementation
procedure TWidget.Work; begin end;
procedure TWidget.Run; begin end;
end.
`;
    const model = buildClassNavigatorModel(source, 'PropertySample.pas');
    const widget = required(model.roots.find(node => node.label === 'TWidget'));
    assert.equal(widget.children[0].kind, 'properties-group');
    assert.deepEqual(widget.children[0].children.map(node => node.label), ['Secret', 'Caption']);
    assert.deepEqual(widget.children[0].children.map(node => node.access), ['strict-private', 'public']);
    assert.equal(source.slice(required(widget.children[0].children[1].offset), required(widget.children[0].children[1].offset) + 7), 'Caption');
    assert.equal(required(widget.children.find(node => node.label === 'Work')).access, 'protected');
    assert.equal(required(widget.children.find(node => node.label === 'Run')).access, 'public');
});
test('member order independently supports visibility, declaration, and implementation order', () => {
    const source = `unit OrderingSample;
interface
type
  TOrdered = class
  private
    procedure PrivateFirst;
    procedure PrivateSecond;
  protected
    procedure ProtectedWork;
  public
    property Caption: string read FCaption;
    procedure PublicFirst;
    procedure PublicSecond;
  end;
implementation
procedure TOrdered.PrivateSecond; begin end;
procedure TOrdered.PublicFirst; begin end;
procedure TOrdered.PrivateFirst; begin end;
procedure TOrdered.PublicSecond; begin end;
procedure TOrdered.ProtectedWork; begin end;
end.
`;
    const grouped = required(buildClassNavigatorModel(source, 'OrderingSample.pas')
        .roots.find(node => node.label === 'TOrdered'));
    assert.deepEqual(grouped.children.map(node => node.label), [
        'properties',
        'PublicFirst',
        'PublicSecond',
        'ProtectedWork',
        'PrivateSecond',
        'PrivateFirst'
    ]);
    const declarationOrdered = required(buildClassNavigatorModel(source, 'OrderingSample.pas', { memberOrder: 'declaration' })
        .roots.find(node => node.label === 'TOrdered'));
    assert.deepEqual(declarationOrdered.children.map(node => node.label), [
        'properties',
        'PrivateFirst',
        'PrivateSecond',
        'ProtectedWork',
        'PublicFirst',
        'PublicSecond'
    ]);
    const implementationOrdered = required(buildClassNavigatorModel(source, 'OrderingSample.pas', { memberOrder: 'implementation' })
        .roots.find(node => node.label === 'TOrdered'));
    assert.deepEqual(implementationOrdered.children.map(node => node.label), [
        'properties',
        'PrivateSecond',
        'PublicFirst',
        'PrivateFirst',
        'PublicSecond',
        'ProtectedWork'
    ]);
    const legacySourceOrdered = required(buildClassNavigatorModel(source, 'OrderingSample.pas', { memberOrder: 'source' })
        .roots.find(node => node.label === 'TOrdered'));
    assert.deepEqual(legacySourceOrdered.children.map(node => node.label), implementationOrdered.children.map(node => node.label));
});
test('grouped member order puts constructors and destructors immediately after properties', () => {
    const source = `unit LifecycleOrdering;
interface
type
  TOrdered = class
  private
    procedure Hidden;
    destructor Destroy; override;
  public
    property Caption: string read FCaption;
    procedure Run;
    constructor Create;
  end;
implementation
procedure TOrdered.Run; begin end;
constructor TOrdered.Create; begin end;
procedure TOrdered.Hidden; begin end;
destructor TOrdered.Destroy; begin end;
end.
`;
    const labels = (memberOrder: string) => required(buildClassNavigatorModel(source, 'LifecycleOrdering.pas', { memberOrder }).roots.find(node => node.label === 'TOrdered')).children.map(node => node.label);
    assert.deepEqual(labels('visibility'), ['properties', 'Create', 'Destroy', 'Run', 'Hidden']);
    assert.deepEqual(labels('declaration'), ['properties', 'Hidden', 'Destroy', 'Run', 'Create']);
    assert.deepEqual(labels('implementation'), ['properties', 'Run', 'Create', 'Hidden', 'Destroy']);
});
test('type alphabetical order combines independently with member implementation order', () => {
    const source = `unit CombinedOrdering;
interface
type
  TZebra = class
  public
    procedure FirstDeclared;
    procedure SecondDeclared;
  end;
  TAlpha = class
  public
    procedure AlphaRun;
  end;
implementation
procedure TZebra.SecondDeclared; begin end;
procedure TAlpha.AlphaRun; begin end;
procedure TZebra.FirstDeclared; begin end;
end.
`;
    const declared = buildClassNavigatorModel(source, 'CombinedOrdering.pas', {
        memberOrder: 'declaration',
        typeOrder: 'declaration'
    });
    assert.deepEqual(declared.roots.filter(node => node.kind === 'type').map(node => node.label), ['TZebra', 'TAlpha']);
    assert.deepEqual(required(declared.roots.find(node => node.label === 'TZebra')).children.map(node => node.label), ['FirstDeclared', 'SecondDeclared']);
    const combined = buildClassNavigatorModel(source, 'CombinedOrdering.pas', {
        memberOrder: 'implementation',
        typeOrder: 'alphabetical'
    });
    assert.deepEqual(combined.roots.filter(node => node.kind === 'type').map(node => node.label), ['TAlpha', 'TZebra']);
    assert.deepEqual(required(combined.roots.find(node => node.label === 'TZebra')).children.map(node => node.label), ['SecondDeclared', 'FirstDeclared']);
});
test('nested types stay before properties and always keep declaration order', () => {
    const source = `unit NestedOrdering;
interface
type
  THost = class
  private
    property Caption: string read FCaption;
  type
    TZebra = record end;
    TAlpha = class end;
  private
    procedure Run;
  end;
implementation
procedure THost.Run; begin end;
end.
`;
    for (const typeOrder of ['declaration', 'alphabetical']) {
        const host = required(buildClassNavigatorModel(source, 'NestedOrdering.pas', {
            memberOrder: 'implementation',
            typeOrder
        }).roots.find(node => node.label === 'THost'));
        assert.deepEqual(host.children.map(node => node.label), [
            'TZebra', 'TAlpha', 'properties', 'Run'
        ]);
    }
});
test('navigator search is prefix-only unless an asterisk wildcard is used', () => {
    const roots = [{
            id: 'tfirst', kind: 'type', label: 'TFirstService', children: [
                { id: 'properties', kind: 'properties-group', label: 'properties', children: [
                        { id: 'property', kind: 'property', label: 'SearchText', children: [] }
                    ] },
                { id: 'run-search', kind: 'routine', label: 'RunSearch', children: [
                        { id: 'ai-step', kind: 'ai-step', label: 'Prepare search phase', children: [] },
                        { id: 'local-search', kind: 'routine', label: 'LocalSearch', children: [] }
                    ] }
            ]
        }, {
            id: 'archive', kind: 'type', label: 'TSearchArchive', children: []
        }];
    assert.equal(required(findNavigatorEntry(roots, 'tfirst')).label, 'TFirstService');
    assert.equal(required(findNavigatorEntry(roots, 'runsea')).label, 'RunSearch');
    assert.equal(required(findNavigatorEntry(roots, 'localsea')).label, 'LocalSearch');
    assert.equal(findNavigatorEntry(roots, 'search'), undefined);
    assert.equal(required(findNavigatorEntry(roots, '*search')).label, 'RunSearch');
    assert.equal(required(findNavigatorEntry(roots, '*calSea')).label, 'LocalSearch');
    assert.deepEqual(findNavigatorEntries(roots, '*search').map(node => node.label), [
        'RunSearch', 'LocalSearch', 'TSearchArchive'
    ]);
    assert.equal(findNavigatorEntry(roots, 'SearchText'), undefined);
    assert.equal(findNavigatorEntry(roots, 'preparation phase'), undefined);
    assert.equal(findNavigatorEntry(roots, '   '), undefined);
});
test('navigator search filters current and global classes, files, and routines independently', () => {
    const model = buildClassNavigatorModel(SOURCE, 'C:\\Work\\NavigatorSample.pas');
    assert.deepEqual(normalizeNavigatorSearchOptions({}), {
        scope: 'current', types: true, files: false, routines: true, navigation: 'all'
    });
    assert.deepEqual(navigatorSearchResultsForModel(model, 'C:\\Work\\NavigatorSample.pas', 'tfoo', {
        types: true, files: false, routines: false
    }).map(item => item.label), ['TFoo']);
    assert.deepEqual(navigatorSearchResultsForModel(model, 'C:\\Work\\NavigatorSample.pas', '*run', {
        types: false, files: false, routines: true
    }).map(item => item.label), ['GlobalRun', 'Run']);
    assert.deepEqual(navigatorSearchResultsForModel(model, 'C:\\Work\\NavigatorSample.pas', 'navigator', {
        types: false, files: true, routines: false
    }).map(item => item.label), ['NavigatorSample.pas']);
    const typeDefinition: SourceDefinition = {
        unitName: 'OtherUnit', length: 12, line: 1, character: 0,
        kind: 'type', structureKind: 'class', symbol: 'TGlobalThing',
        filePath: 'C:\\Work\\OtherUnit.pas', offset: 20
    };
    const routineDefinition: SourceDefinition = {
        unitName: 'OtherUnit', length: 9, line: 2, character: 0,
        kind: 'routine', symbol: 'GlobalRun', owner: 'TGlobalThing',
        filePath: 'C:\\Work\\OtherUnit.pas', offset: 80, implementationOffset: 180
    };
    const index = { definitions: new Map([
            ['tglobalthing', [typeDefinition]], ['globalrun', [routineDefinition]]
        ]) };
    assert.deepEqual(navigatorSearchResultsForIndex(index, 'global', {
        scope: 'global', types: true, files: false, routines: true, navigation: 'current'
    }).map(item => [item.kind, item.label, item.offset]), [['routine', 'GlobalRun', 180]]);
    assert.deepEqual(navigatorSearchResultsForIndex(index, '*global*', {
        scope: 'global', types: true, files: false, routines: true, navigation: 'confirm'
    }).map(item => item.label), ['GlobalRun', 'TGlobalThing']);
});
test('navigator webview previews active results while moving with arrow keys', () => {
    assert.deepEqual([WebviewMessageKind.SearchActivate, WebviewMessageKind.SearchClosed, WebviewMessageKind.RestoreSearchState],
        ['searchActivate', 'searchClosed', 'restoreSearchState']);
    const script = readBrowserScript();
    assert.match(script, /ArrowDown[\s\S]*?activateResult\(activeResult \+ 1, true\)/);
    assert.match(script, /ArrowUp[\s\S]*?activateResult\(activeResult - 1, true\)/);
    assert.match(script, /shouldPreview\(results\[activeResult\]\)[\s\S]*?WebviewMessageKind\.SearchActivate/);
    assert.match(script, /navigation === "all"[\s\S]*?navigation === "current"/);
    assert.match(script, /searchStartTreeState = captureTreeState\(\)/);
    assert.match(script, /type: WebviewMessageKind\.SearchClosed, restoreState/);
    assert.match(script, /type === WebviewMessageKind\.RestoreSearchState[\s\S]*?restoreTreeState\(data\.state, true\)/);
});
test('cancelled navigator search can resolve the original nested selection by id', () => {
    const model = buildClassNavigatorModel(SOURCE, 'C:\\Work\\NavigatorSample.pas');
    const run = required(model.routineNodes.find(node => node.name === 'Run'));
    assert.equal(navigatorNodeById(model, run.id), run);
    assert.equal(navigatorNodeById(model, 'missing-navigation-node'), undefined);
});
test('confirmed global search results resolve back to the new file navigator node', () => {
    const model = buildClassNavigatorModel(SOURCE, 'C:\\Work\\NavigatorSample.pas');
    const run = required(model.routineNodes.find(node => node.name === 'Run'));
    const resolved = required(navigatorNodeForSearchResult(model, {
        kind: 'routine', name: 'Run', owner: 'TFoo', offset: run.implementationOffset
    }));
    assert.equal(resolved, run);
    const type = required(navigatorNodeForSearchResult(model, {
        kind: 'type', name: 'TFoo', offset: model.typeNodes[0].declarationOffset
    }));
    assert.equal(type.name, 'TFoo');
});
test('navigator webview emits a syntactically valid self-contained client script', () => {
    assert.deepEqual([WebviewMessageKind.SortUpdate, WebviewMessageKind.HideSearch, WebviewMessageKind.HideSort, WebviewMessageKind.FocusChanged],
        ['sortUpdate', 'hideSearch', 'hideSort', 'focusChanged']);
    const scriptUri = 'vscode-webview://test/out/webview/classNavigatorClient.js';
    const html = navigatorWebviewHtml({ cspSource: 'vscode-webview://test' },
        'vscode-webview://test/media/codicon.ttf', scriptUri);
    const script = readBrowserScript();
    assert.doesNotThrow(() => new vm.Script(script));
    assert.match(html, /<script nonce="[^"]+" src="vscode-webview:\/\/test\/out\/webview\/classNavigatorClient\.js"><\/script>/);
    assert.match(html, /id="search" hidden/);
    assert.match(html, /id="sort-panel" hidden/);
    assert.match(html, /id="member-order"[\s\S]*?By visibility[\s\S]*?Declaration order[\s\S]*?Implementation order/);
    assert.match(html, /id="type-order"[\s\S]*?Declaration order[\s\S]*?Alphabetical order/);
    assert.match(script, /type: WebviewMessageKind\.SortUpdate, key, value/);
    assert.match(script, /event\.key === "Escape"[\s\S]*?hideSort\(\)/);
    assert.match(script, /data\.type === WebviewMessageKind\.HideSearch\) hideSearch\(\)/);
    assert.match(script, /data\.type === WebviewMessageKind\.HideSort\) hideSort\(\)/);
    assert.match(script, /vscode\.setState\(\{ expanded:/);
    assert.match(html, /html, body \{[^}]*height:100%;[^}]*min-height:0;[^}]*overflow:hidden;/);
    assert.match(html, /#tree, #results \{[^}]*min-height:0;[^}]*overflow:auto;/);
    assert.match(html, /font-family:'pascal-atlas-codicon'/);
    assert.match(html, /font-src vscode-webview:\/\/test/);
    assert.match(html, /twisty::before \{ content:'\\eab6'; \}/);
    assert.match(html, /twisty\.expanded::before \{ content:'\\eab4'; \}/);
    assert.match(script, /"symbol-method": 60044/);
    assert.match(script, /name === "symbol-constructor"[\s\S]*?--vscode-charts-purple/);
    assert.match(html, /\.icon-properties \{ color:var\(--vscode-charts-blue, #75beff\); \}/);
    assert.match(html, /\.icon-package \{ color:#ffb454; \}/);
    assert.match(html, /\.icon-project-file \{ color:#d2a8ff; \}/);
    assert.match(html, /\.icon-object \{ color:var\(--vscode-charts-yellow, #cca700\); \}/);
    assert.match(script, /object: 60043/);
    assert.doesNotMatch(script, /struct: 60049/);
    assert.match(script, /paddingLeft = depth \* 8/);
    assert.doesNotMatch(html, /<svg viewBox=/);
    assert.match(script, /JSON\.stringify\(\{ webviewSection: section, preventDefaultContextMenuItems: true \}\)/);
    assert.match(script, /document\.addEventListener\("focusin",[\s\S]*?reportWebviewFocus\(true\)/);
    assert.match(script, /window\.addEventListener\("blur",[\s\S]*?reportWebviewFocus\(false\)/);
    assert.match(script, /type: WebviewMessageKind\.FocusChanged, focused/);
    assert.match(script, /row\.addEventListener\("contextmenu", \(\) => setSelected/);
    assert.doesNotMatch(html + script, /id="context"|class="menu-item"|showContext\(/);
});
test('routine kinds use distinct icons while lifecycle routines share one icon', () => {
    assert.equal(routineIconName({ specialRoutineKind: 'constructor' }), 'symbol-constructor');
    assert.equal(routineIconName({ specialRoutineKind: 'destructor' }), 'symbol-constructor');
    assert.equal(routineIconName({ specialRoutineKind: 'initialize' }), 'symbol-constructor');
    assert.equal(routineIconName({ specialRoutineKind: 'finalize' }), 'symbol-constructor');
    assert.notEqual(routineIconName({ specialRoutineKind: 'constructor' }), routineIconName({ routineFlavor: 'instance' }));
    assert.notEqual(routineIconName({ routineFlavor: 'static' }), routineIconName({ routineFlavor: 'class' }));
    assert.notEqual(accessColorId('public'), accessColorId('private'));
    assert.notEqual(accessColorId('protected'), accessColorId('strict-private'));
    assert.equal(accessColorId('public'), accessColorId('published'));
});
test('record Initialize and Finalize are parsed as the same lifecycle icon family', () => {
    const source = `unit ManagedRecord;
interface
type
  TManaged = record
  public
    class operator Initialize(out Dest: TManaged);
    class operator Finalize(var Dest: TManaged);
    class operator Add(const Left, Right: TManaged): TManaged;
  end;
implementation
class operator TManaged.Initialize(out Dest: TManaged); begin end;
class operator TManaged.Finalize(var Dest: TManaged); begin end;
class operator TManaged.Add(const Left, Right: TManaged): TManaged; begin end;
end.
`;
    const managed = required(buildClassNavigatorModel(source, 'ManagedRecord.pas')
        .roots.find(node => node.label === 'TManaged'));
    const initialize = required(managed.children.find(node => node.label === 'Initialize'));
    const finalize = required(managed.children.find(node => node.label === 'Finalize'));
    const add = required(managed.children.find(node => node.label === 'Add'));
    assert.equal(initialize.specialRoutineKind, 'initialize');
    assert.equal(finalize.specialRoutineKind, 'finalize');
    assert.equal(add.specialRoutineKind, 'operator');
    assert.equal(routineIconName(initialize), routineIconName(finalize));
    assert.notEqual(routineIconName(initialize), routineIconName(add));
});
test('class routines expose missing declarations and implementations with useful jump ranges', () => {
    const source = `unit Counterparts;
interface
type
  TDemo = class
  public
    procedure DeclaredOnly;
    function Complete: Integer;
  end;
implementation
function TDemo.Complete: Integer;
begin
  Result := 1;
end;
procedure TDemo.BodyOnly;
  procedure LocalHelper;
  begin
  end;
begin
  LocalHelper;
end;
end.`;
    const model = buildClassNavigatorModel(source, 'Counterparts.pas');
    const demo = required(model.roots.find(node => node.label === 'TDemo'));
    const declared = required(demo.children.find(node => node.name === 'DeclaredOnly'));
    const complete = required(demo.children.find(node => node.name === 'Complete'));
    const orphan = required(demo.children.find(node => node.name === 'BodyOnly'));
    assert.equal(declared.missingCounterpart, 'implementation');
    assert.equal(declared.implementationOffset, undefined);
    assert.equal(complete.missingCounterpart, undefined);
    assert.equal(source.slice(required(complete.implementationOffset), required(complete.implementationOffset) + 8), 'Complete');
    assert.equal(orphan.missingCounterpart, 'declaration');
    assert.equal(orphan.declarationOffset, undefined);
    assert.equal(activeNodeAt(model, source.lastIndexOf('LocalHelper;')), orphan);
    assert.equal(serializeNavigatorNode(orphan).jumpable, true);
    assert.match(required(serializeNavigatorNode(orphan).tooltip), /Missing declaration/);
    assert.match(required(serializeNavigatorNode(declared).tooltip), /Missing implementation/);
    assert.deepEqual(orphan.children.map(node => node.label), ['LocalHelper']);
    assert.equal(orphan.children[0].missingCounterpart, undefined);
});
test('overloads match parameter types rather than implementation occurrence order', () => {
    const source = `unit OverloadedCounterparts;
interface
type
  TDemo = class
  public
    procedure Run(Value: Integer); overload;
    procedure Run(Value: string); overload;
    procedure Pair(A, B: Integer; const Caption: string = 'default');
    class function Calculate(Value: Integer): Integer;
  end;
implementation
procedure TDemo.Run(Text: string);
begin
end;
procedure TDemo.Pair(First: Integer; Second: Integer; const Text: string);
begin
end;
class function TDemo.Calculate(Number: Integer): Integer;
begin
  Result := Number;
end;
end.`;
    const model = buildClassNavigatorModel(source, 'OverloadedCounterparts.pas');
    const methods = model.roots[0].children;
    const integer = required(methods.find(node => (node.signature || '').includes('Run(Value: Integer)')));
    const string = required(methods.find(node => (node.signature || '').includes('Run(Value: string)')));
    assert.equal(integer.missingCounterpart, 'implementation');
    assert.equal(integer.implementationOffset, undefined);
    assert.equal(string.missingCounterpart, undefined);
    assert.equal(string.implementationOffset, source.indexOf('Run(Text: string)'));
    assert.equal(required(methods.find(node => node.name === 'Pair')).missingCounterpart, undefined);
    assert.equal(required(methods.find(node => node.name === 'Calculate')).missingCounterpart, undefined);
    assert.equal(methods.filter(node => node.name === 'Run').length, 2);
});
test('methods with mismatching result types retain both unmatched counterparts', () => {
    const source = `unit ResultCounterparts;
interface
type
  TDemo = class
  public
    function ReadValue: Integer;
  end;
implementation
function TDemo.ReadValue: string;
begin
  Result := '';
end;
end.`;
    const methods = buildClassNavigatorModel(source, 'ResultCounterparts.pas').roots[0].children;
    assert.deepEqual(methods.map(node => node.missingCounterpart).sort(), ['declaration', 'implementation']);
    assert.notEqual(methods[0].id, methods[1].id);
});
test('class owner matching does not steal another class or global routine implementation', () => {
    const source = `unit OwnerCounterparts;
interface
type
  TFirst = class
  public
    procedure Run;
  end;
  TSecond = class
  end;
procedure Run;
implementation
procedure TSecond.Run;
begin
end;
procedure TUnknown.Run;
begin
end;
end.`;
    const model = buildClassNavigatorModel(source, 'OwnerCounterparts.pas');
    const first = required(model.roots.find(node => node.label === 'TFirst')).children[0];
    const second = required(model.roots.find(node => node.label === 'TSecond')).children[0];
    const unknown = required(model.roots.find(node => node.label === 'TUnknown')).children[0];
    assert.equal(first.missingCounterpart, 'implementation');
    assert.equal(first.implementationOffset, undefined);
    assert.equal(second.missingCounterpart, 'declaration');
    assert.equal(second.implementationOffset, source.indexOf('Run;', source.indexOf('procedure TSecond')));
    assert.equal(unknown.missingCounterpart, 'declaration');
    assert.equal(unknown.implementationOffset, source.indexOf('Run;', source.indexOf('procedure TUnknown')));
    const global = required(model.roots.find(node => node.kind === 'global-group')).children[0];
    assert.equal(global.implementationOffset, undefined);
    assert.equal(global.missingCounterpart, undefined);
});
test('abstract methods and interface contracts need no local implementation', () => {
    const source = `unit AbstractCounterparts;
interface
type
  TDemo = class
  public
    procedure AbstractMethod; virtual;
      abstract;
    procedure RegularMethod;
  end;
  IContract = interface
    procedure ContractMethod;
  end;
implementation
end.`;
    const model = buildClassNavigatorModel(source, 'AbstractCounterparts.pas');
    assert.equal(required(model.routineNodes.find(node => node.name === 'AbstractMethod')).missingCounterpart, undefined);
    assert.equal(required(model.routineNodes.find(node => node.name === 'ContractMethod')).missingCounterpart, undefined);
    assert.equal(required(model.routineNodes.find(node => node.name === 'RegularMethod')).missingCounterpart, 'implementation');
});
test('nested class methods with the same name match their lexical owners', () => {
    const source = `unit NestedCounterparts;
interface
type
  TOuter = class
  type
    TInner = class
    public
      procedure Run;
    end;
  public
    procedure Run;
  end;
implementation
procedure TOuter.TInner.Run;
begin
end;
end.`;
    const model = buildClassNavigatorModel(source, 'NestedCounterparts.pas');
    const outer = model.roots[0];
    const inner = required(outer.children.find(node => node.kind === 'type'));
    assert.equal(inner.children[0].missingCounterpart, undefined);
    assert.equal(inner.children[0].implementationOffset, source.indexOf('Run;', source.indexOf('procedure TOuter.TInner')));
    assert.equal(required(outer.children.find(node => node.kind === 'routine')).missingCounterpart, 'implementation');
});
test('abbreviated implementation headings match only unambiguous non-overloaded methods', () => {
    const source = `unit AbbreviatedCounterparts;
interface
type
  TDemo = class
  public
    procedure Save(Value: Integer);
    function ReadValue(Value: Integer): string;
    procedure Run(Value: Integer); overload;
    procedure Run(Value: string); overload;
  end;
implementation
procedure TDemo.Save;
begin
end;
function TDemo.ReadValue;
begin
  Result := '';
end;
procedure TDemo.Run;
begin
end;
end.`;
    const model = buildClassNavigatorModel(source, 'AbbreviatedCounterparts.pas');
    assert.equal(required(model.routineNodes.find(node => node.name === 'Save')).missingCounterpart, undefined);
    assert.equal(required(model.routineNodes.find(node => node.name === 'ReadValue')).missingCounterpart, undefined);
    const overloaded = model.routineNodes.filter(node => node.name === 'Run');
    assert.deepEqual(overloaded.map(node => node.missingCounterpart).sort(), ['declaration', 'implementation', 'implementation']);
});
