import { create } from "zustand";
import { readDir, type FileEntry } from "../lib/tauri-api";
import { isSameOrInside, rebase } from "../lib/paths";

export type CreateKind = "file" | "folder";

function rebaseKeys<T>(record: Record<string, T>, from: string, to: string, mapValue: (value: T) => T) {
  const next: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    next[isSameOrInside(key, from) ? rebase(key, from, to) : key] = mapValue(value);
  }
  return next;
}

interface ExplorerState {
  root: string | null;
  /** Listing per loaded folder, keyed by absolute path. */
  children: Record<string, FileEntry[]>;
  expanded: Record<string, boolean>;
  /** The inline "new file/folder" name input, if one is open. */
  creating: { parent: string; kind: CreateKind } | null;
  /** Path whose row is showing the inline rename input. */
  renaming: string | null;
  /** Entry being dragged, and the folder it would land in if dropped now. */
  dragging: string | null;
  dropTarget: string | null;

  init: (root: string) => void;
  refresh: (dir: string) => Promise<void>;
  toggle: (dir: string) => void;
  expand: (dir: string) => void;
  startCreate: (parent: string, kind: CreateKind) => void;
  cancelCreate: () => void;
  startRename: (path: string) => void;
  cancelRename: () => void;
  /** Keeps cached listings and open folders valid after `from` is renamed. */
  rebasePaths: (from: string, to: string) => void;
  /** Drops cached state at or under a deleted path. */
  forgetPath: (path: string) => void;
  setDrag: (dragging: string | null, dropTarget: string | null) => void;
}

function withoutPath<T>(record: Record<string, T>, path: string) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !isSameOrInside(key, path)));
}

// Tree state lives here, not inside each node, so other features (creating a
// file, reloading a folder after a change) can open and refresh any folder.
export const useExplorerStore = create<ExplorerState>((set, get) => ({
  root: null,
  children: {},
  expanded: {},
  creating: null,
  renaming: null,
  dragging: null,
  dropTarget: null,

  init: (root) => {
    set({ root, children: {}, expanded: {}, creating: null, renaming: null, dragging: null, dropTarget: null });
    get().refresh(root).catch(console.error);
  },

  refresh: async (dir) => {
    const entries = await readDir(dir);
    set((state) => ({ children: { ...state.children, [dir]: entries } }));
  },

  toggle: (dir) => {
    if (get().expanded[dir]) {
      set((state) => ({ expanded: { ...state.expanded, [dir]: false } }));
    } else {
      get().expand(dir);
    }
  },

  expand: (dir) => {
    set((state) => ({ expanded: { ...state.expanded, [dir]: true } }));
    if (!get().children[dir]) get().refresh(dir).catch(console.error);
  },

  // Creating and renaming are mutually exclusive, like VS Code's explorer.
  startCreate: (parent, kind) => {
    if (parent !== get().root) get().expand(parent);
    set({ creating: { parent, kind }, renaming: null });
  },

  cancelCreate: () => set({ creating: null }),

  startRename: (path) => set({ renaming: path, creating: null }),

  cancelRename: () => set({ renaming: null }),

  rebasePaths: (from, to) =>
    set((state) => ({
      expanded: rebaseKeys(state.expanded, from, to, (open) => open),
      children: rebaseKeys(state.children, from, to, (entries) =>
        entries.map((e) => (isSameOrInside(e.path, from) ? { ...e, path: rebase(e.path, from, to) } : e)),
      ),
    })),

  forgetPath: (path) =>
    set((state) => ({
      expanded: withoutPath(state.expanded, path),
      children: withoutPath(state.children, path),
      creating: state.creating && isSameOrInside(state.creating.parent, path) ? null : state.creating,
      renaming: state.renaming && isSameOrInside(state.renaming, path) ? null : state.renaming,
    })),

  setDrag: (dragging, dropTarget) => {
    const current = get();
    if (current.dragging !== dragging || current.dropTarget !== dropTarget) set({ dragging, dropTarget });
  },
}));
