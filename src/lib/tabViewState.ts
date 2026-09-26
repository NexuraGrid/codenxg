import type * as monacoTypes from "monaco-editor";

// One Monaco editor instance is reused across tabs (models are swapped in and
// out) — its view state (cursor, scroll, folding) lives here, keyed by path,
// so switching back to a tab lands where the user left it, in-session and
// across restarts (see persistedTabs.ts / tabPersistence.ts).
const states = new Map<string, monacoTypes.editor.ICodeEditorViewState>();

export function getViewState(path: string): monacoTypes.editor.ICodeEditorViewState | undefined {
  return states.get(path);
}

/** Accepts `unknown` so a value freshly parsed from disk can be passed straight through. */
export function setViewState(path: string, state: unknown): void {
  if (state) states.set(path, state as monacoTypes.editor.ICodeEditorViewState);
}

export function clearViewState(path: string): void {
  states.delete(path);
}

export function allViewStates(): ReadonlyMap<string, monacoTypes.editor.ICodeEditorViewState> {
  return states;
}
