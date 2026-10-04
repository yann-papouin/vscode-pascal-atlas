/** Distinct protocol/model concepts retain their own string values. */
export const SourceSymbolKind = Object.freeze({
  Unit: "unit",
  Type: "type",
  Routine: "routine",
  Symbol: "symbol",
  Constant: "constant",
  Variable: "variable",
  Property: "property",
  Field: "field",
  EnumMember: "enumMember",
} as const)
export const CompiledSymbolKind = Object.freeze({
  Unit: "unit",
  Class: "class",
  Interface: "interface",
  Global: "global",
  Routine: "routine",
} as const)
export const CompiledMemberKind = Object.freeze({
  Constructor: "constructor",
  Destructor: "destructor",
  Method: "method",
  Property: "property",
  Rtti: "rtti",
  Observed: "observed",
} as const)
export const PascalBuiltinName = Object.freeze({
  TObject: "TObject",
  Create: "Create",
  Destroy: "Destroy",
  Pointer: "Pointer",
  System: "System",
} as const)
