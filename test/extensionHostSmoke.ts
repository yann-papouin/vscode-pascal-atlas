import { findFormatterExecutable } from "../src/formatter/formatterSupport"
import * as assert from "node:assert/strict"
import * as fs from "node:fs"
import * as path from "node:path"
import * as vscode from "vscode"
import { CommandId, LanguageId } from "../src/shared/identifiers"
import { errorMessage } from "../src/shared/guards"

interface SmokeReport {
  vscode: string
  passed: string[]
  limitations: string[]
  error?: string
}
function positionOf(
  document: vscode.TextDocument,
  text: string,
  extra = 0,
): vscode.Position {
  const offset = document.getText().indexOf(text)
  assert.ok(offset >= 0, "Missing smoke fixture marker: " + text)
  return document.positionAt(offset + extra)
}
async function eventually<T>(
  read: () => T | PromiseLike<T>,
  accepted: (value: T) => boolean,
  label: string,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    const value = await read()
    if (accepted(value)) return value
    if (Date.now() >= deadline) throw new Error("Timed out waiting for " + label)
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
}
export async function run(): Promise<void> {
  const report: SmokeReport = { vscode: vscode.version, passed: [], limitations: [] }
  try {
    const extension = vscode.extensions.getExtension<unknown>(
      "yannpapouin.pascal-atlas",
    )
    assert.ok(extension, "Pascal Atlas must be loaded from extensionDevelopmentPath")
    await extension.activate()
    assert.equal(extension.isActive, true)
    report.passed.push("Extension activation")
    assert.equal(
      vscode.workspace.getConfiguration("pascalAtlas").get("dependencies.autoInstall"),
      false,
    )
    const commands = new Set(await vscode.commands.getCommands(true))
    for (const command of [
      CommandId.OpenSettings,
      CommandId.ControlCenterRefresh,
      CommandId.ClassNavigatorRefresh,
      CommandId.FormatterFormatDocument,
      CommandId.DiagnosticsRunNow,
      CommandId.GoToDefinition,
    ])
      assert.ok(commands.has(command), "Missing command " + command)
    report.passed.push(
      "Navigator, settings, diagnostics, formatting and navigation commands registered",
    )
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    assert.ok(root, "Expected isolated smoke workspace")
    const document = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(root, "Smoke.pas")),
    )
    assert.equal(document.languageId, LanguageId.Pascal)
    await vscode.window.showTextDocument(document)
    await vscode.commands.executeCommand("pascalAtlas.classNavigator.focus")
    await vscode.commands.executeCommand(CommandId.ClassNavigatorRefresh)
    await vscode.commands.executeCommand("pascalAtlas.controlCenter.focus")
    await vscode.commands.executeCommand(CommandId.ControlCenterRefresh)
    await vscode.commands.executeCommand(CommandId.OpenSettings)
    await eventually(
      () =>
        vscode.window.tabGroups.all
          .flatMap((group) => group.tabs)
          .some((tab) => tab.label === "Pascal Atlas Settings"),
      Boolean,
      "settings webview tab",
    )
    report.passed.push(
      "Navigator and Control Center views and full settings webview opened",
    )
    await vscode.window.showTextDocument(document)
    const definitions = await eventually(
      () =>
        vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
          "vscode.executeDefinitionProvider",
          document.uri,
          positionOf(document, "  SmokeAction ( );", 4),
        ),
      (result) =>
        Array.isArray(result) &&
        result.some(
          (item) =>
            ("uri" in item ? item.uri : item.targetUri).toString() ===
            document.uri.toString(),
        ),
      "current-file routine definition",
    )
    assert.ok(definitions.length)
    report.passed.push("Current-file source definition provider")
    const completions = await eventually(
      () =>
        vscode.commands.executeCommand<vscode.CompletionList | undefined>(
          "vscode.executeCompletionItemProvider",
          document.uri,
          positionOf(document, "  SmokeAction ( );", 5),
        ),
      (result) =>
        Boolean(
          result?.items.some(
            (item) =>
              (typeof item.label === "string" ? item.label : item.label.label) ===
              "SmokeAction",
          ),
        ),
      "current-file symbol completion",
    )
    assert.ok(completions)
    report.passed.push("Current-file symbol completion provider")
    const line = positionOf(document, "  SmokeAction ( );").line
    const onTypeEdits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
      "vscode.executeFormatOnTypeProvider",
      document.uri,
      new vscode.Position(line, document.lineAt(line).text.length),
      ";",
      { tabSize: 2, insertSpaces: true },
    )
    assert.ok(onTypeEdits.length > 0, "On-type formatter must produce spacing edits")
    const formattingEdit = new vscode.WorkspaceEdit()
    formattingEdit.set(document.uri, onTypeEdits)
    assert.equal(await vscode.workspace.applyEdit(formattingEdit), true)
    assert.match(
      document.getText(),
      /SmokeAction\(\);/,
      "On-type formatter must normalize call spacing",
    )
    report.passed.push(
      "Registered on-type formatting provider normalized Pascal call spacing",
    )
    const formatter = findFormatterExecutable(document)
    if (formatter && fs.existsSync(formatter)) {
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        document.uri,
        { tabSize: 2, insertSpaces: true },
      )
      assert.ok(
        edits.length > 0,
        "Detected Formatter.exe must format the deliberately unformatted fixture",
      )
      const edit = new vscode.WorkspaceEdit()
      edit.set(document.uri, edits)
      assert.equal(await vscode.workspace.applyEdit(edit), true)
      assert.match(document.getText(), /procedure TDemo\.Ping;/)
      report.passed.push(
        "Detected Formatter.exe document formatting execution and result",
      )
    } else {
      const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
        "vscode.executeFormatDocumentProvider",
        document.uri,
        { tabSize: 2, insertSpaces: true },
      )
      assert.ok(Array.isArray(edits))
      report.passed.push("Document formatter handled unavailable external tool")
      report.limitations.push(
        "Licensed Formatter.exe execution was unavailable; registered on-type formatting was exercised.",
      )
    }
    const broken = await vscode.workspace.openTextDocument(
      vscode.Uri.file(path.join(root, "SyntaxSmoke.pas")),
    )
    await vscode.window.showTextDocument(broken)
    await vscode.commands.executeCommand(CommandId.DiagnosticsRunNow)
    await eventually(
      () => vscode.languages.getDiagnostics(broken.uri),
      (diagnostics) =>
        diagnostics.some(
          (item) =>
            item.source === "Pascal Atlas Syntax" &&
            item.code === "pascal.declaration.missingValue",
        ),
      "syntax worker diagnostics",
    )
    report.passed.push("Compiled syntax worker published real Problems diagnostics")
    report.limitations.push(
      "Licensed Delphi compiler execution was disabled in the isolated smoke workspace.",
    )
    console.log("Pascal Atlas Extension Host smoke passed: " + report.passed.join("; "))
  } catch (error) {
    report.error = errorMessage(error)
    throw error
  } finally {
    const reportPath = process.env.PASCAL_ATLAS_SMOKE_REPORT
    if (reportPath)
      await fs.promises.writeFile(
        reportPath,
        JSON.stringify(report, null, 2) + "\n",
        "utf8",
      )
  }
}
