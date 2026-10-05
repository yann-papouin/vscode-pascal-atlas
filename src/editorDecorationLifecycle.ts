export interface DecorationEditor {
  viewColumn?: number
  document?: {
    uri?: {
      /** Serialize the document URI for stable editor identity comparisons. */
      toString(): string
    }
  }
}
/**
 * Read an editor's document identity, returning an empty key when no document URI is
 * available.
 */
export function editorUri(editor: DecorationEditor | undefined): string {
  return editor?.document?.uri?.toString() || ""
}
/**
 * Rebind a decoration owner to a live editor by object identity, then URI and view
 * column; return undefined when no visible editor matches.
 */
export function findVisibleEditor<T extends DecorationEditor>(
  visibleEditors: readonly T[] | undefined,
  target: DecorationEditor | undefined,
): T | undefined {
  if (!target) return undefined
  const editors = visibleEditors || []
  const exact = editors.find(
    /** Find the exact editor object before falling back to document identity. */ (
      editor,
    ) => editor === target,
  )
  if (exact) return exact
  const uri = editorUri(target)
  if (!uri) return undefined
  // VS Code may replace an editor object without closing its document, so URI and column provide a stable fallback.
  const matching = editors.filter(
    /** Select editors displaying the same document URI. */ (editor) =>
      editorUri(editor) === uri,
  )
  return matching.length === 1
    ? matching[0]
    : matching.find(
        /** Prefer the matching editor in the same view column. */ (editor) =>
          editor.viewColumn === target.viewColumn,
      ) || matching[0]
}
/**
 * Determine whether a decoration owner has lost every visible editor for its document.
 */
export function shouldRetireEditor(
  visibleEditors: readonly DecorationEditor[] | undefined,
  target: DecorationEditor | undefined,
): boolean {
  return !findVisibleEditor(visibleEditors, target)
}
