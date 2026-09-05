import { describe, expect, it } from 'vitest';
import {
  FIRST_INTERVAL_DAYS,
  INITIAL_EASE,
  isDue,
  MAX_EASE,
  MAX_INTERVAL_DAYS,
  MIN_EASE,
  NEW_CARD,
  nextState,
  reviewOrder,
  SECOND_INTERVAL_DAYS,
  startOfUtcDay,
  type Scheduled,
} from '../src/core/schedule';

/** A fixed UTC noon, so nothing here depends on when the tests run. */
const NOON = Date.UTC(2026, 8, 5, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/** Days between a due date and the day the review happened. */
function daysOut(s: Scheduled, now = NOON): number {
  return Math.round((s.dueAt - startOfUtcDay(now)) / DAY);
}

describe('startOfUtcDay', () => {
  it('collapses any time on a day to that day', () => {
    const start = Date.UTC(2026, 8, 5, 0, 0, 0);
    expect(startOfUtcDay(Date.UTC(2026, 8, 5, 0, 0, 0))).toBe(start);
    expect(startOfUtcDay(Date.UTC(2026, 8, 5, 23, 59, 59))).toBe(start);
    expect(startOfUtcDay(NOON)).toBe(start);
  });

  it('is what makes "due today" a stable question', () => {
    // The bug this prevents: a card reviewed at 09:00 and scheduled "+1 day"
    // being invisible at 08:59 next morning and appearing at 09:00.
    const morning = nextState(NEW_CARD, 'correct', Date.UTC(2026, 8, 5, 9, 0));
    const evening = nextState(NEW_CARD, 'correct', Date.UTC(2026, 8, 5, 21, 30));
    expect(morning.dueAt).toBe(evening.dueAt);
  });
});

describe('nextState — correct', () => {
  it('schedules a new card for tomorrow', () => {
    const s = nextState(NEW_CARD, 'correct', NOON);
    expect(s.reps).toBe(1);
    expect(s.intervalDays).toBe(FIRST_INTERVAL_DAYS);
    expect(daysOut(s)).toBe(1);
  });

  it('schedules the second success six days out', () => {
    const first = nextState(NEW_CARD, 'correct', NOON);
    const second = nextState(first, 'correct', NOON + DAY);
    expect(second.reps).toBe(2);
    expect(second.intervalDays).toBe(SECOND_INTERVAL_DAYS);
  });

  it('grows multiplicatively after the two fixed steps', () => {
    let s = nextState(NEW_CARD, 'correct', NOON);
    s = nextState(s, 'correct', NOON);
    const before = s.intervalDays;
    s = nextState(s, 'correct', NOON);
    // interval x ease, and ease is above 1, so it must actually grow.
    expect(s.intervalDays).toBeGreaterThan(before);
    expect(s.reps).toBe(3);
  });

  it('grows monotonically over a long correct streak, and never past the cap', () => {
    let s = nextState(NEW_CARD, 'correct', NOON);
    let previous = s.intervalDays;
    for (let i = 0; i < 20; i++) {
      s = nextState(s, 'correct', NOON);
      expect(s.intervalDays).toBeGreaterThanOrEqual(previous);
      expect(s.intervalDays).toBeLessThanOrEqual(MAX_INTERVAL_DAYS);
      previous = s.intervalDays;
    }
  });

  it('raises ease but never past the ceiling', () => {
    let s = nextState(NEW_CARD, 'correct', NOON);
    expect(s.ease).toBeGreaterThan(INITIAL_EASE);
    for (let i = 0; i < 30; i++) s = nextState(s, 'correct', NOON);
    expect(s.ease).toBeLessThanOrEqual(MAX_EASE);
  });
});

describe('nextState — incorrect', () => {
  it('resets the streak and brings the card back tomorrow', () => {
    let s = nextState(NEW_CARD, 'correct', NOON);
    s = nextState(s, 'correct', NOON);
    s = nextState(s, 'correct', NOON); // comfortably out in the future
    expect(s.intervalDays).toBeGreaterThan(1);

    const lapsed = nextState(s, 'incorrect', NOON);
    expect(lapsed.reps).toBe(0);
    expect(lapsed.intervalDays).toBe(FIRST_INTERVAL_DAYS);
    expect(daysOut(lapsed)).toBe(1);
  });

  it('counts lapses and never forgets them', () => {
    let s = nextState(NEW_CARD, 'incorrect', NOON);
    expect(s.lapses).toBe(1);
    s = nextState(s, 'correct', NOON);
    expect(s.lapses).toBe(1); // a success does not erase the history
    s = nextState(s, 'incorrect', NOON);
    expect(s.lapses).toBe(2);
  });

  it('holds ease at the floor however often a card is failed', () => {
    // Without a floor, a repeatedly failed card drives its own multiplier to
    // zero and can never recover, reappearing forever however well it is later
    // learned.
    let s = NEW_CARD;
    for (let i = 0; i < 40; i++) s = nextState(s, 'incorrect', NOON);
    expect(s.ease).toBe(MIN_EASE);
    expect(s.intervalDays).toBe(FIRST_INTERVAL_DAYS);
  });

  it('lets a lapsed card recover its interval with successes', () => {
    let s = NEW_CARD;
    for (let i = 0; i < 5; i++) s = nextState(s, 'incorrect', NOON);
    for (let i = 0; i < 5; i++) s = nextState(s, 'correct', NOON);
    expect(s.intervalDays).toBeGreaterThan(FIRST_INTERVAL_DAYS);
  });
});

describe('nextState — partial', () => {
  it('sits between correct and incorrect', () => {
    let mature = nextState(NEW_CARD, 'correct', NOON);
    mature = nextState(mature, 'correct', NOON);
    mature = nextState(mature, 'correct', NOON);

    const onPartial = nextState(mature, 'partial', NOON);
    const onCorrect = nextState(mature, 'correct', NOON);
    const onIncorrect = nextState(mature, 'incorrect', NOON);

    expect(onPartial.intervalDays).toBeLessThan(onCorrect.intervalDays);
    expect(onPartial.intervalDays).toBeGreaterThan(onIncorrect.intervalDays);
  });

  it('halves the interval and holds reps rather than advancing them', () => {
    let s = nextState(NEW_CARD, 'correct', NOON);
    s = nextState(s, 'correct', NOON); // 6 days, reps 2
    const p = nextState(s, 'partial', NOON);
    expect(p.intervalDays).toBe(3);
    expect(p.reps).toBe(2); // not failed, but not advanced either
  });

  it('never schedules sooner than tomorrow', () => {
    const p = nextState(NEW_CARD, 'partial', NOON);
    expect(p.intervalDays).toBe(FIRST_INTERVAL_DAYS);
    expect(daysOut(p)).toBe(1);
  });

  it('does not count as a lapse', () => {
    const p = nextState(NEW_CARD, 'partial', NOON);
    expect(p.lapses).toBe(0);
  });
});

describe('determinism', () => {
  it('gives identical output for identical input', () => {
    const a = nextState({ reps: 3, intervalDays: 12, ease: 2.4, lapses: 1 }, 'correct', NOON);
    const b = nextState({ reps: 3, intervalDays: 12, ease: 2.4, lapses: 1 }, 'correct', NOON);
    expect(a).toEqual(b);
  });

  it('never mutates the state it was given', () => {
    const prev = { reps: 2, intervalDays: 6, ease: 2.5, lapses: 0 };
    const copy = { ...prev };
    nextState(prev, 'incorrect', NOON);
    expect(prev).toEqual(copy);
  });

  it('always produces a due date on a day boundary, in the future', () => {
    for (const result of ['correct', 'partial', 'incorrect'] as const) {
      const s = nextState(NEW_CARD, result, NOON);
      expect(s.dueAt % DAY).toBe(0);
      expect(s.dueAt).toBeGreaterThan(startOfUtcDay(NOON));
    }
  });
});

describe('isDue', () => {
  const sched = (dueAt: number): Scheduled => ({ ...NEW_CARD, dueAt });

  it('treats a card with no state as due — it has never been seen', () => {
    expect(isDue(null, NOON)).toBe(true);
    expect(isDue(undefined, NOON)).toBe(true);
  });

  it('is due on the day it comes up and every day after', () => {
    expect(isDue(sched(startOfUtcDay(NOON)), NOON)).toBe(true);
    expect(isDue(sched(startOfUtcDay(NOON) - 7 * DAY), NOON)).toBe(true);
  });

  it('is not due before then', () => {
    expect(isDue(sched(startOfUtcDay(NOON) + DAY), NOON)).toBe(false);
  });
});

describe('reviewOrder', () => {
  type Card = { id: string; state: Scheduled | null };
  const today = startOfUtcDay(NOON);
  const at = (dueAt: number): Scheduled => ({ ...NEW_CARD, dueAt });

  it('puts due cards first, then new, then not-yet-due', () => {
    const cards: Card[] = [
      { id: 'future', state: at(today + 5 * DAY) },
      { id: 'new', state: null },
      { id: 'due', state: at(today - DAY) },
    ];
    expect(reviewOrder(cards, (c) => c.state, NOON).map((c) => c.id)).toEqual([
      'due',
      'new',
      'future',
    ]);
  });

  it('shows the longest-overdue card first', () => {
    // The card you were meant to see a week ago is the closest to being
    // forgotten, so it leads.
    const cards: Card[] = [
      { id: 'yesterday', state: at(today - DAY) },
      { id: 'last-week', state: at(today - 7 * DAY) },
      { id: 'today', state: at(today) },
    ];
    expect(reviewOrder(cards, (c) => c.state, NOON).map((c) => c.id)).toEqual([
      'last-week',
      'yesterday',
      'today',
    ]);
  });

  it('orders not-yet-due cards by how soon they come up', () => {
    const cards: Card[] = [
      { id: 'far', state: at(today + 30 * DAY) },
      { id: 'near', state: at(today + 2 * DAY) },
    ];
    expect(reviewOrder(cards, (c) => c.state, NOON).map((c) => c.id)).toEqual(['near', 'far']);
  });

  it('is stable, so equal cards keep their original order', () => {
    const cards: Card[] = [
      { id: 'a', state: null },
      { id: 'b', state: null },
      { id: 'c', state: null },
    ];
    expect(reviewOrder(cards, (c) => c.state, NOON).map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('keeps every card — this orders a deck, it does not filter one', () => {
    const cards: Card[] = [
      { id: 'future', state: at(today + 99 * DAY) },
      { id: 'new', state: null },
    ];
    expect(reviewOrder(cards, (c) => c.state, NOON)).toHaveLength(2);
  });

  it('handles an empty deck', () => {
    expect(reviewOrder([] as Card[], (c) => c.state, NOON)).toEqual([]);
  });
});
