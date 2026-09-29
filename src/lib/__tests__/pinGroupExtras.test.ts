import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePinGroupStore } from "../../state/pinGroupStore";
import { useDialogStore } from "../../state/dialogStore";
import { TOAST_DURATION_MS, useToastStore } from "../../state/toastStore";
import { ancestorDirsWithin } from "../paths";
import { dropTargetIndex, movePathTo, restoreGroup, type PinGroup } from "../pinGroups";
import {
  clearGroupWithConfirm,
  deleteGroupWithConfirm,
  removeFileFromGroup,
  removeFilesFromGroupWithConfirm,
} from "../pinGroupActions";

const readDir = vi.hoisted(() => vi.fn());
vi.mock("../tauri-api", () => ({ readDir }));

const { useExplorerStore } = await import("../../state/explorerStore");

const pins = () => usePinGroupStore.getState();
const toasts = () => useToastStore.getState().toasts;
const groupPaths = (id: string) => pins().groups.find((g) => g.id === id)?.paths;

function undoLast() {
  const toast = toasts()[toasts().length - 1];
  expect(toast.action?.label).toBe("Undo");
  useToastStore.getState().runAction(toast.id);
}

async function confirming<T>(run: Promise<T>): Promise<T> {
  await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
  useDialogStore.getState().close("confirm");
  return run;
}

beforeEach(() => {
  for (const t of toasts()) useToastStore.getState().dismiss(t.id);
  pins().reset();
  pins().load(
    "/w",
    [
      { id: "a", name: "A", paths: ["/w/1", "/w/2", "/w/3", "/w/4"] },
      { id: "b", name: "B", paths: ["/w/x"] },
    ],
    "a",
  );
});

describe("reordering a group's files", () => {
  it("moves a file up and down, clamping at the ends", () => {
    expect(movePathTo(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(movePathTo(["a", "b", "c"], 0, 9)).toEqual(["b", "c", "a"]);
    const same = ["a", "b"];
    expect(movePathTo(same, 1, 1)).toBe(same);
  });

  it("maps a drop gap to the landing index", () => {
    // Dragging row 1 of 4 into the gaps before rows 0..4.
    expect([0, 1, 2, 3, 4].map((gap) => dropTargetIndex(1, gap))).toEqual([0, 1, 1, 2, 3]);
  });

  it("persists the new order in the store", () => {
    pins().moveFile("a", "/w/4", 1);
    expect(groupPaths("a")).toEqual(["/w/1", "/w/4", "/w/2", "/w/3"]);
    const before = pins().groups;
    pins().moveFile("a", "/w/nope", 0);
    expect(pins().groups[0]).toBe(before[0]);
  });
});

describe("undoing removals", () => {
  it("restores a single removed file at its old position", () => {
    removeFileFromGroup("a", "/w/2");
    expect(toasts()[toasts().length - 1]?.message).toBe('Removed 2 from "A"');
    expect(groupPaths("a")).toEqual(["/w/1", "/w/3", "/w/4"]);
    undoLast();
    expect(groupPaths("a")).toEqual(["/w/1", "/w/2", "/w/3", "/w/4"]);
    expect(toasts()).toEqual([]);
  });

  it("restores a bulk removal, keeping files added since at the end", async () => {
    expect(await confirming(removeFilesFromGroupWithConfirm("a", ["/w/1", "/w/3"]))).toBe(true);
    pins().addFile("a", "/w/new");
    undoLast();
    expect(groupPaths("a")).toEqual(["/w/1", "/w/2", "/w/3", "/w/4", "/w/new"]);
  });

  it("restores a cleared group", async () => {
    await confirming(clearGroupWithConfirm("a"));
    expect(groupPaths("a")).toEqual([]);
    undoLast();
    expect(groupPaths("a")).toEqual(["/w/1", "/w/2", "/w/3", "/w/4"]);
  });

  it("restores a deleted group in its place, active again", async () => {
    await confirming(deleteGroupWithConfirm("a"));
    expect(pins().groups.map((g) => g.id)).toEqual(["b"]);
    expect(pins().activeGroupId).toBeNull();
    undoLast();
    expect(pins().groups.map((g) => g.id)).toEqual(["a", "b"]);
    expect(pins().activeGroupId).toBe("a");
  });

  it("offers no undo when the confirmation is cancelled", async () => {
    const run = removeFilesFromGroupWithConfirm("a", ["/w/1", "/w/2"]);
    await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
    useDialogStore.getState().close("cancel");
    expect(await run).toBe(false);
    expect(toasts()).toEqual([]);
  });

  it("never restores into another workspace", () => {
    removeFileFromGroup("a", "/w/2");
    pins().load("/other", [], null);
    undoLast();
    expect(pins().groups).toEqual([]);
  });

  it("restoreGroup reinserts a missing group at a clamped index", () => {
    const snapshot: PinGroup = { id: "z", name: "Z", paths: ["/p"] };
    expect(restoreGroup([], snapshot, 5)).toEqual([snapshot]);
  });
});

describe("toasts", () => {
  afterEach(() => vi.useRealTimers());

  it("dismiss themselves after a while", () => {
    vi.useFakeTimers();
    useToastStore.getState().show("hello");
    expect(toasts()).toHaveLength(1);
    vi.advanceTimersByTime(TOAST_DURATION_MS);
    expect(toasts()).toEqual([]);
  });

  it("keep only the newest few on screen", () => {
    for (let i = 0; i < 5; i++) useToastStore.getState().show(`t${i}`);
    expect(toasts().map((t) => t.message)).toEqual(["t2", "t3", "t4"]);
  });
});

describe("reveal in explorer", () => {
  beforeEach(() => {
    readDir.mockReset();
    readDir.mockResolvedValue([]);
    useExplorerStore.setState({ root: null });
    useExplorerStore.getState().init("/w");
  });

  it("lists the folders to expand, outermost first", () => {
    expect(ancestorDirsWithin("/w/src/lib/a.ts", "/w")).toEqual(["/w/src", "/w/src/lib"]);
    expect(ancestorDirsWithin("/w/a.ts", "/w")).toEqual([]);
    expect(ancestorDirsWithin("C:\\w\\src\\a.ts", "C:\\w")).toEqual(["C:\\w\\src"]);
    expect(ancestorDirsWithin("/wx/a.ts", "/w")).toBeNull();
    expect(ancestorDirsWithin("/w", "/w")).toBeNull();
  });

  it("expands and loads every ancestor, then marks the file revealed", async () => {
    expect(await useExplorerStore.getState().reveal("/w/src/lib/a.ts")).toBe(true);
    const state = useExplorerStore.getState();
    expect(state.expanded).toMatchObject({ "/w/src": true, "/w/src/lib": true });
    expect(readDir).toHaveBeenCalledWith("/w/src");
    expect(readDir).toHaveBeenCalledWith("/w/src/lib");
    expect(state.revealed?.path).toBe("/w/src/lib/a.ts");

    const nonce = state.revealed?.nonce;
    await useExplorerStore.getState().reveal("/w/src/lib/a.ts");
    expect(useExplorerStore.getState().revealed?.nonce).not.toBe(nonce);
  });

  it("does nothing for a path outside the workspace", async () => {
    expect(await useExplorerStore.getState().reveal("/elsewhere/a.ts")).toBe(false);
    expect(useExplorerStore.getState().revealed).toBeNull();
  });

  it("keeps open folders when the tree remounts for the same root", async () => {
    await useExplorerStore.getState().reveal("/w/src/a.ts");
    useExplorerStore.getState().init("/w");
    expect(useExplorerStore.getState().expanded["/w/src"]).toBe(true);
    useExplorerStore.getState().init("/other");
    expect(useExplorerStore.getState().expanded).toEqual({});
  });
});
