import { deleteEntryPermanently, moveEntry, renameEntry, trashEntry } from "./tauri-api";
import { disposeModel, rebaseModels } from "./monacoModelRegistry";
import { basename, isSameOrInside } from "./paths";
import { useEditorStore } from "../state/editorStore";
import { useExplorerStore } from "../state/explorerStore";
import { showDialog } from "../state/dialogStore";

/**
 * After a rename or move on disk: carries every open tab, Monaco model and
 * expanded folder from `oldPath` to `newPath`, then reloads the listings.
 */
async function followRelocation(oldPath: string, newPath: string, dirsToRefresh: string[]) {
  // Models first: when the active tab's path changes the editor looks its
  // model up by the new path, and must find it there — not reread the file,
  // which would drop unsaved edits.
  rebaseModels(oldPath, newPath);
  useEditorStore.getState().rebasePaths(oldPath, newPath);
  const explorer = useExplorerStore.getState();
  explorer.rebasePaths(oldPath, newPath);
  await Promise.all(dirsToRefresh.map((dir) => explorer.refresh(dir)));
}

/** Rejects (renaming nothing) on failure. */
export async function renamePath(oldPath: string, parentDir: string, newName: string): Promise<string> {
  const newPath = await renameEntry(oldPath, newName);
  if (newPath !== oldPath) await followRelocation(oldPath, newPath, [parentDir]);
  return newPath;
}

/** Drag and drop in the explorer. Failures are reported in a dialog. */
export async function movePath(oldPath: string, oldParentDir: string, targetDir: string): Promise<void> {
  let newPath: string;
  try {
    newPath = await moveEntry(oldPath, targetDir);
  } catch (error) {
    await showDialog({
      title: `Couldn't move '${basename(oldPath)}'`,
      message: String(error),
      buttons: [{ label: "OK", value: "ok", variant: "primary" }],
      cancelValue: "ok",
    });
    return;
  }
  if (newPath === oldPath) return;

  await followRelocation(oldPath, newPath, [oldParentDir, targetDir]);
  // Like VS Code: the destination opens so the moved entry stays visible.
  const explorer = useExplorerStore.getState();
  if (targetDir !== explorer.root) explorer.expand(targetDir);
}

/**
 * VS Code's delete: confirm, move to the trash, and only if the trash is
 * unavailable offer a permanent delete behind a second, explicit prompt.
 */
export async function deletePath(path: string, isDir: boolean, parentDir: string): Promise<void> {
  const name = basename(path);
  const affectedTabs = useEditorStore.getState().tabs.filter((t) => isSameOrInside(t.path, path));
  const unsaved = affectedTabs.some((t) => t.isDirty);

  const confirmed = await showDialog({
    title: isDir
      ? `Are you sure you want to delete '${name}' and its contents?`
      : `Are you sure you want to delete '${name}'?`,
    message: unsaved
      ? "It has unsaved changes that will be lost. You can restore the file from the Trash."
      : "You can restore it from the Trash.",
    buttons: [
      { label: "Move to Trash", value: "trash", variant: "primary" },
      { label: "Cancel", value: "cancel" },
    ],
    cancelValue: "cancel",
  });
  if (confirmed !== "trash") return;

  try {
    await trashEntry(path);
  } catch (trashError) {
    const permanent = await showDialog({
      title: `Couldn't move '${name}' to the Trash. Delete it permanently?`,
      message: `This can't be undone. (${String(trashError)})`,
      buttons: [
        { label: "Delete Permanently", value: "delete", variant: "danger" },
        { label: "Cancel", value: "cancel" },
      ],
      cancelValue: "cancel",
    });
    if (permanent !== "delete") return;

    try {
      await deleteEntryPermanently(path);
    } catch (deleteError) {
      await showDialog({
        title: `Couldn't delete '${name}'`,
        message: String(deleteError),
        buttons: [{ label: "OK", value: "ok", variant: "primary" }],
        cancelValue: "ok",
      });
      return;
    }
  }

  // Closed without the save prompt: saving would recreate what was deleted.
  const closing = affectedTabs.map((t) => t.path);
  closing.forEach(disposeModel);
  useEditorStore.getState().closeTabs(closing);

  const explorer = useExplorerStore.getState();
  explorer.forgetPath(path);
  await explorer.refresh(parentDir);
}
