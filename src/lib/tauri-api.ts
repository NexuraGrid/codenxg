import { Channel, invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** Opens `path` as the workspace; the backend refuses paths outside it. */
export function setWorkspace(path: string): Promise<void> {
  return invoke("set_workspace", { path });
}

/** Changed paths arrive in debounced batches; starts with nothing watched. */
export function startWatcher(onChange: (paths: string[]) => void): Promise<void> {
  const channel = new Channel<string[]>();
  channel.onmessage = onChange;
  return invoke("watch_start", { onChange: channel });
}

/** Replaces the set of watched folders (each watched one level deep). */
export function watchDirs(dirs: string[]): Promise<void> {
  return invoke("watch_dirs", { dirs });
}

export function readDir(path: string): Promise<FileEntry[]> {
  return invoke("read_dir", { path });
}

export function readFile(path: string): Promise<string> {
  return invoke("read_file", { path });
}

export function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

/** Resolves to the created entry's full path; rejects if the name exists. */
export function createEntry(parent: string, name: string, isDir: boolean): Promise<string> {
  return invoke("create_entry", { parent, name, isDir });
}

/** Renames in place (same folder); resolves to the new full path. */
export function renameEntry(path: string, newName: string): Promise<string> {
  return invoke("rename_entry", { path, newName });
}

/** Moves into another folder (drag and drop); resolves to the new full path. */
export function moveEntry(path: string, targetDir: string): Promise<string> {
  return invoke("move_entry", { path, targetDir });
}

export function trashEntry(path: string): Promise<void> {
  return invoke("trash_entry", { path });
}

export function deleteEntryPermanently(path: string): Promise<void> {
  return invoke("delete_entry", { path });
}

export interface FileList {
  files: string[];
  truncated: boolean;
}

export function listFiles(root: string): Promise<FileList> {
  return invoke("list_files", { root });
}

// Output streams over a dedicated IPC channel instead of global events: no
// event-bus broadcast or eval per chunk, which is what made the shell feel slow.
export function createTerminal(
  id: string,
  cwd: string,
  rows: number,
  cols: number,
  onOutput: (chunk: string) => void,
  onExit: () => void,
): Promise<void> {
  const output = new Channel<string>();
  output.onmessage = onOutput;
  const exit = new Channel<null>();
  exit.onmessage = onExit;
  return invoke("create_terminal", { id, cwd, rows, cols, onOutput: output, onExit: exit });
}

export function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke("write_to_terminal", { id, data });
}

export function resizeTerminal(id: string, rows: number, cols: number): Promise<void> {
  return invoke("resize_terminal", { id, rows, cols });
}

export function closeTerminal(id: string): Promise<void> {
  return invoke("close_terminal", { id });
}

export interface GitChange {
  path: string;
  origPath: string | null;
  /** Porcelain letters: "." unchanged, M, A, D, R, C, T, or "?" untracked. */
  index: string;
  worktree: string;
  conflicted: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  headOid: string | null;
  changes: GitChange[];
}

export function gitStatus(): Promise<GitStatus> {
  return invoke("git_status");
}

export function gitStage(paths: string[]): Promise<void> {
  return invoke("git_stage", { paths });
}

export function gitUnstage(paths: string[]): Promise<void> {
  return invoke("git_unstage", { paths });
}

/** Tracked files are restored from the index; untracked ones go to the trash. */
export function gitDiscard(tracked: string[], untracked: string[]): Promise<void> {
  return invoke("git_discard", { tracked, untracked });
}

export function gitCommit(message: string, stageAll: boolean): Promise<void> {
  return invoke("git_commit", { message, stageAll });
}

export function gitPush(): Promise<void> {
  return invoke("git_push");
}

export function gitPull(): Promise<void> {
  return invoke("git_pull");
}

export function gitInit(): Promise<void> {
  return invoke("git_init");
}

/** The file at HEAD, or null when HEAD doesn't have it (or it's binary). */
export function gitShowHead(path: string): Promise<string | null> {
  return invoke("git_show_head", { path });
}
