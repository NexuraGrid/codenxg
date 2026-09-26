import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Mirrors the window's maximized state onto <html data-maximized>, so CSS can
 * drop the rounded window corners when the window fills the screen.
 */
export function useMaximizedAttribute(): void {
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    const sync = () =>
      appWindow
        .isMaximized()
        .then((maximized) => {
          document.documentElement.toggleAttribute("data-maximized", maximized);
        })
        .catch(console.error);

    sync();
    appWindow
      .onResized(sync)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
