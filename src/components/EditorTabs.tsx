import { useCallback, useState, type MouseEvent } from "react";
import { useEditorStore } from "../state/editorStore";
import { closeTabs, pathsToClose, type TabCloseAction } from "../lib/tabActions";
import { ContextMenu, type ContextMenuEntry } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import { CloseIcon, GearIcon } from "./icons";
import { WindowControls } from "./WindowControls";

interface MenuState {
  x: number;
  y: number;
  path: string;
}

export function EditorTabs() {
  const tabs = useEditorStore((s) => s.tabs);
  const activeTabPath = useEditorStore((s) => s.activeTabPath);
  const setActiveTab = useEditorStore((s) => s.setActiveTab);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  function run(action: TabCloseAction, target: string) {
    // The right-clicked tab survives "others/left/right", so it takes focus
    // if the active tab was among the closed ones — same as VS Code.
    closeTabs(pathsToClose(tabs, target, action), target);
  }

  function handleClose(event: MouseEvent, path: string) {
    event.stopPropagation();
    run("close", path);
  }

  function handleAuxClick(event: MouseEvent, path: string) {
    if (event.button === 1) run("close", path);
  }

  function handleContextMenu(event: MouseEvent, path: string) {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, path });
  }

  function menuEntries(target: string): ContextMenuEntry[] {
    const index = tabs.findIndex((t) => t.path === target);
    return [
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
    ];
  }

  return (
    <header className="tabs">
      <div className="tabs__list">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab${tab.path === activeTabPath ? " is-active" : ""}`}
            title={
              tab.settings
                ? "Settings"
                : tab.commit
                  ? `${tab.commit.file} @ ${tab.commit.shortHash}`
                  : tab.stash
                    ? `${tab.stash.file} @ stash#${tab.stash.index}`
                    : tab.path
            }
            onClick={() => setActiveTab(tab.path)}
            onAuxClick={(e) => handleAuxClick(e, tab.path)}
            onContextMenu={(e) => handleContextMenu(e, tab.path)}
          >
            {tab.settings ? <GearIcon className="tab__gear" /> : <FileIcon name={tab.title} languageId={tab.language} />}
            <span>{tab.title}</span>
            {tab.commit && <span className="tab__hint">{tab.commit.shortHash}</span>}
            {tab.stash && <span className="tab__hint">stash#{tab.stash.index}</span>}
            {tab.showDiff && !tab.commit && !tab.stash && <span className="tab__hint">diff</span>}
            {tab.isDirty && <span className="tab__dirty">●</span>}
            <button className="tab__close" title="Close" onClick={(e) => handleClose(e, tab.path)}>
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>
      <div className="tabs__drag" data-tauri-drag-region />
      <WindowControls />

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(menu.path)} onClose={closeMenu} />}
    </header>
  );
}
