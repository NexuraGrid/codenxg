import type * as monacoTypes from "monaco-editor";

// The single editor instance, for features outside the editor component
// (go to line from the palette). Null while no file is open.
let current: monacoTypes.editor.IStandaloneCodeEditor | null = null;

export function setActiveEditor(editor: monacoTypes.editor.IStandaloneCodeEditor | null): void {
  current = editor;
}

export function getActiveEditor(): monacoTypes.editor.IStandaloneCodeEditor | null {
  return current;
}
