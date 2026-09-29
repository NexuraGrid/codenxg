import { useEffect, useRef, useState, type ComponentType } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelHandle } from "react-resizable-panels";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FileTree } from "./FileTree";
import { PinGroupsSection } from "./PinGroupsSection";
import { useExplorerStore } from "../state/explorerStore";
import { EditorGroups } from "./EditorGroups";
import { TerminalPanel } from "./TerminalPanel";
import { TerminalTabs } from "./TerminalTabs";
import { SourceControl } from "./SourceControl";
import { SearchPanel } from "./SearchPanel";
import { useGitStore } from "../state/gitStore";
import { useEditorStore } from "../state/editorStore";
import { usePinGroupStore } from "../state/pinGroupStore";
import { FilesIcon, FolderOpenIcon, GearIcon, GitIcon, GlobeIcon, PencilIcon, SearchIcon, TerminalIcon } from "./icons";
import { QuickOpen } from "./QuickOpen";
import { CommandPalette } from "./CommandPalette";
import { PinGroupQuickPick, usePinQuickPickHotkeys } from "./PinGroupQuickPick";
import { useHotkey } from "../lib/useHotkey";
import { useEditorGroupHotkeys } from "../lib/editorGroupHotkeys";
import { useFileWatcher } from "../lib/fileWatcher";
import { useAutoSave } from "../lib/useAutoSave";
import { connectLanguageServers } from "../lib/lsp/manager";
import { getActiveEditor } from "../lib/editorInstance";
import { prefillFromSelection } from "../lib/searchQuery";
import { openSettingsTab } from "../lib/settingsTab";
import { canToggleMarkdownPreview, toggleMarkdownPreview } from "../lib/markdownPreview";
import { cancelScheduledSave, flushWorkspaceTabsNow, restoreWorkspaceTabs, scheduleSaveWorkspaceTabs } from "../lib/tabPersistence";
import { usePaletteStore } from "../state/paletteStore";
import { useSearchStore } from "../state/searchStore";
import { registerCommands } from "../lib/commands/registry";
import { appCommands, layoutCommands, showCommandPalette, type LayoutActions } from "../lib/commands/appCommands";
import { useTerminalStore } from "../state/terminalStore";

// Ctrl+E / Ctrl+P are shell bindings too (fish: accept suggestion, history);
// leave them to the terminal while it has focus.
const outsideTerminal = (event: KeyboardEvent) =>
  !(event.target instanceof Element && event.target.closest(".xterm"));

// An <input>/<textarea> outside Monaco (whose own input is a textarea).
const inPlainTextField = (event: KeyboardEvent) =>
  event.target instanceof Element &&
  event.target.matches("input, textarea") &&
  !event.target.closest(".monaco-editor");

type SidebarView = "files" | "search" | "git" | "web";

const SIDEBAR_VIEWS: { id: SidebarView; title: string; Icon: ComponentType }[] = [
  { id: "files", title: "Files", Icon: FilesIcon },
  { id: "search", title: "Search", Icon: SearchIcon },
  { id: "git", title: "Source control", Icon: GitIcon },
  { id: "web", title: "Browser", Icon: GlobeIcon },
];

interface LayoutProps {
  workspaceRoot: string;
  onOpenFolder: () => void;
}

export function Layout({ workspaceRoot, onOpenFolder }: LayoutProps) {
  const projectName = workspaceRoot.split(/[\\/]/).filter(Boolean).pop() ?? workspaceRoot;
  const terminalPanelRef = useRef<ImperativePanelHandle>(null);
  const [sidebarView, setSidebarView] = useState<SidebarView>("files");
  const [isOutputOpen, setIsOutputOpen] = useState(true);

  // "Reveal in Explorer" from anywhere brings the file tree into view.
  useEffect(
    () =>
      useExplorerStore.subscribe((state, previous) => {
        if (state.revealed && state.revealed !== previous.revealed) setSidebarView("files");
      }),
    [],
  );

  function toggleOutput() {
    const panel = terminalPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }

  useHotkey("mod+b", toggleOutput);
  useFileWatcher(workspaceRoot);
  useAutoSave();
  // PHP, Python and Java servers start on demand and stop with the project.
  useEffect(() => connectLanguageServers(workspaceRoot), [workspaceRoot]);

  // Reopens this workspace's remembered tabs the same way a click would
  // (through addTab), then keeps them in sync as the user works and once more
  // right before the window actually closes.
  useEffect(() => {
    void restoreWorkspaceTabs(workspaceRoot);
  }, [workspaceRoot]);

  useEffect(() => {
    const unsubscribe = useEditorStore.subscribe((state, previous) => {
      if (
        state.groups !== previous.groups ||
        state.activeGroupId !== previous.activeGroupId ||
        state.groupSizes !== previous.groupSizes
      ) {
        scheduleSaveWorkspaceTabs(workspaceRoot);
      }
    });
    const unsubscribePins = usePinGroupStore.subscribe((state, previous) => {
      if (state.root === workspaceRoot && (state.groups !== previous.groups || state.activeGroupId !== previous.activeGroupId)) {
        scheduleSaveWorkspaceTabs(workspaceRoot);
      }
    });
    return () => {
      unsubscribe();
      unsubscribePins();
      // A switch away from this workspace resets the (shared) editor store,
      // which would otherwise schedule a save for this root; see
      // cancelScheduledSave's own comment for why that must not fire later.
      cancelScheduledSave();
    };
  }, [workspaceRoot]);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async () => {
        // Tauri only destroys the window once this resolves: a failed save
        // must never leave the window impossible to close.
        await flushWorkspaceTabsNow(workspaceRoot).catch(console.error);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(console.error);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [workspaceRoot]);

  const changeCount = useGitStore((s) => s.status?.changes.length ?? 0);
  const terminalSessions = useTerminalStore((s) => s.sessions);
  const activeTerminalId = useTerminalStore((s) => s.activeSessionId);
  useEffect(() => useTerminalStore.getState().ensureSession(), []);

  function newTerminal() {
    terminalPanelRef.current?.expand();
    useTerminalStore.getState().createSession();
  }
  // VS Code's shortcut. `code` rather than `key`: Shift turns ` into ~ (or
  // something else entirely on non-US layouts).
  useHotkey("mod+shift+`", newTerminal, { capture: true, matchCode: "Backquote" });

  // Ctrl+Shift+F: VS Code's project-wide search. Prefills the query from the
  // editor's current selection, like VS Code does.
  function findInFiles() {
    const editor = getActiveEditor();
    const model = editor?.getModel();
    const selection = editor?.getSelection();
    const selectedText = model && selection ? model.getValueInRange(selection) : "";
    const prefill = prefillFromSelection(selectedText);
    if (prefill) useSearchStore.getState().setQuery(prefill);
    useSearchStore.getState().requestFocus();
    setSidebarView("search");
  }
  useHotkey("mod+shift+f", findInFiles, { capture: true });

  // The Command Palette's registry: app-wide commands plus the ones that need
  // this Layout (panels, sidebar views). Read through a ref, so they always
  // call the current handlers without re-registering on every render.
  const actions: LayoutActions = {
    toggleTerminal: toggleOutput,
    newTerminal,
    showView: setSidebarView,
    findInFiles,
    openFolder: onOpenFolder,
  };
  const layoutActions = useRef(actions);
  layoutActions.current = actions;
  useEffect(() => registerCommands([...appCommands(), ...layoutCommands(() => layoutActions.current)]), []);
  // Ctrl+Shift+P / F1, from anywhere: captured ahead of Monaco (whose own
  // palette uses the same keys) and xterm (which would send ^P to the shell).
  useHotkey("mod+shift+p", () => showCommandPalette(), { capture: true });
  useHotkey("f1", () => showCommandPalette(), { capture: true });

  const openPalette = usePaletteStore((s) => s.open);
  useHotkey("mod+e", () => openPalette(""), { capture: true, when: outsideTerminal });
  useHotkey("mod+p", () => openPalette(""), { capture: true, when: outsideTerminal });
  // Captured ahead of Monaco's own Ctrl+G so both paths share one palette.
  useHotkey("mod+g", () => openPalette(":"), {
    capture: true,
    when: (event) => outsideTerminal(event) && Boolean(getActiveEditor()?.getModel()),
  });

  useHotkey("mod+,", openSettingsTab, { capture: true });
  usePinQuickPickHotkeys();
  useEditorGroupHotkeys();
  // Ctrl+Shift+V: Markdown preview. Plain Ctrl+V (paste) never matches, and
  // the terminal and text fields keep their own Ctrl+Shift+V paste.
  useHotkey("mod+shift+v", toggleMarkdownPreview, {
    capture: true,
    when: (event) => outsideTerminal(event) && !inPlainTextField(event) && canToggleMarkdownPreview(),
  });

  return (
    <main className="app" data-tauri-drag-region>
      <PanelGroup direction="horizontal" autoSaveId="code-editor-design-layout">
        <Panel defaultSize={11} minSize={8} maxSize={25}>
          <aside className="panel sidebar">
            <nav className="sidebar__toolbar" aria-label="Views" data-tauri-drag-region>
              {SIDEBAR_VIEWS.map(({ id, title, Icon }) => (
                <button
                  key={id}
                  className={`icon-btn${sidebarView === id ? " is-active" : ""}`}
                  title={title}
                  onClick={() => setSidebarView(id)}
                >
                  <Icon />
                  {id === "git" && changeCount > 0 && <span className="badge">{changeCount}</span>}
                </button>
              ))}
              <button
                className="icon-btn sidebar__open-folder"
                title={`Open Folder… (current: ${projectName})`}
                onClick={onOpenFolder}
              >
                <FolderOpenIcon />
              </button>
              <button className="icon-btn" title="Settings (Ctrl+,)" onClick={openSettingsTab}>
                <GearIcon />
              </button>
            </nav>
            {sidebarView === "files" && (
              <>
                <PinGroupsSection />
                <FileTree rootPath={workspaceRoot} />
              </>
            )}
            {sidebarView === "search" && <SearchPanel root={workspaceRoot} />}
            {sidebarView === "git" && <SourceControl root={workspaceRoot} />}
          </aside>
        </Panel>

        <PanelResizeHandle className="panel-gap" />

        <Panel defaultSize={53} minSize={30}>
          <section className="panel editor">
            <EditorGroups />
          </section>
        </Panel>

        <PanelResizeHandle className="panel-gap" />

        <Panel
          ref={terminalPanelRef}
          defaultSize={36}
          minSize={20}
          collapsible
          collapsedSize={0}
          onResize={(size) => setIsOutputOpen(size > 0)}
        >
          <section className="panel output">
            <header className="output__header" data-tauri-drag-region>
              <TerminalTabs />
              <kbd className="kbd">⌘B</kbd>
            </header>

            <div className="output__body">
              {terminalSessions.map((session) => (
                <TerminalPanel
                  key={session.id}
                  sessionId={session.id}
                  cwd={workspaceRoot}
                  isActive={session.id === activeTerminalId}
                />
              ))}
              {terminalSessions.length === 0 && (
                <button className="output__empty" onClick={newTerminal}>
                  No terminal open — click to start one
                </button>
              )}
            </div>
            <div className="output__track" aria-hidden="true" />
          </section>
        </Panel>
      </PanelGroup>

      <QuickOpen root={workspaceRoot} />
      <CommandPalette />
      <PinGroupQuickPick />

      {/* Lives outside the collapsible panel so it can reopen it. */}
      <div className="float-tools">
        <button
          className={`tool-btn${isOutputOpen ? " is-active" : ""}`}
          title={isOutputOpen ? "Hide output (Ctrl+B)" : "Show output (Ctrl+B)"}
          onClick={toggleOutput}
        >
          <TerminalIcon />
        </button>
        <button className="tool-btn" title="Edit">
          <PencilIcon />
        </button>
      </div>
    </main>
  );
}
