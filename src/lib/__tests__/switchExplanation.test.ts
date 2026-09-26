import { describe, expect, it } from "vitest";
import { explainStashError, explainSwitchBlock } from "../switchExplanation";

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

describe("explainStashError", () => {
  it("explains a conflicting apply", () => {
    const text = explainStashError("apply", "CONFLICT (content): Merge conflict in src/app.ts");
    expect(text.title).toBe("Apply finished with conflicts");
    expect(text.message).not.toContain("kept");
  });

  it("notes the stash was kept when a pop conflicts", () => {
    const text = explainStashError("pop", "CONFLICT (content): Merge conflict in src/app.ts");
    expect(text.title).toBe("Pop finished with conflicts");
    expect(text.message).toContain("The stash was kept");
  });

  it("falls back to git's own words for anything else", () => {
    const text = explainStashError("apply", "fatal: no stash entries found.");
    expect(text.title).toBe("Couldn't apply the stash");
    expect(text.message).toContain("fatal: no stash entries found.");
  });
});
