import { create } from "zustand";
import {
  gitBranches,
  gitCheckout,
  gitCreateBranch,
  gitStashAndSwitch,
  gitFetch,
  gitLog,
  gitCommit,
  gitDiscard,
  gitInit,
  gitPull,
  gitPush,
  gitShowHead,
  gitStage,
  gitStatus,
  gitUnstage,
  type GitBranch,
  type GitChange,
  type GitCommit,
  type GitStatus,
  type SwitchOutcome,
} from "../lib/tauri-api";
import { basename, dirname } from "../lib/paths";
import { showDialog } from "./dialogStore";
import { explainSwitchBlock } from "../lib/switchExplanation";

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
  branches: GitBranch[];
  loadBranches: () => Promise<void>;
  checkout: (branch: GitBranch) => Promise<void>;
  /** Creates from `base` (current commit when null) and moves onto it if `switchTo`. */
  createBranch: (name: string, base?: string | null, switchTo?: boolean) => Promise<boolean>;
  fetch: () => Promise<void>;
  /** Commits loaded so far, newest first; `hasMoreHistory` while pages remain. */
  history: GitCommit[];
  hasMoreHistory: boolean;
  loadHistory: (more?: boolean) => Promise<void>;
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

const HISTORY_PAGE = 100;
const FAILED = Symbol("failed");
let inFlight: Promise<void> | null = null;
let refreshAgain = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
const headTexts = new Map<string, Promise<string | null>>();

export const useGitStore = create<GitState>((set, get) => {
  async function run(label: string, action: () => Promise<unknown>): Promise<boolean> {
    return (await runFor(label, action)) !== FAILED;
  }

  /** Runs a git action with a busy label; errors become a dialog and FAILED. */
  async function runFor<T>(label: string, action: () => Promise<T>): Promise<T | typeof FAILED> {
    set({ busy: label });
    try {
      return await action();
    } catch (error) {
      await showDialog({
        title: `Git: ${label.replace("…", "")} failed`,
        message: String(error),
        buttons: [{ label: "OK", value: "ok", variant: "primary" }],
        cancelValue: "ok",
      });
      return FAILED;
    } finally {
      set({ busy: null });
      await get().refresh();
    }
  }

  /** When git refused to switch: explain why and offer to stash and retry. */
  async function followUp(target: string, outcome: SwitchOutcome, created: boolean) {
    if (!outcome.blocked) return;
    const current = get().status?.branch ?? "the current commit";
    const { title, message, canStash } = explainSwitchBlock(outcome.blocked, target, current, created);
    const choice = await showDialog({
      title,
      message,
      buttons: canStash
        ? [
            { label: "Stash changes & switch", value: "stash", variant: "primary" },
            { label: `Stay on ${current}`, value: "stay" },
          ]
        : [{ label: "OK", value: "stay", variant: "primary" }],
      cancelValue: "stay",
    });
    if (choice !== "stash") return;

    const retry = await runFor(`Switching to ${target}…`, () => gitStashAndSwitch(target));
    if (retry === FAILED) return;
    if (retry.blocked) {
      await followUp(target, retry, false);
      return;
    }
    await showDialog({
      title: `Switched to "${target}"`,
      message: `Your changes from "${current}" were stashed. Switch back and run “git stash pop” to bring them back.`,
      buttons: [{ label: "OK", value: "ok", variant: "primary" }],
      cancelValue: "ok",
    });
  }

  return {
    status: null,
    busy: null,
    byPath: {},
    changedDirs: {},
    headVersion: 0,
    message: "",

    setMessage: (message) => set({ message }),

    branches: [],
    loadBranches: async () => {
      try {
        set({ branches: await gitBranches() });
      } catch (error) {
        console.error(error);
      }
    },
    checkout: async (branch) => {
      const outcome = await runFor(`Switching to ${branch.name}…`, () => gitCheckout(branch.name, branch.isRemote));
      // A remote branch is entered through its local namesake.
      const local = branch.isRemote ? branch.name.slice(branch.name.indexOf("/") + 1) : branch.name;
      if (outcome !== FAILED) await followUp(local, outcome, false);
      await Promise.all([get().loadBranches(), get().loadHistory()]);
    },
    createBranch: async (name, base = null, switchTo = true) => {
      const outcome = await runFor(`Creating ${name}…`, () => gitCreateBranch(name, base, switchTo));
      if (outcome !== FAILED) await followUp(name, outcome, true);
      await Promise.all([get().loadBranches(), get().loadHistory()]);
      return outcome !== FAILED;
    },
    fetch: async () => {
      await run("Fetching…", gitFetch);
      await get().loadBranches();
    },

    history: [],
    hasMoreHistory: false,
    loadHistory: async (more = false) => {
      const skip = more ? get().history.length : 0;
      try {
        const page = await gitLog(skip, HISTORY_PAGE);
        set((state) => ({
          history: more ? [...state.history, ...page] : page,
          hasMoreHistory: page.length === HISTORY_PAGE,
        }));
      } catch (error) {
        console.error(error);
      }
    },

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
            if (status.headOid !== previousHead) {
              headTexts.clear();
              // Commits made here or in the terminal show up in History.
              if (get().history.length > 0) void get().loadHistory();
            }
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
      set({ status: null, busy: null, byPath: {}, changedDirs: {}, branches: [], history: [], hasMoreHistory: false });
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
