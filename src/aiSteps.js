'use strict';

const { createHash } = require('node:crypto');

const AI_STEP_CACHE_STATE_KEY = 'pascalUnion.classNavigator.aiSteps.cache.v1';
const AI_STEP_CHUNK_CACHE_STATE_KEY = 'pascalUnion.classNavigator.aiSteps.chunkCache.v1';
const AI_STEP_PROMPT_VERSION = 7;
const DEFAULT_MAX_SOURCE_CHARACTERS = 24000;

function lineStartOffset(text, offset) {
  return Math.max(0, text.lastIndexOf('\n', Math.max(0, offset - 1)) + 1);
}

function lineNumberAt(text, offset) {
  let line = 1;
  for (let index = 0; index < Math.min(text.length, Math.max(0, offset)); index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function offsetAtLine(text, oneBasedLine) {
  if (oneBasedLine <= 1) return 0;
  let line = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    line += 1;
    if (line === oneBasedLine) return index + 1;
  }
  return text.length;
}

function routineSourceRange(text, node) {
  if (!Number.isInteger(node?.implementationOffset)) return undefined;
  const startOffset = lineStartOffset(text, node.implementationOffset);
  const rawEnd = Number.isInteger(node.implementationEndOffset)
    ? node.implementationEndOffset
    : text.length;
  const endOffset = Math.max(startOffset, Math.min(text.length, rawEnd));
  let meaningfulEndOffset = endOffset;
  while (meaningfulEndOffset > startOffset && /\s/.test(text[meaningfulEndOffset - 1])) {
    meaningfulEndOffset -= 1;
  }
  return {
    startOffset,
    endOffset,
    startLine: lineNumberAt(text, startOffset),
    endLine: lineNumberAt(text, Math.max(startOffset, meaningfulEndOffset - 1))
  };
}

function routineAnalysisKey(documentUri, text, node, options = {}) {
  const range = routineSourceRange(text, node);
  if (!range) return undefined;
  const identity = [node.owner || 'global', node.name || node.label || '', node.signature || '']
    .join('|').toLowerCase();
  const sourceHash = createHash('sha256')
    .update(text.slice(range.startOffset, range.endOffset))
    .digest('hex')
    .slice(0, 20);
  const granularity = ['balanced', 'detailed'].includes(options.granularity)
    ? options.granularity
    : 'coarse';
  const strategy = [
    granularity,
    Math.max(1, Math.min(12, Number(options.maxSteps) || 5)),
    Math.max(2000, Number(options.maxSourceCharacters) || DEFAULT_MAX_SOURCE_CHARACTERS),
    options.substepsEnabled === false ? 'flat' : 'nested',
    Math.max(2, Math.min(8, Number(options.maxSubsteps) || 5)),
    Math.max(6, Math.min(100, Number(options.substepMinParentLines) || 30)),
    Math.max(2, Math.min(5, Number(options.maxDepth) || 3)),
    Math.max(6, Math.min(50, Number(options.targetLinesPerStep) || 20))
  ].join(':');
  return `v${AI_STEP_PROMPT_VERSION}|${strategy}|${documentUri}|${identity}|${sourceHash}`;
}

function buildRoutineAnalysisContext(text, node, maxSourceCharacters = DEFAULT_MAX_SOURCE_CHARACTERS) {
  const range = routineSourceRange(text, node);
  if (!range) return undefined;
  const completeSource = text.slice(range.startOffset, range.endOffset);
  const limit = Math.max(2000, Number(maxSourceCharacters) || DEFAULT_MAX_SOURCE_CHARACTERS);
  const lines = completeSource.split(/\r?\n/);
  const numberedLine = (line, index) =>
    `[${String(range.startLine + index).padStart(5, '0')}] ${line}`;
  let truncated = false;
  let numberedSource;
  if (completeSource.length <= limit) {
    numberedSource = lines.map(numberedLine).join('\n');
  } else {
    truncated = true;
    const headBudget = Math.floor(limit * 0.72);
    const tailBudget = Math.floor(limit * 0.28);
    let headEnd = 0;
    let headSize = 0;
    while (headEnd < lines.length && headSize + lines[headEnd].length + 1 <= headBudget) {
      headSize += lines[headEnd].length + 1;
      headEnd += 1;
    }
    let tailStart = lines.length;
    let tailSize = 0;
    while (tailStart > headEnd && tailSize + lines[tailStart - 1].length + 1 <= tailBudget) {
      tailStart -= 1;
      tailSize += lines[tailStart].length + 1;
    }
    numberedSource = [
      ...lines.slice(0, headEnd).map((line, index) => numberedLine(line, index)),
      '{ ... 中间代码因长度限制省略 ... }',
      ...lines.slice(tailStart).map((line, index) => numberedLine(line, tailStart + index))
    ].join('\n');
  }
  return {
    ...range,
    truncated,
    numberedSource
  };
}

function compactPascalLine(line, state) {
  let result = '';
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    const next = line[index + 1];
    if (state.comment === 'brace') {
      if (character === '}') state.comment = '';
      continue;
    }
    if (state.comment === 'paren') {
      if (character === '*' && next === ')') {
        state.comment = '';
        index += 1;
      }
      continue;
    }
    if (state.string) {
      if (character === "'" && next === "'") {
        index += 1;
      } else if (character === "'") {
        state.string = false;
      }
      result += ' ';
      continue;
    }
    if (character === '/' && next === '/') break;
    if (character === '{') {
      state.comment = 'brace';
      continue;
    }
    if (character === '(' && next === '*') {
      state.comment = 'paren';
      index += 1;
      continue;
    }
    if (character === "'") {
      state.string = true;
      result += ' ';
      continue;
    }
    result += character;
  }
  return result.trim();
}

function balancedPartitions(items, count) {
  const result = [];
  let offset = 0;
  for (let index = 0; index < count; index += 1) {
    const remaining = items.length - offset;
    const partitions = count - index;
    const size = Math.ceil(remaining / partitions);
    result.push(items.slice(offset, offset + size));
    offset += size;
  }
  return result.filter(part => part.length > 0);
}

function fallbackPlannedTitle(node, index) {
  if (node.kind === 'group') return `整理功能阶段${index + 1}`;
  const first = node.codeLines.find(line => line.code)?.code || '';
  if (/^if\b/i.test(first)) return '判断并处理条件';
  if (/^(?:for|while|repeat)\b/i.test(first)) return '遍历并处理数据';
  if (/^case\b/i.test(first)) return '处理条件分支';
  if (/^(?:try|except|finally)\b/i.test(first)) return '执行异常保护';
  if (/^result\s*:=/i.test(first)) return '整理并返回结果';
  if (/^(?:exit|break|continue)\b/i.test(first)) return '结束当前处理';
  return `处理代码块${index + 1}`;
}

function buildDetailedStepPlan(text, context, options = {}) {
  if (!context || context.truncated) return undefined;
  const targetLines = Math.max(6, Math.min(30, Number(options.targetLinesPerStep) || 10));
  const minLines = Math.max(4, Math.floor(targetLines * 0.7));
  const maxLines = Math.max(targetLines + 3, Math.ceil(targetLines * 1.4));
  const maxSubsteps = Math.max(2, Math.min(8, Number(options.maxSubsteps) || 6));
  const maxDepth = Math.max(2, Math.min(5, Number(options.maxDepth) || 3));
  const maxRoots = Math.max(2, Math.min(12, Number(options.maxSteps) || 8));
  const source = text.slice(context.startOffset, context.endOffset);
  const rawLines = source.split(/\r?\n/);
  const state = { comment: '', string: false, parentheses: 0, brackets: 0 };
  const codeLines = rawLines.map((raw, index) => {
    const code = compactPascalLine(raw, state);
    for (const character of code) {
      if (character === '(') state.parentheses += 1;
      else if (character === ')') state.parentheses = Math.max(0, state.parentheses - 1);
      else if (character === '[') state.brackets += 1;
      else if (character === ']') state.brackets = Math.max(0, state.brackets - 1);
    }
    const safeBoundary = state.parentheses === 0 && state.brackets === 0
      && (/;\s*$/.test(code) || /^end\b[.;]?\s*$/i.test(code));
    return {
      raw,
      code,
      index,
      line: context.startLine + index,
      meaningful: code.length > 0,
      safeBoundary
    };
  });
  const meaningful = codeLines.filter(line => line.meaningful);
  if (!meaningful.length) return undefined;

  const leafRanges = [];
  let startMeaningful = 0;
  while (startMeaningful < meaningful.length) {
    const remaining = meaningful.length - startMeaningful;
    if (remaining <= maxLines || (leafRanges.length > 0 && remaining < minLines)) {
      leafRanges.push([startMeaningful, meaningful.length - 1]);
      break;
    }
    const targetEnd = Math.min(meaningful.length - 1, startMeaningful + targetLines - 1);
    const maximumEnd = Math.min(meaningful.length - 1, startMeaningful + maxLines - 1);
    const minimumEnd = Math.min(maximumEnd, startMeaningful + minLines - 1);
    let end = -1;
    for (let index = targetEnd; index <= maximumEnd; index += 1) {
      if (meaningful[index].safeBoundary) {
        end = index;
        break;
      }
    }
    if (end < 0) {
      for (let index = targetEnd - 1; index >= minimumEnd; index -= 1) {
        if (meaningful[index].safeBoundary) {
          end = index;
          break;
        }
      }
    }
    if (end < 0) {
      end = maximumEnd;
      while (end + 1 < meaningful.length && !meaningful[end].safeBoundary
        && end - startMeaningful + 1 < maxLines * 2) end += 1;
    }
    leafRanges.push([startMeaningful, end]);
    startMeaningful = end + 1;
  }

  if (leafRanges.length > 1) {
    const last = leafRanges[leafRanges.length - 1];
    if (last[1] - last[0] + 1 < minLines) {
      leafRanges[leafRanges.length - 2][1] = last[1];
      leafRanges.pop();
    }
  }

  const nodes = new Map();
  const leaves = leafRanges.map((range, index) => {
    const first = meaningful[range[0]];
    const last = meaningful[range[1]];
    const nextFirst = leafRanges[index + 1] ? meaningful[leafRanges[index + 1][0]] : undefined;
    const startIndex = first.index;
    const endIndex = nextFirst ? Math.max(startIndex, nextFirst.index - 1) : rawLines.length - 1;
    const chunkSource = rawLines.slice(startIndex, endIndex + 1).join('\n');
    const node = {
      id: `c${String(index + 1).padStart(2, '0')}`,
      kind: 'leaf',
      line: first.line,
      endLine: context.startLine + endIndex,
      meaningfulLines: range[1] - range[0] + 1,
      codeLines: codeLines.slice(startIndex, endIndex + 1),
      source: chunkSource,
      children: [],
      hash: createHash('sha256').update(`leaf\n${chunkSource}`).digest('hex').slice(0, 24)
    };
    nodes.set(node.id, node);
    return node;
  });

  let level = leaves;
  let depth = 1;
  while (level.length > maxRoots && depth < maxDepth) {
    const minimumParents = Math.ceil(level.length / maxSubsteps);
    const desiredParents = Math.max(
      minimumParents,
      Math.min(maxRoots, Math.floor(level.length / 2))
    );
    const groups = balancedPartitions(level, desiredParents).map((children, index) => {
      const node = {
        id: `g${depth}_${String(index + 1).padStart(2, '0')}`,
        kind: 'group',
        line: children[0].line,
        endLine: children[children.length - 1].endLine,
        children: children.map(child => child.id),
        codeLines: [],
        hash: createHash('sha256')
          .update(`group\n${children.map(child => child.hash).join('\n')}`)
          .digest('hex').slice(0, 24)
      };
      nodes.set(node.id, node);
      return node;
    });
    level = groups;
    depth += 1;
  }
  for (const [index, node] of [...nodes.values()].entries()) {
    node.fallbackTitle = fallbackPlannedTitle(node, index);
  }
  return {
    protocol: 'fixed-chunks-v1',
    targetLines,
    minLines,
    maxLines,
    leaves,
    nodes: [...nodes.values()],
    roots: level.map(node => node.id),
    maxDepth: depth
  };
}

function plannedPrompt(plan, context, signature, cachedLabels = new Map()) {
  const labels = {};
  for (const node of plan.nodes) {
    const cached = cachedLabels instanceof Map
      ? cachedLabels.get(node.hash)
      : cachedLabels?.[node.hash];
    if (cached) labels[node.id] = normalizeStepTitle(cached);
  }
  const unresolved = plan.nodes.filter(node => !labels[node.id]);
  const descriptions = plan.nodes.map(node => node.kind === 'leaf'
    ? `${node.id}: 行 ${node.line}-${node.endLine}${labels[node.id] ? `，已有标题“${labels[node.id]}”` : ''}`
    : `${node.id}: 行 ${node.line}-${node.endLine}，包含 ${node.children.join(', ')}${labels[node.id] ? `，已有标题“${labels[node.id]}”` : ''}`);
  const sources = plan.leaves
    .filter(node => !labels[node.id])
    .map(node => `--- ${node.id} [${node.line}-${node.endLine}] ---\n${node.source}`);
  return {
    cachedLabels: labels,
    unresolvedIds: unresolved.map(node => node.id),
    prompt: [
      '你是 Delphi/Object Pascal 代码导航助手。',
      `函数 ${signature} 已由本地语法分析器切成约 ${plan.targetLines} 行的固定代码块。`,
      '边界和层级已经确定，不要重新划分、合并、遗漏或改变任何 id。',
      '请只为尚无标题的 id 生成简短清晰的中文功能名称；叶子名称描述该代码块的具体作用，父级名称概括其 children。',
      '名称不要带序号，不超过 14 个汉字，不要解释。',
      `必须返回以下 ${unresolved.length} 个 id；每行只输出一个完整 JSON 对象，不要数组、Markdown 或代码围栏：`,
      '{"id":"c01","title":"校验输入参数"}',
      '{"id":"g1_01","title":"准备分组数据"}',
      '',
      '固定结构：',
      ...descriptions,
      '',
      '需要分析的代码块：',
      ...sources
    ].join('\n')
  };
}

function buildAiStepPrompt(text, node, options = {}) {
  const context = buildRoutineAnalysisContext(text, node, options.maxSourceCharacters);
  if (!context) return undefined;
  const configuredMaxSteps = Math.max(1, Math.min(12, Number(options.maxSteps) || 5));
  const granularity = ['balanced', 'detailed'].includes(options.granularity)
    ? options.granularity
    : 'coarse';
  const substepsEnabled = options.substepsEnabled !== false;
  const maxSubsteps = Math.max(2, Math.min(8, Number(options.maxSubsteps) || 5));
  const maxDepth = Math.max(2, Math.min(5, Number(options.maxDepth) || 3));
  const substepMinParentLines = Math.max(
    6,
    Math.min(100, Number(options.substepMinParentLines) || 30)
  );
  const targetLinesPerStep = Math.max(
    6,
    Math.min(50, Number(options.targetLinesPerStep) || (granularity === 'detailed' ? 10 : 20))
  );
  const source = text.slice(context.startOffset, context.endOffset);
  const meaningfulLineCount = source.split(/\r?\n/)
    .filter(line => line.trim().length > 0).length;
  // A hard density ceiling prevents a model from turning every branch or call
  // into a navigation item. Small routines intentionally collapse to one step.
  // Detailed output stays hierarchical: top-level phases remain broad while
  // recursive leaves approach the configured reading granularity.
  const linesPerStep = granularity === 'detailed'
    ? Math.max(24, targetLinesPerStep * 3)
    : targetLinesPerStep;
  const effectiveMaxSteps = Math.min(
    configuredMaxSteps,
    Math.max(1, Math.ceil(meaningfulLineCount / linesPerStep))
  );
  if (granularity === 'detailed') {
    const fixedPlan = buildDetailedStepPlan(text, context, {
      ...options,
      maxSteps: effectiveMaxSteps,
      targetLinesPerStep
    });
    if (fixedPlan) {
      const fixedPrompt = plannedPrompt(
        fixedPlan,
        context,
        node.signature || `${node.owner ? `${node.owner}.` : ''}${node.name || node.label}`,
        options.chunkLabelCache
      );
      return {
        ...context,
        meaningfulLineCount,
        targetLinesPerStep,
        effectiveMaxSteps,
        granularity,
        substepsEnabled,
        maxSubsteps,
        maxDepth,
        substepMinParentLines,
        fixedPlan,
        cachedLabels: fixedPrompt.cachedLabels,
        unresolvedIds: fixedPrompt.unresolvedIds,
        prompt: fixedPrompt.prompt
      };
    }
  }
  const granularityRules = granularity === 'coarse'
    ? [
        '只识别顶层功能阶段，不要做逐语句摘要。',
        '把相邻的参数校验、变量准备、若干赋值、若干函数调用和结果收尾分别合并为较大的功能块。',
        '单个 if/for/赋值/函数调用/注释标题通常不能独立成为一步；只有承担独立业务目的时才可以。',
        '每一步应覆盖一段有明确目的的连续实现；常规情况下尽量覆盖十几行有效代码，短函数可以只返回 1 步。',
        '不要为了达到最大步骤数而拆分；步骤数越少但能表达完整功能阶段越好。'
      ]
    : granularity === 'detailed' ? [
        '细致识别函数中的业务阶段、数据转换、循环处理、重要分支、状态切换和结果收尾，但仍不要逐语句摘要。',
        `每个复杂父步骤尽量拆成若干较细的连续功能块；最细叶子步骤目标约 ${targetLinesPerStep} 行有效代码。`,
        '二级步骤不能只做粗略概括：内部仍包含多段循环、分支或状态处理时，必须继续递归添加 children，所有层级使用相同的细分标准。',
        '对于较长且包含多层循环、分支或状态处理的复杂函数，不能只返回扁平的顶层步骤；至少一个复杂顶层步骤必须包含两个或更多 children，并对仍然复杂的 children 继续递归。',
        '单个简单赋值、简单判断或单次函数调用仍不能独立成为步骤。'
      ] : [
        '按有意义的实现阶段归纳，不要把单个赋值或单次函数调用机械地拆成一步。',
        '相邻且目的相同的语句应合并。'
      ];
  return {
    ...context,
    meaningfulLineCount,
    targetLinesPerStep,
    effectiveMaxSteps,
    granularity,
    substepsEnabled,
    maxSubsteps,
    maxDepth,
    substepMinParentLines,
    prompt: [
      '你是 Delphi/Object Pascal 代码导航助手。',
      '请把下面这个函数的执行逻辑整理成简短、清晰、按执行顺序排列的中文功能块。',
      ...granularityRules,
      `最多 ${effectiveMaxSteps} 步。步骤名称不要带序号，不超过 14 个汉字，不要解释。`,
      substepsEnabled
        ? `如果任一步骤预计覆盖至少 ${substepMinParentLines} 行、并且内部确实包含多个可独立定位的功能阶段，可递归增加 children；每层最多 ${maxSubsteps} 个，最多 ${maxDepth} 层。`
        : '',
      substepsEnabled
        ? '简单步骤不要添加 children，也不要把单个判断、赋值或调用拆成子步骤。'
        : '',
      '每一步的 line 必须是该步骤在所给源码中实际开始的方括号行号。',
      '只输出严格 JSON，不要 Markdown，不要代码围栏：',
      substepsEnabled
        ? '{"steps":[{"title":"处理输入数据","line":42,"children":[{"title":"校验有效性","line":43},{"title":"建立分组","line":68,"children":[{"title":"创建索引","line":70}]}]}]}'
        : '{"steps":[{"title":"校验输入参数","line":42}]}',
      context.truncated
        ? '源码过长并已省略中段；只为可见代码生成能可靠定位的步骤。'
        : '',
      '',
      `函数：${node.signature || `${node.owner ? `${node.owner}.` : ''}${node.name || node.label}`}`,
      context.numberedSource
    ].filter(Boolean).join('\n')
  };
}

function buildBatchAiStepPrompt(requests) {
  const entries = (requests || [])
    .filter(request => request?.analysis?.numberedSource)
    .map((request, index) => ({ id: `r${index + 1}`, request }));
  if (!entries.length) return undefined;
  const first = entries[0].request.analysis;
  const detailed = first.granularity === 'detailed';
  const routineBlocks = entries.map(({ id, request }) => [
    `--- ${id} ---`,
    `函数：${request.routine.signature || `${request.routine.owner ? `${request.routine.owner}.` : ''}${request.routine.name || request.routine.label}`}`,
    `最多 ${request.analysis.effectiveMaxSteps} 个顶层步骤。`,
    request.analysis.numberedSource
  ].join('\n'));
  return {
    entries,
    prompt: [
      '你是 Delphi/Object Pascal 代码导航助手。',
      `请一次处理下面全部 ${entries.length} 个函数，为每个函数生成简短、清晰、按执行顺序排列的中文功能块。`,
      '必须为每个 id 返回且只返回一个结果；不要遗漏、合并或改写 id。',
      detailed
        ? '细致识别业务阶段、数据转换、循环处理和重要分支；复杂阶段继续递归细分，但不要逐语句摘要。'
        : '只识别承担独立业务目的的功能阶段，不要把单个判断、赋值、调用或几行小代码机械拆成一步。',
      '步骤标题不要带序号，不超过 14 个汉字；line 必须是步骤在所给源码中实际开始的方括号行号。',
      first.substepsEnabled
        ? `复杂步骤可递归增加 children，每层最多 ${first.maxSubsteps} 个、最多 ${first.maxDepth} 层；简单步骤不要添加 children。`
        : '不要生成 children。',
      '只输出严格 JSON，不要 Markdown，不要代码围栏：',
      '{"routines":[{"id":"r1","steps":[{"title":"校验输入","line":42},{"title":"处理数据","line":55,"children":[{"title":"建立索引","line":57}]}]}]}',
      '',
      ...routineBlocks
    ].join('\n\n')
  };
}

function jsonCandidate(value) {
  const text = String(value || '').trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1];
  const candidate = fenced || text;
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart >= 0 && objectEnd > objectStart) return candidate.slice(objectStart, objectEnd + 1);
  const arrayStart = candidate.indexOf('[');
  const arrayEnd = candidate.lastIndexOf(']');
  if (arrayStart >= 0 && arrayEnd > arrayStart) return candidate.slice(arrayStart, arrayEnd + 1);
  return candidate;
}

function jsonCandidates(value) {
  const text = String(value || '').trim();
  const candidates = [];
  const add = candidate => {
    const normalized = String(candidate || '').trim();
    if (normalized && !candidates.includes(normalized)) candidates.push(normalized);
  };
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) add(match[1]);
  add(text);
  add(jsonCandidate(text));

  // Compatible providers may prepend reasoning or append another object.
  // Extract balanced JSON values instead of joining the first opening brace
  // to the final closing brace, which would make otherwise valid JSON fail.
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    const stack = [];
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{' || character === '[') stack.push(character);
      else if (character === '}' || character === ']') {
        const opening = stack.pop();
        if ((opening === '{' && character !== '}') || (opening === '[' && character !== ']')) break;
        if (!stack.length) {
          add(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return candidates;
}

function parseJsonResponse(value) {
  for (const candidate of jsonCandidates(value)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next fenced/balanced candidate.
    }
  }
  return undefined;
}

function normalizeStepTitle(value) {
  return String(value || '')
    .replace(/^\s*(?:第\s*)?\d+\s*[.、:：)）-]?\s*/u, '')
    .replace(/[。；;]+$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
}

function normalizedStepEntries(entries, range, limit) {
  const result = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const title = normalizeStepTitle(entry?.title ?? entry?.name ?? entry?.label);
    const rawLine = entry?.line ?? entry?.startLine ?? entry?.start_line;
    const line = typeof rawLine === 'number'
      ? rawLine
      : Number(String(rawLine ?? '').match(/\d+/)?.[0]);
    if (!title || !/[\u3400-\u9fff]/u.test(title) || !Number.isInteger(line)) continue;
    if (line < range.startLine || line > range.endLine) continue;
    const key = `${line}:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ title, line, source: entry });
    if (result.length >= limit) break;
  }
  return result.sort((left, right) => left.line - right.line);
}

function plannedLabelsFromResponse(value, analysis) {
  const plan = analysis?.fixedPlan;
  const knownIds = new Set(plan?.nodes?.map(node => node.id) || []);
  const labels = { ...(analysis?.cachedLabels || {}) };
  const modelLabels = {};
  const absorb = parsed => {
    const rows = parsed?.id
      ? [parsed]
      : Array.isArray(parsed)
        ? parsed
        : parsed?.items ?? parsed?.labels ?? parsed?.result?.items ?? parsed?.data?.items;
    if (Array.isArray(rows)) {
      for (const row of rows) {
        const id = String(row?.id || '').trim();
        const title = normalizeStepTitle(row?.title ?? row?.name ?? row?.label);
        if (!knownIds.has(id) || !title || !/[\u3400-\u9fff]/u.test(title)) continue;
        labels[id] = title;
        modelLabels[id] = title;
      }
    } else if (rows && typeof rows === 'object') {
      for (const [id, value] of Object.entries(rows)) {
        const title = normalizeStepTitle(value);
        if (!knownIds.has(id) || !title || !/[\u3400-\u9fff]/u.test(title)) continue;
        labels[id] = title;
        modelLabels[id] = title;
      }
    }
  };
  const seen = new Set();
  for (const candidate of jsonCandidates(value)) {
    try {
      const parsed = JSON.parse(candidate);
      const signature = JSON.stringify(parsed);
      if (seen.has(signature)) continue;
      seen.add(signature);
      absorb(parsed);
    } catch {
      // Streaming text can end with an incomplete final JSON line.
    }
  }
  return { labels, modelLabels };
}

function plannedStepsFromLabels(analysis, labels = {}) {
  const plan = analysis?.fixedPlan;
  if (!plan) return [];
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const create = id => {
    const node = byId.get(id);
    if (!node) return undefined;
    const children = node.children.map(create).filter(Boolean);
    return {
      title: labels[id] || node.fallbackTitle,
      line: node.line,
      ...(children.length ? { children } : {})
    };
  };
  return plan.roots.map(create).filter(Boolean);
}

function parseAiStepResponseResult(value, analysis, limits = analysis) {
  if (analysis?.fixedPlan) {
    const { labels, modelLabels } = plannedLabelsFromResponse(value, analysis);
    const unresolvedIds = analysis.unresolvedIds || analysis.fixedPlan.nodes.map(node => node.id);
    const missingIds = unresolvedIds.filter(id => !modelLabels[id]);
    return {
      planned: true,
      steps: plannedStepsFromLabels(analysis, labels),
      labels,
      modelLabels,
      missingIds,
      validLabelCount: Object.keys(modelLabels).length
    };
  }
  const steps = parseAiStepResponse(value, analysis, limits);
  return {
    planned: false,
    steps,
    labels: {},
    modelLabels: {},
    missingIds: [],
    validLabelCount: steps.length
  };
}

function mergeAiStepResponseResults(analysis, first, second) {
  if (!analysis?.fixedPlan) return second?.steps?.length ? second : first;
  const labels = {
    ...(analysis.cachedLabels || {}),
    ...(first?.modelLabels || {}),
    ...(second?.modelLabels || {})
  };
  const unresolvedIds = analysis.unresolvedIds || [];
  const missingIds = unresolvedIds.filter(id => !labels[id]);
  const modelLabels = { ...(first?.modelLabels || {}), ...(second?.modelLabels || {}) };
  return {
    planned: true,
    steps: plannedStepsFromLabels(analysis, labels),
    labels,
    modelLabels,
    missingIds,
    validLabelCount: Object.keys(modelLabels).length
  };
}

function buildAiStepRepairPrompt(analysis, missingIds) {
  const plan = analysis?.fixedPlan;
  if (!plan) return '';
  const wanted = new Set(missingIds || []);
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const descriptions = [...wanted].map(id => {
    const node = byId.get(id);
    if (!node) return '';
    if (node.kind === 'group') {
      const children = node.children.map(childId => {
        const title = analysis.cachedLabels?.[childId];
        return title ? `${childId}（${title}）` : childId;
      });
      return `${id}: 行 ${node.line}-${node.endLine}，包含 ${children.join(', ')}`;
    }
    return `--- ${id} [${node.line}-${node.endLine}] ---\n${node.source}`;
  }).filter(Boolean);
  return [
    '你是 Delphi/Object Pascal 代码导航助手。',
    '上一次结果只有少量 id 缺失。现在只补齐下面列出的 id，不要重复其他项目，也不要改变固定边界。',
    '每个标题必须是简短清晰的中文功能名称，不带序号，不超过 14 个汉字。',
    '每行只输出一个完整 JSON 对象，不要数组、Markdown 或代码围栏：{"id":"c01","title":"处理输入数据"}',
    '',
    ...descriptions
  ].join('\n');
}

function plannedLabelsByHash(analysis, steps) {
  const plan = analysis?.fixedPlan;
  if (!plan) return [];
  const byId = new Map(plan.nodes.map(node => [node.id, node]));
  const result = [];
  const visit = (ids, rows) => {
    for (let index = 0; index < ids.length; index += 1) {
      const node = byId.get(ids[index]);
      const step = rows?.[index];
      if (!node || !step?.title) continue;
      result.push([node.hash, step.title]);
      if (node.children.length) visit(node.children, step.children);
    }
  };
  visit(plan.roots, steps);
  return result;
}

function parseAiStepResponse(value, range, limits = 8) {
  if (range?.fixedPlan) {
    const { labels } = plannedLabelsFromResponse(value, range);
    return plannedStepsFromLabels(range, labels);
  }
  const parsed = parseJsonResponse(value);
  if (parsed === undefined) return [];
  const sourceSteps = Array.isArray(parsed)
    ? parsed
    : parsed?.steps ?? parsed?.result?.steps ?? parsed?.data?.steps;
  if (!Array.isArray(sourceSteps)) return [];
  const options = typeof limits === 'object' && limits ? limits : { effectiveMaxSteps: limits };
  const maxSteps = Math.max(1, Math.min(12,
    Number(options.effectiveMaxSteps ?? options.maxSteps) || 5));
  const substepsEnabled = options.substepsEnabled !== false;
  const maxSubsteps = Math.max(2, Math.min(8, Number(options.maxSubsteps) || 5));
  const maxDepth = Math.max(2, Math.min(5, Number(options.maxDepth) || 3));
  const substepMinParentLines = Math.max(
    6,
    Math.min(100, Number(options.substepMinParentLines) || 30)
  );
  const topSteps = normalizedStepEntries(sourceSteps, range, maxSteps);
  const normalizeLevel = (steps, endLine, depth) => steps.map((step, index) => {
    const itemEndLine = Math.max(
      step.line,
      (steps[index + 1]?.line ?? (endLine + 1)) - 1
    );
    let children = [];
    if (substepsEnabled
      && depth < maxDepth
      && itemEndLine - step.line + 1 >= substepMinParentLines) {
      const childEntries = normalizedStepEntries(
        Array.isArray(step.source?.children)
          ? step.source.children
          : Array.isArray(step.source?.substeps) ? step.source.substeps : [],
        { startLine: step.line, endLine: itemEndLine },
        maxSubsteps
      );
      children = normalizeLevel(childEntries, itemEndLine, depth + 1);
      if (children.length < 2) children = [];
    }
    return {
      title: step.title,
      line: step.line,
      ...(children.length ? { children } : {})
    };
  });
  return normalizeLevel(topSteps, range.endLine, 1);
}

function parseBatchAiStepResponse(value, batch) {
  let parsed;
  try {
    parsed = JSON.parse(jsonCandidate(value));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : parsed?.routines ?? parsed?.results;
  if (!Array.isArray(rows)) return [];
  const byId = new Map(rows.map(row => [String(row?.id || ''), row]));
  return (batch?.entries || []).map(entry => {
    const row = byId.get(entry.id);
    const steps = row
      ? parseAiStepResponse(JSON.stringify({ steps: row.steps }), entry.request.analysis, entry.request.analysis)
      : [];
    return { ...entry, steps };
  });
}

function createStepNode(
  text,
  analysisKey,
  step,
  index,
  endLine,
  parentPrefix = '',
  siblingCount = 1
) {
  const lineOffset = offsetAtLine(text, step.line);
  const sourceLineEnd = text.indexOf('\n', lineOffset);
  const lineText = text.slice(lineOffset, sourceLineEnd < 0 ? text.length : sourceLineEnd);
  const indentation = /^\s*/.exec(lineText)?.[0].length || 0;
  const number = parentPrefix ? `${parentPrefix}.${index + 1}` : `${index + 1}`;
  const node = {
    id: `ai-step:${createHash('sha1').update(`${analysisKey}:${number}:${step.line}`).digest('hex').slice(0, 16)}`,
    kind: 'ai-step',
    label: siblingCount > 1 ? `${number}. ${step.title}` : step.title,
    name: step.title,
    offset: Math.min(text.length, lineOffset + indentation),
    line: step.line,
    startLine: step.line,
    endLine: Math.max(step.line, endLine),
    stepDepth: number.split('.').length,
    children: []
  };
  const children = Array.isArray(step.children) ? step.children : [];
  node.children = children.map((child, childIndex) => createStepNode(
    text,
    analysisKey,
    child,
    childIndex,
    Math.max(child.line, (children[childIndex + 1]?.line ?? (node.endLine + 1)) - 1),
    number,
    children.length
  ));
  for (const child of node.children) child.parent = node;
  return node;
}

function createAiStepNodes(text, routineNode, analysisKey, steps) {
  const routineRange = routineSourceRange(text, routineNode);
  return steps.map((step, index) => createStepNode(
    text,
    analysisKey,
    step,
    index,
    Math.max(
      step.line,
      Number.isInteger(steps[index + 1]?.line)
        ? steps[index + 1].line - 1
        : routineRange?.endLine ?? step.line
    ),
    '',
    steps.length
  ));
}

module.exports = {
  AI_STEP_CACHE_STATE_KEY,
  AI_STEP_CHUNK_CACHE_STATE_KEY,
  AI_STEP_PROMPT_VERSION,
  buildAiStepRepairPrompt,
  buildAiStepPrompt,
  buildBatchAiStepPrompt,
  buildDetailedStepPlan,
  buildRoutineAnalysisContext,
  createAiStepNodes,
  lineStartOffset,
  mergeAiStepResponseResults,
  normalizeStepTitle,
  offsetAtLine,
  parseAiStepResponse,
  parseAiStepResponseResult,
  parseBatchAiStepResponse,
  plannedLabelsByHash,
  routineAnalysisKey,
  routineSourceRange
};
