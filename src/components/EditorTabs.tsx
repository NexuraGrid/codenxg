import { useCallback, useState, type MouseEvent } from "react";
import { MAX_EDITOR_GROUPS, useEditorStore, type EditorTab } from "../state/editorStore";
import { closeTabs, pathsToClose, type TabCloseAction } from "../lib/tabActions";
import { isMarkdownSourceTab, openMarkdownPreview } from "../lib/markdownPreview";
import { moveEditorToOtherGroup, splitEditor } from "../lib/editorGroupActions";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import { CloseIcon, GearIcon, PinIcon } from "./icons";
import { WindowControls } from "./WindowControls";
import { PinGroupSwitcher } from "./PinGroupSwitcher";
import { usePinGroupStore } from "../state/pinGroupStore";
import { useExplorerStore } from "../state/explorerStore";
import { isPersistableTab } from "../lib/persistedTabs";
import { addFileToGroup, createGroupFromPrompt, removeFileFromGroup } from "../lib/pinGroupActions";

interface MenuState {
  x: number;
  y: number;
  path: string;
}

function tabTooltip(tab: EditorTab): string {
  if (tab.settings) return "Settings";
  if (tab.markdownPreview) return `Preview of ${tab.markdownPreview.source}`;
  if (tab.commit) return `${tab.commit.file} @ ${tab.commit.shortHash}`;
  if (tab.stash) return `${tab.stash.file} @ stash#${tab.stash.index}`;
  return tab.path;
}

const NO_TABS: EditorTab[] = [];

interface EditorTabsProps {
  /** The editor group whose tabs this bar shows. */
  groupId: string;
  /** The leftmost group's bar hosts the pin group switcher. */
  showPinGroupSwitcher: boolean;
  /** The rightmost group's bar doubles as the title bar's right end. */
  showWindowControls: boolean;
}

export function EditorTabs({ groupId, showPinGroupSwitcher, showWindowControls }: EditorTabsProps) {
  const tabs = useEditorStore((s) => s.groups.find((g) => g.id === groupId)?.tabs ?? NO_TABS);
  const activeTabPath = useEditorStore((s) => s.groups.find((g) => g.id === groupId)?.activeTabPath ?? null);
  const groupCount = useEditorStore((s) => s.groups.length);
  const isFocusedGroup = useEditorStore((s) => s.activeGroupId === groupId);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const makePermanent = useEditorStore((s) => s.makePermanent);
  const setPinned = useEditorStore((s) => s.setPinned);
  const pinGroups = usePinGroupStore((s) => s.groups);
  const activeGroupId = usePinGroupStore((s) => s.activeGroupId);
  const activeGroup = pinGroups.find((g) => g.id === activeGroupId);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  function run(action: TabCloseAction, target: string) {
    // The right-clicked tab survives "others/left/right", so it takes focus
    // if the active tab was among the closed ones — same as VS Code.
    closeTabs(pathsToClose(tabs, target, action), target, groupId);
  }

  function handleClose(event: MouseEvent, path: string) {
    event.stopPropagation();
    run("close", path);
  }

  function handleUnpin(event: MouseEvent, path: string) {
    event.stopPropagation();
    setPinned(path, false, groupId);
  }

  function handleAuxClick(event: MouseEvent, path: string) {
    if (event.button === 1) run("close", path);
  }

  function handleContextMenu(event: MouseEvent, path: string) {
    event.preventDefault();
    // The menu's actions (split, move, pin groups) act on the focused group and tab.
    setActiveTab(path, groupId);
    setMenu({ x: event.clientX, y: event.clientY, path });
  }

  function groupEntries(): ContextMenuEntry[] {
    const canMove = groupCount > 1 || tabs.length > 1;
    return [
      { type: "item", label: groupCount < MAX_EDITOR_GROUPS ? "Split Right" : "Split to Other Group", onSelect: splitEditor },
      { type: "item", label: "Move to Other Group", disabled: !canMove, onSelect: moveEditorToOtherGroup },
      { type: "separator" },
    ];
  }

  function menuEntries(target: string): ContextMenuEntry[] {
    const index = tabs.findIndex((t) => t.path === target);
    const isPinned = Boolean(tabs[index]?.isPinned);
    const preview: ContextMenuEntry[] =
      tabs[index] && isMarkdownSourceTab(tabs[index])
        ? [{ type: "item", label: "Open Preview", onSelect: () => openMarkdownPreview(target) }, { type: "separator" }]
        : [];
    return [
      ...preview,
      ...groupEntries(),
      { type: "item", label: "Close", onSelect: () => run("close", target) },
      { type: "item", label: "Close Others", disabled: tabs.length < 2, onSelect: () => run("others", target) },
      { type: "item", label: "Close to the Left", disabled: index <= 0, onSelect: () => run("left", target) },
      {
        type: "item",
        label: "Close to the Right",
        disabled: index === tabs.length - 1,
        onSelect: () => run("right", target),
      },
      { type: "separator" },
      { type: "item", label: "Close All", onSelect: () => run("all", target) },
      ...(tabs[index] && isPersistableTab(tabs[index])
        ? [
            { type: "separator" } as const,
            {
              type: "item",
              label: "Reveal in Explorer",
              onSelect: () => void useExplorerStore.getState().reveal(target),
            } as const,
          ]
        : []),
      { type: "separator" },
      { type: "item", label: isPinned ? "Unpin" : "Pin", onSelect: () => setPinned(target, !isPinned, groupId) },
      ...(tabs[index] && isPersistableTab(tabs[index]) ? pinGroupEntries(target) : []),
    ];
  }

  function pinGroupEntries(target: string): ContextMenuEntry[] {
    const containing = pinGroups.filter((g) => g.paths.includes(target));
    const entries: ContextMenuEntry[] = [
      {
        type: "submenu",
        label: "Add to Pin Group",
        entries: [
          ...pinGroups.map(
            (g): ContextMenuEntry => ({
              type: "item",
              label: g.name,
              checked: g.paths.includes(target),
              disabled: g.paths.includes(target),
              onSelect: () => addFileToGroup(g.id, target),
            }),
          ),
          ...(pinGroups.length > 0 ? [{ type: "separator" } as const] : []),
          { type: "item", label: "New Group…", onSelect: () => void createGroupFromPrompt([target]) },
        ],
      },
    ];
    if (containing.length > 0) {
      const remove = removeFileFromGroup;
      entries.push(
        containing.length === 1
          ? { type: "item", label: `Remove from "${containing[0].name}"`, onSelect: () => remove(containing[0].id, target) }
          : {
              type: "submenu",
              label: "Remove from Group",
              entries: containing.map((g) => ({ type: "item", label: g.name, onSelect: () => remove(g.id, target) })),
            },
      );
    }
    return entries;
  }

  return (
    <header className={`tabs${isFocusedGroup && groupCount > 1 ? " is-focused-group" : ""}`}>
      {showPinGroupSwitcher && <PinGroupSwitcher />}
      <div className="tabs__list">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab${tab.path === activeTabPath ? " is-active" : ""}${tab.isPreview ? " is-preview" : ""}${tab.isPinned ? " is-pinned" : ""}${activeGroup?.paths.includes(tab.path) ? " in-group" : ""}`}
            title={activeGroup?.paths.includes(tab.path) ? `${tabTooltip(tab)} • ${activeGroup.name}` : tabTooltip(tab)}
            onClick={() => setActiveTab(tab.path, groupId)}
            onDoubleClick={() => makePermanent(tab.path, groupId)}
            onAuxClick={(e) => handleAuxClick(e, tab.path)}
            onContextMenu={(e) => handleContextMenu(e, tab.path)}
          >
            {tab.settings ? <GearIcon className="tab__gear" /> : <FileIcon name={tab.title} languageId={tab.language} />}
            <span className="tab__title">{tab.title}</span>
            {tab.commit && <span className="tab__hint">{tab.commit.shortHash}</span>}
            {tab.stash && <span className="tab__hint">stash#{tab.stash.index}</span>}
            {tab.showDiff && !tab.commit && !tab.stash && <span className="tab__hint">diff</span>}
            {tab.isDirty && <span className="tab__dirty">●</span>}
            {tab.isPinned ? (
              <button className="tab__close tab__pin" title="Unpin" onClick={(e) => handleUnpin(e, tab.path)}>
                <PinIcon />
              </button>
            ) : (
              <button className="tab__close" title="Close" onClick={(e) => handleClose(e, tab.path)}>
                <CloseIcon />
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="tabs__drag" data-tauri-drag-region />
      {showWindowControls && <WindowControls />}

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.path)} onClose={closeMenu} />}
    </header>
  );
}
