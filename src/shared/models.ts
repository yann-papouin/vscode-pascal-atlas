/** Shared source and navigation data, including metadata added during parsing. */
export interface NavigatorTarget {
  stepDepth?: number
  isCurrentFile?: boolean
  icon?: string
  id?: string
  kind?: string
  label?: string
  name?: string
  owner?: string
  qualifiedName?: string
  signature?: string
  routineKind?: string
  routineFlavor?: string
  specialRoutineKind?: string
  typeKind?: string
  typeName?: string
  access?: string
  section?: string | number
  targetKind?: string
  missingCounterpart?: string
  contextValue?: string
  filePath?: string
  projectPath?: string
  groupPath?: string
  fsPath?: string
  routineSignatureKey?: string
  description?: string
  tooltip?: string
  offset?: number
  rangeOffset?: number
  declarationOffset?: number
  declarationAttributesStartOffset?: number
  declarationStartOffset?: number
  declarationHeaderEndOffset?: number
  declarationEndOffset?: number
  declarationTerminatorEndOffset?: number
  implementationOffset?: number
  implementationStartOffset?: number
  implementationEndOffset?: number
  implementationTerminatorEndOffset?: number
  startLine?: number
  endLine?: number
  line?: number
  end?: number
  next?: number
  terminatorEndOffset?: number
  children?: NavigatorNode[]
  parent?: NavigatorNode
  ranges?: Array<[number, number]>
  routineOverloaded?: boolean
  classLayout?: StructureLayout
}
export interface NavigatorNode extends NavigatorTarget {
  id: string
  kind: string
  label: string
  children: NavigatorNode[]
}

export interface RoutineDirective {
  name: string
  start: number
  end: number
}
export interface StructureMember {
  kind: string
  name: string
  nameOffset?: number
  start: number
  end: number
  headerEnd?: number
  attributeStart?: number
  directiveNames?: string[]
  directives?: RoutineDirective[]
  declarationKind?: string
  typeName?: string
  routineKind?: string
  section?: number
  access?: string
  accessors?: string[]
}
export interface StructureSection {
  access: string
  start: number
  bodyStart: number
  end?: number
  implicit?: boolean
  spelling?: string
  members?: StructureMember[]
}
export interface StructureLayout {
  name?: string
  offset?: number
  kind: string
  start?: number
  kindOffset?: number
  bodyStart: number
  closingStart?: number
  endOffset: number
  forward?: boolean
  shorthand?: boolean
  keyword?: string
  sections: StructureSection[]
  members: StructureMember[]
  nested?: StructureLayout[]
}
export interface RoutineHeader {
  name: string
  nameOffset: number
  start: number
  headerEnd: number
  owner?: string
  signature?: string
  kind?: string
  routineKind?: string
  ownerParts?: string[]
}
export interface RoutineBody {
  header: RoutineHeader
  children: RoutineBody[]
  end: number
  complete: boolean
  next: number
  terminatorEndOffset?: number
}
export interface NavigatorModel {
  filePath: string
  roots: NavigatorNode[]
  nodes: NavigatorNode[]
  routineNodes: NavigatorNode[]
  implementationNodes: NavigatorNode[]
  declarationNodes: NavigatorNode[]
  propertyNodes: NavigatorNode[]
  typeNodes: NavigatorNode[]
  sectionNodes: NavigatorNode[]
  uses: NavigatorNode[]
  implementationRoutines: RoutineBody[]
}
export interface NavigatorOptions {
  showUses?: boolean
  showGlobalRoutines?: boolean
  showInterfaces?: boolean
  showRecordsAndObjects?: boolean
  showProperties?: boolean
  showProjectPackageEntry?: boolean
  showProjectFileEntry?: boolean
  showUnitInitialization?: boolean
  showUnitFinalization?: boolean
  memberOrder?: string
  typeOrder?: string
  backgroundParsingEnabled?: boolean
  backgroundParsingThresholdKb?: number
  aiStepsEnabled?: boolean
}
export type { SourceDefinition, SourceUnit, SourceIndex } from "./sourceModels"
