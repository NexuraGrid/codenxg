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
  /** The Settings view, opened as a tab (Ctrl+, or the gear icon) — not a real file. */
  settings?: boolean;
  /**
   * A rendered preview of a Markdown file (Ctrl+Shift+V), keyed
   * `markdown-preview:<source>` so it never collides with the file's own tab.
   */
  markdownPreview?: { source: string };
  /**
   * A preview tab (italic title): single-clicking another file replaces it in
   * place instead of opening a new tab. Editing, saving, double-clicking or
   * pinning it makes it permanent. At most one exists at a time.
   */
  isPreview?: boolean;
  /** Pinned tabs sort to the left and survive Close Others/Left/Right/All. */
  isPinned?: boolean;
}

// Lives here (not in lib/markdownPreview) so rebasePaths can rekey preview tabs.
export const MARKDOWN_PREVIEW_PREFIX = "markdown-preview:";

function rebaseActivePath(active: string | null, from: string, to: string): string | null {
  if (!active) return active;
  if (active.startsWith(MARKDOWN_PREVIEW_PREFIX)) {
    const source = active.slice(MARKDOWN_PREVIEW_PREFIX.length);
    return isSameOrInside(source, from) ? `${MARKDOWN_PREVIEW_PREFIX}${rebase(source, from, to)}` : active;
  }
  return isSameOrInside(active, from) ? rebase(active, from, to) : active;
}

/** Pinned tabs first, each group in its current order. */
function pinnedFirst(tabs: EditorTab[]): EditorTab[] {
  return [...tabs.filter((t) => t.isPinned), ...tabs.filter((t) => !t.isPinned)];
}

interface EditorState {
  tabs: EditorTab[];
  activeTabPath: string | null;
  /**
   * Opens (or focuses) a tab; `tab.showDiff` picks the file or its diff view.
   * With `tab.isPreview`, a new tab takes the current preview tab's slot; a
   * non-preview open of an already-open preview tab makes it permanent.
   */
  addTab: (tab: EditorTab) => void;
  /** Turns a preview tab into a normal one (no-op otherwise). */
  makePermanent: (path: string) => void;
  /** Pins/unpins a tab, moving it to the end of the pinned group or right after it. */
  setPinned: (path: string, pinned: boolean) => void;
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
          tabs: state.tabs.map((t) =>
            t.path === tab.path
              ? { ...t, showDiff: tab.showDiff ?? false, isPreview: Boolean(t.isPreview && tab.isPreview) }
              : t,
          ),
        };
      }
      const isPinned = Boolean(tab.isPinned);
      const opened = { ...tab, isPinned, isPreview: Boolean(tab.isPreview) && !isPinned };
      if (isPinned) {
        // Restored pinned tabs: keep them inside the pinned group.
        const tabs = [...state.tabs];
        tabs.splice(tabs.filter((t) => t.isPinned).length, 0, opened);
        return { tabs, activeTabPath: tab.path };
      }
      const previewIndex = opened.isPreview ? state.tabs.findIndex((t) => t.isPreview) : -1;
      if (previewIndex !== -1) {
        const tabs = [...state.tabs];
        tabs[previewIndex] = opened;
        return { tabs, activeTabPath: tab.path };
      }
      return { tabs: [...state.tabs, opened], activeTabPath: tab.path };
    }),

  makePermanent: (path) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.path === path);
      if (!tab?.isPreview) return state;
      return { tabs: state.tabs.map((t) => (t === tab ? { ...t, isPreview: false } : t)) };
    }),

  setPinned: (path, pinned) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.path === path);
      if (!tab || Boolean(tab.isPinned) === pinned) return state;
      const updated = { ...tab, isPinned: pinned, isPreview: false };
      const rest = state.tabs.filter((t) => t !== tab);
      const pinnedCount = rest.filter((t) => t.isPinned).length;
      // A newly pinned tab goes last among the pinned; an unpinned one goes
      // first among the rest — both land right at the group boundary.
      const tabs = pinnedFirst(rest);
      tabs.splice(pinnedCount, 0, updated);
      return { tabs };
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
        if (t.markdownPreview) {
          if (!isSameOrInside(t.markdownPreview.source, from)) return t;
          const source = rebase(t.markdownPreview.source, from, to);
          return { ...t, path: `${MARKDOWN_PREVIEW_PREFIX}${source}`, title: `Preview ${basename(source)}`, markdownPreview: { source } };
        }
        if (!isSameOrInside(t.path, from)) return t;
        const path = rebase(t.path, from, to);
        return { ...t, path, title: basename(path), language: languageFromPath(path) };
      }),
      activeTabPath: rebaseActivePath(state.activeTabPath, from, to),
    })),

  reset: () => set({ tabs: [], activeTabPath: null }),

  // Called on every keystroke: bail out when nothing changes so subscribers
  // (tabs, editor) don't re-render per character typed.
  setDirty: (path, isDirty) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.path === path);
      if (!tab || tab.isDirty === isDirty) return state;
      // An edited preview tab becomes permanent, same as VS Code.
      const isPreview = isDirty ? false : tab.isPreview;
      return { tabs: state.tabs.map((t) => (t === tab ? { ...t, isDirty, isPreview } : t)) };
    }),
}));
