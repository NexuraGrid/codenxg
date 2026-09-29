import type * as monacoTypes from "monaco-editor";

type ViewState = monacoTypes.editor.ICodeEditorViewState;

// Each editor group reuses one Monaco editor instance across its tabs (models
// are swapped in and out) — its view state (cursor, scroll, folding) lives
// here, keyed by group and path, so switching back to a tab lands where the
// user left it, in-session and across restarts (see persistedTabs.ts /
// tabPersistence.ts). The same file open in two groups keeps two view states.
const states = new Map<string, Map<string, ViewState>>();
const EMPTY: ReadonlyMap<string, ViewState> = new Map();

export function getViewState(groupId: string, path: string): ViewState | undefined {
  return states.get(groupId)?.get(path);
}

/** Accepts `unknown` so a value freshly parsed from disk can be passed straight through. */
export function setViewState(groupId: string, path: string, state: unknown): void {
  if (!state) return;
  let group = states.get(groupId);
  if (!group) states.set(groupId, (group = new Map()));
  group.set(path, state as ViewState);
}

export function clearViewState(groupId: string, path: string): void {
  states.get(groupId)?.delete(path);
}

/** Carries `path`'s view state to another group (split / move). */
export function copyViewState(fromGroupId: string, toGroupId: string, path: string): void {
  const state = getViewState(fromGroupId, path);
  if (state) setViewState(toGroupId, path, state);
}

export function viewStatesOf(groupId: string): ReadonlyMap<string, ViewState> {
  return states.get(groupId) ?? EMPTY;
}

/** Forgets groups that no longer exist. */
export function pruneViewStates(liveGroupIds: readonly string[]): void {
  for (const id of states.keys()) if (!liveGroupIds.includes(id)) states.delete(id);
}
