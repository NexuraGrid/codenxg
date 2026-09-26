import { create } from "zustand";
import { buildReplacementText, summarizeResults, type SearchOptions } from "../lib/searchQuery";
import { applyMatchesToText, type MatchRange } from "../lib/searchReplace";
import { applyMatchesToModel } from "../lib/searchApply";
import { readFile, searchInWorkspace, writeSearchFiles, type FileMatches } from "../lib/tauri-api";
import { showDialog } from "./dialogStore";

interface SearchState extends SearchOptions {
  replaceValue: string;
  isReplaceOpen: boolean;
  include: string;
  exclude: string;

  isSearching: boolean;
  error: string | null;
  files: FileMatches[];
  matchCount: number;
  truncated: boolean;
  /** Paths the user collapsed; everything else shows expanded. */
  collapsedPaths: Set<string>;
  /** Bumped on every Ctrl+Shift+F so the panel refocuses its input even when already open. */
  focusToken: number;

  requestFocus: () => void;
  setQuery: (query: string) => void;
  setReplaceValue: (value: string) => void;
  setIsReplaceOpen: (open: boolean) => void;
  setMatchCase: (value: boolean) => void;
  setWholeWord: (value: boolean) => void;
  setUseRegex: (value: boolean) => void;
  setInclude: (value: string) => void;
  setExclude: (value: string) => void;
  toggleCollapsed: (path: string) => void;

  runSearch: (root: string) => Promise<void>;
  replaceInFile: (path: string) => Promise<void>;
  replaceAll: () => Promise<void>;
  reset: () => void;
}

// Increases on every search kicked off; a response is applied only if it's
// still the latest one, so a fast retype can't have an older result land
// after a newer one (no cancellation on the Rust side, so this is enough).
let latestRequestId = 0;

function splitGlob(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: "",
  matchCase: false,
  wholeWord: false,
  useRegex: false,
  replaceValue: "",
  isReplaceOpen: false,
  include: "",
  exclude: "",

  isSearching: false,
  error: null,
  files: [],
  matchCount: 0,
  truncated: false,
  collapsedPaths: new Set(),
  focusToken: 0,

  requestFocus: () => set((state) => ({ focusToken: state.focusToken + 1 })),
  setQuery: (query) => set({ query }),
  setReplaceValue: (replaceValue) => set({ replaceValue }),
  setIsReplaceOpen: (isReplaceOpen) => set({ isReplaceOpen }),
  setMatchCase: (matchCase) => set({ matchCase }),
  setWholeWord: (wholeWord) => set({ wholeWord }),
  setUseRegex: (useRegex) => set({ useRegex }),
  setInclude: (include) => set({ include }),
  setExclude: (exclude) => set({ exclude }),

  toggleCollapsed: (path) =>
    set((state) => {
      const collapsedPaths = new Set(state.collapsedPaths);
      if (collapsedPaths.has(path)) collapsedPaths.delete(path);
      else collapsedPaths.add(path);
      return { collapsedPaths };
    }),

  runSearch: async (root) => {
    const { query, matchCase, wholeWord, useRegex, include, exclude } = get();
    const requestId = ++latestRequestId;

    if (!query.trim()) {
      set({ files: [], matchCount: 0, truncated: false, error: null, isSearching: false });
      return;
    }

    set({ isSearching: true, error: null });
    try {
      const response = await searchInWorkspace(root, {
        query,
        matchCase,
        wholeWord,
        useRegex,
        include: splitGlob(include),
        exclude: splitGlob(exclude),
      });
      if (requestId !== latestRequestId) return; // a newer search is already in flight/applied
      set({
        files: response.files,
        matchCount: response.matchCount,
        truncated: response.truncated,
        isSearching: false,
      });
    } catch (error) {
      if (requestId !== latestRequestId) return;
      set({ error: String(error), isSearching: false, files: [], matchCount: 0, truncated: false });
    }
  },

  replaceInFile: async (path) => {
    const file = get().files.find((f) => f.path === path);
    if (!file) return;
    await applyReplacements([file], get());
    removeFilesFromResults([path], set, get);
  },

  replaceAll: async () => {
    const { files, matchCount } = get();
    if (files.length === 0) return;

    const choice = await showDialog({
      title: "Replace all matches?",
      message: `This replaces ${matchCount} match${matchCount === 1 ? "" : "es"} in ${files.length} file${
        files.length === 1 ? "" : "s"
      }. Open files are edited in place (undoable); closed files are written to disk.`,
      buttons: [
        { label: "Replace All", value: "replace", variant: "danger" },
        { label: "Cancel", value: "cancel" },
      ],
      cancelValue: "cancel",
    });
    if (choice !== "replace") return;

    await applyReplacements(files, get());
    removeFilesFromResults(
      files.map((f) => f.path),
      set,
      get,
    );
  },

  reset: () =>
    set({
      query: "",
      replaceValue: "",
      isReplaceOpen: false,
      files: [],
      matchCount: 0,
      truncated: false,
      error: null,
      isSearching: false,
    }),
}));

async function applyReplacements(files: FileMatches[], options: SearchOptions & { replaceValue: string }) {
  const toWrite: { path: string; content: string }[] = [];

  for (const file of files) {
    const ranges: MatchRange[] = file.matches;
    const replacementFor = (match: MatchRange) => buildReplacementText(match.matchText, options.replaceValue, options);

    const appliedToModel = applyMatchesToModel(file.path, ranges, replacementFor);
    if (appliedToModel) continue;

    const original = await readFile(file.path);
    const updated = applyMatchesToText(original, ranges, replacementFor);
    toWrite.push({ path: file.path, content: updated });
  }

  if (toWrite.length > 0) await writeSearchFiles(toWrite);
}

function removeFilesFromResults(paths: string[], set: (partial: Partial<SearchState>) => void, get: () => SearchState) {
  const closing = new Set(paths);
  const files = get().files.filter((f) => !closing.has(f.path));
  const { matchCount, fileCount } = summarizeResults(files);
  set({ files, matchCount, truncated: fileCount === 0 ? false : get().truncated });
}
