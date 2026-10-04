import * as fs from "node:fs"
import * as path from "node:path"
export const projectRoot = path.resolve(__dirname, "..", "..")
export function sourcePath(moduleName: string): string {
  return path.join(projectRoot, "src", moduleName.replace(/\.js$/, ".ts"))
}
export function artifactPath(moduleName: string): string {
  return path.join(projectRoot, "out", "src", moduleName)
}
export function resourcePath(relativePath: string): string {
  return path.join(projectRoot, "resources", relativePath)
}
export function readBrowserScript(name = "classNavigatorClient"): string {
  return fs.readFileSync(path.join(projectRoot, "out", "webview", name + ".js"), "utf8")
}

import * as assert from "node:assert/strict"
export function required<T>(
  value: T,
  message = "Expected fixture value to be defined",
): NonNullable<T> {
  assert.ok(value !== undefined && value !== null, message)
  return value
}

import Module = require("node:module")
export type ModuleLoad = (
  request: string,
  parent: NodeModule | null | undefined,
  isMain: boolean,
) => unknown
interface TestModuleLoader {
  _load: ModuleLoad
}
function hasModuleLoader(value: unknown): value is TestModuleLoader {
  return (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    typeof Reflect.get(value, "_load") === "function"
  )
}
if (!hasModuleLoader(Module))
  throw new Error("This Node version does not expose its test module loader.")
export const testModuleLoader: TestModuleLoader = Module
