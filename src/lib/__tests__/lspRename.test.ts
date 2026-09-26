import { describe, expect, it, vi } from "vitest";
import { toRenameLocation } from "../lsp/rename";

const range = (l1: number, c1: number, l2: number, c2: number) => ({
  start: { line: l1, character: c1 },
  end: { line: l2, character: c2 },
});
const position = { lineNumber: 1, column: 1 };

describe("toRenameLocation", () => {
  it("rejects when the server found nothing to rename", () => {
    const fallback = vi.fn();
    const textInRange = vi.fn();
    expect(toRenameLocation(null, position, fallback, textInRange)).toEqual({ rejectReason: "Nothing to rename here" });
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the range and placeholder text when both are given", () => {
    const result = toRenameLocation({ range: range(0, 0, 0, 3), placeholder: "foo" }, position, vi.fn(), vi.fn());
    expect(result).toEqual({ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: "foo" });
  });

  it("reads the range's own text from the model when only a bare range is given", () => {
    const textInRange = vi.fn().mockReturnValue("bareWord");
    const result = toRenameLocation(range(0, 0, 0, 3), position, vi.fn(), textInRange);
    expect(result).toEqual({ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }, text: "bareWord" });
    expect(textInRange).toHaveBeenCalledWith({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 });
  });

  it("falls back to the model's word range when the server defers to default behavior", () => {
    const fallback = vi.fn().mockReturnValue({ range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6 }, text: "foo" });
    const result = toRenameLocation({ defaultBehavior: true }, position, fallback, vi.fn());
    expect(fallback).toHaveBeenCalledWith(position);
    expect(result).toEqual({ range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 6 }, text: "foo" });
  });

  it("rejects on default behavior when there's no word under the cursor either", () => {
    const result = toRenameLocation({ defaultBehavior: true }, position, () => null, vi.fn());
    expect(result).toEqual({ rejectReason: "Nothing to rename here" });
  });
});
