import { describe, expect, it } from "vitest";
import {
  buildWorkspaceRecord,
  planRestoreTabs,
  upsertWorkspaceState,
  type WorkspaceTabsRecord,
  type WorkspacesState,
} from "../persistedTabs";
import type { EditorTab } from "../../state/editorStore";

function tab(overrides: Partial<EditorTab> = {}): EditorTab {
  return { path: "/a.ts", title: "a.ts", isDirty: false, language: "typescript", ...overrides };
}

describe("buildWorkspaceRecord", () => {
  it("keeps only real file tabs", () => {
    const tabs = [
      tab({ path: "/a.ts" }),
      tab({ path: "/b.ts", commit: { hash: "h", shortHash: "h", file: "b", origFile: null } }),
      tab({ path: "/c.ts", stash: { index: 0, message: "m", file: "c", origFile: null } }),
      tab({ path: "settings:app", settings: true }),
    ];
    const record = buildWorkspaceRecord(tabs, "/a.ts", new Map(), 1000);
    expect(record.tabs.map((t) => t.path)).toEqual(["/a.ts"]);
  });

  it("keeps showDiff only when true", () => {
    const tabs = [tab({ path: "/a.ts", showDiff: true }), tab({ path: "/b.ts", showDiff: false })];
    const record = buildWorkspaceRecord(tabs, null, new Map(), 1000);
    expect(record.tabs[0]).toMatchObject({ path: "/a.ts", showDiff: true });
    expect(record.tabs[1]).not.toHaveProperty("showDiff");
  });

  it("attaches a viewState only when present in the map", () => {
    const tabs = [tab({ path: "/a.ts" }), tab({ path: "/b.ts" })];
    const viewStates = new Map<string, unknown>([["/a.ts", { cursor: 1 }]]);
    const record = buildWorkspaceRecord(tabs, null, viewStates, 1000);
    expect(record.tabs[0].viewState).toEqual({ cursor: 1 });
    expect(record.tabs[1]).not.toHaveProperty("viewState");
  });

  it("nulls activeTabPath when it points at a filtered-out tab", () => {
    const tabs = [tab({ path: "/a.ts" }), tab({ path: "settings:app", settings: true })];
    const record = buildWorkspaceRecord(tabs, "settings:app", new Map(), 1000);
    expect(record.activeTabPath).toBeNull();
  });

  it("records the given timestamp", () => {
    expect(buildWorkspaceRecord([], null, new Map(), 42).lastAccessed).toBe(42);
  });
});

describe("upsertWorkspaceState", () => {
  it("leaves state alone under the cap", () => {
    const state: WorkspacesState = { "/ws-a": { tabs: [], activeTabPath: null, lastAccessed: 1 } };
    const record: WorkspaceTabsRecord = { tabs: [], activeTabPath: null, lastAccessed: 2 };
    const next = upsertWorkspaceState(state, "/ws-b", record, 20);
    expect(Object.keys(next).sort()).toEqual(["/ws-a", "/ws-b"]);
  });

  it("evicts the least-recently-accessed workspace once over the cap", () => {
    const state: WorkspacesState = {
      "/old": { tabs: [], activeTabPath: null, lastAccessed: 1 },
      "/mid": { tabs: [], activeTabPath: null, lastAccessed: 2 },
    };
    const record: WorkspaceTabsRecord = { tabs: [], activeTabPath: null, lastAccessed: 3 };
    const next = upsertWorkspaceState(state, "/new", record, 2);
    expect(Object.keys(next).sort()).toEqual(["/mid", "/new"]);
  });

  it("never evicts the workspace being written, even if its timestamp is the oldest", () => {
    const state: WorkspacesState = {
      "/a": { tabs: [], activeTabPath: null, lastAccessed: 100 },
      "/b": { tabs: [], activeTabPath: null, lastAccessed: 200 },
    };
    // A brand-new workspace, but stamped with an old timestamp on purpose.
    const record: WorkspaceTabsRecord = { tabs: [], activeTabPath: null, lastAccessed: 1 };
    const next = upsertWorkspaceState(state, "/new", record, 2);
    expect(next).toHaveProperty("/new");
  });
});

describe("planRestoreTabs", () => {
  it("returns an empty plan for an undefined record", () => {
    const plan = planRestoreTabs(undefined, new Set());
    expect(plan).toEqual({ tabsToOpen: [], activePath: null, viewStates: new Map() });
  });

  it("skips tabs whose file no longer exists", () => {
    const record: WorkspaceTabsRecord = {
      tabs: [{ path: "/a.ts" }, { path: "/gone.ts" }],
      activeTabPath: "/a.ts",
      lastAccessed: 1,
    };
    const plan = planRestoreTabs(record, new Set(["/a.ts"]));
    expect(plan.tabsToOpen.map((t) => t.path)).toEqual(["/a.ts"]);
  });

  it("falls back the active tab to the last surviving one when the persisted active is missing", () => {
    const record: WorkspaceTabsRecord = {
      tabs: [{ path: "/a.ts" }, { path: "/b.ts" }],
      activeTabPath: "/gone.ts",
      lastAccessed: 1,
    };
    const plan = planRestoreTabs(record, new Set(["/a.ts", "/b.ts"]));
    expect(plan.activePath).toBe("/b.ts");
  });

  it("carries the viewState through only for surviving tabs", () => {
    const record: WorkspaceTabsRecord = {
      tabs: [
        { path: "/a.ts", viewState: { cursor: 1 } },
        { path: "/gone.ts", viewState: { cursor: 2 } },
      ],
      activeTabPath: "/a.ts",
      lastAccessed: 1,
    };
    const plan = planRestoreTabs(record, new Set(["/a.ts"]));
    expect(plan.viewStates.get("/a.ts")).toEqual({ cursor: 1 });
    expect(plan.viewStates.has("/gone.ts")).toBe(false);
  });

  it("derives title, language and showDiff for each reopened tab", () => {
    const record: WorkspaceTabsRecord = {
      tabs: [{ path: "/src/App.tsx", showDiff: true }],
      activeTabPath: "/src/App.tsx",
      lastAccessed: 1,
    };
    const plan = planRestoreTabs(record, new Set(["/src/App.tsx"]));
    expect(plan.tabsToOpen[0]).toMatchObject({
      path: "/src/App.tsx",
      title: "App.tsx",
      isDirty: false,
      showDiff: true,
    });
  });

  it("returns a null activePath when nothing survives", () => {
    const record: WorkspaceTabsRecord = { tabs: [{ path: "/gone.ts" }], activeTabPath: "/gone.ts", lastAccessed: 1 };
    const plan = planRestoreTabs(record, new Set());
    expect(plan.activePath).toBeNull();
    expect(plan.tabsToOpen).toEqual([]);
  });
});
