import * as path from 'node:path';
/** Emitted modules live in out/src; static assets stay at the extension root. */
export const extensionRoot = path.resolve(__dirname, '..', '..');
export function resourcePath(relativePath: string): string { return path.join(extensionRoot, relativePath); }
export function workerPath(fileName: string): string { return path.join(__dirname, fileName); }
