/** Structured source symbol data transferred to parser workers and persisted in caches. */
export interface SourceDefinition {
  symbol: string; unitName: string; filePath: string; offset: number; length: number;
  line: number; character: number; kind: string;
  signature?: string; typeName?: string; owner?: string; structureKind?: string;
  declarationEndOffset?: number; typeParameters?: string[]; elementType?: string;
  aliasedType?: string; helperTarget?: string; baseTypes?: string[];
  implementationOffset?: number; implementationLine?: number; implementationCharacter?: number;
}
export interface SourceUnit {
  unitName: string; filePath?: string; symbols: Set<string>;
  definitions: SourceDefinition[]; types: SourceDefinition[]; members: SourceDefinition[];
}
export interface SourceIndex {
  fileCount: number; files: Set<string>; symbols: Map<string, Set<string>>;
  definitions: Map<string, SourceDefinition[]>; types: Map<string, SourceDefinition[]>;
  members: Map<string, Map<string, SourceDefinition[]>>; units: Map<string, SourceDefinition[]>;
  cacheHit?: boolean; cacheElapsedMs?: number;
}
export interface SerializedSourceIndex {
  fileCount: number; files: string[]; symbols: Array<[string, string[]]>;
  definitions: Array<[string, SourceDefinition[]]>; types: Array<[string, SourceDefinition[]]>;
  members: Array<[string, Array<[string, SourceDefinition[]]>]>; units: Array<[string, SourceDefinition[]]>;
}
export interface SourceParserRequest { id: number; text: string; filePath: string; }
export type SourceParserResponse = { id: number; unit: SourceUnit | undefined; error?: never }
  | { id: number; error: string; unit?: never };
export interface DefinitionSelectionOptions {
  preferImplementation?: boolean; singleTarget?: boolean; usedUnitNames?: readonly string[];
}
