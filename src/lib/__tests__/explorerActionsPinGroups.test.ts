import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePinGroupStore } from "../../state/pinGroupStore";
import { useDialogStore } from "../../state/dialogStore";
import { rebaseGroupPaths, removeGroupPathsUnder, type PinGroup } from "../pinGroups";

const api = vi.hoisted(() => ({
  renameEntry: vi.fn(),
  moveEntry: vi.fn(),
  trashEntry: vi.fn(),
  deleteEntryPermanently: vi.fn(),
  readDir: vi.fn(async () => []),
}));
vi.mock("../tauri-api", () => api);
vi.mock("../monacoModelRegistry", () => ({ rebaseModels: vi.fn(), disposeModel: vi.fn() }));

const { deletePath, movePath, renamePath } = await import("../explorerActions");

const pins = () => usePinGroupStore.getState();
const paths = () => pins().groups.map((g) => g.paths);

beforeEach(() => {
  pins().reset();
  pins().load(
    "/w",
    [
      { id: "a", name: "A", paths: ["/w/src/a.ts", "/w/src/lib/b.ts", "/w/readme.md"] },
      { id: "b", name: "B", paths: ["/w/srcx/c.ts", "/w/src"] },
    ],
    null,
  );
});

describe("pin group path helpers", () => {
  const groups: PinGroup[] = [{ id: "g", name: "G", paths: ["/r/dir/x", "/r/dir2/y", "/r/new/x"] }];

  it("rewrites a folder prefix without touching sibling folders that share it", () => {
    expect(rebaseGroupPaths(groups, "/r/dir", "/r/other")[0].paths).toEqual(["/r/other/x", "/r/dir2/y", "/r/new/x"]);
  });

  it("drops a duplicate a rebase would create, keeping the first position", () => {
    expect(rebaseGroupPaths(groups, "/r/dir", "/r/new")[0].paths).toEqual(["/r/new/x", "/r/dir2/y"]);
  });

  it("keeps untouched groups identical", () => {
    expect(rebaseGroupPaths(groups, "/nope", "/else")[0]).toBe(groups[0]);
    expect(removeGroupPathsUnder(groups, "/nope")[0]).toBe(groups[0]);
  });

  it("removes a folder's contents but not its prefix-sharing siblings", () => {
    expect(removeGroupPathsUnder(groups, "/r/dir")[0].paths).toEqual(["/r/dir2/y", "/r/new/x"]);
  });
});

describe("explorer actions keep pin groups in sync", () => {
  it("follows a file rename", async () => {
    api.renameEntry.mockResolvedValueOnce("/w/readme2.md");
    await renamePath("/w/readme.md", "/w", "readme2.md");
    expect(paths()[0]).toEqual(["/w/src/a.ts", "/w/src/lib/b.ts", "/w/readme2.md"]);
  });

  it("follows a folder rename for every contained path", async () => {
    api.renameEntry.mockResolvedValueOnce("/w/source");
    await renamePath("/w/src", "/w", "source");
    expect(paths()).toEqual([
      ["/w/source/a.ts", "/w/source/lib/b.ts", "/w/readme.md"],
      ["/w/srcx/c.ts", "/w/source"],
    ]);
  });

  it("follows a move", async () => {
    api.moveEntry.mockResolvedValueOnce("/w/src/lib/readme.md");
    await movePath("/w/readme.md", "/w", "/w/src/lib");
    expect(paths()[0]).toEqual(["/w/src/a.ts", "/w/src/lib/b.ts", "/w/src/lib/readme.md"]);
  });

  it("removes what the app deletes", async () => {
    api.trashEntry.mockResolvedValueOnce(undefined);
    const done = deletePath("/w/src", true, "/w");
    await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
    useDialogStore.getState().close("trash");
    await done;
    expect(paths()).toEqual([["/w/readme.md"], ["/w/srcx/c.ts"]]);
  });

  it("leaves groups alone when the delete is cancelled", async () => {
    const done = deletePath("/w/readme.md", false, "/w");
    await vi.waitFor(() => expect(useDialogStore.getState().current).not.toBeNull());
    useDialogStore.getState().close("cancel");
    await done;
    expect(paths()[0]).toContain("/w/readme.md");
    expect(api.trashEntry).not.toHaveBeenCalled();
  });
});
