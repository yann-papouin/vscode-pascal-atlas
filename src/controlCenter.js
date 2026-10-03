'use strict';

const vscode = require('vscode');
const { randomBytes } = require('node:crypto');
const { discoverLoadedProjects } = require('./projectDiscovery');
const { STYLE_RULES } = require('./formatter/styleRules');
const { DEFAULT_BLOCK_LEVEL_COLORS } = require('./formatter/highlighting');
const { resetSymbolColors } = require('./defaultSettings');
const { languageCode, localizedPages, sectionsWithPages } = require('./controlCenterI18n');

const SECTIONS = [
  {
    title: '界面与语言',
    description: '控制 Pascal Union 设置页面使用的界面语言。',
    settings: [
      {
        key: 'ui.language', label: '配置语言', type: 'select', target: 'global', defaultValue: 'zh-CN',
        options: ['zh-CN', 'en'], optionLabels: ['简体中文（默认）', '英文']
      }
    ]
  },
  {
    title: '总开关',
    description: '统一控制辅助扩展；关闭后保留 Vallenta 自身能力。',
    settings: [
      { key: 'enabled', label: '启用 Pascal Union', type: 'boolean' }
    ]
  },
  {
    title: '依赖与兼容',
    description: '确保 Vallenta Studio 与调试基础依赖齐全；旧 Formatter 和重复 Pascal 提供器不属于必要依赖。',
    settings: [
      { key: 'dependencies.autoInstall', label: '自动安装缺失的必要扩展', type: 'boolean' }
    ],
    actions: [
      { command: 'pascalUnion.dependencies.check', label: '立即检查扩展环境', icon: '✓' }
    ]
  },
  {
    title: '文件编码',
    description: '新建 Delphi 文件默认 GB2312，其他文件默认 UTF-8；.pas 无法明确识别为 UTF-8/GB2312 时回退 GB2312。',
    settings: [
      { key: 'encoding.enabled', label: '启用文件编码策略', type: 'boolean' },
      {
        key: 'encoding.delphiDefault', label: 'Delphi 新文件与识别失败时', type: 'select', target: 'global',
        options: ['gb2312', 'gbk', 'utf8', 'utf8bom'],
        optionLabels: ['GB2312（默认）', 'GBK', 'UTF-8', 'UTF-8 with BOM']
      },
      {
        key: 'encoding.otherDefault', label: '其他新文件与识别失败时', type: 'select', target: 'global',
        options: ['utf8', 'utf8bom', 'gb2312', 'gbk'],
        optionLabels: ['UTF-8（默认）', 'UTF-8 with BOM', 'GB2312', 'GBK']
      },
      { key: 'encoding.detectExisting', label: '读取时自动识别并保留原编码', type: 'boolean' },
      { key: 'encoding.respectDprojDeclaration', label: '优先采用 DPROJ 的 XML 编码声明', type: 'boolean' }
    ]
  },
  {
    title: '符号着色',
    description: '优先分析当前文件，并合并所有已加载工程、源码和包符号。',
    settings: [
      { key: 'coloring.enabled', label: 'Pascal Union 符号着色', type: 'boolean' },
      { key: 'coloring.typingDelayMs', label: '当前文件输入延迟', type: 'number', unit: 'ms', min: 0, max: 3000, step: 10 },
      { key: 'coloring.inactiveEditorDelayMs', label: '非活动编辑器延迟', type: 'number', unit: 'ms', min: 0, max: 5000, step: 50 },
      { key: 'coloring.persistedCache.enabled', label: '跨窗口保留最近文件着色', type: 'boolean' },
      { key: 'coloring.colors.useDefault', label: '使用主题默认语义颜色', type: 'boolean', group: '颜色方案' },
      { key: 'coloring.colors.unit', label: 'Unit 名称', type: 'color', colorRule: true, defaultValue: '#4EC9B0' },
      { key: 'coloring.colors.type', label: '类型与接口', type: 'color', colorRule: true, defaultValue: '#4EC9B0' },
      { key: 'coloring.colors.variable', label: '变量与字段', type: 'color', colorRule: true, defaultValue: '#9CDCFE' },
      { key: 'coloring.colors.constant', label: '常量', type: 'color', colorRule: true, defaultValue: '#4FC1FF' },
      { key: 'coloring.colors.enumMember', label: '枚举成员', type: 'color', colorRule: true, defaultValue: '#4FC1FF' },
      { key: 'coloring.colors.property', label: '属性', type: 'color', colorRule: true, defaultValue: '#9CDCFE' },
      { key: 'coloring.colors.method', label: '函数与过程', type: 'color', colorRule: true, defaultValue: '#DCDCAA' }
    ],
    actions: [
      { command: 'pascalUnion.coloring.colors.reset', label: '一键恢复默认颜色', icon: '↺' }
    ]
  },
  {
    title: '跳转与接口',
    description: '源码函数优先实现；无源码符号可打开从 BPL 恢复的注释式接口。',
    settings: [
      { key: 'navigation.enabled', label: 'Pascal Union 增强跳转', type: 'boolean' },
      { key: 'navigation.preferImplementation', label: '函数优先跳到实现', type: 'boolean' },
      { key: 'navigation.singleTargetByDefault', label: '普通跳转只取最佳目标', type: 'boolean' },
      { key: 'navigation.selectTargetOnJump', label: '跳转后选中目标标识符（可能短暂反色）', type: 'boolean' },
      {
        key: 'navigation.candidatePickerShortcut', label: '全部候选快捷键', type: 'select',
        options: ['altF12', 'ctrlAltF12', 'none'],
        optionLabels: ['Alt+F12', 'Ctrl+Alt+F12', '不绑定']
      },
      { key: 'navigation.virtualInterfaces', label: '无源码时打开虚拟接口', type: 'boolean' },
      { key: 'navigation.isolatePlatformSources', label: '隔离大型 RTL/VCL 源码，避免阻塞 Vallenta', type: 'boolean' },
      { key: 'navigation.prewarmCurrentFile', label: '预解析当前文件及 uses', type: 'boolean' },
      { key: 'navigation.interactiveWaitMs', label: 'Ctrl 跳转最长等待', type: 'number', unit: 'ms', min: 0, max: 1000, step: 10 },
      { key: 'hover.enabled', label: '包符号悬停信息', type: 'boolean' }
    ]
  },
  {
    title: '类与函数导航',
    description: '在 Explorer 内组织 Pascal 类型和函数；DPK/DPROJ 额外提供 Package Includes、File Includes 一级定位入口。',
    settings: [
      { key: 'classNavigator.enabled', label: '在 Explorer 显示 Delphi 类导航', type: 'boolean' },
      { key: 'classNavigator.showUses', label: '显示 uses 节点（不罗列引用包）', type: 'boolean' },
      { key: 'classNavigator.showGlobalRoutines', label: '显示全局函数与过程', type: 'boolean' },
      { key: 'classNavigator.showInterfaces', label: '显示接口', type: 'boolean' },
      { key: 'classNavigator.showRecordsAndObjects', label: '显示 record 与 object', type: 'boolean' },
      { key: 'classNavigator.showProperties', label: '在类型首行显示 properties 分组', type: 'boolean' },
      { key: 'classNavigator.showProjectPackageEntry', label: 'DPK/DPROJ 显示 Package Includes', type: 'boolean' },
      { key: 'classNavigator.showProjectFileEntry', label: 'DPK/DPROJ 显示 File Includes', type: 'boolean' },
      { key: 'classNavigator.showUnitInitialization', label: 'Unit 底部显示 initialization', type: 'boolean' },
      { key: 'classNavigator.showUnitFinalization', label: 'Unit 底部显示 finalization', type: 'boolean' },
      {
        key: 'classNavigator.memberOrder', label: '成员排列方式', type: 'select',
        options: ['visibility', 'declaration', 'implementation'],
        optionLabels: ['按分组排序（默认）', '全部按声明顺序', '按实现顺序']
      },
      {
        key: 'classNavigator.typeOrder', label: '顶层类型排列方式', type: 'select',
        options: ['declaration', 'alphabetical'],
        optionLabels: ['按声明顺序（默认）', '按字母顺序']
      },
      { key: 'classNavigator.followCursor', label: '点击与滚动时跟随选中', type: 'boolean' },
      { key: 'classNavigator.highlightRange.enabled', label: '导航真实条目时在行号旁标记源码块', type: 'boolean' },
      { key: 'classNavigator.pauseWhenCollapsed', label: '导航收起时暂停监控且不自动展开', type: 'boolean' },
      { key: 'classNavigator.scrollFollowDelayMs', label: '滚动跟随延迟', type: 'number', unit: 'ms', min: 0, max: 500, step: 5 },
      { key: 'classNavigator.scrollFollowOffsetLines', label: '滚动跟随定位点向下偏移', type: 'number', unit: '行', min: -20, max: 20, step: 1 },
      { key: 'classNavigator.navigationClickHoldMs', label: '导航点击防闪烁时间', type: 'number', unit: 'ms', min: 0, max: 2000, step: 50 },
      {
        key: 'classNavigator.navigationReveal.mode', label: '导航跳转后的源码显示方式', type: 'select',
        options: ['smart', 'center', 'top', 'default'],
        optionLabels: ['智能：完整居中，大块按比例定位（默认）', '始终居中', '起点置顶', 'VS Code 默认定位']
      },
      { key: 'classNavigator.navigationReveal.largeBlockStartPercent', label: '大块源码起点距窗口顶部', type: 'number', unit: '%', min: 0, max: 50, step: 5 },
      { key: 'classNavigator.keepFocusOnNavigationClick', label: '导航点击后保持蓝色树选中与焦点', type: 'boolean' },
      { key: 'classNavigator.defaultOpenBelowExplorer', label: '首次默认展开并放在文件树下方', type: 'boolean' },
      { key: 'classNavigator.backgroundParsing.enabled', label: '大文件类导航使用后台线程', type: 'boolean' },
      { key: 'classNavigator.backgroundParsing.thresholdKb', label: '后台解析文件阈值', type: 'number', unit: 'KB', min: 64, max: 4096, step: 64 }
    ],
    actions: [
      { command: 'pascalUnion.navigator.showClasses', label: '切换到类导航', icon: '◈' },
      { command: 'pascalUnion.classNavigator.refresh', label: '刷新当前文件导航', icon: '↻' }
    ]
  },
  {
    title: 'AI 函数步骤',
    description: '通过当前 OAI Compatible Copilot 模型，为光标所在或树中选中的函数生成可点击的中文步骤。',
    settings: [
      { key: 'classNavigator.aiSteps.enabled', label: '启用 AI 函数步骤', type: 'boolean' },
      {
        key: 'classNavigator.aiSteps.provider', label: '模型提供器', type: 'select',
        options: ['oaicopilot'],
        optionLabels: ['OAI Compatible Copilot']
      },
      {
        key: 'classNavigator.aiSteps.modelId', label: 'AI 模型', type: 'model',
        placeholder: '选择已配置模型，或输入自定义模型 ID'
      },
      {
        key: 'classNavigator.aiSteps.reasoningEffort', label: 'AI 推理强度', type: 'select',
        options: ['auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
        optionLabels: ['提供器默认', '最少（最快，部分网关不兼容）', '低（默认；GLM-5.2 映射为高）', '中等', '高', '更高', '最大（最慢）']
      },
      {
        key: 'classNavigator.aiSteps.granularity', label: '功能块粒度', type: 'select',
        options: ['coarse', 'balanced'],
        optionLabels: ['粗粒度：顶层功能阶段（默认）', '均衡：保留更多实现阶段']
      },
      { key: 'classNavigator.aiSteps.maxSteps', label: '最大功能块数', type: 'number', min: 1, max: 12, step: 1 },
      { key: 'classNavigator.aiSteps.normalTargetLines', label: '普通生成最细粒度', type: 'number', unit: '行', min: 8, max: 50, step: 1 },
      { key: 'classNavigator.aiSteps.detailedTargetLines', label: '详细生成最细粒度', type: 'number', unit: '行', min: 6, max: 30, step: 1 },
      { key: 'classNavigator.aiSteps.substeps.enabled', label: '复杂功能块生成子步骤', type: 'boolean' },
      { key: 'classNavigator.aiSteps.substeps.maxPerStep', label: '每个功能块最多子步骤', type: 'number', min: 2, max: 8, step: 1 },
      { key: 'classNavigator.aiSteps.substeps.minParentLines', label: '允许细分的最小功能块行数', type: 'number', min: 6, max: 100, step: 1 },
      { key: 'classNavigator.aiSteps.substeps.maxDepth', label: '递归步骤最大层数', type: 'number', min: 2, max: 5, step: 1 },
      {
        key: 'classNavigator.aiSteps.maxSourceCharacters', label: '函数源码字符上限',
        type: 'number', min: 2000, max: 100000, step: 1000
      },
      {
        key: 'classNavigator.aiSteps.requestTimeoutSeconds', label: '单次请求超时',
        type: 'number', unit: '秒', min: 15, max: 600, step: 15
      },
      { key: 'classNavigator.aiSteps.cacheEnabled', label: '缓存未修改函数的步骤', type: 'boolean' },
      { key: 'classNavigator.aiSteps.highlightRange', label: '点击步骤时在行号旁标记功能块', type: 'boolean' },
    ],
    actions: [
      { command: 'pascalUnion.classNavigator.stopAiGeneration', label: '停止 AI 步骤生成', icon: '■' }
    ]
  },
  {
    title: '补全与包符号',
    description: '恢复 AppSys、Environment、SO() 返回对象等编译包成员。',
    settings: [
      { key: 'completion.enabled', label: '点号成员补全', type: 'boolean' },
      { key: 'completion.unqualified.enabled', label: '输入前缀补全全局符号', type: 'boolean' },
      { key: 'completion.interactiveWaitMs', label: '全局补全最长等待', type: 'number', unit: 'ms', min: 0, max: 500, step: 10 },
      { key: 'signatureHelp.enabled', label: '函数参数签名提示', type: 'boolean' },
      { key: 'signatureHelp.triggerOnComma', label: '输入逗号时切换参数提示', type: 'boolean' },
      { key: 'symbols.compiled.enabled', label: 'BPL/DCP 符号恢复', type: 'boolean' },
      { key: 'symbols.compiled.parsedCache.enabled', label: '缓存解析后的 BPL/DCP 索引', type: 'boolean' },
      { key: 'symbols.sourceCache.enabled', label: '缓存工作区与 RAD/VCL 源码索引', type: 'boolean' },
      { key: 'symbols.compiled.initialPackageLimit', label: '首次检查包数量', type: 'number', min: 1, max: 32, step: 1 }
    ]
  },
  {
    title: '代码格式化',
    description: '内置原 Delphi Personal Formatter：整篇、保存时、输入时格式化及 Delphi 结构着色。',
    settings: [
      { key: 'formatter.enabled', label: '启用 Pascal Union Formatter', type: 'boolean' },
      { key: 'formatter.executablePath', label: 'Formatter.exe 路径', type: 'text', target: 'global', placeholder: '留空时自动检测 RAD Studio' },
      { key: 'formatter.preserveInlineVariables', label: '保留内联变量声明', type: 'boolean' },
      { key: 'formatter.alignWrappedParameters', label: '对齐换行参数', type: 'boolean' },
      {
        key: 'formatter.shortcut', label: '整篇格式化快捷键', type: 'select',
        options: ['shiftAltF', 'ctrlAltF', 'ctrlKCtrlF', 'none'],
        optionLabels: ['Shift+Alt+F', 'Ctrl+Alt+F', 'Ctrl+K Ctrl+F', '不绑定']
      },
      { key: 'formatter.onType.enabled', label: '输入时自动格式化', type: 'boolean' },
      {
        key: 'formatter.onType.semicolon.scope', label: '输入分号时格式化', type: 'select',
        options: ['currentLine', 'previousLine', 'currentAndPrevious', 'disabled'],
        optionLabels: ['本行', '上一行', '本行和上一行', '关闭']
      },
      {
        key: 'formatter.onType.closingParenthesis.scope', label: '输入右括号时格式化', type: 'select',
        options: ['currentLine', 'previousLine', 'currentAndPrevious', 'disabled'],
        optionLabels: ['本行', '上一行', '本行和上一行', '关闭']
      },
      {
        key: 'formatter.onType.enter.scope', label: '按回车时格式化', type: 'select',
        options: ['currentLine', 'previousLine', 'currentAndPrevious', 'disabled'],
        optionLabels: ['本行', '上一行', '本行和上一行', '关闭']
      },
      { key: 'formatter.onType.logging', label: '记录输入格式化日志', type: 'boolean' },
      { key: 'formatter.highlighting.enabled', label: 'Delphi 结构辅助着色', type: 'boolean' },
      {
        key: 'formatter.highlighting.blockLevelColors',
        label: '结构层级循环色板',
        type: 'colorPalette',
        defaultValue: [...DEFAULT_BLOCK_LEVEL_COLORS],
        placeholder: '#E06C75, #D19A66, #C586C0'
      }
    ],
    actions: [
      { command: 'pascalUnion.formatter.formatDocument', label: '格式化当前文件', icon: '⌁' }
    ]
  },
  {
    title: 'Explorer 隐藏规则',
    description: '分别控制 Delphi 表单、编译产物、工程元数据和构建目录是否出现在 Explorer。',
    settings: [
      { key: 'explorer.hideFormFiles', label: '隐藏 DFM/FMX 表单文件', type: 'boolean', target: 'global' },
      { key: 'explorer.hideSkinConfigFiles', label: '隐藏 SKINCFG 皮肤配置文件', type: 'boolean', target: 'global' },
      { key: 'explorer.hideBuildArtifacts', label: '隐藏 DCU/BPL/DCP/EXE 等产物', type: 'boolean', target: 'global' },
      { key: 'explorer.hideProjectMetadata', label: '隐藏工程缓存和元数据', type: 'boolean', target: 'global' },
      { key: 'explorer.hideBuildDirectories', label: '隐藏 Win32/Win64/bin/lib 等目录', type: 'boolean', target: 'global' }
    ]
  },
  {
    title: '格式化语法规范',
    description: '默认规范与当前使用风格一致；关闭默认规范后可编辑、保存和加载自定义规范。',
    settings: [
      { key: 'formatter.style.useDefault', label: '应用默认语法规范', type: 'boolean' },
      ...STYLE_RULES.map(rule => ({
        ...rule,
        key: `formatter.${rule.key}`,
        styleRule: true
      }))
    ],
    actions: [
      { command: 'pascalUnion.formatter.style.save', label: '保存自定义规范', icon: '⇩' },
      { command: 'pascalUnion.formatter.style.load', label: '加载自定义规范', icon: '⇧' }
    ]
  },
  {
    title: '编译与运行',
    description: '在 VS Code 中直接调用 Delphi MSBuild/DCC；不会启动 RAD Studio 或 bds.exe。',
    settings: [
      { key: 'build.enabled', label: '启用无界面正式编译', type: 'boolean' },
      {
        key: 'build.configuration', label: '默认 Config', type: 'select',
        options: ['auto', 'Debug', 'Release'], optionLabels: ['工程默认', 'Debug', 'Release']
      },
      {
        key: 'build.platform', label: '默认 Platform', type: 'select',
        options: ['auto', 'Win32', 'Win64'], optionLabels: ['工程默认', 'Win32', 'Win64']
      },
      { key: 'build.saveBeforeBuild', label: '编译前保存目标工程文件', type: 'boolean' },
      { key: 'build.showStatusBar', label: '在状态栏显示 Build All、Run、Debug、平台和构建模式', type: 'boolean' },
      {
        key: 'run.buildBeforeRun', label: 'Run 前构建', type: 'select',
        options: ['always', 'ifOutdated', 'never'], optionLabels: ['始终构建', '仅缺失或过期时', '从不构建']
      },
      { key: 'build.stopGroupOnFailure', label: '工程组失败后停止', type: 'boolean' },
      { key: 'build.terminalSummary', label: '在终端显示明确的构建结果', type: 'boolean' },
      { key: 'build.output.showErrors', label: '构建输出：错误', type: 'boolean' },
      { key: 'build.output.showWarnings', label: '构建输出：警告', type: 'boolean' },
      { key: 'build.output.showOther', label: '构建输出：其他', type: 'boolean' },
      { key: 'build.completionNotification', label: '构建结束后显示通知', type: 'boolean' },
      { key: 'build.timeoutSeconds', label: '正式编译超时', type: 'number', unit: 's', min: 30, max: 7200, step: 30 },
      { key: 'build.msbuildPath', label: 'MSBuild.exe 路径（留空自动检测）', type: 'text', target: 'global' }
    ]
  },
  {
    title: 'Delphi 调试器',
    description: '使用独立 MIT Delphi DAP 调试器，支持启动工程以及工程组内已加载的 BPL/DLL。',
    settings: [
      { key: 'debugger.enabled', label: '启用 Delphi 调试集成', type: 'boolean' },
      { key: 'debugger.autoInstall', label: '自动安装 Delphi Debugger', type: 'boolean' },
      {
        key: 'debugger.buildBeforeDebug', label: '调试前构建', type: 'select',
        options: ['always', 'ifOutdated', 'never'], optionLabels: ['始终构建', '仅缺失或过期时', '从不构建']
      },
      {
        key: 'debugger.shortcutMode', label: '调试与运行快捷键模式', type: 'select',
        options: ['visualStudio', 'radStudio'], optionLabels: ['Visual Studio / VS Code', 'RAD Studio']
      },
      { key: 'debugger.loadGroupModules', label: '加载工程组全部包符号', type: 'boolean' },
      { key: 'debugger.validateSymbols', label: '调试前检查符号文件', type: 'boolean' },
      { key: 'debugger.generateDetailedMap', label: '调试构建生成详细 MAP（推荐）', type: 'boolean' },
      { key: 'debugger.stopAtEntry', label: '在程序入口暂停', type: 'boolean' },
      {
        key: 'debugger.programConsole', label: 'Debug 程序输出位置', type: 'select',
        options: ['external', 'debugConsole'], optionLabels: ['独立 Windows 控制台', 'VS Code Debug Console']
      },
      { key: 'debugger.revealOutputOnStart', label: '调试开始时打开 Debug Console', type: 'boolean' },
      {
        key: 'debugger.stepIsolation', label: '单步线程隔离', type: 'select',
        options: ['auto', 'none'], optionLabels: ['自动隔离', 'RAD Studio 风格']
      },
      { key: 'debugger.stepIsolationReleaseMs', label: '线程等待释放延迟', type: 'number', unit: 'ms', min: -1, max: 60000, step: 100 }
    ],
    actions: [
      { command: 'pascalUnion.dependencies.check', label: '检查并安装调试器', icon: '✓' },
      { command: 'pascalUnion.debug.selectStartupProject', label: '选择工程组启动工程', icon: '▶' }
    ]
  },
  {
    title: 'Delphi 导航 · 工程模式',
    description: '类导航与 Project/Package 工程树共用 Explorer 中的 Delphi 导航窗口，并通过右上角按钮切换。',
    settings: [
      { key: 'projectNavigator.enabled', label: '允许切换到 Delphi 工程模式', type: 'boolean' },
      {
        key: 'projectNavigator.defaultExpansion', label: '工程树默认展开层级', type: 'select',
        options: ['firstLevel', 'all'], optionLabels: ['只展开 Project，显示全部 Package', '展开 Project 和 Package']
      },
      { key: 'projectNavigator.showGroupproj', label: 'Project 下显示 GROUPPROJ', type: 'boolean' },
      { key: 'projectNavigator.showDpr', label: 'Project 下显示 DPR', type: 'boolean' },
      { key: 'projectNavigator.showDpk', label: 'Package 下显示 DPK', type: 'boolean' },
      { key: 'projectNavigator.showDproj', label: 'Package 下显示 DPROJ', type: 'boolean' },
      { key: 'projectNavigator.contextMenus.enabled', label: '显示 Project/Package 右键构建与调试菜单', type: 'boolean' }
    ],
    actions: [
      { command: 'pascalUnion.navigator.toggleMode', label: '切换类导航 / 工程', icon: '⇄' },
      { command: 'pascalUnion.projectNavigator.refresh', label: '刷新 Delphi 工程树', icon: '↻' }
    ]
  },
  {
    title: '工程与搜索路径',
    description: '打开新工作区时识别 groupproj、加载 Vallenta 工程组，并合并全部工程的源码路径。',
    settings: [
      { key: 'projectGroups.autoDetect', label: '自动识别并加载 groupproj', type: 'boolean' },
      { key: 'projectGroups.activateFirstProject', label: '活动工程失效时自动修复并选择', type: 'boolean' },
      { key: 'paths.enabled', label: '自动同步全部工程', type: 'boolean' },
      { key: 'includeNestedSourceDirectories', label: '包含嵌套源码目录', type: 'boolean' },
      { key: 'restartActiveLsp', label: '路径改变后重启 Vallenta LSP', type: 'boolean' }
    ],
    actions: [
      { command: 'pascalUnion.projects.detect', label: '立即识别 Project Group', icon: '⌕' },
      { command: 'pascalUnion.sync', label: '立即同步', icon: '↻' },
      { command: 'pascalUnion.showPaths', label: '查看路径', icon: '≡' }
    ]
  },
  {
    title: '缺失 uses',
    description: '发现未引入声明 Unit 的符号，并提供 Add Unit 修复。',
    settings: [
      { key: 'missingUnits.enabled', label: '编译器诊断的 Add Unit 修复', type: 'boolean' },
      { key: 'missingUnits.debounceMs', label: 'Unit 索引刷新延迟', type: 'number', unit: 'ms', min: 50, max: 5000, step: 50 },
      { key: 'missingUnits.compiledFallback', label: '必要时搜索全部编译包', type: 'boolean' }
    ]
  },
  {
    title: '后台诊断',
    description: '独立语法检查与隔离的 Delphi 编译器检查。',
    settings: [
      { key: 'diagnostics.enabled', label: '后台诊断总开关', type: 'boolean' },
      { key: 'diagnostics.syntax.enabled', label: '即时语法检查', type: 'boolean' },
      { key: 'diagnostics.syntax.debounceMs', label: '语法检查延迟', type: 'number', unit: 'ms', min: 50, max: 5000, step: 50 },
      { key: 'diagnostics.compiler.enabled', label: 'Delphi 编译检查', type: 'boolean' },
      { key: 'diagnostics.compiler.idleDelayMs', label: '编译空闲延迟', type: 'number', unit: 'ms', min: 250, max: 60000, step: 250 },
      { key: 'diagnostics.compiler.startupDelayMs', label: '启动后首次编译延迟', type: 'number', unit: 'ms', min: 0, max: 120000, step: 1000 },
      { key: 'diagnostics.compiler.maxParallelProjects', label: '并行工程数', type: 'number', min: 1, max: 4, step: 1 },
      { key: 'diagnostics.compiler.timeoutSeconds', label: '单次超时', type: 'number', unit: 's', min: 10, max: 1800, step: 10 },
      { key: 'diagnostics.compiler.includeWarnings', label: '显示编译器警告', type: 'boolean' },
      { key: 'diagnostics.ignoreUtf8ConversionWarning', label: '忽略“建议转换为 UTF-8”警告', type: 'boolean' },
      { key: 'diagnostics.compiler.configuration', label: '构建配置', type: 'select', options: ['auto', 'Debug', 'Release'] },
      { key: 'diagnostics.compiler.platform', label: '目标平台', type: 'select', options: ['auto', 'Win32', 'Win64'] }
    ],
    actions: [
      { command: 'pascalUnion.diagnostics.runNow', label: '立即检查', icon: '▶' },
      { command: 'pascalUnion.diagnostics.showStatus', label: '查看状态', icon: 'ⓘ' },
      { command: 'pascalUnion.diagnostics.clearCache', label: '清理缓存', icon: '⌫' }
    ]
  }
];

const COMMANDS = new Set(SECTIONS.flatMap(section => section.actions || []).map(action => action.command));

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

class PascalUnionControlCenterProvider {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.view = undefined;
  }

  register() {
    this.context.subscriptions.push(
      vscode.window.registerWebviewViewProvider('pascalUnion.controlCenter', this, {
        webviewOptions: { retainContextWhenHidden: true }
      }),
      vscode.commands.registerCommand('pascalUnion.openSettings', () => this.openMainSettings()),
      vscode.commands.registerCommand('pascalUnion.openNativeSettings', () => {
        return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:BoringLi.pascal-union');
      }),
      vscode.commands.registerCommand('pascalUnion.controlCenter.refresh', () => this.refresh()),
      vscode.commands.registerCommand('pascalUnion.coloring.colors.reset', async () => {
        await resetSymbolColors(this.output);
        this.postState();
      }),
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('pascalUnion.ui.language')) this.refresh();
        else if (event.affectsConfiguration('pascalUnion')) this.postState();
      })
    );
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html(view.webview, false);
    view.webview.onDidReceiveMessage(message => this.receive(message), undefined, this.context.subscriptions);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  configuration() {
    return vscode.workspace.getConfiguration('pascalUnion');
  }

  language() {
    return languageCode(this.configuration().get('ui.language', 'zh-CN'));
  }

  values() {
    const configuration = this.configuration();
    const values = Object.fromEntries(SECTIONS.flatMap(section => section.settings).map(setting => [
      setting.key,
      configuration.get(setting.key, setting.defaultValue)
    ]));
    if (values['formatter.style.useDefault']) {
      for (const rule of STYLE_RULES) {
        values[`formatter.${rule.key}`] = rule.defaultValue;
      }
    }
    return values;
  }

  status() {
    const folders = vscode.workspace.workspaceFolders || [];
    const projects = folders.flatMap(folder => discoverLoadedProjects(folder.uri.fsPath));
    const managedPaths = folders.flatMap(folder => this.context.workspaceState.get(
      `pascalUnion.managedPaths:${folder.uri.fsPath}`,
      []
    ));
    return {
      workspaces: folders.length,
      projects: new Set(projects.map(item => item.toLowerCase())).size,
      paths: new Set(managedPaths.map(item => String(item).toLowerCase())).size
    };
  }

  async receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'update') {
      const setting = SECTIONS.flatMap(section => section.settings)
        .find(item => item.key === message.key);
      if (!setting) return;
      let value = message.value;
      if (setting.type === 'number') {
        value = Math.max(setting.min, Math.min(setting.max, Number(value)));
        if (!Number.isFinite(value)) return;
      } else if (setting.type === 'boolean') {
        value = Boolean(value);
      } else if (setting.type === 'text' || setting.type === 'model') {
        value = String(value || '').trim();
      } else if (setting.type === 'color') {
        value = String(value || '');
        if (!/^#[0-9a-f]{6}$/i.test(value)) return;
      } else if (setting.type === 'colorPalette') {
        value = String(value || '').split(/[\s,;]+/).filter(Boolean);
        if (value.length < 1 || value.length > 12
          || value.some(color => !/^#[0-9a-f]{6}$/i.test(color))) return;
      } else if (setting.type === 'select' && !setting.options.includes(value)) {
        return;
      }
      const target = setting.target === 'global'
        ? vscode.ConfigurationTarget.Global
        : vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await this.configuration().update(setting.key, value, target);
      this.output.appendLine(`Control Center updated pascalUnion.${setting.key} = ${JSON.stringify(value)}.`);
      // Language changes rebuild the complete localized webview through the
      // configuration listener. Avoid a second render/flicker here.
      if (setting.key !== 'ui.language') this.postState();
      return;
    }
    if (message.type === 'command' && COMMANDS.has(message.command)) {
      await vscode.commands.executeCommand(message.command);
      this.postState();
      return;
    }
    if (message.type === 'openSettings') {
      await vscode.commands.executeCommand('pascalUnion.openSettings');
    }
    if (message.type === 'openNativeSettings') {
      await vscode.commands.executeCommand('pascalUnion.openNativeSettings');
    }
  }

  openMainSettings() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'pascalUnion.settings',
      this.language() === 'en' ? 'Pascal Union Settings' : 'Pascal Union 设置',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview, true);
    panel.webview.onDidReceiveMessage(message => this.receive(message), undefined, this.context.subscriptions);
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = undefined; });
  }

  refresh() {
    if (this.view) this.view.webview.html = this.html(this.view.webview, false);
    if (this.panel) {
      this.panel.title = this.language() === 'en' ? 'Pascal Union Settings' : 'Pascal Union 设置';
      this.panel.webview.html = this.html(this.panel.webview, true);
    }
  }

  postState() {
    void this.view?.webview.postMessage({ type: 'state', values: this.values(), status: this.status() });
    void this.panel?.webview.postMessage({ type: 'state', values: this.values(), status: this.status() });
  }

  html(webview, fullPage) {
    const nonce = randomBytes(16).toString('base64');
    const initial = JSON.stringify({ values: this.values(), status: this.status() }).replace(/</g, '\\u003c');
    const language = this.language();
    const english = language === 'en';
    const sections = sectionsWithPages(SECTIONS, language);
    const pages = localizedPages(language);
    const cards = pages.map((page, index) => `
      <div class="page${index === 0 ? ' active' : ''}" data-page="${index}">
        ${sections.filter(section => section.pageId === page.id).map(section => `
          <section class="card">
            <h2>${escapeHtml(section.title)}</h2>
            <p class="description">${escapeHtml(section.description)}</p>
            ${section.settings.map(setting => this.settingHtml(setting)).join('')}
            ${(section.actions || []).length ? `<div class="actions">${section.actions.map(action => `
              <button type="button" data-command="${escapeHtml(action.command)}"><span>${escapeHtml(action.icon)}</span>${escapeHtml(action.label)}</button>
            `).join('')}</div>` : ''}
          </section>
        `).join('')}
      </div>
    `).join('');
    const tabs = pages.map((page, index) => `
      <button type="button" class="tab${index === 0 ? ' active' : ''}" data-tab="${index}">${escapeHtml(page.title)}</button>
    `).join('');
    return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    * { box-sizing: border-box; }
    body { padding: ${fullPage ? '18px 24px' : '10px'}; max-width: ${fullPage ? '1100px' : 'none'}; margin: ${fullPage ? '0 auto' : '0'}; color: var(--vscode-foreground); background: ${fullPage ? 'var(--vscode-editor-background)' : 'var(--vscode-sideBar-background)'}; font: var(--vscode-font-weight) var(--vscode-font-size)/1.45 var(--vscode-font-family); }
    .hero { padding: 4px 2px 12px; }
    h1 { margin: 0 0 4px; font-size: 17px; }
    .subtitle, .description { color: var(--vscode-descriptionForeground); }
    .summary { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; margin: 10px 0 2px; }
    .metric { padding: 7px 4px; text-align: center; border: 1px solid var(--vscode-widget-border); border-radius: 5px; background: var(--vscode-editor-background); }
    .metric strong { display: block; font-size: 16px; color: var(--vscode-textLink-foreground); }
    .metric span { font-size: 10px; color: var(--vscode-descriptionForeground); }
    .tabs { display: flex; gap: 3px; overflow-x: auto; margin: 0 0 9px; padding-bottom: 5px; }
    .tab { flex: 0 0 auto; color: var(--vscode-foreground); background: transparent; border-bottom: 2px solid transparent; }
    .tab.active { color: var(--vscode-textLink-foreground); border-bottom-color: var(--vscode-focusBorder); }
    .page { display: none; }
    .page.active { display: block; }
    .card { display: block; margin: 0 0 9px; padding: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-sideBar-background); }
    h2 { margin: 0; font-size: 13px; }
    .setting-group { position: sticky; top: 0; z-index: 1; margin: 12px 0 0; padding: 7px 0 4px; color: var(--vscode-textLink-foreground); background: var(--vscode-sideBar-background); font-size: 12px; }
    .description { margin: 3px 0 8px; font-size: 11px; }
    .setting { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 28px; border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border) 55%, transparent); }
    .setting.disabled { opacity: .48; }
    .setting label { overflow-wrap: anywhere; }
    input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--vscode-focusBorder); }
    input[type=number], input[type=text], select { width: 120px; padding: 3px 5px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
    input.palette-input { width: min(260px, 48vw); }
    input[type=color] { width: 46px; height: 24px; padding: 1px 2px; border: 1px solid var(--vscode-input-border, var(--vscode-widget-border)); border-radius: 3px; background: var(--vscode-input-background); }
    .color-control { display: flex; align-items: center; gap: 7px; }
    .color-control code { min-width: 62px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .number { display: flex; align-items: center; gap: 4px; }
    .unit { min-width: 18px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
    button { padding: 4px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; border-radius: 2px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button span { margin-right: 4px; }
    .footer { width: 100%; margin: 2px 0 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  </style>
</head>
<body>
  <header class="hero">
    <h1>Pascal Union</h1>
    <div class="subtitle">${english ? 'Delphi workspace development control center' : 'Delphi 全工程开发控制中心'}</div>
    <div class="summary">
      <div class="metric"><strong id="projectCount">0</strong><span>${english ? 'Projects' : '加载工程'}</span></div>
      <div class="metric"><strong id="pathCount">0</strong><span>${english ? 'Managed paths' : '托管路径'}</span></div>
      <div class="metric"><strong id="workspaceCount">0</strong><span>${english ? 'Workspaces' : '工作区'}</span></div>
    </div>
  </header>
  <nav class="tabs">${tabs}</nav>
  ${cards}
  ${fullPage ? '' : `
  <button type="button" class="footer" id="openSettings">${english ? 'Open full settings in the editor' : '在编辑器主窗口打开分页设置'}</button>
  <button type="button" class="footer" id="openNativeSettings">${english ? 'Open in VS Code Settings' : '在 VS Code 设置中打开配置'}</button>`}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const initial = ${initial};
    function apply(state) {
      for (const [key, value] of Object.entries(state.values || {})) {
        const input = document.querySelector('[data-key="' + CSS.escape(key) + '"]');
        if (!input) continue;
        if (input.type === 'checkbox') input.checked = Boolean(value);
        else input.value = Array.isArray(value) ? value.join(', ') : value ?? '';
        if (input.type === 'color') input.parentElement.querySelector('[data-color-value]').textContent = input.value.toUpperCase();
      }
      const useDefaultStyle = Boolean(state.values?.['formatter.style.useDefault']);
      document.querySelectorAll('[data-style-rule]').forEach(input => {
        input.disabled = useDefaultStyle;
        input.closest('.setting')?.classList.toggle('disabled', useDefaultStyle);
      });
      const useDefaultColors = Boolean(state.values?.['coloring.colors.useDefault']);
      document.querySelectorAll('[data-color-rule]').forEach(input => {
        input.disabled = useDefaultColors;
        input.closest('.setting')?.classList.toggle('disabled', useDefaultColors);
      });
      document.getElementById('projectCount').textContent = state.status?.projects ?? 0;
      document.getElementById('pathCount').textContent = state.status?.paths ?? 0;
      document.getElementById('workspaceCount').textContent = state.status?.workspaces ?? 0;
    }
    document.querySelectorAll('[data-key]').forEach(input => input.addEventListener('change', () => {
      const value = input.type === 'checkbox' ? input.checked
        : input.type === 'number' ? Number(input.value) : input.value;
      if (input.type === 'color') input.parentElement.querySelector('[data-color-value]').textContent = input.value.toUpperCase();
      vscode.postMessage({ type: 'update', key: input.dataset.key, value });
    }));
    document.querySelectorAll('[data-command]').forEach(button => button.addEventListener('click', () => {
      vscode.postMessage({ type: 'command', command: button.dataset.command });
    }));
    document.querySelectorAll('[data-tab]').forEach(tab => tab.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach(item => item.classList.toggle('active', item === tab));
      document.querySelectorAll('[data-page]').forEach(page => page.classList.toggle('active', page.dataset.page === tab.dataset.tab));
    }));
    document.getElementById('openSettings')?.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    document.getElementById('openNativeSettings')?.addEventListener('click', () => vscode.postMessage({ type: 'openNativeSettings' }));
    window.addEventListener('message', event => { if (event.data?.type === 'state') apply(event.data); });
    apply(initial);
  </script>
</body>
</html>`;
  }

  settingHtml(setting) {
    const ruleAttributes = `${setting.styleRule ? ' data-style-rule="true"' : ''}`
      + `${setting.colorRule ? ' data-color-rule="true"' : ''}`;
    let input;
    if (setting.type === 'boolean') {
      input = `<input type="checkbox" data-key="${escapeHtml(setting.key)}"${ruleAttributes} aria-label="${escapeHtml(setting.label)}">`;
    } else if (setting.type === 'select') {
      input = `<select data-key="${escapeHtml(setting.key)}"${ruleAttributes}>${setting.options.map((option, index) => `
        <option value="${escapeHtml(option)}">${escapeHtml(setting.optionLabels?.[index] || option)}</option>`).join('')}</select>`;
    } else if (setting.type === 'number') {
      input = `<span class="number"><input type="number" data-key="${escapeHtml(setting.key)}"${ruleAttributes} min="${setting.min}" max="${setting.max}" step="${setting.step}"><span class="unit">${escapeHtml(setting.unit || '')}</span></span>`;
    } else if (setting.type === 'color') {
      const defaultColor = escapeHtml(setting.defaultValue || '#000000');
      input = `<span class="color-control"><input type="color" value="${defaultColor}" data-key="${escapeHtml(setting.key)}"${ruleAttributes} aria-label="${escapeHtml(setting.label)}"><code data-color-value>${defaultColor}</code></span>`;
    } else if (setting.type === 'model') {
      const models = vscode.workspace.getConfiguration('oaicopilot').get('models', []) || [];
      const currentModelId = String(this.configuration().get(setting.key, '') || '').trim();
      const discoveredModelIds = models
        .map(model => String(model?.id || '').trim())
        .filter(id => id && !id.startsWith('__provider__'));
      // Keep useful choices available if OAI Compatible Copilot has not
      // activated yet or its configuration cannot be read in this window.
      const modelIds = [...new Set([
        ...discoveredModelIds,
        ...['deepseek-v4-pro', 'glm-5.2', currentModelId].filter(Boolean)
      ])]
        .sort((left, right) => left.localeCompare(right));
      input = `<select data-key="${escapeHtml(setting.key)}"${ruleAttributes}>
        <option value="">${this.language() === 'en' ? 'Automatic (first available model)' : '自动（第一个可用模型）'}</option>
        ${modelIds.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('')}
      </select>`;
    } else {
      const inputClass = setting.type === 'colorPalette' ? ' class="palette-input"' : '';
      input = `<input type="text"${inputClass} data-key="${escapeHtml(setting.key)}"${ruleAttributes} placeholder="${escapeHtml(setting.placeholder || '')}">`;
    }
    const group = setting.group
      ? `<h3 class="setting-group">${escapeHtml(setting.group)}</h3>`
      : '';
    return `${group}<div class="setting"><label>${escapeHtml(setting.label)}</label>${input}</div>`;
  }
}

module.exports = { SECTIONS, PascalUnionControlCenterProvider };
