import { describe, expect, it } from "vitest";
import { applyMatchesToText } from "../searchReplace";

describe("applyMatchesToText", () => {
  it("replaces a single match on a single line", () => {
    const text = "const foo = 1;";
    const result = applyMatchesToText(
      text,
      [{ line: 1, startColumn: 7, endColumn: 10, matchText: "foo" }],
      () => "bar",
    );
    expect(result).toBe("const bar = 1;");
  });

  it("replaces multiple matches on the same line without shifting earlier columns", () => {
    const text = "foo foo foo";
    const matches = [
      { line: 1, startColumn: 1, endColumn: 4, matchText: "foo" },
      { line: 1, startColumn: 5, endColumn: 8, matchText: "foo" },
      { line: 1, startColumn: 9, endColumn: 12, matchText: "foo" },
    ];
    const result = applyMatchesToText(text, matches, () => "barbaz");
    expect(result).toBe("barbaz barbaz barbaz");
  });

  it("replaces matches across several lines", () => {
    const text = "one foo\ntwo foo\nthree";
    const matches = [
      { line: 1, startColumn: 5, endColumn: 8, matchText: "foo" },
      { line: 2, startColumn: 5, endColumn: 8, matchText: "foo" },
    ];
    const result = applyMatchesToText(text, matches, () => "bar");
    expect(result).toBe("one bar\ntwo bar\nthree");
  });

  it("supports a per-match replacement (regex group substitution)", () => {
    const text = "a=1 b=2";
    const matches = [
      { line: 1, startColumn: 1, endColumn: 4, matchText: "a=1" },
      { line: 1, startColumn: 5, endColumn: 8, matchText: "b=2" },
    ];
    const result = applyMatchesToText(text, matches, (m) => m.matchText.split("=").reverse().join(":"));
    expect(result).toBe("1:a 2:b");
  });

  it("ignores a match whose line is out of range", () => {
    const text = "only line";
    const result = applyMatchesToText(
      text,
      [{ line: 5, startColumn: 1, endColumn: 5, matchText: "only" }],
      () => "x",
    );
    expect(result).toBe("only line");
  });
});
