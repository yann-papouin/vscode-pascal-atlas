const CONTROL_WORDS = new Set(["case", "for", "if", "repeat", "while", "with"]);
const { normalizeGenericTypeSpacing } = require("./generics");

function formatCodeSegment(code, options = {}) {
  const formatted = code
    .replace(/\b([A-Za-z_]\w*)[ \t]+\(/g, (match, word) =>
      CONTROL_WORDS.has(word.toLowerCase()) ? match : `${word}(`
    )
    .replace(/\([ \t]+/g, "(")
    .replace(/[ \t]+\)/g, ")")
    .replace(/[ \t]*,[ \t]*/g, ", ")
    .replace(/[ \t]*(?::=|<=|>=|<>|=)[ \t]*/g, (operator) => ` ${operator.trim()} `)
    .replace(/[ \t]*:(?!=)[ \t]*/g, ": ")
    .replace(/[ \t]*;[ \t]*/g, "; ");
  return options.normalizeGenericTypeSpacing === false
    ? formatted
    : normalizeGenericTypeSpacing(formatted);
}

function scanPascalLine(line, initialState = "code", shouldFormat = false, options = {}) {
  let state = initialState;
  let result = "";
  let code = "";
  let index = 0;

  const flushCode = () => {
    result += shouldFormat ? formatCodeSegment(code, options) : code;
    code = "";
  };

  while (index < line.length) {
    if (state === "braceComment") {
      const end = line.indexOf("}", index);
      if (end === -1) {
        result += line.slice(index);
        index = line.length;
      } else {
        result += line.slice(index, end + 1);
        index = end + 1;
        state = "code";
      }
      continue;
    }

    if (state === "parenComment") {
      const end = line.indexOf("*)", index);
      if (end === -1) {
        result += line.slice(index);
        index = line.length;
      } else {
        result += line.slice(index, end + 2);
        index = end + 2;
        state = "code";
      }
      continue;
    }

    if (line.startsWith("//", index)) {
      flushCode();
      result += line.slice(index);
      index = line.length;
      continue;
    }

    if (line[index] === "{") {
      flushCode();
      result += "{";
      index += 1;
      state = "braceComment";
      continue;
    }

    if (line.startsWith("(*", index)) {
      flushCode();
      result += "(*";
      index += 2;
      state = "parenComment";
      continue;
    }

    if (line[index] === "'") {
      flushCode();
      const start = index;
      index += 1;
      while (index < line.length) {
        if (line[index] !== "'") {
          index += 1;
          continue;
        }
        if (line[index + 1] === "'") {
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      result += line.slice(start, index);
      continue;
    }

    code += line[index];
    index += 1;
  }

  if (state === "code") {
    flushCode();
  }

  return {
    text: shouldFormat ? result.trimEnd() : result,
    state
  };
}

function commentStateBeforeLine(lines, lineNumber) {
  let state = "code";
  for (let line = 0; line < lineNumber; line += 1) {
    state = scanPascalLine(lines[line], state).state;
  }
  return state;
}

function formatPascalLine(line, initialState = "code", options = {}) {
  return scanPascalLine(line, initialState, true, options).text;
}

function onTypeLineRequests(lineNumber, character, scope) {
  if (scope === "disabled") return [];
  const requests = [];
  if (scope === "previousLine" || scope === "currentAndPrevious") {
    requests.push({ lineNumber: lineNumber - 1, alignBlankContinuationLine: false });
  }
  if (scope === "currentLine" || scope === "currentAndPrevious") {
    requests.push({
      lineNumber,
      alignBlankContinuationLine: character === "\n"
    });
  }
  return requests;
}

module.exports = {
  commentStateBeforeLine,
  formatCodeSegment,
  formatPascalLine,
  onTypeLineRequests,
  scanPascalLine
};
