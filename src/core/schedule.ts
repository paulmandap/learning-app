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
 * Which of the three queue bands a card belongs to.
 *
 * 0 due · 1 never reviewed · 2 not yet due. Shared by `reviewOrder` and
 * `studyOrder` so the backlog-first principle has exactly one definition:
 * a card you were meant to see a week ago leads, and new material is only
 * added once the backlog is clear.
 */
export function dueBucket(state: Scheduled | null | undefined, now: number): 0 | 1 | 2 {
  if (!state) return 1; // never reviewed
  return state.dueAt <= startOfUtcDay(now) ? 0 : 2;
}

/**
 * Order a study queue: due cards first (longest overdue first), then cards
 * never reviewed, then everything else by how soon it comes up.
 *
 * Overdue-first rather than newest-first because a card you were meant to see a
 * week ago is the one closest to being forgotten. New cards come after due ones
 * so a backlog is cleared before more material is added to it.
 *
 * Reads only `dueAt`. `studyOrder` below is what the study screens deal — this
 * stays as the plain "what does the schedule say" ordering it has always been,
 * and is the base `studyOrder` refines.
 */
export function reviewOrder<T>(
  items: T[],
  stateOf: (item: T) => Scheduled | null | undefined,
  now: number,
): T[] {
  const rank = (item: T): number => dueBucket(stateOf(item), now);

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

// ----------------------------------------------------------------- selection --

/**
 * The order the study screens actually deal (Phase D).
 *
 * `reviewOrder` answers "what does the schedule say". This answers "what should
 * this student see next", which is a different question once you know that some
 * cards have beaten them repeatedly and others never have.
 *
 * ## It refines the schedule, it does not overrule it
 *
 * The three bands are untouched: due, then never-seen, then future. That is the
 * backlog principle and it still holds — clearing what is overdue before adding
 * new material is the whole point of having a schedule. Everything below only
 * decides the order WITHIN a band.
 *
 * ## Two things it adds
 *
 * **Struggle first.** A card failed four times comes before one failed once,
 * and a card whose last answer was wrong (`reps === 0`) comes before one on a
 * streak. Both numbers have been arriving in every study screen since Phase 6 —
 * `reviewStatesForSet` returns `lapses`, `reps` and `ease` per card — and
 * `reviewOrder` reads none of them. Nothing new is fetched or stored for this.
 *
 * **A section's cards stay together.** The brief asks that a miss be followed by
 * another card from the same part of the notes rather than a jump elsewhere.
 * Grouping the queue does that without any mid-session reordering: the sibling
 * is already the next card. The alternative — recomputing after every answer —
 * would mean reordering underneath a moving cursor, which repeats or skips
 * cards and would undo the per-level position fix (§17.1).
 *
 * A section's place in the queue is set by its most-struggled card, so the part
 * of the notes going worst leads, and its cards are dealt together.
 *
 * ## What it deliberately does not do
 *
 *  - **It never changes the level.** Levels are exclusive at the owner's request
 *    and the student picks one from buttons carrying counts. Filtering happens
 *    in the screen, before this is called; this only ever reorders what it is
 *    handed.
 *  - **It ignores section accuracy and the Phase C trend.** Both are calibrated
 *    for a display label, not for choosing what someone studies: the trend is
 *    wrong on about one screen in four across the sections it shows, and
 *    `sectionSplit`'s accuracy carries an unresolved question about how partials
 *    score. Per-card `lapses`/`reps` are stronger evidence and depend on neither.
 *  - **It does not filter.** Like `reviewOrder`, every card handed in comes back.
 *    A deck that hid what was not due would tell someone who sat down to study
 *    that there is nothing to study.
 *
 * Fully deterministic: same cards, same schedules, same clock, same order.
 */
export function studyOrder<T>(
  items: T[],
  stateOf: (item: T) => Scheduled | null | undefined,
  sectionOf: (item: T) => string | null,
  now: number,
): T[] {
  // Start from the schedule's own answer. It settles the bands and, within
  // them, overdue-first and stability — so anything this function does not have
  // an opinion about keeps the behaviour Phase 6 established and tested.
  const scheduled = reviewOrder(items, stateOf, now);

  /** How badly this card is going. Lower sorts earlier. */
  const struggle = (item: T): [number, number] => {
    const state = stateOf(item);
    // A card never reviewed has no struggle history. It sits at the calm end of
    // its own band, which only matters inside band 1 where every card is new.
    if (!state) return [0, 0];
    return [-state.lapses, state.reps];
  };

  const byStruggle = (a: { item: T; i: number }, b: { item: T; i: number }): number => {
    const [al, ar] = struggle(a.item);
    const [bl, br] = struggle(b.item);
    // Most lapses first, then whoever is not on a streak, then the schedule's
    // own order via the index — which already encodes longest-overdue-first.
    return al - bl || ar - br || a.i - b.i;
  };

  const out: T[] = [];

  // Band by band, so the backlog cannot be reordered behind new material.
  for (const band of [0, 1, 2] as const) {
    const inBand = scheduled
      .map((item, i) => ({ item, i }))
      .filter(({ item }) => dueBucket(stateOf(item), now) === band);
    if (inBand.length === 0) continue;

    const ranked = [...inBand].sort(byStruggle);

    // A section's place is its most-struggled card's place. `ranked` is already
    // in that order, so first appearance is the answer — and a Map preserves
    // insertion order, which is what makes this deterministic without a second
    // sort over section names.
    const bySection = new Map<string, { item: T; i: number }[]>();
    for (const entry of ranked) {
      // Cards with no section share one group rather than each becoming their
      // own. They are the leftovers, not a part of the notes.
      const key = sectionOf(entry.item) ?? '';
      const group = bySection.get(key);
      if (group) group.push(entry);
      else bySection.set(key, [entry]);
    }

    for (const group of bySection.values()) {
      for (const { item } of group) out.push(item);
    }
  }

  return out;
}
