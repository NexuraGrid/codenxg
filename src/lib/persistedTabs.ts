import { basename } from "./paths";
import { languageFromPath } from "./language";
import { MAX_EDITOR_GROUPS, type EditorTab } from "../state/editorStore";
import { sanitizePinGroups, type PinGroup } from "./pinGroups";

export interface PersistedTab {
  path: string;
  showDiff?: boolean;
  /** Absent in records saved before pinning existed; read as unpinned. */
  isPinned?: boolean;
  /** Monaco's own `ICodeEditorViewState`, opaque here — best-effort restore only. */
  viewState?: unknown;
}

/** One editor group's remembered tabs. */
export interface PersistedGroup {
  tabs: PersistedTab[];
  activeTabPath: string | null;
}

export interface WorkspaceTabsRecord {
  /**
   * The first (leftmost) editor group — the whole record before split editor
   * groups existed, and still all an older build reads back.
   */
  tabs: PersistedTab[];
  activeTabPath: string | null;
  /** Every editor group, left to right; written only when there are two or more. */
  editorGroups?: PersistedGroup[];
  /** Index into `editorGroups` of the focused group. */
  activeEditorGroup?: number;
  /** Each group's width in percent, in `editorGroups` order. */
  editorGroupSizes?: number[];
  /** Epoch ms; used only to evict the least-recently-used workspace once capped. */
  lastAccessed: number;
  /** Absent in records saved before pin groups existed; read as none. */
  pinGroups?: PinGroup[];
  activePinGroup?: string | null;
}

export interface PinGroupsSnapshot {
  groups: PinGroup[];
  activeGroupId: string | null;
}

export type WorkspacesState = Record<string, WorkspaceTabsRecord>;

export const MAX_REMEMBERED_WORKSPACES = 20;

/** A tab worth remembering across restarts: a real file, not a synthetic view. */
export function isPersistableTab(tab: EditorTab): boolean {
  return !tab.commit && !tab.stash && !tab.settings && !tab.markdownPreview;
}

/** One group's persistable tabs (real files only) and their view states. */
export function buildGroupRecord(
  tabs: EditorTab[],
  activeTabPath: string | null,
  viewStates: ReadonlyMap<string, unknown>,
): PersistedGroup {
  const persistable = tabs.filter(isPersistableTab);
  return {
    tabs: persistable.map((tab) => {
      const viewState = viewStates.get(tab.path);
      return {
        path: tab.path,
        ...(tab.showDiff ? { showDiff: true } : {}),
        ...(tab.isPinned ? { isPinned: true } : {}),
        ...(viewState !== undefined ? { viewState } : {}),
      };
    }),
    activeTabPath: persistable.some((t) => t.path === activeTabPath) ? activeTabPath : null,
  };
}

/** Builds the record to persist for one workspace from its current (single group's) tabs. */
export function buildWorkspaceRecord(
  tabs: EditorTab[],
  activeTabPath: string | null,
  viewStates: ReadonlyMap<string, unknown>,
  now: number,
  pins: PinGroupsSnapshot = { groups: [], activeGroupId: null },
): WorkspaceTabsRecord {
  return {
    ...buildGroupRecord(tabs, activeTabPath, viewStates),
    lastAccessed: now,
    ...(pins.groups.length > 0 ? { pinGroups: pins.groups, activePinGroup: pins.activeGroupId } : {}),
  };
}

export interface EditorGroupSnapshot {
  tabs: EditorTab[];
  activeTabPath: string | null;
  viewStates: ReadonlyMap<string, unknown>;
}

export interface EditorLayoutSnapshot {
  /** Left to right; at least one. */
  groups: EditorGroupSnapshot[];
  activeIndex: number;
  sizes: number[];
}

/**
 * Builds the record for a workspace with (possibly) several editor groups.
 * `tabs`/`activeTabPath` always hold the first group, so a single group
 * writes exactly what builds without editor groups wrote.
 */
export function buildLayoutRecord(
  layout: EditorLayoutSnapshot,
  now: number,
  pins?: PinGroupsSnapshot,
): WorkspaceTabsRecord {
  const [first] = layout.groups;
  const record = buildWorkspaceRecord(first.tabs, first.activeTabPath, first.viewStates, now, pins);
  if (layout.groups.length < 2) return record;
  return {
    ...record,
    editorGroups: layout.groups.map((g) => buildGroupRecord(g.tabs, g.activeTabPath, g.viewStates)),
    activeEditorGroup: layout.activeIndex,
    editorGroupSizes: layout.sizes,
  };
}

/** A record's pin groups, tolerating records without any (or with junk). */
export function readPinGroups(record: WorkspaceTabsRecord | undefined): PinGroupsSnapshot {
  const groups = sanitizePinGroups(record?.pinGroups);
  const active = record?.activePinGroup;
  return { groups, activeGroupId: groups.some((g) => g.id === active) ? (active as string) : null };
}

/** Caps `state` to the `max` most recently accessed workspaces; `root` is always kept. */
export function upsertWorkspaceState(
  state: WorkspacesState,
  root: string,
  record: WorkspaceTabsRecord,
  max: number = MAX_REMEMBERED_WORKSPACES,
): WorkspacesState {
  const next: WorkspacesState = { ...state, [root]: record };
  const roots = Object.keys(next);
  if (roots.length <= max) return next;

  const oldest = roots
    .filter((r) => r !== root)
    .sort((a, b) => next[a].lastAccessed - next[b].lastAccessed)
    .slice(0, roots.length - max);
  for (const r of oldest) delete next[r];
  return next;
}

export interface RestorePlan {
  tabsToOpen: EditorTab[];
  activePath: string | null;
  viewStates: Map<string, unknown>;
}

/**
 * Decides which persisted tabs are still worth reopening. `existingPaths` is
 * checked beforehand (a directory listing, not a per-file read), so a moved or
 * deleted file is skipped silently instead of opening a broken tab.
 */
export function planRestoreTabs(
  record: WorkspaceTabsRecord | undefined,
  existingPaths: ReadonlySet<string>,
): RestorePlan {
  if (!record) return { tabsToOpen: [], activePath: null, viewStates: new Map() };

  const surviving = record.tabs.filter((t) => existingPaths.has(t.path));
  const tabsToOpen: EditorTab[] = surviving.map((t) => ({
    path: t.path,
    title: basename(t.path),
    isDirty: false,
    language: languageFromPath(t.path),
    showDiff: t.showDiff ?? false,
    // Preview status isn't persisted: every restored tab comes back permanent.
    isPinned: t.isPinned === true,
  }));

  const viewStates = new Map<string, unknown>();
  for (const t of surviving) if (t.viewState !== undefined) viewStates.set(t.path, t.viewState);

  const activePath =
    record.activeTabPath && surviving.some((t) => t.path === record.activeTabPath)
      ? record.activeTabPath
      : (surviving[surviving.length - 1]?.path ?? null);

  return { tabsToOpen, activePath, viewStates };
}

export interface LayoutRestorePlan {
  /** Left to right; never empty (a lone group may have nothing to open). */
  groups: RestorePlan[];
  activeIndex: number;
  /** Null: split evenly (none saved, or they no longer match the groups). */
  sizes: number[] | null;
}

/** A record's editor groups, tolerating hand-edited junk; null when it has none. */
function readEditorGroups(record: WorkspaceTabsRecord): PersistedGroup[] | null {
  const raw: unknown = record.editorGroups;
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const groups: PersistedGroup[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { tabs, activeTabPath } = item as Record<string, unknown>;
    if (!Array.isArray(tabs)) continue;
    groups.push({
      tabs: tabs.filter(
        (t): t is PersistedTab => Boolean(t) && typeof t === "object" && typeof (t as PersistedTab).path === "string",
      ),
      activeTabPath: typeof activeTabPath === "string" ? activeTabPath : null,
    });
  }
  return groups.length > 0 ? groups : null;
}

/**
 * planRestoreTabs for every remembered editor group. A record from before
 * editor groups existed is one group. Groups left with nothing to reopen are
 * dropped (focus and sizes follow), and at most MAX_EDITOR_GROUPS come back.
 */
export function planRestoreLayout(
  record: WorkspaceTabsRecord | undefined,
  existingPaths: ReadonlySet<string>,
): LayoutRestorePlan {
  const saved = record ? readEditorGroups(record) : null;
  if (!record || !saved) return { groups: [planRestoreTabs(record, existingPaths)], activeIndex: 0, sizes: null };

  const plans = saved.map((g) => planRestoreTabs({ ...g, lastAccessed: record.lastAccessed }, existingPaths));
  const keptIndexes = plans
    .map((plan, index) => (plan.tabsToOpen.length > 0 ? index : -1))
    .filter((index) => index !== -1)
    .slice(0, MAX_EDITOR_GROUPS);
  if (keptIndexes.length === 0) return { groups: [plans[0]], activeIndex: 0, sizes: null };

  const savedActive = typeof record.activeEditorGroup === "number" ? record.activeEditorGroup : 0;
  const activeIndex = Math.max(0, keptIndexes.indexOf(savedActive));
  const rawSizes: unknown = record.editorGroupSizes;
  const sizesValid =
    keptIndexes.length === saved.length &&
    Array.isArray(rawSizes) &&
    rawSizes.length === saved.length &&
    rawSizes.every((s) => typeof s === "number" && Number.isFinite(s) && s > 0);
  const sizes = sizesValid ? normalizeSizes(rawSizes as number[]) : null;

  return { groups: keptIndexes.map((i) => plans[i]), activeIndex, sizes };
}

function normalizeSizes(sizes: number[]): number[] {
  const total = sizes.reduce((sum, s) => sum + s, 0);
  return sizes.map((s) => (s / total) * 100);
}

/** Every distinct file path a record remembers, across all its editor groups. */
export function rememberedPaths(record: WorkspaceTabsRecord): string[] {
  const groups = readEditorGroups(record) ?? [{ tabs: Array.isArray(record.tabs) ? record.tabs : [], activeTabPath: null }];
  return [...new Set(groups.flatMap((g) => g.tabs.map((t) => t.path)))];
}
