import { readDir, readWorkspacesState, writeWorkspacesState } from "./tauri-api";
import { dirname } from "./paths";
import { useEditorStore } from "../state/editorStore";
import { getActiveEditor } from "./editorInstance";
import { pathOfModel } from "./monacoModelRegistry";
import { allViewStates, setViewState } from "./tabViewState";
import { buildWorkspaceRecord, planRestoreTabs, readPinGroups, upsertWorkspaceState, type WorkspacesState } from "./persistedTabs";
import { usePinGroupStore } from "../state/pinGroupStore";

const SAVE_DEBOUNCE_MS = 500;

let cache: WorkspacesState | null = null;
let loading: Promise<WorkspacesState> | null = null;

function safeParse(raw: string): WorkspacesState | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as WorkspacesState) : null;
  } catch {
    return null;
  }
}

async function ensureCache(): Promise<WorkspacesState> {
  if (cache) return cache;
  if (!loading) {
    loading = readWorkspacesState()
      .then((raw) => (raw ? (safeParse(raw) ?? {}) : {}))
      .catch(() => ({}));
  }
  cache = await loading;
  return cache;
}

/** Lists each tab's parent folder once (no file reads), so a moved/deleted file is skipped silently. */
export async function existingPaths(paths: string[]): Promise<Set<string>> {
  const byDir = new Map<string, string[]>();
  for (const path of paths) {
    const dir = dirname(path);
    const list = byDir.get(dir);
    if (list) list.push(path);
    else byDir.set(dir, [path]);
  }

  const existing = new Set<string>();
  await Promise.all(
    [...byDir.entries()].map(async ([dir, list]) => {
      let entries;
      try {
        entries = await readDir(dir);
      } catch {
        return; // the folder itself is gone: none of `list` survive
      }
      const files = new Set(entries.filter((e) => !e.isDir).map((e) => e.path));
      for (const path of list) if (files.has(path)) existing.add(path);
    }),
  );
  return existing;
}

/** Reopens a workspace's remembered tabs the same way a user click would: through addTab. */
export async function restoreWorkspaceTabs(root: string): Promise<void> {
  const state = await ensureCache();
  const record = state[root];
  const pins = readPinGroups(record);
  usePinGroupStore.getState().load(root, pins.groups, pins.activeGroupId);
  if (!record || record.tabs.length === 0) return;

  const existing = await existingPaths(record.tabs.map((t) => t.path));
  const plan = planRestoreTabs(record, existing);
  if (plan.tabsToOpen.length === 0) return;

  for (const tab of plan.tabsToOpen) useEditorStore.getState().addTab(tab);
  for (const [path, viewState] of plan.viewStates) setViewState(path, viewState);
  if (plan.activePath) useEditorStore.getState().setActiveTab(plan.activePath);
}

/** Best-effort: refreshes the cache for whichever tab is on screen right now. */
function captureActiveViewState(): void {
  const editor = getActiveEditor();
  const activePath = useEditorStore.getState().activeTabPath;
  if (!editor || !activePath) return;
  const model = editor.getModel();
  if (!model || pathOfModel(model) !== activePath) return;
  try {
    const state = editor.saveViewState();
    if (state) setViewState(activePath, state);
  } catch {
    // Not fatal: the tab just reopens without a remembered cursor position.
  }
}

async function flushWorkspaceTabs(root: string): Promise<void> {
  captureActiveViewState();
  const state = await ensureCache();
  const { tabs, activeTabPath } = useEditorStore.getState();
  // Until restore has loaded this workspace's groups, keep the saved ones.
  const pinStore = usePinGroupStore.getState();
  const pins = pinStore.root === root ? pinStore : readPinGroups(state[root]);
  const record = buildWorkspaceRecord(tabs, activeTabPath, allViewStates(), Date.now(), pins);
  const next = upsertWorkspaceState(state, root, record);
  cache = next;
  try {
    await writeWorkspacesState(JSON.stringify(next));
  } catch {
    // Not fatal: tabs just won't be remembered next launch.
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Debounced save — call on every tab list / active tab change. */
export function scheduleSaveWorkspaceTabs(root: string): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushWorkspaceTabs(root), SAVE_DEBOUNCE_MS);
}

/**
 * Drops a pending debounced save without flushing it. Needed when switching
 * workspaces: `useEditorStore` is a single global store, so a save scheduled
 * for the outgoing root that fires after the switch would read the *new*
 * workspace's tabs and corrupt the outgoing one's remembered record.
 */
export function cancelScheduledSave(): void {
  clearTimeout(saveTimer);
}

/** Immediate save, used right before the window closes. */
export function flushWorkspaceTabsNow(root: string): Promise<void> {
  clearTimeout(saveTimer);
  return flushWorkspaceTabs(root);
}
