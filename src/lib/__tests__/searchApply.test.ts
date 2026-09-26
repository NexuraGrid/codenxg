import { beforeEach, describe, expect, it } from "vitest";
import { applyMatchesToModel } from "../searchApply";
import { createModel, disposeAllModels, getModel } from "../monacoModelRegistry";
import { useEditorStore } from "../../state/editorStore";

const PATH = "/ws/main.ts";

beforeEach(() => {
  disposeAllModels();
  useEditorStore.getState().reset();
  useEditorStore.getState().addTab({ path: PATH, title: "main.ts", isDirty: false, language: "typescript" });
});

describe("applyMatchesToModel", () => {
  it("returns false when the file has no open model", () => {
    expect(applyMatchesToModel("/ws/other.ts", [], () => "x")).toBe(false);
  });

  it("applies edits to the open model as one undoable step", () => {
    createModel(PATH, "const foo = 1;\nconst foo2 = 2;", "typescript");

    const applied = applyMatchesToModel(
      PATH,
      [
        { line: 1, startColumn: 7, endColumn: 10, matchText: "foo" },
        { line: 2, startColumn: 7, endColumn: 10, matchText: "foo" },
      ],
      () => "bar",
    );

    expect(applied).toBe(true);
    expect(getModel(PATH)!.getValue()).toBe("const bar = 1;\nconst bar2 = 2;");

    getModel(PATH)!.undo();
    expect(getModel(PATH)!.getValue()).toBe("const foo = 1;\nconst foo2 = 2;");
  });

  it("passes each match through the replacement function", () => {
    createModel(PATH, "a=1 b=2", "typescript");

    applyMatchesToModel(
      PATH,
      [
        { line: 1, startColumn: 1, endColumn: 4, matchText: "a=1" },
        { line: 1, startColumn: 5, endColumn: 8, matchText: "b=2" },
      ],
      (m) => m.matchText.split("=").reverse().join(":"),
    );

    expect(getModel(PATH)!.getValue()).toBe("1:a 2:b");
  });

  it("skips matches whose text changed since the search (dirty buffer)", () => {
    createModel(PATH, "let foo = 1;\nconst foo = 2;", "typescript");

    applyMatchesToModel(
      PATH,
      [
        { line: 1, startColumn: 7, endColumn: 10, matchText: "foo" },
        { line: 2, startColumn: 7, endColumn: 10, matchText: "foo" },
      ],
      () => "bar",
    );

    expect(getModel(PATH)!.getValue()).toBe("let foo = 1;\nconst bar = 2;");
  });
});
