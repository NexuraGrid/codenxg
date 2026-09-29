import { describe, expect, it } from "vitest";
import { matchPreviewChord, type ChordKeyEvent } from "../markdownPreviewHotkeys";

const key = (k: string, mods: Partial<ChordKeyEvent> = {}): ChordKeyEvent => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("matchPreviewChord", () => {
  it("starts the chord on Ctrl+K and Cmd+K", () => {
    expect(matchPreviewChord(key("k", { ctrlKey: true }), null, 0)).toBe("start");
    expect(matchPreviewChord(key("K", { metaKey: true }), null, 0)).toBe("start");
  });

  it("runs on V with or without Ctrl held", () => {
    expect(matchPreviewChord(key("v"), 1000, 1500)).toBe("run");
    expect(matchPreviewChord(key("v", { ctrlKey: true }), 1000, 1500)).toBe("run");
  });

  it("ignores a lone V and bare modifier presses", () => {
    expect(matchPreviewChord(key("v"), null, 0)).toBeNull();
    expect(matchPreviewChord(key("Control", { ctrlKey: true }), 1000, 1200)).toBeNull();
  });

  it("cancels on any other key or after the timeout", () => {
    expect(matchPreviewChord(key("x"), 1000, 1200)).toBe("cancel");
    expect(matchPreviewChord(key("v"), 1000, 4000)).toBe("cancel");
  });

  it("leaves Ctrl+Shift+K and Ctrl+Shift+V alone", () => {
    expect(matchPreviewChord(key("K", { ctrlKey: true, shiftKey: true }), null, 0)).toBeNull();
    expect(matchPreviewChord(key("V", { ctrlKey: true, shiftKey: true }), 1000, 1200)).toBe("cancel");
  });
});
