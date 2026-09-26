import { useEffect } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const STEP = 0.1;
const STORAGE_KEY = "code-editor:zoom";
// Wheels and trackpads fire bursts of events; one zoom step per gesture tick.
const WHEEL_COOLDOWN_MS = 80;

export function clampZoom(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, rounded));
}

function readStoredZoom(): number {
  try {
    const stored = Number(localStorage.getItem(STORAGE_KEY));
    return stored > 0 ? clampZoom(stored) : 1;
  } catch {
    return 1;
  }
}

function storeZoom(value: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Zoom still applies for this session; it just won't be remembered.
  }
}

// Whole-window zoom via the webview itself, not CSS `zoom`: CSS zoom breaks
// the mouse-to-text coordinate math in Monaco and xterm.
export function useZoom(): void {
  useEffect(() => {
    const webview = getCurrentWebview();
    let zoom = readStoredZoom();
    let lastWheelStep = 0;

    const apply = (next: number) => {
      zoom = clampZoom(next);
      storeZoom(zoom);
      webview.setZoom(zoom).catch(console.error);
    };

    apply(zoom);

    // Capture phase: runs before Monaco and xterm see the key, otherwise the
    // terminal would forward Ctrl+- to the shell as a control character.
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;

      let next: number | null = null;
      if (event.key === "+" || event.key === "=" || event.code === "NumpadAdd") next = zoom + STEP;
      else if (event.key === "-" || event.key === "_" || event.code === "NumpadSubtract") next = zoom - STEP;
      else if (event.key === "0" || event.code === "Numpad0") next = 1;
      if (next === null) return;

      event.preventDefault();
      event.stopPropagation();
      apply(next);
    }

    function onWheel(event: WheelEvent) {
      if (!(event.ctrlKey && event.shiftKey)) return;
      event.preventDefault();
      event.stopPropagation();

      // Some platforms turn Shift+wheel into horizontal scroll (deltaX).
      const delta = event.deltaY || event.deltaX;
      const now = performance.now();
      if (delta === 0 || now - lastWheelStep < WHEEL_COOLDOWN_MS) return;
      lastWheelStep = now;
      apply(delta < 0 ? zoom + STEP : zoom - STEP);
    }

    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("wheel", onWheel, { capture: true });
    };
  }, []);
}
