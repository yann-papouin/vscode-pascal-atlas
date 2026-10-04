import { required } from './helpers';
import * as assert from 'node:assert/strict';
import { test as test } from 'node:test';
import { buildAiStepRepairPrompt, buildAiStepPrompt, buildBatchAiStepPrompt, createAiStepNodes, mergeAiStepResponseResults, parseAiStepResponse, parseAiStepResponseResult, parseBatchAiStepResponse, plannedLabelsByHash, routineAnalysisKey, routineSourceRange } from '../src/aiSteps';

const SOURCE = `unit AiStepsSample;
interface
implementation
procedure TRunner.Execute(AValue: Integer);
begin
  if AValue <= 0 then
    Exit;
  Prepare(AValue);
  RunWork;
end;
end.
`;

const ROUTINE = {
  id: 'routine:execute',
  owner: 'TRunner',
  name: 'Execute',
  label: 'Execute',
  signature: 'procedure TRunner.Execute(AValue: Integer);',
  implementationOffset: SOURCE.indexOf('Execute(AValue'),
  implementationEndOffset: SOURCE.lastIndexOf('end;') + 4
};

test('AI step prompt sends numbered source and collapses a short routine to one functional block', () => {
  const result = required(buildAiStepPrompt(SOURCE, ROUTINE, { maxSteps: 5, maxSourceCharacters: 24000 }));
  assert.match(result.prompt, /at most 1 steps/i);
  assert.match(result.prompt, /top-level functional phases/i);
  assert.match(result.prompt, /short routines may return just one step/i);
  assert.match(result.prompt, /strict JSON/i);
  assert.match(result.prompt, /\[00004\] procedure TRunner\.Execute/);
  assert.match(result.prompt, /\[00009\]\s+RunWork/);
  assert.equal(result.startLine, 4);
  assert.equal(result.endLine >= 10, true);
  assert.equal(result.effectiveMaxSteps, 1);
  assert.equal(result.granularity, 'coarse');
});

test('AI step response is normalized, range checked, ordered and capped', () => {
  const range = routineSourceRange(SOURCE, ROUTINE);
  const response = '```json\n{"steps":['
    + '{"title":"2. Prepare work.","line":8},'
    + '{"title":"1. Validate input parameters","line":6},'
    + '{"title":"Out-of-range step","line":99}'
    + ']}\n```';
  assert.deepEqual(parseAiStepResponse(response, range, 8), [
    { title: 'Validate input parameters', line: 6 },
    { title: 'Prepare work', line: 8 }
  ]);
});

test('AI step response accepts provider reasoning, bracketed line numbers and substeps', () => {
  const response = '<think>Analyze the routine structure first {this is not JSON}</think>\n'
    + '```json\n{"result":{"steps":[{"title":"Process input","line":"[00010]",'
    + '"substeps":[{"title":"Read parameters","start_line":"[00011]"},'
    + '{"title":"Transform data","startLine":"[00018]"}]}]}}\n```\n'
    + '{"note":"done"}';
  assert.deepEqual(parseAiStepResponse(response, { startLine: 1, endLine: 40 }, {
    effectiveMaxSteps: 5,
    substepsEnabled: true,
    maxSubsteps: 5,
    substepMinParentLines: 6,
    maxDepth: 3
  }), [{
    title: 'Process input',
    line: 10,
    children: [
      { title: 'Read parameters', line: 11 },
      { title: 'Transform data', line: 18 }
    ]
  }]);
});

test('complex AI steps retain bounded recursive navigable substeps', () => {
  const range = { startLine: 1, endLine: 100 };
  const response = JSON.stringify({
    steps: [
      {
        title: 'Process edge groups',
        line: 10,
        children: [
          { title: 'Initialize current group', line: 12 },
          { title: 'Merge adjacent segments', line: 24, children: [
            { title: 'Find adjacent segments', line: 25 },
            { title: 'Update current edge group', line: 34 }
          ] },
          { title: 'Close out group', line: 42 }
        ]
      },
      { title: 'Validate group connections', line: 60 }
    ]
  });
  const steps = parseAiStepResponse(response, range, {
    effectiveMaxSteps: 5,
    substepsEnabled: true,
    maxSubsteps: 5,
    substepMinParentLines: 6,
    maxDepth: 3
  });
  assert.deepEqual(steps, [
    {
      title: 'Process edge groups',
      line: 10,
      children: [
        { title: 'Initialize current group', line: 12 },
        { title: 'Merge adjacent segments', line: 24, children: [
          { title: 'Find adjacent segments', line: 25 },
          { title: 'Update current edge group', line: 34 }
        ] },
        { title: 'Close out group', line: 42 }
      ]
    },
    { title: 'Validate group connections', line: 60 }
  ]);
});

test('detailed prompt fixes roughly ten-line leaves before asking the model for labels', () => {
  const body = Array.from({ length: 60 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const routine = {
    owner: 'TRunner',
    name: 'ComplexRun',
    implementationOffset: source.indexOf('ComplexRun'),
    implementationEndOffset: source.length
  };
  const result = required(buildAiStepPrompt(source, routine, {
    granularity: 'detailed',
    maxSteps: 10,
    substepsEnabled: true,
    maxSubsteps: 5,
    substepMinParentLines: 12,
    maxDepth: 3,
    targetLinesPerStep: 10
  }));
  assert.equal(result.meaningfulLineCount >= 60, true);
  assert.equal(required(result.fixedPlan).protocol, 'fixed-chunks-v1');
  assert.equal(required(result.fixedPlan).targetLines, 10);
  assert.equal(required(result.fixedPlan).leaves.length, 6);
  assert.equal(required(result.fixedPlan).leaves.every((leaf) => required(leaf.meaningfulLines) >= 8
    && required(leaf.meaningfulLines) <= 13), true);
  assert.equal(required(result.fixedPlan).roots.length, 3);
  assert.match(result.prompt, /Boundaries and hierarchy are fixed/);
  assert.match(result.prompt, /c01: lines 1-10/);
  assert.match(result.prompt, /g1_01: lines 1-20, includes c01, c02/);
  assert.doesNotMatch(result.prompt, /line.*children/i);
});

test('detailed response only labels fixed ids and cannot move source ranges', () => {
  const body = Array.from({ length: 60 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const routine = {
    owner: 'TRunner',
    name: 'ComplexRun',
    implementationOffset: source.indexOf('ComplexRun'),
    implementationEndOffset: source.length
  };
  const analysis = required(buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 10, maxSubsteps: 5,
    maxDepth: 3, targetLinesPerStep: 10
  }));
  const items = required(analysis.fixedPlan).nodes.map((node, index) => ({
    id: node.id,
    title: `Process phase ${index + 1}`,
    line: 9999
  }));
  const result = parseAiStepResponseResult(JSON.stringify({ items }), analysis);
  assert.equal(required(result.missingIds).length, 0);
  assert.equal(result.steps.length, required(analysis.fixedPlan).roots.length);
  assert.deepEqual(result.steps.map((step) => step.line), required(analysis.fixedPlan).roots.map((id) =>
    required(required(analysis.fixedPlan).nodes.find((node) => node.id === id)).line));
  assert.equal(result.steps.every((step) => required(step.children).length === 2), true);
});

test('detailed response accepts streamed one-object-per-line labels', () => {
  const body = Array.from({ length: 20 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const analysis = required(buildAiStepPrompt(source, {
    implementationOffset: 0,
    implementationEndOffset: source.length
  }, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10
  }));
  const firstTwo = required(analysis.unresolvedIds).slice(0, 2);
  const stream = `${JSON.stringify({ id: firstTwo[0], title: 'Process first section' })}\n`
    + `${JSON.stringify({ id: firstTwo[1], title: 'Process final section' })}\n`
    + '{"id":"incomplete"';
  const parsed = parseAiStepResponseResult(stream, analysis);
  assert.equal(parsed.validLabelCount, 2);
  assert.equal(required(parsed.modelLabels)[firstTwo[0]], 'Process first section');
  assert.equal(required(parsed.modelLabels)[firstTwo[1]], 'Process final section');
});

test('detailed response retries only missing ids and keeps deterministic fallbacks', () => {
  const body = Array.from({ length: 30 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const routine = {
    owner: 'TRunner', name: 'ComplexRun', implementationOffset: 0,
    implementationEndOffset: source.length
  };
  const analysis = required(buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10
  }));
  const firstId = required(analysis.unresolvedIds)[0];
  const first = parseAiStepResponseResult(JSON.stringify({
    items: [{ id: firstId, title: 'Process first batch' }]
  }), analysis);
  assert.equal(first.validLabelCount, 1);
  assert.equal(required(first.missingIds).length, required(analysis.unresolvedIds).length - 1);
  const repairPrompt = buildAiStepRepairPrompt(analysis, first.missingIds);
  assert.match(repairPrompt, /Fill in only the IDs listed below/);
  assert.doesNotMatch(repairPrompt, new RegExp(`--- ${firstId} \\[`));
  const repairedId = required(first.missingIds)[0];
  const repairAnalysis = { ...analysis, prompt: repairPrompt };
  const repair = parseAiStepResponseResult(JSON.stringify({
    items: [{ id: repairedId, title: 'Continue processing data' }]
  }), repairAnalysis);
  const merged = mergeAiStepResponseResults(analysis, first, repair);
  assert.equal(merged.validLabelCount, 2);
  assert.equal(required(merged.missingIds).length, required(analysis.unresolvedIds).length - 2);
  assert.equal(merged.steps.length > 0, true);
});

test('fixed detailed labels are reusable through source-block hashes', () => {
  const body = Array.from({ length: 30 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const routine = { implementationOffset: 0, implementationEndOffset: source.length };
  const analysis = required(buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10
  }));
  const response = JSON.stringify({ items: required(analysis.fixedPlan).nodes.map((node, index) => ({
    id: node.id,
    title: `Cached step ${index + 1}`
  })) });
  const result = parseAiStepResponseResult(response, analysis);
  const cached = new Map(plannedLabelsByHash(analysis, result.steps));
  assert.equal(cached.size, required(analysis.fixedPlan).nodes.length);
  const restored = required(buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10, chunkLabelCache: cached
  }));
  assert.deepEqual(restored.unresolvedIds, []);
  assert.match(restored.prompt, /Return all 0 IDs below/);
});

test('AI step nodes are numbered and jump to the requested source line', () => {
  const key = routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE);
  const nodes = createAiStepNodes(SOURCE, ROUTINE, key, [
    { title: 'Validate input parameters', line: 6 },
    { title: 'Run task', line: 9 }
  ]);
  assert.deepEqual(nodes.map((node) => node.label), ['1. Validate input parameters', '2. Run task']);
  assert.equal(SOURCE.slice(nodes[0].offset, required(nodes[0].offset) + 2), 'if');
  assert.equal(SOURCE.slice(nodes[1].offset, required(nodes[1].offset) + 7), 'RunWork');
  assert.equal(nodes.every((node) => node.kind === 'ai-step'), true);
  assert.deepEqual(nodes.map((node) => [node.startLine, node.endLine]), [[6, 8], [9, 10]]);
});

test('a sole AI step omits the redundant number prefix', () => {
  const key = routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE);
  const nodes = createAiStepNodes(SOURCE, ROUTINE, key, [
    { title: 'Run the complete workflow', line: 6 }
  ]);
  assert.equal(nodes[0].label, 'Run the complete workflow');
});

test('AI substep nodes are nested, numbered and split their parent range', () => {
  const source = Array.from({ length: 80 }, (_, index) => `Line${index + 1};`).join('\n');
  const routine = {
    implementationOffset: 0,
    implementationEndOffset: source.length
  };
  const nodes = createAiStepNodes(source, routine, 'nested-key', [{
    title: 'Process edge groups',
    line: 10,
    children: [
      { title: 'Initialize group', line: 12 },
      { title: 'Merge segments', line: 24 }
    ]
  }, { title: 'Validate result', line: 60 }]);
  assert.deepEqual(nodes[0].children.map((node) => node.label), [
    '1.1. Initialize group',
    '1.2. Merge segments'
  ]);
  assert.deepEqual(nodes[0].children.map((node) => [node.startLine, node.endLine]), [
    [12, 23],
    [24, 59]
  ]);
  assert.equal(nodes[0].children.every((node) => node.parent === nodes[0]), true);
});

test('AI cache key changes only when the routine source changes', () => {
  const key = routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE);
  const changed = SOURCE.replace('RunWork;', 'RunWorkFast;');
  const changedKey = routineAnalysisKey('file:///AiStepsSample.pas', changed, {
    ...ROUTINE,
    implementationEndOffset: changed.lastIndexOf('end;') + 4
  });
  assert.notEqual(key, changedKey);
  assert.equal(key, routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE));
});

test('AI cache key changes when functional-block granularity changes', () => {
  const coarse = routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE, {
    granularity: 'coarse', maxSteps: 5
  });
  const balanced = routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE, {
    granularity: 'balanced', maxSteps: 5
  });
  assert.notEqual(coarse, balanced);
});

test('truncated prompts preserve the real line numbers of the retained tail', () => {
  const body = Array.from({ length: 400 }, (_, index) => `  Step${index + 1};`).join('\n');
  const source = `procedure TRunner.LongRun;\nbegin\n${body}\nend;`;
  const routine = {
    owner: 'TRunner',
    name: 'LongRun',
    implementationOffset: source.indexOf('LongRun'),
    implementationEndOffset: source.length
  };
  const result = required(buildAiStepPrompt(source, routine, { maxSourceCharacters: 2000 }));
  assert.equal(result.truncated, true);
  assert.match(result.numberedSource, /\[00402\]\s+Step400;/);
});

test('whole-file AI prompt requests every routine in one JSON response', () => {
  const first = { routine: ROUTINE, analysis: buildAiStepPrompt(SOURCE, ROUTINE, { maxSteps: 5 }) };
  const secondRoutine = { ...ROUTINE, id: 'routine:second', name: 'Second', label: 'Second' };
  const second = { routine: secondRoutine, analysis: buildAiStepPrompt(SOURCE, secondRoutine, { maxSteps: 5 }) };
  const batch = required(buildBatchAiStepPrompt([first, second]));
  assert.equal(batch.entries.length, 2);
  assert.match(batch.prompt, /Process all 2 routines below in one request/);
  assert.match(batch.prompt, /--- r1 ---/);
  assert.match(batch.prompt, /--- r2 ---/);
  const parsed = parseBatchAiStepResponse(JSON.stringify({ routines: [
    { id: 'r1', steps: [{ title: 'Validate input', line: 6 }] },
    { id: 'r2', steps: [{ title: 'Run task', line: 9 }] }
  ] }), batch);
  assert.deepEqual(parsed.map((item) => [item.id, item.steps]), [
    ['r1', [{ title: 'Validate input', line: 6 }]],
    ['r2', [{ title: 'Run task', line: 9 }]]
  ]);
});
