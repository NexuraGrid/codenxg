import { beforeEach, describe, expect, it, vi } from "vitest";
import * as monaco from "monaco-editor";

const writeText = vi.fn().mockResolvedValue(undefined);
const readText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeText(text),
  readText: () => readText(),
}));

const { copy, cut, paste, focusedEditor } = await import("../editorClipboard");

// A minimal stand-in for IStandaloneCodeEditor: only what copy/cut/paste
// actually call, backed by a real Monaco model so selections and edits behave
// exactly like the real editor would.
function fakeEditor(text: string) {
  const model = monaco.editor.createModel(text, "plaintext");
  let selections: monaco.Selection[] = [new monaco.Selection(1, 1, 1, 1)];
  const trigger = vi.fn((_source: string, handlerId: string, payload?: unknown) => {
    if (handlerId === "editor.action.deleteLines") {
      const lines = new Set(selections.map((s) => s.positionLineNumber));
      const kept = model
        .getValue()
        .split("\n")
        .filter((_, i) => !lines.has(i + 1));
      model.setValue(kept.join("\n"));
    }
    if (handlerId === "paste") {
      const { text: pasted } = payload as { text: string };
      const edits = selections.map((range) => ({ range, text: pasted }));
      model.pushEditOperations([], edits, () => null);
    }
  });
  return {
    model,
    setSelections: (s: monaco.Selection[]) => (selections = s),
    getModel: () => model,
    getSelections: () => selections,
    trigger,
    pushUndoStop: vi.fn(),
    executeEdits: vi.fn((_source: string, edits: { range: monaco.IRange; text: string }[]) => {
      model.pushEditOperations([], edits, () => null);
    }),
  };
}

beforeEach(() => {
  writeText.mockClear();
  readText.mockReset();
});

describe("copy", () => {
  it("copies the whole cursor line when the selection is empty", async () => {
    const editor = fakeEditor("first\nsecond\nthird");
    editor.setSelections([new monaco.Selection(2, 3, 2, 3)]);

    const ok = await copy(editor as unknown as Parameters<typeof copy>[0]);

    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith(`second${editor.model.getEOL()}`);
  });

  it("copies only the selected text when there is a selection", async () => {
    const editor = fakeEditor("hello world");
    editor.setSelections([new monaco.Selection(1, 1, 1, 6)]);

    await copy(editor as unknown as Parameters<typeof copy>[0]);

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("reports failure and doesn't remember the copy when the plugin write rejects", async () => {
    writeText.mockRejectedValueOnce(new Error("denied"));
    const editor = fakeEditor("hello world");
    editor.setSelections([new monaco.Selection(1, 1, 1, 6)]);

    const ok = await copy(editor as unknown as Parameters<typeof copy>[0]);
    expect(ok).toBe(false);
  });
});

describe("cut", () => {
  it("deletes the whole line for an empty selection, like the keyboard shortcut", async () => {
    const editor = fakeEditor("first\nsecond\nthird");
    editor.setSelections([new monaco.Selection(2, 1, 2, 1)]);

    await cut(editor as unknown as Parameters<typeof cut>[0]);

    expect(writeText).toHaveBeenCalledWith(`second${editor.model.getEOL()}`);
    expect(editor.trigger).toHaveBeenCalledWith("keyboard", "editor.action.deleteLines", null);
    expect(editor.model.getValue()).toBe("first\nthird");
  });

  it("removes just the selected range when there is a selection", async () => {
    const editor = fakeEditor("hello world");
    editor.setSelections([new monaco.Selection(1, 1, 1, 6)]);

    await cut(editor as unknown as Parameters<typeof cut>[0]);

    expect(editor.model.getValue()).toBe(" world");
  });
});

describe("paste", () => {
  it("goes through Monaco's own paste handler with the clipboard text", async () => {
    readText.mockResolvedValue("pasted");
    const editor = fakeEditor("hello world");
    editor.setSelections([new monaco.Selection(1, 6, 1, 6)]);

    await paste(editor as unknown as Parameters<typeof paste>[0]);

    expect(editor.trigger).toHaveBeenCalledWith(
      "keyboard",
      "paste",
      expect.objectContaining({ text: "pasted" }),
    );
    expect(editor.model.getValue()).toBe("hellopasted world");
  });

  it("does nothing when the clipboard is empty", async () => {
    readText.mockResolvedValue("");
    const editor = fakeEditor("hello world");

    await paste(editor as unknown as Parameters<typeof paste>[0]);

    expect(editor.trigger).not.toHaveBeenCalled();
  });

  it("restores multi-cursor pieces when pasting back what a multi-selection copy produced", async () => {
    const editor = fakeEditor("aaa\nbbb");
    editor.setSelections([new monaco.Selection(1, 1, 1, 1), new monaco.Selection(2, 1, 2, 1)]);
    await copy(editor as unknown as Parameters<typeof copy>[0]);
    const copiedText = writeText.mock.calls[0][0] as string;

    // Pasting back exactly what was just copied is how Monaco/VS Code detect
    // "this is my own multi-cursor copy" — a different clipboard origin (or
    // someone else's copy) never gets multicursorText.
    readText.mockResolvedValue(copiedText);
    await paste(editor as unknown as Parameters<typeof paste>[0]);

    expect(editor.trigger).toHaveBeenLastCalledWith(
      "keyboard",
      "paste",
      expect.objectContaining({ multicursorText: ["aaa\n", "bbb\n"] }),
    );
  });
});

describe("focusedEditor", () => {
  it("returns the editor that currently has text focus", () => {
    const unfocused = { hasTextFocus: () => false };
    const focused = { hasTextFocus: () => true };
    expect(focusedEditor([unfocused, focused])).toBe(focused);
  });

  it("returns undefined when nothing is focused", () => {
    expect(focusedEditor([{ hasTextFocus: () => false }])).toBeUndefined();
  });
});
