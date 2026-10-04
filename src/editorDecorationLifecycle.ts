export interface DecorationEditor { viewColumn?: number; document?: { uri?: { toString(): string } }; }
export function editorUri(editor: DecorationEditor | undefined): string { return editor?.document?.uri?.toString() || ''; }
export function findVisibleEditor<T extends DecorationEditor>(visibleEditors: readonly T[] | undefined, target: DecorationEditor | undefined): T | undefined {
 if (!target) return undefined;
 const editors = visibleEditors || [];
 const exact = editors.find(editor => editor === target);
 if (exact) return exact;
 const uri = editorUri(target); if (!uri) return undefined;
 const matching = editors.filter(editor => editorUri(editor) === uri);
 return matching.length === 1 ? matching[0] : matching.find(editor => editor.viewColumn === target.viewColumn) || matching[0];
}
export function shouldRetireEditor(visibleEditors: readonly DecorationEditor[] | undefined, target: DecorationEditor | undefined): boolean { return !findVisibleEditor(visibleEditors, target); }
