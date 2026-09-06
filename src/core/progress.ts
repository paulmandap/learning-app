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

/*
 * MASTERED_INTERVAL_DAYS (21) and STRUGGLING_LAPSES (3) used to live here and
 * are gone rather than left unused. Both were inputs to the old mastery bands,
 * which measured the SCHEDULE rather than the learner — see KNOWN_REPS below
 * for what replaced them and why. The scheduler still uses intervals and
 * lapses; nothing outside it needs to know those numbers any more.
 */

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

/** Days shown in the forecast. A week is as far as a student plans. */
export const FORECAST_DAYS = 7;

export interface ForecastDay {
  /** UTC day boundary, so it lines up with the streak and the due dates. */
  dayStart: number;
  /** Cards falling due that day. */
  due: number;
}

/**
 * What is coming, day by day, starting today.
 *
 * ## Why this replaced "answers a day, last 30 days"
 *
 * The old chart plotted how many answers were given each day, and the owner
 * asked the right question of it: *"what is the relevance of that information?
 * like 225 answers in 2 days. what do i gain from that?"*
 *
 * Nothing, is the honest answer. It measured **effort rather than learning**,
 * and worse, it rewarded the exact behaviour the scheduler exists to prevent:
 * cramming 225 answers into two days drew the tallest bars on the screen, while
 * the spacing that actually makes things stick drew none. "Am I keeping at it?"
 * was already answered, better, by the streak and the pet beside it.
 *
 * This answers something nothing else in the app can: whether tonight is light
 * and tomorrow is heavy. It is forward-looking, it is actionable, and it cannot
 * be inflated by grinding.
 *
 * **Overdue cards fold into today**, because that is what they are: work
 * waiting now. Giving them their own past-dated column would push the useful
 * part of the chart sideways to make room for a scolding.
 */
export function dueForecast(
  states: { dueAt: number }[],
  now: number,
  windowDays: number = FORECAST_DAYS,
): ForecastDay[] {
  const today = startOfUtcDay(now);
  const byDay = new Map<number, number>();

  for (const s of states) {
    const day = startOfUtcDay(s.dueAt);
    const bucket = day < today ? today : day;
    // Beyond the window there is nothing to show; a card due in three months
    // is not a plan, it is a promise.
    if (bucket > today + (windowDays - 1) * DAY_MS) continue;
    byDay.set(bucket, (byDay.get(bucket) ?? 0) + 1);
  }

  const out: ForecastDay[] = [];
  for (let i = 0; i < windowDays; i++) {
    const dayStart = today + i * DAY_MS;
    out.push({ dayStart, due: byDay.get(dayStart) ?? 0 });
  }
  return out;
}

/**
 * What to call a day in the forecast.
 *
 * "Today" and "Tomorrow" rather than dates, because those are the two days
 * anyone actually plans around; the rest get a weekday name, which is enough
 * to locate them inside a single week. UTC throughout, matching the day
 * boundaries the schedule and the streak both use.
 */
export function forecastDayLabel(dayStart: number, todayStart: number): string {
  const offset = Math.round((dayStart - todayStart) / DAY_MS);
  if (offset === 0) return 'Today';
  if (offset === 1) return 'Tomorrow';
  return new Date(dayStart).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
}

/** Share of the week's cards a day must hold before it is worth naming. */
const BUSY_DAY_SHARE = 0.4;

/**
 * The one sentence worth putting under the forecast.
 *
 * Seven bars still leave the reader to find the shape in them; this names it.
 * It says nothing at all rather than manufacturing an observation, because a
 * line of commentary under every chart is how a dashboard starts feeling like
 * it is talking for the sake of it.
 */
export function describeForecast(days: ForecastDay[], todayStart: number): string | null {
  const total = days.reduce((n, d) => n + d.due, 0);
  if (total === 0) return "Nothing waiting this week — you're ahead.";

  const heaviest = days.reduce((a, b) => (b.due > a.due ? b : a));
  // Today needs no announcement: its own row is the first thing read, and the
  // "cards ready for review" line above has already said it.
  if (heaviest.dayStart === todayStart) return null;

  // Worth naming only if it genuinely stands out. Without this, "Thursday is
  // the busy one" gets said about a day holding one more card than its
  // neighbours, and the sentence stops meaning anything.
  const standsOut = heaviest.due >= 2 && heaviest.due / total >= BUSY_DAY_SHARE;
  if (!standsOut) return null;

  return `${forecastDayLabel(heaviest.dayStart, todayStart)} is the busy one.`;
}

// ----------------------------------------------------------------- mastery --

export type MasteryBucket = 'known' | 'getting' | 'needsWork' | 'notStarted';

export type MasteryCounts = Record<MasteryBucket, number>;

/**
 * Correct answers in a row before a card counts as known.
 *
 * ## Why this replaced a 21-day interval
 *
 * The first version called a card mastered once its interval reached 21 days,
 * which is SM-2's conventional line and is defensible as a statement about
 * scheduling. As a thing to show a student it was broken, and the owner spotted
 * it: *"i don't really know what's know well, getting there, and not started.
 * to me it's just a circle with different colors."*
 *
 * Tracing the real schedule shows why. Intervals go 1 day, 6 days, 16 days,
 * 45 days, and a card is only shown when it comes due:
 *
 * | correct answers | interval | falls on |
 * |---|---|---|
 * | 1 | 1 day  | day 0 |
 * | 2 | 6 days | day 1 |
 * | 3 | 16 days | day 7 |
 * | 4 | 45 days | **day 23** |
 *
 * **No card could reach "known" before the 23rd day of using the app**, however
 * well the student answered. Everything they had touched sat in one middle band
 * and everything else in another, so the chart could not move for three weeks —
 * it was reporting how long ago they installed the app, not what they had
 * learned.
 *
 * Three in a row lands on day 7 instead, and it is also the plainer claim: "you
 * have got this right three times running" is something a person can check
 * against their own memory, which "its interval exceeds 21 days" is not.
 */
export const KNOWN_REPS = 3;

/**
 * Which bucket one card is in.
 *
 * `reps` is the scheduler's count of consecutive successes: a correct answer
 * increments it, a wrong answer resets it to zero, and a partial holds it. That
 * makes it exactly the number this wants, already maintained, with no new
 * storage — and it moves the same day a student answers, which the interval
 * never did.
 */
export function masteryOf(state: ReviewState | null | undefined): MasteryBucket {
  // No schedule at all means it has never been answered. Distinct from a card
  // answered wrong, which HAS a schedule sitting at zero — those are different
  // things to a learner, and the whole point is that the bands mean something.
  if (!state) return 'notStarted';
  if (state.reps >= KNOWN_REPS) return 'known';
  if (state.reps > 0) return 'getting';
  return 'needsWork';
}

/** Bucket every card in a set. Cards with no schedule have not been started. */
export function masteryCounts<T>(
  items: T[],
  stateOf: (item: T) => ReviewState | null | undefined,
): MasteryCounts {
  const counts: MasteryCounts = { known: 0, getting: 0, needsWork: 0, notStarted: 0 };
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
