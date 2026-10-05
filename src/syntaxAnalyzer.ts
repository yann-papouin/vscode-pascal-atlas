import { inList } from "./shared/guards"
export interface PascalToken {
  type: "word" | "number" | "string" | "symbol"
  value: string
  lower: string
  offset: number
  length: number
}
export interface SyntaxDiagnostic {
  offset: number
  length: number
  code: string
  message: string
  severity: "error" | "warning"
}
export interface SyntaxOptions {
  defines?: readonly string[]
}
import { CompilerDirective, PascalIntrinsic, PascalKeyword } from "./shared/pascal"
/**
 * Create an offset-based lexical diagnostic with a minimum highlight width of one
 * UTF-16 code unit.
 */
function diagnostic(
  offset: number,
  length: number,
  code: string,
  message: string,
  severity: SyntaxDiagnostic["severity"] = "error",
): SyntaxDiagnostic {
  return { offset, length: Math.max(1, length), code, message, severity }
}

/**
 * Parse a compiler-directive name and argument, normalizing the name while leaving
 * argument evaluation to the conditional handler.
 */
function directiveParts(value: string) {
  const match = /^\s*\$\s*([A-Za-z]+)\b([\s\S]*?)\s*$/.exec(value)
  return match ? { name: match[1].toUpperCase(), argument: match[2].trim() } : undefined
}

/**
 * Canonicalize active compiler symbols as trimmed uppercase names, discarding empty
 * entries.
 */
function normalizeDefines(defines: readonly unknown[] | undefined) {
  return new Set(
    (defines || [])
      .map(
        /** Normalize compiler symbols for case-insensitive conditional evaluation. */ (
          value,
        ) => String(value).trim().toUpperCase(),
      )
      .filter(Boolean),
  )
}

/**
 * Evaluate the supported boolean conditional-compilation subset; assume unsupported
 * expressions are active so uncertain preprocessing does not hide real syntax errors.
 */
function evaluateIfExpression(expression: string, defines: ReadonlySet<string>) {
  let source = expression.trim()
  source = source.replace(
    /\bDEFINED\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi,
    /**
     * Substitute the active compiler-symbol truth value before evaluating the
     * conditional expression.
     */ (_, name) => (defines.has(name.toUpperCase()) ? " true " : " false "),
  )
  source = source
    .replace(/\bNOT\b/gi, "!")
    .replace(/\bAND\b/gi, "&&")
    .replace(/\bOR\b/gi, "||")
  if (!/^[\s()!&|truefals0-9]+$/i.test(source)) return true
  try {
    // The expression has been reduced to boolean literals and operators above.
    return Boolean(Function(`"use strict"; return (${source});`)())
  } catch {
    return true
  }
}

/**
 * Tokenize active Pascal code and collect deterministic lexical/directive errors,
 * excluding inactive conditional branches while preserving original UTF-16 offsets.
 */
function tokenizePascal(text: string, options: SyntaxOptions = {}) {
  const tokens: PascalToken[] = []
  const diagnostics = []
  const defines = normalizeDefines(options.defines)
  const conditionals: {
    offset: number
    parentActive: boolean
    branchTaken: boolean
    currentActive: boolean
    elseSeen: boolean
  }[] = []
  let active = true

  /**
   * Recompute whether tokens may be emitted after the conditional stack changes; every
   * enclosing branch must remain active.
   */
  const updateActive = () => {
    active = conditionals.every(
      /** Test whether every enclosing conditional branch is active. */ (item) =>
        item.currentActive,
    )
  }

  /**
   * Advance conditional-compilation frames and report orphan, duplicate, or
   * unterminated branch directives at their original offsets.
   */
  const handleDirective = (raw: string, offset: number, length: number) => {
    const directive = directiveParts(raw)
    if (!directive) return
    // Branch selection and enclosing-branch activity are separate: an ELSE must never reactivate code inside an inactive parent.
    const parentActive = conditionals.every(
      /** Test whether every enclosing conditional branch is active. */ (item) =>
        item.currentActive,
    )
    if (
      directive.name === CompilerDirective.IFDEF ||
      directive.name === CompilerDirective.IFNDEF ||
      directive.name === CompilerDirective.IF
    ) {
      let condition
      if (directive.name === CompilerDirective.IFDEF)
        condition = defines.has(directive.argument.toUpperCase())
      else if (directive.name === CompilerDirective.IFNDEF)
        condition = !defines.has(directive.argument.toUpperCase())
      else condition = evaluateIfExpression(directive.argument, defines)
      conditionals.push({
        offset,
        parentActive,
        branchTaken: parentActive && condition,
        currentActive: parentActive && condition,
        elseSeen: false,
      })
      updateActive()
      return
    }
    if (directive.name === CompilerDirective.ELSEIF) {
      const frame = conditionals.at(-1)
      if (!frame) {
        diagnostics.push(
          diagnostic(
            offset,
            length,
            "pascal.directive.orphanElseIf",
            "Orphan {$ELSEIF} directive.",
          ),
        )
        return
      }
      if (frame.elseSeen) {
        diagnostics.push(
          diagnostic(
            offset,
            length,
            "pascal.directive.afterElse",
            "{$ELSEIF} cannot follow {$ELSE}.",
          ),
        )
      }
      const condition = evaluateIfExpression(directive.argument, defines)
      frame.currentActive = frame.parentActive && !frame.branchTaken && condition
      frame.branchTaken ||= frame.currentActive
      updateActive()
      return
    }
    if (directive.name === CompilerDirective.ELSE) {
      const frame = conditionals.at(-1)
      if (!frame) {
        diagnostics.push(
          diagnostic(
            offset,
            length,
            "pascal.directive.orphanElse",
            "Orphan {$ELSE} directive.",
          ),
        )
        return
      }
      if (frame.elseSeen) {
        diagnostics.push(
          diagnostic(
            offset,
            length,
            "pascal.directive.duplicateElse",
            "Duplicate {$ELSE} directive.",
          ),
        )
      }
      frame.elseSeen = true
      frame.currentActive = frame.parentActive && !frame.branchTaken
      frame.branchTaken ||= frame.currentActive
      updateActive()
      return
    }
    if (
      directive.name === CompilerDirective.ENDIF ||
      directive.name === CompilerDirective.IFEND
    ) {
      if (conditionals.length === 0) {
        diagnostics.push(
          diagnostic(
            offset,
            length,
            "pascal.directive.orphanEndIf",
            "Orphan conditional-compilation terminator.",
          ),
        )
      } else {
        conditionals.pop()
        updateActive()
      }
    }
  }

  /**
   * Append an original-text token and its lowercase comparison key only when all
   * enclosing conditional branches are active.
   */
  const pushToken = (
    type: PascalToken["type"],
    value: string,
    offset: number,
    length = value.length,
  ) => {
    if (active) tokens.push({ type, value, lower: value.toLowerCase(), offset, length })
  }

  for (let index = 0; index < text.length; ) {
    const current = text[index]
    const next = text[index + 1]
    if (/\s/.test(current)) {
      index += 1
      continue
    }
    if (current === "/" && next === "/") {
      const end = text.indexOf("\n", index + 2)
      index = end < 0 ? text.length : end + 1
      continue
    }
    if (current === "{") {
      const end = text.indexOf("}", index + 1)
      if (end < 0) {
        diagnostics.push(
          diagnostic(
            index,
            text.length - index,
            "pascal.comment.unterminated",
            "Unterminated brace comment.",
          ),
        )
        break
      }
      const raw = text.slice(index + 1, end)
      if (/^\s*\$/.test(raw)) handleDirective(raw, index, end - index + 1)
      index = end + 1
      continue
    }
    if (current === "(" && next === "*") {
      const end = text.indexOf("*)", index + 2)
      if (end < 0) {
        diagnostics.push(
          diagnostic(
            index,
            text.length - index,
            "pascal.comment.unterminated",
            "Unterminated parenthesized comment.",
          ),
        )
        break
      }
      const raw = text.slice(index + 2, end)
      if (/^\s*\$/.test(raw)) handleDirective(raw, index, end - index + 2)
      index = end + 2
      continue
    }
    if (current === "'") {
      const start = index
      index += 1
      let closed = false
      while (index < text.length) {
        if (text[index] === "\r" || text[index] === "\n") break
        if (text[index] === "'" && text[index + 1] === "'") {
          index += 2
          continue
        }
        // A doubled quote belongs to the string literal; it must not end the lexer span or shift following token offsets.
        if (text[index] === "'") {
          index += 1
          closed = true
          break
        }
        index += 1
      }
      if (!closed)
        diagnostics.push(
          diagnostic(
            start,
            index - start,
            "pascal.string.unterminated",
            "Unterminated string literal.",
          ),
        )
      else
        pushToken(PascalKeyword.String, text.slice(start, index), start, index - start)
      continue
    }
    if (/[A-Za-z_]/.test(current)) {
      const start = index
      index += 1
      while (index < text.length && /[A-Za-z0-9_]/.test(text[index])) index += 1
      pushToken("word", text.slice(start, index), start, index - start)
      continue
    }
    if (/[0-9]/.test(current)) {
      const start = index
      index += 1
      while (index < text.length && /[A-Za-z0-9_.]/.test(text[index])) index += 1
      pushToken("number", text.slice(start, index), start, index - start)
      continue
    }
    const pair = text.slice(index, index + 2)
    if (inList(pair, [":=", "<=", ">=", "<>", "..", "+=", "-=", "*=", "/="])) {
      pushToken("symbol", pair, index, 2)
      index += 2
      continue
    }
    pushToken("symbol", current, index, 1)
    index += 1
  }

  for (const frame of conditionals) {
    diagnostics.push(
      diagnostic(
        frame.offset,
        1,
        "pascal.directive.unterminated",
        "Conditional-compilation block is missing {$ENDIF}.",
      ),
    )
  }
  return { tokens, diagnostics }
}

/**
 * Read the preceding token, returning undefined at the start of the already
 * whitespace-free stream.
 */
function previousSignificant(tokens: readonly PascalToken[], index: number) {
  return index > 0 ? tokens[index - 1] : undefined
}

/** Read the following token, returning undefined at the end of the token stream. */
function nextSignificant(tokens: readonly PascalToken[], index: number) {
  return index + 1 < tokens.length ? tokens[index + 1] : undefined
}

/**
 * Apply the conservative generic-angle heuristic using the existing nesting depth and
 * adjacent word tokens.
 */
function isGenericOpen(
  tokens: readonly PascalToken[],
  index: number,
  genericDepth: number,
) {
  if (genericDepth > 0) return true
  const previous = previousSignificant(tokens, index)
  const next = nextSignificant(tokens, index)
  if (!previous || !next || next.type !== PascalIntrinsic.Word) return false
  if (
    !(
      previous.type === PascalIntrinsic.Word ||
      previous.value === ">" ||
      previous.value === "]"
    )
  )
    return false
  if (
    previous.type === PascalIntrinsic.Word &&
    /^T[A-Z][A-Za-z0-9]*$/.test(previous.value)
  )
    return true
  return false
}

/**
 * Report unambiguous missing assignment values or declaration types without attempting
 * full Delphi grammar validation.
 */
function addObviousIncompleteDiagnostics(
  tokens: readonly PascalToken[],
  diagnostics: SyntaxDiagnostic[],
) {
  const terminators = new Set<string>([
    ";",
    PascalKeyword.End,
    PascalKeyword.Else,
    PascalKeyword.Until,
  ])
  const assignments = new Set<string>([":=", "+=", "-=", "*=", "/="])
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]
    if (
      assignments.has(token.value) &&
      (!next || terminators.has(next.lower) || terminators.has(next.value))
    ) {
      diagnostics.push(
        diagnostic(
          token.offset,
          token.length,
          "pascal.expression.missingRightHandSide",
          `Assignment '${token.value}' is missing its value.`,
        ),
      )
      continue
    }
    if (token.value === ":" && next?.value === ";") {
      let cursor = index - 1
      while (
        cursor >= 0 &&
        !inList(tokens[cursor].lower, [
          ";",
          PascalKeyword.Var,
          PascalKeyword.Const,
          PascalKeyword.Type,
          PascalKeyword.Function,
          PascalKeyword.Procedure,
          PascalKeyword.Property,
        ])
      )
        cursor -= 1
      if (
        cursor >= 0 &&
        (
          [
            PascalKeyword.Var,
            PascalKeyword.Function,
            PascalKeyword.Property,
          ] as readonly string[]
        ).includes(tokens[cursor].lower)
      ) {
        diagnostics.push(
          diagnostic(
            token.offset,
            token.length,
            "pascal.declaration.missingType",
            "Declaration is missing a type name.",
          ),
        )
      }
    }
    if (token.value === "=" && next?.value === ";") {
      let cursor = index - 1
      while (
        cursor >= 0 &&
        tokens[cursor].value !== ";" &&
        !([PascalKeyword.Const, PascalKeyword.Type] as readonly string[]).includes(
          tokens[cursor].lower,
        )
      )
        cursor -= 1
      if (
        cursor >= 0 &&
        inList(tokens[cursor].lower, [PascalKeyword.Const, PascalKeyword.Type])
      ) {
        diagnostics.push(
          diagnostic(
            token.offset,
            token.length,
            "pascal.declaration.missingValue",
            `${tokens[cursor].lower === PascalKeyword.Type ? "Type" : "Constant"} declaration is incomplete.`,
          ),
        )
      }
    }
  }
}

/**
 * Combine lexical, conditional-directive, delimiter, and obvious incomplete-expression
 * diagnostics, sorted by source offset; leave block grammar to the Delphi compiler.
 */
function analyzePascalSyntax(text: string, options: SyntaxOptions = {}) {
  const tokenized = tokenizePascal(text, options)
  const diagnostics = [...tokenized.diagnostics]
  // Check only deterministic parentheses/brackets here; Delphi begin/end and type-block grammar belongs to compiler diagnostics.
  const delimiterStack: PascalToken[] = []

  for (let index = 0; index < tokenized.tokens.length; index += 1) {
    const token = tokenized.tokens[index]
    if (token.value === "(" || token.value === "[") {
      delimiterStack.push(token)
      continue
    }
    if (token.value === ")" || token.value === "]") {
      const expected = token.value === ")" ? "(" : "["
      const opener = delimiterStack.at(-1)
      if (!opener || opener.value !== expected) {
        diagnostics.push(
          diagnostic(
            token.offset,
            token.length,
            "pascal.delimiter.unexpected",
            `Unexpected '${token.value}'.`,
          ),
        )
      } else {
        delimiterStack.pop()
      }
      continue
    }
  }

  for (const opener of delimiterStack) {
    diagnostics.push(
      diagnostic(
        opener.offset,
        opener.length,
        "pascal.delimiter.unclosed",
        `Unclosed '${opener.value}'.`,
      ),
    )
  }

  addObviousIncompleteDiagnostics(tokenized.tokens, diagnostics)

  diagnostics.sort(
    /** Order diagnostics by source offset, breaking ties by diagnostic code. */ (
      left,
      right,
    ) => left.offset - right.offset || left.code.localeCompare(right.code),
  )
  return diagnostics
}

export { analyzePascalSyntax, evaluateIfExpression, isGenericOpen, tokenizePascal }
