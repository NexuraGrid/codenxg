import { beforeEach, describe, expect, it } from "vitest";
import {
  createModel,
  disposeAllModels,
  getModel,
  markDeletedOnDisk,
  markSaved,
  reloadFromDisk,
  syncWithDisk,
} from "../monacoModelRegistry";
import { useEditorStore } from "../../state/editorStore";

const PATH = "/ws/main.ts";

function isDirty() {
  return useEditorStore.getState().tabs.find((t) => t.path === PATH)?.isDirty;
}

function type(text: string) {
  const model = getModel(PATH)!;
  model.applyEdits([{ range: model.getFullModelRange(), text }]);
}

beforeEach(() => {
  disposeAllModels();
  useEditorStore.getState().reset();
  useEditorStore.getState().addTab({ path: PATH, title: "main.ts", isDirty: false, language: "typescript" });
  createModel(PATH, "original", "typescript");
});

describe("syncWithDisk", () => {
  it("ignores the echo of our own save even after more typing", () => {
    type("saved");
    markSaved(PATH, "saved");
    type("saved and more");

    expect(syncWithDisk(PATH, "saved")).toBe("unchanged");
    expect(getModel(PATH)!.getValue()).toBe("saved and more");
  });

  it("reloads a clean file in place, undoably", () => {
    expect(syncWithDisk(PATH, "from git")).toBe("reloaded");
    expect(getModel(PATH)!.getValue()).toBe("from git");
    expect(isDirty()).toBe(false);

    getModel(PATH)!.undo();
    expect(getModel(PATH)!.getValue()).toBe("original");
  });

  it("never overwrites unsaved edits: it reports a conflict", () => {
    type("my edits");

    expect(syncWithDisk(PATH, "their edits")).toBe("conflict");
    expect(getModel(PATH)!.getValue()).toBe("my edits");

    reloadFromDisk(PATH);
    expect(getModel(PATH)!.getValue()).toBe("their edits");
    expect(isDirty()).toBe(false);
  });

  it("treats identical content as clean", () => {
    type("same");
    expect(syncWithDisk(PATH, "same")).toBe("unchanged");
    expect(isDirty()).toBe(false);
  });

  it("flags a deleted file as unsaved so saving recreates it", () => {
    markDeletedOnDisk(PATH);
    expect(isDirty()).toBe(true);
    expect(getModel(PATH)!.getValue()).toBe("original");
  });
});
