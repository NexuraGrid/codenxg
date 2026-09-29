import type { EditorTab } from "../state/editorStore";
import { basename, dirname, isSameOrInside, rebase } from "./paths";

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

/**
 * Groups after `from` was renamed or moved to `to`: the file itself, or every
 * file under it for a folder, follows along. Unchanged groups keep their identity.
 */
export function rebaseGroupPaths(groups: PinGroup[], from: string, to: string): PinGroup[] {
  return groups.map((group) => {
    if (!group.paths.some((p) => isSameOrInside(p, from))) return group;
    const paths = group.paths.map((p) => (isSameOrInside(p, from) ? rebase(p, from, to) : p));
    return { ...group, paths: [...new Set(paths)] };
  });
}

/** Groups without `path` (and, for a folder, anything under it). */
export function removeGroupPathsUnder(groups: PinGroup[], path: string): PinGroup[] {
  return groups.map((group) =>
    group.paths.some((p) => isSameOrInside(p, path))
      ? { ...group, paths: group.paths.filter((p) => !isSameOrInside(p, path)) }
      : group,
  );
}

/**
 * Where a dragged entry lands: dropped in the gap before `insertBefore`
 * (`length` for after the last one), counted once it has left its old slot.
 */
export function dropTargetIndex(from: number, insertBefore: number): number {
  return insertBefore > from ? insertBefore - 1 : insertBefore;
}

/** `paths` with the entry at `from` moved to `to` (clamped); the same array when nothing moves. */
export function movePathTo(paths: string[], from: number, to: number): string[] {
  const target = Math.max(0, Math.min(to, paths.length - 1));
  if (from < 0 || from >= paths.length || from === target) return paths;
  const next = [...paths];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Puts a group back as it was in `snapshot` (undo): a deleted group returns
 * at `index`; an existing one gets its earlier files back in their earlier
 * order, keeping any added since at the end.
 */
export function restoreGroup(groups: PinGroup[], snapshot: PinGroup, index: number): PinGroup[] {
  const current = groups.find((g) => g.id === snapshot.id);
  if (!current) {
    const at = Math.max(0, Math.min(index, groups.length));
    return [...groups.slice(0, at), { ...snapshot, paths: [...snapshot.paths] }, ...groups.slice(at)];
  }
  const earlier = new Set(snapshot.paths);
  const paths = [...snapshot.paths, ...current.paths.filter((p) => !earlier.has(p))];
  return groups.map((g) => (g.id === snapshot.id ? { ...current, paths } : g));
}
