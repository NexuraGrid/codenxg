import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
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
import { flyoutStyle, useFlyoutPlacement } from "./useFlyoutPlacement";
import { usePinQuickPickStore } from "../state/pinQuickPickStore";
import { useMissingGroupPaths } from "./useMissingGroupPaths";
import { quickPickShortcutLabel } from "../lib/pinGroupQuickPick";

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

/** A group's files shown beside its row: on hover (after a delay) or pinned open by a click. */
type Flyout = { groupId: string; mode: "hover" | "click" };

const HOVER_OPEN_MS = 250;
const HOVER_CLOSE_MS = 150;

/** The Explorer's "Pin Groups" section: one compact row per group, its files in a flyout beside it. */
export function PinGroupsSection() {
  const groups = usePinGroupStore((s) => s.groups);
  const activeGroupId = usePinGroupStore((s) => s.activeGroupId);
  const root = usePinGroupStore((s) => s.root);
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);
  const missing = useMissingGroupPaths(groups.length > 0);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [flyout, setFlyout] = useState<Flyout | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const rows = useRef(new Map<string, HTMLDivElement>());
  const anchorRef = useRef<HTMLElement | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);

  const dirty = useMemo(() => new Set(tabs.filter((t) => t.isDirty).map((t) => t.path)), [tabs]);

  useEffect(
    () => () => {
      window.clearTimeout(openTimer.current);
      window.clearTimeout(closeTimer.current);
    },
    [],
  );

  const flyoutGroup = flyout && !collapsed ? groups.find((g) => g.id === flyout.groupId) : undefined;
  anchorRef.current = flyoutGroup ? (rows.current.get(flyoutGroup.id) ?? null) : null;

  const flyoutRef = useRef(flyout);
  flyoutRef.current = flyout;
  const closeFlyout = useCallback((refocusRow = false) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    const current = flyoutRef.current;
    if (current && refocusRow) rows.current.get(current.groupId)?.focus();
    setFlyout(null);
  }, []);

  if (groups.length === 0) return null;

  function toggleSection() {
    closeFlyout();
    setCollapsed((was) => {
      storeCollapsed(!was);
      return !was;
    });
  }

  function hoverEnter(groupId: string | null) {
    window.clearTimeout(closeTimer.current);
    if (groupId === null || flyout?.mode === "click" || flyout?.groupId === groupId) return;
    window.clearTimeout(openTimer.current);
    // Already browsing another group's files: follow the pointer right away.
    if (flyout) setFlyout({ groupId, mode: "hover" });
    else openTimer.current = window.setTimeout(() => setFlyout({ groupId, mode: "hover" }), HOVER_OPEN_MS);
  }

  function hoverLeave() {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    // A grace period to cross the gap between the row and its flyout.
    closeTimer.current = window.setTimeout(
      () => setFlyout((current) => (current?.mode === "hover" ? null : current)),
      HOVER_CLOSE_MS,
    );
  }

  function toggleClickFlyout(groupId: string) {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    setFlyout((current) => (current?.groupId === groupId && current.mode === "click" ? null : { groupId, mode: "click" }));
  }

  function onRowKeyDown(event: KeyboardEvent, groupId: string) {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
      event.preventDefault();
      setFlyout({ groupId, mode: "click" });
    }
  }

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
        label: "Show Files…",
        shortcut: groups.indexOf(group) < 9 ? quickPickShortcutLabel(undefined, String(groups.indexOf(group) + 1)) : undefined,
        onSelect: () => usePinQuickPickStore.getState().open(group.id),
      },
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
            const isOpen = flyoutGroup?.id === group.id;
            return (
              <li key={group.id}>
                <div
                  ref={(el) => {
                    if (el) rows.current.set(group.id, el);
                    else rows.current.delete(group.id);
                  }}
                  className={`pin-section__row pin-section__group${isActive ? " is-active" : ""}${isOpen ? " is-open" : ""}`}
                  title={isActive ? `${group.name} (active group) • double-click to open` : `${group.name} • double-click to open`}
                  role="button"
                  tabIndex={0}
                  aria-haspopup="listbox"
                  aria-expanded={isOpen}
                  onPointerEnter={() => hoverEnter(group.id)}
                  onPointerLeave={hoverLeave}
                  onClick={() => toggleClickFlyout(group.id)}
                  onDoubleClick={() => {
                    closeFlyout();
                    void switchPinGroup(group.id);
                  }}
                  onKeyDown={(e) => onRowKeyDown(e, group.id)}
                  onContextMenu={(e) => openMenu(e, { group })}
                >
                  <PinIcon />
                  <span className="pin-section__name">{group.name}</span>
                  <span className="pin-section__actions">
                    {!isActive && (
                      <button
                        className="icon-btn"
                        title="Open Group"
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          void switchPinGroup(group.id);
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <PinIcon />
                      </button>
                    )}
                  </span>
                  <span className="pin-section__count">{group.paths.length}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {flyout && flyoutGroup && (
        <GroupFlyout
          key={flyoutGroup.id}
          group={flyoutGroup}
          mode={flyout.mode}
          anchorRef={anchorRef}
          root={root}
          isActive={flyoutGroup.id === activeGroupId}
          activeTabPath={activeTabPath}
          missing={missing}
          dirty={dirty}
          onPointerEnter={() => hoverEnter(null)}
          onPointerLeave={() => flyout.mode === "hover" && hoverLeave()}
          onClose={closeFlyout}
          onFileMenu={(e, path) => openMenu(e, { group: flyoutGroup, path })}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.target)} onClose={closeMenu} />}
    </section>
  );
}

interface GroupFlyoutProps {
  group: PinGroup;
  mode: Flyout["mode"];
  anchorRef: RefObject<HTMLElement | null>;
  root: string | null;
  isActive: boolean;
  activeTabPath: string | null;
  missing: ReadonlySet<string>;
  dirty: ReadonlySet<string>;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onClose: (refocusRow?: boolean) => void;
  onFileMenu: (event: MouseEvent, path: string) => void;
}

/**
 * A group's files beside its row, over the editor. Opened by a click it takes
 * focus (arrows, Enter, Escape) and stays until a click elsewhere or Escape.
 */
function GroupFlyout({
  group,
  mode,
  anchorRef,
  root,
  isActive,
  activeTabPath,
  missing,
  dirty,
  onPointerEnter,
  onPointerLeave,
  onClose,
  onFileMenu,
}: GroupFlyoutProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const placement = useFlyoutPlacement(anchorRef, panelRef, true, group.paths.length);
  const [selected, setSelected] = useState(() => {
    const focused = isActive && activeTabPath ? group.paths.indexOf(activeTabPath) : -1;
    return Math.max(0, focused);
  });
  const current = Math.min(selected, Math.max(0, group.paths.length - 1));

  useEffect(() => {
    if (mode === "click") panelRef.current?.focus({ preventScroll: true });
  }, [mode]);

  useEffect(() => {
    if (mode === "click") listRef.current?.children[current]?.scrollIntoView({ block: "nearest" });
  }, [mode, current]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      if (mode !== "click") return;
      const target = event.target as Element;
      // Its own row toggles it; a context menu opened from it keeps it.
      if (panelRef.current?.contains(target) || anchorRef.current?.contains(target) || target.closest?.(".context-menu")) return;
      onClose();
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !document.querySelector(".context-menu")) onClose(mode === "click");
    }
    window.addEventListener("pointerdown", onPointerDown, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    function onBlur() {
      if (mode === "hover") onClose();
    }
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, [mode, anchorRef, onClose]);

  function open(path: string) {
    onClose();
    void openFileFromGroup(group.id, path, missing.has(path));
  }

  function onKeyDown(event: KeyboardEvent) {
    const count = group.paths.length;
    if (event.key === "ArrowDown" && count) setSelected((current + 1) % count);
    else if (event.key === "ArrowUp" && count) setSelected((current - 1 + count) % count);
    else if (event.key === "Home" && count) setSelected(0);
    else if (event.key === "End" && count) setSelected(count - 1);
    else if (event.key === "Enter" && group.paths[current]) open(group.paths[current]);
    else if (event.key === "Escape" || event.key === "ArrowLeft") onClose(true);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return createPortal(
    <div
      ref={panelRef}
      className="pin-flyout"
      role="listbox"
      aria-label={`Files in ${group.name}`}
      aria-activedescendant={mode === "click" && group.paths[current] ? `pin-flyout-${current}` : undefined}
      tabIndex={-1}
      style={flyoutStyle(placement)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <div className="pin-flyout__title" title={group.name}>
        {group.name}
      </div>
      <ul ref={listRef} className="pin-section__files">
        {group.paths.length === 0 && <li className="pin-section__empty">No files yet</li>}
        {group.paths.map((path, i) => {
          const { name, dir } = groupFileLabel(path, root);
          const isMissing = missing.has(path);
          const isFocused = isActive && path === activeTabPath;
          const isSelected = mode === "click" && i === current;
          return (
            <li
              key={path}
              id={`pin-flyout-${i}`}
              role="option"
              aria-selected={isSelected}
              className={`pin-section__row pin-section__file${isMissing ? " is-missing" : ""}${isFocused ? " is-focused" : ""}${isSelected ? " is-selected" : ""}`}
              title={isMissing ? `${path} (missing)` : path}
              onClick={() => open(path)}
              onContextMenu={(e) => onFileMenu(e, path)}
            >
              <FileIcon name={name} />
              <span className="pin-section__name">{name}</span>
              {dir && <span className="pin-section__dir">{dir}</span>}
              {dirty.has(path) && <span className="pin-section__dirty" title="Unsaved changes">●</span>}
              <span className="pin-section__actions">
                <button
                  className="icon-btn"
                  title="Remove from Group"
                  tabIndex={-1}
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
    </div>,
    document.body,
  );
}
