import { create } from "zustand";
import {
  findGroupByName,
  movePathTo,
  normalizeGroupName,
  restoreGroup,
  rebaseGroupPaths,
  removeGroupPathsUnder,
  type PinGroup,
} from "../lib/pinGroups";

interface PinGroupState {
  /** The workspace these groups belong to; null until one is loaded. */
  root: string | null;
  groups: PinGroup[];
  /** The group last switched to; its tabs are the ones a switch closes. */
  activeGroupId: string | null;

  load: (root: string, groups: PinGroup[], activeGroupId: string | null) => void;
  reset: () => void;
  /**
   * Creates a group (or, if one already has that name, adds to it) and
   * returns it; null for an empty name.
   */
  createGroup: (name: string, paths?: string[]) => PinGroup | null;
  /** False when the name is empty or taken by another group. */
  renameGroup: (id: string, name: string) => boolean;
  deleteGroup: (id: string) => void;
  addFile: (id: string, path: string) => void;
  removeFile: (id: string, path: string) => void;
  /** Takes `paths` out of a group; open tabs and their pin state are untouched. */
  removeFilesFromGroup: (id: string, paths: string[]) => void;
  /** Empties a group, keeping the group itself. */
  clearGroup: (id: string) => void;
  setActiveGroup: (id: string | null) => void;
  /** Moves one of a group's files to position `toIndex` (its tab order). */
  moveFile: (id: string, path: string, toIndex: number) => void;
  /**
   * Undoes a removal or deletion: see `restoreGroup` in lib/pinGroups. A
   * deleted group that was active becomes active again if no other group is.
   */
  restoreGroup: (snapshot: PinGroup, index: number, wasActive: boolean) => void;
  /** Follows a rename or move made in the app (a folder carries its contents). */
  rebasePaths: (from: string, to: string) => void;
  /**
   * Drops a path deleted from within the app (a folder drops its contents).
   * Files deleted outside the app stay listed, shown as missing.
   */
  forgetPathsUnder: (path: string) => void;
}

let nextId = 0;
function newGroupId(): string {
  nextId += 1;
  return `g${Date.now().toString(36)}${nextId.toString(36)}`;
}

function withPaths(group: PinGroup, paths: string[]): PinGroup {
  return { ...group, paths: [...new Set([...group.paths, ...paths])] };
}

export const usePinGroupStore = create<PinGroupState>((set, get) => ({
  root: null,
  groups: [],
  activeGroupId: null,

  load: (root, groups, activeGroupId) =>
    set({ root, groups, activeGroupId: groups.some((g) => g.id === activeGroupId) ? activeGroupId : null }),

  reset: () => set({ root: null, groups: [], activeGroupId: null }),

  createGroup: (name, paths = []) => {
    const clean = normalizeGroupName(name);
    if (!clean) return null;
    const existing = findGroupByName(get().groups, clean);
    if (existing) {
      const merged = withPaths(existing, paths);
      set((state) => ({ groups: state.groups.map((g) => (g.id === existing.id ? merged : g)) }));
      return merged;
    }
    const group: PinGroup = { id: newGroupId(), name: clean, paths: [...new Set(paths)] };
    set((state) => ({ groups: [...state.groups, group] }));
    return group;
  },

  renameGroup: (id, name) => {
    const clean = normalizeGroupName(name);
    if (!clean) return false;
    const clash = findGroupByName(get().groups, clean);
    if (clash && clash.id !== id) return false;
    set((state) => ({ groups: state.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) }));
    return true;
  },

  deleteGroup: (id) =>
    set((state) => ({
      groups: state.groups.filter((g) => g.id !== id),
      activeGroupId: state.activeGroupId === id ? null : state.activeGroupId,
    })),

  addFile: (id, path) =>
    set((state) => ({ groups: state.groups.map((g) => (g.id === id ? withPaths(g, [path]) : g)) })),

  removeFile: (id, path) => get().removeFilesFromGroup(id, [path]),

  removeFilesFromGroup: (id, paths) => {
    const removing = new Set(paths);
    set((state) => ({
      groups: state.groups.map((g) => (g.id === id ? { ...g, paths: g.paths.filter((p) => !removing.has(p)) } : g)),
    }));
  },

  clearGroup: (id) =>
    set((state) => ({ groups: state.groups.map((g) => (g.id === id ? { ...g, paths: [] } : g)) })),

  setActiveGroup: (id) => set({ activeGroupId: id }),

  moveFile: (id, path, toIndex) =>
    set((state) => ({
      groups: state.groups.map((g) => {
        if (g.id !== id) return g;
        const paths = movePathTo(g.paths, g.paths.indexOf(path), toIndex);
        return paths === g.paths ? g : { ...g, paths };
      }),
    })),

  restoreGroup: (snapshot, index, wasActive) =>
    set((state) => ({
      groups: restoreGroup(state.groups, snapshot, index),
      activeGroupId: wasActive && state.activeGroupId === null ? snapshot.id : state.activeGroupId,
    })),

  rebasePaths: (from, to) => set((state) => ({ groups: rebaseGroupPaths(state.groups, from, to) })),

  forgetPathsUnder: (path) => set((state) => ({ groups: removeGroupPathsUnder(state.groups, path) })),
}));
