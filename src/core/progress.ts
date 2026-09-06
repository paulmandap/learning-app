/**
 * Progress arithmetic for the dashboard (Phase 9b).
 *
 * Pure and deterministic — no clock of its own, no react-native, no database.
 * `now` is always passed in, so a test can walk a month of study in a
 * millisecond and the same inputs always give the same answer.
 *
 * ## What this screen is for
 *
 * The app already records every answer (D8), every schedule (Phase 6) and every
 * section a card came from, and shows almost none of it back. The owner's words:
 * *"the app is too basic … so that the user may get motivated."*
 *
 * So the job here is not analytics. It is two questions a student actually asks:
 * **am I getting anywhere**, and **what should I look at next**. Everything that
 * does not answer one of those was deliberately left out.
 *
 * ## The rule that keeps it honest
 *
 * A group is not ranked until it has been answered enough times to mean
 * anything (`MIN_SECTION_ATTEMPTS`). This is not caution for its own sake — it
 * is the direct lesson of measuring `topic`, which produced 17 distinct labels
 * for 17 cards. Rates over n=1 are noise, and a dashboard that confidently tells
 * a student to go and study the wrong thing is worse than one that stays quiet.
 */

import { startOfUtcDay } from './schedule';
import type { ReviewState } from './schedule';

/** Milliseconds in a day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Answers a section needs before it can be called a strength or a weakness.
 *
 * Three. Low enough that a student sees something useful in their first proper
 * session, high enough that one lucky guess cannot read as mastery and one slip
 * cannot read as a weakness.
 */
export const MIN_SECTION_ATTEMPTS = 3;

/**
 * The line between "going well" and "worth another look".
 *
 * A display cut, NOT a grade — nothing here changes a score or a schedule. It
 * only decides which of two headings a section is listed under, and it keeps the
 * two lists disjoint so a section can never appear as both.
 */
export const STRONG_ACCURACY = 0.7;

/**
 * Interval at which a card counts as mastered.
 *
 * 21 days is SM-2's conventional line between a card still being learned and one
 * that has stuck. It also means "mastered" cannot be claimed in a single
 * session, which is what makes it worth seeing.
 */
export const MASTERED_INTERVAL_DAYS = 21;

/**
 * Lapses at which a card is called out as struggling.
 *
 * The same number `src/core/variant.ts` uses to trigger a rephrasing — a card
 * failed three times is the point this project has already decided means "the
 * question, not just the fact, may be the problem". Used as a filter here rather
 * than a trigger.
 */
export const STRUGGLING_LAPSES = 3;

// ------------------------------------------------------------------ streak --

/**
 * Consecutive days studied, counting back from the most recent day with an answer.
 *
 * Deliberately kind at the edges, and both choices are worth stating:
 *
 *  - **Today not yet studied does not break the streak.** A run counted from
 *    yesterday is still alive — you have not missed today until it is over.
 *    Zeroing it at midnight would punish someone for not having studied yet.
 *  - **A gap of two clear days ends it.** Anything looser stops meaning
 *    "consecutive" and the number stops being worth showing.
 *
 * UTC days throughout, reusing `startOfUtcDay` from the scheduler rather than a
 * second definition. Due dates are already compared in UTC in Postgres and in
 * the browser, and two definitions of "today" in one app would disagree for
 * anyone not on UTC — visibly, since a streak and a due count sit side by side.
 */
export function studyStreak(attemptTimes: number[], now: number): number {
  if (attemptTimes.length === 0) return 0;

  const days = new Set(attemptTimes.map((t) => startOfUtcDay(t)));
  const today = startOfUtcDay(now);

  // Where the run ends: today if it has an answer, else yesterday, else nowhere.
  let cursor: number;
  if (days.has(today)) cursor = today;
  else if (days.has(today - DAY_MS)) cursor = today - DAY_MS;
  else return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak++;
    cursor -= DAY_MS;
  }
  return streak;
}

// ---------------------------------------------------------------- activity --

/** Days shown in the activity chart. Four weeks plus the current part-week. */
export const ACTIVITY_DAYS = 30;

export interface ActivityDay {
  /** UTC day boundary, so it lines up with the streak and the due dates. */
  dayStart: number;
  answers: number;
}

/**
 * Answers per day across the recent window, oldest first.
 *
 * **Zero-filled, and that is the whole point.** Plotting only the days that have
 * rows would space them evenly regardless of the gaps between them, so a week
 * off would look identical to a week of daily study. The empty days are the
 * information — they are what makes a streak visible as a shape rather than a
 * number.
 */
export function dailyActivity(
  rows: { dayStart: number; answers: number }[],
  now: number,
  windowDays: number = ACTIVITY_DAYS,
): ActivityDay[] {
  const byDay = new Map<number, number>();
  for (const r of rows) {
    byDay.set(startOfUtcDay(r.dayStart), (byDay.get(startOfUtcDay(r.dayStart)) ?? 0) + r.answers);
  }

  const today = startOfUtcDay(now);
  const out: ActivityDay[] = [];
  for (let i = windowDays - 1; i >= 0; i--) {
    const dayStart = today - i * DAY_MS;
    out.push({ dayStart, answers: byDay.get(dayStart) ?? 0 });
  }
  return out;
}

// ----------------------------------------------------------------- mastery --

export type MasteryBucket = 'mastered' | 'struggling' | 'learning' | 'new';

export type MasteryCounts = Record<MasteryBucket, number>;

/**
 * Which bucket one card is in.
 *
 * Order matters, and `mastered` is tested before `struggling` on purpose: a card
 * you failed repeatedly and have since relearned to a three-week interval IS
 * mastered. Leaving it labelled "struggling" for ever would hold someone's worst
 * week against them permanently, which is the opposite of motivating — and it
 * would be untrue.
 */
export function masteryOf(state: ReviewState | null | undefined): MasteryBucket {
  if (!state || state.reps === 0) {
    // Never answered, or reset to zero by a lapse. A card whose streak was reset
    // is genuinely back to being learned, so it is not "new" unless it has no
    // history at all.
    if (!state) return 'new';
    return state.lapses >= STRUGGLING_LAPSES ? 'struggling' : 'learning';
  }
  if (state.intervalDays >= MASTERED_INTERVAL_DAYS) return 'mastered';
  if (state.lapses >= STRUGGLING_LAPSES) return 'struggling';
  return 'learning';
}

/** Bucket every card in a set. Cards with no schedule count as new. */
export function masteryCounts<T>(
  items: T[],
  stateOf: (item: T) => ReviewState | null | undefined,
): MasteryCounts {
  const counts: MasteryCounts = { mastered: 0, struggling: 0, learning: 0, new: 0 };
  for (const item of items) counts[masteryOf(stateOf(item))]++;
  return counts;
}

// ---------------------------------------------------------------- sections --

/** One item's history, as `item_stats` reports it. */
export interface ItemHistory {
  section: string | null;
  attempts: number;
  misses: number;
  partials: number;
}

export interface SectionScore {
  section: string;
  attempts: number;
  /** Answers that were fully correct — partials do not count towards this. */
  correct: number;
  /** 0..1. Only meaningful because `attempts >= MIN_SECTION_ATTEMPTS`. */
  accuracy: number;
}

export interface SectionSplit {
  strong: SectionScore[];
  weak: SectionScore[];
  /** Sections held back for want of answers, so the screen can say why. */
  tooEarly: number;
}

/**
 * Split a set's sections into what is going well and what is not.
 *
 * Grouped by section rather than by `topic`, and that is a measured choice:
 * `topic` produced 17 distinct labels across 17 cards, so every per-topic rate
 * would have been computed over a single answer. `section_title` comes from the
 * document's own headings and groups several cards together — on a 10-page PDF
 * the planner produces about eight of them.
 *
 * A partial counts as neither right nor wrong. It already halves the review
 * interval (`src/core/schedule.ts`), so it is felt in the schedule; counting it
 * as a miss here would penalise the same answer twice, and counting it as
 * correct would flatter.
 *
 * @param limit How many to name under each heading. Two — a list of eight
 *              sections is a spreadsheet, and the brief was to keep this simple.
 */
export function sectionSplit(history: ItemHistory[], limit = 2): SectionSplit {
  const totals = new Map<string, { attempts: number; correct: number }>();

  for (const row of history) {
    // A card with no section cannot be advice about where to look.
    if (!row.section) continue;
    if (row.attempts <= 0) continue;

    const t = totals.get(row.section) ?? { attempts: 0, correct: 0 };
    t.attempts += row.attempts;
    t.correct += Math.max(0, row.attempts - row.misses - row.partials);
    totals.set(row.section, t);
  }

  const scored: SectionScore[] = [];
  let tooEarly = 0;

  for (const [section, t] of totals) {
    if (t.attempts < MIN_SECTION_ATTEMPTS) {
      tooEarly++;
      continue;
    }
    scored.push({ section, attempts: t.attempts, correct: t.correct, accuracy: t.correct / t.attempts });
  }

  // Ties break on the larger sample, then by name, so the same data always
  // produces the same screen.
  const byAccuracy = (dir: 1 | -1) => (a: SectionScore, b: SectionScore) =>
    dir * (b.accuracy - a.accuracy) || b.attempts - a.attempts || a.section.localeCompare(b.section);

  return {
    strong: scored.filter((s) => s.accuracy >= STRONG_ACCURACY).sort(byAccuracy(1)).slice(0, limit),
    weak: scored.filter((s) => s.accuracy < STRONG_ACCURACY).sort(byAccuracy(-1)).slice(0, limit),
    tooEarly,
  };
}
