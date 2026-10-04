/**
 * Where the overlay window goes. Pure: no electron import, so it is testable
 * in Vitest (Global Constraint 4).
 *
 * The bug it fixes: overlay-window.ts positioned the pill from
 * `screen.getPrimaryDisplay()`, once, in create(). With two monitors the pill
 * came out on the primary screen no matter where the user was working, and it
 * never moved afterwards. The spec asks for
 * `getDisplayNearestPoint(getCursorScreenPoint())` recomputed at every
 * `show()`.
 *
 * `DisplayLike` is structurally what Electron's `Display` gives (`id`,
 * `bounds`, `workArea`), so the caller passes `screen.getAllDisplays()`
 * straight in.
 */
export interface Rect { x: number; y: number; width: number; height: number }
export interface DisplayLike { id: number; bounds: Rect; workArea: Rect }
export interface Point { x: number; y: number }
export interface Size { width: number; height: number }
export interface OverlayBounds extends Rect { displayId: number }

/** The dictation pill: 360×56 of visible pill inside a 420×124 window.
 *  Frozen: `Readonly<Size>` is compile-time only, and callers spread it, but
 *  freezing costs nothing and rules out an accidental runtime mutation. */
export const PILL_WINDOW_SIZE: Readonly<Size> = Object.freeze({ width: 420, height: 124 });
/** The suggesting state: gist row + three variant rows (spec §7). Height
 *  grown for Important 7 (final review): the CSS line-clamp on each variant's
 *  text went from 2 to 8 lines so a variant up to LENGTH_MAX = 280 chars
 *  (variant-filter.ts) is fully readable before it can be accepted — see the
 *  comment on `.variant .vtext` in overlay.css for the sizing math. Width is
 *  unchanged: both this and PILL_WINDOW_SIZE are centered on the work area
 *  independently of their own width (see computeOverlayBounds), so growing
 *  only the height cannot introduce a horizontal jump between the two. */
export const SUGGEST_WINDOW_SIZE: Readonly<Size> = Object.freeze({ width: 480, height: 520 });
/** The window extends this far past the work-area bottom so the pill's
 *  box-shadow is not clipped; the CSS pulls the pill back up. */
export const SHADOW_MARGIN = 24;

/** Squared distance from `p` to the nearest point of `r`; 0 when inside. */
function distanceSquared(r: Rect, p: Point): number {
  const dx = p.x < r.x ? r.x - p.x : p.x > r.x + r.width ? p.x - (r.x + r.width) : 0;
  const dy = p.y < r.y ? r.y - p.y : p.y > r.y + r.height ? p.y - (r.y + r.height) : 0;
  return dx * dx + dy * dy;
}

function contains(r: Rect, p: Point): boolean {
  // Half-open on the right/bottom edges: with adjacent screens, x = 1512 is
  // the first column of the second screen, not the last of the first.
  return p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height;
}

export function pickDisplay(displays: readonly DisplayLike[], cursor: Point): DisplayLike {
  if (displays.length === 0) throw new RangeError("pickDisplay: no displays given");
  for (const d of displays) if (contains(d.bounds, cursor)) return d;
  // The cursor can sit in a gap (mismatched resolutions) or, briefly, outside
  // every screen: fall back to the nearest one instead of the primary.
  return displays.reduce((best, d) =>
    distanceSquared(d.bounds, cursor) < distanceSquared(best.bounds, cursor) ? d : best, displays[0]!); // length checked
}

/**
 * Bottom-center of the work area of the display under the cursor, with the
 * shadow margin hanging below. Clamped so the window never starts left of or
 * above the work area even when it is wider/taller than the screen.
 */
export function computeOverlayBounds(displays: readonly DisplayLike[], cursor: Point, size: Size): OverlayBounds {
  if (displays.length === 0) throw new RangeError("computeOverlayBounds: no displays given");
  const display = pickDisplay(displays, cursor);
  const wa = display.workArea;
  // Round the FINAL coordinate, not an intermediate offset: rounding only
  // the centering half-width (as this used to) leaves a fractional work
  // area's x still fractional, and left y unrounded entirely.
  const x = Math.round(Math.max(wa.x, wa.x + (wa.width - size.width) / 2));
  const y = Math.round(Math.max(wa.y, wa.y + wa.height - size.height + SHADOW_MARGIN));
  return { x, y, width: size.width, height: size.height, displayId: display.id };
}
