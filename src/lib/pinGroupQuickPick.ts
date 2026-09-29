import { fuzzyMatch, matchPath } from "./fuzzy";
import { groupFileLabel, type PinGroup } from "./pinGroups";

/**
 * The "Pin Groups" quick pick: step 1 picks a group, step 2 one of its files.
 * Pure state so the keyboard flow is testable without a DOM.
 */
export interface QuickPickState {
  /** null while picking a group (step 1); the group being browsed in step 2. */
  groupId: string | null;
  query: string;
  selected: number;
  /** Step 1's filter and selection, restored on going back to it. */
  groupQuery: string;
  groupSelected: number;
}

/** Starts at step 1, or straight at step 2 for `groupId` (when it exists). */
export function initialQuickPick(groups: PinGroup[], groupId: string | null = null): QuickPickState {
  const index = groupId ? groups.findIndex((g) => g.id === groupId) : -1;
  return {
    groupId: index === -1 ? null : groupId,
    query: "",
    selected: 0,
    groupQuery: "",
    groupSelected: Math.max(0, index),
  };
}

/** The id of the Nth group (1-based), as Ctrl+Alt+N targets it; null when there's none. */
export function nthGroupId(groups: PinGroup[], n: number): string | null {
  return groups[n - 1]?.id ?? null;
}

export interface GroupPickItem {
  group: PinGroup;
  indices: number[];
}

/** Groups whose name fuzzy-matches `query`, best first; all of them, in order, for an empty query. */
export function filterGroups(groups: PinGroup[], query: string): GroupPickItem[] {
  const q = query.replace(/\s+/g, "");
  if (!q) return groups.map((group) => ({ group, indices: [] }));
  const scored: (GroupPickItem & { score: number })[] = [];
  for (const group of groups) {
    const match = fuzzyMatch(q, group.name);
    if (match) scored.push({ group, indices: match.indices, score: match.score });
  }
  // Array#sort is stable: equal scores keep the groups' own order.
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ group, indices }) => ({ group, indices }));
}

export interface FilePickItem {
  path: string;
  name: string;
  dir: string;
  nameIndices: number[];
  dirIndices: number[];
}

/** A group's files matching `query` (by name, then folder), best first; in group order when empty. */
export function filterGroupFiles(group: PinGroup, root: string | null, query: string): FilePickItem[] {
  const q = query.replace(/\s+/g, "");
  const items = group.paths.map((path) => ({ path, ...groupFileLabel(path, root) }));
  if (!q) return items.map((item) => ({ ...item, nameIndices: [], dirIndices: [] }));
  const scored: (FilePickItem & { score: number })[] = [];
  for (const item of items) {
    const match = matchPath(q, item.dir, item.name);
    if (match) scored.push({ ...item, ...match });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map(({ score: _score, ...item }) => item);
}

export function setQuickPickQuery(state: QuickPickState, query: string): QuickPickState {
  return { ...state, query, selected: 0 };
}

/** Step 1 → step 2 for `groupId`, remembering step 1's filter and selection. */
export function enterGroup(state: QuickPickState, groupId: string): QuickPickState {
  return { groupId, query: "", selected: 0, groupQuery: state.query, groupSelected: state.selected };
}

/** Step 2 → step 1, as it was left. */
export function backToGroups(state: QuickPickState): QuickPickState {
  return { ...state, groupId: null, query: state.groupQuery, selected: state.groupSelected };
}

export type QuickPickCommand = { type: "close" } | { type: "openFile"; groupId: string; path: string };

export interface QuickPickKeyResult {
  state: QuickPickState;
  command: QuickPickCommand | null;
  /** False when the key isn't the quick pick's (e.g. Backspace deleting text): leave it to the input. */
  handled: boolean;
}

/**
 * What a key does. `ids` are the visible rows in order: group ids in step 1,
 * file paths in step 2.
 */
export function quickPickKey(state: QuickPickState, key: string, ids: readonly string[]): QuickPickKeyResult {
  const done = (next: QuickPickState, command: QuickPickCommand | null = null): QuickPickKeyResult => ({
    state: next,
    command,
    handled: true,
  });
  const selected = Math.min(state.selected, Math.max(0, ids.length - 1));

  switch (key) {
    case "ArrowDown":
      return done(ids.length ? { ...state, selected: (selected + 1) % ids.length } : state);
    case "ArrowUp":
      return done(ids.length ? { ...state, selected: (selected - 1 + ids.length) % ids.length } : state);
    case "Enter": {
      const id = ids[selected];
      if (id === undefined) return done(state);
      if (state.groupId === null) return done(enterGroup({ ...state, selected }, id));
      return done(state, { type: "openFile", groupId: state.groupId, path: id });
    }
    case "Escape":
      return state.groupId === null ? done(state, { type: "close" }) : done(backToGroups(state));
    case "Backspace":
      if (state.groupId !== null && state.query === "") return done(backToGroups(state));
      return { state, command: null, handled: false };
    default:
      return { state, command: null, handled: false };
  }
}

export interface HotkeyEventLike {
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** AltGr, which Windows reports as Ctrl+Alt: typing `@`, `#`, `|`… must not trigger this. */
  altGraph?: boolean;
}

/**
 * Ctrl+Alt+P (Cmd+Alt+P on macOS) opens the quick pick at step 1; Ctrl+Alt+1…9
 * at step 2 for that group. Matched by physical key, since Alt changes the
 * character produced (macOS turns Alt+P into "π").
 */
export function matchQuickPickHotkey(event: HotkeyEventLike): { nth: number | null } | null {
  if (!(event.ctrlKey || event.metaKey) || !event.altKey || event.shiftKey || event.altGraph) return null;
  if (event.code === "KeyP") return { nth: null };
  const digit = /^Digit([1-9])$/.exec(event.code);
  return digit ? { nth: Number(digit[1]) } : null;
}

export function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

/** How the quick pick's shortcut reads on this platform. */
export function quickPickShortcutLabel(mac = isMacPlatform(), key = "P"): string {
  return mac ? `⌘⌥${key}` : `Ctrl+Alt+${key}`;
}
