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

/** Folder passed on the command line (`codenxg .`), already absolute. */
export function launchFolder(): Promise<string | null> {
  return invoke("launch_folder");
}

/** Puts `codenxg` on the PATH (and the launcher on Linux); resolves to a status message. */
export function installCli(): Promise<string> {
  return invoke("install_cli");
}

/** False for installs the package manager owns (Linux packages), where the in-app updater can't apply an update. */
export function updatesSupported(): Promise<boolean> {
  return invoke("updates_supported");
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

/**
 * Raw bytes of an image inside the workspace (the Markdown preview); rejects
 * anything else, see read_image_data on the Rust side.
 */
export function readImageData(path: string): Promise<ArrayBuffer> {
  return invoke("read_image_data", { path });
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

export interface SearchQueryInput {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  useRegex: boolean;
  include: string | null;
  exclude: string | null;
}

export interface SearchMatch {
  line: number;
  startColumn: number;
  endColumn: number;
  matchText: string;
  preview: string;
  previewMatchStart: number;
  previewMatchEnd: number;
}

export interface FileMatches {
  path: string;
  matches: SearchMatch[];
}

export interface SearchResponse {
  files: FileMatches[];
  matchCount: number;
  truncated: boolean;
}

export function searchInWorkspace(root: string, query: SearchQueryInput): Promise<SearchResponse> {
  return invoke("search_in_workspace", { root, query });
}

/** Writes several files at once (project-wide replace), each atomically. */
export function writeSearchFiles(files: { path: string; content: string }[]): Promise<void> {
  return invoke("write_search_files", { files });
}

// Output streams over a dedicated IPC channel instead of global events: no
// event-bus broadcast or eval per chunk, which is what made the shell feel slow.
/**
 * Resolves to a warning message when the configured shell wasn't found and
 * the app fell back to auto-detecting one, otherwise null.
 */
export function createTerminal(
  id: string,
  cwd: string,
  rows: number,
  cols: number,
  shellPath: string | undefined,
  shellArgs: string[] | undefined,
  onOutput: (chunk: string) => void,
  onExit: () => void,
): Promise<string | null> {
  const output = new Channel<string>();
  output.onmessage = onOutput;
  const exit = new Channel<null>();
  exit.onmessage = onExit;
  return invoke("create_terminal", { id, cwd, rows, cols, shellPath, shellArgs, onOutput: output, onExit: exit });
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

export interface GitBranch {
  /** "main", or "origin/main" for a remote branch. */
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  upstream: string | null;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  /** Unix seconds. */
  timestamp: number;
  refs: string[];
}

export interface GitCommitFile {
  path: string;
  origPath: string | null;
  /** A, M, D, R, C or T. */
  status: string;
}

export function gitBranches(): Promise<GitBranch[]> {
  return invoke("git_branches");
}

export interface SwitchBlock {
  kind: "local-changes" | "untracked-files" | "unresolved-conflicts" | "other";
  /** Files git named as the obstacle, relative to the repository. */
  files: string[];
  /** git's own message. */
  detail: string;
}

/** Either we're on the branch now, or `blocked` says why git refused. */
export interface SwitchOutcome {
  switched: boolean;
  blocked: SwitchBlock | null;
}

export function gitCheckout(name: string, isRemote: boolean): Promise<SwitchOutcome> {
  return invoke("git_checkout", { name, isRemote });
}

/** Creates `name` from `base` (current commit when null); the branch exists even if switching is refused. */
export function gitCreateBranch(name: string, base: string | null, switchTo: boolean): Promise<SwitchOutcome> {
  return invoke("git_create_branch", { name, base, switch: switchTo });
}

/** Stashes every uncommitted change (untracked too), then switches. */
export function gitStashAndSwitch(name: string): Promise<SwitchOutcome> {
  return invoke("git_stash_and_switch", { name });
}

export function gitFetch(): Promise<void> {
  return invoke("git_fetch");
}

export function gitLog(skip: number, limit: number): Promise<GitCommit[]> {
  return invoke("git_log", { skip, limit });
}

export function gitCommitFiles(hash: string): Promise<GitCommitFile[]> {
  return invoke("git_commit_files", { hash });
}

/** A file as of `rev` (a hash, or `hash^` for its parent); null if absent there. */
export function gitShowAt(rev: string, path: string): Promise<string | null> {
  return invoke("git_show_at", { rev, path });
}

export interface GitStash {
  index: number;
  /** The message, without its "On <branch>: " / "WIP on <branch>: " prefix. */
  message: string;
  /** None when the subject doesn't have the usual shape. */
  branch: string | null;
  /** Unix seconds. */
  timestamp: number;
}

export function gitStashList(): Promise<GitStash[]> {
  return invoke("git_stash_list");
}

/** Stashes every uncommitted change; `includeUntracked` also stashes new files. */
export function gitStashPush(message: string | null, includeUntracked: boolean): Promise<void> {
  return invoke("git_stash_push", { message, includeUntracked });
}

/** Re-applies a stash; the stash itself stays (see `gitStashPop` to drop it too). */
export function gitStashApply(index: number): Promise<void> {
  return invoke("git_stash_apply", { index });
}

export function gitStashPop(index: number): Promise<void> {
  return invoke("git_stash_pop", { index });
}

export function gitStashDrop(index: number): Promise<void> {
  return invoke("git_stash_drop", { index });
}

export function gitStashFiles(index: number): Promise<GitCommitFile[]> {
  return invoke("git_stash_files", { index });
}

export interface StashFileDiff {
  before: string | null;
  after: string | null;
}

/** One file's content before and after a stash, for a read-only diff. */
export function gitStashFileDiff(index: number, path: string, origPath: string | null): Promise<StashFileDiff> {
  return invoke("git_stash_file_diff", { index, path, origPath });
}

export interface LspStarted {
  /** The server that was started, e.g. "intelephense". */
  name: string;
  /** Machine-specific `initialize` options (Vue's TypeScript path), if any. */
  initializationOptions?: object;
}

/** Starts the language server for `language`. */
export function lspStart(language: string, onMessage: (json: string) => void): Promise<LspStarted> {
  const channel = new Channel<string>();
  channel.onmessage = onMessage;
  return invoke("lsp_start", { language, onMessage: channel });
}

/**
 * Installs the language server for `language` with its fixed, allow-listed
 * recipe. Rejects with "not-installable", "tool-missing:<tool>:<requires>",
 * or the installer's error output.
 */
export function lspInstall(language: string): Promise<void> {
  return invoke("lsp_install", { language });
}

export function lspSend(language: string, message: string): Promise<void> {
  return invoke("lsp_send", { language, message });
}

export function lspStop(language: string): Promise<void> {
  return invoke("lsp_stop", { language });
}

/** Raw JSON, or `null` if the file was never written yet. */
export function readSettings(): Promise<string | null> {
  return invoke("read_settings");
}

export function writeSettings(content: string): Promise<void> {
  return invoke("write_settings", { content });
}

/** Raw JSON, or `null` if the file was never written yet. */
export function readWorkspacesState(): Promise<string | null> {
  return invoke("read_workspaces_state");
}

export function writeWorkspacesState(content: string): Promise<void> {
  return invoke("write_workspaces_state", { content });
}
