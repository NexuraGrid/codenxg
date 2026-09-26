import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useExplorerStore } from "../state/explorerStore";
import { movePath } from "../lib/explorerActions";
import { isSameOrInside } from "../lib/paths";

export interface DragSource {
  path: string;
  name: string;
  isDir: boolean;
  parentPath: string;
}

// Past this distance a press becomes a drag; below it, it stays a click.
const DRAG_THRESHOLD_PX = 4;
// Hovering a collapsed folder this long opens it, so deep targets are reachable.
const AUTO_EXPAND_MS = 600;
const GHOST_OFFSET = { x: 14, y: 10 };

interface PendingDrag {
  source: DragSource;
  startX: number;
  startY: number;
  active: boolean;
}

// Drop target = nearest element carrying data-drop-dir (a folder row points
// at itself, a file row at its parent, the tree background at the root).
function targetAt(x: number, y: number): { dir: string | null; folder: string | null } {
  const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-dir]");
  return { dir: element?.dataset.dropDir ?? null, folder: element?.dataset.folder ?? null };
}

function canDrop(source: DragSource, dir: string): boolean {
  // Already there, or a folder into itself / its own subfolders.
  return dir !== source.parentPath && !isSameOrInside(dir, source.path);
}

/**
 * Pointer-event drag and drop for the explorer. HTML5 drag and drop is avoided
 * on purpose: Tauri claims window-level drag events for OS file drops, which
 * can swallow them inside the webview.
 */
export function useTreeDrag() {
  const [ghost, setGhost] = useState<DragSource | null>(null);
  const pendingRef = useRef<PendingDrag | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const lastPointRef = useRef({ x: 0, y: 0 });
  const suppressClickRef = useRef(false);

  const placeGhost = useCallback((element: HTMLDivElement | null) => {
    ghostRef.current = element;
    const { x, y } = lastPointRef.current;
    if (element) element.style.transform = `translate(${x + GHOST_OFFSET.x}px, ${y + GHOST_OFFSET.y}px)`;
  }, []);

  const beginPointer = useCallback((event: ReactPointerEvent, source: DragSource) => {
    if (event.button !== 0) return;
    pendingRef.current = { source, startX: event.clientX, startY: event.clientY, active: false };
  }, []);

  /** A drag ends with a click on the row it started from; ignore that click. */
  const isClickSuppressed = useCallback(() => suppressClickRef.current, []);

  useEffect(() => {
    let expandTimer: { folder: string; id: number } | null = null;

    function clearExpandTimer() {
      if (expandTimer) window.clearTimeout(expandTimer.id);
      expandTimer = null;
    }

    function scheduleExpand(folder: string | null, source: DragSource) {
      const explorer = useExplorerStore.getState();
      if (!folder || folder === source.path || explorer.expanded[folder]) {
        clearExpandTimer();
        return;
      }
      if (expandTimer?.folder === folder) return;
      clearExpandTimer();
      expandTimer = { folder, id: window.setTimeout(() => useExplorerStore.getState().expand(folder), AUTO_EXPAND_MS) };
    }

    function onMove(event: PointerEvent) {
      const pending = pendingRef.current;
      if (!pending) return;
      lastPointRef.current = { x: event.clientX, y: event.clientY };

      if (!pending.active) {
        const distance = Math.hypot(event.clientX - pending.startX, event.clientY - pending.startY);
        if (distance < DRAG_THRESHOLD_PX) return;
        pending.active = true;
        setGhost(pending.source);
        document.body.classList.add("is-dragging-entry");
      }

      placeGhost(ghostRef.current);
      const { dir, folder } = targetAt(event.clientX, event.clientY);
      useExplorerStore.getState().setDrag(pending.source.path, dir && canDrop(pending.source, dir) ? dir : null);
      scheduleExpand(folder, pending.source);
    }

    function finish(drop: boolean) {
      const pending = pendingRef.current;
      pendingRef.current = null;
      clearExpandTimer();
      if (!pending?.active) return;

      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);

      const explorer = useExplorerStore.getState();
      const target = explorer.dropTarget;
      explorer.setDrag(null, null);
      setGhost(null);
      document.body.classList.remove("is-dragging-entry");

      if (drop && target) {
        movePath(pending.source.path, pending.source.parentPath, target).catch(console.error);
      }
    }

    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && pendingRef.current?.active) {
        event.preventDefault();
        event.stopPropagation();
        finish(false);
      }
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("blur", onCancel);
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      clearExpandTimer();
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("blur", onCancel);
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      document.body.classList.remove("is-dragging-entry");
    };
  }, [placeGhost]);

  return { ghost, placeGhost, beginPointer, isClickSuppressed };
}
