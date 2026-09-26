import { create } from "zustand";
import {
  gitCommit,
  gitDiscard,
  gitInit,
  gitPull,
  gitPush,
  gitShowHead,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitChange,
  type GitStatus,
} from "../lib/tauri-api";
import { basename, dirname } from "../lib/paths";
import { showDialog } from "./dialogStore";

/** One letter per file, as VS Code shows it next to the name. */
export type FileDecoration = "M" | "A" | "D" | "R" | "U" | "C";

interface GitState {
  status: GitStatus | null;
  /** What a running action is doing ("Committing…"), for the panel. */
  busy: string | null;
  byPath: Record<string, FileDecoration>;
  /** Folders holding a change, so collapsed folders still hint at it. */
  changedDirs: Record<string, true>;
  /** Bumped when HEAD moves, so gutters re-read the committed text. */
  headVersion: number;
  /** The commit message draft; survives switching sidebar views. */
  message: string;
  setMessage: (message: string) => void;
  refresh: () => Promise<void>;
  /** Coalesces bursts (file watcher batches, saves) into one `git status`. */
  scheduleRefresh: () => void;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  discard: (changes: GitChange[]) => Promise<void>;
  commit: (message: string) => Promise<boolean>;
  push: () => Promise<void>;
  pull: () => Promise<void>;
  init: () => Promise<void>;
  reset: () => void;
}

let inFlight: Promise<void> | null = null;
let refreshAgain = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const headTexts = new Map<string, Promise<string | null>>();

export const useGitStore = create<GitState>((set, get) => {
  async function run(label: string, action: () => Promise<void>): Promise<boolean> {
    set({ busy: label });
    try {
      await action();
      return true;
    } catch (error) {
      await showDialog({
        title: `Git: ${label.replace("…", "")} failed`,
        message: String(error),
        buttons: [{ label: "OK", value: "ok", variant: "primary" }],
        cancelValue: "ok",
      });
      return false;
    } finally {
      set({ busy: null });
      await get().refresh();
    }
  }

  return {
    status: null,
    busy: null,
    byPath: {},
    changedDirs: {},
    headVersion: 0,
    message: "",

    setMessage: (message) => set({ message }),

    refresh: () => {
      if (inFlight) {
        refreshAgain = true;
        return inFlight;
      }
      inFlight = (async () => {
        try {
          do {
            refreshAgain = false;
            const status = await gitStatus();
            const previousHead = get().status?.headOid;
            if (status.headOid !== previousHead) headTexts.clear();
            set((state) => ({
              status,
              ...decorations(status.changes),
              headVersion: status.headOid !== previousHead ? state.headVersion + 1 : state.headVersion,
            }));
          } while (refreshAgain);
        } catch (error) {
          console.error(error);
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },

    scheduleRefresh: () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => void get().refresh(), 300);
    },

    stage: async (paths) => void (await run("Staging…", () => gitStage(paths))),
    unstage: async (paths) => void (await run("Unstaging…", () => gitUnstage(paths))),

    discard: async (changes) => {
      if (changes.length === 0) return;
      const untracked = changes.filter((c) => c.index === "?").map((c) => c.path);
      const tracked = changes.filter((c) => c.index !== "?").map((c) => c.path);
      const what = changes.length === 1 ? basename(changes[0].path) : `${changes.length} files`;
      const choice = await showDialog({
        title: `Discard changes in ${what}?`,
        message:
          untracked.length > 0
            ? "Edits are lost; new (untracked) files are moved to the trash."
            : "Your edits since the last stage will be lost.",
        buttons: [
          { label: "Discard", value: "discard", variant: "danger" },
          { label: "Cancel", value: "cancel", variant: "primary" },
        ],
        cancelValue: "cancel",
      });
      if (choice === "discard") await run("Discarding…", () => gitDiscard(tracked, untracked));
    },

    commit: async (message) => {
      const changes = get().status?.changes ?? [];
      const hasStaged = changes.some((c) => c.index !== "." && c.index !== "?");
      let stageAll = false;
      if (!hasStaged) {
        if (changes.length === 0) return false;
        // VS Code's "smart commit" question.
        const choice = await showDialog({
          title: "There are no staged changes to commit.",
          message: "Stage all your changes and commit them directly?",
          buttons: [
            { label: "Stage All & Commit", value: "yes", variant: "primary" },
            { label: "Cancel", value: "no" },
          ],
          cancelValue: "no",
        });
        if (choice !== "yes") return false;
        stageAll = true;
      }
      return run("Committing…", () => gitCommit(message, stageAll));
    },

    push: async () => void (await run("Pushing…", gitPush)),
    pull: async () => void (await run("Pulling…", gitPull)),
    init: async () => void (await run("Initializing…", gitInit)),

    reset: () => {
      headTexts.clear();
      set({ status: null, busy: null, byPath: {}, changedDirs: {} });
    },
  };
});

/** The committed text of `path`, cached until HEAD moves. */
export function headText(path: string): Promise<string | null> {
  let text = headTexts.get(path);
  if (!text) {
    text = gitShowHead(path).catch(() => null);
    headTexts.set(path, text);
  }
  return text;
}

export function decorationOf(change: GitChange): FileDecoration {
  if (change.conflicted) return "C";
  if (change.index === "?") return "U";
  const letter = change.worktree !== "." ? change.worktree : change.index;
  if (letter === "A" || letter === "D" || letter === "R") return letter;
  return "M";
}

function decorations(changes: GitChange[]) {
  const byPath: Record<string, FileDecoration> = {};
  const changedDirs: Record<string, true> = {};
  for (const change of changes) {
    byPath[change.path] = decorationOf(change);
    // Walk up until an already-marked folder: every ancestor above it is too.
    for (let dir = dirname(change.path); !changedDirs[dir] && dir !== dirname(dir); dir = dirname(dir)) {
      changedDirs[dir] = true;
    }
  }
  return { byPath, changedDirs };
}
