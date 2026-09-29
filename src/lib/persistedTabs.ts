import { basename } from "./paths";
import { languageFromPath } from "./language";
import type { EditorTab } from "../state/editorStore";

export interface PersistedTab {
  path: string;
  showDiff?: boolean;
  /** Absent in records saved before pinning existed; read as unpinned. */
  isPinned?: boolean;
  /** Monaco's own `ICodeEditorViewState`, opaque here — best-effort restore only. */
  viewState?: unknown;
}

export interface WorkspaceTabsRecord {
  tabs: PersistedTab[];
  activeTabPath: string | null;
  /** Epoch ms; used only to evict the least-recently-used workspace once capped. */
  lastAccessed: number;
}

export type WorkspacesState = Record<string, WorkspaceTabsRecord>;

export const MAX_REMEMBERED_WORKSPACES = 20;

/** A tab worth remembering across restarts: a real file, not a synthetic view. */
export function isPersistableTab(tab: EditorTab): boolean {
  return !tab.commit && !tab.stash && !tab.settings;
}

/** Builds the record to persist for one workspace from its current tabs. */
export function buildWorkspaceRecord(
  tabs: EditorTab[],
  activeTabPath: string | null,
  viewStates: ReadonlyMap<string, unknown>,
  now: number,
): WorkspaceTabsRecord {
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
    lastAccessed: now,
  };
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
