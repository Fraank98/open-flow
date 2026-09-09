import { describe, it, expect } from "vitest";
import {
  computeOverlayBounds, pickDisplay, PILL_WINDOW_SIZE, SUGGEST_WINDOW_SIZE, SHADOW_MARGIN,
  type DisplayLike,
} from "../../src/main/utils/overlay-bounds.js";

/** A 1512×982 laptop screen with the 25 px menubar excluded from the work area. */
const LAPTOP: DisplayLike = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 25, width: 1512, height: 957 },
};
/** An external 2560×1440 screen to the RIGHT of the laptop. */
const RIGHT: DisplayLike = {
  id: 2,
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1512, y: 25, width: 2560, height: 1415 },
};
/** An external 1920×1080 screen to the LEFT: negative coordinates. */
const LEFT: DisplayLike = {
  id: 3,
  bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
  workArea: { x: -1920, y: -175, width: 1920, height: 1055 },
};

describe("PILL_WINDOW_SIZE / SUGGEST_WINDOW_SIZE / SHADOW_MARGIN", () => {
  it("are the sizes of the spec: 420x124 for the pill, 480x300 for the suggestions, 24 px of shadow", () => {
    expect(PILL_WINDOW_SIZE).toEqual({ width: 420, height: 124 });
    expect(SUGGEST_WINDOW_SIZE).toEqual({ width: 480, height: 300 });
    expect(SHADOW_MARGIN).toBe(24);
  });
});

describe("pickDisplay", () => {
  it("returns the display whose bounds contain the cursor", () => {
    expect(pickDisplay([LAPTOP, RIGHT, LEFT], { x: 700, y: 400 }).id).toBe(1);
    expect(pickDisplay([LAPTOP, RIGHT, LEFT], { x: 2000, y: 900 }).id).toBe(2);
    expect(pickDisplay([LAPTOP, RIGHT, LEFT], { x: -800, y: 300 }).id).toBe(3);
  });
  it("treats the right and bottom edges as belonging to the next display (half-open rectangles)", () => {
    expect(pickDisplay([LAPTOP, RIGHT], { x: 1512, y: 10 }).id).toBe(2);
    expect(pickDisplay([LAPTOP, RIGHT], { x: 1511, y: 10 }).id).toBe(1);
  });
  it("falls back to the nearest display when the cursor is in a gap between displays", () => {
    // A cursor 100 px above the top of both screens: nearest by clamped distance.
    expect(pickDisplay([LAPTOP, RIGHT], { x: 3000, y: -100 }).id).toBe(2);
    expect(pickDisplay([LAPTOP, RIGHT], { x: 10, y: -100 }).id).toBe(1);
  });
  it("throws RangeError on an empty display list", () => {
    expect(() => pickDisplay([], { x: 0, y: 0 })).toThrow(RangeError);
  });
});

describe("computeOverlayBounds", () => {
  it("centers the window on the work area and lets the shadow hang SHADOW_MARGIN below it", () => {
    expect(computeOverlayBounds([LAPTOP], { x: 700, y: 400 }, PILL_WINDOW_SIZE)).toEqual({
      x: 546,            // 0 + (1512 - 420) / 2
      y: 882,            // 25 + 957 - 124 + 24
      width: 420,
      height: 124,
      displayId: 1,
    });
  });

  it("uses the display the cursor is on, not the primary one (the two-monitor bug)", () => {
    const b = computeOverlayBounds([LAPTOP, RIGHT], { x: 2600, y: 700 }, PILL_WINDOW_SIZE);
    expect(b).toEqual({ x: 2582, y: 1340, width: 420, height: 124, displayId: 2 });
  });

  it("handles a display at negative coordinates", () => {
    const b = computeOverlayBounds([LAPTOP, LEFT], { x: -800, y: 300 }, PILL_WINDOW_SIZE);
    expect(b).toEqual({ x: -1170, y: 780, width: 420, height: 124, displayId: 3 });
  });

  it("uses the size it is given: the suggesting window is taller and wider", () => {
    const b = computeOverlayBounds([LAPTOP], { x: 700, y: 400 }, SUGGEST_WINDOW_SIZE);
    expect(b).toEqual({ x: 516, y: 706, width: 480, height: 300, displayId: 1 });
  });

  it("rounds to integers: Electron setBounds takes integers", () => {
    const odd: DisplayLike = { id: 9, bounds: { x: 0, y: 0, width: 1511, height: 900 }, workArea: { x: 0, y: 0, width: 1511, height: 900 } };
    expect(computeOverlayBounds([odd], { x: 5, y: 5 }, PILL_WINDOW_SIZE).x).toBe(546); // 545.5 → 546
  });

  it("never places the window left of or above the work area, even if it does not fit", () => {
    const tiny: DisplayLike = { id: 8, bounds: { x: 100, y: 100, width: 320, height: 200 }, workArea: { x: 100, y: 100, width: 320, height: 200 } };
    const b = computeOverlayBounds([tiny], { x: 150, y: 150 }, SUGGEST_WINDOW_SIZE);
    expect(b.x).toBe(100);
    expect(b.y).toBe(100);
  });

  it("throws RangeError on an empty display list", () => {
    expect(() => computeOverlayBounds([], { x: 0, y: 0 }, PILL_WINDOW_SIZE)).toThrow(RangeError);
  });
});
