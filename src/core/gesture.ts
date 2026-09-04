/**
 * Swipe decision logic. Pure — no react-native, no DOM.
 *
 * Lives in core rather than inside the component so the rules that decide
 * whether a drag counts as an answer are testable without a native transform.
 * Getting these wrong is expensive: too eager and a scroll grades a card the
 * user never meant to answer; too reluctant and swiping feels broken.
 */

export type SwipeVerdict = 'missed' | 'gotIt' | 'none';

/** Fraction of card width a drag must cross to count on distance alone. */
export const SWIPE_DISTANCE_RATIO = 0.28;

/** A fast flick counts even if short — matches how people actually swipe. */
export const SWIPE_VELOCITY = 0.35;

/** Horizontal movement must beat vertical by this much to be a swipe at all. */
export const HORIZONTAL_DOMINANCE = 1.4;

export interface SwipeInput {
  /** Horizontal travel in px. Negative is left. */
  dx: number;
  /** Vertical travel in px. */
  dy: number;
  /** Horizontal velocity in px/ms. */
  vx: number;
  /** Card width in px, so the threshold scales with the screen. */
  width: number;
}

/**
 * Decide what a released drag means.
 *
 * Right = "Got it", left = "Missed" — the same direction as the ← / → keyboard
 * shortcuts the spec already defines, so the two input methods agree.
 */
export function swipeVerdict(input: SwipeInput): SwipeVerdict {
  const { dx, dy, vx, width } = input;

  // A mostly-vertical drag is the user scrolling the page, not answering.
  if (Math.abs(dx) < Math.abs(dy) * HORIZONTAL_DOMINANCE) return 'none';

  const farEnough = Math.abs(dx) > width * SWIPE_DISTANCE_RATIO;
  const fastEnough = Math.abs(vx) > SWIPE_VELOCITY;

  // A flick must still travel a little, or an accidental twitch grades a card.
  if (!farEnough && !(fastEnough && Math.abs(dx) > 24)) return 'none';

  return dx > 0 ? 'gotIt' : 'missed';
}

/**
 * Should the pan responder claim this gesture from the surrounding ScrollView?
 *
 * Deliberately stricter than swipeVerdict: the card only takes over once the
 * drag is clearly horizontal, so vertical scrolling keeps working normally.
 */
export function shouldCaptureGesture(dx: number, dy: number): boolean {
  return Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * HORIZONTAL_DOMINANCE;
}

/**
 * How strongly to tint the card mid-drag, 0..1.
 *
 * Reaching full strength at the decision threshold means the colour *is* the
 * affordance: when it looks committed, releasing commits. On iOS this carries
 * the feedback that haptics would otherwise provide.
 */
export function swipeProgress(dx: number, width: number): number {
  if (width <= 0) return 0;
  const ratio = Math.abs(dx) / (width * SWIPE_DISTANCE_RATIO);
  return Math.min(1, Math.max(0, ratio));
}
