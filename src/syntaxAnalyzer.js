'use strict';

function diagnostic(offset, length, code, message, severity = 'error') {
  return { offset, length: Math.max(1, length), code, message, severity };
}

function directiveParts(value) {
  const match = /^\s*\$\s*([A-Za-z]+)\b([\s\S]*?)\s*$/.exec(value);
  return match ? { name: match[1].toUpperCase(), argument: match[2].trim() } : undefined;
}

function normalizeDefines(defines) {
  return new Set((defines || []).map(value => String(value).trim().toUpperCase()).filter(Boolean));
}

function evaluateIfExpression(expression, defines) {
  let source = expression.trim();
  source = source.replace(/\bDEFINED\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi,
    (_, name) => defines.has(name.toUpperCase()) ? ' true ' : ' false ');
  source = source.replace(/\bNOT\b/gi, '!').replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||');
  if (!/^[\s()!&|truefals0-9]+$/i.test(source)) return true;
  try {
    // The expression has been reduced to boolean literals and operators above.
    return Boolean(Function(`"use strict"; return (${source});`)());
  } catch {
    return true;
  }
}

function tokenizePascal(text, options = {}) {
  const tokens = [];
  const diagnostics = [];
  const defines = normalizeDefines(options.defines);
  const conditionals = [];
  let active = true;

  const updateActive = () => {
    active = conditionals.every(item => item.currentActive);
  };

  const handleDirective = (raw, offset, length) => {
    const directive = directiveParts(raw);
    if (!directive) return;
    const parentActive = conditionals.every(item => item.currentActive);
    if (directive.name === 'IFDEF' || directive.name === 'IFNDEF' || directive.name === 'IF') {
      let condition;
      if (directive.name === 'IFDEF') condition = defines.has(directive.argument.toUpperCase());
      else if (directive.name === 'IFNDEF') condition = !defines.has(directive.argument.toUpperCase());
      else condition = evaluateIfExpression(directive.argument, defines);
      conditionals.push({
        offset,
        parentActive,
        branchTaken: parentActive && condition,
        currentActive: parentActive && condition,
        elseSeen: false
      });
      updateActive();
      return;
    }
    if (directive.name === 'ELSEIF') {
      const frame = conditionals.at(-1);
      if (!frame) {
        diagnostics.push(diagnostic(offset, length, 'pascal.directive.orphanElseIf', 'Orphan {$ELSEIF} directive.'));
        return;
      }
      if (frame.elseSeen) {
        diagnostics.push(diagnostic(offset, length, 'pascal.directive.afterElse', '{$ELSEIF} cannot follow {$ELSE}.'));
      }
      const condition = evaluateIfExpression(directive.argument, defines);
      frame.currentActive = frame.parentActive && !frame.branchTaken && condition;
      frame.branchTaken ||= frame.currentActive;
      updateActive();
      return;
    }
    if (directive.name === 'ELSE') {
      const frame = conditionals.at(-1);
      if (!frame) {
        diagnostics.push(diagnostic(offset, length, 'pascal.directive.orphanElse', 'Orphan {$ELSE} directive.'));
        return;
      }
      if (frame.elseSeen) {
        diagnostics.push(diagnostic(offset, length, 'pascal.directive.duplicateElse', 'Duplicate {$ELSE} directive.'));
      }
      frame.elseSeen = true;
      frame.currentActive = frame.parentActive && !frame.branchTaken;
      frame.branchTaken ||= frame.currentActive;
      updateActive();
      return;
    }
    if (directive.name === 'ENDIF' || directive.name === 'IFEND') {
      if (conditionals.length === 0) {
        diagnostics.push(diagnostic(offset, length, 'pascal.directive.orphanEndIf', 'Orphan conditional-compilation terminator.'));
      } else {
        conditionals.pop();
        updateActive();
      }
    }
  };

  const pushToken = (type, value, offset, length = value.length) => {
    if (active) tokens.push({ type, value, lower: value.toLowerCase(), offset, length });
  };

  for (let index = 0; index < text.length;) {
    const current = text[index];
    const next = text[index + 1];
    if (/\s/.test(current)) {
      index += 1;
      continue;
    }
    if (current === '/' && next === '/') {
      const end = text.indexOf('\n', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if (current === '{') {
      const end = text.indexOf('}', index + 1);
      if (end < 0) {
        diagnostics.push(diagnostic(index, text.length - index, 'pascal.comment.unterminated', 'Unterminated brace comment.'));
        break;
      }
      const raw = text.slice(index + 1, end);
      if (/^\s*\$/.test(raw)) handleDirective(raw, index, end - index + 1);
      index = end + 1;
      continue;
    }
    if (current === '(' && next === '*') {
      const end = text.indexOf('*)', index + 2);
      if (end < 0) {
        diagnostics.push(diagnostic(index, text.length - index, 'pascal.comment.unterminated', 'Unterminated parenthesized comment.'));
        break;
      }
      const raw = text.slice(index + 2, end);
      if (/^\s*\$/.test(raw)) handleDirective(raw, index, end - index + 2);
      index = end + 2;
      continue;
    }
    if (current === "'") {
      const start = index;
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] === '\r' || text[index] === '\n') break;
        if (text[index] === "'" && text[index + 1] === "'") {
          index += 2;
          continue;
        }
        if (text[index] === "'") {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (!closed) diagnostics.push(diagnostic(start, index - start, 'pascal.string.unterminated', 'Unterminated string literal.'));
      else pushToken('string', text.slice(start, index), start, index - start);
      continue;
    }
    if (/[A-Za-z_]/.test(current)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index += 1;
      pushToken('word', text.slice(start, index), start, index - start);
      continue;
    }
    if (/[0-9]/.test(current)) {
      const start = index;
      index += 1;
      while (index < text.length && /[A-Za-z0-9_.]/.test(text[index])) index += 1;
      pushToken('number', text.slice(start, index), start, index - start);
      continue;
    }
    const pair = text.slice(index, index + 2);
    if ([':=', '<=', '>=', '<>', '..', '+=', '-=', '*=', '/='].includes(pair)) {
      pushToken('symbol', pair, index, 2);
      index += 2;
      continue;
    }
    pushToken('symbol', current, index, 1);
    index += 1;
  }

  for (const frame of conditionals) {
    diagnostics.push(diagnostic(frame.offset, 1, 'pascal.directive.unterminated', 'Conditional-compilation block is missing {$ENDIF}.'));
  }
  return { tokens, diagnostics };
}

function previousSignificant(tokens, index) {
  return index > 0 ? tokens[index - 1] : undefined;
}

function nextSignificant(tokens, index) {
  return index + 1 < tokens.length ? tokens[index + 1] : undefined;
}

function isGenericOpen(tokens, index, genericDepth) {
  if (genericDepth > 0) return true;
  const previous = previousSignificant(tokens, index);
  const next = nextSignificant(tokens, index);
  if (!previous || !next || next.type !== 'word') return false;
  if (!(previous.type === 'word' || previous.value === '>' || previous.value === ']')) return false;
  if (previous.type === 'word' && /^T[A-Z][A-Za-z0-9]*$/.test(previous.value)) return true;
  return false;
}

function addObviousIncompleteDiagnostics(tokens, diagnostics) {
  const terminators = new Set([';', 'end', 'else', 'until']);
  const assignments = new Set([':=', '+=', '-=', '*=', '/=']);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (assignments.has(token.value) && (!next || terminators.has(next.lower) || terminators.has(next.value))) {
      diagnostics.push(diagnostic(token.offset, token.length, 'pascal.expression.missingRightHandSide',
        `Assignment '${token.value}' is missing its value.`));
      continue;
    }
    if (token.value === ':' && next?.value === ';') {
      let cursor = index - 1;
      while (cursor >= 0 && ![';', 'var', 'const', 'type', 'function', 'procedure', 'property'].includes(tokens[cursor].lower)) cursor -= 1;
      if (cursor >= 0 && ['var', 'function', 'property'].includes(tokens[cursor].lower)) {
        diagnostics.push(diagnostic(token.offset, token.length, 'pascal.declaration.missingType', 'Declaration is missing a type name.'));
      }
    }
    if (token.value === '=' && next?.value === ';') {
      let cursor = index - 1;
      while (cursor >= 0 && tokens[cursor].value !== ';' && !['const', 'type'].includes(tokens[cursor].lower)) cursor -= 1;
      if (cursor >= 0 && ['const', 'type'].includes(tokens[cursor].lower)) {
        diagnostics.push(diagnostic(token.offset, token.length, 'pascal.declaration.missingValue',
          `${tokens[cursor].lower === 'type' ? 'Type' : 'Constant'} declaration is incomplete.`));
      }
    }
  }
}

function analyzePascalSyntax(text, options = {}) {
  const tokenized = tokenizePascal(text, options);
  const diagnostics = [...tokenized.diagnostics];
  const delimiterStack = [];

  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index];
    if (token.value === '(' || token.value === '[') {
      delimiterStack.push(token);
      continue;
    }
    if (token.value === ')' || token.value === ']') {
      const expected = token.value === ')' ? '(' : '[';
      const opener = delimiterStack.at(-1);
      if (!opener || opener.value !== expected) {
        diagnostics.push(diagnostic(token.offset, token.length, 'pascal.delimiter.unexpected', `Unexpected '${token.value}'.`));
      } else {
        delimiterStack.pop();
      }
      continue;
    }
  }

  for (const opener of delimiterStack) {
    diagnostics.push(diagnostic(opener.offset, opener.length, 'pascal.delimiter.unclosed', `Unclosed '${opener.value}'.`));
  }

  addObviousIncompleteDiagnostics(tokenized.tokens, diagnostics);

  diagnostics.sort((left, right) => left.offset - right.offset || left.code.localeCompare(right.code));
  return diagnostics;
}

module.exports = {
  analyzePascalSyntax,
  evaluateIfExpression,
  isGenericOpen,
  tokenizePascal
};
