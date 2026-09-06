import { describe, expect, it } from 'vitest';
import {
  describeForecast,
  dueForecast,
  forecastDayLabel,
  KNOWN_REPS,
  masteryCounts,
  masteryOf,
  MIN_SECTION_ATTEMPTS,
  sectionSplit,
  STRONG_ACCURACY,
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

describe('dueForecast', () => {
  const at = (n: number) => startOfUtcDay(NOON) + n * DAY + 5 * 60 * 60 * 1000;

  it('covers the whole window, starting today', () => {
    const out = dueForecast([], NOON, 7);
    expect(out).toHaveLength(7);
    expect(out[0]!.dayStart).toBe(startOfUtcDay(NOON));
    expect(out[6]!.dayStart).toBe(startOfUtcDay(NOON) + 6 * DAY);
  });

  it('shows free days rather than dropping them', () => {
    // A day with nothing due is information — it is when you get an evening
    // off. Omitting it would also make the remaining bars lie about spacing.
    const out = dueForecast([{ dueAt: at(2) }], NOON, 4);
    expect(out.map((d) => d.due)).toEqual([0, 0, 1, 0]);
  });

  it('folds overdue cards into today', () => {
    // They are work waiting NOW. A past-dated column would push the useful part
    // of the chart sideways to make room for a scolding.
    const out = dueForecast([{ dueAt: at(-3) }, { dueAt: at(-1) }, { dueAt: at(0) }], NOON, 3);
    expect(out.map((d) => d.due)).toEqual([3, 0, 0]);
  });

  it('counts several cards landing on one day', () => {
    const out = dueForecast([{ dueAt: at(1) }, { dueAt: at(1) }, { dueAt: at(1) }], NOON, 3);
    expect(out.map((d) => d.due)).toEqual([0, 3, 0]);
  });

  it('ignores anything past the window', () => {
    // A card due in three months is not a plan.
    const out = dueForecast([{ dueAt: at(40) }], NOON, 7);
    expect(out.every((d) => d.due === 0)).toBe(true);
  });

  it('normalises any time of day to its UTC day', () => {
    const lateEvening = startOfUtcDay(NOON) + DAY + 23 * 60 * 60 * 1000;
    const out = dueForecast([{ dueAt: lateEvening }], NOON, 3);
    expect(out[1]).toEqual({ dayStart: startOfUtcDay(NOON) + DAY, due: 1 });
  });
});

describe('describeForecast', () => {
  const today = startOfUtcDay(NOON);
  const days = (counts: number[]) =>
    counts.map((due, i) => ({ dayStart: today + i * DAY, due }));

  it('says the week is clear when nothing is due', () => {
    expect(describeForecast(days([0, 0, 0, 0, 0, 0, 0]), today)).toMatch(/ahead/i);
  });

  it('names a day that genuinely stands out', () => {
    expect(describeForecast(days([1, 0, 12, 0, 1, 0, 0]), today)).toBe('Monday is the busy one.');
  });

  it('says nothing about an even week', () => {
    // "Thursday is the busy one" about a day holding one more card than its
    // neighbours is how a summary line stops meaning anything.
    expect(describeForecast(days([3, 3, 4, 3, 3, 0, 0]), today)).toBeNull();
  });

  it('says nothing when today is the heaviest', () => {
    // The row itself is the first thing read, and "cards ready for review"
    // above has already said it.
    expect(describeForecast(days([20, 1, 0, 0, 0, 0, 0]), today)).toBeNull();
  });

  it('does not call a single card a busy day', () => {
    expect(describeForecast(days([0, 1, 0, 0, 0, 0, 0]), today)).toBeNull();
  });
});

describe('forecastDayLabel', () => {
  const today = startOfUtcDay(NOON);

  it('speaks one vocabulary, not two', () => {
    // Every row is a weekday name, the first two included. "Today" and
    // "Tomorrow" among five weekday names made the reader translate between
    // two kinds of label to work out whether Thursday came before or after
    // tomorrow. 2026-09-05 is a Saturday.
    expect(forecastDayLabel(today, today)).toBe('Saturday');
    expect(forecastDayLabel(today + DAY, today)).toBe('Sunday');
    expect(forecastDayLabel(today + 2 * DAY, today)).toBe('Monday');
  });

  it('names every day in the window', () => {
    const names = [0, 1, 2, 3, 4, 5, 6].map((n) => forecastDayLabel(today + n * DAY, today));
    expect(new Set(names).size).toBe(7);
    expect(names.every((n) => /day$/.test(n))).toBe(true);
  });
});

describe('masteryOf', () => {
  it('calls a card with no schedule not started', () => {
    expect(masteryOf(null)).toBe('notStarted');
    expect(masteryOf(undefined)).toBe('notStarted');
  });

  it('calls a card right three times running known', () => {
    expect(masteryOf(state({ reps: KNOWN_REPS }))).toBe('known');
    expect(masteryOf(state({ reps: KNOWN_REPS + 4 }))).toBe('known');
  });

  it('calls one or two right getting there', () => {
    expect(masteryOf(state({ reps: 1 }))).toBe('getting');
    expect(masteryOf(state({ reps: 2 }))).toBe('getting');
  });

  it('calls a card whose last answer was wrong needs work', () => {
    // reps is reset to 0 by a wrong answer, so this is exactly "you missed it
    // last time" — the thing a student can act on today.
    expect(masteryOf(state({ reps: 0, lapses: 1 }))).toBe('needsWork');
  });

  it('separates never-seen from missed-last-time', () => {
    // These are different things to a learner and the whole point of the bands
    // is that they mean something. A card answered wrong HAS a schedule.
    expect(masteryOf(null)).toBe('notStarted');
    expect(masteryOf(state({ reps: 0 }))).toBe('needsWork');
  });

  it('does not hold an old bad run against a card that is going well now', () => {
    // Lapses never decrease, so keying off them would leave a card labelled
    // badly for ever. What matters is the current run.
    expect(masteryOf(state({ reps: 5, lapses: 9 }))).toBe('known');
  });

  it('is reachable in a week, which the interval-based version was not', () => {
    // The defect this replaced: intervals go 1, 6, 16, 45 days and a card is
    // only shown when due, so a 21-day threshold could not be met before day
    // 23 however well someone answered. Three correct answers land on day 7.
    expect(masteryOf(state({ reps: 3, intervalDays: 16 }))).toBe('known');
  });
});

describe('masteryCounts', () => {
  it('buckets every card exactly once', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
    const states: Record<string, ReviewState | null> = {
      a: state({ reps: 4 }),
      b: state({ reps: 2 }),
      c: state({ reps: 0, lapses: 3 }),
      d: null,
    };
    const counts = masteryCounts(items, (i) => states[i.id]);
    expect(counts).toEqual({ known: 1, getting: 1, needsWork: 1, notStarted: 1 });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(items.length);
  });

  it('counts an untouched set as all not started', () => {
    const counts = masteryCounts([{}, {}, {}], () => null);
    expect(counts).toEqual({ known: 0, getting: 0, needsWork: 0, notStarted: 3 });
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
