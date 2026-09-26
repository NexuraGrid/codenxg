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
