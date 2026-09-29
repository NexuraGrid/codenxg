import { beforeEach, describe, expect, it } from "vitest";
import { useEditorStore, type EditorTab } from "../../state/editorStore";
import { openPreviewTab, pathsToClose } from "../tabActions";
import { buildWorkspaceRecord, planRestoreTabs } from "../persistedTabs";

function tab(path: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return { path, title: path.slice(1), isDirty: false, language: "typescript", ...overrides };
}

const store = () => useEditorStore.getState();
const paths = () => store().tabs.map((t) => t.path);
const find = (path: string) => store().tabs.find((t) => t.path === path);

beforeEach(() => store().reset());

describe("preview tabs", () => {
  it("replaces the existing preview tab in place", () => {
    store().addTab(tab("/a"));
    openPreviewTab(tab("/b"));
    store().addTab(tab("/c"));
    openPreviewTab(tab("/d"));
    expect(paths()).toEqual(["/a", "/d", "/c"]);
    expect(find("/d")?.isPreview).toBe(true);
    expect(store().activeTabPath).toBe("/d");
  });

  it("appends a preview tab when there is none to replace", () => {
    store().addTab(tab("/a"));
    openPreviewTab(tab("/b"));
    expect(paths()).toEqual(["/a", "/b"]);
  });

  it("does not demote an already-open permanent tab to preview", () => {
    store().addTab(tab("/a"));
    openPreviewTab(tab("/a"));
    expect(find("/a")?.isPreview).toBe(false);
  });

  it("becomes permanent when a non-preview open targets it", () => {
    openPreviewTab(tab("/a"));
    store().addTab(tab("/a"));
    expect(find("/a")?.isPreview).toBe(false);
  });

  it("becomes permanent once edited", () => {
    openPreviewTab(tab("/a"));
    store().setDirty("/a", true);
    expect(find("/a")?.isPreview).toBe(false);
    openPreviewTab(tab("/b"));
    expect(paths()).toEqual(["/a", "/b"]);
  });

  it("becomes permanent through makePermanent (double-click, save)", () => {
    openPreviewTab(tab("/a"));
    store().makePermanent("/a");
    openPreviewTab(tab("/b"));
    expect(paths()).toEqual(["/a", "/b"]);
  });
});

describe("pinned tabs", () => {
  it("moves a pinned tab to the end of the pinned group", () => {
    ["/a", "/b", "/c"].forEach((p) => store().addTab(tab(p)));
    store().setPinned("/c", true);
    store().setPinned("/b", true);
    expect(paths()).toEqual(["/c", "/b", "/a"]);
  });

  it("moves an unpinned tab right after the pinned group", () => {
    ["/a", "/b", "/c"].forEach((p) => store().addTab(tab(p)));
    store().setPinned("/b", true);
    store().setPinned("/c", true);
    store().setPinned("/b", false);
    expect(paths()).toEqual(["/c", "/b", "/a"]);
    expect(find("/b")?.isPinned).toBe(false);
  });

  it("makes a pinned preview tab permanent", () => {
    openPreviewTab(tab("/a"));
    store().setPinned("/a", true);
    expect(find("/a")).toMatchObject({ isPinned: true, isPreview: false });
  });

  it("keeps restored pinned tabs inside the pinned group", () => {
    store().addTab(tab("/a"));
    store().addTab(tab("/p", { isPinned: true }));
    expect(paths()).toEqual(["/p", "/a"]);
  });
});

describe("pathsToClose with pinned tabs", () => {
  const tabs = [tab("/p", { isPinned: true }), tab("/a"), tab("/b"), tab("/c")];

  it("skips pinned tabs for bulk actions", () => {
    expect(pathsToClose(tabs, "/b", "others")).toEqual(["/a", "/c"]);
    expect(pathsToClose(tabs, "/b", "left")).toEqual(["/a"]);
    expect(pathsToClose(tabs, "/a", "right")).toEqual(["/b", "/c"]);
    expect(pathsToClose(tabs, "/a", "all")).toEqual(["/a", "/b", "/c"]);
  });

  it("still closes a pinned tab explicitly", () => {
    expect(pathsToClose(tabs, "/p", "close")).toEqual(["/p"]);
  });
});

describe("pinned persistence", () => {
  it("saves isPinned only when true and never saves preview status", () => {
    const record = buildWorkspaceRecord(
      [tab("/p", { isPinned: true }), tab("/a", { isPreview: true })],
      null,
      new Map(),
      1,
    );
    expect(record.tabs[0]).toMatchObject({ path: "/p", isPinned: true });
    expect(record.tabs[1]).not.toHaveProperty("isPinned");
    expect(record.tabs[1]).not.toHaveProperty("isPreview");
  });

  it("restores old records without the field as unpinned, permanent tabs", () => {
    const plan = planRestoreTabs(
      { tabs: [{ path: "/a" }, { path: "/p", isPinned: true }], activeTabPath: null, lastAccessed: 1 },
      new Set(["/a", "/p"]),
    );
    expect(plan.tabsToOpen.map((t) => [t.path, t.isPinned, t.isPreview])).toEqual([
      ["/a", false, undefined],
      ["/p", true, undefined],
    ]);
  });
});
