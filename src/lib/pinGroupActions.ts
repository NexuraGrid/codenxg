import { useEditorStore } from "../state/editorStore";
import { usePinGroupStore } from "../state/pinGroupStore";
import { promptText, showDialog } from "../state/dialogStore";
import { basename } from "./paths";
import { languageFromPath } from "./language";
import { closeTabs } from "./tabActions";
import { planGroupSwitch, type PinGroup } from "./pinGroups";
import { existingPaths } from "./tabPersistence";

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

/** Deletes a group after confirming; its files and tabs are left alone. */
export async function deleteGroupWithConfirm(groupId: string): Promise<void> {
  const group = usePinGroupStore.getState().groups.find((g) => g.id === groupId);
  if (!group) return;
  const choice = await showDialog({
    title: `Delete the pin group "${group.name}"?`,
    message: "Its files and open tabs are not affected.",
    buttons: [
      { label: "Delete", value: "delete", variant: "danger" },
      { label: "Cancel", value: "cancel" },
    ],
    cancelValue: "cancel",
  });
  if (choice === "delete") usePinGroupStore.getState().deleteGroup(groupId);
}
