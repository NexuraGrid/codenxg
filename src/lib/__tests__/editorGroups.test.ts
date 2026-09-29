import { beforeEach, describe, expect, it, vi } from "vitest";
import { allTabs, MAX_EDITOR_GROUPS, uniqueOpenTabs, useEditorStore, type EditorTab } from "../../state/editorStore";
import { useDialogStore } from "../../state/dialogStore";
import { usePinGroupStore } from "../../state/pinGroupStore";
import { closeTabs, openPreviewTab } from "../tabActions";
import { closeGroup, focusGroupAt, moveEditorToGroup, moveEditorToOtherGroup, splitEditor } from "../editorGroupActions";
import { openMarkdownPreviewToSide } from "../markdownPreview";
import { switchPinGroup } from "../pinGroupActions";
import {
  buildLayoutRecord,
  buildWorkspaceRecord,
  planRestoreLayout,
  rememberedPaths,
  type WorkspaceTabsRecord,
} from "../persistedTabs";
import {
  FOCUS_LEFT_GROUP_ID,
  FOCUS_RIGHT_GROUP_ID,
  matchEditorGroupHotkey,
  MOVE_EDITOR_LEFT_ID,
  MOVE_EDITOR_RIGHT_ID,
  SPLIT_EDITOR_ID,
  type GroupHotkeyEvent,
} from "../editorGroupHotkeys";

const disposeModel = vi.hoisted(() => vi.fn());
vi.mock("../monacoModelRegistry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../monacoModelRegistry")>()),
  disposeModel,
}));

function tab(path: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return { path, title: path.slice(1), isDirty: false, language: "typescript", ...overrides };
}

const store = () => useEditorStore.getState();
const groupPaths = () => store().groups.map((g) => g.tabs.map((t) => t.path));
const activeIndex = () => store().groups.findIndex((g) => g.id === store().activeGroupId);
const groupId = (index: number) => store().groups[index].id;

beforeEach(() => {
  store().reset();
  usePinGroupStore.getState().reset();
  if (useDialogStore.getState().current) useDialogStore.getState().close("cancel");
  disposeModel.mockClear();
});

describe("opening files", () => {
  it("targets the active group and mirrors it in tabs/activeTabPath", () => {
    store().addTab(tab("/a"));
    splitEditor();
    store().addTab(tab("/b"));
    expect(groupPaths()).toEqual([["/a"], ["/a", "/b"]]);
    expect(store().tabs.map((t) => t.path)).toEqual(["/a", "/b"]);
    expect(store().activeTabPath).toBe("/b");

    store().focusGroup(groupId(0));
    store().addTab(tab("/c"));
    expect(groupPaths()).toEqual([["/a", "/c"], ["/a", "/b"]]);
    expect(store().activeTabPath).toBe("/c");
  });

  it("adds to another group without moving focus", () => {
    store().addTab(tab("/a"));
    splitEditor();
    store().focusGroup(groupId(0));
    store().addTab(tab("/b"), groupId(1));
    expect(activeIndex()).toBe(0);
    expect(store().groups[1].activeTabPath).toBe("/b");
  });

  it("keeps one preview slot per group", () => {
    store().addTab(tab("/a"));
    splitEditor();
    openPreviewTab(tab("/p1"));
    store().focusGroup(groupId(0));
    openPreviewTab(tab("/p2"));
    openPreviewTab(tab("/p3"));
    expect(groupPaths()).toEqual([["/a", "/p3"], ["/a", "/p1"]]);
  });

  it("keeps a replaced preview's model while another group still shows the file", () => {
    store().addTab(tab("/a"));
    openPreviewTab(tab("/p"));
    splitEditor(); // /p is now in both groups
    store().focusGroup(groupId(0));
    openPreviewTab(tab("/q"));
    expect(disposeModel).not.toHaveBeenCalledWith("/p");
  });
});

describe("split editor", () => {
  it("duplicates the active tab into a new right group and focuses it", () => {
    store().addTab(tab("/a", { isPinned: true }));
    store().addTab(tab("/b"));
    splitEditor();
    expect(groupPaths()).toEqual([["/a", "/b"], ["/b"]]);
    expect(activeIndex()).toBe(1);
    expect(store().groups[1].tabs[0]).toMatchObject({ path: "/b", isPinned: false, isPreview: false });
    // Both copies are one file: the same path, so the same shared model.
    expect(uniqueOpenTabs(store()).map((t) => t.path)).toEqual(["/a", "/b"]);
    expect(store().groupSizes).toEqual([50, 50]);
  });

  it("never creates more than MAX_EDITOR_GROUPS: from the right group it splits into the left one", () => {
    store().addTab(tab("/a"));
    splitEditor();
    store().addTab(tab("/b"));
    splitEditor();
    expect(store().groups).toHaveLength(MAX_EDITOR_GROUPS);
    expect(groupPaths()).toEqual([["/a", "/b"], ["/a", "/b"]]);
    expect(activeIndex()).toBe(0);
  });

  it("does nothing without an active tab", () => {
    splitEditor();
    expect(store().groups).toHaveLength(1);
  });

  it("Focus Right Group splits when there is only one group", () => {
    store().addTab(tab("/a"));
    focusGroupAt(1);
    expect(groupPaths()).toEqual([["/a"], ["/a"]]);
    focusGroupAt(0);
    expect(activeIndex()).toBe(0);
  });
});

describe("moving editors", () => {
  it("moves right into a new group, and back left collapsing the emptied group", () => {
    store().addTab(tab("/a"));
    store().addTab(tab("/b"));
    moveEditorToGroup("right");
    expect(groupPaths()).toEqual([["/a"], ["/b"]]);
    expect(activeIndex()).toBe(1);

    moveEditorToGroup("left");
    expect(groupPaths()).toEqual([["/a", "/b"]]);
    expect(store().activeTabPath).toBe("/b");
  });

  it("does not move a group's only tab into a new group", () => {
    store().addTab(tab("/a"));
    moveEditorToGroup("right");
    expect(groupPaths()).toEqual([["/a"]]);
  });

  it("replaces the copy already open in the target group", () => {
    store().addTab(tab("/a"));
    store().addTab(tab("/b"));
    splitEditor(); // /b in both
    store().focusGroup(groupId(0));
    store().setActiveTab("/b");
    moveEditorToOtherGroup();
    expect(groupPaths()).toEqual([["/a"], ["/b"]]);
  });
});

describe("closing", () => {
  it("removes a group once its last tab closes, focusing the remaining one", async () => {
    store().addTab(tab("/a"));
    store().addTab(tab("/b"));
    moveEditorToGroup("right");
    await closeTabs(["/b"]);
    expect(groupPaths()).toEqual([["/a"]]);
    expect(store().activeTabPath).toBe("/a");
  });

  it("keeps the last group even when it is empty", async () => {
    store().addTab(tab("/a"));
    await closeTabs(["/a"]);
    expect(store().groups).toHaveLength(1);
    expect(store().activeTabPath).toBeNull();
  });

  it("doesn't prompt or drop the model when another group still has the dirty file", async () => {
    store().addTab(tab("/a"));
    splitEditor();
    store().setDirty("/a", true);
    expect(allTabs(store()).every((t) => t.isDirty)).toBe(true);

    await closeTabs(["/a"]);
    expect(useDialogStore.getState().current).toBeNull();
    expect(disposeModel).not.toHaveBeenCalled();
    expect(groupPaths()).toEqual([["/a"]]);
    expect(store().tabs[0].isDirty).toBe(true);
  });

  it("prompts for the file's last copy", async () => {
    store().addTab(tab("/a", { isDirty: true }));
    const closing = closeTabs(["/a"]);
    await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
    useDialogStore.getState().close("cancel");
    await closing;
    expect(groupPaths()).toEqual([["/a"]]);
  });

  it("Close Group closes its tabs, sparing the other group's copies", async () => {
    store().addTab(tab("/a"));
    store().addTab(tab("/b"));
    splitEditor(); // right: /b
    store().addTab(tab("/c"));
    await closeGroup();
    expect(groupPaths()).toEqual([["/a", "/b"]]);
    expect(disposeModel).toHaveBeenCalledWith("/c");
    expect(disposeModel).not.toHaveBeenCalledWith("/b");
  });

  it("closes a deleted file in every group", () => {
    store().addTab(tab("/a"));
    store().addTab(tab("/b"));
    splitEditor();
    store().closeTabsEverywhere(["/b"]);
    expect(groupPaths()).toEqual([["/a"]]);
  });
});

describe("file-level changes span groups", () => {
  it("renames the file in every group", () => {
    store().addTab(tab("/x/a.ts"));
    splitEditor();
    store().rebasePaths("/x", "/y");
    expect(groupPaths()).toEqual([["/y/a.ts"], ["/y/a.ts"]]);
    expect(store().groups.every((g) => g.activeTabPath === "/y/a.ts")).toBe(true);
  });
});

describe("markdown preview to the side", () => {
  it("opens in a new right group and keeps focus on the source", () => {
    store().addTab(tab("/doc.md", { language: "markdown" }));
    openMarkdownPreviewToSide("/doc.md");
    expect(groupPaths()).toEqual([["/doc.md"], ["markdown-preview:/doc.md"]]);
    expect(activeIndex()).toBe(0);
    expect(store().activeTabPath).toBe("/doc.md");

    openMarkdownPreviewToSide("/doc.md");
    expect(groupPaths()).toEqual([["/doc.md"], ["markdown-preview:/doc.md"]]);
  });

  it("from the right group, uses the left one", () => {
    store().addTab(tab("/a"));
    splitEditor();
    store().addTab(tab("/doc.md", { language: "markdown" }));
    openMarkdownPreviewToSide("/doc.md");
    expect(groupPaths()).toEqual([["/a", "markdown-preview:/doc.md"], ["/a", "/doc.md"]]);
    expect(activeIndex()).toBe(1);
  });
});

describe("pin groups act on the active editor group", () => {
  it("switching opens and closes tabs only in the focused group", async () => {
    usePinGroupStore.getState().load(
      "/w",
      [
        { id: "one", name: "One", paths: ["/w/1"] },
        { id: "two", name: "Two", paths: ["/w/2"] },
      ],
      "one",
    );
    store().addTab(tab("/w/1", { isPinned: true }));
    splitEditor(); // the right group gets its own (unpinned) /w/1 copy…
    store().setPinned("/w/1", true); // …pinned there too

    store().focusGroup(groupId(0));
    await switchPinGroup("two", async (paths) => new Set(paths));
    expect(groupPaths()).toEqual([["/w/2"], ["/w/1"]]);
    expect(store().groups[1].tabs[0].isPinned).toBe(true);
  });
});

describe("persistence", () => {
  const view = new Map<string, unknown>();

  it("writes a single group exactly like before editor groups", () => {
    const tabs = [tab("/a"), tab("/b")];
    const record = buildLayoutRecord({ groups: [{ tabs, activeTabPath: "/b", viewStates: view }], activeIndex: 0, sizes: [100] }, 7);
    expect(record).toEqual(buildWorkspaceRecord(tabs, "/b", view, 7));
    expect(record.editorGroups).toBeUndefined();
  });

  it("round-trips two groups with focus and sizes", () => {
    const record = buildLayoutRecord(
      {
        groups: [
          { tabs: [tab("/a"), tab("/b")], activeTabPath: "/a", viewStates: new Map([["/a", { left: 1 }]]) },
          { tabs: [tab("/b", { isPinned: true })], activeTabPath: "/b", viewStates: new Map([["/b", { right: 1 }]]) },
        ],
        activeIndex: 1,
        sizes: [30, 70],
      },
      1,
    );
    // The first group stays in `tabs` for older builds.
    expect(record.tabs.map((t) => t.path)).toEqual(["/a", "/b"]);
    expect(rememberedPaths(record)).toEqual(["/a", "/b"]);

    const plan = planRestoreLayout(record, new Set(["/a", "/b"]));
    expect(plan.groups.map((g) => g.tabsToOpen.map((t) => t.path))).toEqual([["/a", "/b"], ["/b"]]);
    expect(plan.groups[1].tabsToOpen[0].isPinned).toBe(true);
    expect(plan.groups[0].viewStates.get("/a")).toEqual({ left: 1 });
    expect(plan.groups[1].viewStates.get("/b")).toEqual({ right: 1 });
    expect(plan.activeIndex).toBe(1);
    expect(plan.sizes).toEqual([30, 70]);
  });

  it("migrates an old single-group record to one group", () => {
    const legacy: WorkspaceTabsRecord = { tabs: [{ path: "/a" }, { path: "/b" }], activeTabPath: "/b", lastAccessed: 1 };
    const plan = planRestoreLayout(legacy, new Set(["/a", "/b"]));
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0].tabsToOpen.map((t) => t.path)).toEqual(["/a", "/b"]);
    expect(plan.groups[0].activePath).toBe("/b");
    expect(plan.activeIndex).toBe(0);
    expect(plan.sizes).toBeNull();
  });

  it("drops a group whose files are all gone, along with its saved sizes", () => {
    const record: WorkspaceTabsRecord = {
      tabs: [{ path: "/gone" }],
      activeTabPath: "/gone",
      lastAccessed: 1,
      editorGroups: [
        { tabs: [{ path: "/gone" }], activeTabPath: "/gone" },
        { tabs: [{ path: "/b" }], activeTabPath: "/b" },
      ],
      activeEditorGroup: 1,
      editorGroupSizes: [30, 70],
    };
    const plan = planRestoreLayout(record, new Set(["/b"]));
    expect(plan.groups.map((g) => g.tabsToOpen.map((t) => t.path))).toEqual([["/b"]]);
    expect(plan.activeIndex).toBe(0);
    expect(plan.sizes).toBeNull();
  });

  it("tolerates junk editor groups", () => {
    const record = {
      tabs: [{ path: "/a" }],
      activeTabPath: "/a",
      lastAccessed: 1,
      editorGroups: [null, { tabs: "nope" }, { tabs: [{ path: 3 }, { path: "/a" }] }],
      activeEditorGroup: "x",
      editorGroupSizes: [1, -1, 2],
    } as unknown as WorkspaceTabsRecord;
    const plan = planRestoreLayout(record, new Set(["/a"]));
    expect(plan.groups.map((g) => g.tabsToOpen.map((t) => t.path))).toEqual([["/a"]]);
    expect(plan.sizes).toBeNull();
  });
});

describe("hotkeys", () => {
  const base: GroupHotkeyEvent = {
    key: "",
    code: "",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    altGraph: false,
    inTerminal: false,
  };

  it("maps the editor group shortcuts", () => {
    expect(matchEditorGroupHotkey({ ...base, key: "\\", code: "Backslash" })).toBe(SPLIT_EDITOR_ID);
    expect(matchEditorGroupHotkey({ ...base, key: "&", code: "Digit1" })).toBe(FOCUS_LEFT_GROUP_ID);
    expect(matchEditorGroupHotkey({ ...base, key: "2", code: "Digit2" })).toBe(FOCUS_RIGHT_GROUP_ID);
    expect(matchEditorGroupHotkey({ ...base, altKey: true, key: "ArrowLeft" })).toBe(MOVE_EDITOR_LEFT_ID);
    expect(matchEditorGroupHotkey({ ...base, altKey: true, key: "ArrowRight" })).toBe(MOVE_EDITOR_RIGHT_ID);
  });

  it("leaves pin groups' Ctrl+Alt+digits, AltGr and the terminal's keys alone", () => {
    expect(matchEditorGroupHotkey({ ...base, altKey: true, code: "Digit1", key: "1" })).toBeNull();
    expect(matchEditorGroupHotkey({ ...base, altKey: true, altGraph: true, key: "ArrowLeft" })).toBeNull();
    expect(matchEditorGroupHotkey({ ...base, key: "\\", code: "Backslash", inTerminal: true })).toBeNull();
    expect(matchEditorGroupHotkey({ ...base, altKey: true, key: "ArrowRight", inTerminal: true })).toBeNull();
    expect(matchEditorGroupHotkey({ ...base, ctrlKey: false, code: "Digit1" })).toBeNull();
    expect(matchEditorGroupHotkey({ ...base, shiftKey: true, code: "Digit1" })).toBeNull();
  });
});
