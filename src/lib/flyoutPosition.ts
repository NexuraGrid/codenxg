export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface FlyoutPlacement {
  left: number;
  top: number;
  /** Cap for the panel's height; it scrolls past this. */
  maxHeight: number;
  /** True when it opened to the left of the anchor for lack of room on the right. */
  flipped: boolean;
}

/**
 * Where a panel beside `anchor` goes: to its right, top-aligned with it,
 * flipping to the left when the right side has no room, then clamped so it
 * stays `margin` inside the viewport. A panel taller than the viewport is
 * capped (see maxHeight) rather than pushed off-screen.
 */
export function placeFlyout(anchor: Box, panel: Size, viewport: Size, margin = 8, gap = 4): FlyoutPlacement {
  const maxHeight = Math.max(0, viewport.height - margin * 2);
  const height = Math.min(panel.height, maxHeight);
  const maxLeft = viewport.width - margin - panel.width;

  let left = anchor.right + gap;
  let flipped = false;
  if (left > maxLeft) {
    const leftSide = anchor.left - gap - panel.width;
    if (leftSide >= margin) {
      left = leftSide;
      flipped = true;
    } else {
      left = maxLeft;
    }
  }
  left = Math.max(margin, left);

  const top = Math.max(margin, Math.min(anchor.top, viewport.height - margin - height));
  return { left, top, maxHeight, flipped };
}
