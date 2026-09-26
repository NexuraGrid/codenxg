import { describe, expect, it } from "vitest";
import { autoSaveAppliesTo, autoSavableTabs, isRealFileTab } from "../autoSave";
import type { EditorTab } from "../../state/editorStore";

function tab(overrides: Partial<EditorTab> = {}): EditorTab {
  return { path: "/a.ts", title: "a.ts", isDirty: false, language: "typescript", ...overrides };
}

describe("isRealFileTab", () => {
  it("is true for a plain file tab", () => {
    expect(isRealFileTab(tab())).toBe(true);
  });

  it("is false for a commit, stash or settings tab", () => {
    expect(isRealFileTab(tab({ commit: { hash: "h", shortHash: "h", file: "a", origFile: null } }))).toBe(false);
    expect(isRealFileTab(tab({ stash: { index: 0, message: "m", file: "a", origFile: null } }))).toBe(false);
    expect(isRealFileTab(tab({ settings: true }))).toBe(false);
  });
});

describe("autoSavableTabs", () => {
  it("keeps only dirty real-file tabs", () => {
    const tabs = [
      tab({ path: "/a.ts", isDirty: true }),
      tab({ path: "/b.ts", isDirty: false }),
      tab({ path: "/c.ts", isDirty: true, settings: true }),
      tab({ path: "/d.ts", isDirty: true, commit: { hash: "h", shortHash: "h", file: "d", origFile: null } }),
    ];
    expect(autoSavableTabs(tabs).map((t) => t.path)).toEqual(["/a.ts"]);
  });
});

describe("autoSaveAppliesTo", () => {
  it("off never applies", () => {
    expect(autoSaveAppliesTo("off", "delay")).toBe(false);
    expect(autoSaveAppliesTo("off", "blur")).toBe(false);
    expect(autoSaveAppliesTo("off", "tab-switch")).toBe(false);
  });

  it("afterDelay only applies to the delay trigger", () => {
    expect(autoSaveAppliesTo("afterDelay", "delay")).toBe(true);
    expect(autoSaveAppliesTo("afterDelay", "blur")).toBe(false);
    expect(autoSaveAppliesTo("afterDelay", "tab-switch")).toBe(false);
  });

  it("onFocusChange applies to window blur and tab switches, not the delay timer", () => {
    expect(autoSaveAppliesTo("onFocusChange", "blur")).toBe(true);
    expect(autoSaveAppliesTo("onFocusChange", "tab-switch")).toBe(true);
    expect(autoSaveAppliesTo("onFocusChange", "delay")).toBe(false);
  });
});
