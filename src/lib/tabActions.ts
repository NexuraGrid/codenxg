import { useEditorStore, type EditorTab } from "../state/editorStore";
import { showDialog } from "../state/dialogStore";
import { disposeModel } from "./monacoModelRegistry";
import { saveFile } from "./fileSave";

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

  closing.forEach((t) => disposeModel(t.path));
  removeTabs(
    closing.map((t) => t.path),
    preferredActive,
  );
}

export type TabCloseAction = "close" | "others" | "left" | "right" | "all";

export function pathsToClose(tabs: EditorTab[], target: string, action: TabCloseAction): string[] {
  const index = tabs.findIndex((t) => t.path === target);
  if (index === -1) return [];

  switch (action) {
    case "close":
      return [target];
    case "others":
      return tabs.filter((t) => t.path !== target).map((t) => t.path);
    case "left":
      return tabs.slice(0, index).map((t) => t.path);
    case "right":
      return tabs.slice(index + 1).map((t) => t.path);
    case "all":
      return tabs.map((t) => t.path);
  }
}
