import { isRecord, isInteger } from "./guards"
import { WorkerOperation } from "./identifiers"
import type {
  CompiledClass,
  CompiledMethod,
  CompiledProperty,
  CompiledGlobal,
  CompiledRoutine,
  CompiledUnit,
  CompiledPackageData,
} from "./compiledModels"
export interface RttiClassDescriptor {
  symbol: string
  namespace: string
  methods: Array<{ name: string }>
}
export interface CompiledOperationContract {
  [WorkerOperation.MangledClasses]: {
    payload: { text: string; bplPath: string }
    result: Map<string, CompiledClass>
  }
  [WorkerOperation.PackageIndex]: {
    payload: { text: string; bplPath: string }
    result: CompiledPackageData
  }
  [WorkerOperation.RttiMembers]: {
    payload: { text: string; classInfo: RttiClassDescriptor }
    result: CompiledMethod[]
  }
}
export type CompiledOperation = keyof CompiledOperationContract
export type CompiledWorkerPayload = {
  [Operation in CompiledOperation]: {
    operation: Operation
  } & CompiledOperationContract[Operation]["payload"]
}[CompiledOperation]
export type CompiledWorkerRequest = CompiledWorkerPayload & { id: number }
export type CompiledWorkerResult =
  CompiledOperationContract[CompiledOperation]["result"]
export type CompiledWorkerResponse =
  | { id: number; value: CompiledWorkerResult; error?: never }
  | { id: number; error: string; value?: never }
/**
 * Validate the request envelope and operation-specific package/RTTI fields before a
 * worker reads untrusted payload properties.
 */
export function isCompiledWorkerRequest(
  value: unknown,
): value is CompiledWorkerRequest {
  if (!isRecord(value) || !isInteger(value.id) || typeof value.text !== "string")
    return false
  if (
    value.operation === WorkerOperation.MangledClasses ||
    value.operation === WorkerOperation.PackageIndex
  )
    return typeof value.bplPath === "string"
  return (
    value.operation === WorkerOperation.RttiMembers &&
    isRecord(value.classInfo) &&
    typeof value.classInfo.symbol === "string" &&
    typeof value.classInfo.namespace === "string" &&
    Array.isArray(value.classInfo.methods) &&
    value.classInfo.methods.every(
      /** Require every transferred class method to have a string name. */ (method) =>
        isRecord(method) && typeof method.name === "string",
    )
  )
}
/**
 * Narrow a compiled member record only when its name/signature and optional type name
 * have the expected shapes.
 */
export function isCompiledMethod(value: unknown): value is CompiledMethod {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.signature === "string" &&
    (value.typeName === undefined || typeof value.typeName === "string")
  )
}
/**
 * Validate a compiled class/interface and its nested methods, properties, signatures,
 * and optional RTTI before adopting parsed or cached data.
 */
export function isCompiledClass(value: unknown): value is CompiledClass {
  return (
    isRecord(value) &&
    (value.kind === "class" || value.kind === "interface") &&
    typeof value.symbol === "string" &&
    typeof value.namespace === "string" &&
    typeof value.bplPath === "string" &&
    Array.isArray(value.methods) &&
    value.methods.every(isCompiledMethod) &&
    Array.isArray(value.properties) &&
    value.properties.every(isCompiledProperty) &&
    Array.isArray(value.signatures) &&
    value.signatures.every(
      /** Require every transferred routine signature to be text. */ (signature) =>
        typeof signature === "string",
    ) &&
    (value.rttiMembers === undefined || isCompiledMethodArray(value.rttiMembers))
  )
}
/**
 * Validate every key and class record in a Map transferred from a worker or restored
 * from a cache.
 */
export function isCompiledClassMap(
  value: unknown,
): value is Map<string, CompiledClass> {
  return (
    // Structured cloning preserves Map containers, but their keys and nested records still need validation at the trust boundary.
    value instanceof Map &&
    [...value].every(
      /** Validate class-map keys and their transferred class records. */ ([
        key,
        entry,
      ]) => typeof key === "string" && isCompiledClass(entry),
    )
  )
}
/**
 * Validate an inferred property and both accessor-method arrays without trusting
 * nested serialized values.
 */
function isCompiledProperty(value: unknown): value is CompiledProperty {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isCompiledMethodArray(value.getters) &&
    isCompiledMethodArray(value.setters)
  )
}
/**
 * Validate a compiled global symbol, including an optional associated class
 * descriptor.
 */
function isCompiledGlobal(value: unknown): value is CompiledGlobal {
  return (
    isRecord(value) &&
    value.kind === "global" &&
    typeof value.symbol === "string" &&
    typeof value.namespace === "string" &&
    typeof value.bplPath === "string" &&
    typeof value.signature === "string" &&
    (value.typeName === undefined || typeof value.typeName === "string") &&
    (value.classInfo === undefined || isCompiledClass(value.classInfo))
  )
}
/**
 * Recognize a compiled routine record with the namespaced identity and signature
 * needed for navigation.
 */
function isCompiledRoutine(value: unknown): value is CompiledRoutine {
  return (
    isRecord(value) &&
    value.kind === "routine" &&
    typeof value.symbol === "string" &&
    typeof value.name === "string" &&
    typeof value.namespace === "string" &&
    typeof value.bplPath === "string" &&
    typeof value.signature === "string"
  )
}
/**
 * Validate a string-keyed Map using a supplied value guard, preserving the narrowed
 * value type for downstream readers.
 */
function isStringMap<Value>(
  value: unknown,
  validate: (entry: unknown) => entry is Value,
): value is Map<string, Value> {
  return (
    value instanceof Map &&
    [...value].every(
      /** Validate each map key and delegate its value to the supplied record guard. */ ([
        key,
        entry,
      ]) => typeof key === "string" && validate(entry),
    )
  )
}
/** Require an array composed entirely of valid compiled routine records. */
function isRoutineArray(value: unknown): value is CompiledRoutine[] {
  return Array.isArray(value) && value.every(isCompiledRoutine)
}
/**
 * Validate the nested class, global, and overloaded-routine maps of a compiled unit.
 */
function isCompiledUnit(value: unknown): value is CompiledUnit {
  return (
    isRecord(value) &&
    value.kind === "unit" &&
    typeof value.symbol === "string" &&
    typeof value.namespace === "string" &&
    typeof value.bplPath === "string" &&
    isCompiledClassMap(value.classes) &&
    isStringMap(value.globals, isCompiledGlobal) &&
    isStringMap(value.routines, isRoutineArray)
  )
}
/**
 * Validate the complete package-index envelope, including nested Maps and Sets, before
 * accepting a worker result or persisted package cache.
 */
export function isCompiledPackageData(value: unknown): value is CompiledPackageData {
  return (
    isRecord(value) &&
    typeof value.bplPath === "string" &&
    value.names instanceof Map &&
    [...value.names].every(
      /** Require compiled-name entries to contain string keys and names. */ ([
        key,
        name,
      ]) => typeof key === "string" && typeof name === "string",
    ) &&
    value.units instanceof Map &&
    [...value.units].every(
      /** Validate each unit-candidate set and all unit names it contains. */ ([
        key,
        units,
      ]) =>
        typeof key === "string" &&
        units instanceof Set &&
        [...units].every(
          /** Require one transferred unit candidate to be a string. */ (unit) =>
            typeof unit === "string",
        ),
    ) &&
    isRecord(value.packageIndex) &&
    isStringMap(value.packageIndex.units, isCompiledUnit) &&
    isCompiledClassMap(value.packageIndex.classes) &&
    isStringMap(value.packageIndex.globals, isCompiledGlobal) &&
    isStringMap(value.packageIndex.routines, isCompiledRoutine)
  )
}
/** Require an array composed entirely of valid compiled method records. */
export function isCompiledMethodArray(value: unknown): value is CompiledMethod[] {
  return Array.isArray(value) && value.every(isCompiledMethod)
}
