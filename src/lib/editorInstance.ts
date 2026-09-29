import type * as monacoTypes from "monaco-editor";
import { useEditorStore } from "../state/editorStore";

type CodeEditor = monacoTypes.editor.IStandaloneCodeEditor;

// Each editor group's Monaco instance, for features outside the editor
// component (go to line from the palette, format on save). A group showing
// no text editor (no tab, a preview, settings) has none.
const editors = new Map<string, CodeEditor>();

export function setGroupEditor(groupId: string, editor: CodeEditor): void {
  editors.set(groupId, editor);
}

/** Unregisters `editor` — only if it is still the one registered for the group. */
export function clearGroupEditor(groupId: string, editor: CodeEditor): void {
  if (editors.get(groupId) === editor) editors.delete(groupId);
}

export function getGroupEditor(groupId: string): CodeEditor | null {
  return editors.get(groupId) ?? null;
}

/** The focused (active) editor group's editor, if it shows one. */
export function getActiveEditor(): CodeEditor | null {
  return getGroupEditor(useEditorStore.getState().activeGroupId);
}
