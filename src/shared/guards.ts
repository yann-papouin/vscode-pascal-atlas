/** Narrow values received from JSON, messages, and caught exceptions. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
/**
 * Narrow an untrusted value to an integer without coercing strings or fractional
 * numbers.
 */
export function isInteger(value: unknown): value is number {
  return Number.isInteger(value)
}
/**
 * Extract a caught error's message, accepting serialized error records and falling
 * back to string conversion.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : isRecord(error) && typeof error.message === "string"
      ? error.message
      : String(error)
}
/**
 * Read a native or serialized error stack without assuming every caught value is an
 * Error instance.
 */
export function errorStack(error: unknown): string | undefined {
  return error instanceof Error
    ? error.stack
    : isRecord(error) && typeof error.stack === "string"
      ? error.stack
      : undefined
}

/**
 * Test membership against heterogeneous readonly values without weakening the caller's
 * input type.
 */
export function inList(value: unknown, values: readonly unknown[]): boolean {
  return values.includes(value)
}
