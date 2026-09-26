import { beforeEach, describe, expect, it, vi } from "vitest";

const writeText = vi.fn().mockResolvedValue(undefined);
const readText = vi.fn();
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeText(text),
  readText: () => readText(),
}));

const { canCopyTerminalSelection, copyTerminalSelection, pasteIntoTerminal } = await import("../terminalClipboard");

function fakeTerminal(selection: string) {
  return {
    hasSelection: () => selection.length > 0,
    getSelection: () => selection,
    clearSelection: vi.fn(),
    paste: vi.fn(),
  };
}

beforeEach(() => {
  writeText.mockClear();
  readText.mockReset();
});

describe("canCopyTerminalSelection", () => {
  it("is false with no selection", () => {
    expect(canCopyTerminalSelection(fakeTerminal(""))).toBe(false);
  });

  it("is true once there is a selection", () => {
    expect(canCopyTerminalSelection(fakeTerminal("hello"))).toBe(true);
  });
});

describe("copyTerminalSelection", () => {
  it("writes the selection to the clipboard and clears it", async () => {
    const terminal = fakeTerminal("hello world");
    await copyTerminalSelection(terminal);
    expect(writeText).toHaveBeenCalledWith("hello world");
    expect(terminal.clearSelection).toHaveBeenCalled();
  });

  it("does nothing when there is no selection", async () => {
    const terminal = fakeTerminal("");
    await copyTerminalSelection(terminal);
    expect(writeText).not.toHaveBeenCalled();
    expect(terminal.clearSelection).not.toHaveBeenCalled();
  });
});

describe("pasteIntoTerminal", () => {
  it("pastes the clipboard's text through the terminal's own bracketed-paste path", async () => {
    readText.mockResolvedValue("pasted text");
    const terminal = fakeTerminal("");
    await pasteIntoTerminal(terminal);
    expect(terminal.paste).toHaveBeenCalledWith("pasted text");
  });

  it("does nothing for an empty clipboard", async () => {
    readText.mockResolvedValue("");
    const terminal = fakeTerminal("");
    await pasteIntoTerminal(terminal);
    expect(terminal.paste).not.toHaveBeenCalled();
  });

  it("does nothing when reading the clipboard fails", async () => {
    readText.mockRejectedValue(new Error("denied"));
    const terminal = fakeTerminal("");
    await expect(pasteIntoTerminal(terminal)).resolves.toBeUndefined();
    expect(terminal.paste).not.toHaveBeenCalled();
  });
});
