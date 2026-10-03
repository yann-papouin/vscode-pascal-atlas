# Pascal Union

[English](#english)

## English

A VS Code workspace suite for **Delphi / Object Pascal** that brings cross-project symbols, structural navigation, project-group management, build/run, formatting, and diagnostics into one consistent experience.

Pascal Union is designed for real Delphi workspaces made up of `.groupproj`, `.dproj`, `.dpk`, `.dpr`, and large collections of `.pas` files. It works alongside Vallenta Studio and fills important gaps around cross-package symbols, compiled-package interfaces, project navigation, and command-line build/run workflows.

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

The **Delphi Navigator** view in Explorer switches between two modes:

- **Class navigation** organizes the active file by `uses`, `global`, classes, interfaces, records, and objects.
- **Project view** presents `.groupproj/.dpr` and `.dpk/.dproj` as a Project → Package tree.

The class navigator focuses on structure rather than ordinary fields and local variables:

- Properties, constructors/destructors, Initialize/Finalize, class routines, static routines, and regular methods have distinct grouping and icons.
- Nested routines appear recursively under their owning routine instead of being misclassified as global.
- Members can be grouped by visibility or shown in original source order.
- Types and properties navigate to declarations; routines prefer implementations.
- Editor clicks and scrolling follow the active item and mark its source range in the line-number gutter.
- Multiple `uses` blocks plus Unit `initialization` and `finalization` sections are independently navigable.

Project and Package nodes use distinct icons. Package nodes offer Build, Compile, and Clean actions; Project nodes offer Build All, Compile All, Clean All, and Run. Group actions are also available from the view title's `...` menu, while file nodes open directly in the editor.

#### AI routine steps

The navigator can call an installed OAI Compatible Copilot through the VS Code Language Model API to create concise English functional steps for a routine:

- Steps describe meaningful implementation phases instead of mechanically splitting every few lines.
- Complex phases may be refined into one level of substeps.
- Clicking a step marks its range in the gutter without covering source text.
- All routines in the active file can be generated in one request, which can be stopped at any time.
- Results are cached by routine content and reused until the source changes.

AI analysis runs only when explicitly requested and can be disabled completely.

#### Project-group build and run

Pascal Union uses the installed Delphi command-line toolchain directly. It does not start RAD Studio or run `bds.exe`.

- Package commands: Build, Compile, and Clean.
- Project Group commands: Build All, Compile All, Clean All, and Run.
- Selectable startup project, Debug/Release configuration, and Win32/Win64 platform for Pascal Union Run and build commands.
- Optional status-bar actions for Build All, Run, platform, and configuration.
- Concise build summaries with aligned `[ERROR]` / `[WARN]` diagnostics, also published to Problems.
- Run does not attach a debugger and redirects standard output, standard error, and the exit result to the VS Code Debug Console.
- Delphi debugging remains available through Vallenta Studio.

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
4. Use **Delphi Navigator** in Explorer for class navigation or switch it to Project view.
5. Ctrl+Click to navigate, or use the Project/Package context menu to build or run. Use Vallenta Studio for Delphi debugging.
6. Open **Pascal Union → Features and Settings** from the Activity Bar to configure each feature page.

### Settings

Pascal Union provides a visual settings center and registers the same options in VS Code's main Settings editor. To keep navigation compact, related options are consolidated into seven top-level pages: General, Editing, Navigation & Symbols, Formatting, Projects & Files, Build & Debug, and Diagnostics. The settings center is displayed in English.

Every major capability has an independent switch. The symbol palette can be reset to the bundled defaults without changing unrelated coloring behavior.

### Requirements

- Windows;
- Visual Studio Code 1.85 or newer;
- Vallenta Studio, installed separately from the Marketplace;
- `ms-vscode.cpptools`, currently retained as a Vallenta/LSP companion;
- a licensed local RAD Studio/Delphi toolchain for formatting, compiling, debugging, or compiled-package recovery.

When dependency auto-installation is enabled, Pascal Union checks Vallenta Studio and C/C++. The separate **Pascal Formatter** and **Pascal** extensions are not required; enabling multiple Pascal language extensions may register duplicate completion or navigation providers.

### Privacy and independence

Pascal Union contains no telemetry and does not upload source code to a service operated by BORING. Project analysis, formatting, compilation, and symbol recovery run locally. Only the explicitly invoked AI routine-steps feature sends the selected routine to the language-model provider chosen by the user in VS Code.

Pascal Union is independently developed by **BORING** and is not affiliated with, authorized by, endorsed by, or maintained by Vallenta or Embarcadero Technologies. Vallenta Studio, RAD Studio, and related tools are installed separately and remain subject to their own licenses. See `NOTICE.md` for the complete notice.

### Development and publishing

```powershell
npm test
npm run package
```

After configuring a Marketplace Publisher, publish with:

```powershell
npm run publish
```
