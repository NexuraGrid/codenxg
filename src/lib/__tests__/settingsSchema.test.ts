import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../settingsSchema";

describe("mergeSettings", () => {
  it("returns the defaults for undefined input", () => {
    expect(mergeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("returns the defaults for non-object input", () => {
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings([1, 2, 3])).toEqual(DEFAULT_SETTINGS);
  });

  it("keeps valid overrides", () => {
    const result = mergeSettings({
      editor: { fontSize: 18, wordWrap: true, tabSize: 2 },
      files: { autoSave: "afterDelay", autoSaveDelayMs: 2000 },
      terminal: { fontSize: 16 },
    });
    expect(result.editor.fontSize).toBe(18);
    expect(result.editor.wordWrap).toBe(true);
    expect(result.editor.tabSize).toBe(2);
    expect(result.files.autoSave).toBe("afterDelay");
    expect(result.files.autoSaveDelayMs).toBe(2000);
    expect(result.terminal.fontSize).toBe(16);
  });

  it("drops unknown top-level and nested keys", () => {
    const result = mergeSettings({
      editor: { fontSize: 18, madeUpKey: "whatever" },
      somethingElse: true,
    });
    expect(result).not.toHaveProperty("somethingElse");
    expect(result.editor).not.toHaveProperty("madeUpKey");
    expect(result.editor.fontSize).toBe(18);
  });

  it("falls back to default when a field has the wrong type", () => {
    const result = mergeSettings({
      editor: { fontSize: "huge", insertSpaces: "yes" },
      files: { autoSaveDelayMs: "soon" },
    });
    expect(result.editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
    expect(result.editor.insertSpaces).toBe(DEFAULT_SETTINGS.editor.insertSpaces);
    expect(result.files.autoSaveDelayMs).toBe(DEFAULT_SETTINGS.files.autoSaveDelayMs);
  });

  it("falls back to default when a number is out of range", () => {
    expect(mergeSettings({ editor: { tabSize: 0 } }).editor.tabSize).toBe(DEFAULT_SETTINGS.editor.tabSize);
    expect(mergeSettings({ editor: { tabSize: 999 } }).editor.tabSize).toBe(DEFAULT_SETTINGS.editor.tabSize);
    expect(mergeSettings({ editor: { fontSize: 0 } }).editor.fontSize).toBe(DEFAULT_SETTINGS.editor.fontSize);
  });

  it("falls back to default when autoSave isn't one of the known modes", () => {
    expect(mergeSettings({ files: { autoSave: "sometimes" } }).files.autoSave).toBe("off");
  });

  it("falls back to default when a font family is an empty string", () => {
    expect(mergeSettings({ editor: { fontFamily: "" } }).editor.fontFamily).toBe(DEFAULT_SETTINGS.editor.fontFamily);
  });

  it("treats a non-object section as entirely missing", () => {
    const result = mergeSettings({ editor: "nonsense", files: null });
    expect(result.editor).toEqual(DEFAULT_SETTINGS.editor);
    expect(result.files).toEqual(DEFAULT_SETTINGS.files);
  });
});
