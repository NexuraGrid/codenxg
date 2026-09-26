export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** True for `dir` itself and anything nested under it. */
export function isSameOrInside(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`);
}

/** Moves `path` from under `from` to under `to` (after renaming `from`). */
export function rebase(path: string, from: string, to: string): string {
  return path === from ? to : to + path.slice(from.length);
}

const WINDOWS_DRIVE_URI_PATH = /^\/([A-Za-z]):(\/.*)?$/;

/**
 * Turns a `file:` URI's `.path` back into the path form this app stores
 * (tab paths, the model registry, the workspace root): on Windows that's
 * `C:\Users\...` — an upper-cased drive letter and backslashes, matching
 * what the OS/open-folder dialog gives the Rust side. `monaco.Uri.file()`
 * only forward-slashes a path when it happens to run on Windows, and a
 * language server is free to send a lower-cased drive letter (both VS Code
 * and several servers do), so a URI's `.path` can't be compared or looked up
 * against those stored paths directly — it must go through this first.
 */
export function pathFromUri(uri: { path: string }): string {
  const match = WINDOWS_DRIVE_URI_PATH.exec(uri.path);
  if (!match) return uri.path; // POSIX: already in the app's form.
  const [, drive, rest] = match;
  return `${drive.toUpperCase()}:${(rest ?? "").replace(/\//g, "\\")}`;
}
