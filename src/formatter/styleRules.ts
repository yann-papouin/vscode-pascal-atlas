import { SettingValueType } from '../shared/identifiers';
import { isRecord } from '../shared/guards';
import { isInteger, errorMessage } from '../shared/guards';
import { PascalIntrinsic, PascalKeyword } from '../shared/pascal';
const SPACING_OPTIONS = ['BeforeAndAfter', 'BeforeOnly', 'AfterOnly', 'None'];
const SPACING_LABELS = ['Before and after', 'Before only', 'After only', 'No spaces'];
const LINE_BREAK_OPTIONS = ['Yes', 'No', 'AsIs'];
const LINE_BREAK_LABELS = ['Always break', 'Never break', 'Keep as is'];
const CAPITALIZATION_OPTIONS = ['lowercase', 'UPPERCASE', 'FirstUpper', 'AsIs'];
const CAPITALIZATION_LABELS = ['Lowercase', 'Uppercase', 'Capitalize', 'Keep as is'];
const STYLE_PROFILE_KIND = 'pascal-atlas-formatter-style';

export type StyleValue = string | number | boolean;
interface StyleRuleBase { group?: string; key: string; option: string; label: string; }
export type StyleRule = StyleRuleBase & ({ type: 'number'; min: number; max: number; step: number; defaultValue: number } | { type: 'boolean'; defaultValue: boolean } | { type: 'select'; options: readonly string[]; optionLabels: readonly string[]; defaultValue: string });
export type StyleValueGetter = (key: string, defaultValue: StyleValue) => StyleValue;
const STYLE_RULES: readonly StyleRule[] = Object.freeze([
  { group: 'Indentation', key: 'style.indentation.tabSize', option: 'DelphiFormatter.TabSize', label: 'Tab width', type: 'number', min: 1, max: 16, step: 1, defaultValue: 2 },
  { key: 'style.indentation.indentSize', option: 'DelphiFormatter.IndentSize', label: 'Indent width', type: 'number', min: 1, max: 16, step: 1, defaultValue: 2 },
  { key: 'style.indentation.useTabs', option: 'DelphiFormatter.UseTabs', label: 'Indent using tabs', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.indentation.continuationIndent', option: 'DelphiFormatter.ContinuationIndent', label: 'Continuation indent', type: 'number', min: 0, max: 16, step: 1, defaultValue: 2 },
  { key: 'style.indentation.compilerDirectives', option: 'DelphiFormatter.IndentCompilerDirectives', label: 'Indent compiler directives', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.indentation.blockContents', option: 'DelphiFormatter.IndentBlockContents', label: 'Indent block contents', type: SettingValueType.Boolean, defaultValue: true },
  { key: 'style.indentation.brackets', option: 'DelphiFormatter.IndentBrackets', label: 'Indent brackets', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.indentation.beginEnd', option: 'DelphiFormatter.IndentBeginAndEnd', label: 'Indent begin/end', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.indentation.methodBody', option: 'DelphiFormatter.IndentFunctionImplementationBody', label: 'Indent routine implementation bodies', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.indentation.nestedMethods', option: 'DelphiFormatter.IndentInnerFunctionImplementation', label: 'Indent nested routine implementations', type: SettingValueType.Boolean, defaultValue: true },
  { key: 'style.indentation.afterSections', option: 'DelphiFormatter.IndentAfterSections', label: 'Indent after interface/implementation', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.indentation.classBody', option: 'DelphiFormatter.IndentClassDefinitionBody', label: 'Indent class definitions', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.indentation.caseContents', option: 'DelphiFormatter.IndentCaseContents', label: 'Indent case contents', type: SettingValueType.Boolean, defaultValue: true },
  { key: 'style.indentation.caseLabels', option: 'DelphiFormatter.IndentCaseLabels', label: 'Indent case labels', type: SettingValueType.Boolean, defaultValue: true },

  { group: 'Spacing', key: 'style.spacing.assignment', option: 'DelphiFormatter.AssignSpaces', label: 'Assignment operator spacing', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'BeforeAndAfter' },
  { key: 'style.spacing.mathOperators', option: 'DelphiFormatter.MathOperatorSpaces', label: 'Math operator spacing', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'BeforeAndAfter' },
  { key: 'style.spacing.colon', option: 'DelphiFormatter.ColonSpaces', label: 'Colon spacing', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'AfterOnly' },
  { key: 'style.spacing.comma', option: 'DelphiFormatter.CommaSpaces', label: 'Comma spacing', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'AfterOnly' },
  { key: 'style.spacing.semicolon', option: 'DelphiFormatter.SemicolonSpaces', label: 'Semicolon spacing', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'AfterOnly' },
  { key: 'style.spacing.parentheses', option: 'DelphiFormatter.BracketSpaces', label: 'Spaces inside parentheses', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.spacing.squareBrackets', option: 'DelphiFormatter.SquareBracketSpaces', label: 'Spaces inside square brackets', type: SettingValueType.Boolean, defaultValue: false },

  { group: 'Line breaks', key: 'style.lineBreaks.varAndConstItems', option: 'DelphiFormatter.NewLineForEachVarAndConstElement', label: 'One var/const item per line', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'AsIs' },
  { key: 'style.lineBreaks.usesItems', option: 'DelphiFormatter.NewLineForEachUseElement', label: 'One uses item per line', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'AsIs' },
  { key: 'style.lineBreaks.beforeControlBegin', option: 'DelphiFormatter.NewLineBeforeBeginInControlBlock', label: 'Line break before control-block begin', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterMethodBegin', option: 'DelphiFormatter.NewLineAfterBeginInMethodDefinition', label: 'Line break after routine begin', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterControlBegin', option: 'DelphiFormatter.NewLineAfterBeginInControlBlock', label: 'Line break after control-block begin', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterOtherBegin', option: 'DelphiFormatter.NewLineAfterOtherBegin', label: 'Line break after other begin', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterSemicolon', option: 'DelphiFormatter.NewLineAfterSemicolon', label: 'Line break after semicolon', type: SettingValueType.Boolean, defaultValue: true },
  { key: 'style.lineBreaks.elseIfTogether', option: 'DelphiFormatter.NewLineBetweenElseAndIf', label: 'Put else and if on separate lines', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.lineBreaks.keepUserBreaks', option: 'DelphiFormatter.KeepUserLinebreaks', label: 'Keep user line breaks', type: SettingValueType.Boolean, defaultValue: true },
  { key: 'style.lineBreaks.maxEmptyLines', option: 'DelphiFormatter.MaxNumOfEmptyLines', label: 'Maximum consecutive blank lines', type: 'number', min: 0, max: 10, step: 1, defaultValue: 1 },
  { key: 'style.lineBreaks.rightMargin', option: 'DelphiFormatter.RightMargin', label: 'Right margin column', type: 'number', min: 40, max: 300, step: 1, defaultValue: 120 },

  { group: 'Capitalization', key: 'style.capitalization.keywords', option: 'DelphiFormatter.KeywordsCapitalization', label: 'Pascal keywords', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'lowercase' },
  { key: 'style.capitalization.compilerDirectives', option: 'DelphiFormatter.CompilerDirectivesCapitalization', label: 'Compiler directives', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'AsIs' },
  { key: 'style.capitalization.numbers', option: 'DelphiFormatter.NumbersCapitalization', label: 'Hexadecimal numbers', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'AsIs' },
  { key: 'style.capitalization.otherWords', option: 'DelphiFormatter.OtherWordsCapitalization', label: 'Other identifiers', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'AsIs' },

  { group: 'Vertical alignment', key: 'style.alignment.assignments', option: 'DelphiFormatter.AlignAssignments', label: 'Align assignments', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.alignment.typeNames', option: 'DelphiFormatter.AlignTypeNames', label: 'Align variable type names', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.alignment.constants', option: 'DelphiFormatter.AlignConst', label: 'Align constants', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.alignment.initializations', option: 'DelphiFormatter.AlignInitializations', label: 'Align initialization expressions', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.alignment.typeDefinitions', option: 'DelphiFormatter.AlignTypeDefs', label: 'Align type definitions', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.alignment.parameterTypes', option: 'DelphiFormatter.AlignParameterTypes', label: 'Align parameter types', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.alignment.endOfLineComments', option: 'DelphiFormatter.AlignEndOfLineComments', label: 'Align end-of-line comments', type: SettingValueType.Boolean, defaultValue: false },
  { key: 'style.alignment.properties', option: 'DelphiFormatter.AlignProperties', label: 'Align property declarations', type: SettingValueType.Boolean, defaultValue: false }
]);

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xmlValue(value: StyleValue) {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function applyStyleRules(xml: string, getValue: StyleValueGetter) {
  let result = xml;
  for (const rule of STYLE_RULES) {
    const value = getValue(rule.key, rule.defaultValue);
    const pattern = new RegExp(`(<Option\\s+Name="${escapeRegExp(rule.option)}"[^>]*\\sValue=")[^"]*(")`);
    if (!pattern.test(result)) {
      throw new Error(`Formatter configuration is missing rule ${rule.option}`);
    }
    result = result.replace(pattern, `$1${xmlValue(value)}$2`);
  }
  return result;
}

function resolveFormatterConfig(xml: string, useDefault: boolean, getValue: StyleValueGetter) {
  return useDefault ? xml : applyStyleRules(xml, getValue);
}

function validateStyleRuleValue(rule: StyleRule, value: unknown): value is StyleValue {
  if (rule.type === SettingValueType.Boolean) return typeof value === 'boolean';
  if (rule.type === 'number') {
    return isInteger(value) && value >= rule.min && value <= rule.max;
  }
  if (rule.type === 'select') return typeof value === 'string' && rule.options.includes(value);
  return false;
}

function createStyleProfile(getValue: StyleValueGetter, useDefault = false) {
  return {
    kind: STYLE_PROFILE_KIND,
    version: 1,
    rules: Object.fromEntries(STYLE_RULES.map(rule => [
      rule.key,
      useDefault ? rule.defaultValue : getValue(rule.key, rule.defaultValue)
    ]))
  };
}

function parseStyleProfile(text: string) {
  let profile: unknown;
  try {
    profile = JSON.parse(text);
  } catch (error) {
    throw new Error(`The custom profile is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(profile) || profile.kind !== STYLE_PROFILE_KIND || profile.version !== 1
    || !isRecord(profile.rules)) {
    throw new Error('This is not a Pascal Atlas formatting profile, or its version is unsupported.');
  }
  const result = new Map<string, StyleValue>();
  for (const rule of STYLE_RULES) {
    if (!Object.prototype.hasOwnProperty.call(profile.rules, rule.key)) {
      throw new Error(`The custom profile is missing ${rule.key}.`);
    }
    const value = profile.rules[rule.key];
    if (!validateStyleRuleValue(rule, value)) {
      throw new Error(`The value for ${rule.key} in the custom profile is invalid.`);
    }
    result.set(rule.key, value);
  }
  return result;
}

export {
  STYLE_RULES,
  applyStyleRules,
  createStyleProfile,
  parseStyleProfile,
  resolveFormatterConfig
};
