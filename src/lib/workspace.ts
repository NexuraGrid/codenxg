import { open } from "@tauri-apps/plugin-dialog";
import { setWorkspace } from "./tauri-api";

const LAST_WORKSPACE_KEY = "code-editor:last-workspace";

export async function pickFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false });
  return typeof selected === "string" ? selected : null;
}

export function rememberWorkspace(path: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE_KEY, path);
  } catch {
    // Not fatal: the app just starts on the welcome screen next time.
  }
}

// The folder may have been moved or deleted since the last session;
// set_workspace rejects it then.
export async function restoreLastWorkspace(): Promise<string | null> {
  let path: string | null = null;
  try {
    path = localStorage.getItem(LAST_WORKSPACE_KEY);
  } catch {
    return null;
  }
  if (!path) return null;

  try {
    await setWorkspace(path);
    return path;
  } catch {
    try {
      localStorage.removeItem(LAST_WORKSPACE_KEY);
    } catch {
      // Ignore; the stale path is simply retried and rejected next launch.
    }
    return null;
  }
}
