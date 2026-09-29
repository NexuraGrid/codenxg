import { useCallback, useState } from "react";
import { usePinGroupStore } from "../state/pinGroupStore";
import { useEditorStore } from "../state/editorStore";
import {
  deleteGroupWithConfirm,
  openFileFromGroup,
  pinnedFilePaths,
  renameGroupFromPrompt,
  savePinnedTabsAsGroup,
  switchPinGroup,
} from "../lib/pinGroupActions";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { ChevronIcon, PinIcon } from "./icons";
import { FileIcon } from "./FileIcon";
import { groupFileLabel } from "../lib/pinGroups";
import { useMissingGroupPaths } from "./useMissingGroupPaths";

/** The dropdown at the left of the tab bar: switch, save, rename and delete pin groups. */
export function PinGroupSwitcher() {
  const groups = usePinGroupStore((s) => s.groups);
  const activeGroupId = usePinGroupStore((s) => s.activeGroupId);
  // Re-render when pins change so "Save pinned tabs" enables/disables.
  const hasPinned = useEditorStore((s) => s.tabs.some((t) => t.isPinned));
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  const root = usePinGroupStore((s) => s.root);
  const missing = useMissingGroupPaths(anchor !== null);

  function open(button: HTMLElement) {
    const rect = button.getBoundingClientRect();
    setAnchor({ x: rect.left, y: rect.bottom + 2 });
  }

  const active = groups.find((g) => g.id === activeGroupId);

  const entries: ContextMenuEntry[] = [
    ...groups.flatMap((g): ContextMenuEntry[] => [
      {
        type: "item",
        label: g.name,
        detail: `${g.paths.length}`,
        checked: g.id === activeGroupId,
        onSelect: () => void switchPinGroup(g.id),
      },
      // Each file under its group: activates the group and focuses the file.
      ...g.paths.map((path): ContextMenuEntry => {
        const { name, dir } = groupFileLabel(path, root);
        const isMissing = missing.has(path);
        return {
          type: "item",
          label: isMissing ? `${name} (missing)` : name,
          detail: dir || undefined,
          icon: <FileIcon name={name} />,
          indent: true,
          onSelect: () => void openFileFromGroup(g.id, path, isMissing),
        };
      }),
    ]),
    {
      type: "item",
      label: "No Group",
      checked: !active,
      disabled: !active,
      // Leaves every tab open; the next switch just won't close any.
      onSelect: () => usePinGroupStore.getState().setActiveGroup(null),
    },
    { type: "separator" },
    {
      type: "item",
      label: "Save Pinned Tabs as Group…",
      disabled: !hasPinned || pinnedFilePaths().length === 0,
      onSelect: () => void savePinnedTabsAsGroup(),
    },
    { type: "item", label: "Rename Group…", disabled: !active, onSelect: () => active && void renameGroupFromPrompt(active.id) },
    { type: "item", label: "Delete Group…", disabled: !active, onSelect: () => active && void deleteGroupWithConfirm(active.id) },
  ];

  return (
    <>
      <button
        className={`pin-groups${active ? " is-active" : ""}`}
        title={active ? `Pin group: ${active.name}` : "Pin groups"}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        // Opens on pointerdown: the open menu closes itself on any pointerdown
        // outside it (this button included), so a click would reopen it.
        onPointerDown={(e) => {
          if (e.button === 0 && !anchor) open(e.currentTarget);
        }}
        onClick={(e) => {
          // Keyboard activation (Enter/Space) has no pointerdown.
          if (e.detail === 0) {
            if (anchor) close();
            else open(e.currentTarget);
          }
        }}
      >
        <PinIcon />
        <span className="pin-groups__name">{active ? active.name : "No group"}</span>
        <ChevronIcon open={anchor !== null} />
      </button>
      {anchor && <ContextMenu x={anchor.x} y={anchor.y} entries={entries} onClose={close} />}
    </>
  );
}
