import { useLayoutEffect, useState, type RefObject } from "react";
import { placeFlyout, type FlyoutPlacement } from "../lib/flyoutPosition";

/**
 * Keeps `panel` beside `anchor` (see placeFlyout) while `active`: measured
 * before paint, and again on resize or when anything scrolls. `contentKey`
 * re-measures when the panel's contents change size.
 */
export function useFlyoutPlacement(
  anchorRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  active: boolean,
  contentKey?: unknown,
): FlyoutPlacement | null {
  const [placement, setPlacement] = useState<FlyoutPlacement | null>(null);

  useLayoutEffect(() => {
    if (!active) {
      setPlacement(null);
      return;
    }
    function update(event?: Event) {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      // The panel scrolling its own list doesn't move it.
      if (!anchor || !panel || (event && event.target === panel)) return;
      const next = placeFlyout(
        anchor.getBoundingClientRect(),
        { width: panel.offsetWidth, height: panel.scrollHeight },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPlacement((prev) =>
        prev &&
        prev.left === next.left &&
        prev.top === next.top &&
        prev.maxHeight === next.maxHeight &&
        prev.flipped === next.flipped
          ? prev
          : next,
      );
    }
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [active, anchorRef, panelRef, contentKey]);

  return placement;
}

/** Inline style for a flyout: hidden until measured, so it never flashes at 0,0. */
export function flyoutStyle(placement: FlyoutPlacement | null) {
  return placement
    ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
    : { left: 0, top: 0, visibility: "hidden" as const };
}
