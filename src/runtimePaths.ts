import * as path from "node:path"
/** Emitted modules live in out/src; static assets stay at the extension root. */
export const extensionRoot = path.resolve(__dirname, "..", "..")
/**
 * Resolve a static resource relative to the extension root, independently of the
 * emitted module directory.
 */
export function resourcePath(relativePath: string): string {
  return path.join(extensionRoot, relativePath)
}
/**
 * Resolve a compiled worker beside the running host module so packaged and development
 * launches use the same entrypoint.
 */
export function workerPath(fileName: string): string {
  return path.join(__dirname, fileName)
}
