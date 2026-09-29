/**
 * Looking at a post's photo up close — the numbers behind the viewer
 * (NOTES §65), with no screen: tested in tests/photo-view.test.ts.
 *
 * The owner: *"when i see the post with a picture, i can't click on the
 * picture. i want it to work like facebook where after clicking the picture,
 * i can zoom in zoom out"*.
 *
 * The photo is drawn at `scale = fit × zoom`, where `fit` shows all of it in
 * the frame, and moved by `x, y` — its centre's distance from the frame's
 * centre, in points on screen. The same shape as the profile photo's circle
 * (src/core/crop.ts), with the opposite starting point: there the photo must
 * fill the circle; here it must all be seen, and can only be moved once it is
 * bigger than the frame — and never so far that its edge comes away from the
 * frame's.
 */

export const VIEW_ZOOM_MIN = 1;
export const VIEW_ZOOM_MAX = 4;
/** Where a double tap takes a photo that is not zoomed. */
export const DOUBLE_TAP_ZOOM = 2.5;

export interface ViewPlacement {
  zoom: number;
  x: number;
  y: number;
}

export const VIEW_START: ViewPlacement = { zoom: 1, x: 0, y: 0 };

interface Frame {
  /** The photo's own size, in pixels. */
  width: number;
  height: number;
  /** The space it is shown in, in points. */
  frameWidth: number;
  frameHeight: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The scale at zoom 1: the whole photo, as big as the frame allows. */
export function fitScale({ width, height, frameWidth, frameHeight }: Frame): number {
  return Math.min(frameWidth / Math.max(1, width), frameHeight / Math.max(1, height));
}

/** A placement brought back inside what keeps the photo's edges at the frame's. */
export function clampView(p: ViewPlacement, f: Frame): ViewPlacement {
  const zoom = clamp(p.zoom, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
  const scale = fitScale(f) * zoom;
  const roomX = Math.max(0, (f.width * scale - f.frameWidth) / 2);
  const roomY = Math.max(0, (f.height * scale - f.frameHeight) / 2);
  return { zoom, x: clamp(p.x, -roomX, roomX), y: clamp(p.y, -roomY, roomY) };
}

/**
 * A new zoom, keeping the point under the fingers (or the pointer) where it
 * is — `px, py` from the frame's centre, in points. The buttons zoom about
 * the middle: `px = py = 0`.
 */
export function zoomViewAbout(p: ViewPlacement, zoom: number, px: number, py: number, f: Frame): ViewPlacement {
  const next = clamp(zoom, VIEW_ZOOM_MIN, VIEW_ZOOM_MAX);
  const ratio = next / p.zoom;
  return clampView({ zoom: next, x: px - (px - p.x) * ratio, y: py - (py - p.y) * ratio }, f);
}

/** A double tap: in to `DOUBLE_TAP_ZOOM` at that point, or back out to the whole photo. */
export function doubleTap(p: ViewPlacement, px: number, py: number, f: Frame): ViewPlacement {
  return p.zoom > VIEW_ZOOM_MIN ? VIEW_START : zoomViewAbout(p, DOUBLE_TAP_ZOOM, px, py, f);
}

/** Where the photo is drawn: its size, and its top-left from the frame's centre. */
export function viewDrawn(p: ViewPlacement, f: Frame) {
  const scale = fitScale(f) * p.zoom;
  const w = f.width * scale;
  const h = f.height * scale;
  return { width: w, height: h, left: p.x - w / 2, top: p.y - h / 2 };
}
