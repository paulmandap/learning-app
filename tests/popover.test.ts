import { describe, expect, it } from 'vitest';
import { placePopover, POPOVER_GAP } from '../src/core/popover';

/**
 * Where the reaction bar opens over a message (NOTES §65).
 */

const WINDOW = { width: 393, height: 800 };
const KEEP = { top: 50, bottom: 30, side: 8 };
const BAR = { width: 290, height: 260 };

describe('placePopover', () => {
  it('opens above the message when it fits, growing upwards from just over it', () => {
    const at = placePopover({ x: 60, y: 500, width: 120, height: 40 }, BAR, 'start', WINDOW, KEEP);
    expect(at.top).toBeUndefined();
    expect(at.bottom).toBe(WINDOW.height - 500 + POPOVER_GAP);
    expect(at.maxHeight).toBe(500 - POPOVER_GAP - KEEP.top);
  });

  it('opens below a message near the top of the screen', () => {
    const at = placePopover({ x: 60, y: 90, width: 120, height: 40 }, BAR, 'start', WINDOW, KEEP);
    expect(at.bottom).toBeUndefined();
    expect(at.top).toBe(90 + 40 + POPOVER_GAP);
    expect(at.maxHeight).toBe(WINDOW.height - KEEP.bottom - 130 - POPOVER_GAP);
  });

  it('opens where there is more room when it fits neither way', () => {
    const short = { width: 393, height: 400 };
    const low = placePopover({ x: 60, y: 260, width: 120, height: 40 }, BAR, 'start', short, KEEP);
    expect(low.bottom).toBeDefined();
    const high = placePopover({ x: 60, y: 120, width: 120, height: 40 }, BAR, 'start', short, KEEP);
    expect(high.top).toBeDefined();
  });

  it('lines up with the left edge of theirs and the right edge of yours', () => {
    const theirs = placePopover({ x: 44, y: 500, width: 300, height: 40 }, BAR, 'start', WINDOW, KEEP);
    expect(theirs.left).toBe(44);
    const yours = placePopover({ x: 40, y: 500, width: 340, height: 40 }, BAR, 'end', WINDOW, KEEP);
    expect(yours.left + yours.width).toBe(380);
  });

  it('moves in rather than hanging off either side of the window', () => {
    const right = placePopover({ x: 300, y: 500, width: 60, height: 40 }, BAR, 'start', WINDOW, KEEP);
    expect(right.left + right.width).toBe(WINDOW.width - KEEP.side);
    const left = placePopover({ x: 20, y: 500, width: 60, height: 40 }, BAR, 'end', WINDOW, KEEP);
    expect(left.left).toBe(KEEP.side);
  });

  it('narrows to the window on a screen smaller than the bar', () => {
    const at = placePopover({ x: 20, y: 500, width: 60, height: 40 }, BAR, 'start', { width: 280, height: 800 }, KEEP);
    expect(at.width).toBe(280 - 2 * KEEP.side);
    expect(at.left).toBe(KEEP.side);
  });
});
