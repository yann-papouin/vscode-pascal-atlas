import { PascalKeyword } from "./shared/pascal"
import * as path from "node:path"

/**
 * Canonicalize a Delphi search-path entry for case-insensitive deduplication without
 * retaining trailing separators.
 */
function normalizeKey(value: string) {
  return path
    .normalize(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase()
}

/** Split a semicolon-delimited Unit Search Path into trimmed, nonempty entries. */
function splitSearchPath(value: string) {
  return typeof value === "string"
    ? value
        .split(";")
        .map(
          /** Trim one semicolon-separated search-path entry. */ (item) => item.trim(),
        )
        .filter(Boolean)
    : []
}

/**
 * Replace paths previously owned by Pascal Atlas while preserving user entries and the
 * first spelling of each canonical path.
 */
function mergeManagedSearchPath(
  currentValue: string,
  previousManaged: readonly string[],
  nextManaged: readonly string[],
) {
  const previousKeys = new Set(previousManaged.map(normalizeKey))
  // Only remove the previous managed set; user-owned paths must survive synchronization even when the managed roots change.
  const values = [
    ...splitSearchPath(currentValue).filter(
      /** Select search paths that were absent from the previous normalized path set. */ (
        item,
      ) => !previousKeys.has(normalizeKey(item)),
    ),
    ...nextManaged,
  ]
  const result = []
  const seen = new Set()
  for (const value of values) {
    const key = normalizeKey(value)
    if (!seen.has(key)) {
      seen.add(key)
      result.push(value)
    }
  }
  return result.join(";")
}

export { mergeManagedSearchPath, splitSearchPath }
