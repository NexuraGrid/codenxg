import { describe, expect, it } from "vitest";
import { explainSwitchBlock } from "../switchExplanation";

describe("explainSwitchBlock", () => {
  it("says the branch exists when it was just created", () => {
    const text = explainSwitchBlock({ kind: "local-changes", files: ["a.ts"], detail: "" }, "feat", "main", true);
    expect(text.title).toBe('Branch "feat" was created, but you\'re still on "main"');
    expect(text.message).toContain("• a.ts");
    expect(text.canStash).toBe(true);
  });

  it("offers no stash for a half-done merge", () => {
    const text = explainSwitchBlock({ kind: "unresolved-conflicts", files: [], detail: "" }, "feat", "main", false);
    expect(text.title).toBe('Can\'t switch to "feat" yet');
    expect(text.canStash).toBe(false);
  });

  it("caps long file lists", () => {
    const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const text = explainSwitchBlock({ kind: "untracked-files", files, detail: "" }, "x", "main", false);
    expect(text.message).toContain("…and 4 more");
    expect(text.message).not.toContain("f9.ts");
  });

  it("falls back to git's own words", () => {
    const text = explainSwitchBlock({ kind: "other", files: [], detail: "fatal: odd" }, "x", "main", false);
    expect(text.message).toContain("fatal: odd");
  });
});
