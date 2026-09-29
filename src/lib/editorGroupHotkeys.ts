import { useEffect } from "react";
import { executeCommand } from "./commands/registry";

export const SPLIT_EDITOR_ID = "workbench.action.splitEditor";
export const MOVE_EDITOR_LEFT_ID = "workbench.action.moveEditorToLeftGroup";
export const MOVE_EDITOR_RIGHT_ID = "workbench.action.moveEditorToRightGroup";
export const MOVE_EDITOR_OTHER_ID = "workbench.action.moveEditorToOtherGroup";
export const FOCUS_LEFT_GROUP_ID = "workbench.action.focusFirstEditorGroup";
export const FOCUS_RIGHT_GROUP_ID = "workbench.action.focusSecondEditorGroup";
export const CLOSE_GROUP_ID = "workbench.action.closeEditorGroup";

export interface GroupHotkeyEvent {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  altGraph: boolean;
  /** The key went to the integrated terminal. */
  inTerminal: boolean;
}

/**
 * The editor group shortcuts, as command ids:
 * - Ctrl+\ — Split Editor
 * - Ctrl+Alt+Left / Right — Move Editor into Left / Right Group
 * - Ctrl+1 / Ctrl+2 — Focus Left / Right Group
 * Ctrl+Alt+1…9 stays with pin groups (the digits here require no Alt), and
 * the terminal keeps Ctrl+\ (SIGQUIT) and Ctrl+Alt+arrows for the shell.
 * Digits and the backslash match the physical key, so non-US layouts
 * (AZERTY's "&", German "#") keep the same key; a layout that types "\" with
 * AltGr can't use Ctrl+\ at all — the palette has the command.
 */
export function matchEditorGroupHotkey(event: GroupHotkeyEvent): string | null {
  const mod = event.ctrlKey || event.metaKey;
  if (!mod || event.shiftKey || event.altGraph) return null;

  if (event.altKey) {
    if (event.inTerminal) return null;
    if (event.key === "ArrowLeft") return MOVE_EDITOR_LEFT_ID;
    if (event.key === "ArrowRight") return MOVE_EDITOR_RIGHT_ID;
    return null;
  }
  if (event.code === "Digit1") return FOCUS_LEFT_GROUP_ID;
  if (event.code === "Digit2") return FOCUS_RIGHT_GROUP_ID;
  if (!event.inTerminal && (event.code === "Backslash" || event.key === "\\")) return SPLIT_EDITOR_ID;
  return null;
}

/** Installs the editor group shortcuts, captured ahead of Monaco and xterm. */
export function useEditorGroupHotkeys(): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const id = matchEditorGroupHotkey({
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        altGraph: event.getModifierState?.("AltGraph") ?? false,
        inTerminal: event.target instanceof Element && Boolean(event.target.closest(".xterm")),
      });
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      void executeCommand(id);
    }
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);
}
