import { useEffect, useRef } from "react";

interface HotkeyOptions {
  /** Listen in the capture phase, ahead of Monaco/xterm's own key handling. */
  capture?: boolean;
  /** Return false to let the key through untouched (e.g. inside the terminal). */
  when?: (event: KeyboardEvent) => boolean;
  /** Match the physical key (`event.code`) instead of the produced character. */
  matchCode?: string;
}

// "mod" maps to Cmd on macOS and Ctrl elsewhere.
export function useHotkey(combo: string, handler: () => void, options: HotkeyOptions = {}): void {
  // Latest handler/predicate without re-subscribing on every render.
  const handlerRef = useRef(handler);
  const whenRef = useRef(options.when);
  handlerRef.current = handler;
  whenRef.current = options.when;
  const capture = options.capture ?? false;
  const matchCode = options.matchCode;

  useEffect(() => {
    const parts = combo.toLowerCase().split("+");
    const key = parts[parts.length - 1];
    const needsMod = parts.includes("mod");
    const needsShift = parts.includes("shift");

    function onKeyDown(event: KeyboardEvent) {
      const modPressed = event.metaKey || event.ctrlKey;
      if (needsMod !== modPressed || needsShift !== event.shiftKey || event.altKey) return;
      if (matchCode ? event.code !== matchCode : event.key.toLowerCase() !== key) return;
      if (whenRef.current && !whenRef.current(event)) return;
      event.preventDefault();
      if (capture) event.stopPropagation();
      handlerRef.current();
    }

    window.addEventListener("keydown", onKeyDown, { capture });
    return () => window.removeEventListener("keydown", onKeyDown, { capture });
  }, [combo, capture, matchCode]);
}
