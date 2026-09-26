import { describe, expect, it } from "vitest";
import {
  buildReplacementText,
  buildSearchRegex,
  prefillFromSelection,
  splitPreview,
  summarizeResults,
} from "../searchQuery";

const base = { query: "", matchCase: false, wholeWord: false, useRegex: false };

describe("buildSearchRegex", () => {
  it("rejects an empty query", () => {
    const result = buildSearchRegex({ ...base, query: "" });
    expect(result.ok).toBe(false);
  });

  it("is case-insensitive by default", () => {
    const result = buildSearchRegex({ ...base, query: "foo" });
    expect(result.ok && result.regex.test("FOO BAR")).toBe(true);
  });

  it("matches case exactly when matchCase is set", () => {
    const result = buildSearchRegex({ ...base, query: "foo", matchCase: true });
    expect(result.ok && result.regex.test("FOO")).toBe(false);
    expect(result.ok && result.regex.test("foo")).toBe(true);
  });

  it("escapes special characters when not using regex", () => {
    const result = buildSearchRegex({ ...base, query: "a.b(" });
    expect(result.ok && result.regex.test("axb(")).toBe(false);
    expect(result.ok && result.regex.test("a.b(")).toBe(true);
  });

  it("wraps the pattern with word boundaries when wholeWord is set", () => {
    const result = buildSearchRegex({ ...base, query: "cat", wholeWord: true });
    expect(result.ok && result.regex.test("concatenate")).toBe(false);
    expect(result.ok && result.regex.test("a cat sat")).toBe(true);
  });

  it("uses the raw pattern as a regex when useRegex is set", () => {
    const result = buildSearchRegex({ ...base, query: "f\\w+", useRegex: true });
    expect(result.ok && result.regex.test("foobar")).toBe(true);
  });

  it("reports an error for an invalid regex", () => {
    const result = buildSearchRegex({ ...base, query: "(unterminated", useRegex: true });
    expect(result.ok).toBe(false);
  });

  it("returns a global regex, ready to scan a whole line", () => {
    const result = buildSearchRegex({ ...base, query: "a" });
    expect(result.ok && result.regex.global).toBe(true);
  });
});

describe("buildReplacementText", () => {
  it("returns the literal replacement when not using regex", () => {
    expect(buildReplacementText("foo", "bar", { ...base, query: "foo" })).toBe("bar");
  });

  it("expands capture groups when using regex", () => {
    const options = { ...base, query: "(\\w+)@(\\w+)", useRegex: true };
    expect(buildReplacementText("user@host", "$2:$1", options)).toBe("host:user");
  });

  it("falls back to the literal replacement if the regex can't re-match", () => {
    const options = { ...base, query: "abc", useRegex: true };
    expect(buildReplacementText("xyz", "replaced", options)).toBe("replaced");
  });
});

describe("summarizeResults", () => {
  it("counts matches and files", () => {
    const files = [{ matches: [1, 2] }, { matches: [3] }] as { matches: unknown[] }[];
    expect(summarizeResults(files)).toEqual({ matchCount: 3, fileCount: 2 });
  });

  it("handles an empty result set", () => {
    expect(summarizeResults([])).toEqual({ matchCount: 0, fileCount: 0 });
  });
});

describe("splitPreview", () => {
  it("splits a preview into before/match/after", () => {
    const result = splitPreview("const foo = 1;", 6, 9);
    expect(result).toEqual({ before: "const ", match: "foo", after: " = 1;" });
  });

  it("clamps out-of-range offsets", () => {
    const result = splitPreview("abc", -5, 100);
    expect(result).toEqual({ before: "", match: "abc", after: "" });
  });
});

describe("prefillFromSelection", () => {
  it("returns the trimmed single-line selection", () => {
    expect(prefillFromSelection("  hello  ")).toBe("hello");
  });

  it("keeps only the first line of a multi-line selection", () => {
    expect(prefillFromSelection("first\nsecond")).toBe("first");
  });

  it("returns an empty string when nothing is selected", () => {
    expect(prefillFromSelection("")).toBe("");
    expect(prefillFromSelection("   ")).toBe("");
  });
});
