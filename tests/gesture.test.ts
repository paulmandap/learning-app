import { describe, expect, it } from 'vitest';
import {
  shouldCaptureGesture,
  swipeProgress,
  swipeVerdict,
  SWIPE_DISTANCE_RATIO,
} from '../src/core/gesture';

const W = 350; // typical card width
const far = W * SWIPE_DISTANCE_RATIO + 10;
const near = W * SWIPE_DISTANCE_RATIO - 10;

describe('swipeVerdict', () => {
  it('grades right as Got it and left as Missed', () => {
    // Same direction as the ← / → keyboard shortcuts, so both agree.
    expect(swipeVerdict({ dx: far, dy: 0, vx: 0, width: W })).toBe('gotIt');
    expect(swipeVerdict({ dx: -far, dy: 0, vx: 0, width: W })).toBe('missed');
  });

  it('does nothing when the drag falls short', () => {
    expect(swipeVerdict({ dx: near, dy: 0, vx: 0, width: W })).toBe('none');
    expect(swipeVerdict({ dx: -near, dy: 0, vx: 0, width: W })).toBe('none');
  });

  it('accepts a fast flick that did not travel far', () => {
    // People flick rather than drag; requiring full distance feels broken.
    expect(swipeVerdict({ dx: 40, dy: 0, vx: 1.2, width: W })).toBe('gotIt');
    expect(swipeVerdict({ dx: -40, dy: 0, vx: -1.2, width: W })).toBe('missed');
  });

  it('ignores a fast twitch that barely moved', () => {
    // Velocity alone must not grade a card the user never meant to answer.
    expect(swipeVerdict({ dx: 8, dy: 0, vx: 2, width: W })).toBe('none');
  });

  it('IGNORES a vertical drag — that is the user scrolling', () => {
    // The failure that would make the page unusable: scrolling grades cards.
    expect(swipeVerdict({ dx: 30, dy: 200, vx: 0.1, width: W })).toBe('none');
    expect(swipeVerdict({ dx: -30, dy: 200, vx: -0.1, width: W })).toBe('none');
  });

  it('still grades a diagonal drag that is mostly horizontal', () => {
    expect(swipeVerdict({ dx: far, dy: 20, vx: 0, width: W })).toBe('gotIt');
  });

  it('scales the threshold with card width', () => {
    // 100px is decisive on a narrow card and not on a wide one.
    expect(swipeVerdict({ dx: 100, dy: 0, vx: 0, width: 200 })).toBe('gotIt');
    expect(swipeVerdict({ dx: 100, dy: 0, vx: 0, width: 900 })).toBe('none');
  });

  it('does nothing at rest', () => {
    expect(swipeVerdict({ dx: 0, dy: 0, vx: 0, width: W })).toBe('none');
  });
});

describe('shouldCaptureGesture', () => {
  it('lets vertical scrolling through', () => {
    expect(shouldCaptureGesture(4, 60)).toBe(false);
    expect(shouldCaptureGesture(20, 40)).toBe(false);
  });

  it('claims a clearly horizontal drag', () => {
    expect(shouldCaptureGesture(40, 5)).toBe(true);
  });

  it('ignores a tap that never moved', () => {
    expect(shouldCaptureGesture(2, 1)).toBe(false);
  });
});

describe('swipeProgress', () => {
  it('reaches full strength exactly at the decision threshold', () => {
    // The colour IS the affordance: fully tinted means releasing will commit.
    expect(swipeProgress(W * SWIPE_DISTANCE_RATIO, W)).toBeCloseTo(1, 5);
  });

  it('is 0 at rest and clamps at 1', () => {
    expect(swipeProgress(0, W)).toBe(0);
    expect(swipeProgress(W, W)).toBe(1);
  });

  it('is symmetric — direction is carried elsewhere', () => {
    expect(swipeProgress(-50, W)).toBe(swipeProgress(50, W));
  });

  it('survives a zero width during first layout', () => {
    expect(swipeProgress(50, 0)).toBe(0);
  });
});
