import { useEditorStore } from "../state/editorStore";
import { usePinGroupStore } from "../state/pinGroupStore";
import { promptText, showDialog } from "../state/dialogStore";
import { basename } from "./paths";
import { languageFromPath } from "./language";
import { closeTabs } from "./tabActions";
import { planGroupSwitch, type PinGroup } from "./pinGroups";
import { existingPaths } from "./tabPersistence";
import { showToast } from "../state/toastStore";
import { isPersistableTab } from "./persistedTabs";

/** Checks which of `paths` still exist; injectable for tests. */
export type ExistenceCheck = (paths: string[]) => Promise<Set<string>>;

/** Adds `path` to a group and pins its tab. */
export function addFileToGroup(groupId: string, path: string): void {
  usePinGroupStore.getState().addFile(groupId, path);
  useEditorStore.getState().setPinned(path, true);
}

/** Asks for a name, then creates a group with `paths` (their tabs get pinned). */
export async function createGroupFromPrompt(paths: string[], title = "New Pin Group"): Promise<PinGroup | null> {
  const name = await promptText({ title, placeholder: "Group name", confirmLabel: "Create" });
  if (!name) return null;
  const group = usePinGroupStore.getState().createGroup(name, paths);
  if (!group) return null;
  for (const path of paths) useEditorStore.getState().setPinned(path, true);
  return group;
}

/** "Save pinned tabs as group…": every pinned file tab, in tab order. */
export function pinnedFilePaths(): string[] {
  return useEditorStore
    .getState()
    .tabs.filter((t) => t.isPinned && !t.commit && !t.stash && !t.settings && !t.markdownPreview)
    .map((t) => t.path);
}

export async function savePinnedTabsAsGroup(): Promise<void> {
  const group = await createGroupFromPrompt(pinnedFilePaths(), "Save Pinned Tabs as Group");
  if (group) usePinGroupStore.getState().setActiveGroup(group.id);
}

/**
 * Makes `groupId` the active group: its files open as pinned tabs (missing
 * ones are skipped) and the first is activated; the previous group's tabs
 * that aren't in it close, unless they have unsaved changes.
 */
export async function switchPinGroup(groupId: string, exists: ExistenceCheck = existingPaths): Promise<void> {
  const pins = usePinGroupStore.getState();
  const next = pins.groups.find((g) => g.id === groupId);
  if (!next) return;
  const previous = pins.groups.find((g) => g.id === pins.activeGroupId);

  const plan = planGroupSwitch(useEditorStore.getState().tabs, previous, next);
  const present = await exists(plan.open);
  const opening = plan.open.filter((path) => present.has(path));

  await closeTabs(plan.close, opening[0]);

  const store = useEditorStore.getState();
  for (const path of opening) {
    if (store.tabs.some((t) => t.path === path)) {
      useEditorStore.getState().setPinned(path, true);
    } else {
      useEditorStore.getState().addTab({ path, title: basename(path), isDirty: false, language: languageFromPath(path), isPinned: true });
    }
  }
  if (opening[0]) useEditorStore.getState().setActiveTab(opening[0]);
  usePinGroupStore.getState().setActiveGroup(groupId);
}

export async function renameGroupFromPrompt(groupId: string): Promise<void> {
  const group = usePinGroupStore.getState().groups.find((g) => g.id === groupId);
  if (!group) return;
  const name = await promptText({ title: "Rename Pin Group", initialValue: group.name, confirmLabel: "Rename" });
  if (name === null || name === group.name) return;
  if (!usePinGroupStore.getState().renameGroup(groupId, name)) {
    await showDialog({
      title: name ? `A group named "${name}" already exists` : "A group needs a name",
      buttons: [{ label: "OK", value: "ok", variant: "primary" }],
      cancelValue: "ok",
    });
  }
}

/**
 * Shows `message` with an Undo that puts the group back exactly as it was
 * just before the change (see the store's restoreGroup). Call before changing it.
 */
function offerUndo(groupId: string, message: string): void {
  const { root, groups, activeGroupId } = usePinGroupStore.getState();
  const index = groups.findIndex((g) => g.id === groupId);
  if (index < 0) return;
  const snapshot = groups[index];
  const wasActive = activeGroupId === groupId;
  showToast(message, {
    action: {
      label: "Undo",
      run: () => {
        // A toast can outlive its workspace; never restore into another one.
        if (usePinGroupStore.getState().root !== root) return;
        usePinGroupStore.getState().restoreGroup(snapshot, index, wasActive);
      },
    },
  });
}

function fileCount(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

async function confirmDanger(title: string, message: string, label: string): Promise<boolean> {
  const choice = await showDialog({
    title,
    message,
    buttons: [
      { label, value: "confirm", variant: "danger" },
      { label: "Cancel", value: "cancel" },
    ],
    cancelValue: "cancel",
  });
  return choice === "confirm";
}

/**
 * Deletes a group after confirming; its files and open tabs are left alone.
 * If it was the active group, no group is active afterwards.
 */
export async function deleteGroupWithConfirm(groupId: string): Promise<boolean> {
  const group = usePinGroupStore.getState().groups.find((g) => g.id === groupId);
  if (!group) return false;
  const confirmed = await confirmDanger(
    `Delete the pin group "${group.name}" (${fileCount(group.paths.length)})?`,
    "Its files and open tabs are not affected.",
    "Delete",
  );
  if (confirmed) {
    offerUndo(groupId, `Deleted group "${group.name}"`);
    usePinGroupStore.getState().deleteGroup(groupId);
  }
  return confirmed;
}

/**
 * Takes `paths` out of a group — one at once, several after confirming. Open
 * tabs stay open and keep their pin state. True when something was removed.
 */
export async function removeFilesFromGroupWithConfirm(groupId: string, paths: string[]): Promise<boolean> {
  const group = usePinGroupStore.getState().groups.find((g) => g.id === groupId);
  const removing = group ? paths.filter((p) => group.paths.includes(p)) : [];
  if (!group || removing.length === 0) return false;
  if (removing.length > 1) {
    const confirmed = await confirmDanger(
      `Remove ${fileCount(removing.length)} from "${group.name}"?`,
      "The files and their open tabs are not affected.",
      "Remove",
    );
    if (!confirmed) return false;
  }
  offerUndo(
    groupId,
    removing.length === 1
      ? `Removed ${basename(removing[0])} from "${group.name}"`
      : `Removed ${fileCount(removing.length)} from "${group.name}"`,
  );
  usePinGroupStore.getState().removeFilesFromGroup(groupId, removing);
  return true;
}

/** Empties a group after confirming; the group itself and open tabs stay. */
export async function clearGroupWithConfirm(groupId: string): Promise<boolean> {
  const group = usePinGroupStore.getState().groups.find((g) => g.id === groupId);
  if (!group || group.paths.length === 0) return false;
  const confirmed = await confirmDanger(
    `Remove all ${fileCount(group.paths.length)} from "${group.name}"?`,
    "The group is kept, empty. The files and their open tabs are not affected.",
    "Remove All",
  );
  if (confirmed) {
    offerUndo(groupId, `Removed all ${fileCount(group.paths.length)} from "${group.name}"`);
    usePinGroupStore.getState().clearGroup(groupId);
  }
  return confirmed;
}

/** What happened when a group's file was clicked. */
export type GroupFileOpenResult = "opened" | "missing" | "unknown";

/**
 * Opens one of a group's files: activates the group first when it isn't the
 * active one (see switchPinGroup), then focuses the file's tab, reopening it
 * pinned if it was closed. A file that no longer exists changes nothing.
 */
export async function openGroupFile(
  groupId: string,
  path: string,
  exists: ExistenceCheck = existingPaths,
): Promise<GroupFileOpenResult> {
  const group = usePinGroupStore.getState().groups.find((g) => g.id === groupId);
  if (!group || !group.paths.includes(path)) return "unknown";
  if (!(await exists([path])).has(path)) return "missing";

  if (usePinGroupStore.getState().activeGroupId !== groupId) await switchPinGroup(groupId, exists);

  const editor = useEditorStore.getState();
  if (editor.tabs.some((t) => t.path === path)) {
    editor.setActiveTab(path);
  } else {
    editor.addTab({ path, title: basename(path), isDirty: false, language: languageFromPath(path), isPinned: true });
  }
  return "opened";
}

/** Takes `path` out of a group (with an Undo); its tab (if open) is left as it is. */
export function removeFileFromGroup(groupId: string, path: string): void {
  const group = usePinGroupStore.getState().groups.find((g) => g.id === groupId);
  if (!group?.paths.includes(path)) return;
  offerUndo(groupId, `Removed ${basename(path)} from "${group.name}"`);
  usePinGroupStore.getState().removeFile(groupId, path);
}

/** The active tab's file, when it's a real file that can join a group. */
export function activeFilePath(): string | null {
  const { tabs, activeTabPath } = useEditorStore.getState();
  const tab = tabs.find((t) => t.path === activeTabPath);
  return tab && isPersistableTab(tab) ? tab.path : null;
}

/** Adds the active tab's file to a group (and pins it); false when there's none. */
export function addActiveFileToGroup(groupId: string): boolean {
  const path = activeFilePath();
  if (!path || !usePinGroupStore.getState().groups.some((g) => g.id === groupId)) return false;
  addFileToGroup(groupId, path);
  return true;
}

/** Offers to drop a group entry whose file no longer exists. */
export async function offerRemoveMissingFile(groupId: string, path: string): Promise<void> {
  const choice = await showDialog({
    title: `"${basename(path)}" no longer exists`,
    message: "Remove it from the pin group?",
    buttons: [
      { label: "Remove", value: "remove", variant: "danger" },
      { label: "Cancel", value: "cancel" },
    ],
    cancelValue: "cancel",
  });
  if (choice === "remove") removeFileFromGroup(groupId, path);
}

/**
 * A click on a group's file (sidebar or switcher): activate its group and
 * focus it — or, when it's gone (`knownMissing`, or found missing now),
 * only offer to drop it from the group.
 */
export async function openFileFromGroup(
  groupId: string,
  path: string,
  knownMissing = false,
  exists: ExistenceCheck = existingPaths,
): Promise<GroupFileOpenResult> {
  const result = knownMissing ? "missing" : await openGroupFile(groupId, path, exists);
  if (result === "missing") await offerRemoveMissingFile(groupId, path);
  return result;
}
