/**
 * Placing a photo in the profile circle — the numbers behind the editor
 * (NOTES §63), with no screen: tested in tests/crop.test.ts.
 *
 * The owner: *"when user picked a photo, they should be able to edit it (just
 * like facebook), there's a circle where you could adjust which part of the
 * picture you wanna see, and have opacity outside the circle so users won't
 * get lost. they should be able to zoom in and zoom out."*
 *
 * The photo is drawn at `scale = cover × zoom`, where `cover` just fills the
 * circle, and moved by `x, y` — its centre's distance from the circle's
 * centre, in points on screen. Whatever is inside the circle is the picture.
 * The circle is always covered: the photo can never be moved or shrunk so far
 * that an empty corner shows inside it.
 */

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;

export interface Placement {
  zoom: number;
  x: number;
  y: number;
}

export const START: Placement = { zoom: 1, x: 0, y: 0 };

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The scale at zoom 1: the photo's shorter side just spans the circle. */
export function coverScale(width: number, height: number, circle: number): number {
  return Math.max(circle / Math.max(1, width), circle / Math.max(1, height));
}

/** A placement brought back inside what keeps the circle covered. */
export function clampPlacement(p: Placement, width: number, height: number, circle: number): Placement {
  const zoom = clamp(p.zoom, ZOOM_MIN, ZOOM_MAX);
  const scale = coverScale(width, height, circle) * zoom;
  const roomX = Math.max(0, (width * scale - circle) / 2);
  const roomY = Math.max(0, (height * scale - circle) / 2);
  return { zoom, x: clamp(p.x, -roomX, roomX), y: clamp(p.y, -roomY, roomY) };
}

/**
 * A new zoom, keeping the point under the fingers (or the pointer) where it
 * is — `px, py` from the circle's centre, in points. Zooming from the middle
 * is `px = py = 0`.
 */
export function zoomAbout(p: Placement, zoom: number, px: number, py: number, width: number, height: number, circle: number): Placement {
  const next = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
  const ratio = next / p.zoom;
  return clampPlacement({ zoom: next, x: px - (px - p.x) * ratio, y: py - (py - p.y) * ratio }, width, height, circle);
}

/** Where the photo is drawn on screen: its size, and its top-left from the circle's centre. */
export function drawnAt(p: Placement, width: number, height: number, circle: number) {
  const scale = coverScale(width, height, circle) * p.zoom;
  const w = width * scale;
  const h = height * scale;
  return { width: w, height: h, left: p.x - w / 2, top: p.y - h / 2 };
}

/** The square of the photo inside the circle, in the photo's own pixels — what is saved. */
export function cropSquare(p: Placement, width: number, height: number, circle: number) {
  const scale = coverScale(width, height, circle) * p.zoom;
  const side = circle / scale;
  return {
    x: width / 2 - p.x / scale - side / 2,
    y: height / 2 - p.y / scale - side / 2,
    side,
  };
}
