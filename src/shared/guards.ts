/** Narrow values received from JSON, messages, and caught exceptions. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
export function isInteger(value: unknown): value is number {
  return Number.isInteger(value)
}
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === "string"
      ? error.message
      : String(error)
}
export function errorStack(error: unknown): string | undefined {
  return error instanceof Error
    ? error.stack
    : isRecord(error) && typeof error.stack === "string"
      ? error.stack
      : undefined
}

export function inList(value: unknown, values: readonly unknown[]): boolean {
  return values.includes(value)
}
