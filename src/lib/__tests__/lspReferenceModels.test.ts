import { beforeEach, describe, expect, it, vi } from "vitest";
import * as monaco from "monaco-editor";
import { createModel, disposeAllModels, getModel } from "../monacoModelRegistry";
import { useEditorStore } from "../../state/editorStore";

const readFile = vi.fn();
vi.mock("../tauri-api", () => ({ readFile: (path: string) => readFile(path) }));

const { ensureModelsForLocations, releaseUnusedLoanedModels } = await import("../lsp/referenceModels");

const loc = (path: string) => ({ uri: monaco.Uri.file(path), range: new monaco.Range(1, 1, 1, 1) });

beforeEach(() => {
  disposeAllModels();
  useEditorStore.getState().reset();
  readFile.mockReset();
});

describe("ensureModelsForLocations", () => {
  it("loads a model for a referenced file that has none yet", async () => {
    readFile.mockResolvedValue("<?php\necho 1;");
    await ensureModelsForLocations([loc("/ws/other.php")]);
    expect(getModel("/ws/other.php")?.getValue()).toBe("<?php\necho 1;");
  });

  it("doesn't re-read a file that already has a model", async () => {
    createModel("/ws/open.php", "already here", "php");
    await ensureModelsForLocations([loc("/ws/open.php")]);
    expect(readFile).not.toHaveBeenCalled();
  });

  it("ignores a location whose file can't be read", async () => {
    readFile.mockRejectedValue(new Error("gone"));
    await expect(ensureModelsForLocations([loc("/ws/missing.php")])).resolves.toBeUndefined();
    expect(getModel("/ws/missing.php")).toBeUndefined();
  });

  it("releases a loaned model once a new batch no longer references it and it never became a tab", async () => {
    readFile.mockResolvedValue("content");
    await ensureModelsForLocations([loc("/ws/a.php")]);
    expect(getModel("/ws/a.php")).toBeDefined();

    await ensureModelsForLocations([loc("/ws/b.php")]);
    expect(getModel("/ws/a.php")).toBeUndefined();
    expect(getModel("/ws/b.php")).toBeDefined();
  });

  it("keeps a loaned model once its file becomes a real open tab", async () => {
    readFile.mockResolvedValue("content");
    await ensureModelsForLocations([loc("/ws/a.php")]);
    useEditorStore.getState().addTab({ path: "/ws/a.php", title: "a.php", isDirty: false, language: "php" });

    releaseUnusedLoanedModels();
    expect(getModel("/ws/a.php")).toBeDefined();
  });
});
