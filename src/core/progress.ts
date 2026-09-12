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
import type { AttemptResult } from './grade';

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

/**
 * Keep only the schedules whose card the student can still be shown.
 *
 * ## The bug this exists to stop
 *
 * The owner: *"it says 11 cards ready for review but in my study tab, there's
 * only a few."*
 *
 * `listItems` filters `hidden = false`, so a card that has been reported —
 * *"Thanks, you won't see that one again"* — is gone from every deck. Its
 * `review_state` row is not: nothing deletes it, and every due count read
 * straight from that table. So a reported card stayed "due" for ever, on a
 * screen that promised work the app would then refuse to hand over.
 *
 * A promised count that cannot be delivered is worse than no count: it makes
 * the number look broken, and after a while it makes the screen look broken.
 *
 * Deliberately takes the ids the caller already has rather than a `hidden`
 * flag, so it is equally correct for a card that is hidden, one whose row has
 * gone, and any future reason a card stops being shown. The rule is "count
 * what you would deal", not "count what is not hidden".
 */
export function schedulesForVisibleCards<T extends { studyItemId: string }>(
  schedules: T[],
  visibleItemIds: ReadonlySet<string>,
): T[] {
  return schedules.filter((s) => visibleItemIds.has(s.studyItemId));
}

/**
 * Which set holds the most of something — the set to send someone to.
 *
 * ## Why the dashboard needs this
 *
 * Progress counts across every set at once, which is right for a number and
 * useless for a button: "Retry what you missed (12)" has to lead somewhere, and
 * the twelve may be spread over four sets. This picks the one worth opening.
 *
 * Most-of-them rather than most-recent, which is the opposite of Home's
 * `continueTarget`, and deliberately so. Home answers *where was I*; this
 * answers *where is the work*. A student who studied one set this morning and
 * has a backlog in another should be sent to the backlog.
 *
 * Ties break on the set id so the same data always produces the same button.
 * Returns null for an empty list, which the caller must treat as "no valid
 * destination" rather than navigating anyway.
 */
export function busiestSet(rows: { studySetId: string }[]): string | null {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.studySetId, (counts.get(row.studySetId) ?? 0) + 1);

  let best: string | null = null;
  let bestCount = 0;
  for (const [setId, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && setId < best)) {
      best = setId;
      bestCount = count;
    }
  }
  return best;
}

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
 * Every row is a weekday name — Sunday, Monday, Tuesday — including the first
 * two. It said "Today" and "Tomorrow" for those, on the reasoning that they are
 * the days people plan around, and the owner disliked it: *"i don't like that
 * today and tomorrow."*
 *
 * He was right, and the reason is that the list then spoke two vocabularies at
 * once. Five weekday names with two relative words at the top makes the reader
 * translate between them to work out whether Thursday is before or after
 * tomorrow. One kind of label throughout is simply read.
 *
 * The window still starts today rather than on a Sunday, so no row is a day
 * that has already gone and a full week ahead is always visible.
 *
 * UTC throughout, matching the day boundaries the schedule and the streak use.
 */
export function forecastDayLabel(dayStart: number, _todayStart?: number): string {
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
  // "cards ready for review" line above has already said it. This matters more
  // now that rows are named rather than relative — "Wednesday is the busy one"
  // on a Wednesday reads as a statement about some other Wednesday.
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
 * ## A partial counts as WRONG here, and this docstring used to deny it
 *
 * The arithmetic is `correct = attempts - misses - partials` over `attempts`,
 * so a partial is excluded from the numerator and kept in the denominator —
 * arithmetically identical to a miss. Four answers with two partials and no
 * misses score 50%, exactly as two outright misses would.
 *
 * This paragraph previously read *"A partial counts as neither right nor
 * wrong… counting it as a miss here would penalise the same answer twice"*,
 * which describes behaviour the code does not have, and `tests/progress.test.ts`
 * pinned the real behaviour under that same false name. Corrected 2026-09-12
 * rather than changed: the reasoning in the old wording is a good argument for
 * excluding partials from both halves of the fraction, and acting on it would
 * move every accuracy figure on the Progress screen — an owner's call, not a
 * tidy-up. **Flagged, not fixed.**
 *
 * `sectionTrends` follows this same definition deliberately. If the two
 * disagreed, one screen would report a section at 43% and describe it as
 * climbing on a different definition of the number.
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

// ------------------------------------------------------------------- trend --

/**
 * Is a section getting better, or worse?
 *
 * ## The question this answers, and why it was missing
 *
 * `sectionSplit` above says where a student stands: 43% on Renal Physiology.
 * It cannot say whether that 43% is on its way up from 20% or down from 70%,
 * and those are opposite situations wanting opposite advice. It is the one
 * thing the brief asked for that nothing in this app could answer.
 *
 * Nothing new is stored for it. `attempts` has carried `created_at` since 0001;
 * the information was always there and was only ever aggregated away by the
 * `item_stats` view, which sums a lifetime and keeps no order.
 *
 * ## Why this is a word and not a chart
 *
 * `app/(tabs)/progress.tsx` records a decision against plotting accuracy over
 * time: *"with a handful of answers a day it would be mostly noise, and a noisy
 * chart of a real measure is worse than no chart."* That reasoning is still
 * right, and it is the reason this returns one of three words rather than a
 * line: a chart shows every wobble and invites the reader to find a trend in
 * it, while a gated label refuses to say anything until the movement is bigger
 * than the noise.
 *
 * The gate is what makes that true, so the gate is measured rather than
 * guessed — see `tests/trend.test.ts`, which runs the rule against a simulated
 * student whose real accuracy never changes and requires that it rarely claims
 * a direction.
 *
 * ## What the measurement assumes, and where it is optimistic
 *
 * The simulation treats each answer as an independent coin flip at a fixed
 * probability. **Real study data is neither independent nor stationary**, and
 * the ways it differs are worth stating because they all push the same way:
 *
 *  - **The same card recurs.** A section's answers are not draws from a pool of
 *    distinct questions; a handful of cards are asked repeatedly. Getting a
 *    card right once makes getting it right again more likely, so answers
 *    cluster and the true variance is higher than the binomial figure.
 *  - **The scheduler chooses what you see.** `reviewOrder` deals overdue and
 *    lapsed cards first, so a window is enriched with cards you recently got
 *    wrong. That is the point of spaced repetition, and it means the two
 *    windows are not samples from the same population even when nothing about
 *    the student has changed.
 *  - **A real change is gradual.** The power figure below assumes accuracy
 *    steps cleanly at the midpoint; a drift spread across both windows shows up
 *    smaller and is caught less often.
 *
 * So the false-alarm rates are a floor, not a guarantee. They are still worth
 * having — they were enough to reject the first choice of constants outright —
 * but the honest reading is "this rule is quiet enough to be worth shipping",
 * not "this rule is wrong 6.9% of the time".
 *
 * ## Several sections are tested at once, and that multiplies
 *
 * The 6.9% is **per section**. The dashboard computes a direction for every
 * section and shows up to four (two strong, two weak), so the chance that at
 * least one of them is wrong for a student who has not changed is higher —
 * measured 2026-09-12, 40,000 trials per cell:
 *
 * | sections | p=0.5 | p=0.7 | p=0.85 |
 * |---|---|---|---|
 * | 1  | 0.069 | 0.077 | 0.026 |
 * | 4  | 0.249 | 0.278 | 0.102 |
 * | 8  | 0.441 | 0.481 | 0.196 |
 *
 * **About one screen in four will carry a spurious word** once a student has
 * four ranked sections. No correction is applied, deliberately: the alternative
 * is a threshold so strict that nothing is ever said, and the cost of being
 * wrong here is one soft word on a dashboard, not a grade or a schedule. But
 * the number belongs in writing, because "6.9%" on its own reads as a promise
 * about the screen and it is only a promise about one row.
 */

/** An answer, with enough of its context to place it in time and in a section. */
export interface AttemptRecord {
  section: string | null;
  result: AttemptResult;
  /** Epoch ms. Only the ORDER matters, never the gap. */
  at: number;
}

export type TrendDirection = 'improving' | 'steady' | 'slipping';

/**
 * Answers a section needs in EACH half before a direction is worth claiming.
 *
 * ## Both numbers below are measured, and the first guess was badly wrong
 *
 * Six per window with a one-third threshold looked reasonable and is unusable.
 * Simulating a student whose real accuracy NEVER changes — so every direction
 * reported is a false alarm — gave these rates at p = 0.5, where variance is
 * worst (20,000 trials each, 2026-09-12):
 *
 * | per window | ≥ 1/3 | ≥ 0.40 | ≥ 0.50 |
 * |---|---|---|---|
 * | 6  | **0.385** | 0.145 | 0.145 |
 * | 8  | 0.215 | 0.077 | 0.077 |
 * | 10 | 0.114 | **0.069** | 0.031 |
 * | 12 | 0.154 | 0.065 | 0.021 |
 * | 15 | 0.084 | 0.022 | 0.005 |
 *
 * So the obvious setting would have told **two students in five** that they
 * were improving or slipping when nothing had happened. That is precisely the
 * "mostly noise" the dashboard's own docstring warns about, and it would have
 * shipped looking perfectly sensible.
 *
 * Ten per window at a 0.40 threshold costs 6.9% in the worst case and 2.8% for
 * a consistently strong student, while still catching a genuine 0.4 → 0.8 shift
 * 55% of the time. Twelve buys almost nothing (6.5%) for a fifth more data.
 *
 * The table is not monotonic along a row because the threshold interacts with
 * the window's granularity: at ten, accuracy moves in tenths, so 0.40 means
 * "four more right out of ten" exactly.
 *
 * **The cost is honest and worth stating: a section needs twenty answers before
 * this says anything at all.** Staying silent until then is the point.
 */
export const MIN_TREND_WINDOW = 10;

/**
 * How far back "recently" reaches.
 *
 * Two months. A section someone turned around in March is not *improving* in
 * September, and a window with no far edge would eventually compare a student
 * against a beginner they no longer are — always flattering, never actionable.
 *
 * It is also the bound that keeps the query finite. `attempts` is the fastest
 * growing table in the app and the only unbounded read left on this screen, so
 * the date filter and the row cap beside it are not tidiness.
 */
export const TREND_WINDOW_DAYS = 60;

/**
 * Most answers the trend query will ever pull back.
 *
 * A safety rail rather than a product decision: at two months a heavy user
 * could hold thousands of answers, and the dashboard should not download all of
 * them to work out three words. Newest first, so a truncated window is still
 * the most recent history rather than an arbitrary slice.
 */
export const TREND_ATTEMPT_CAP = 600;

/**
 * How far accuracy must move before it is a direction rather than a wobble.
 *
 * Four tenths — with `MIN_TREND_WINDOW` at ten, exactly "four more right out of
 * ten, or four fewer". See the measured table above for what lower thresholds
 * cost. This project would rather stay quiet than tell someone they are
 * slipping because two cards went badly.
 */
export const TREND_THRESHOLD = 0.4;

/**
 * ## Units, stated once because they are easy to misread
 *
 * `earlier` and `recent` are **proportions in 0..1** — the share of answers in
 * that window that were fully correct. `change` is their difference, so it is
 * in **percentage POINTS, not a relative percentage**: a section going from 20%
 * to 60% has `change = 0.4`, not 2.0. `TREND_THRESHOLD` is in the same units,
 * which at ten answers per window makes it exactly "four more right out of ten".
 *
 * ## These numbers are not the percentage on the screen
 *
 * The Progress row shows `SectionScore.accuracy` from `sectionSplit`, which is a
 * **lifetime** rate over every answer ever given, from the `item_stats` view.
 * `earlier` and `recent` come from the **last 60 days, capped at 600 answers**.
 * They are different populations and will disagree — a section can show 7% and
 * still be climbing, because the 7% carries a bad start the trend window has
 * left behind. That is the intended reading, and it is why the two are kept as
 * separate fields rather than merged.
 *
 * Only `direction` currently reaches a user. `earlier`, `recent` and `change`
 * are computed for callers that want to explain the word — nothing renders them
 * today, and anything that starts to must say which window it is quoting.
 */
export interface SectionTrend {
  section: string;
  direction: TrendDirection;
  /** Share correct in the older half, 0..1. NOT the lifetime rate on screen. */
  earlier: number;
  /** Share correct in the newer half, 0..1. */
  recent: number;
  /** `recent - earlier`, in percentage points. Signed. */
  change: number;
  /** Answers counted — both halves, so always even. */
  attempts: number;
}

/**
 * Accuracy over a run of answers.
 *
 * A partial scores zero, which is what `sectionSplit` already does: its
 * `correct` excludes partials while its denominator keeps them. The two must
 * agree or the same screen would report a section at 43% and call it improving
 * on a different definition of the number.
 *
 * Worth flagging rather than burying: `sectionSplit`'s docstring says a partial
 * "counts as neither right nor wrong", and the arithmetic there makes it count
 * exactly as a miss. Whichever is intended, this follows the code so the screen
 * stays coherent.
 */
function accuracyOf(rows: AttemptRecord[]): number {
  if (rows.length === 0) return 0;
  const correct = rows.filter((r) => r.result === 'correct').length;
  return correct / rows.length;
}

/**
 * Which way each section is going.
 *
 * Splits a section's answers down the middle in time and compares the two
 * halves. **The halves are kept equal in size** — on an odd count the middle
 * answer is dropped — because an eleven-answer section split 6/5 compares
 * windows whose noise floors differ, and the larger one would look steadier for
 * no reason a student could see.
 *
 * Sections without enough history are absent from the result rather than
 * reported as `steady`: "we do not know yet" and "you are holding level" are
 * different things, and only one of them is worth a line on a screen.
 */
export function sectionTrends(rows: AttemptRecord[]): SectionTrend[] {
  const bySection = new Map<string, AttemptRecord[]>();
  for (const row of rows) {
    if (!row.section) continue;
    const list = bySection.get(row.section);
    if (list) list.push(row);
    else bySection.set(row.section, [row]);
  }

  const out: SectionTrend[] = [];

  for (const [section, all] of bySection) {
    // Oldest first. Index breaks ties so two answers on the same millisecond
    // keep the order they arrived in rather than depending on sort stability.
    const ordered = all
      .map((r, i) => ({ r, i }))
      .sort((a, b) => a.r.at - b.r.at || a.i - b.i)
      .map(({ r }) => r);

    const half = Math.floor(ordered.length / 2);
    if (half < MIN_TREND_WINDOW) continue;

    const earlier = accuracyOf(ordered.slice(0, half));
    // From the END, so the dropped middle answer on an odd count is the one
    // furthest from both windows rather than the newest.
    const recent = accuracyOf(ordered.slice(ordered.length - half));
    const change = recent - earlier;

    const direction: TrendDirection =
      change >= TREND_THRESHOLD ? 'improving' : change <= -TREND_THRESHOLD ? 'slipping' : 'steady';

    out.push({ section, direction, earlier, recent, change, attempts: half * 2 });
  }

  // Biggest movement first, then by name, so the same data always produces the
  // same screen — the rule sectionSplit already follows.
  return out.sort(
    (a, b) => Math.abs(b.change) - Math.abs(a.change) || a.section.localeCompare(b.section),
  );
}
