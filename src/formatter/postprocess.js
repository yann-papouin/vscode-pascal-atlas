const DECLARATION_PATTERN = /\b(?:procedure|function|constructor|destructor|operator)\b/i;
const {
  findGenericTypeSpans,
  normalizeGenericTypeSpacingOnMaskedLine
} = require("./generics");
const TYPE_SYNTAX_KEYWORDS = new Set([
  "array", "class", "const", "constref", "dispinterface", "file", "function",
  "interface", "object", "of", "out", "packed", "procedure", "record",
  "reference", "set", "specialize", "to", "type", "var"
]);
const TYPE_SPAN_TERMINATORS = new Set([
  "absolute", "abstract", "assembler", "cdecl", "default", "deprecated", "dispid",
  "do", "dynamic", "experimental", "external", "final", "forward", "implements",
  "index", "inline", "message", "name", "nodefault", "overload", "override",
  "platform", "read", "register", "reintroduce", "safecall", "sealed", "static",
  "stdcall", "stored", "unsafe", "varargs", "virtual", "write"
]);
const NON_TYPE_AFTER_COLON = new Set([
  "asm", "begin", "break", "case", "continue", "else", "end", "except", "exit",
  "finally", "for", "goto", "if", "inherited", "raise", "repeat", "try", "while",
  "with"
]);

function maskPascalLines(lines) {
  let state = "code";

  return lines.map((line) => {
    const characters = [...line];
    let index = 0;

    while (index < characters.length) {
      if (state === "braceComment") {
        const original = characters[index];
        characters[index] = " ";
        if (original === "}") {
          state = "code";
        }
        index += 1;
        continue;
      }

      if (state === "parenComment") {
        if (line.startsWith("*)", index)) {
          characters[index] = " ";
          characters[index + 1] = " ";
          index += 2;
          state = "code";
        } else {
          characters[index] = " ";
          index += 1;
        }
        continue;
      }

      if (state === "string") {
        characters[index] = " ";
        if (line[index] === "'") {
          if (line[index + 1] === "'") {
            characters[index + 1] = " ";
            index += 2;
          } else {
            index += 1;
            state = "code";
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
        state = "braceComment";
        index += 1;
        continue;
      }
      if (line.startsWith("(*", index)) {
        characters[index] = " ";
        characters[index + 1] = " ";
        state = "parenComment";
        index += 2;
        continue;
      }
      if (line[index] === "'") {
        characters[index] = " ";
        state = "string";
      }
      index += 1;
    }

    return characters.join("");
  });
}

function capitalizeIdentifierCharacters(characters, codeLine, start, end) {
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

function findTypeSpanEnd(codeLine, start) {
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

  return { end: codeLine.length, terminator: "end" };
}

function isDeclarationColon(codeLine, colonIndex, span, context) {
  const prefix = codeLine.slice(0, colonIndex);
  const segmentStart = Math.max(prefix.lastIndexOf(";"), prefix.lastIndexOf("("));
  const segment = prefix.slice(segmentStart + 1).trim();
  if (/^(?:[-+]?\d|[$%&][0-9A-Fa-f])/.test(segment)) {
    return false;
  }

  const declarationContext =
    context.section === "var" ||
    context.section === "const" ||
    context.typeBlockDepth > 0 ||
    /\b(?:const|constref|function|operator|out|procedure|property|var)\b/i.test(prefix);
  return span.terminator !== ":=" || declarationContext;
}

function capitalizeTypeNamesOnLine(line, codeLine, context) {
  const characters = [...line];
  const inlineTypeDeclaration = /^\s*type\b/i.test(codeLine);
  const declarationMatch = codeLine.match(/^\s*(?:type\s+)?([A-Za-z_]\w*)(?:\s*<[^>]*>)?\s*=\s*/i);
  const rightHandSide = declarationMatch
    ? codeLine.slice(declarationMatch.index + declarationMatch[0].length)
    : "";
  const clearlyTypeDeclaration = /^(?:packed\s+)?(?:array|class|dispinterface|file|interface|object|record|reference|set)\b|^\^/i
    .test(rightHandSide);

  if (
    declarationMatch &&
    (context.section === "type" || inlineTypeDeclaration || clearlyTypeDeclaration)
  ) {
    const nameStart = codeLine.indexOf(declarationMatch[1], declarationMatch.index);
    characters[nameStart] = characters[nameStart].toUpperCase();

    const simpleAliasMatch = rightHandSide.match(/^\s*\^?\s*([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*(?:\s*<[^;]+>)?)/);
    if (
      simpleAliasMatch &&
      !TYPE_SYNTAX_KEYWORDS.has(simpleAliasMatch[1].trim().toLowerCase())
    ) {
      const aliasStart = declarationMatch.index + declarationMatch[0].length + simpleAliasMatch.index;
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

function normalizeTypeNameCapitalization(lines) {
  const codeLines = maskPascalLines(lines);
  const result = [...lines];
  const context = { section: undefined, typeBlockDepth: 0 };

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
      const afterKeyword = codeLine.slice(typeBlockMatch.index + typeBlockMatch[0].length);
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

function normalizeVariableNameCapitalization(lines) {
  const codeLines = maskPascalLines(lines);
  const declaredVariables = new Set(["result", "self"]);
  const addNames = (names) => {
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

function normalizeGenericTypeSpacing(lines) {
  const codeLines = maskPascalLines(lines);
  return lines.map((line, index) =>
    normalizeGenericTypeSpacingOnMaskedLine(line, codeLines[index])
  );
}

function protectBlankLinesForFormatting(text, protections) {
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

function restoreProtectedBlankLines(text, protections) {
  if (protections.length === 0) {
    return text;
  }

  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r\n|\n|\r/);
  for (const protection of protections) {
    let markerLine = lines.findIndex((line) => line.includes(protection.marker));
    if (markerLine >= 0) {
      const indentation = lines[markerLine].match(/^\s*/)[0];

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

function isInlineVariableDeclaration(codeLine) {
  return /^\s*var\s+[A-Za-z_]\w*/i.test(codeLine) && /;\s*$/.test(codeLine);
}

function findInlineVariableDeclarationEnd(codeLines, declarationIndex) {
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

function normalizeInlineVariableContinuations(lines, options = {}) {
  const codeLines = maskPascalLines(lines);
  const result = [...lines];
  const includeBlankLineIndexes = new Set(options.includeBlankLineIndexes ?? []);

  for (let declarationIndex = 0; declarationIndex < result.length - 1; declarationIndex += 1) {
    const declarationEnd = findInlineVariableDeclarationEnd(codeLines, declarationIndex);
    if (declarationEnd < 0) {
      continue;
    }

    const declarationIndent = result[declarationIndex].match(/^\s*/)[0];
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

function preserveInlineVariables(lines) {
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

function alignWrappedParameters(lines, options = {}) {
  const codeLines = maskPascalLines(lines);
  const result = [...lines];
  const alignBlankLineIndexes = new Set(options.alignBlankLineIndexes ?? []);
  const indentSize = Number.isInteger(options.indentSize) ? options.indentSize : 2;
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

      scanStart = codeLine.indexOf("(", declarationMatch.index + declarationMatch[0].length);
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

function alignWrappedArgumentLine(lines, lineIndex, indentSize = 2) {
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
  const frames = [];

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
        frames.at(-1).lastTopLevelCharacter = character;
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

function postprocessPascal(text, options = {}) {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  let lines = text.split(/\r\n|\n|\r/);

  if (options.preserveInlineVariables !== false) {
    lines = preserveInlineVariables(lines);
  }
  lines = normalizeTypeNameCapitalization(lines);
  lines = normalizeVariableNameCapitalization(lines);
  lines = normalizeGenericTypeSpacing(lines);
  lines = normalizeInlineVariableContinuations(lines);
  if (options.alignWrappedParameters !== false) {
    lines = alignWrappedParameters(lines);
  }

  return lines.join(newline);
}

module.exports = {
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

