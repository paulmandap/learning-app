import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  clampView,
  doubleTap,
  DOUBLE_TAP_ZOOM,
  fitScale,
  VIEW_START,
  VIEW_ZOOM_MAX,
  viewDrawn,
  zoomViewAbout,
} from '../src/core/photo-view';

/**
 * A post's photo, the whole screen, to zoom into (NOTES §65) — the owner:
 * *"i want it to work like facebook where after clicking the picture, i can
 * zoom in zoom out, the like comment share can still be seen at the bottom
 * part."*
 */

// A 4032 × 3024 phone photo in a 393 × 600 frame: as wide as the frame at zoom 1.
const PHOTO = { width: 4032, height: 3024, frameWidth: 393, frameHeight: 600 };

describe('the numbers', () => {
  it('shows the whole photo at zoom 1, as big as the frame allows', () => {
    const d = viewDrawn(VIEW_START, PHOTO);
    expect(d.width).toBeCloseTo(393);
    expect(d.height).toBeCloseTo(393 * (3024 / 4032));
    expect(d.left).toBeCloseTo(-393 / 2);
    // A tall photo in a wide frame is fitted by its height instead.
    expect(fitScale({ width: 1000, height: 3000, frameWidth: 800, frameHeight: 600 })).toBeCloseTo(0.2);
  });

  it('cannot be moved at its whole size — there is nothing hidden to move to', () => {
    const p = clampView({ zoom: 1, x: 80, y: -50 }, PHOTO);
    expect(p.zoom).toBe(1);
    expect(Math.abs(p.x) + Math.abs(p.y)).toBe(0);
  });

  it('zoomed, moves only as far as keeps its edge at the frame’s', () => {
    const p = clampView({ zoom: 2, x: 9999, y: 9999 }, PHOTO);
    const d = viewDrawn(p, PHOTO);
    // Its left edge exactly at the frame's left edge, never past it.
    expect(PHOTO.frameWidth / 2 + d.left).toBeCloseTo(0);
    // Its height (589.5) is still less than the frame's, so it stays centred up and down.
    expect(p.y).toBe(0);
  });

  it('zooms from 1× to 4×, and no further either way', () => {
    expect(zoomViewAbout(VIEW_START, 0.2, 0, 0, PHOTO).zoom).toBe(1);
    expect(zoomViewAbout(VIEW_START, 99, 0, 0, PHOTO).zoom).toBe(VIEW_ZOOM_MAX);
  });

  it('keeps the point under the fingers where it is', () => {
    // A point 100 to the right of the centre: the photo moves out from under it.
    const p = zoomViewAbout(VIEW_START, 2, 100, 0, PHOTO);
    expect(p.x).toBeCloseTo(-100);
    const before = (100 - VIEW_START.x) / (fitScale(PHOTO) * 1);
    const after = (100 - p.x) / (fitScale(PHOTO) * 2);
    expect(after).toBeCloseTo(before);
  });

  it('a double tap goes in where it was tapped, and a second one comes back out', () => {
    const inside = doubleTap(VIEW_START, 50, 0, PHOTO);
    expect(inside.zoom).toBe(DOUBLE_TAP_ZOOM);
    expect(inside.x).toBeLessThan(0);
    expect(doubleTap(inside, 0, 0, PHOTO)).toEqual(VIEW_START);
  });
});

describe('on screen', () => {
  const post = readFileSync('src/ui/post.tsx', 'utf8');
  const viewer = readFileSync('src/ui/photo-viewer.tsx', 'utf8');

  it('a post’s photo opens it, and so does a repost’s original', () => {
    expect(post).toContain('accessibilityLabel="Open the photo"');
    expect(post).toContain('onOpenPhoto={() => setViewing(post)}');
    expect(post).toContain('onOpenOriginalPhoto={original ? () => setViewing(original) : undefined}');
    // The original's own heart: its reactions are fetched with the list's.
    expect(post).toContain('posts.map((p) => p.shared_post_id)');
  });

  it('keeps the heart, comments and share at the bottom — the post’s own', () => {
    const shown = post.slice(post.indexOf('function PostPhotoViewer('));
    expect(shown).toContain('<HeartButton');
    expect(shown).toContain('icon="comment"');
    expect(shown).toContain('icon="share"');
    // Share opens the in-app share sheet over it, not the phone's menu.
    expect(post.indexOf('<PostPhotoViewer')).toBeLessThan(post.indexOf('<ShareSheet'));
  });

  it('zooms by pinch, wheel, buttons, keys and a double tap, and never scrolls the page under it', () => {
    for (const way of ['spreadOf(e)', "addEventListener?.('wheel'", 'label="Zoom in"', 'label="Zoom out"', "e.key === '+'", 'doubleTap(']) {
      expect(viewer, way).toContain(way);
    }
    expect(viewer).toContain("touchAction: 'none'");
    expect(viewer).toContain('{ passive: false }');
    expect(viewer).toContain('label="Close the photo"');
  });

  it('is the whole screen, drawn beside the Sheet', () => {
    expect(viewer).toContain('<FullScreen onClose={onClose}>');
    expect(readFileSync('src/ui/sheet.tsx', 'utf8')).toContain('export function FullScreen(');
  });
});
