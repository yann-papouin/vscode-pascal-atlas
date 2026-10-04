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
      (method) => isRecord(method) && typeof method.name === "string",
    )
  )
}
export function isCompiledMethod(value: unknown): value is CompiledMethod {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.signature === "string" &&
    (value.typeName === undefined || typeof value.typeName === "string")
  )
}
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
    value.signatures.every((signature) => typeof signature === "string") &&
    (value.rttiMembers === undefined || isCompiledMethodArray(value.rttiMembers))
  )
}
export function isCompiledClassMap(
  value: unknown,
): value is Map<string, CompiledClass> {
  return (
    value instanceof Map &&
    [...value].every(
      ([key, entry]) => typeof key === "string" && isCompiledClass(entry),
    )
  )
}
function isCompiledProperty(value: unknown): value is CompiledProperty {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    isCompiledMethodArray(value.getters) &&
    isCompiledMethodArray(value.setters)
  )
}
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
function isStringMap<Value>(
  value: unknown,
  validate: (entry: unknown) => entry is Value,
): value is Map<string, Value> {
  return (
    value instanceof Map &&
    [...value].every(([key, entry]) => typeof key === "string" && validate(entry))
  )
}
function isRoutineArray(value: unknown): value is CompiledRoutine[] {
  return Array.isArray(value) && value.every(isCompiledRoutine)
}
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
export function isCompiledPackageData(value: unknown): value is CompiledPackageData {
  return (
    isRecord(value) &&
    typeof value.bplPath === "string" &&
    value.names instanceof Map &&
    [...value.names].every(
      ([key, name]) => typeof key === "string" && typeof name === "string",
    ) &&
    value.units instanceof Map &&
    [...value.units].every(
      ([key, units]) =>
        typeof key === "string" &&
        units instanceof Set &&
        [...units].every((unit) => typeof unit === "string"),
    ) &&
    isRecord(value.packageIndex) &&
    isStringMap(value.packageIndex.units, isCompiledUnit) &&
    isCompiledClassMap(value.packageIndex.classes) &&
    isStringMap(value.packageIndex.globals, isCompiledGlobal) &&
    isStringMap(value.packageIndex.routines, isCompiledRoutine)
  )
}
export function isCompiledMethodArray(value: unknown): value is CompiledMethod[] {
  return Array.isArray(value) && value.every(isCompiledMethod)
}
