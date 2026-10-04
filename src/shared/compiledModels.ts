/** Compiled package symbols recovered from exported names and RTTI. */
export interface CompiledMethod {
  name: string; signature: string; abiName?: string; typeName?: string;
  mangled?: boolean; rtti?: boolean; inferred?: boolean;
}
export interface CompiledProperty { name: string; typeName?: string; abiName?: string; signature?: string; getters: CompiledMethod[]; setters: CompiledMethod[]; }
export interface CompiledMemberOwner {
  symbol: string; methods?: CompiledMethod[]; properties?: CompiledProperty[];
  rttiMembers?: CompiledMethod[];
}
interface CompiledBase { name?: string; signature?: string; classInfo?: CompiledClass; symbol: string; namespace: string; bplPath: string; }
export interface CompiledClass extends CompiledBase {
  kind: 'class' | 'interface'; signatures: string[]; methods: CompiledMethod[];
  properties: CompiledProperty[]; rttiMembers?: CompiledMethod[];
  compiledMembersLoaded?: boolean; compiledMembersPromise?: Promise<CompiledClass>;
}
interface EnrichedSymbol {
  typeName?: string; classInfo?: CompiledClass; observedMembers?: CompiledMethod[];
  workspaceMembersLoaded?: boolean; 
}
export interface CompiledGlobal extends CompiledBase, EnrichedSymbol {
  kind: 'global'; workspaceEnrichmentPromise?: Promise<CompiledGlobal>; signature: string; rttiLoaded?: boolean; rttiPromise?: Promise<CompiledGlobal>;
}
export interface CompiledRoutine extends CompiledBase, EnrichedSymbol {
  kind: 'routine'; workspaceEnrichmentPromise?: Promise<CompiledRoutine>; name: string; signature: string;
  returnTypeLoaded?: boolean; returnTypePromise?: Promise<CompiledRoutine>;
}
export interface CompiledUnit extends CompiledBase {
  kind: 'unit'; classes: Map<string, CompiledClass>; globals: Map<string, CompiledGlobal>;
  routines: Map<string, CompiledRoutine[]>;
}
export type CompiledInfo = CompiledClass | CompiledGlobal | CompiledRoutine | CompiledUnit;
export interface CompiledPackageIndex {
  units: Map<string, CompiledUnit>; classes: Map<string, CompiledClass>;
  globals: Map<string, CompiledGlobal>; routines: Map<string, CompiledRoutine>;
}
export interface CompiledPackageData {
  names: Map<string, string>; units: Map<string, Set<string>>;
  packageIndex: CompiledPackageIndex; bplPath: string; parsedCacheHit?: boolean;
}
export interface KnownCompiledMember { name: string; kind: string; value: CompiledMethod | CompiledProperty; }
export type ObservedMemberIndex = Map<string, Map<string, string>>;
export interface InferenceEntry { offset: number; typeName?: string; expression?: string; collectionName?: string; }
export interface RoutineInferenceScope {
  offset: number; headerEnd: number; owner?: string; selfOwner?: string; returnType?: string;
  parameters: Map<string, string>;
}
export interface PascalTypeInferenceIndex {
  text: string; code: string; declarations: Map<string, InferenceEntry[]>;
  inlineInitializers: Map<string, InferenceEntry[]>; forInVariables: Map<string, InferenceEntry[]>;
  casts: Map<string, InferenceEntry[]>; routines: RoutineInferenceScope[];
}
export interface PascalUsesRange { start: number; end: number; unitName: string; }
