import type {
  NavigatorModel,
  NavigatorTarget,
  RoutineBody,
  RoutineDirective,
  StructureMember,
} from "./models"
export interface CounterpartModel {
  routineNodes: NavigatorTarget[]
  implementationRoutines?: RoutineBody[]
}
export interface RoutineDeclarationIndex<T extends NavigatorTarget = NavigatorTarget> {
  bySignature: Map<string | undefined, T[]>
  byName: Map<string, T[]>
}
export interface DeclarationEntry extends NavigatorTarget {
  name: string
  start: number
  end: number
  headerEnd: number
  attributeStart?: number
  section?: number
  access?: string
  directives: RoutineDirective[]
}
export interface EditorOptions {
  eol?: string
  tabSize?: number | string
  insertSpaces?: boolean | string
}
export interface SourceEdit {
  offset: number
  endOffset: number
  text: string
}
export interface PlanFailure {
  reason: string
  edits?: undefined
  offset?: undefined
  text?: undefined
  caretOffset?: undefined
  targetId?: undefined
  direction?: undefined
}
export interface ImplementationPlan {
  reason?: undefined
  offset: number
  text: string
  caretOffset: number
  targetId?: string
}
export interface CounterpartPlan {
  reason?: undefined
  edits: SourceEdit[]
  caretOffset: number
  targetId?: string
  direction: string
}
export interface EditorPosition {
  line: number
  character: number
}
export interface EditorRange<P extends EditorPosition = EditorPosition> {
  start: P
  end: P
}
export interface EditorSelection<P extends EditorPosition = EditorPosition>
  extends EditorRange<P> {
  active: P
  isEmpty: boolean
}
export interface EditableDocument<
  P extends EditorPosition = EditorPosition,
  U extends {
    scheme?: string
    /** Serialize the document URI for identity and filesystem lookup. */
    toString(): string
  } = {
    scheme?: string
    /** Serialize the document URI for identity and filesystem lookup. */
    toString(): string
  },
> {
  uri: U
  languageId: string
  version: number
  eol: number
  isClosed?: boolean
  /** Read the current document source snapshot. */
  getText(): string
  /** Convert a UTF-16 source offset to an editor position. */
  positionAt(offset: number): P
  /** Convert an editor position to a UTF-16 source offset. */
  offsetAt(position: P): number
}
export interface EditBuilder<
  P extends EditorPosition = EditorPosition,
  R extends EditorRange<P> = EditorRange<P>,
> {
  /** Queue inserted text at an editor position in the current edit transaction. */
  insert(position: P, text: string): void
  /** Queue replacement text for a source range in the current edit transaction. */
  replace(range: R, text: string): void
}
export interface CounterpartEditor<
  P extends EditorPosition = EditorPosition,
  R extends EditorRange<P> = EditorRange<P>,
  S extends EditorSelection<P> = EditorSelection<P>,
  U extends {
    scheme?: string
    /** Serialize the document URI for identity and filesystem lookup. */
    toString(): string
  } = {
    scheme?: string
    /** Serialize the document URI for identity and filesystem lookup. */
    toString(): string
  },
> {
  document: EditableDocument<P, U>
  selections: readonly S[]
  selection: S
  options: EditorOptions
  /**
   * Apply queued edits with the requested undo boundaries and report whether they were
   * accepted.
   */
  edit(
    callback: (builder: EditBuilder<P, R>) => void,
    options: { undoStopBefore: boolean; undoStopAfter: boolean },
  ): PromiseLike<boolean>
  /** Reveal a source range using the optional editor reveal policy. */
  revealRange(range: R, type?: number): void
}
export interface ImplementationApi<
  P extends EditorPosition = EditorPosition,
  R extends EditorRange<P> = EditorRange<P>,
  S extends EditorSelection<P> = EditorSelection<P>,
  U extends {
    scheme?: string
    /** Serialize the document URI for identity and filesystem lookup. */
    toString(): string
  } = {
    scheme?: string
    /** Serialize the document URI for identity and filesystem lookup. */
    toString(): string
  },
> {
  window: {
    activeTextEditor?: CounterpartEditor<P, R, S, U>
    /** Display the reason a counterpart command cannot proceed. */
    showInformationMessage(message: string): unknown
    /** Display a counterpart creation failure to the user. */
    showErrorMessage(message: string): unknown
  }
  workspace: {
    /** Read configuration scoped to the optional document URI. */
    getConfiguration(
      section?: string,
      uri?: U,
    ): {
      /** Read a boolean option or return its fallback when unset. */
      get(key: string, fallback: boolean): boolean
    }
    fs?: {
      /** Report provider writability, or undefined when it is unknown. */
      isWritableFileSystem(scheme: string): boolean | undefined
    }
  }
  Selection: new (start: P, end: P) => S
  Range: new (start: P, end: P) => R
  EndOfLine: { CRLF: number }
  TextEditorRevealType: { InCenterIfOutsideViewport: number }
}
