'use strict';

const SPACING_OPTIONS = ['BeforeAndAfter', 'BeforeOnly', 'AfterOnly', 'None'];
const SPACING_LABELS = ['前后留空格', '仅前面', '仅后面', '不留空格'];
const LINE_BREAK_OPTIONS = ['Yes', 'No', 'AsIs'];
const LINE_BREAK_LABELS = ['总是换行', '不换行', '保持原样'];
const CAPITALIZATION_OPTIONS = ['lowercase', 'UPPERCASE', 'FirstUpper', 'AsIs'];
const CAPITALIZATION_LABELS = ['小写', '大写', '首字母大写', '保持原样'];
const STYLE_PROFILE_KIND = 'pascal-union-formatter-style';

const STYLE_RULES = Object.freeze([
  { group: '缩进', key: 'style.indentation.tabSize', option: 'DelphiFormatter.TabSize', label: 'Tab 宽度', type: 'number', min: 1, max: 16, step: 1, defaultValue: 2 },
  { key: 'style.indentation.indentSize', option: 'DelphiFormatter.IndentSize', label: '每级缩进宽度', type: 'number', min: 1, max: 16, step: 1, defaultValue: 2 },
  { key: 'style.indentation.useTabs', option: 'DelphiFormatter.UseTabs', label: '使用 Tab 缩进', type: 'boolean', defaultValue: false },
  { key: 'style.indentation.continuationIndent', option: 'DelphiFormatter.ContinuationIndent', label: '续行额外缩进', type: 'number', min: 0, max: 16, step: 1, defaultValue: 2 },
  { key: 'style.indentation.compilerDirectives', option: 'DelphiFormatter.IndentCompilerDirectives', label: '缩进编译器指令', type: 'boolean', defaultValue: false },
  { key: 'style.indentation.blockContents', option: 'DelphiFormatter.IndentBlockContents', label: '缩进代码块内容', type: 'boolean', defaultValue: true },
  { key: 'style.indentation.brackets', option: 'DelphiFormatter.IndentBrackets', label: '缩进括号', type: 'boolean', defaultValue: false },
  { key: 'style.indentation.beginEnd', option: 'DelphiFormatter.IndentBeginAndEnd', label: '缩进 begin/end', type: 'boolean', defaultValue: false },
  { key: 'style.indentation.methodBody', option: 'DelphiFormatter.IndentFunctionImplementationBody', label: '缩进函数实现体', type: 'boolean', defaultValue: false },
  { key: 'style.indentation.nestedMethods', option: 'DelphiFormatter.IndentInnerFunctionImplementation', label: '缩进嵌套函数实现', type: 'boolean', defaultValue: true },
  { key: 'style.indentation.afterSections', option: 'DelphiFormatter.IndentAfterSections', label: '缩进 interface/implementation 后内容', type: 'boolean', defaultValue: false },
  { key: 'style.indentation.classBody', option: 'DelphiFormatter.IndentClassDefinitionBody', label: '缩进类定义内容', type: 'boolean', defaultValue: false },
  { key: 'style.indentation.caseContents', option: 'DelphiFormatter.IndentCaseContents', label: '缩进 case 内容', type: 'boolean', defaultValue: true },
  { key: 'style.indentation.caseLabels', option: 'DelphiFormatter.IndentCaseLabels', label: '缩进 case 标签', type: 'boolean', defaultValue: true },

  { group: '空格', key: 'style.spacing.assignment', option: 'DelphiFormatter.AssignSpaces', label: '赋值运算符空格', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'BeforeAndAfter' },
  { key: 'style.spacing.mathOperators', option: 'DelphiFormatter.MathOperatorSpaces', label: '数学运算符空格', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'BeforeAndAfter' },
  { key: 'style.spacing.colon', option: 'DelphiFormatter.ColonSpaces', label: '冒号空格', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'AfterOnly' },
  { key: 'style.spacing.comma', option: 'DelphiFormatter.CommaSpaces', label: '逗号空格', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'AfterOnly' },
  { key: 'style.spacing.semicolon', option: 'DelphiFormatter.SemicolonSpaces', label: '分号空格', type: 'select', options: SPACING_OPTIONS, optionLabels: SPACING_LABELS, defaultValue: 'AfterOnly' },
  { key: 'style.spacing.parentheses', option: 'DelphiFormatter.BracketSpaces', label: '圆括号内侧留空格', type: 'boolean', defaultValue: false },
  { key: 'style.spacing.squareBrackets', option: 'DelphiFormatter.SquareBracketSpaces', label: '方括号内侧留空格', type: 'boolean', defaultValue: false },

  { group: '换行', key: 'style.lineBreaks.varAndConstItems', option: 'DelphiFormatter.NewLineForEachVarAndConstElement', label: '每个 var/const 项单独一行', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'AsIs' },
  { key: 'style.lineBreaks.usesItems', option: 'DelphiFormatter.NewLineForEachUseElement', label: '每个 uses 项单独一行', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'AsIs' },
  { key: 'style.lineBreaks.beforeControlBegin', option: 'DelphiFormatter.NewLineBeforeBeginInControlBlock', label: '控制语句 begin 前换行', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterMethodBegin', option: 'DelphiFormatter.NewLineAfterBeginInMethodDefinition', label: '函数 begin 后换行', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterControlBegin', option: 'DelphiFormatter.NewLineAfterBeginInControlBlock', label: '控制块 begin 后换行', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterOtherBegin', option: 'DelphiFormatter.NewLineAfterOtherBegin', label: '其他 begin 后换行', type: 'select', options: LINE_BREAK_OPTIONS, optionLabels: LINE_BREAK_LABELS, defaultValue: 'Yes' },
  { key: 'style.lineBreaks.afterSemicolon', option: 'DelphiFormatter.NewLineAfterSemicolon', label: '分号后换行', type: 'boolean', defaultValue: true },
  { key: 'style.lineBreaks.elseIfTogether', option: 'DelphiFormatter.NewLineBetweenElseAndIf', label: 'else 与 if 分行', type: 'boolean', defaultValue: false },
  { key: 'style.lineBreaks.keepUserBreaks', option: 'DelphiFormatter.KeepUserLinebreaks', label: '保留用户换行', type: 'boolean', defaultValue: true },
  { key: 'style.lineBreaks.maxEmptyLines', option: 'DelphiFormatter.MaxNumOfEmptyLines', label: '最多连续空行数', type: 'number', min: 0, max: 10, step: 1, defaultValue: 1 },
  { key: 'style.lineBreaks.rightMargin', option: 'DelphiFormatter.RightMargin', label: '右边界列数', type: 'number', min: 40, max: 300, step: 1, defaultValue: 120 },

  { group: '大小写', key: 'style.capitalization.keywords', option: 'DelphiFormatter.KeywordsCapitalization', label: 'Pascal 关键字', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'lowercase' },
  { key: 'style.capitalization.compilerDirectives', option: 'DelphiFormatter.CompilerDirectivesCapitalization', label: '编译器指令', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'AsIs' },
  { key: 'style.capitalization.numbers', option: 'DelphiFormatter.NumbersCapitalization', label: '十六进制数字', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'AsIs' },
  { key: 'style.capitalization.otherWords', option: 'DelphiFormatter.OtherWordsCapitalization', label: '其他标识符', type: 'select', options: CAPITALIZATION_OPTIONS, optionLabels: CAPITALIZATION_LABELS, defaultValue: 'AsIs' },

  { group: '纵向对齐', key: 'style.alignment.assignments', option: 'DelphiFormatter.AlignAssignments', label: '对齐赋值', type: 'boolean', defaultValue: false },
  { key: 'style.alignment.typeNames', option: 'DelphiFormatter.AlignTypeNames', label: '对齐变量类型名', type: 'boolean', defaultValue: false },
  { key: 'style.alignment.constants', option: 'DelphiFormatter.AlignConst', label: '对齐常量', type: 'boolean', defaultValue: false },
  { key: 'style.alignment.initializations', option: 'DelphiFormatter.AlignInitializations', label: '对齐初始化表达式', type: 'boolean', defaultValue: false },
  { key: 'style.alignment.typeDefinitions', option: 'DelphiFormatter.AlignTypeDefs', label: '对齐类型定义', type: 'boolean', defaultValue: false },
  { key: 'style.alignment.parameterTypes', option: 'DelphiFormatter.AlignParameterTypes', label: '对齐参数类型', type: 'boolean', defaultValue: false },
  { key: 'style.alignment.endOfLineComments', option: 'DelphiFormatter.AlignEndOfLineComments', label: '对齐行尾注释', type: 'boolean', defaultValue: false },
  { key: 'style.alignment.properties', option: 'DelphiFormatter.AlignProperties', label: '对齐属性声明', type: 'boolean', defaultValue: false }
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function xmlValue(value) {
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}

function applyStyleRules(xml, getValue) {
  let result = xml;
  for (const rule of STYLE_RULES) {
    const value = getValue(rule.key, rule.defaultValue);
    const pattern = new RegExp(`(<Option\\s+Name="${escapeRegExp(rule.option)}"[^>]*\\sValue=")[^"]*(")`);
    if (!pattern.test(result)) {
      throw new Error(`Formatter 配置缺少规则 ${rule.option}`);
    }
    result = result.replace(pattern, `$1${xmlValue(value)}$2`);
  }
  return result;
}

function validateStyleRuleValue(rule, value) {
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'number') {
    return Number.isInteger(value) && value >= rule.min && value <= rule.max;
  }
  if (rule.type === 'select') return rule.options.includes(value);
  return false;
}

function createStyleProfile(getValue, useDefault = false) {
  return {
    kind: STYLE_PROFILE_KIND,
    version: 1,
    rules: Object.fromEntries(STYLE_RULES.map(rule => [
      rule.key,
      useDefault ? rule.defaultValue : getValue(rule.key, rule.defaultValue)
    ]))
  };
}

function parseStyleProfile(text) {
  let profile;
  try {
    profile = JSON.parse(text);
  } catch (error) {
    throw new Error(`自定义规范不是有效的 JSON：${error.message}`);
  }
  if (!profile || profile.kind !== STYLE_PROFILE_KIND || profile.version !== 1
    || !profile.rules || typeof profile.rules !== 'object' || Array.isArray(profile.rules)) {
    throw new Error('这不是 Pascal Union 格式化规范文件，或文件版本不受支持。');
  }
  const result = new Map();
  for (const rule of STYLE_RULES) {
    if (!Object.prototype.hasOwnProperty.call(profile.rules, rule.key)) {
      throw new Error(`自定义规范缺少 ${rule.key}。`);
    }
    const value = profile.rules[rule.key];
    if (!validateStyleRuleValue(rule, value)) {
      throw new Error(`自定义规范中的 ${rule.key} 值无效。`);
    }
    result.set(rule.key, value);
  }
  return result;
}

module.exports = { STYLE_RULES, applyStyleRules, createStyleProfile, parseStyleProfile };
