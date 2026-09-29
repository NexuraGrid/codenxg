import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { usePinGroupStore } from "../state/pinGroupStore";
import { useEditorStore } from "../state/editorStore";
import { dropTargetIndex, groupFileLabel, type PinGroup } from "../lib/pinGroups";
import { useExplorerStore } from "../state/explorerStore";
import { isSameOrInside } from "../lib/paths";
import {
  activeFilePath,
  addActiveFileToGroup,
  clearGroupWithConfirm,
  deleteGroupWithConfirm,
  openFileFromGroup,
  removeFileFromGroup,
  removeFilesFromGroupWithConfirm,
  renameGroupFromPrompt,
  switchPinGroup,
} from "../lib/pinGroupActions";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import { CheckIcon, ChevronIcon, CloseIcon, MinusIcon, PinIcon, TrashIcon } from "./icons";
import { flyoutStyle, useFlyoutPlacement } from "./useFlyoutPlacement";
import { usePinQuickPickStore } from "../state/pinQuickPickStore";
import { useMissingGroupPaths } from "./useMissingGroupPaths";
import { quickPickShortcutLabel } from "../lib/pinGroupQuickPick";
import { checkedItems, emptySelection, selectAll, selectItem, toggleAll, type ListSelection, type SelectGesture } from "../lib/listSelection";

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

  /** Keeps a hover-opened flyout from closing under the pointer once it's being worked with. */
  function pinFlyout() {
    window.clearTimeout(closeTimer.current);
    setFlyout((current) => (current && current.mode === "hover" ? { ...current, mode: "click" } : current));
  }

  function onRowKeyDown(event: KeyboardEvent, groupId: string) {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowRight") {
      event.preventDefault();
      setFlyout({ groupId, mode: "click" });
    } else if (event.key === "Delete") {
      event.preventDefault();
      void deleteGroupWithConfirm(groupId);
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
        {
          type: "item",
          label: "Reveal in Explorer",
          disabled: missing.has(path) || !root || path === root || !isSameOrInside(path, root),
          onSelect: () => {
            closeFlyout();
            void useExplorerStore.getState().reveal(path);
          },
        },
        { type: "separator" },
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
                    <button
                      className="icon-btn"
                      title="Delete Group…"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteGroupWithConfirm(group.id);
                      }}
                      onDoubleClick={(e) => e.stopPropagation()}
                    >
                      <TrashIcon />
                    </button>
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
          onPin={pinFlyout}
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
  /** Turns a hover-opened flyout into a sticky one. */
  onPin: () => void;
  onFileMenu: (event: MouseEvent, path: string) => void;
}

/**
 * A group's files beside its row, over the editor. Opened by a click it takes
 * focus (arrows, Enter, Escape) and stays until a click elsewhere or Escape.
 *
 * Files can be checked for removal from the group: checkbox or Ctrl/Cmd+click
 * toggles, Shift+click checks a range, Space / Ctrl+A / Delete from the
 * keyboard. Checking anything makes a hover-opened flyout sticky. Removing
 * files (or the group) never closes or unpins their tabs; each removal can be
 * undone from its toast. Files reorder by dragging, or Alt+Up/Down.
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
  onPin,
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
  const [selection, setSelection] = useState<ListSelection>(emptySelection);
  const checked = checkedItems(group.paths, selection);
  const selecting = checked.length > 0;
  const allChecked = selecting && checked.length === group.paths.length;
  const { drag, beginDrag, isClickSuppressed } = useFlyoutReorder(listRef, group, onPin, setSelected);

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
      // Its own row toggles it; a context menu or confirmation opened from it keeps it.
      if (
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target) ||
        target.closest?.(".context-menu, .dialog-backdrop")
      )
        return;
      onClose();
    }
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape" && !document.querySelector(".context-menu, .dialog-backdrop")) onClose(mode === "click");
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

  function pick(index: number, gesture: SelectGesture) {
    const path = group.paths[index];
    if (path === undefined) return;
    onPin();
    setSelected(index);
    setSelection((s) => selectItem(group.paths, s, path, gesture));
  }

  function onRowClick(event: MouseEvent, index: number) {
    if (isClickSuppressed()) return;
    if (event.shiftKey) pick(index, "range");
    else if (event.ctrlKey || event.metaKey || selecting) pick(index, "toggle");
    else open(group.paths[index]);
  }

  function refocus() {
    panelRef.current?.focus({ preventScroll: true });
  }

  /** One file goes at once; several (or clearing the group) ask first. Tabs are never touched. */
  async function remove(paths: string[]) {
    onPin();
    if (await removeFilesFromGroupWithConfirm(group.id, paths)) setSelection(emptySelection);
    refocus();
  }

  async function clearAll() {
    onPin();
    if (await clearGroupWithConfirm(group.id)) setSelection(emptySelection);
    refocus();
  }

  async function deleteGroup() {
    onPin();
    // Once deleted, the group (and with it this flyout) is gone.
    if (!(await deleteGroupWithConfirm(group.id))) refocus();
  }

  /** Alt+Up/Down: the keyboard's drag-to-reorder, moving the focused file one slot. */
  function moveFocused(delta: number) {
    const path = group.paths[current];
    const to = current + delta;
    if (path === undefined || to < 0 || to >= group.paths.length) return;
    onPin();
    usePinGroupStore.getState().moveFile(group.id, path, to);
    setSelected(to);
  }

  function onKeyDown(event: KeyboardEvent) {
    const count = group.paths.length;
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) moveFocused(event.key === "ArrowUp" ? -1 : 1);
    else if (event.key === " " && count) pick(current, "toggle");
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a" && count) setSelection((s) => selectAll(group.paths, s));
    else if (event.key === "Delete" && count) void remove(selecting ? checked : [group.paths[current]]);
    else if (event.key === "ArrowDown" && count) setSelected((current + 1) % count);
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
      className={`pin-flyout${selecting ? " is-selecting" : ""}`}
      role="listbox"
      aria-multiselectable
      aria-label={`Files in ${group.name}`}
      aria-activedescendant={mode === "click" && group.paths[current] ? `pin-flyout-${current}` : undefined}
      tabIndex={-1}
      style={flyoutStyle(placement)}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    >
      <div className="pin-flyout__header">
        {group.paths.length > 0 && (
          <span
            className={`pin-check${selecting ? " is-checked" : ""}`}
            role="checkbox"
            aria-checked={allChecked ? true : selecting ? "mixed" : false}
            aria-label="Select all"
            title={allChecked ? "Deselect all" : "Select all (Ctrl+A)"}
            onClick={() => {
              onPin();
              setSelection((s) => toggleAll(group.paths, s));
            }}
          >
            {allChecked ? <CheckIcon /> : selecting ? <MinusIcon /> : null}
          </span>
        )}
        <span className="pin-flyout__title" title={group.name}>
          {group.name}
        </span>
        {selecting ? (
          <button className="pin-flyout__action" title="Remove the selected files from the group (Delete)" onClick={() => void remove(checked)}>
            Remove ({checked.length})
          </button>
        ) : (
          group.paths.length > 0 && (
            <button className="pin-flyout__action" title="Remove all files from the group" onClick={() => void clearAll()}>
              Remove All
            </button>
          )
        )}
        <button className="icon-btn" title="Delete Group…" onClick={() => void deleteGroup()}>
          <TrashIcon />
        </button>
      </div>
      <ul ref={listRef} className="pin-section__files">
        {group.paths.length === 0 && <li className="pin-section__empty">No files yet</li>}
        {group.paths.map((path, i) => {
          const { name, dir } = groupFileLabel(path, root);
          const isMissing = missing.has(path);
          const isFocused = isActive && path === activeTabPath;
          const isSelected = mode === "click" && i === current;
          const isChecked = selection.checked.has(path);
          const isDragged = drag?.from === i;
          const dropMark = drag && drag.insertBefore === i ? " is-drop-before" : drag && i === group.paths.length - 1 && drag.insertBefore === group.paths.length ? " is-drop-after" : "";
          return (
            <li
              key={path}
              id={`pin-flyout-${i}`}
              role="option"
              aria-selected={isChecked}
              className={`pin-section__row pin-section__file${isMissing ? " is-missing" : ""}${isFocused ? " is-focused" : ""}${isSelected ? " is-selected" : ""}${isChecked ? " is-checked" : ""}${isDragged ? " is-drag-source" : ""}${dropMark}`}
              title={isMissing ? `${path} (missing)` : path}
              onPointerDown={(e) => beginDrag(e, i)}
              onClick={(e) => onRowClick(e, i)}
              onContextMenu={(e) => onFileMenu(e, path)}
            >
              <span
                className={`pin-check${isChecked ? " is-checked" : ""}`}
                role="checkbox"
                aria-checked={isChecked}
                aria-label={`Select ${name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  pick(i, e.shiftKey ? "range" : "toggle");
                }}
              >
                {isChecked && <CheckIcon />}
              </span>
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

/** Pointer travel before a press on a file becomes a drag (a click otherwise). */
const DRAG_THRESHOLD_PX = 4;

interface FlyoutDrag {
  from: number;
  /** The gap the file would drop into: before this row, or `length` for the end. */
  insertBefore: number;
}

/**
 * Drag-to-reorder for a flyout's files, pointer-based like the file tree's:
 * a press past the threshold picks the file up, the gap nearest the pointer
 * shows where it lands, and releasing moves it there (in the group's order,
 * which is its tabs' order). The click that ends a drag doesn't open the file.
 */
function useFlyoutReorder(
  listRef: RefObject<HTMLUListElement | null>,
  group: PinGroup,
  onPin: () => void,
  onMoved: (index: number) => void,
) {
  const [drag, setDrag] = useState<FlyoutDrag | null>(null);
  const suppressClick = useRef(false);
  const stopRef = useRef<(() => void) | null>(null);
  const latest = useRef({ group, onPin, onMoved });
  latest.current = { group, onPin, onMoved };

  useEffect(() => () => stopRef.current?.(), []);

  function insertionAt(clientY: number): number {
    const rows = Array.from(listRef.current?.children ?? []);
    const index = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return index < 0 ? rows.length : index;
  }

  function beginDrag(event: ReactPointerEvent, from: number) {
    const target = event.target as Element;
    if (event.button !== 0 || target.closest("button, .pin-check") || latest.current.group.paths.length < 2) return;
    const startY = event.clientY;
    let current: FlyoutDrag | null = null;

    function onMove(e: PointerEvent) {
      if (!current && Math.abs(e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      if (!current) latest.current.onPin();
      current = { from, insertBefore: insertionAt(e.clientY) };
      setDrag(current);
    }
    function onUp() {
      stop();
      if (!current) return;
      suppressClick.current = true;
      // The click (if any) fires right after pointerup; nothing after it should be eaten.
      window.setTimeout(() => (suppressClick.current = false), 0);
      const { group: g, onMoved: moved } = latest.current;
      const path = g.paths[current.from];
      const to = dropTargetIndex(current.from, current.insertBefore);
      if (path !== undefined && to !== current.from) {
        usePinGroupStore.getState().moveFile(g.id, path, to);
        moved(to);
      }
    }
    function stop() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", stop);
      stopRef.current = null;
      setDrag(null);
    }
    stopRef.current?.();
    stopRef.current = stop;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", stop);
  }

  return { drag, beginDrag, isClickSuppressed: () => suppressClick.current };
}
