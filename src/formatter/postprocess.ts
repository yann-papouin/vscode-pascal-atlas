import { LexerState } from '../shared/identifiers';
type PascalLexerState = (typeof LexerState)[keyof typeof LexerState];
export interface BlankLineProtection { lineNumber: number; marker: string; indentation?: string; selectionIndexes?: number[]; resolvedLineNumber?: number; resolvedCharacter?: number; }
import { isInteger } from '../shared/guards';
import { PascalKeyword } from '../shared/pascal';
const DECLARATION_PATTERN = /\b(?:procedure|function|constructor|destructor|operator)\b/i;
import { findGenericTypeSpans, normalizeGenericTypeSpacingOnMaskedLine } from './generics';
const TYPE_SYNTAX_KEYWORDS = new Set<string>([
  PascalKeyword.Array, PascalKeyword.Class, PascalKeyword.Const, PascalKeyword.Constref, PascalKeyword.Dispinterface, PascalKeyword.File, PascalKeyword.Function,
  PascalKeyword.Interface, PascalKeyword.Object, PascalKeyword.Of, PascalKeyword.Out, PascalKeyword.Packed, PascalKeyword.Procedure, PascalKeyword.Record,
  PascalKeyword.Reference, PascalKeyword.Set, PascalKeyword.Specialize, PascalKeyword.To, PascalKeyword.Type, PascalKeyword.Var
]);
const TYPE_SPAN_TERMINATORS = new Set<string>([
  PascalKeyword.Absolute, PascalKeyword.Abstract, PascalKeyword.Assembler, PascalKeyword.Cdecl, PascalKeyword.Default, PascalKeyword.Deprecated, PascalKeyword.Dispid,
  PascalKeyword.Do, PascalKeyword.Dynamic, PascalKeyword.Experimental, PascalKeyword.External, PascalKeyword.Final, PascalKeyword.Forward, PascalKeyword.Implements,
  PascalKeyword.Index, PascalKeyword.Inline, PascalKeyword.Message, PascalKeyword.Name, PascalKeyword.Nodefault, PascalKeyword.Overload, PascalKeyword.Override,
  PascalKeyword.Platform, PascalKeyword.Read, PascalKeyword.Register, PascalKeyword.Reintroduce, PascalKeyword.Safecall, PascalKeyword.Sealed, PascalKeyword.Static,
  PascalKeyword.Stdcall, PascalKeyword.Stored, PascalKeyword.Unsafe, PascalKeyword.Varargs, PascalKeyword.Virtual, PascalKeyword.Write
]);
const NON_TYPE_AFTER_COLON = new Set<string>([
  PascalKeyword.Asm, PascalKeyword.Begin, PascalKeyword.Break, PascalKeyword.Case, PascalKeyword.Continue, PascalKeyword.Else, PascalKeyword.End, PascalKeyword.Except, PascalKeyword.Exit,
  PascalKeyword.Finally, PascalKeyword.For, PascalKeyword.Goto, PascalKeyword.If, PascalKeyword.Inherited, PascalKeyword.Raise, PascalKeyword.Repeat, PascalKeyword.Try, PascalKeyword.While,
  PascalKeyword.With
]);

/**
 * Replaces comments and string contents with spaces while preserving code columns.
 * Block comments and strings may continue across lines.
 * @param {string[]} lines Pascal source split into lines.
 * @returns {string[]} Code-only lines aligned with the source.
 * @example
 * maskPascalLines(["begin {x}"]); // ["begin    "]
 */
function maskPascalLines(lines: string[]) {
  let state: PascalLexerState = LexerState.Code;

  return lines.map((line) => {
    const characters = [...line];
    let index = 0;

    while (index < characters.length) {
      if (state === LexerState.BraceComment) {
        const original = characters[index];
        characters[index] = " ";
        if (original === "}") {
          state = LexerState.Code;
        }
        index += 1;
        continue;
      }

      if (state === LexerState.ParenComment) {
        if (line.startsWith("*)", index)) {
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 2;
          state = LexerState.Code;
        } else {
          characters[index] = " ";
          index += 1;
        }
        continue;
      }

      if (state === LexerState.String) {
        characters[index] = " ";
        if (line[index] === "'") {
          if (line[index + 1] === "'") {
            characters[index + 1] = " ";
            index += 2;
          } else {
            index += 1;
            state = LexerState.Code;
          }
        } else {
          index += 1;
        }
        continue;
      }

      if (line.startsWith("//", index)) {
        characters.fill(" ", index);
        break;
      }
      if (line[index] === "{") {
        characters[index] = " ";
        state = LexerState.BraceComment;
        index += 1;
        continue;
      }
      if (line.startsWith("(*", index)) {
        characters[index] = " ";
        characters[index + 1] = " ";
        state = LexerState.ParenComment;
        index += 2;
        continue;
      }
      if (line[index] === "'") {
        characters[index] = " ";
        state = LexerState.String;
      }
      index += 1;
    }

    return characters.join("");
  });
}

/**
 * Uppercases eligible identifiers in a mutable character array over a code span.
 * Parameter names, range bounds, and Pascal syntax keywords are left alone.
 * @param {string[]} characters Mutable characters corresponding to `codeLine`.
 * @param {string} codeLine Comment- and string-masked source line.
 * @param {number} start Inclusive start column.
 * @param {number} end Exclusive end column.
 * @example
 * const chars = [..."value: point"];
 * capitalizeIdentifierCharacters(chars, "value: point", 7, 12);
 * chars.join(""); // "value: Point"
 */
function capitalizeIdentifierCharacters(characters: string[], codeLine: string, start: number, end: number) {
  const identifier = /\b[A-Za-z_]\w*\b/g;
  identifier.lastIndex = start;
  let match;

  while ((match = identifier.exec(codeLine)) !== null && match.index < end) {
    const remainder = codeLine.slice(match.index + match[0].length, end);
    const isParameterName = /^(?:\s*,\s*[A-Za-z_]\w*)*\s*:/.test(remainder);
    const openSquareBracket = codeLine.lastIndexOf("[", match.index);
    const closeSquareBracket = codeLine.lastIndexOf("]", match.index);
    const isRangeBound =
      openSquareBracket > closeSquareBracket &&
      codeLine.slice(openSquareBracket, codeLine.indexOf("]", match.index) + 1).includes("..");
    if (
      !isParameterName &&
      !isRangeBound &&
      !TYPE_SYNTAX_KEYWORDS.has(match[0].toLowerCase())
    ) {
      characters[match.index] = characters[match.index].toUpperCase();
    }
  }
}

/**
 * Finds where a type expression ends at a top-level separator or directive.
 * Nested generic, array, and parameter delimiters do not end the span.
 * @param {string} codeLine Comment- and string-masked source line.
 * @param {number} start Column where the type expression begins.
 * @returns {{end:number, terminator:string}} End column and terminating token.
 * @example
 * findTypeSpanEnd("Point; Value", 0); // { end: 5, terminator: ";" }
 */
function findTypeSpanEnd(codeLine: string, start: number) {
  let angleDepth = 0;
  let parenthesisDepth = 0;
  let squareDepth = 0;

  for (let index = start; index < codeLine.length; index += 1) {
    const character = codeLine[index];
    if (character === "<") {
      angleDepth += 1;
      continue;
    }
    if (character === ">" && angleDepth > 0) {
      angleDepth -= 1;
      continue;
    }
    if (character === "[") {
      squareDepth += 1;
      continue;
    }
    if (character === "]" && squareDepth > 0) {
      squareDepth -= 1;
      continue;
    }
    if (character === "(") {
      parenthesisDepth += 1;
      continue;
    }
    if (character === ")") {
      if (parenthesisDepth === 0 && angleDepth === 0 && squareDepth === 0) {
        return { end: index, terminator: ")" };
      }
      parenthesisDepth = Math.max(0, parenthesisDepth - 1);
      continue;
    }

    if (angleDepth === 0 && parenthesisDepth === 0 && squareDepth === 0) {
      if (character === ";") {
        return { end: index, terminator: ";" };
      }
      if (character === ":" && codeLine[index + 1] === "=") {
        return { end: index, terminator: ":=" };
      }
      if (character === "=") {
        return { end: index, terminator: "=" };
      }
      if (/[A-Za-z_]/.test(character)) {
        const wordMatch = codeLine.slice(index).match(/^[A-Za-z_]\w*/);
        if (wordMatch && TYPE_SPAN_TERMINATORS.has(wordMatch[0].toLowerCase())) {
          return { end: index, terminator: wordMatch[0].toLowerCase() };
        }
        index += (wordMatch?.[0].length ?? 1) - 1;
      }
    }
  }

  return { end: codeLine.length, terminator: PascalKeyword.End };
}

/**
 * Decides whether a colon introduces a type declaration instead of a value.
 * @param {string} codeLine Comment- and string-masked source line.
 * @param {number} colonIndex Column of the colon.
 * @param {{end:number, terminator:string}} span Type span following the colon.
 * @param {{section?:string, typeBlockDepth:number}} context Current parser context.
 * @returns {boolean} Whether identifiers in the following span are type names.
 * @example
 * isDeclarationColon("Value: Integer", 5, { end: 14, terminator: "end" },
 *   { section: "var", typeBlockDepth: 0 }); // true
 */
function isDeclarationColon(codeLine: string, colonIndex: number, span: { end: number; terminator: string }, context: { section: string | undefined; typeBlockDepth: number; }) {
  const prefix = codeLine.slice(0, colonIndex);
  const segmentStart = Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("("));
  const segment = prefix.slice(segmentStart + 1).trim();
  if (/^(?:[-+]?\d|[$%&][0-9A-Fa-f])/.test(segment)) {
    return false;
  }

  const declarationContext =
    context.section === PascalKeyword.Var ||
    context.section === PascalKeyword.Const ||
    context.typeBlockDepth > 0 ||
    /\b(?:const|constref|function|operator|out|procedure|property|var)\b/i.test(prefix);
  return span.terminator !== ":=" || declarationContext;
}

/**
 * Capitalizes type identifiers in declarations, annotations, and type operators.
 * @param {string} line Original source line, including comments and strings.
 * @param {string} codeLine The same line with comments and strings masked.
 * @param {{section?:string, typeBlockDepth:number}} context Current parser context.
 * @returns {string} Source line with recognized type names capitalized.
 * @example
 * capitalizeTypeNamesOnLine("value: point", "value: point",
 *   { section: "var", typeBlockDepth: 0 }); // "value: Point"
 */
function capitalizeTypeNamesOnLine(line: string, codeLine: string, context: { section: string | undefined; typeBlockDepth: number }) {
  const characters = [...line];
  const inlineTypeDeclaration = /^\s*type\b/i.test(codeLine);
  const declarationMatch = codeLine.match(/^\s*(?:type\s+)?([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*=\s*/i);
  const rightHandSide = declarationMatch
    ? codeLine.slice((declarationMatch.index ?? 0) + declarationMatch[0].length)
    : "";
  const clearlyTypeDeclaration = /^(?:packed\s+)?(?:array|class|dispinterface|file|interface|object|record|reference|set)\b|^\^/i
    .test(rightHandSide);

  if (
    declarationMatch &&
    (context.section === PascalKeyword.Type || inlineTypeDeclaration || clearlyTypeDeclaration)
  ) {
    const nameStart = codeLine.indexOf(declarationMatch[1], declarationMatch.index);
    characters[nameStart] = characters[nameStart].toUpperCase();

    const simpleAliasMatch = rightHandSide.match(/^\s*\^?\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*(?:\s*<[^;]+>)?)/);
    if (
      simpleAliasMatch &&
      !TYPE_SYNTAX_KEYWORDS.has(simpleAliasMatch[1].trim().toLowerCase())
    ) {
      const aliasStart = (declarationMatch.index ?? 0) + declarationMatch[0].length + (simpleAliasMatch.index ?? 0);
      const aliasEnd = aliasStart + simpleAliasMatch[0].length;
      capitalizeIdentifierCharacters(characters, codeLine, aliasStart, aliasEnd);
    }
  }

  const colon = /:/g;
  let colonMatch;
  while ((colonMatch = colon.exec(codeLine)) !== null) {
    const colonIndex = colonMatch.index;
    if (codeLine[colonIndex + 1] === "=") {
      continue;
    }

    const start = colonIndex + 1;
    const candidate = codeLine.slice(start).match(/^\s*\^?\s*([A-Za-z_]\w*)/);
    if (!candidate || NON_TYPE_AFTER_COLON.has(candidate[1].toLowerCase())) {
      continue;
    }

    const span = findTypeSpanEnd(codeLine, start);
    if (!isDeclarationColon(codeLine, colonIndex, span, context)) {
      continue;
    }
    capitalizeIdentifierCharacters(characters, codeLine, start, span.end);
  }

  const classParent = /\bclass\s*\(/gi;
  let classMatch;
  while ((classMatch = classParent.exec(codeLine)) !== null) {
    const start = classMatch.index + classMatch[0].length;
    const closingParenthesis = codeLine.indexOf(")", start);
    capitalizeIdentifierCharacters(
      characters,
      codeLine,
      start,
      closingParenthesis < 0 ? codeLine.length : closingParenthesis
    );
  }

  const typeOperator = /\b(?:as|is)\s+/gi;
  let operatorMatch;
  while ((operatorMatch = typeOperator.exec(codeLine)) !== null) {
    const start = operatorMatch.index + operatorMatch[0].length;
    const span = findTypeSpanEnd(codeLine, start);
    capitalizeIdentifierCharacters(characters, codeLine, start, span.end);
  }

  const compoundType = /\b(?:array(?:\s*\[[^\]]*\])?|class|file|set)\s+of\s+/gi;
  let compoundMatch;
  while ((compoundMatch = compoundType.exec(codeLine)) !== null) {
    const start = compoundMatch.index + compoundMatch[0].length;
    const span = findTypeSpanEnd(codeLine, start);
    capitalizeIdentifierCharacters(characters, codeLine, start, span.end);
  }

  for (const genericSpan of findGenericTypeSpans(codeLine)) {
    capitalizeIdentifierCharacters(
      characters,
      codeLine,
      genericSpan.start,
      genericSpan.end
    );
  }

  return characters.join("");
}

/**
 * Capitalizes declared type names and type references across Pascal source lines.
 * @param {string[]} lines Pascal source lines.
 * @returns {string[]} New lines with type identifiers capitalized.
 * @example
 * normalizeTypeNameCapitalization(["var", "  value: point;"]); // type becomes "Point"
 */
function normalizeTypeNameCapitalization(lines: string[]) {
  const codeLines = maskPascalLines(lines);
  const result = [...lines];
  const context: { section: string | undefined; typeBlockDepth: number } = { section: undefined, typeBlockDepth: 0 };

  for (let index = 0; index < codeLines.length; index += 1) {
    const codeLine = codeLines[index];
    const trimmedCode = codeLine.trim();
    const sectionMatch = trimmedCode.match(/^(type|const|var|threadvar|resourcestring|label)$/i);

    if (sectionMatch && context.typeBlockDepth === 0) {
      context.section = sectionMatch[1].toLowerCase();
    } else if (
      context.typeBlockDepth === 0 &&
      /^(?:begin|constructor|destructor|exports|finalization|function|implementation|initialization|operator|procedure|uses)\b/i.test(trimmedCode)
    ) {
      context.section = undefined;
    }

    result[index] = capitalizeTypeNamesOnLine(result[index], codeLine, context);

    const typeBlockMatch = codeLine.match(/=\s*(?:packed\s+)?(class|dispinterface|interface|object|record)\b/i);
    if (typeBlockMatch) {
      const afterKeyword = codeLine.slice((typeBlockMatch.index ?? 0) + typeBlockMatch[0].length);
      if (!/^\s*;/.test(afterKeyword)) {
        context.typeBlockDepth += 1;
      }
    }
    if (/^\s*end\s*;/i.test(codeLine) && context.typeBlockDepth > 0) {
      context.typeBlockDepth -= 1;
    }
  }

  return result;
}

/**
 * Capitalizes references to declared variables, including `Result` and `Self`.
 * @param {string[]} lines Pascal source lines.
 * @returns {string[]} New lines with recognized variable names capitalized.
 * @example
 * normalizeVariableNameCapitalization(["var", "  value: Integer;", "begin", "  value := 1;"]);
 * // Both occurrences of `value` become `Value`.
 */
function normalizeVariableNameCapitalization(lines: string[]) {
  const codeLines = maskPascalLines(lines);
  const declaredVariables = new Set<string>([PascalKeyword.Result, PascalKeyword.Self]);
  const addNames = (names: string) => {
    for (const name of names.split(",")) {
      const trimmedName = name.trim();
      if (trimmedName) {
        declaredVariables.add(trimmedName.toLowerCase());
      }
    }
  };

  for (const codeLine of codeLines) {
    const typedDeclaration = /(?:^|[;(])\s*(?:(?:const|constref|out|var)\s+)?([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:\s*\^?\s*([A-Za-z_]\w*)/gi;
    let declarationMatch;
    while ((declarationMatch = typedDeclaration.exec(codeLine)) !== null) {
      if (!NON_TYPE_AFTER_COLON.has(declarationMatch[2].toLowerCase())) {
        addNames(declarationMatch[1]);
      }
    }

    const inlineVariable = /\bvar\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?=:|:=)/gi;
    while ((declarationMatch = inlineVariable.exec(codeLine)) !== null) {
      addNames(declarationMatch[1]);
    }

    const exceptionVariable = /\bon\s+([A-Za-z_]\w*)\s*:/gi;
    while ((declarationMatch = exceptionVariable.exec(codeLine)) !== null) {
      addNames(declarationMatch[1]);
    }
  }

  return lines.map((line, lineIndex) => {
    const characters = [...line];
    const identifier = /\b[A-Za-z_]\w*\b/g;
    let match;
    while ((match = identifier.exec(codeLines[lineIndex])) !== null) {
      if (declaredVariables.has(match[0].toLowerCase())) {
        characters[match.index] = characters[match.index].toUpperCase();
      }
    }
    return characters.join("");
  });
}

/**
 * Removes unnecessary spaces around delimiters in recognized generic types.
 * @param {string[]} lines Pascal source lines.
 * @returns {string[]} New lines with generic type spacing normalized.
 * @example
 * normalizeGenericTypeSpacing(["TList < TPoint >"]); // ["TList<TPoint>"]
 */
function normalizeGenericTypeSpacing(lines: string[]) {
  const codeLines = maskPascalLines(lines);
  return lines.map((line, index) =>
    normalizeGenericTypeSpacingOnMaskedLine(line, codeLines[index])
  );
}

/**
 * Adds temporary comment markers to selected blank lines before Formatter.exe runs.
 * @param {string} text Source text to format.
 * @param {{lineNumber:number, marker:string}[]} protections Blank lines to preserve.
 * @returns {string} Text with markers on the selected blank lines.
 * @example
 * protectBlankLinesForFormatting("begin\n\nend.", [{ lineNumber: 1, marker: "CARET" }]);
 * // "begin\n{CARET}\nend."
 */
function protectBlankLinesForFormatting(text: string, protections: BlankLineProtection[]) {
  if (protections.length === 0) {
    return text;
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n|\r/);
  for (const protection of protections) {
    if (
      protection.lineNumber >= 0 &&
      protection.lineNumber < lines.length &&
      lines[protection.lineNumber].trim() === ""
    ) {
      lines[protection.lineNumber] = `${lines[protection.lineNumber]}{${protection.marker}}`;
    }
  }
  return lines.join(newline);
}

/**
 * Removes temporary blank-line markers and records their restored caret positions.
 * @param {string} text Formatter output containing any temporary markers.
 * @param {{marker:string, resolvedLineNumber?:number, resolvedCharacter?:number}[]} protections Marker records to restore.
 * @returns {string} Formatter output with protected lines returned to blank lines.
 * @example
 * const protections = [{ marker: "CARET" }];
 * restoreProtectedBlankLines("begin\n  {CARET}\nend.", protections); // "begin\n  \nend."
 * protections[0].resolvedCharacter; // 2
 */
function restoreProtectedBlankLines(text: string, protections: BlankLineProtection[]) {
  if (protections.length === 0) {
    return text;
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n|\r/);
  for (const protection of protections) {
    let markerLine = lines.findIndex((line) => line.includes(protection.marker));
    if (markerLine >= 0) {
      const indentation = lines[markerLine].match(/^\s*/)?.[0] || '';

      // Formatter.exe treats the temporary marker as a comment and may add its
      // normal declaration separator beside it. Keep the protected caret line,
      // but discard adjacent blank lines created around that marker.
      while (markerLine > 0 && lines[markerLine - 1].trim() === "") {
        lines.splice(markerLine - 1, 1);
        markerLine -= 1;
      }
      while (markerLine + 1 < lines.length && lines[markerLine + 1].trim() === "") {
        lines.splice(markerLine + 1, 1);
      }

      protection.resolvedLineNumber = markerLine;
      protection.resolvedCharacter = indentation.length;
      lines[markerLine] = indentation;
    }
  }
  return lines.join(newline);
}

/**
 * Checks whether a line is a complete inline `var` declaration ending in `;`.
 * @param {string} codeLine Source line to inspect.
 * @returns {boolean} True for a single-line inline variable declaration.
 * @example
 * isInlineVariableDeclaration("var Value := CreateValue;"); // true
 */
function isInlineVariableDeclaration(codeLine: string) {
  return /^\s*var\s+[A-Za-z_]\w*/i.test(codeLine) && /;\s*$/.test(codeLine);
}

/**
 * Finds the line ending a multiline inline `var` declaration.
 * @param {string[]} codeLines Comment- and string-masked source lines.
 * @param {number} declarationIndex Candidate line containing `var`.
 * @returns {number} Semicolon line index, or -1 if this is not a complete declaration.
 * @example
 * findInlineVariableDeclarationEnd(["var", "  Value := 1;", "begin"], 0); // 1
 */
function findInlineVariableDeclarationEnd(codeLines: string[], declarationIndex: number) {
  if (!/^\s*var\s+[A-Za-z_]\w*/i.test(codeLines[declarationIndex])) {
    return -1;
  }

  for (let index = declarationIndex; index < codeLines.length; index += 1) {
    if (codeLines[index].includes(";")) {
      return index;
    }
  }
  return -1;
}

/**
 * Aligns statements following a multiline inline-variable declaration to its indent.
 * @param {string[]} lines Pascal source lines.
 * @param {{includeBlankLineIndexes?:number[]}} [options] Blank lines eligible for alignment.
 * @returns {string[]} New lines with declaration continuations aligned.
 * @example
 * normalizeInlineVariableContinuations(["  var Value: Integer;", "      DoWork;", "end;"]);
 * // The `DoWork;` line is reduced to the declaration's two-space indent.
 */
function normalizeInlineVariableContinuations(lines: string[], options: { includeBlankLineIndexes?: Iterable<number> } = {}) {
  const codeLines = maskPascalLines(lines);
  const result = [...lines];
  const includeBlankLineIndexes = new Set(options.includeBlankLineIndexes ?? []);

  for (let declarationIndex = 0; declarationIndex < result.length - 1; declarationIndex += 1) {
    const declarationEnd = findInlineVariableDeclarationEnd(codeLines, declarationIndex);
    if (declarationEnd < 0) {
      continue;
    }

    const declarationIndent = result[declarationIndex].match(/^\s*/)?.[0] || '';
    for (let index = declarationEnd + 1; index < result.length; index += 1) {
      const isBlank = result[index].trim() === "";
      const isCommentOnly = !isBlank && codeLines[index].trim() === "";

      if (!isBlank || includeBlankLineIndexes.has(index)) {
        result[index] = `${declarationIndent}${result[index].trimStart()}`;
      }
      if (!isBlank && !isCommentOnly) {
        break;
      }
    }
    declarationIndex = declarationEnd;
  }

  return result;
}

/**
 * Joins a formatter-split `var` line back to its inline initializer declaration.
 * @param {string[]} lines Formatter output lines.
 * @returns {string[]} New lines with eligible `var` declarations joined.
 * @example
 * preserveInlineVariables(["var", "  Value := CreateValue;"]); // ["var Value := CreateValue;"]
 */
function preserveInlineVariables(lines: string[]) {
  const result = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)(var)\s*$/i);
    const declaration = lines[index + 1]?.trimStart() ?? "";

    if (match && /^[A-Za-z_]\w*(?:\s*:\s*.*?)?\s*:=/.test(declaration)) {
      result.push(`${match[1]}${match[2]} ${declaration}`);
      index += 1;
    } else {
      result.push(lines[index]);
    }
  }

  return result;
}

/**
 * Aligns wrapped parameters in routine declarations and calls.
 * @param {string[]} lines Pascal source lines.
 * @param {{alignBlankLineIndexes?:number[], indentSize?:number}} [options] Alignment options.
 * @returns {string[]} New lines with continuation parameters aligned.
 * @example
 * alignWrappedParameters(["procedure Run(A: Integer;", "B: Integer);"]);
 * // The second parameter is indented to the continuation column.
 */
function alignWrappedParameters(lines: string[], options: { alignBlankLineIndexes?: Iterable<number>; indentSize?: number } = {}) {
  const codeLines = maskPascalLines(lines);
  const result = [...lines];
  const alignBlankLineIndexes = new Set(options.alignBlankLineIndexes ?? []);
  const indentSize = isInteger(options.indentSize) ? options.indentSize : 2;
  let inParameterList = false;
  let parameterDepth = 0;
  let continuationColumn = indentSize;
  let previousParameterEnded = false;

  for (let lineIndex = 0; lineIndex < result.length; lineIndex += 1) {
    const codeLine = codeLines[lineIndex];
    let scanStart = 0;

    if (!inParameterList) {
      const declarationMatch = DECLARATION_PATTERN.exec(codeLine);
      if (!declarationMatch) {
        continue;
      }

      scanStart = codeLine.indexOf("(", (declarationMatch.index ?? 0) + declarationMatch[0].length);
      if (scanStart < 0) {
        continue;
      }

      inParameterList = true;
      parameterDepth = 0;
      continuationColumn = Math.max(0, codeLine.search(/\S/)) + indentSize;
      previousParameterEnded = false;
    } else {
      const trimmedCode = codeLine.trim();
      if (!trimmedCode) {
        if (
          alignBlankLineIndexes.has(lineIndex) &&
          previousParameterEnded
        ) {
          result[lineIndex] = " ".repeat(continuationColumn);
        }
        continue;
      }

      const firstCodeColumn = codeLine.search(/\S/);
      if (
        previousParameterEnded &&
        codeLine[firstCodeColumn] !== ")"
      ) {
        result[lineIndex] = `${" ".repeat(continuationColumn)}${result[lineIndex].trimStart()}`;
      } else if (
        previousParameterEnded &&
        codeLine[firstCodeColumn] === ")" &&
        alignBlankLineIndexes.has(lineIndex)
      ) {
        result[lineIndex] = `${" ".repeat(continuationColumn)}${result[lineIndex].trimStart()}`;
      }
    }

    let lastTopLevelCharacter;
    for (let characterIndex = scanStart; characterIndex < codeLine.length; characterIndex += 1) {
      const character = codeLine[characterIndex];
      if (character === "(") {
        parameterDepth += 1;
        continue;
      }
      if (character === ")") {
        parameterDepth -= 1;
        if (parameterDepth <= 0) {
          inParameterList = false;
          break;
        }
        continue;
      }
      if (parameterDepth === 1 && !/\s/.test(character)) {
        lastTopLevelCharacter = character;
      }
    }

    if (inParameterList) {
      previousParameterEnded = lastTopLevelCharacter === ";";
    }
  }

  return result;
}

/**
 * Aligns a blank continuation line or closing parenthesis after a wrapped argument.
 * @param {string[]} lines Pascal source lines.
 * @param {number} lineIndex Index of the blank line or closing-parenthesis line.
 * @param {number} [indentSize=2] Indentation added for declarations and calls.
 * @returns {string[]} New lines with the selected continuation line aligned.
 * @example
 * alignWrappedArgumentLine(["Call(Value,", ")"], 1); // ["Call(Value,", "  )"]
 */
function alignWrappedArgumentLine(lines: string[], lineIndex: number, indentSize = 2) {
  const targetText = lines[lineIndex] ?? "";
  const trimmedTarget = targetText.trimStart();
  if (
    lineIndex < 0 ||
    lineIndex >= lines.length ||
    (trimmedTarget !== "" && !trimmedTarget.startsWith(")"))
  ) {
    return [...lines];
  }

  const codeLines = maskPascalLines(lines);
  const frames: { lastTopLevelCharacter: string; openLine: number; baseIndent: number; continuationColumn?: number; isDeclaration: boolean }[] = [];

  for (let currentLine = 0; currentLine < lineIndex; currentLine += 1) {
    const codeLine = codeLines[currentLine];
    const firstCodeColumn = codeLine.search(/\S/);
    const activeFrame = frames.at(-1);
    if (
      activeFrame &&
      currentLine > activeFrame.openLine &&
      activeFrame.continuationColumn === undefined &&
      firstCodeColumn >= 0
    ) {
      activeFrame.continuationColumn = firstCodeColumn;
    }

    for (let column = 0; column < codeLine.length; column += 1) {
      const character = codeLine[column];
      if (character === "(") {
        const parentFrame = frames.at(-1);
        if (parentFrame) {
          parentFrame.lastTopLevelCharacter = character;
        }
        frames.push({
          openLine: currentLine,
          baseIndent: Math.max(0, firstCodeColumn),
          continuationColumn: undefined,
          isDeclaration: DECLARATION_PATTERN.test(codeLine.slice(0, column)),
          lastTopLevelCharacter: "("
        });
        continue;
      }
      if (character === ")") {
        if (frames.length > 0) {
          frames.pop();
        }
        const parentFrame = frames.at(-1);
        if (parentFrame) {
          parentFrame.lastTopLevelCharacter = character;
        }
        continue;
      }
      if (!/\s/.test(character) && frames.length > 0) {
        frames[frames.length - 1].lastTopLevelCharacter = character;
      }
    }
  }

  const frame = frames.at(-1);
  if (!frame || frame.lastTopLevelCharacter !== ",") {
    return [...lines];
  }

  const result = [...lines];
  const continuationColumn = frame.isDeclaration
    ? frame.baseIndent + indentSize
    : frame.continuationColumn ?? frame.baseIndent + indentSize;
  result[lineIndex] = `${" ".repeat(continuationColumn)}${trimmedTarget}`;
  return result;
}

/**
 * Runs the extension's capitalization, generic-spacing, and alignment passes.
 * @param {string} text Formatter output to postprocess.
 * @param {{preserveInlineVariables?:boolean, normalizeTypeNameCapitalization?:boolean, normalizeVariableNameCapitalization?:boolean, normalizeGenericTypeSpacing?:boolean, normalizeInlineVariableContinuations?:boolean, alignWrappedParameters?:boolean}} [options] Set a pass to `false` to disable it.
 * @returns {string} Postprocessed source with its original newline style.
 * @example
 * postprocessPascal("var\n  value: point;"); // "var\n  Value: Point;"
 */
function postprocessPascal(text: string, options: { preserveInlineVariables?: boolean; normalizeTypeNameCapitalization?: boolean; normalizeVariableNameCapitalization?: boolean; normalizeGenericTypeSpacing?: boolean; normalizeInlineVariableContinuations?: boolean; alignWrappedParameters?: boolean } = {}) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = text.split(/\r\n|\n|\r/);

  if (options.preserveInlineVariables !== false) {
    lines = preserveInlineVariables(lines);
  }
  if (options.normalizeTypeNameCapitalization !== false) {
    lines = normalizeTypeNameCapitalization(lines);
  }
  if (options.normalizeVariableNameCapitalization !== false) {
    lines = normalizeVariableNameCapitalization(lines);
  }
  if (options.normalizeGenericTypeSpacing !== false) {
    lines = normalizeGenericTypeSpacing(lines);
  }
  if (options.normalizeInlineVariableContinuations !== false) {
    lines = normalizeInlineVariableContinuations(lines);
  }
  if (options.alignWrappedParameters !== false) {
    lines = alignWrappedParameters(lines);
  }

  return lines.join(newline);
}

export {
  alignWrappedArgumentLine,
  alignWrappedParameters,
  isInlineVariableDeclaration,
  maskPascalLines,
  normalizeGenericTypeSpacing,
  normalizeInlineVariableContinuations,
  normalizeTypeNameCapitalization,
  normalizeVariableNameCapitalization,
  postprocessPascal,
  protectBlankLinesForFormatting,
  preserveInlineVariables,
  restoreProtectedBlankLines
};

