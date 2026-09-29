import { beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorStore, type EditorTab } from "../../state/editorStore";
import { usePinGroupStore } from "../../state/pinGroupStore";
import { useDialogStore } from "../../state/dialogStore";
import { groupFileLabel, planGroupSwitch, sanitizePinGroups, type PinGroup } from "../pinGroups";
import {
  addActiveFileToGroup,
  addFileToGroup,
  openFileFromGroup,
  openGroupFile,
  removeFileFromGroup,
  switchPinGroup,
} from "../pinGroupActions";
import { buildWorkspaceRecord, readPinGroups, type WorkspaceTabsRecord } from "../persistedTabs";

function tab(path: string, overrides: Partial<EditorTab> = {}): EditorTab {
  return { path, title: path.slice(1), isDirty: false, language: "typescript", ...overrides };
}

const pins = () => usePinGroupStore.getState();
const editor = () => useEditorStore.getState();
const openPaths = () => editor().tabs.map((t) => t.path);
const everything = async (paths: string[]) => new Set(paths);

beforeEach(() => {
  pins().reset();
  editor().reset();
});

describe("pin group store", () => {
  it("creates groups, trimming names and dropping duplicate paths", () => {
    const group = pins().createGroup("  Backend  api ", ["/a", "/b", "/a"])!;
    expect(group.name).toBe("Backend api");
    expect(group.paths).toEqual(["/a", "/b"]);
    expect(pins().groups).toEqual([group]);
  });

  it("rejects empty names and merges into a group with the same name", () => {
    expect(pins().createGroup("   ")).toBeNull();
    const first = pins().createGroup("UI", ["/a"])!;
    const again = pins().createGroup("ui", ["/b"])!;
    expect(again.id).toBe(first.id);
    expect(pins().groups).toHaveLength(1);
    expect(pins().groups[0].paths).toEqual(["/a", "/b"]);
  });

  it("renames, refusing empty or taken names", () => {
    const a = pins().createGroup("A")!;
    pins().createGroup("B");
    expect(pins().renameGroup(a.id, "B")).toBe(false);
    expect(pins().renameGroup(a.id, " ")).toBe(false);
    expect(pins().renameGroup(a.id, "a")).toBe(true);
    expect(pins().renameGroup(a.id, "Alpha")).toBe(true);
    expect(pins().groups.map((g) => g.name)).toEqual(["Alpha", "B"]);
  });

  it("deletes a group and clears it if it was active", () => {
    const a = pins().createGroup("A")!;
    const b = pins().createGroup("B")!;
    pins().setActiveGroup(a.id);
    pins().deleteGroup(a.id);
    expect(pins().groups.map((g) => g.id)).toEqual([b.id]);
    expect(pins().activeGroupId).toBeNull();
  });

  it("adds and removes files", () => {
    const a = pins().createGroup("A")!;
    pins().addFile(a.id, "/x");
    pins().addFile(a.id, "/y");
    pins().addFile(a.id, "/x");
    pins().removeFile(a.id, "/x");
    expect(pins().groups[0].paths).toEqual(["/y"]);
  });

  it("pins a file's tab when it's added to a group", () => {
    editor().addTab(tab("/x"));
    const a = pins().createGroup("A")!;
    addFileToGroup(a.id, "/x");
    expect(editor().tabs[0].isPinned).toBe(true);
    expect(pins().groups[0].paths).toEqual(["/x"]);
  });

  it("ignores an unknown active group on load", () => {
    pins().load("/ws", [{ id: "g1", name: "A", paths: [] }], "nope");
    expect(pins().root).toBe("/ws");
    expect(pins().activeGroupId).toBeNull();
  });
});

describe("planGroupSwitch", () => {
  const previous: PinGroup = { id: "p", name: "P", paths: ["/a", "/b", "/shared"] };
  const next: PinGroup = { id: "n", name: "N", paths: ["/shared", "/c"] };

  it("closes the previous group's clean tabs that the new group doesn't have", () => {
    const tabs = [tab("/a"), tab("/b", { isDirty: true }), tab("/shared"), tab("/other")];
    expect(planGroupSwitch(tabs, previous, next)).toEqual({ close: ["/a"], open: ["/shared", "/c"] });
  });

  it("closes nothing without a previous group, or when re-selecting the same one", () => {
    const tabs = [tab("/a"), tab("/b")];
    expect(planGroupSwitch(tabs, undefined, next).close).toEqual([]);
    expect(planGroupSwitch(tabs, previous, previous).close).toEqual([]);
  });
});

describe("switchPinGroup", () => {
  it("opens the group's files pinned, activates the first, and closes the old group's clean tabs", async () => {
    const old = pins().createGroup("Old", ["/a", "/dirty"])!;
    const next = pins().createGroup("Next", ["/c", "/d"])!;
    editor().addTab(tab("/a", { isPinned: true }));
    editor().addTab(tab("/dirty", { isPinned: true }));
    editor().addTab(tab("/unrelated"));
    editor().setDirty("/dirty", true);
    pins().setActiveGroup(old.id);

    await switchPinGroup(next.id, everything);

    expect(openPaths()).not.toContain("/a");
    expect(openPaths()).toEqual(expect.arrayContaining(["/dirty", "/unrelated", "/c", "/d"]));
    expect(editor().tabs.filter((t) => ["/c", "/d"].includes(t.path)).every((t) => t.isPinned)).toBe(true);
    expect(editor().activeTabPath).toBe("/c");
    expect(pins().activeGroupId).toBe(next.id);
  });

  it("skips files that no longer exist", async () => {
    const group = pins().createGroup("G", ["/gone", "/here"])!;
    await switchPinGroup(group.id, async () => new Set(["/here"]));
    expect(openPaths()).toEqual(["/here"]);
    expect(editor().activeTabPath).toBe("/here");
  });

  it("pins an already-open tab instead of opening it twice", async () => {
    editor().addTab(tab("/c"));
    const group = pins().createGroup("G", ["/c"])!;
    await switchPinGroup(group.id, everything);
    expect(openPaths()).toEqual(["/c"]);
    expect(editor().tabs[0].isPinned).toBe(true);
  });
});

describe("opening a group's file", () => {
  it("activates the group, then focuses that file", async () => {
    const old = pins().createGroup("Old", ["/a"])!;
    const next = pins().createGroup("Next", ["/c", "/d"])!;
    editor().addTab(tab("/a", { isPinned: true }));
    pins().setActiveGroup(old.id);

    expect(await openGroupFile(next.id, "/d", everything)).toBe("opened");

    expect(pins().activeGroupId).toBe(next.id);
    expect(openPaths()).toEqual(["/c", "/d"]);
    expect(editor().activeTabPath).toBe("/d");
  });

  it("only focuses when the group is already active, reopening a closed tab pinned", async () => {
    const group = pins().createGroup("G", ["/c", "/d"])!;
    await switchPinGroup(group.id, everything);
    editor().closeTabs(["/d"]);
    editor().addTab(tab("/unrelated"));

    expect(await openGroupFile(group.id, "/d", everything)).toBe("opened");

    expect(openPaths()).toEqual(["/c", "/d", "/unrelated"]);
    expect(editor().tabs.find((t) => t.path === "/d")?.isPinned).toBe(true);
    expect(editor().activeTabPath).toBe("/d");
  });

  it("skips a missing file without switching groups", async () => {
    const old = pins().createGroup("Old", ["/a"])!;
    const next = pins().createGroup("Next", ["/gone", "/c"])!;
    pins().setActiveGroup(old.id);
    editor().addTab(tab("/a", { isPinned: true }));

    expect(await openGroupFile(next.id, "/gone", async () => new Set(["/a", "/c"]))).toBe("missing");

    expect(pins().activeGroupId).toBe(old.id);
    expect(openPaths()).toEqual(["/a"]);
    expect(editor().activeTabPath).toBe("/a");
  });

  it("ignores paths that aren't in the group", async () => {
    const group = pins().createGroup("G", ["/c"])!;
    expect(await openGroupFile(group.id, "/elsewhere", everything)).toBe("unknown");
    expect(await openGroupFile("nope", "/c", everything)).toBe("unknown");
    expect(openPaths()).toEqual([]);
  });

  it("offers to remove a missing file and removes it when confirmed", async () => {
    const group = pins().createGroup("G", ["/gone", "/c"])!;
    const pending = openFileFromGroup(group.id, "/gone", true);
    expect(useDialogStore.getState().current?.request.title).toContain("gone");
    useDialogStore.getState().close("remove");

    expect(await pending).toBe("missing");
    expect(pins().groups[0].paths).toEqual(["/c"]);
    expect(openPaths()).toEqual([]);
  });

  it("keeps a missing file when removal is cancelled", async () => {
    const group = pins().createGroup("G", ["/gone"])!;
    const pending = openFileFromGroup(group.id, "/gone", false, async () => new Set());
    await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
    useDialogStore.getState().close("cancel");
    await pending;
    expect(pins().groups[0].paths).toEqual(["/gone"]);
  });
});

describe("editing a group's files", () => {
  it("removes a file from the group, leaving its tab open", () => {
    const group = pins().createGroup("G", ["/a", "/b"])!;
    editor().addTab(tab("/a", { isPinned: true }));
    removeFileFromGroup(group.id, "/a");
    expect(pins().groups[0].paths).toEqual(["/b"]);
    expect(openPaths()).toEqual(["/a"]);
  });

  it("adds the active file to a group and pins it", () => {
    const group = pins().createGroup("G", ["/a"])!;
    editor().addTab(tab("/b"));
    expect(addActiveFileToGroup(group.id)).toBe(true);
    expect(pins().groups[0].paths).toEqual(["/a", "/b"]);
    expect(editor().tabs[0].isPinned).toBe(true);
  });

  it("adds nothing without an active file tab", () => {
    const group = pins().createGroup("G")!;
    expect(addActiveFileToGroup(group.id)).toBe(false);
    editor().addTab(tab("settings", { settings: true }));
    expect(addActiveFileToGroup(group.id)).toBe(false);
    expect(pins().groups[0].paths).toEqual([]);
  });

  it("doesn't add a file opened while a group is active", async () => {
    const group = pins().createGroup("G", ["/a"])!;
    await switchPinGroup(group.id, everything);
    editor().addTab(tab("/b"));
    expect(pins().groups[0].paths).toEqual(["/a"]);
  });
});

describe("groupFileLabel", () => {
  it("shows the folder relative to the workspace root", () => {
    expect(groupFileLabel("/ws/src/lib/a.ts", "/ws")).toEqual({ name: "a.ts", dir: "src/lib" });
    expect(groupFileLabel("/ws/a.ts", "/ws")).toEqual({ name: "a.ts", dir: "" });
    expect(groupFileLabel("/other/a.ts", "/ws")).toEqual({ name: "a.ts", dir: "/other" });
    expect(groupFileLabel("C:\\ws\\src\\a.ts", "C:\\ws")).toEqual({ name: "a.ts", dir: "src" });
  });
});

describe("pin group persistence", () => {
  const groups: PinGroup[] = [
    { id: "g1", name: "API", paths: ["/a", "/b"] },
    { id: "g2", name: "UI", paths: [] },
  ];

  it("round-trips groups and the active one through the workspace record", () => {
    const record = buildWorkspaceRecord([tab("/a")], "/a", new Map(), 1, { groups, activeGroupId: "g2" });
    const restored = readPinGroups(JSON.parse(JSON.stringify(record)) as WorkspaceTabsRecord);
    expect(restored).toEqual({ groups, activeGroupId: "g2" });
  });

  it("writes nothing extra when there are no groups", () => {
    const record = buildWorkspaceRecord([tab("/a")], "/a", new Map(), 1);
    expect(record).not.toHaveProperty("pinGroups");
    expect(record).not.toHaveProperty("activePinGroup");
  });

  it("reads records saved before pin groups existed as having none", () => {
    const legacy: WorkspaceTabsRecord = { tabs: [{ path: "/a", isPinned: true }], activeTabPath: "/a", lastAccessed: 1 };
    expect(readPinGroups(legacy)).toEqual({ groups: [], activeGroupId: null });
    expect(readPinGroups(undefined)).toEqual({ groups: [], activeGroupId: null });
  });

  it("drops malformed groups and a dangling active id", () => {
    const junk = [null, 3, { id: "x" }, { id: "g1", name: "  ", paths: [] }, { id: "g2", name: "Ok", paths: ["/a", 5, "/a"] }];
    expect(sanitizePinGroups(junk)).toEqual([{ id: "g2", name: "Ok", paths: ["/a"] }]);
    const record = { tabs: [], activeTabPath: null, lastAccessed: 1, pinGroups: junk, activePinGroup: "g1" } as unknown as WorkspaceTabsRecord;
    expect(readPinGroups(record).activeGroupId).toBeNull();
  });
});
