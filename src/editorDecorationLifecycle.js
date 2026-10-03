'use strict';

function editorUri(editor) {
  return editor?.document?.uri?.toString?.() || '';
}

function findVisibleEditor(visibleEditors, target) {
  if (!target) return undefined;
  const editors = visibleEditors || [];
  const exact = editors.find(editor => editor === target);
  if (exact) return exact;

  const uri = editorUri(target);
  if (!uri) return undefined;
  const matchingUri = editors.filter(editor => editorUri(editor) === uri);
  if (matchingUri.length === 1) return matchingUri[0];
  if (matchingUri.length === 0) return undefined;

  return matchingUri.find(editor => editor.viewColumn === target.viewColumn)
    || matchingUri[0];
}

function shouldRetireEditor(visibleEditors, target) {
  return !findVisibleEditor(visibleEditors, target);
}

module.exports = { editorUri, findVisibleEditor, shouldRetireEditor };
