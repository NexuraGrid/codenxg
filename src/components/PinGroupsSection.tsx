import { useCallback, useMemo, useState, type MouseEvent } from "react";
import { usePinGroupStore } from "../state/pinGroupStore";
import { useEditorStore } from "../state/editorStore";
import { groupFileLabel, type PinGroup } from "../lib/pinGroups";
import {
  activeFilePath,
  addActiveFileToGroup,
  deleteGroupWithConfirm,
  openFileFromGroup,
  removeFileFromGroup,
  renameGroupFromPrompt,
  switchPinGroup,
} from "../lib/pinGroupActions";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import { ChevronIcon, CloseIcon, PinIcon } from "./icons";
import { useMissingGroupPaths } from "./useMissingGroupPaths";

const COLLAPSED_KEY = "code-editor:pin-groups-collapsed";

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function storeCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Still toggles for this session; it just won't be remembered.
  }
}

type MenuTarget = { group: PinGroup; path?: string };

/** The Explorer's "Pin Groups" section: every group and its files, above the file tree. */
export function PinGroupsSection() {
  const groups = usePinGroupStore((s) => s.groups);
  const activeGroupId = usePinGroupStore((s) => s.activeGroupId);
  const root = usePinGroupStore((s) => s.root);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);
  const missing = useMissingGroupPaths(groups.length > 0);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  // Groups the user expanded/collapsed by hand; otherwise only the active one is open.
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const dirty = useMemo(() => new Set(tabs.filter((t) => t.isDirty).map((t) => t.path)), [tabs]);

  if (groups.length === 0) return null;

  function toggleSection() {
    setCollapsed((was) => {
      storeCollapsed(!was);
      return !was;
    });
  }

  const isExpanded = (group: PinGroup) => expanded[group.id] ?? group.id === activeGroupId;

  function openMenu(event: MouseEvent, target: MenuTarget) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, target });
  }

  function menuEntries({ group, path }: MenuTarget): ContextMenuEntry[] {
    if (path) {
      return [
        {
          type: "item",
          label: "Open",
          disabled: missing.has(path),
          onSelect: () => void openFileFromGroup(group.id, path, false),
        },
        { type: "item", label: "Remove from Group", onSelect: () => removeFileFromGroup(group.id, path) },
      ];
    }
    const active = activeFilePath();
    return [
      { type: "item", label: "Open Group", onSelect: () => void switchPinGroup(group.id) },
      {
        type: "item",
        label: "Add Active File to Group",
        disabled: !active || group.paths.includes(active),
        onSelect: () => addActiveFileToGroup(group.id),
      },
      { type: "separator" },
      { type: "item", label: "Rename…", onSelect: () => void renameGroupFromPrompt(group.id) },
      { type: "item", label: "Delete…", onSelect: () => void deleteGroupWithConfirm(group.id) },
    ];
  }

  return (
    <section className={`pin-section${collapsed ? " is-collapsed" : ""}`}>
      <header className="pin-section__header" onClick={toggleSection} aria-expanded={!collapsed}>
        <ChevronIcon open={!collapsed} />
        <span>Pin Groups</span>
      </header>
      {!collapsed && (
        <ul className="pin-section__groups">
          {groups.map((group) => {
            const isActive = group.id === activeGroupId;
            const open = isExpanded(group);
            return (
              <li key={group.id}>
                <div
                  className={`pin-section__row pin-section__group${isActive ? " is-active" : ""}`}
                  title={isActive ? `${group.name} (active group)` : group.name}
                  onClick={() => setExpanded((e) => ({ ...e, [group.id]: !open }))}
                  onContextMenu={(e) => openMenu(e, { group })}
                >
                  <ChevronIcon open={open} />
                  <PinIcon />
                  <span className="pin-section__name">{group.name}</span>
                  <span className="pin-section__actions">
                    {!isActive && (
                      <button
                        className="icon-btn"
                        title="Open Group"
                        onClick={(e) => {
                          e.stopPropagation();
                          void switchPinGroup(group.id);
                        }}
                      >
                        <PinIcon />
                      </button>
                    )}
                  </span>
                  <span className="pin-section__count">{group.paths.length}</span>
                </div>
                {open && (
                  <ul className="pin-section__files">
                    {group.paths.length === 0 && <li className="pin-section__empty">No files yet</li>}
                    {group.paths.map((path) => {
                      const { name, dir } = groupFileLabel(path, root);
                      const isMissing = missing.has(path);
                      const isFocused = isActive && path === activeTabPath;
                      return (
                        <li
                          key={path}
                          className={`pin-section__row pin-section__file${isMissing ? " is-missing" : ""}${isFocused ? " is-focused" : ""}`}
                          title={isMissing ? `${path} (missing)` : path}
                          onClick={() => void openFileFromGroup(group.id, path, isMissing)}
                          onContextMenu={(e) => openMenu(e, { group, path })}
                        >
                          <FileIcon name={name} />
                          <span className="pin-section__name">{name}</span>
                          {dir && <span className="pin-section__dir">{dir}</span>}
                          {dirty.has(path) && <span className="pin-section__dirty" title="Unsaved changes">●</span>}
                          <span className="pin-section__actions">
                            <button
                              className="icon-btn"
                              title="Remove from Group"
                              onClick={(e) => {
                                e.stopPropagation();
                                removeFileFromGroup(group.id, path);
                              }}
                            >
                              <CloseIcon />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.target)} onClose={closeMenu} />}
    </section>
  );
}
