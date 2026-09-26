import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Just what these helpers need from xterm's `Terminal`, so tests don't need a real one. */
export interface ClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  clearSelection(): void;
  paste(data: string): void;
}

/** Whether the terminal's right-click "Copy" entry should be enabled. */
export function canCopyTerminalSelection(terminal: Pick<ClipboardTerminal, "hasSelection">): boolean {
  return terminal.hasSelection();
}

/** Same path as Ctrl+Shift+C / Ctrl+C-with-a-selection: write through the native clipboard plugin. */
export async function copyTerminalSelection(terminal: ClipboardTerminal): Promise<void> {
  if (!terminal.hasSelection()) return;
  try {
    await writeText(terminal.getSelection());
  } catch (error) {
    console.error(error);
    return;
  }
  terminal.clearSelection();
}

/** Same path as Ctrl+V / Ctrl+Shift+V: read the native clipboard, then xterm's own (bracketed) paste. */
export async function pasteIntoTerminal(terminal: Pick<ClipboardTerminal, "paste">): Promise<void> {
  let text: string | null;
  try {
    text = await readText();
  } catch (error) {
    console.error(error);
    return;
  }
  if (text) terminal.paste(text);
}
