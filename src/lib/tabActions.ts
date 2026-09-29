import { useEditorStore, type EditorTab } from "../state/editorStore";
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

export async function closeTabs(paths: string[], preferredActive?: string): Promise<void> {
  const { tabs, closeTabs: removeTabs } = useEditorStore.getState();
  const closing = tabs.filter((t) => paths.includes(t.path));
  if (closing.length === 0) return;
  if (!(await confirmUnsaved(closing))) return;

  closing.forEach((t) => {
    disposeModel(t.path);
    clearViewState(t.path);
  });
  removeTabs(
    closing.map((t) => t.path),
    preferredActive,
  );
}

/**
 * Opens `tab` as the preview tab (VS Code's single-click open). The preview it
 * replaces is never dirty (editing promotes it), so its model is just dropped.
 */
export function openPreviewTab(tab: EditorTab): void {
  const store = useEditorStore.getState();
  const replaced = store.tabs.find((t) => t.isPreview && t.path !== tab.path);
  store.addTab({ ...tab, isPreview: true });
  if (replaced && !useEditorStore.getState().tabs.some((t) => t.path === replaced.path)) {
    disposeModel(replaced.path);
    clearViewState(replaced.path);
  }
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
