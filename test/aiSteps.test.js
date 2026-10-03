'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildAiStepRepairPrompt,
  buildAiStepPrompt,
  buildBatchAiStepPrompt,
  createAiStepNodes,
  mergeAiStepResponseResults,
  parseAiStepResponse,
  parseAiStepResponseResult,
  parseBatchAiStepResponse,
  plannedLabelsByHash,
  routineAnalysisKey,
  routineSourceRange
} = require('../src/aiSteps');

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
  const result = buildAiStepPrompt(SOURCE, ROUTINE, { maxSteps: 5, maxSourceCharacters: 24000 });
  assert.match(result.prompt, /最多 1 步/);
  assert.match(result.prompt, /顶层功能阶段/);
  assert.match(result.prompt, /短函数可以只返回 1 步/);
  assert.match(result.prompt, /严格 JSON/);
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
    + '{"title":"2. 执行准备工作。","line":8},'
    + '{"title":"1、校验输入参数","line":6},'
    + '{"title":"越界步骤","line":99}'
    + ']}\n```';
  assert.deepEqual(parseAiStepResponse(response, range, 8), [
    { title: '校验输入参数', line: 6 },
    { title: '执行准备工作', line: 8 }
  ]);
});

test('AI step response accepts provider reasoning, bracketed line numbers and substeps', () => {
  const response = '<think>先分析函数结构 {这不是 JSON}</think>\n'
    + '```json\n{"result":{"steps":[{"title":"处理输入","line":"[00010]",'
    + '"substeps":[{"title":"读取参数","start_line":"[00011]"},'
    + '{"title":"转换数据","startLine":"[00018]"}]}]}}\n```\n'
    + '{"note":"done"}';
  assert.deepEqual(parseAiStepResponse(response, { startLine: 1, endLine: 40 }, {
    effectiveMaxSteps: 5,
    substepsEnabled: true,
    maxSubsteps: 5,
    substepMinParentLines: 6,
    maxDepth: 3
  }), [{
    title: '处理输入',
    line: 10,
    children: [
      { title: '读取参数', line: 11 },
      { title: '转换数据', line: 18 }
    ]
  }]);
});

test('complex AI steps retain bounded recursive navigable substeps', () => {
  const range = { startLine: 1, endLine: 100 };
  const response = JSON.stringify({
    steps: [
      {
        title: '处理边组',
        line: 10,
        children: [
          { title: '初始化当前分组', line: 12 },
          { title: '合并相切线段', line: 24, children: [
            { title: '查找相邻线段', line: 25 },
            { title: '更新当前边组', line: 34 }
          ] },
          { title: '收尾闭合分组', line: 42 }
        ]
      },
      { title: '校验分组连接', line: 60 }
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
      title: '处理边组',
      line: 10,
      children: [
        { title: '初始化当前分组', line: 12 },
        { title: '合并相切线段', line: 24, children: [
          { title: '查找相邻线段', line: 25 },
          { title: '更新当前边组', line: 34 }
        ] },
        { title: '收尾闭合分组', line: 42 }
      ]
    },
    { title: '校验分组连接', line: 60 }
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
  const result = buildAiStepPrompt(source, routine, {
    granularity: 'detailed',
    maxSteps: 10,
    substepsEnabled: true,
    maxSubsteps: 5,
    substepMinParentLines: 12,
    maxDepth: 3,
    targetLinesPerStep: 10
  });
  assert.equal(result.meaningfulLineCount >= 60, true);
  assert.equal(result.fixedPlan.protocol, 'fixed-chunks-v1');
  assert.equal(result.fixedPlan.targetLines, 10);
  assert.equal(result.fixedPlan.leaves.length, 6);
  assert.equal(result.fixedPlan.leaves.every(leaf => leaf.meaningfulLines >= 8
    && leaf.meaningfulLines <= 13), true);
  assert.equal(result.fixedPlan.roots.length, 3);
  assert.match(result.prompt, /边界和层级已经确定/);
  assert.match(result.prompt, /c01: 行 1-10/);
  assert.match(result.prompt, /g1_01: 行 1-20，包含 c01, c02/);
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
  const analysis = buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 10, maxSubsteps: 5,
    maxDepth: 3, targetLinesPerStep: 10
  });
  const items = analysis.fixedPlan.nodes.map((node, index) => ({
    id: node.id,
    title: `处理阶段${index + 1}`,
    line: 9999
  }));
  const result = parseAiStepResponseResult(JSON.stringify({ items }), analysis);
  assert.equal(result.missingIds.length, 0);
  assert.equal(result.steps.length, analysis.fixedPlan.roots.length);
  assert.deepEqual(result.steps.map(step => step.line), analysis.fixedPlan.roots.map(id =>
    analysis.fixedPlan.nodes.find(node => node.id === id).line));
  assert.equal(result.steps.every(step => step.children.length === 2), true);
});

test('detailed response accepts streamed one-object-per-line labels', () => {
  const body = Array.from({ length: 20 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const analysis = buildAiStepPrompt(source, {
    implementationOffset: 0,
    implementationEndOffset: source.length
  }, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10
  });
  const firstTwo = analysis.unresolvedIds.slice(0, 2);
  const stream = `${JSON.stringify({ id: firstTwo[0], title: '处理前段数据' })}\n`
    + `${JSON.stringify({ id: firstTwo[1], title: '处理后段数据' })}\n`
    + '{"id":"incomplete"';
  const parsed = parseAiStepResponseResult(stream, analysis);
  assert.equal(parsed.validLabelCount, 2);
  assert.equal(parsed.modelLabels[firstTwo[0]], '处理前段数据');
  assert.equal(parsed.modelLabels[firstTwo[1]], '处理后段数据');
});

test('detailed response retries only missing ids and keeps deterministic fallbacks', () => {
  const body = Array.from({ length: 30 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const routine = {
    owner: 'TRunner', name: 'ComplexRun', implementationOffset: 0,
    implementationEndOffset: source.length
  };
  const analysis = buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10
  });
  const firstId = analysis.unresolvedIds[0];
  const first = parseAiStepResponseResult(JSON.stringify({
    items: [{ id: firstId, title: '处理第一批数据' }]
  }), analysis);
  assert.equal(first.validLabelCount, 1);
  assert.equal(first.missingIds.length, analysis.unresolvedIds.length - 1);
  const repairPrompt = buildAiStepRepairPrompt(analysis, first.missingIds);
  assert.match(repairPrompt, /只补齐下面列出的 id/);
  assert.doesNotMatch(repairPrompt, new RegExp(`--- ${firstId} \\[`));
  const repairedId = first.missingIds[0];
  const repair = parseAiStepResponseResult(JSON.stringify({
    items: [{ id: repairedId, title: '继续处理数据' }]
  }), { ...analysis, prompt: repairPrompt });
  const merged = mergeAiStepResponseResults(analysis, first, repair);
  assert.equal(merged.validLabelCount, 2);
  assert.equal(merged.missingIds.length, analysis.unresolvedIds.length - 2);
  assert.equal(merged.steps.length > 0, true);
});

test('fixed detailed labels are reusable through source-block hashes', () => {
  const body = Array.from({ length: 30 }, (_, index) => `  ProcessStep(${index + 1});`).join('\n');
  const source = `procedure TRunner.ComplexRun;\nbegin\n${body}\nend;`;
  const routine = { implementationOffset: 0, implementationEndOffset: source.length };
  const analysis = buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10
  });
  const response = JSON.stringify({ items: analysis.fixedPlan.nodes.map((node, index) => ({
    id: node.id,
    title: `缓存步骤${index + 1}`
  })) });
  const result = parseAiStepResponseResult(response, analysis);
  const cached = new Map(plannedLabelsByHash(analysis, result.steps));
  assert.equal(cached.size, analysis.fixedPlan.nodes.length);
  const restored = buildAiStepPrompt(source, routine, {
    granularity: 'detailed', maxSteps: 8, maxSubsteps: 6,
    maxDepth: 3, targetLinesPerStep: 10, chunkLabelCache: cached
  });
  assert.deepEqual(restored.unresolvedIds, []);
  assert.match(restored.prompt, /必须返回以下 0 个 id/);
});

test('AI step nodes are numbered and jump to the requested source line', () => {
  const key = routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE);
  const nodes = createAiStepNodes(SOURCE, ROUTINE, key, [
    { title: '校验输入参数', line: 6 },
    { title: '执行任务', line: 9 }
  ]);
  assert.deepEqual(nodes.map(node => node.label), ['1. 校验输入参数', '2. 执行任务']);
  assert.equal(SOURCE.slice(nodes[0].offset, nodes[0].offset + 2), 'if');
  assert.equal(SOURCE.slice(nodes[1].offset, nodes[1].offset + 7), 'RunWork');
  assert.equal(nodes.every(node => node.kind === 'ai-step'), true);
  assert.deepEqual(nodes.map(node => [node.startLine, node.endLine]), [[6, 8], [9, 10]]);
});

test('a sole AI step omits the redundant number prefix', () => {
  const key = routineAnalysisKey('file:///AiStepsSample.pas', SOURCE, ROUTINE);
  const nodes = createAiStepNodes(SOURCE, ROUTINE, key, [
    { title: '执行完整流程', line: 6 }
  ]);
  assert.equal(nodes[0].label, '执行完整流程');
});

test('AI substep nodes are nested, numbered and split their parent range', () => {
  const source = Array.from({ length: 80 }, (_, index) => `Line${index + 1};`).join('\n');
  const routine = {
    implementationOffset: 0,
    implementationEndOffset: source.length
  };
  const nodes = createAiStepNodes(source, routine, 'nested-key', [{
    title: '处理边组',
    line: 10,
    children: [
      { title: '初始化分组', line: 12 },
      { title: '合并线段', line: 24 }
    ]
  }, { title: '校验结果', line: 60 }]);
  assert.deepEqual(nodes[0].children.map(node => node.label), [
    '1.1. 初始化分组',
    '1.2. 合并线段'
  ]);
  assert.deepEqual(nodes[0].children.map(node => [node.startLine, node.endLine]), [
    [12, 23],
    [24, 59]
  ]);
  assert.equal(nodes[0].children.every(node => node.parent === nodes[0]), true);
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
  const result = buildAiStepPrompt(source, routine, { maxSourceCharacters: 2000 });
  assert.equal(result.truncated, true);
  assert.match(result.numberedSource, /\[00402\]\s+Step400;/);
});

test('whole-file AI prompt requests every routine in one JSON response', () => {
  const first = { routine: ROUTINE, analysis: buildAiStepPrompt(SOURCE, ROUTINE, { maxSteps: 5 }) };
  const secondRoutine = { ...ROUTINE, id: 'routine:second', name: 'Second', label: 'Second' };
  const second = { routine: secondRoutine, analysis: buildAiStepPrompt(SOURCE, secondRoutine, { maxSteps: 5 }) };
  const batch = buildBatchAiStepPrompt([first, second]);
  assert.equal(batch.entries.length, 2);
  assert.match(batch.prompt, /一次处理下面全部 2 个函数/);
  assert.match(batch.prompt, /--- r1 ---/);
  assert.match(batch.prompt, /--- r2 ---/);
  const parsed = parseBatchAiStepResponse(JSON.stringify({ routines: [
    { id: 'r1', steps: [{ title: '校验输入', line: 6 }] },
    { id: 'r2', steps: [{ title: '执行任务', line: 9 }] }
  ] }), batch);
  assert.deepEqual(parsed.map(item => [item.id, item.steps]), [
    ['r1', [{ title: '校验输入', line: 6 }]],
    ['r2', [{ title: '执行任务', line: 9 }]]
  ]);
});
