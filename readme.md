# Pascal Union

[English](#english) | [简体中文](#简体中文)

## English

A VS Code workspace suite for **Delphi / Object Pascal** that brings cross-project symbols, structural navigation, project-group management, build/run, native debugging, formatting, and diagnostics into one consistent experience.

Pascal Union is designed for real Delphi workspaces made up of `.groupproj`, `.dproj`, `.dpk`, `.dpr`, and large collections of `.pas` files. It works alongside Vallenta Studio and fills important gaps around cross-package symbols, compiled-package interfaces, project navigation, and command-line build/debug workflows.

### Key features

#### Workspace-wide symbols and fast navigation

- Automatically discovers `.groupproj` files and loads every referenced Project and Package instead of limiting analysis to Vallenta's currently selected project.
- Merges project directories, Unit Search Paths, and source roots so types, variables, properties, and routines can be highlighted, completed, and navigated across packages.
- Prioritizes the active document and uses persistent caches and background workers for indexing, source analysis, and compiled-symbol recovery.
- Ctrl+Click and `F12` choose one best destination: routines prefer their implementation, while types and variables go to their declaration.
- `Alt+F12` explicitly opens the full definition/implementation candidate list.
- Adds fallback support for `Self.Member`, multi-level member chains, generics, interfaces, records, class routines, and local scopes.
- Provides member completion after `.` and signature help while entering routine arguments.

#### Compiled Package interface recovery

When a dependency provides only DCP/BPL artifacts and no Pascal source, Pascal Union can use tools from the local RAD Studio installation to recover public symbols and provide:

- semantic highlighting for types and members;
- Go to Definition, hover details, and member completion;
- generated read-only, comment-style Unit, interface, and class declarations;
- fallback recovery from BPL exports and DCP Unit/type aliases.

Real `.pas` declarations always take precedence over generated interfaces.

#### Delphi class navigator and project view

The **Delphi 导航** view in Explorer switches between two modes:

- **Class navigation** organizes the active file by `uses`, `global`, classes, interfaces, records, and objects.
- **Project view** presents `.groupproj/.dpr` and `.dpk/.dproj` as a Project → Package tree.

The class navigator focuses on structure rather than ordinary fields and local variables:

- Properties, constructors/destructors, Initialize/Finalize, class routines, static routines, and regular methods have distinct grouping and icons.
- Nested routines appear recursively under their owning routine instead of being misclassified as global.
- Members can be grouped by visibility or shown in original source order.
- Types and properties navigate to declarations; routines prefer implementations.
- Editor clicks and scrolling follow the active item and mark its source range in the line-number gutter.
- Multiple `uses` blocks plus Unit `initialization` and `finalization` sections are independently navigable.

Project and Package nodes use distinct icons. Package nodes offer Build, Compile, Clean, Debug, and Attach actions; Project nodes offer Build All, Compile All, Clean All, Run, and Debug. Group actions are also available from the view title's `...` menu, while file nodes open directly in the editor.

#### AI routine steps

The navigator can call an installed OAI Compatible Copilot through the VS Code Language Model API to create concise Chinese functional steps for a routine:

- Steps describe meaningful implementation phases instead of mechanically splitting every few lines.
- Complex phases may be refined into one level of substeps.
- Clicking a step marks its range in the gutter without covering source text.
- All routines in the active file can be generated in one request, which can be stopped at any time.
- Results are cached by routine content and reused until the source changes.

AI analysis runs only when explicitly requested and can be disabled completely.

#### Project-group build, run, and native debugging

Pascal Union uses the installed Delphi command-line toolchain directly. It does not start RAD Studio or run `bds.exe`.

- Package commands: Build, Compile, Clean, Debug, and Attach to Package Host.
- Project Group commands: Build All, Compile All, Clean All, Run, and Debug.
- Selectable startup project, Debug/Release configuration, and Win32/Win64 platform.
- Optional status-bar actions for Build All, Run, Debug, platform, and configuration.
- Concise build summaries with aligned `[ERROR]` / `[WARN]` diagnostics, also published to Problems.
- Run does not attach a debugger and redirects standard output, standard error, and the exit result to the VS Code Debug Console.
- Visual Studio and RAD Studio debug keybinding layouts are both supported.

Native debugging is provided by the MIT-licensed `mca-software.delphi-debugger`. Pascal Union builds a dynamic configuration from `.dproj/.groupproj`, collects EXE/BPL/DLL and MAP/RSM/DCP artifacts, and supplies source search paths. No handwritten `launch.json` or DDK is required.

Breakpoints in BPL/DLL modules that have not loaded yet remain unverified and can activate after the module enters the process and its symbols become available.

#### Integrated Delphi Formatter

The former **Delphi Personal Formatter** is now built into Pascal Union:

- Acts as the default formatter for Pascal and Object Pascal.
- Uses RAD Studio's `Formatter.exe`; the separate Pascal Formatter extension is not required.
- Preserves inline variables and aligns wrapped parameters and arguments.
- Can format the current or previous line when typing `;`, `)`, or Enter.
- Exposes detailed indentation, spacing, line-break, capitalization, and alignment rules.
- Includes a built-in default style and can save or load custom JSON profiles.

When the default syntax standard is enabled, its detailed options reflect the bundled profile and become read-only. Disable it to customize every rule.

#### Diagnostics, encoding, and editing support

- Worker-based syntax diagnostics cover strings, comments, delimiters, generics, and structural `begin/end` errors.
- Background Delphi compilation uses isolated shadow files and never overwrites project sources or normal output directories.
- Missing-Unit diagnostics offer an **Add Unit to uses** quick fix.
- New `.pas/.dpr/.dpk/.dproj` files default to GB2312; existing files retain a reliably detected original encoding, while other documents default to UTF-8.
- Optional Explorer exclusions cover Delphi forms, `.skincfg`, generated output, and metadata.
- Built-in Object Pascal snippets include `begin/end`, conditions, loops, exceptions, Case, Procedure, and Function templates.
- RAD/VCL source opens in an isolated language mode so inspecting System/Winapi code does not stall the original project's navigation.

### Quick start

1. Install Pascal Union and accept installation of the required companion extensions.
2. Open a Delphi workspace containing a `.groupproj`, `.dproj`, or `.dpk`.
3. Pascal Union discovers the project group, synchronizes search paths, and analyzes the active Pascal file first.
4. Use **Delphi 导航** in Explorer for class navigation or switch it to Project view.
5. Ctrl+Click to navigate, or right-click a Project/Package node to build, run, or debug.
6. Open **Pascal Union → 能力与设置** from the Activity Bar to configure each feature page.

### Settings

Pascal Union provides a visual settings center and registers the same options in VS Code's main Settings editor. To keep navigation compact, related options are consolidated into seven top-level pages: General, Editing, Navigation & Symbols, Formatting, Projects & Files, Build & Debug, and Diagnostics. The General page can switch the settings center between Simplified Chinese (default) and English immediately.

Every major capability has an independent switch. The symbol palette can be reset to the bundled defaults without changing unrelated coloring behavior.

### Requirements

- Windows;
- Visual Studio Code 1.85 or newer;
- Vallenta Studio, installed separately from the Marketplace;
- `ms-vscode.cpptools`, currently retained as a Vallenta/LSP companion;
- a licensed local RAD Studio/Delphi toolchain for formatting, compiling, debugging, or compiled-package recovery.

When dependency auto-installation is enabled, Pascal Union checks Vallenta Studio, C/C++, and Delphi Debugger. The separate **Pascal Formatter** and **Pascal** extensions are not required; enabling multiple Pascal language extensions may register duplicate completion or navigation providers.

### Privacy and independence

Pascal Union contains no telemetry and does not upload source code to a service operated by BORING. Project analysis, formatting, compilation, and symbol recovery run locally. Only the explicitly invoked AI routine-steps feature sends the selected routine to the language-model provider chosen by the user in VS Code.

Pascal Union is independently developed by **BORING** and is not affiliated with, authorized by, endorsed by, or maintained by Vallenta or Embarcadero Technologies. Vallenta Studio, RAD Studio, and related tools are installed separately and remain subject to their own licenses. See `NOTICE.md` for the complete notice.

---

## 简体中文

一套面向 **Delphi / Object Pascal** 的 VS Code 工程开发扩展，将跨工程符号、类导航、工程组管理、构建运行、原生调试、格式化和诊断集中到统一体验中。

Pascal Union 适合由 `.groupproj`、`.dproj`、`.dpk`、`.dpr` 和大量 `.pas` 文件组成的真实 Delphi 工程。它与 Vallenta Studio 协同工作，同时补足跨 Package 符号、编译包接口、工程导航和命令行构建调试等能力。

### 核心能力

#### 全工程符号与快速代码导航

- 自动发现工作区中的 `.groupproj`，加载其所有 Project 和 Package，不再只依赖 Vallenta 当前选中的单个工程。
- 合并工程目录、Unit Search Path 和源码目录，让跨包类型、变量、属性及函数可以着色、补全和跳转。
- 当前打开文件优先分析；索引、源码解析和编译符号恢复使用缓存与后台 Worker，降低 Reload Window 和大文件切换后的等待。
- Ctrl+单击和 `F12` 默认选择最合适的唯一目标：函数优先进入实现，类型与变量进入声明。
- `Alt+F12` 显式打开定义/实现候选列表，适合需要自行选择目标的场景。
- 支持 `Self.Member`、多级成员链、泛型类型、接口、Record、类方法和局部作用域的补充解析。
- 输入对象后的 `.` 可补全已知成员；函数参数输入过程中可显示签名及参数提示。

#### 无源码 Package 接口恢复

当依赖只提供 DCP/BPL、没有 Pascal 源码时，Pascal Union 可以利用本机 RAD Studio 工具恢复公开符号，并提供：

- 类型和成员着色；
- Go to Definition、Hover 和成员补全；
- 只读的注释式 Unit、接口和类声明预览；
- BPL 导出符号与 DCP 中 Unit/类型别名的回退解析。

如果同时存在真实 `.pas` 声明，源码始终优先，不会被生成接口覆盖。

#### Delphi 类导航与工程视图

Explorer 中的 **Delphi 导航** 可以在两种模式间切换：

- **类导航**：按 `uses`、`global`、类、接口、Record 和 Object 组织当前文件。
- **工程视图**：以 Project → Package 的层级展示 `.groupproj/.dpr` 与 `.dpk/.dproj`。

类导航只展示结构性内容，不罗列普通字段和局部变量：

- 类型节点下显示 Properties、构造/析构、Initialize/Finalize、类函数、静态函数和普通方法；
- 局部函数递归显示在所属函数下，不会误放到 `global`；
- 支持按可见性分组或严格按源码顺序显示；
- 点击类型或 Property 进入声明，点击函数优先进入实现；
- 编辑器点击与滚动会同步当前条目，并在行号槽标记对应代码块；
- 多个 `uses` 块、Unit `initialization` 和 `finalization` 均可独立定位。

工程视图中的 Project 和 Package 使用不同图标。右键节点可直接 Build、Compile、Clean、Run 或 Debug；文件节点可在主编辑器中打开。工程组操作也可以从视图标题栏的 `...` 菜单执行。

#### AI 函数步骤

类导航可通过 VS Code Language Model API 调用已安装的 OAI Compatible Copilot，为函数生成简短的中文功能步骤：

- 按实现功能块概括，而不是机械地逐行拆分；
- 复杂步骤可以继续细分为子步骤；
- 点击步骤会在行号槽标记对应范围，不覆盖代码文字；
- 支持一次生成当前文件的全部函数，也可以随时停止；
- 结果按函数内容缓存，源码未变化时无需重复请求。

AI 功能只会在用户主动触发后运行，并可在设置中完全关闭。

#### Delphi 工程组构建、运行与调试

Pascal Union 直接使用本机 Delphi 命令行工具链，不需要启动 RAD Studio，也不会运行 `bds.exe`。

- Package：Build、Compile、Clean、Debug、Attach to Package Host。
- Project Group：Build All、Compile All、Clean All、Run、Debug。
- 支持选择启动工程、Debug/Release 和 Win32/Win64。
- 可在状态栏显示 Build All、Run、Debug、平台和构建模式。
- 构建输出以清晰的 `[ERROR]` / `[WARN]` 摘要显示，并同步写入 Problems。
- Run 不附加调试器，程序的标准输出、错误输出和退出结果统一重定向到 VS Code Debug Console；Debug 的程序输出仍可选择独立控制台或 Debug Console。
- Debug 快捷键可在 Visual Studio 与 RAD Studio 两套布局之间切换。

原生调试由 MIT 许可的 `mca-software.delphi-debugger` 提供。Pascal Union 负责从 `.dproj/.groupproj` 生成动态调试配置，收集 EXE/BPL/DLL 及 MAP/RSM/DCP，并填写源码搜索路径。用户无需手写 `launch.json` 或安装 DDK。

对于尚未加载的 BPL/DLL，断点会暂时保持未验证；模块进入主进程后，调试器可以加载对应符号并激活断点。

#### 集成 Delphi Formatter

原 **Delphi Personal Formatter** 的能力已经内置到 Pascal Union：

- 作为 Pascal/Object Pascal 的默认文档格式化器；
- 使用 RAD Studio `Formatter.exe`，无需另外安装 Pascal Formatter 扩展；
- 保留 inline var、换行参数和调用参数的对齐；
- 可在输入 `;`、`)` 或 Enter 时仅格式化当前行或上一行；
- 提供详细的缩进、空格、换行、大小写和对齐规则；
- 内置一套默认语法规范，也支持保存和加载自定义 JSON Profile。

启用默认语法规范时，下方规则会按内置 Profile 生效并变为只读；关闭后即可逐项定制。

#### 诊断、编码与编辑体验

- 输入暂停后在 Worker 中检查字符串、注释、括号、泛型和 `begin/end` 等结构错误。
- 后台使用隔离的影子文件执行 Delphi 编译诊断，不覆盖工程源码或正常输出目录。
- Delphi 编译器或 LSP 确认标识符未知后，通过 **Add Unit to uses** 快速修复补充候选 Unit；Pascal Union 不再自行猜测并生成缺失 Unit 警告。
- 新建 `.pas/.dpr/.dpk/.dproj` 默认使用 GB2312；读取和保存已有文件时优先保留其原始编码，其他文档默认 UTF-8。
- 可选隐藏 Delphi 工程中的表单、`.skincfg`、输出目录和元数据文件。
- 内置常用 Object Pascal Snippet，包括 `begin/end`、条件、循环、异常处理、Case、Procedure 和 Function。
- RAD/VCL 平台源码使用隔离语言模式打开，避免查看 System/Winapi 源码后阻塞原工程的着色和跳转。

### 快速开始

1. 安装 Pascal Union，并按提示安装所需配套扩展。
2. 在 VS Code 中打开包含 `.groupproj`、`.dproj` 或 `.dpk` 的 Delphi 工程目录。
3. Pascal Union 会识别工程组、同步搜索路径，并优先分析当前打开的 Pascal 文件。
4. 从 Explorer 的 **Delphi 导航** 查看类结构或切换到工程视图。
5. 使用 Ctrl+单击跳转，或在工程视图中右键 Project/Package 执行构建、运行和调试。
6. 从 Activity Bar 打开 **Pascal Union → 能力与设置**，按功能分页调整行为。

### 设置

Pascal Union 提供可视化设置中心，也会把同一组选项注册到 VS Code 主 Settings 页面。相关选项归并为七个顶级分页：

- 通用；
- 编辑体验；
- 导航与符号；
- 格式化；
- 工程与文件；
- 构建与调试；
- 诊断。

“通用”页可以切换设置中心语言，支持简体中文（默认）和 English，选择后立即生效。

各能力均可独立开关。符号颜色可以一键恢复到插件内置默认配色，而不会改动同页的其他行为设置。

### 依赖与运行条件

- Windows；
- Visual Studio Code 1.85 或更高版本；
- Vallenta Studio（由 Marketplace 单独安装）；
- `ms-vscode.cpptools`（当前保留为 Vallenta/LSP 配套依赖）；
- 需要格式化、编译、调试或编译包符号恢复时，必须安装合法的 RAD Studio/Delphi 工具链。

Pascal Union 会在允许自动安装依赖时检查 Vallenta Studio、C/C++ 和 Delphi Debugger。独立的 **Pascal Formatter** 与 **Pascal** 扩展不是必需项；同时启用多个 Pascal 语言扩展可能产生重复的跳转或补全 Provider。

### 隐私与许可说明

Pascal Union 不包含遥测，也不会向 BORING 运营的服务上传源码。工程分析、格式化、编译和符号恢复均在本机执行。只有主动使用 AI 函数步骤时，选定函数内容才会交给用户在 VS Code 中选择的语言模型 Provider。

本扩展由 **BORING** 独立开发，与 Vallenta 或 Embarcadero Technologies 不存在隶属、授权或背书关系。Vallenta Studio、RAD Studio 及相关工具需单独安装，并遵循各自许可。完整说明见扩展包中的 `NOTICE.md`。

### 开发与发布

```powershell
npm test
npm run package
```

配置 Marketplace Publisher 后可运行：

```powershell
npm run publish
```
