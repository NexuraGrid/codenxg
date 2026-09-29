import { create } from "zustand";
import { basename, isSameOrInside, rebase } from "../lib/paths";
import { languageFromPath } from "../lib/language";

export interface EditorTab {
  path: string;
  title: string;
  isDirty: boolean;
  language: string;
  /** Showing the side-by-side diff against the last commit instead of the file. */
  showDiff?: boolean;
  /**
   * A read-only view of one file's change in a past commit. Such tabs are keyed
   * `commit:<hash>:<file>`, so they never collide with the file's own tab.
   */
  commit?: { hash: string; shortHash: string; file: string; origFile: string | null };
  /**
   * A read-only view of one file's change in a stash. Such tabs are keyed
   * `stash:<index>:<file>`, so they never collide with the file's own tab.
   */
  stash?: { index: number; message: string; file: string; origFile: string | null };
  /** The Settings view, opened as a tab (Ctrl+, or the gear icon) — not a real file. */
  settings?: boolean;
  /**
   * A rendered preview of a Markdown file (Ctrl+Shift+V), keyed
   * `markdown-preview:<source>` so it never collides with the file's own tab.
   */
  markdownPreview?: { source: string };
  /**
   * A preview tab (italic title): single-clicking another file replaces it in
   * place instead of opening a new tab. Editing, saving, double-clicking or
   * pinning it makes it permanent. At most one exists per editor group.
   */
  isPreview?: boolean;
  /** Pinned tabs sort to the left and survive Close Others/Left/Right/All. */
  isPinned?: boolean;
}

/**
 * One editor group: a tab bar plus the editor showing its active tab. Groups
 * sit side by side (left to right). A path is unique within a group but may
 * be open in several groups at once; they all share one Monaco model, so
 * edits and the dirty flag are per file, not per tab.
 */
export interface EditorGroup {
  id: string;
  tabs: EditorTab[];
  activeTabPath: string | null;
}

/**
 * The UI lays groups out left/right and supports two of them. The store is an
 * array so more (or vertical) groups only need a UI, not a new model.
 */
export const MAX_EDITOR_GROUPS = 2;

// Lives here (not in lib/markdownPreview) so rebasePaths can rekey preview tabs.
export const MARKDOWN_PREVIEW_PREFIX = "markdown-preview:";

function rebaseActivePath(active: string | null, from: string, to: string): string | null {
  if (!active) return active;
  if (active.startsWith(MARKDOWN_PREVIEW_PREFIX)) {
    const source = active.slice(MARKDOWN_PREVIEW_PREFIX.length);
    return isSameOrInside(source, from) ? `${MARKDOWN_PREVIEW_PREFIX}${rebase(source, from, to)}` : active;
  }
  return isSameOrInside(active, from) ? rebase(active, from, to) : active;
}

/** Pinned tabs first, each group in its current order. */
function pinnedFirst(tabs: EditorTab[]): EditorTab[] {
  return [...tabs.filter((t) => t.isPinned), ...tabs.filter((t) => !t.isPinned)];
}

let groupCounter = 0;

function newGroup(tabs: EditorTab[] = [], activeTabPath: string | null = null): EditorGroup {
  groupCounter += 1;
  return { id: `group-${groupCounter}`, tabs, activeTabPath };
}

/** Equal widths (percentages) for `count` groups. */
export function equalGroupSizes(count: number): number[] {
  return Array.from({ length: count }, () => 100 / count);
}

// --- Per-group reducers: each returns the very same group when nothing changes.

function addTabToGroup(group: EditorGroup, tab: EditorTab): EditorGroup {
  if (group.tabs.some((t) => t.path === tab.path)) {
    return {
      ...group,
      activeTabPath: tab.path,
      tabs: group.tabs.map((t) =>
        t.path === tab.path
          ? { ...t, showDiff: tab.showDiff ?? false, isPreview: Boolean(t.isPreview && tab.isPreview) }
          : t,
      ),
    };
  }
  const isPinned = Boolean(tab.isPinned);
  const opened = { ...tab, isPinned, isPreview: Boolean(tab.isPreview) && !isPinned };
  if (isPinned) {
    // Restored pinned tabs: keep them inside the pinned group.
    const tabs = [...group.tabs];
    tabs.splice(tabs.filter((t) => t.isPinned).length, 0, opened);
    return { ...group, tabs, activeTabPath: tab.path };
  }
  const previewIndex = opened.isPreview ? group.tabs.findIndex((t) => t.isPreview) : -1;
  if (previewIndex !== -1) {
    const tabs = [...group.tabs];
    tabs[previewIndex] = opened;
    return { ...group, tabs, activeTabPath: tab.path };
  }
  return { ...group, tabs: [...group.tabs, opened], activeTabPath: tab.path };
}

function makePermanentInGroup(group: EditorGroup, path: string): EditorGroup {
  const tab = group.tabs.find((t) => t.path === path);
  if (!tab?.isPreview) return group;
  return { ...group, tabs: group.tabs.map((t) => (t === tab ? { ...t, isPreview: false } : t)) };
}

function setPinnedInGroup(group: EditorGroup, path: string, pinned: boolean): EditorGroup {
  const tab = group.tabs.find((t) => t.path === path);
  if (!tab || Boolean(tab.isPinned) === pinned) return group;
  const updated = { ...tab, isPinned: pinned, isPreview: false };
  const rest = group.tabs.filter((t) => t !== tab);
  const pinnedCount = rest.filter((t) => t.isPinned).length;
  // A newly pinned tab goes last among the pinned; an unpinned one goes
  // first among the rest — both land right at the group boundary.
  const tabs = pinnedFirst(rest);
  tabs.splice(pinnedCount, 0, updated);
  return { ...group, tabs };
}

function closeTabsInGroup(group: EditorGroup, closing: ReadonlySet<string>, preferredActive?: string): EditorGroup {
  if (!group.tabs.some((t) => closing.has(t.path))) return group;
  const tabs = group.tabs.filter((t) => !closing.has(t.path));
  if (group.activeTabPath && !closing.has(group.activeTabPath)) return { ...group, tabs };
  const fallback = tabs.find((t) => t.path === preferredActive) ?? tabs[tabs.length - 1];
  return { ...group, tabs, activeTabPath: fallback?.path ?? null };
}

function setDirtyInGroup(group: EditorGroup, path: string, isDirty: boolean): EditorGroup {
  const tab = group.tabs.find((t) => t.path === path);
  if (!tab || tab.isDirty === isDirty) return group;
  // An edited preview tab becomes permanent, same as VS Code.
  const isPreview = isDirty ? false : tab.isPreview;
  return { ...group, tabs: group.tabs.map((t) => (t === tab ? { ...t, isDirty, isPreview } : t)) };
}

function rebaseGroup(group: EditorGroup, from: string, to: string): EditorGroup {
  return {
    ...group,
    tabs: group.tabs.map((t) => {
      if (t.markdownPreview) {
        if (!isSameOrInside(t.markdownPreview.source, from)) return t;
        const source = rebase(t.markdownPreview.source, from, to);
        return { ...t, path: `${MARKDOWN_PREVIEW_PREFIX}${source}`, title: `Preview ${basename(source)}`, markdownPreview: { source } };
      }
      if (!isSameOrInside(t.path, from)) return t;
      const path = rebase(t.path, from, to);
      return { ...t, path, title: basename(path), language: languageFromPath(path) };
    }),
    activeTabPath: rebaseActivePath(group.activeTabPath, from, to),
  };
}

// --- Whole-state helpers ------------------------------------------------------

type LayoutSlice = Pick<EditorState, "groups" | "activeGroupId" | "groupSizes" | "tabs" | "activeTabPath">;

/**
 * The layout fields for `groups`, with `tabs`/`activeTabPath` projected from
 * the active group. Empty groups are dropped (one always remains); focus that
 * lands on a dropped group moves to its neighbour.
 */
function layout(groups: EditorGroup[], activeGroupId: string, groupSizes: number[]): LayoutSlice {
  let kept = groups.length > 1 ? groups.filter((g) => g.tabs.length > 0) : groups;
  if (kept.length === 0) kept = [groups.find((g) => g.id === activeGroupId) ?? groups[0]];

  let active = kept.find((g) => g.id === activeGroupId);
  if (!active) {
    const index = groups.findIndex((g) => g.id === activeGroupId);
    const survivorsBefore = groups.slice(0, Math.max(index, 0)).filter((g) => kept.includes(g));
    active = survivorsBefore[survivorsBefore.length - 1] ?? kept[0];
  }
  const sizes = groupSizes.length === kept.length ? groupSizes : equalGroupSizes(kept.length);
  return { groups: kept, activeGroupId: active.id, groupSizes: sizes, tabs: active.tabs, activeTabPath: active.activeTabPath };
}

/** Applies `update` to one group; returns `state` itself when nothing changed. */
function updateGroup(
  state: EditorState,
  groupId: string,
  update: (group: EditorGroup) => EditorGroup,
  focus = false,
): Partial<EditorState> | EditorState {
  let changed = false;
  const groups = state.groups.map((g) => {
    if (g.id !== groupId) return g;
    const next = update(g);
    if (next !== g) changed = true;
    return next;
  });
  const focusChanges = focus && state.activeGroupId !== groupId && state.groups.some((g) => g.id === groupId);
  if (!changed && !focusChanges) return state;
  return layout(changed ? groups : state.groups, focusChanges ? groupId : state.activeGroupId, state.groupSizes);
}

/** Applies `update` to every group (file-level changes: dirty flag, renames). */
function updateAllGroups(state: EditorState, update: (group: EditorGroup) => EditorGroup): Partial<EditorState> | EditorState {
  let changed = false;
  const groups = state.groups.map((g) => {
    const next = update(g);
    if (next !== g) changed = true;
    return next;
  });
  return changed ? layout(groups, state.activeGroupId, state.groupSizes) : state;
}

/** Every open tab across all groups (a path open in two groups appears twice). */
export function allTabs(state: Pick<EditorState, "groups">): EditorTab[] {
  return state.groups.flatMap((g) => g.tabs);
}

/** One tab per open path, in group order — e.g. for "save changes?" prompts. */
export function uniqueOpenTabs(state: Pick<EditorState, "groups">): EditorTab[] {
  const seen = new Set<string>();
  return allTabs(state).filter((t) => !seen.has(t.path) && Boolean(seen.add(t.path)));
}

/** Whether `path` is open in any group other than `exceptGroupId`. */
export function isPathOpen(state: Pick<EditorState, "groups">, path: string, exceptGroupId?: string): boolean {
  return state.groups.some((g) => g.id !== exceptGroupId && g.tabs.some((t) => t.path === path));
}

export function findGroup(state: Pick<EditorState, "groups">, groupId: string): EditorGroup | undefined {
  return state.groups.find((g) => g.id === groupId);
}

/**
 * The group "to the side" of the active one: its right neighbour, or — when
 * it is the rightmost and no more groups fit — its left one. Null when a new
 * group should be created instead (or there is nowhere to go).
 */
export function sideGroupId(state: Pick<EditorState, "groups" | "activeGroupId">): string | null {
  const index = state.groups.findIndex((g) => g.id === state.activeGroupId);
  const right = state.groups[index + 1];
  if (right) return right.id;
  if (state.groups.length < MAX_EDITOR_GROUPS) return null;
  return state.groups[index - 1]?.id ?? null;
}

interface EditorState {
  /** Left to right; never empty. Only a lone group may have no tabs. */
  groups: EditorGroup[];
  /** The focused group: opening files, commands and pin groups act on it. */
  activeGroupId: string;
  /** Each group's width in percent, in `groups` order. */
  groupSizes: number[];
  /** The active group's tabs (kept in sync with `groups`). */
  tabs: EditorTab[];
  /** The active group's active tab (kept in sync with `groups`). */
  activeTabPath: string | null;
  /**
   * Opens (or focuses) a tab in `groupId` (default: the active group) without
   * moving focus to that group; `tab.showDiff` picks the file or its diff
   * view. With `tab.isPreview`, a new tab takes the group's preview slot; a
   * non-preview open of an already-open preview tab makes it permanent.
   */
  addTab: (tab: EditorTab, groupId?: string) => void;
  /** Turns a preview tab into a normal one — in `groupId`, or in every group. */
  makePermanent: (path: string, groupId?: string) => void;
  /** Pins/unpins a tab, moving it to the end of the pinned group or right after it. */
  setPinned: (path: string, pinned: boolean, groupId?: string) => void;
  setShowDiff: (path: string, showDiff: boolean, groupId?: string) => void;
  /**
   * Closes several tabs of one group (default: the active one); if its active
   * tab goes, `preferredActive` takes over. An emptied group is removed
   * unless it is the only one.
   */
  closeTabs: (paths: string[], preferredActive?: string, groupId?: string) => void;
  /** Closes `paths` in every group (the file was deleted). */
  closeTabsEverywhere: (paths: string[]) => void;
  /** Activates a tab in `groupId` (default: the active group); passing a group also focuses it. */
  setActiveTab: (path: string, groupId?: string) => void;
  /** Marks a file dirty/clean in every group that shows it. */
  setDirty: (path: string, isDirty: boolean) => void;
  /** Points tabs at or under a renamed file/folder to their new paths, in every group. */
  rebasePaths: (from: string, to: string) => void;
  focusGroup: (groupId: string) => void;
  /**
   * Inserts a group right after `afterGroupId` (default: the active one),
   * optionally opening `tab` in it; focus stays where it is. Returns the new
   * group's id, or null once MAX_EDITOR_GROUPS exist.
   */
  addGroup: (afterGroupId?: string, tab?: EditorTab) => string | null;
  /**
   * Moves a tab from one group to another (replacing a copy already there),
   * activates it there and focuses that group. An emptied source group is removed.
   */
  moveTab: (path: string, fromGroupId: string, toGroupId: string) => void;
  setGroupSizes: (sizes: number[]) => void;
  reset: () => void;
}

function initialLayout(): LayoutSlice {
  const group = newGroup();
  return { groups: [group], activeGroupId: group.id, groupSizes: [100], tabs: group.tabs, activeTabPath: null };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  ...initialLayout(),

  addTab: (tab, groupId) => set((state) => updateGroup(state, groupId ?? state.activeGroupId, (g) => addTabToGroup(g, tab))),

  makePermanent: (path, groupId) =>
    set((state) =>
      groupId
        ? updateGroup(state, groupId, (g) => makePermanentInGroup(g, path))
        : updateAllGroups(state, (g) => makePermanentInGroup(g, path)),
    ),

  setPinned: (path, pinned, groupId) =>
    set((state) => updateGroup(state, groupId ?? state.activeGroupId, (g) => setPinnedInGroup(g, path, pinned))),

  closeTabs: (paths, preferredActive, groupId) =>
    set((state) => updateGroup(state, groupId ?? state.activeGroupId, (g) => closeTabsInGroup(g, new Set(paths), preferredActive))),

  closeTabsEverywhere: (paths) =>
    set((state) => {
      const closing = new Set(paths);
      return updateAllGroups(state, (g) => closeTabsInGroup(g, closing));
    }),

  setActiveTab: (path, groupId) =>
    set((state) =>
      updateGroup(
        state,
        groupId ?? state.activeGroupId,
        (g) => (g.activeTabPath === path ? g : { ...g, activeTabPath: path }),
        groupId !== undefined,
      ),
    ),

  setShowDiff: (path, showDiff, groupId) =>
    set((state) =>
      updateGroup(state, groupId ?? state.activeGroupId, (g) =>
        g.tabs.some((t) => t.path === path && Boolean(t.showDiff) !== showDiff)
          ? { ...g, tabs: g.tabs.map((t) => (t.path === path ? { ...t, showDiff } : t)) }
          : g,
      ),
    ),

  rebasePaths: (from, to) => set((state) => updateAllGroups(state, (g) => rebaseGroup(g, from, to))),

  focusGroup: (groupId) => set((state) => updateGroup(state, groupId, (g) => g, true)),

  addGroup: (afterGroupId, tab) => {
    const state = get();
    if (state.groups.length >= MAX_EDITOR_GROUPS) return null;
    const index = state.groups.findIndex((g) => g.id === (afterGroupId ?? state.activeGroupId));
    const group = newGroup();
    const filled = tab ? addTabToGroup(group, tab) : group;
    const groups = [...state.groups];
    groups.splice(index === -1 ? groups.length : index + 1, 0, filled);
    // Bypasses `layout`'s pruning: the caller fills an empty group right away.
    const active = groups.find((g) => g.id === state.activeGroupId) ?? groups[0];
    set({
      groups,
      activeGroupId: active.id,
      groupSizes: equalGroupSizes(groups.length),
      tabs: active.tabs,
      activeTabPath: active.activeTabPath,
    });
    return filled.id;
  },

  moveTab: (path, fromGroupId, toGroupId) =>
    set((state) => {
      if (fromGroupId === toGroupId) return state;
      const source = findGroup(state, fromGroupId);
      const target = findGroup(state, toGroupId);
      const tab = source?.tabs.find((t) => t.path === path);
      if (!source || !target || !tab) return state;
      const groups = state.groups.map((g) => {
        if (g === source) return closeTabsInGroup(g, new Set([path]));
        if (g !== target) return g;
        const existing = g.tabs.find((t) => t.path === path);
        if (existing) return { ...g, activeTabPath: path };
        return addTabToGroup(g, tab);
      });
      return layout(groups, toGroupId, state.groupSizes);
    }),

  setGroupSizes: (sizes) =>
    set((state) => {
      if (sizes.length !== state.groups.length || sizes.some((s) => !Number.isFinite(s) || s <= 0)) return state;
      if (sizes.every((s, i) => Math.abs(s - state.groupSizes[i]) < 0.01)) return state;
      return { groupSizes: [...sizes] };
    }),

  reset: () => set(initialLayout()),

  // Called on every keystroke: bail out when nothing changes so subscribers
  // (tabs, editor) don't re-render per character typed.
  setDirty: (path, isDirty) => set((state) => updateAllGroups(state, (g) => setDirtyInGroup(g, path, isDirty))),
}));
