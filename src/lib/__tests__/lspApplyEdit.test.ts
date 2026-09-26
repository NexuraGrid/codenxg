import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModel, disposeAllModels, getModel } from "../monacoModelRegistry";
import { useEditorStore } from "../../state/editorStore";

const readFile = vi.fn();
const writeSearchFiles = vi.fn().mockResolvedValue(undefined);
vi.mock("../tauri-api", () => ({
  readFile: (path: string) => readFile(path),
  writeSearchFiles: (files: unknown) => writeSearchFiles(files),
}));

const { applyWorkspaceEdit } = await import("../lsp/applyEdit");

const OPEN_PATH = "/ws/open.php";
const CLOSED_PATH = "/ws/closed.php";

const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, character: c1 },
  end: { line: l2, character: c2 },
});

beforeEach(() => {
  disposeAllModels();
  useEditorStore.getState().reset();
  readFile.mockReset();
  writeSearchFiles.mockClear();
});

describe("applyWorkspaceEdit", () => {
  it("edits an open file's model as one undoable, dirty-marking step", async () => {
    useEditorStore.getState().addTab({ path: OPEN_PATH, title: "open.php", isDirty: false, language: "php" });
    createModel(OPEN_PATH, "<?php\necho 'old';", "php");

    const result = await applyWorkspaceEdit({
      changes: { [`file://${OPEN_PATH}`]: [{ range: range(1, 5, 1, 10), newText: "'new'" }] },
    });

    expect(getModel(OPEN_PATH)!.getValue()).toBe("<?php\necho 'new';");
    expect(useEditorStore.getState().tabs[0].isDirty).toBe(true);
    expect(result.changedPaths).toEqual([OPEN_PATH]);
    expect(writeSearchFiles).not.toHaveBeenCalled();

    getModel(OPEN_PATH)!.undo();
    expect(getModel(OPEN_PATH)!.getValue()).toBe("<?php\necho 'old';");
  });

  it("patches a closed file on disk through the atomic write helper", async () => {
    readFile.mockResolvedValue("<?php\necho 'old';");

    const result = await applyWorkspaceEdit({
      changes: { [`file://${CLOSED_PATH}`]: [{ range: range(1, 5, 1, 10), newText: "'new'" }] },
    });

    expect(readFile).toHaveBeenCalledWith(CLOSED_PATH);
    expect(writeSearchFiles).toHaveBeenCalledWith([{ path: CLOSED_PATH, content: "<?php\necho 'new';" }]);
    expect(result.changedPaths).toEqual([CLOSED_PATH]);
  });

  it("batches every closed-file write into one call", async () => {
    readFile.mockImplementation(async (path: string) => (path === "/ws/a.php" ? "A" : "B"));

    await applyWorkspaceEdit({
      changes: {
        "file:///ws/a.php": [{ range: range(0, 0, 0, 1), newText: "AA" }],
        "file:///ws/b.php": [{ range: range(0, 0, 0, 1), newText: "BB" }],
      },
    });

    expect(writeSearchFiles).toHaveBeenCalledTimes(1);
    const [files] = writeSearchFiles.mock.calls[0];
    expect(files).toEqual(
      expect.arrayContaining([
        { path: "/ws/a.php", content: "AA" },
        { path: "/ws/b.php", content: "BB" },
      ]),
    );
  });

  it("reports create/rename/delete file operations as skipped, without touching disk for them", async () => {
    const result = await applyWorkspaceEdit({
      documentChanges: [
        { kind: "create", uri: "file:///ws/new.php" },
        { kind: "rename", oldUri: "file:///ws/old.php", newUri: "file:///ws/renamed.php" },
        { kind: "delete", uri: "file:///ws/gone.php" },
      ],
    });

    expect(result.skippedOperations).toEqual([
      { kind: "create", uri: "file:///ws/new.php" },
      { kind: "rename", uri: "file:///ws/old.php", newUri: "file:///ws/renamed.php" },
      { kind: "delete", uri: "file:///ws/gone.php" },
    ]);
    expect(writeSearchFiles).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("does nothing for an empty/missing edit", async () => {
    const result = await applyWorkspaceEdit(null);
    expect(result).toEqual({ changedPaths: [], skippedOperations: [] });
    expect(writeSearchFiles).not.toHaveBeenCalled();
  });
});
