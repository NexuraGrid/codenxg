import { describe, expect, it } from "vitest";
import { diffLines } from "../lineDiff";

const lines = (text: string) => text.split("\n");

describe("diffLines", () => {
  it("reports nothing for identical text", () => {
    expect(diffLines(lines("a\nb\nc"), lines("a\nb\nc"))).toEqual([]);
  });

  it("marks inserted lines as added", () => {
    expect(diffLines(lines("a\nc"), lines("a\nb1\nb2\nc"))).toEqual([{ kind: "added", start: 2, end: 3 }]);
  });

  it("marks replaced lines as modified", () => {
    expect(diffLines(lines("a\nb\nc"), lines("a\nB\nc"))).toEqual([{ kind: "modified", start: 2, end: 2 }]);
  });

  it("marks a removal on the line that follows it", () => {
    expect(diffLines(lines("a\nb\nc"), lines("a\nc"))).toEqual([{ kind: "deleted", start: 2, end: 2 }]);
  });

  it("a removal at the very end sits on the last line", () => {
    expect(diffLines(lines("a\nb"), lines("a"))).toEqual([{ kind: "deleted", start: 1, end: 1 }]);
  });

  it("finds separate hunks", () => {
    const before = lines("1\n2\n3\n4\n5\n6");
    const after = lines("1\nX\n3\n4\n5\n6\n7");
    expect(diffLines(before, after)).toEqual([
      { kind: "modified", start: 2, end: 2 },
      { kind: "added", start: 7, end: 7 },
    ]);
  });

  it("a hunk that both removes and adds lines is modified as a whole", () => {
    expect(diffLines(lines("a\nb\nc"), lines("a\nX\nY\nc"))).toEqual([{ kind: "modified", start: 2, end: 3 }]);
  });
});
