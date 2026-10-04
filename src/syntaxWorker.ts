import { parentPort } from "node:worker_threads"
import { analyzePascalSyntax, type SyntaxDiagnostic } from "./syntaxAnalyzer"
import { errorMessage, errorStack, isRecord } from "./shared/guards"
import { WorkerEvent } from "./shared/identifiers"
export interface SyntaxRequest {
  id: number
  uri: string
  version: number
  text: string
  defines?: readonly string[]
}
export type SyntaxResponse = Pick<SyntaxRequest, "id" | "uri" | "version"> &
  (
    | { diagnostics: SyntaxDiagnostic[]; error?: never }
    | { error: string; diagnostics?: never }
  )
function isSyntaxRequest(value: unknown): value is SyntaxRequest {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    typeof value.uri === "string" &&
    typeof value.version === "number" &&
    typeof value.text === "string" &&
    (value.defines === undefined ||
      (Array.isArray(value.defines) &&
        value.defines.every((define: unknown) => typeof define === "string")))
  )
}
const port = parentPort
if (!port) throw new Error("Syntax worker must run in a worker thread.")
port.on(WorkerEvent.Message, (request: unknown) => {
  const identity = {
    id: isRecord(request) && typeof request.id === "number" ? request.id : -1,
    uri: isRecord(request) && typeof request.uri === "string" ? request.uri : "",
    version:
      isRecord(request) && typeof request.version === "number" ? request.version : -1,
  }
  let response: SyntaxResponse
  try {
    if (!isSyntaxRequest(request)) throw new Error("Invalid syntax-worker request.")
    response = {
      ...identity,
      diagnostics: analyzePascalSyntax(request.text, { defines: request.defines }),
    }
  } catch (error) {
    response = { ...identity, error: errorStack(error) || errorMessage(error) }
  }
  port.postMessage(response)
})
