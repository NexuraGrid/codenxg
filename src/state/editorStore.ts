import { create } from "zustand";
import { basename, isSameOrInside, rebase } from "../lib/paths";
import { languageFromPath } from "../lib/language";

export interface EditorTab {
  path: string;
  title: string;
  isDirty: boolean;
  language: string;
  /** Showing the side-by-side diff against the last commit instead of the file. */
  showDiff?: boolean;
  /**
   * A read-only view of one file's change in a past commit. Such tabs are keyed
   * `commit:<hash>:<file>`, so they never collide with the file's own tab.
   */
  commit?: { hash: string; shortHash: string; file: string; origFile: string | null };
  /**
   * A read-only view of one file's change in a stash. Such tabs are keyed
   * `stash:<index>:<file>`, so they never collide with the file's own tab.
   */
  stash?: { index: number; message: string; file: string; origFile: string | null };
}

interface EditorState {
  tabs: EditorTab[];
  activeTabPath: string | null;
  /** Opens (or focuses) a tab; `tab.showDiff` picks the file or its diff view. */
  addTab: (tab: EditorTab) => void;
  setShowDiff: (path: string, showDiff: boolean) => void;
  /** Closes several tabs; if the active one goes, `preferredActive` takes over. */
  closeTabs: (paths: string[], preferredActive?: string) => void;
  setActiveTab: (path: string) => void;
  setDirty: (path: string, isDirty: boolean) => void;
  /** Points tabs at or under a renamed file/folder to their new paths. */
  rebasePaths: (from: string, to: string) => void;
  reset: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  tabs: [],
  activeTabPath: null,

  addTab: (tab) =>
    set((state) => {
      if (state.tabs.some((t) => t.path === tab.path)) {
        return {
          activeTabPath: tab.path,
          tabs: state.tabs.map((t) => (t.path === tab.path ? { ...t, showDiff: tab.showDiff ?? false } : t)),
        };
      }
      return { tabs: [...state.tabs, tab], activeTabPath: tab.path };
    }),

  closeTabs: (paths, preferredActive) =>
    set((state) => {
      const closing = new Set(paths);
      const tabs = state.tabs.filter((t) => !closing.has(t.path));
      if (state.activeTabPath && !closing.has(state.activeTabPath)) {
        return { tabs };
      }
      const fallback = tabs.find((t) => t.path === preferredActive) ?? tabs[tabs.length - 1];
      return { tabs, activeTabPath: fallback?.path ?? null };
    }),

  setActiveTab: (path) => set({ activeTabPath: path }),

  setShowDiff: (path, showDiff) =>
    set((state) => ({ tabs: state.tabs.map((t) => (t.path === path ? { ...t, showDiff } : t)) })),

  rebasePaths: (from, to) =>
    set((state) => ({
      tabs: state.tabs.map((t) => {
        if (!isSameOrInside(t.path, from)) return t;
        const path = rebase(t.path, from, to);
        return { ...t, path, title: basename(path), language: languageFromPath(path) };
      }),
      activeTabPath:
        state.activeTabPath && isSameOrInside(state.activeTabPath, from)
          ? rebase(state.activeTabPath, from, to)
          : state.activeTabPath,
    })),

  reset: () => set({ tabs: [], activeTabPath: null }),

  // Called on every keystroke: bail out when nothing changes so subscribers
  // (tabs, editor) don't re-render per character typed.
  setDirty: (path, isDirty) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.path === path);
      if (!tab || tab.isDirty === isDirty) return state;
      return { tabs: state.tabs.map((t) => (t === tab ? { ...t, isDirty } : t)) };
    }),
}));
