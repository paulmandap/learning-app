/**
 * Spaced repetition scheduling (spec §6, "Later": adaptive scheduling).
 *
 * Pure and deterministic — no clock of its own, no react-native, no database.
 * `now` is always passed in, so a test can schedule six months of reviews in a
 * millisecond and the same inputs always give the same answer.
 *
 * D8 chose to "log every attempt + missed pile from day one, scheduling later",
 * and this is the later. The missed pile answers *what* to come back to; a
 * schedule answers *when*, which is the part that turns re-reading into
 * retention.
 *
 * ## The algorithm, and why this one
 *
 * An SM-2 variant. SM-2 is old, well understood, and small enough to hold in
 * your head, which matters more here than the marginal gains of FSRS: it needs
 * four numbers per card and no training data, and this app has five users and no
 * review history to fit a model to.
 *
 * Two deliberate departures from textbook SM-2:
 *
 *  - **Three outcomes, not six.** The app grades correct / partial / incorrect
 *    (`AttemptResult`), and flashcards only ever produce two of those. Asking a
 *    student to self-rate 0-5 is exactly the friction the spec avoids elsewhere.
 *  - **Partial is a real state, not a rounding of "wrong".** Quiz short answers
 *    score partial when between 40% and 80% of the rubric is hit. Treating that
 *    as a lapse would throw away a card you nearly know; treating it as correct
 *    would push it out of sight. It shortens the interval instead.
 */

import type { AttemptResult } from './grade';

/** Milliseconds in a day. Intervals are whole days. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Ease floor.
 *
 * Without it a card failed repeatedly drives its own multiplier towards zero and
 * can never recover, so it reappears forever however well you later learn it.
 * 1.3 is SM-2's original value and still the right one: it means a mature card
 * grows by at least 30% per success.
 */
export const MIN_EASE = 1.3;

/** Ease ceiling, so an easy card cannot leap to absurd intervals. */
export const MAX_EASE = 2.8;

/** Starting ease for a card never reviewed. SM-2's default. */
export const INITIAL_EASE = 2.5;

/** First two intervals are fixed, as in SM-2; growth is multiplicative after. */
export const FIRST_INTERVAL_DAYS = 1;
export const SECOND_INTERVAL_DAYS = 6;

/** Nothing is ever scheduled further out than this. */
export const MAX_INTERVAL_DAYS = 365;

export interface ReviewState {
  /** Consecutive successful reviews. Reset to 0 by a lapse. */
  reps: number;
  /** Days until the next review, from the review that produced this state. */
  intervalDays: number;
  /** Multiplier applied once past the two fixed intervals. */
  ease: number;
  /** How many times this card has been failed outright. Never decreases. */
  lapses: number;
}

export interface Scheduled extends ReviewState {
  /** When this card is next due, as epoch ms at a UTC day boundary. */
  dueAt: number;
}

/** A card that has never been reviewed. */
export const NEW_CARD: ReviewState = {
  reps: 0,
  intervalDays: 0,
  ease: INITIAL_EASE,
  lapses: 0,
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * Start of the UTC day containing `ms`.
 *
 * Due dates land on day boundaries so "due today" is a set-membership question
 * with one answer, not a moving comparison against the current time. Without it
 * a card reviewed at 09:00 and scheduled "+1 day" would be invisible at 08:59
 * the next morning and appear at 09:00 — for a study app that reads as a bug.
 *
 * UTC rather than local time, deliberately: due dates are compared in Postgres
 * and in the browser, and a local-time boundary would put those two in different
 * days for anyone not on UTC.
 */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/**
 * The next schedule for a card, given how the review went.
 *
 * @param prev   Current state, or NEW_CARD for a card never reviewed.
 * @param result What the user scored on this review.
 * @param now    Epoch ms of the review.
 */
export function nextState(prev: ReviewState, result: AttemptResult, now: number): Scheduled {
  const today = startOfUtcDay(now);

  if (result === 'incorrect') {
    // A lapse resets the streak and brings the card back tomorrow. Ease drops
    // but keeps its history: a card failed twice is harder than one failed
    // once, and should grow more slowly even after it is relearned.
    const state: ReviewState = {
      reps: 0,
      intervalDays: FIRST_INTERVAL_DAYS,
      ease: clamp(prev.ease - 0.2, MIN_EASE, MAX_EASE),
      lapses: prev.lapses + 1,
    };
    return { ...state, dueAt: today + state.intervalDays * DAY_MS };
  }

  if (result === 'partial') {
    // Half the current interval, floored at one day. reps is held rather than
    // advanced: you did not fail, but you have not earned the next step either.
    // A partial on a brand-new card behaves like a first success, because half
    // of nothing is still tomorrow.
    const halved = Math.max(FIRST_INTERVAL_DAYS, Math.round(prev.intervalDays / 2));
    const state: ReviewState = {
      reps: prev.reps,
      intervalDays: Math.min(halved, MAX_INTERVAL_DAYS),
      ease: clamp(prev.ease - 0.15, MIN_EASE, MAX_EASE),
      lapses: prev.lapses,
    };
    return { ...state, dueAt: today + state.intervalDays * DAY_MS };
  }

  // --- correct ------------------------------------------------------------
  const reps = prev.reps + 1;
  const intervalDays =
    reps === 1
      ? FIRST_INTERVAL_DAYS
      : reps === 2
        ? SECOND_INTERVAL_DAYS
        : Math.min(MAX_INTERVAL_DAYS, Math.round(prev.intervalDays * prev.ease));

  const state: ReviewState = {
    reps,
    intervalDays,
    ease: clamp(prev.ease + 0.1, MIN_EASE, MAX_EASE),
    lapses: prev.lapses,
  };
  return { ...state, dueAt: today + state.intervalDays * DAY_MS };
}

/** Is this card due for review at `now`? A card with no state is always due. */
export function isDue(state: Scheduled | null | undefined, now: number): boolean {
  if (!state) return true;
  return state.dueAt <= startOfUtcDay(now);
}

/**
 * Order a study queue: due cards first (longest overdue first), then cards
 * never reviewed, then everything else by how soon it comes up.
 *
 * Overdue-first rather than newest-first because a card you were meant to see a
 * week ago is the one closest to being forgotten. New cards come after due ones
 * so a backlog is cleared before more material is added to it.
 */
export function reviewOrder<T>(
  items: T[],
  stateOf: (item: T) => Scheduled | null | undefined,
  now: number,
): T[] {
  const today = startOfUtcDay(now);

  const rank = (item: T): number => {
    const state = stateOf(item);
    if (!state) return 1; // never reviewed
    return state.dueAt <= today ? 0 : 2; // due, or not yet due
  };

  return items
    .map((item, i) => ({ item, i })) // index keeps the sort stable
    .sort((a, b) => {
      const ra = rank(a.item);
      const rb = rank(b.item);
      if (ra !== rb) return ra - rb;

      const sa = stateOf(a.item);
      const sb = stateOf(b.item);
      // Within due: longest overdue first. Within not-yet-due: soonest first.
      // Both are ascending dueAt, so one comparison covers them.
      if (sa && sb && sa.dueAt !== sb.dueAt) return sa.dueAt - sb.dueAt;
      return a.i - b.i;
    })
    .map(({ item }) => item);
}
