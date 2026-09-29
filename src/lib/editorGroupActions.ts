import { findGroup, sideGroupId, useEditorStore, type EditorTab } from "../state/editorStore";
import { getGroupEditor } from "./editorInstance";
import { pathOfModel } from "./monacoModelRegistry";
import { clearViewState, copyViewState, pruneViewStates, setViewState } from "./tabViewState";
import { closeTabs } from "./tabActions";

/**
 * Split editor groups, VS Code style: up to MAX_EDITOR_GROUPS groups side by
 * side, each with its own tabs; one of them is focused (the active group)
 * and everything that opens a file — explorer, quick open, search, go to
 * definition, pin groups — acts on that one.
 */

/** Saves the live cursor/scroll of `path` in `groupId`'s editor, if it is showing it. */
function captureViewState(groupId: string, path: string): void {
  const editor = getGroupEditor(groupId);
  const model = editor?.getModel();
  if (!editor || !model || pathOfModel(model) !== path) return;
  try {
    const state = editor.saveViewState();
    if (state) setViewState(groupId, path, state);
  } catch {
    // Best-effort only.
  }
}

/** Moves keyboard focus into a group's editor once it has rendered. */
function focusEditorSoon(groupId: string): void {
  requestAnimationFrame(() => getGroupEditor(groupId)?.focus());
}

function activeTab(): EditorTab | undefined {
  const { tabs, activeTabPath } = useEditorStore.getState();
  return tabs.find((t) => t.path === activeTabPath);
}

/**
 * Opens `tab` in the group to the side of the active one (creating it when
 * there is room) without moving focus. Returns that group's id, or null.
 */
export function openToSide(tab: EditorTab): string | null {
  const store = useEditorStore.getState();
  const target = sideGroupId(store);
  if (target) {
    store.addTab(tab, target);
    return target;
  }
  return store.addGroup(store.activeGroupId, tab);
}

/**
 * Split Editor (Ctrl+\): shows the active tab in the other group too (creating
 * it) and focuses that copy. Both copies share the file's model.
 */
export function splitEditor(): void {
  const tab = activeTab();
  if (!tab) return;
  const from = useEditorStore.getState().activeGroupId;
  captureViewState(from, tab.path);
  const target = openToSide({ ...tab, isPreview: false, isPinned: false });
  if (!target) return;
  copyViewState(from, target, tab.path);
  useEditorStore.getState().focusGroup(target);
  focusEditorSoon(target);
}

/**
 * Move Editor into Left/Right Group (Ctrl+Alt+Left/Right). Moving right from
 * the rightmost group creates a new one, unless the tab is its group's only
 * one (the result would look the same).
 */
export function moveEditorToGroup(direction: "left" | "right"): void {
  const tab = activeTab();
  if (!tab) return;
  const store = useEditorStore.getState();
  const from = store.activeGroupId;
  const index = store.groups.findIndex((g) => g.id === from);
  let target: string | null = store.groups[direction === "left" ? index - 1 : index + 1]?.id ?? null;
  if (!target && direction === "right" && store.tabs.length > 1) target = store.addGroup(from);
  if (!target) return;

  captureViewState(from, tab.path);
  copyViewState(from, target, tab.path);
  clearViewState(from, tab.path);
  useEditorStore.getState().moveTab(tab.path, from, target);
  pruneViewStates(useEditorStore.getState().groups.map((g) => g.id));
  focusEditorSoon(target);
}

/** Move Editor to Other Group: right when there is (or can be) a group there, otherwise left. */
export function moveEditorToOtherGroup(): void {
  const { groups, activeGroupId } = useEditorStore.getState();
  const index = groups.findIndex((g) => g.id === activeGroupId);
  moveEditorToGroup(index < groups.length - 1 || groups.length === 1 ? "right" : "left");
}

/**
 * Focus Left/Right Editor Group (Ctrl+1 / Ctrl+2). Like VS Code, focusing a
 * group that doesn't exist yet splits the active editor into it.
 */
export function focusGroupAt(index: number): void {
  const { groups, focusGroup } = useEditorStore.getState();
  const group = groups[index];
  if (group) {
    focusGroup(group.id);
    focusEditorSoon(group.id);
  } else if (index === groups.length) {
    splitEditor();
  }
}

/** Close Editor Group: closes its tabs (asking to save a file's last copy), which removes the group. */
export async function closeGroup(groupId?: string): Promise<void> {
  const store = useEditorStore.getState();
  const id = groupId ?? store.activeGroupId;
  const group = findGroup(store, id);
  if (!group || store.groups.length < 2) return;
  await closeTabs(
    group.tabs.map((t) => t.path),
    undefined,
    id,
  );
  pruneViewStates(useEditorStore.getState().groups.map((g) => g.id));
}
