import { describe, expect, it } from 'vitest';
import { clampPlacement, coverScale, cropSquare, drawnAt, START, ZOOM_MAX, ZOOM_MIN, zoomAbout } from '../src/core/crop';

/**
 * Placing a photo in the profile circle (NOTES §63). The promise that matters:
 * whatever you do, the circle is full — no empty corner is ever saved as part
 * of somebody's face.
 */

const W = 4032;
const H = 3024;
const D = 300;

describe('the photo fills the circle', () => {
  it('at zoom 1 the shorter side just spans it', () => {
    expect(coverScale(W, H, D) * H).toBeCloseTo(D);
    expect(coverScale(H, W, D) * H).toBeCloseTo(D);
  });

  it('cannot be dragged off the circle, however far', () => {
    const far = clampPlacement({ zoom: 1, x: 99_999, y: -99_999 }, W, H, D);
    const d = drawnAt(far, W, H, D);
    expect(d.left).toBeLessThanOrEqual(-D / 2 + 1e-6);
    expect(d.left + d.width).toBeGreaterThanOrEqual(D / 2 - 1e-6);
    expect(d.top).toBeLessThanOrEqual(-D / 2 + 1e-6);
    expect(d.top + d.height).toBeGreaterThanOrEqual(D / 2 - 1e-6);
    // At zoom 1 a landscape photo can only slide sideways.
    expect(far.y).toBeCloseTo(0);
  });

  it('zooms between filling it and four times that, never past', () => {
    expect(clampPlacement({ zoom: 0.2, x: 0, y: 0 }, W, H, D).zoom).toBe(ZOOM_MIN);
    expect(clampPlacement({ zoom: 99, x: 0, y: 0 }, W, H, D).zoom).toBe(ZOOM_MAX);
  });

  it('zooming out from a corner brings the photo back over the circle', () => {
    const zoomedIn = clampPlacement({ zoom: 3, x: 400, y: 300 }, W, H, D);
    const back = zoomAbout(zoomedIn, 1, 0, 0, W, H, D);
    expect(back).toEqual(clampPlacement(back, W, H, D));
  });
});

describe('what is saved is what is in the circle', () => {
  it('the middle, at the start', () => {
    const sq = cropSquare(START, W, H, D);
    expect(sq.side).toBeCloseTo(H);
    expect(sq.x + sq.side / 2).toBeCloseTo(W / 2);
    expect(sq.y + sq.side / 2).toBeCloseTo(H / 2);
  });

  it('moved right on screen shows more of the left of the photo', () => {
    const p = clampPlacement({ zoom: 1, x: 50, y: 0 }, W, H, D);
    expect(cropSquare(p, W, H, D).x).toBeLessThan(cropSquare(START, W, H, D).x);
  });

  it('zoomed in, a smaller square; always inside the photo', () => {
    for (const p of [
      { zoom: 2, x: 0, y: 0 },
      { zoom: 4, x: 9999, y: 9999 },
      { zoom: 1.5, x: -9999, y: 20 },
    ]) {
      const kept = clampPlacement(p, W, H, D);
      const sq = cropSquare(kept, W, H, D);
      expect(sq.side).toBeCloseTo(H / kept.zoom);
      expect(sq.x).toBeGreaterThanOrEqual(-1e-6);
      expect(sq.y).toBeGreaterThanOrEqual(-1e-6);
      expect(sq.x + sq.side).toBeLessThanOrEqual(W + 1e-6);
      expect(sq.y + sq.side).toBeLessThanOrEqual(H + 1e-6);
    }
  });

  it('zooming about a point keeps that point under the fingers', () => {
    const p = { zoom: 1, x: 0, y: 0 };
    const px = 60;
    const py = -40;
    const before = cropSquare(p, W, H, D);
    const scale0 = coverScale(W, H, D);
    const under = { x: before.x + (px + D / 2) / scale0, y: before.y + (py + D / 2) / scale0 };
    const next = zoomAbout(p, 2, px, py, W, H, D);
    const after = cropSquare(next, W, H, D);
    const scale1 = scale0 * next.zoom;
    expect(after.x + (px + D / 2) / scale1).toBeCloseTo(under.x);
    expect(after.y + (py + D / 2) / scale1).toBeCloseTo(under.y);
  });
});
