import { PascalKeyword } from "./shared/pascal"
import * as path from "node:path"

function normalizeKey(value: string) {
  return path
    .normalize(value)
    .replace(/[\\/]+$/, "")
    .toLowerCase()
}

function splitSearchPath(value: string) {
  return typeof value === "string"
    ? value
        .split(";")
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

function mergeManagedSearchPath(
  currentValue: string,
  previousManaged: readonly string[],
  nextManaged: readonly string[],
) {
  const previousKeys = new Set(previousManaged.map(normalizeKey))
  const values = [
    ...splitSearchPath(currentValue).filter(
      (item) => !previousKeys.has(normalizeKey(item)),
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
