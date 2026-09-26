import { describe, expect, it } from "vitest";
import { applyEditsToText, normalizeWorkspaceEdit } from "../lsp/workspaceEdit";

const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, character: c1 },
  end: { line: l2, character: c2 },
});

describe("normalizeWorkspaceEdit", () => {
  it("is empty for null/undefined", () => {
    expect(normalizeWorkspaceEdit(null)).toEqual({ fileEdits: [], resourceOperations: [] });
    expect(normalizeWorkspaceEdit(undefined)).toEqual({ fileEdits: [], resourceOperations: [] });
  });

  it("reads the legacy `changes` map, one entry per file", () => {
    const result = normalizeWorkspaceEdit({
      changes: {
        "file:///a.php": [{ range: range(0, 0, 0, 1), newText: "x" }],
        "file:///b.php": [{ range: range(1, 0, 1, 1), newText: "y" }],
      },
    });
    expect(result.resourceOperations).toEqual([]);
    expect(result.fileEdits).toEqual([
      { uri: "file:///a.php", edits: [{ range: range(0, 0, 0, 1), newText: "x" }] },
      { uri: "file:///b.php", edits: [{ range: range(1, 0, 1, 1), newText: "y" }] },
    ]);
  });

  it("prefers documentChanges over changes when both are present", () => {
    const result = normalizeWorkspaceEdit({
      changes: { "file:///ignored.php": [{ range: range(0, 0, 0, 1), newText: "ignored" }] },
      documentChanges: [
        { textDocument: { uri: "file:///a.php", version: 3 }, edits: [{ range: range(0, 0, 0, 1), newText: "x" }] },
      ],
    });
    expect(result.fileEdits).toEqual([{ uri: "file:///a.php", edits: [{ range: range(0, 0, 0, 1), newText: "x" }] }]);
  });

  it("splits resource operations out of documentChanges", () => {
    const result = normalizeWorkspaceEdit({
      documentChanges: [
        { textDocument: { uri: "file:///a.php" }, edits: [{ range: range(0, 0, 0, 1), newText: "x" }] },
        { kind: "create", uri: "file:///new.php" },
        { kind: "rename", oldUri: "file:///old.php", newUri: "file:///renamed.php" },
        { kind: "delete", uri: "file:///gone.php" },
      ],
    });
    expect(result.fileEdits).toEqual([{ uri: "file:///a.php", edits: [{ range: range(0, 0, 0, 1), newText: "x" }] }]);
    expect(result.resourceOperations).toEqual([
      { kind: "create", uri: "file:///new.php" },
      { kind: "rename", uri: "file:///old.php", newUri: "file:///renamed.php" },
      { kind: "delete", uri: "file:///gone.php" },
    ]);
  });
});

describe("applyEditsToText", () => {
  it("returns the text unchanged with no edits", () => {
    expect(applyEditsToText("hello", [])).toBe("hello");
  });

  it("applies a single edit within a line", () => {
    const text = "let foo = 1;";
    const result = applyEditsToText(text, [{ range: range(0, 4, 0, 7), newText: "bar" }]);
    expect(result).toBe("let bar = 1;");
  });

  it("applies several edits on the same line without shifting each other", () => {
    const text = "foo + foo + foo";
    const edits = [
      { range: range(0, 0, 0, 3), newText: "bar" },
      { range: range(0, 6, 0, 9), newText: "bar" },
      { range: range(0, 12, 0, 15), newText: "bar" },
    ];
    expect(applyEditsToText(text, edits)).toBe("bar + bar + bar");
  });

  it("applies edits across multiple lines", () => {
    const text = "line one\nline two\nline three";
    const edits = [
      { range: range(0, 0, 0, 4), newText: "LINE" },
      { range: range(2, 5, 2, 10), newText: "THREE" },
    ];
    expect(applyEditsToText(text, edits)).toBe("LINE one\nline two\nline THREE");
  });

  it("applies a multi-line range replacement", () => {
    const text = "before\nmiddle\nafter";
    const result = applyEditsToText(text, [{ range: range(0, 3, 2, 2), newText: "X" }]);
    expect(result).toBe("befXter");
  });

  it("handles surrogate-pair characters as UTF-16 code units, matching Monaco columns", () => {
    // "😀" is two UTF-16 code units; the edit targets the ASCII text right after it.
    const text = "😀 end";
    const result = applyEditsToText(text, [{ range: range(0, 3, 0, 6), newText: "done" }]);
    expect(result).toBe("😀 done");
  });

  it("inserts text without deleting anything when start equals end", () => {
    const text = "ab";
    expect(applyEditsToText(text, [{ range: range(0, 1, 0, 1), newText: "X" }])).toBe("aXb");
  });
});
