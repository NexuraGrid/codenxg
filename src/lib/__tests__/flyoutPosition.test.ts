import { describe, expect, it } from "vitest";
import { placeFlyout } from "../flyoutPosition";

const viewport = { width: 1000, height: 600 };
const row = (left: number, top: number, width = 200, height = 26) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

describe("placeFlyout", () => {
  it("opens to the right of the anchor, top-aligned", () => {
    expect(placeFlyout(row(0, 100), { width: 300, height: 200 }, viewport)).toEqual({
      left: 204,
      top: 100,
      maxHeight: 584,
      flipped: false,
    });
  });

  it("flips left when the right side has no room", () => {
    const placed = placeFlyout(row(700, 100, 250), { width: 300, height: 200 }, viewport);
    expect(placed).toMatchObject({ left: 396, flipped: true });
  });

  it("clamps into the viewport when neither side fits", () => {
    const placed = placeFlyout(row(100, 100, 700), { width: 400, height: 200 }, viewport);
    expect(placed).toMatchObject({ left: 592, flipped: false });
    const wide = placeFlyout(row(0, 0), { width: 1200, height: 100 }, viewport);
    expect(wide.left).toBe(8);
  });

  it("moves up near the bottom edge", () => {
    expect(placeFlyout(row(0, 550), { width: 300, height: 200 }, viewport).top).toBe(392);
  });

  it("caps a panel taller than the viewport, which then scrolls", () => {
    const placed = placeFlyout(row(0, 300), { width: 300, height: 2000 }, viewport);
    expect(placed).toMatchObject({ top: 8, maxHeight: 584 });
  });
});
