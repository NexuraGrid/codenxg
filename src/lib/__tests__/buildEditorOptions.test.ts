import { describe, expect, it } from "vitest";
import { buildEditorOptions, resolveFontFamily } from "../buildEditorOptions";
import { DEFAULT_SETTINGS } from "../settingsSchema";

describe("resolveFontFamily", () => {
  it("quotes a bare font name and adds the monospace fallback chain", () => {
    expect(resolveFontFamily("JetBrains Mono")).toBe('"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace');
  });

  it("passes an existing font stack through unchanged", () => {
    expect(resolveFontFamily("Fira Code, monospace")).toBe("Fira Code, monospace");
  });

  it("falls back to the default font for an empty value", () => {
    expect(resolveFontFamily("   ")).toBe(resolveFontFamily("JetBrains Mono"));
  });
});

describe("buildEditorOptions", () => {
  it("maps wordWrap, minimap and renderWhitespace booleans to Monaco's option shapes", () => {
    const on = buildEditorOptions({ ...DEFAULT_SETTINGS.editor, wordWrap: true, minimap: true, renderWhitespace: true });
    expect(on.wordWrap).toBe("on");
    expect(on.minimap).toEqual({ enabled: true });
    expect(on.renderWhitespace).toBe("all");

    const off = buildEditorOptions({ ...DEFAULT_SETTINGS.editor, wordWrap: false, minimap: false, renderWhitespace: false });
    expect(off.wordWrap).toBe("off");
    expect(off.minimap).toEqual({ enabled: false });
    expect(off.renderWhitespace).toBe("none");
  });

  it("carries fontSize and lineHeight through as-is", () => {
    const options = buildEditorOptions({ ...DEFAULT_SETTINGS.editor, fontSize: 20, lineHeight: 30 });
    expect(options.fontSize).toBe(20);
    expect(options.lineHeight).toBe(30);
  });

  it("does not set model-level options (tabSize/insertSpaces/detectIndentation)", () => {
    const options = buildEditorOptions(DEFAULT_SETTINGS.editor);
    expect(options).not.toHaveProperty("tabSize");
    expect(options).not.toHaveProperty("insertSpaces");
    expect(options).not.toHaveProperty("detectIndentation");
  });
});
