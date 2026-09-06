import { describe, expect, it } from 'vitest';
import {
  dailyActivity,
  masteryCounts,
  masteryOf,
  MASTERED_INTERVAL_DAYS,
  MIN_SECTION_ATTEMPTS,
  sectionSplit,
  STRONG_ACCURACY,
  STRUGGLING_LAPSES,
  studyStreak,
  type ItemHistory,
} from '../src/core/progress';
import { NEW_CARD, startOfUtcDay, type ReviewState } from '../src/core/schedule';

/** A fixed UTC noon, so nothing here depends on when the tests run. */
const NOON = Date.UTC(2026, 8, 5, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

/** `n` days before NOON, at a deliberately awkward hour. */
const daysAgo = (n: number) => NOON - n * DAY + 3 * 60 * 60 * 1000;

function state(over: Partial<ReviewState> = {}): ReviewState {
  return { ...NEW_CARD, reps: 1, intervalDays: 1, ...over };
}

describe('studyStreak', () => {
  it('counts consecutive days ending today', () => {
    expect(studyStreak([daysAgo(0), daysAgo(1), daysAgo(2)], NOON)).toBe(3);
  });

  it('keeps the streak alive when today has not been studied yet', () => {
    // The kind edge, and deliberate: you have not missed today until it is over.
    // Zeroing at midnight would punish someone for not having studied yet.
    expect(studyStreak([daysAgo(1), daysAgo(2)], NOON)).toBe(2);
  });

  it('ends the streak after a clear missed day', () => {
    expect(studyStreak([daysAgo(2), daysAgo(3)], NOON)).toBe(0);
  });

  it('stops at the first gap rather than counting every day ever studied', () => {
    // Studied today and yesterday, then nothing, then a burst a week ago.
    const times = [daysAgo(0), daysAgo(1), daysAgo(6), daysAgo(7), daysAgo(8)];
    expect(studyStreak(times, NOON)).toBe(2);
  });

  it('counts several answers on one day once', () => {
    const times = [NOON, NOON + 1000, NOON + 2000, daysAgo(1)];
    expect(studyStreak(times, NOON)).toBe(2);
  });

  it('is 0 with no history', () => {
    expect(studyStreak([], NOON)).toBe(0);
  });

  it('does not depend on the hour, only the UTC day', () => {
    const justAfterMidnight = Date.UTC(2026, 8, 5, 0, 1);
    const justBeforeMidnight = Date.UTC(2026, 8, 5, 23, 59);
    expect(studyStreak([justAfterMidnight], justBeforeMidnight)).toBe(1);
    expect(studyStreak([justBeforeMidnight], justBeforeMidnight)).toBe(1);
  });

  it('does not care what order the answers arrive in', () => {
    const shuffled = [daysAgo(2), daysAgo(0), daysAgo(1)];
    expect(studyStreak(shuffled, NOON)).toBe(3);
  });
});

describe('dailyActivity', () => {
  it('covers the whole window, oldest first', () => {
    const out = dailyActivity([], NOON, 7);
    expect(out).toHaveLength(7);
    expect(out[6]!.dayStart).toBe(startOfUtcDay(NOON));
    expect(out[0]!.dayStart).toBe(startOfUtcDay(NOON) - 6 * DAY);
  });

  it('fills days with no study as zero rather than dropping them', () => {
    // The empty days ARE the information. Plotting only days that have rows
    // would space them evenly whatever the gaps, so a week off would look
    // exactly like a week of daily study.
    const out = dailyActivity([{ dayStart: daysAgo(0), answers: 5 }], NOON, 5);
    expect(out.map((d) => d.answers)).toEqual([0, 0, 0, 0, 5]);
  });

  it('places each day in the right slot', () => {
    const out = dailyActivity(
      [
        { dayStart: daysAgo(0), answers: 3 },
        { dayStart: daysAgo(2), answers: 7 },
      ],
      NOON,
      4,
    );
    expect(out.map((d) => d.answers)).toEqual([0, 7, 0, 3]);
  });

  it('adds up several rows landing on the same day', () => {
    const out = dailyActivity(
      [
        { dayStart: daysAgo(1), answers: 2 },
        { dayStart: daysAgo(1) + 60_000, answers: 3 },
      ],
      NOON,
      3,
    );
    expect(out.map((d) => d.answers)).toEqual([0, 5, 0]);
  });

  it('ignores anything older than the window', () => {
    const out = dailyActivity([{ dayStart: daysAgo(40), answers: 9 }], NOON, 7);
    expect(out.every((d) => d.answers === 0)).toBe(true);
  });

  it('normalises any time of day to its UTC day', () => {
    const lateEvening = Date.UTC(2026, 8, 5, 23, 45);
    const out = dailyActivity([{ dayStart: lateEvening, answers: 4 }], NOON, 2);
    expect(out[1]).toEqual({ dayStart: startOfUtcDay(NOON), answers: 4 });
  });
});

describe('masteryOf', () => {
  it('calls a card with no schedule new', () => {
    expect(masteryOf(null)).toBe('new');
    expect(masteryOf(undefined)).toBe('new');
  });

  it('calls a long interval mastered', () => {
    expect(masteryOf(state({ reps: 4, intervalDays: MASTERED_INTERVAL_DAYS }))).toBe('mastered');
  });

  it('calls a short interval learning', () => {
    expect(masteryOf(state({ reps: 2, intervalDays: 6 }))).toBe('learning');
  });

  it('calls a repeatedly failed card struggling', () => {
    expect(masteryOf(state({ reps: 1, intervalDays: 1, lapses: STRUGGLING_LAPSES }))).toBe(
      'struggling',
    );
  });

  it('lets a relearned card be mastered again', () => {
    // The order that matters: mastered is tested before struggling. Holding
    // someone's worst week against them for ever is both demotivating and untrue
    // — a card now on a three-week interval IS known.
    const relearned = state({ reps: 5, intervalDays: 30, lapses: 5 });
    expect(masteryOf(relearned)).toBe('mastered');
  });

  it('treats a card just reset by a lapse as learning, not new', () => {
    // reps is 0 after a lapse, but the card has history — calling it "new" would
    // quietly shrink the learning pile every time someone failed a card.
    expect(masteryOf(state({ reps: 0, intervalDays: 1, lapses: 1 }))).toBe('learning');
  });

  it('calls a reset card with many lapses struggling', () => {
    expect(masteryOf(state({ reps: 0, intervalDays: 1, lapses: 4 }))).toBe('struggling');
  });
});

describe('masteryCounts', () => {
  it('buckets every card exactly once', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const states: Record<string, ReviewState | null> = {
      a: state({ reps: 4, intervalDays: 40 }),
      b: state({ reps: 2, intervalDays: 6 }),
      c: state({ reps: 1, intervalDays: 1, lapses: 3 }),
      d: null,
    };
    const counts = masteryCounts(items, (i) => states[i.id]);
    expect(counts).toEqual({ mastered: 1, learning: 1, struggling: 1, new: 1 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(items.length);
  });

  it('counts an untouched set as all new', () => {
    const counts = masteryCounts([{}, {}, {}], () => null);
    expect(counts).toEqual({ mastered: 0, learning: 0, struggling: 0, new: 3 });
  });
});

describe('sectionSplit', () => {
  const row = (over: Partial<ItemHistory> = {}): ItemHistory => ({
    section: 'Circulation',
    attempts: 2,
    misses: 0,
    partials: 0,
    ...over,
  });

  it('names a strong section and a weak one, and keeps them apart', () => {
    const split = sectionSplit([
      row({ section: 'Circulation', attempts: 5, misses: 0 }),
      row({ section: 'Respiration', attempts: 5, misses: 4 }),
    ]);
    expect(split.strong.map((s) => s.section)).toEqual(['Circulation']);
    expect(split.weak.map((s) => s.section)).toEqual(['Respiration']);
  });

  it(`holds back a section with fewer than ${MIN_SECTION_ATTEMPTS} answers`, () => {
    // The whole point. One lucky answer must not read as mastery — this is the
    // lesson of `topic` producing 17 labels for 17 cards, applied in advance.
    const split = sectionSplit([row({ attempts: 2, misses: 0 })]);
    expect(split.strong).toHaveLength(0);
    expect(split.weak).toHaveLength(0);
    expect(split.tooEarly).toBe(1);
  });

  it('ranks a section as soon as it has enough answers', () => {
    const split = sectionSplit([row({ attempts: MIN_SECTION_ATTEMPTS, misses: 0 })]);
    expect(split.strong).toHaveLength(1);
    expect(split.tooEarly).toBe(0);
  });

  it('adds up several cards in the same section', () => {
    const split = sectionSplit([
      row({ section: 'Circulation', attempts: 2, misses: 1 }),
      row({ section: 'Circulation', attempts: 2, misses: 1 }),
    ]);
    expect(split.weak[0]).toMatchObject({ section: 'Circulation', attempts: 4, correct: 2 });
    expect(split.weak[0]!.accuracy).toBe(0.5);
  });

  it('counts a partial as neither right nor wrong', () => {
    // It already halves the review interval, so counting it as a miss here would
    // penalise the same answer twice.
    // Four answers, none wrong, two only partly right: 2 of 4, not 4 of 4.
    const split = sectionSplit([row({ attempts: 4, misses: 0, partials: 2 })]);
    expect(split.strong).toHaveLength(0);
    expect(split.weak[0]).toMatchObject({ attempts: 4, correct: 2 });
    expect(split.weak[0]!.accuracy).toBe(0.5);
  });

  it('never lists the same section as both strong and weak', () => {
    const split = sectionSplit([
      row({ section: 'A', attempts: 10, misses: 0 }),
      row({ section: 'B', attempts: 10, misses: 10 }),
      row({ section: 'C', attempts: 10, misses: 5 }),
    ]);
    const strong = new Set(split.strong.map((s) => s.section));
    for (const w of split.weak) expect(strong.has(w.section)).toBe(false);
  });

  it('names at most two under each heading', () => {
    const many = ['A', 'B', 'C', 'D'].map((section) =>
      row({ section, attempts: 10, misses: 0 }),
    );
    expect(sectionSplit(many).strong).toHaveLength(2);
  });

  it('puts the worst section first among the weak ones', () => {
    const split = sectionSplit([
      row({ section: 'Bad', attempts: 10, misses: 6 }),
      row({ section: 'Worse', attempts: 10, misses: 9 }),
    ]);
    expect(split.weak.map((s) => s.section)).toEqual(['Worse', 'Bad']);
  });

  it('ignores cards with no section and cards never answered', () => {
    const split = sectionSplit([
      row({ section: null, attempts: 9, misses: 0 }),
      row({ section: 'Circulation', attempts: 0, misses: 0 }),
    ]);
    expect(split.strong).toHaveLength(0);
    expect(split.weak).toHaveLength(0);
    expect(split.tooEarly).toBe(0);
  });

  it(`puts the boundary exactly at ${STRONG_ACCURACY}`, () => {
    const at = sectionSplit([row({ section: 'At', attempts: 10, misses: 3 })]);
    expect(at.strong).toHaveLength(1);
    const below = sectionSplit([row({ section: 'Below', attempts: 10, misses: 4 })]);
    expect(below.weak).toHaveLength(1);
  });

  it('is deterministic when sections tie', () => {
    const rows = [
      row({ section: 'Beta', attempts: 4, misses: 0 }),
      row({ section: 'Alpha', attempts: 4, misses: 0 }),
    ];
    expect(sectionSplit(rows)).toEqual(sectionSplit(rows));
    expect(sectionSplit(rows).strong.map((s) => s.section)).toEqual(['Alpha', 'Beta']);
  });

  it('returns nothing at all for an unstudied set', () => {
    expect(sectionSplit([])).toEqual({ strong: [], weak: [], tooEarly: 0 });
  });
});
