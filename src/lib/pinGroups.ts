import type { EditorTab } from "../state/editorStore";
import { basename, dirname, isSameOrInside } from "./paths";

/** A named set of files, per workspace, that can be opened together as pinned tabs. */
export interface PinGroup {
  id: string;
  name: string;
  /** Absolute file paths, in the order their tabs open. */
  paths: string[];
}

/** A group name as entered, trimmed; null when there's nothing left. */
export function normalizeGroupName(name: string): string | null {
  const trimmed = name.trim().replace(/\s+/g, " ");
  return trimmed ? trimmed : null;
}

export function findGroupByName(groups: PinGroup[], name: string): PinGroup | undefined {
  const key = name.toLocaleLowerCase();
  return groups.find((g) => g.name.toLocaleLowerCase() === key);
}

export interface GroupSwitchPlan {
  /** Tabs of the previous group to close: not in the new group and not dirty. */
  close: string[];
  /** The new group's files, in order (existence is checked separately). */
  open: string[];
}

/**
 * What switching from `previous` (the active group, if any) to `next` does to
 * the open tabs. Dirty tabs never close; tabs outside the previous group are
 * left alone.
 */
export function planGroupSwitch(tabs: EditorTab[], previous: PinGroup | undefined, next: PinGroup): GroupSwitchPlan {
  const keep = new Set(next.paths);
  const leaving = new Set(previous && previous.id !== next.id ? previous.paths : []);
  return {
    close: tabs.filter((t) => leaving.has(t.path) && !keep.has(t.path) && !t.isDirty).map((t) => t.path),
    open: [...next.paths],
  };
}

/**
 * Pin groups read back from disk, dropping anything malformed: the record is
 * user-editable JSON and older versions didn't write groups at all.
 */
export function sanitizePinGroups(raw: unknown): PinGroup[] {
  if (!Array.isArray(raw)) return [];
  const groups: PinGroup[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, name, paths } = item as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || !normalizeGroupName(name)) continue;
    if (groups.some((g) => g.id === id)) continue;
    const files = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === "string") : [];
    groups.push({ id, name, paths: [...new Set(files)] });
  }
  return groups;
}

/**
 * How a group's file is listed: its name, plus its folder relative to the
 * workspace root ("" at the root; the absolute folder when outside it).
 */
export function groupFileLabel(path: string, root: string | null): { name: string; dir: string } {
  const name = basename(path);
  const dir = dirname(path);
  if (dir === path || dir === root) return { name, dir: "" };
  if (root && isSameOrInside(dir, root)) return { name, dir: dir.slice(root.length + 1).replace(/\\/g, "/") };
  return { name, dir };
}
