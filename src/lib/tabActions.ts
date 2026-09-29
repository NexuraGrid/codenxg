import { isPathOpen, useEditorStore, type EditorTab } from "../state/editorStore";
import { showDialog } from "../state/dialogStore";
import { disposeModel } from "./monacoModelRegistry";
import { saveFile } from "./fileSave";
import { clearViewState } from "./tabViewState";

/**
 * VS Code's Save / Don't Save / Cancel prompt for modified tabs about to go
 * away. Resolves true when it is safe to proceed.
 */
export async function confirmUnsaved(tabs: EditorTab[]): Promise<boolean> {
  const dirty = tabs.filter((t) => t.isDirty);
  if (dirty.length === 0) return true;

  const title =
    dirty.length === 1
      ? `Do you want to save the changes you made to ${dirty[0].title}?`
      : `Do you want to save the changes to ${dirty.length} files?`;

  const choice = await showDialog({
    title,
    message: "Your changes will be lost if you don't save them.",
    buttons: [
      { label: "Save", value: "save", variant: "primary" },
      { label: "Don't Save", value: "discard" },
      { label: "Cancel", value: "cancel" },
    ],
    cancelValue: "cancel",
  });

  if (choice === "cancel") return false;
  if (choice === "discard") return true;

  try {
    await Promise.all(dirty.map((t) => saveFile(t.path)));
    return true;
  } catch (error) {
    // Nothing closes if a write failed: the edits are still only in memory.
    await showDialog({
      title: "Couldn't save your changes",
      message: String(error),
      buttons: [{ label: "OK", value: "ok", variant: "primary" }],
      cancelValue: "ok",
    });
    return false;
  }
}

/**
 * Closes `paths` in one editor group (default: the active one). Only a file's
 * last open copy asks to save its changes and drops its model: a copy still
 * open in another group keeps both, since the groups share that model.
 */
export async function closeTabs(paths: string[], preferredActive?: string, groupId?: string): Promise<void> {
  const state = useEditorStore.getState();
  const targetId = groupId ?? state.activeGroupId;
  const group = state.groups.find((g) => g.id === targetId);
  const closing = group?.tabs.filter((t) => paths.includes(t.path)) ?? [];
  if (closing.length === 0) return;
  const lastCopies = closing.filter((t) => !isPathOpen(state, t.path, targetId));
  if (!(await confirmUnsaved(lastCopies))) return;

  for (const t of closing) clearViewState(targetId, t.path);
  // Rechecked after the prompt: the other copy may have closed meanwhile.
  const now = useEditorStore.getState();
  for (const t of closing) if (!isPathOpen(now, t.path, targetId)) disposeModel(t.path);
  now.closeTabs(
    closing.map((t) => t.path),
    preferredActive,
    targetId,
  );
}

/**
 * Opens `tab` as the active group's preview tab (VS Code's single-click open).
 * The preview it replaces is never dirty (editing promotes it), so its model
 * is just dropped — unless another group still shows that file.
 */
export function openPreviewTab(tab: EditorTab): void {
  const store = useEditorStore.getState();
  const groupId = store.activeGroupId;
  const replaced = store.tabs.find((t) => t.isPreview && t.path !== tab.path);
  store.addTab({ ...tab, isPreview: true });
  const after = useEditorStore.getState();
  if (!replaced || after.groups.find((g) => g.id === groupId)?.tabs.some((t) => t.path === replaced.path)) return;
  clearViewState(groupId, replaced.path);
  if (!isPathOpen(after, replaced.path)) disposeModel(replaced.path);
}

export type TabCloseAction = "close" | "others" | "left" | "right" | "all";

/** Bulk actions (others/left/right/all) skip pinned tabs; a plain "close" doesn't. */
export function pathsToClose(tabs: EditorTab[], target: string, action: TabCloseAction): string[] {
  const index = tabs.findIndex((t) => t.path === target);
  if (index === -1) return [];

  switch (action) {
    case "close":
      return [target];
    case "others":
      return unpinnedPaths(tabs.filter((t) => t.path !== target));
    case "left":
      return unpinnedPaths(tabs.slice(0, index));
    case "right":
      return unpinnedPaths(tabs.slice(index + 1));
    case "all":
      return unpinnedPaths(tabs);
  }
}

function unpinnedPaths(tabs: EditorTab[]): string[] {
  return tabs.filter((t) => !t.isPinned).map((t) => t.path);
}
