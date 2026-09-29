import type * as monacoTypes from "monaco-editor";
import type { Command } from "./registry";
import { useEditorStore, type EditorTab } from "../../state/editorStore";
import { usePaletteStore } from "../../state/paletteStore";
import { usePinQuickPickStore } from "../../state/pinQuickPickStore";
import { usePinGroupStore } from "../../state/pinGroupStore";
import { useExplorerStore } from "../../state/explorerStore";
import { useGitStore } from "../../state/gitStore";
import { getActiveEditor } from "../editorInstance";
import { saveActiveTab } from "../fileSave";
import { closeTabs, pathsToClose, type TabCloseAction } from "../tabActions";
import { openSettingsTab } from "../settingsTab";
import {
  canToggleMarkdownPreview,
  isMarkdownSourceTab,
  openMarkdownPreview,
  toggleMarkdownPreview,
} from "../markdownPreview";
import {
  activeFilePath,
  addActiveFileToGroup,
  createGroupFromPrompt,
  savePinnedTabsAsGroup,
} from "../pinGroupActions";
import { nthGroupId } from "../pinGroupQuickPick";
import { checkForUpdates } from "../updater";

export const SHOW_COMMANDS_ID = "workbench.action.showCommands";
export const SAVE_COMMAND_ID = "workbench.action.files.save";

/** Ctrl+Shift+P / F1. One modal at a time, like the other pickers. */
export function showCommandPalette(initialQuery = ""): void {
  usePinQuickPickStore.getState().close();
  usePaletteStore.getState().openCommands(initialQuery);
}

let monacoQuickCommandDisabled = false;

/**
 * Monaco's own command palette (F1, Ctrl+Shift+P) would compete with ours.
 * The app's capture-phase hotkeys already get there first; this also drops
 * Monaco's bindings so nothing reaches its quick input. Once per page.
 */
export function disableMonacoQuickCommand(monaco: typeof monacoTypes): void {
  if (monacoQuickCommandDisabled) return;
  monacoQuickCommandDisabled = true;
  const { KeyMod, KeyCode } = monaco;
  monaco.editor.addKeybindingRules([
    { keybinding: KeyCode.F1, command: "-editor.action.quickCommand" },
    { keybinding: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, command: "-editor.action.quickCommand" },
  ]);
}

function activeTab(): EditorTab | undefined {
  const { tabs, activeTabPath } = useEditorStore.getState();
  return tabs.find((t) => t.path === activeTabPath);
}

function hasActiveEditorModel(): boolean {
  return Boolean(getActiveEditor()?.getModel());
}

function closeActive(action: TabCloseAction): void {
  const tab = activeTab();
  if (!tab) return;
  void closeTabs(pathsToClose(useEditorStore.getState().tabs, tab.path, action), tab.path);
}

function cycleTab(step: 1 | -1): void {
  const { tabs, activeTabPath, setActiveTab } = useEditorStore.getState();
  if (tabs.length < 2) return;
  const index = tabs.findIndex((t) => t.path === activeTabPath);
  setActiveTab(tabs[(index + step + tabs.length) % tabs.length].path);
}

/** A built-in Monaco action, run on the active editor (e.g. Format Document). */
function editorAction(actionId: string, title: string, keybinding?: string): Command {
  return {
    id: actionId,
    title,
    category: "Editor",
    keybinding,
    when: () => Boolean(getActiveEditor()?.getModel() && getActiveEditor()?.getAction(actionId)?.isSupported()),
    run: async () => {
      const editor = getActiveEditor();
      editor?.focus();
      await editor?.getAction(actionId)?.run();
    },
  };
}

function pinGroupCommands(): Command[] {
  const openNth: Command[] = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({
    id: `pinGroups.openGroup${n}`,
    title: `Open Pin Group ${n}`,
    category: "Pin Groups",
    keybinding: `mod+alt+${n}`,
    when: () => nthGroupId(usePinGroupStore.getState().groups, n) !== null,
    run: () => usePinQuickPickStore.getState().open(nthGroupId(usePinGroupStore.getState().groups, n)),
  }));

  return [
    {
      id: "pinGroups.browse",
      title: "Browse Pin Groups…",
      category: "Pin Groups",
      keybinding: "mod+alt+p",
      run: () => usePinQuickPickStore.getState().open(null),
    },
    ...openNth,
    {
      id: "pinGroups.newGroup",
      title: "New Pin Group…",
      category: "Pin Groups",
      run: async () => {
        const path = activeFilePath();
        await createGroupFromPrompt(path ? [path] : []);
      },
    },
    {
      id: "pinGroups.savePinnedTabs",
      title: "Save Pinned Tabs as Group…",
      category: "Pin Groups",
      run: () => savePinnedTabsAsGroup(),
    },
    {
      id: "pinGroups.addActiveFile",
      title: "Add Active File to Active Group",
      category: "Pin Groups",
      when: () => {
        const { groups, activeGroupId } = usePinGroupStore.getState();
        const group = groups.find((g) => g.id === activeGroupId);
        const path = activeFilePath();
        return Boolean(group && path && !group.paths.includes(path));
      },
      run: () => {
        const { activeGroupId } = usePinGroupStore.getState();
        if (activeGroupId) addActiveFileToGroup(activeGroupId);
      },
    },
  ];
}

/** The app-wide commands that don't depend on the Layout's own state. */
export function appCommands(): Command[] {
  return [
    {
      id: SHOW_COMMANDS_ID,
      title: "Show All Commands",
      category: "View",
      keybinding: "mod+shift+p",
      run: () => showCommandPalette(),
    },
    {
      id: "workbench.action.quickOpen",
      title: "Go to File…",
      keybinding: "mod+p",
      run: () => usePaletteStore.getState().open(""),
    },
    {
      id: "workbench.action.gotoLine",
      title: "Go to Line/Column…",
      keybinding: "mod+g",
      when: hasActiveEditorModel,
      run: () => usePaletteStore.getState().open(":"),
    },

    // File / tabs
    {
      id: SAVE_COMMAND_ID,
      title: "Save",
      category: "File",
      keybinding: "mod+s",
      when: () => Boolean(activeTab()),
      run: saveActiveTab,
    },
    {
      id: "workbench.action.closeActiveEditor",
      title: "Close Editor",
      category: "View",
      when: () => Boolean(activeTab()),
      run: () => closeActive("close"),
    },
    {
      id: "workbench.action.closeOtherEditors",
      title: "Close Other Editors",
      category: "View",
      when: () => useEditorStore.getState().tabs.length > 1,
      run: () => closeActive("others"),
    },
    {
      id: "workbench.action.closeAllEditors",
      title: "Close All Editors",
      category: "View",
      when: () => useEditorStore.getState().tabs.length > 0,
      run: () => closeActive("all"),
    },
    {
      id: "workbench.action.pinEditor",
      title: "Pin Editor",
      category: "View",
      when: () => Boolean(activeTab() && !activeTab()?.isPinned),
      run: () => {
        const tab = activeTab();
        if (tab) useEditorStore.getState().setPinned(tab.path, true);
      },
    },
    {
      id: "workbench.action.unpinEditor",
      title: "Unpin Editor",
      category: "View",
      when: () => Boolean(activeTab()?.isPinned),
      run: () => {
        const tab = activeTab();
        if (tab) useEditorStore.getState().setPinned(tab.path, false);
      },
    },
    {
      id: "workbench.action.nextEditor",
      title: "Open Next Editor",
      category: "View",
      when: () => useEditorStore.getState().tabs.length > 1,
      run: () => cycleTab(1),
    },
    {
      id: "workbench.action.previousEditor",
      title: "Open Previous Editor",
      category: "View",
      when: () => useEditorStore.getState().tabs.length > 1,
      run: () => cycleTab(-1),
    },
    {
      id: "workbench.files.action.showActiveFileInExplorer",
      title: "Reveal Active File in Explorer",
      category: "File",
      when: () => activeFilePath() !== null,
      run: async () => {
        const path = activeFilePath();
        if (path) await useExplorerStore.getState().reveal(path);
      },
    },

    ...pinGroupCommands(),

    // Markdown
    {
      id: "markdown.togglePreview",
      title: "Toggle Preview",
      category: "Markdown",
      keybinding: "mod+shift+v",
      when: canToggleMarkdownPreview,
      run: () => void toggleMarkdownPreview(),
    },
    {
      id: "markdown.showPreviewToSide",
      title: "Open Preview to the Side",
      category: "Markdown",
      keybinding: "mod+k v",
      when: () => {
        const tab = activeTab();
        return Boolean(tab && isMarkdownSourceTab(tab));
      },
      run: () => {
        const tab = activeTab();
        if (tab) openMarkdownPreview(tab.path);
      },
    },

    {
      id: "workbench.action.openSettings",
      title: "Open Settings",
      category: "Preferences",
      keybinding: "mod+,",
      run: openSettingsTab,
    },

    // Monaco's own actions on the active editor.
    editorAction("editor.action.formatDocument", "Format Document", "shift+alt+f"),
    editorAction("editor.action.rename", "Rename Symbol", "f2"),
    editorAction("editor.action.revealDefinition", "Go to Definition", "f12"),
    editorAction("editor.action.goToReferences", "Go to References", "shift+f12"),
    editorAction("editor.action.quickFix", "Quick Fix…", "mod+."),
    editorAction("editor.action.commentLine", "Toggle Line Comment", "mod+/"),
    editorAction("actions.find", "Find", "mod+f"),
    editorAction("editor.action.startFindReplaceAction", "Replace"),

    // Git: the Source Control panel's own actions (errors surface there).
    ...(
      [
        ["git.fetch", "Fetch", () => useGitStore.getState().fetch()],
        ["git.pull", "Pull", () => useGitStore.getState().pull()],
        ["git.push", "Push", () => useGitStore.getState().push()],
        ["git.refresh", "Refresh", () => useGitStore.getState().refresh()],
      ] as const
    ).map(
      ([id, title, run]): Command => ({
        id,
        title,
        category: "Git",
        when: () => useGitStore.getState().status !== null && !useGitStore.getState().busy,
        run,
      }),
    ),

    {
      id: "update.checkForUpdates",
      title: "Check for Updates…",
      category: "Help",
      run: () => checkForUpdates({ silent: false }),
    },
  ];
}

/** What the Layout owns (panels, sidebar views), for its own commands. */
export interface LayoutActions {
  toggleTerminal: () => void;
  newTerminal: () => void;
  showView: (view: "files" | "search" | "git") => void;
  findInFiles: () => void;
  openFolder: () => void;
}

export function layoutCommands(actions: () => LayoutActions): Command[] {
  return [
    {
      id: "workbench.action.togglePanel",
      title: "Toggle Terminal Panel",
      category: "View",
      keybinding: "mod+b",
      run: () => actions().toggleTerminal(),
    },
    {
      id: "workbench.action.terminal.new",
      title: "Create New Terminal",
      category: "Terminal",
      keybinding: "mod+shift+`",
      run: () => actions().newTerminal(),
    },
    {
      id: "workbench.view.explorer",
      title: "Show Explorer",
      category: "View",
      run: () => actions().showView("files"),
    },
    {
      id: "workbench.view.search",
      title: "Find in Files",
      category: "Search",
      keybinding: "mod+shift+f",
      run: () => actions().findInFiles(),
    },
    {
      id: "workbench.view.scm",
      title: "Show Source Control",
      category: "View",
      run: () => actions().showView("git"),
    },
    {
      id: "workbench.action.files.openFolder",
      title: "Open Folder…",
      category: "File",
      run: () => actions().openFolder(),
    },
  ];
}
