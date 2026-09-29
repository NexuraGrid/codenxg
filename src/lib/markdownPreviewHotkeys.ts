import { useEffect } from "react";
import { executeCommand } from "./commands/registry";

export const PREVIEW_TO_SIDE_ID = "markdown.showPreviewToSide";

/** How long the second stroke of Ctrl+K V may take, as in VS Code. */
const CHORD_TIMEOUT_MS = 2000;

export interface ChordKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Meta", "Shift", "Alt", "AltGraph"]);

/**
 * Ctrl+K V outside Monaco (file tree, tab bar, the preview itself). Inside
 * the editor Monaco owns the chord — its action handles both Ctrl+K V and
 * Ctrl+K Ctrl+V — so its other Ctrl+K chords keep working.
 * Returns what to do with the event: "start" swallows Ctrl+K and waits,
 * "run" swallows V and fires, "cancel" drops a pending chord, null ignores.
 */
export function matchPreviewChord(
  event: ChordKeyEvent,
  pendingSince: number | null,
  now: number,
): "start" | "run" | "cancel" | null {
  if (MODIFIER_KEYS.has(event.key)) return null;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  const pending = pendingSince !== null && now - pendingSince <= CHORD_TIMEOUT_MS;

  // Holding Ctrl through the second stroke (Ctrl+K Ctrl+V) counts too.
  if (pending && key === "v" && !event.altKey && !event.shiftKey) return "run";
  if (mod && key === "k" && !event.altKey && !event.shiftKey) return "start";
  return pendingSince !== null ? "cancel" : null;
}

/** Installs Ctrl+K V for when focus is outside the editor and terminal. */
export function useMarkdownPreviewHotkeys(canRun: () => boolean): void {
  useEffect(() => {
    let pendingSince: number | null = null;

    function onKeyDown(event: KeyboardEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".monaco-editor, .xterm") || target?.matches("input, textarea")) {
        pendingSince = null;
        return;
      }
      const action = matchPreviewChord(event, pendingSince, Date.now());
      if (action === null) return;
      if (action === "cancel") {
        pendingSince = null;
        return;
      }
      if (action === "start") {
        if (!canRun()) return;
        pendingSince = Date.now();
      } else {
        pendingSince = null;
        void executeCommand(PREVIEW_TO_SIDE_ID);
      }
      event.preventDefault();
      event.stopPropagation();
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [canRun]);
}
