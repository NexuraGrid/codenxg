import { useEffect } from "react";
import { readFile, startWatcher, watchDirs } from "./tauri-api";
import { basename, dirname, isSameOrInside } from "./paths";
import { getModel, markDeletedOnDisk, reloadFromDisk, syncWithDisk } from "./monacoModelRegistry";
import { useEditorStore } from "../state/editorStore";
import { useExplorerStore } from "../state/explorerStore";
import { showDialog } from "../state/dialogStore";
import { useGitStore } from "../state/gitStore";

/**
 * Keeps the tree and open files in step with changes made outside the editor
 * (git checkout, a formatter, the terminal). Only the folders on screen are
 * watched: the root, expanded folders and the folders of open files.
 */
export function useFileWatcher(root: string): void {
  useEffect(() => {
    let started = false;
    let lastKey = "";

    function syncWatchedDirs() {
      if (!started) return;
      const dirs = watchedDirs(root);
      const key = dirs.join("\n");
      if (key === lastKey) return;
      lastKey = key;
      watchDirs(dirs).catch(console.error);
    }

    startWatcher(applyChanges)
      .then(() => {
        started = true;
        syncWatchedDirs();
      })
      .catch(console.error);

    const git = useGitStore.getState();
    git.reset();
    void git.refresh();
    // Commits or fetches made in another program while this window was away.
    const onFocus = () => git.scheduleRefresh();
    window.addEventListener("focus", onFocus);

    // Both stores change often (every keystroke marks a tab dirty); the key
    // comparison keeps that from reaching the backend.
    const unsubscribeExplorer = useExplorerStore.subscribe(syncWatchedDirs);
    const unsubscribeEditor = useEditorStore.subscribe(syncWatchedDirs);
    return () => {
      started = false;
      window.removeEventListener("focus", onFocus);
      unsubscribeExplorer();
      unsubscribeEditor();
    };
  }, [root]);
}

function watchedDirs(root: string): string[] {
  const { expanded } = useExplorerStore.getState();
  // .git itself (one level): its index and HEAD change on stage, commit and
  // checkout, including ones run from the terminal.
  const dirs = new Set([root, `${root}/.git`]);
  for (const [dir, isOpen] of Object.entries(expanded)) if (isOpen) dirs.add(dir);
  for (const tab of useEditorStore.getState().tabs) {
    if (isSameOrInside(tab.path, root)) dirs.add(dirname(tab.path));
  }
  return [...dirs].sort();
}

function applyChanges(paths: string[]): void {
  const explorer = useExplorerStore.getState();
  useGitStore.getState().scheduleRefresh();

  // A change inside a folder alters that folder's listing; a changed path that
  // is itself a loaded folder was probably removed or replaced.
  const dirs = new Set<string>();
  for (const path of paths) {
    dirs.add(dirname(path));
    if (explorer.children[path]) dirs.add(path);
  }
  for (const dir of dirs) {
    if (explorer.children[dir]) explorer.refresh(dir).catch(() => explorer.forgetPath(dir));
  }

  for (const tab of useEditorStore.getState().tabs) {
    if (paths.some((path) => isSameOrInside(tab.path, path))) void syncOpenFile(tab.path);
  }
}

async function syncOpenFile(path: string): Promise<void> {
  if (!getModel(path)) return;

  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    if (isNotFound(error)) markDeletedOnDisk(path);
    return;
  }

  if (syncWithDisk(path, text) === "conflict") void askAboutConflict(path);
}

// The Rust side reports io::Error text; ENOENT reads "(os error 2)" on every OS.
function isNotFound(error: unknown): boolean {
  return String(error).includes("(os error 2)");
}

const conflictsOnScreen = new Set<string>();

async function askAboutConflict(path: string): Promise<void> {
  if (conflictsOnScreen.has(path)) return;
  conflictsOnScreen.add(path);
  try {
    const choice = await showDialog({
      title: `${basename(path)} changed on disk`,
      message: "It was modified outside the editor while you have unsaved changes here.",
      buttons: [
        { label: "Keep my changes", value: "keep", variant: "primary" },
        { label: "Load from disk", value: "reload", variant: "danger" },
      ],
      cancelValue: "keep",
    });
    if (choice === "reload") reloadFromDisk(path);
  } finally {
    conflictsOnScreen.delete(path);
  }
}
