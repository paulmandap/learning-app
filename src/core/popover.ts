/**
 * Where a small panel opens beside what opened it (NOTES §65) — the reaction
 * bar over a message. No screen here: tested in tests/popover.test.ts.
 *
 * Above the anchor when the panel fits there, or when there is more room above
 * than below; below it otherwise. Lined up with the anchor's left or right
 * edge, and moved in rather than cut off at the window's side.
 */

/** Where something is on screen, from `measureInWindow`. */
export interface Anchor {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PopoverPlace {
  left: number;
  width: number;
  /** One of these two: `bottom` when it opens above, so it grows upwards. */
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** The gap between the panel and what opened it. */
export const POPOVER_GAP = 6;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function placePopover(
  anchor: Anchor,
  size: { width: number; height: number },
  side: 'start' | 'end',
  window: { width: number; height: number },
  keep: { top: number; bottom: number; side: number },
): PopoverPlace {
  const width = Math.max(0, Math.min(size.width, window.width - 2 * keep.side));
  const wanted = side === 'start' ? anchor.x : anchor.x + anchor.width - width;
  const left = clamp(wanted, keep.side, Math.max(keep.side, window.width - keep.side - width));

  const above = anchor.y - POPOVER_GAP - keep.top;
  const below = window.height - keep.bottom - (anchor.y + anchor.height) - POPOVER_GAP;
  if (above >= size.height || above >= below) {
    return { left, width, bottom: window.height - anchor.y + POPOVER_GAP, maxHeight: Math.max(0, above) };
  }
  return { left, width, top: anchor.y + anchor.height + POPOVER_GAP, maxHeight: Math.max(0, below) };
}
