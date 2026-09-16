import { completeRows, supabase, type Db } from './supabase';
import { isMissingTable } from '../core/db-errors';
import { NEW_CARD, startOfUtcDay, type Scheduled } from '../core/schedule';
import type { AttemptResult } from '../core/grade';
import type { Level } from '../core/planner';

/**
 * Review schedules — when each card is next due (Phase 6).
 *
 * `attempts` records what happened; `review_state` records what happens next.
 * The scheduling maths itself lives in src/core/schedule.ts, pure and tested;
 * this file only moves rows.
 *
 * ## Every function here degrades rather than throws
 *
 * Deliberate, and the reason is deployment order: the code ships before
 * `supabase/migrations/0005_review_state.sql` has necessarily been applied, and
 * a missing table must not break studying. It also holds afterwards — a
 * scheduling failure is not worth losing an answer over, and "no due count"
 * is a far better failure than a home screen that will not load.
 *
 * The trade-off is that a genuine outage looks like "nothing is due". That is
 * accepted here because the study loop still works without a schedule: the
 * missed pile (D8) predates this feature and is unaffected.
 */

export interface ReviewRow {
  study_item_id: string;
  study_set_id: string;
  due_at: string;
  interval_days: number;
  ease: number;
  reps: number;
  lapses: number;
  last_result: AttemptResult | null;
}

const COLUMNS =
  'study_item_id, study_set_id, due_at, interval_days, ease, reps, lapses, last_result';

function toScheduled(row: ReviewRow): Scheduled {
  return {
    reps: row.reps,
    intervalDays: row.interval_days,
    // Postgres numeric comes back as a string through PostgREST.
    ease: typeof row.ease === 'string' ? Number.parseFloat(row.ease) : row.ease,
    lapses: row.lapses,
    dueAt: Date.parse(row.due_at),
  };
}

/**
 * Schedules for every card in a set, keyed by item id.
 *
 * A card absent from the map has never been reviewed, which `isDue` treats as
 * due — so callers do not need to special-case new cards.
 */
export async function reviewStatesForSet(studySetId: string): Promise<Map<string, Scheduled>> {
  const result = await supabase
    .from('review_state')
    // count: a card whose schedule row is missing from a truncated read is
    // treated as never seen, so it loses its interval and its lapse history.
    .select(COLUMNS, { count: 'exact' })
    .eq('study_set_id', studySetId);

  if (result.error) return new Map();
  return new Map(
    (completeRows('reviewStatesForSet', result) as unknown as ReviewRow[]).map((r) => [
      r.study_item_id,
      toScheduled(r),
    ]),
  );
}

/**
 * How many cards are due right now in each set, keyed by set id.
 *
 * One query for the whole home screen rather than one per set, in the same
 * spirit as `continueTarget`.
 *
 * Counts only cards that have been reviewed and have come up again. Cards never
 * reviewed are deliberately excluded: a fresh set of 40 would otherwise read
 * "40 due today", which duplicates the card count already on the row and turns
 * a useful number into noise. "Due" here means "you have seen this and it is
 * time to see it again".
 */
export async function dueCountsBySet(
  now: number = Date.now(),
  db: Db = supabase,
): Promise<Map<string, number>> {
  // `my_schedule` (0021) has already joined the card to the schedule, as its
  // owner, so this counts due cards in sets somebody SHARED as well as your own.
  // The query it replaced embedded `study_items!inner`, and study_items stays
  // select-own — so in a shared set that join matched nothing and every due card
  // in it silently vanished from the badge.
  //
  // It also retires an embedded filter. NOTES §21.1: an embedded filter that
  // fails to resolve returns rows rather than an error, which is a wrong answer
  // with no trace, and §21 and §36 are both this badge disagreeing with the deck
  // it opens. A plain select on a relation that did the join cannot fail that way.
  //
  // count: a truncated read reintroduces the same disagreement from the other
  // direction.
  const { data, error, count } = await db
    .from('my_schedule')
    .select('study_set_id', { count: 'exact' })
    .lte('due_at', new Date(startOfUtcDay(now)).toISOString());

  if (isMissingTable(error)) return legacyDueCountsBySet(now, db);
  if (error) {
    console.warn(`[review] due counts unavailable: ${error.message}`);
    return new Map();
  }

  const counts = new Map<string, number>();
  for (const row of completeRows('dueCountsBySet', { data, count }) as {
    study_set_id: string;
  }[]) {
    counts.set(row.study_set_id, (counts.get(row.study_set_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * The pre-0021 query, for the gap between deploying this and applying it.
 *
 * Migration order matters (NOTES §31), and the safe direction is a build that
 * still works against the older database. Without this, deploying before the
 * migration lands would empty every due badge in the app — including on sets
 * nobody has shared — and it would look exactly like "nothing is due".
 *
 * Logged, because a fallback that says nothing has cost this project a wrong
 * conclusion four times. Delete it once 0021 is applied and recorded.
 */
async function legacyDueCountsBySet(now: number, db: Db): Promise<Map<string, number>> {
  console.warn('[review] my_schedule is missing (apply migration 0021); counting own sets only.');

  const { data, error, count } = await db
    .from('review_state')
    .select('study_set_id, study_items!inner(hidden)', { count: 'exact' })
    .eq('study_items.hidden', false)
    .lte('due_at', new Date(startOfUtcDay(now)).toISOString());

  if (error) {
    console.warn(`[review] due counts unavailable: ${error.message}`);
    return new Map();
  }

  const counts = new Map<string, number>();
  for (const row of completeRows('dueCountsBySet/legacy', { data, count }) as {
    study_set_id: string;
  }[]) {
    counts.set(row.study_set_id, (counts.get(row.study_set_id) ?? 0) + 1);
  }
  return counts;
}

/**
 * Due cards in one set, by level.
 *
 * The set screen shows "7 due" and opens a deck, and a deck deals one level. So
 * the link has to know which level the seven are at, or it opens a deck with
 * none of them in it — which is how "8 due today" survived a finished deck on
 * the owner's phone (NOTES §36). Same inner join and the same hidden-card rule
 * as `dueCountsBySet`, so the two counts cannot disagree.
 */
export async function dueLevelsForSet(
  studySetId: string,
  now: number = Date.now(),
  db: Db = supabase,
): Promise<Partial<Record<Level, number>>> {
  const { data, error, count } = await db
    .from('my_schedule')
    .select('level', { count: 'exact' })
    .eq('study_set_id', studySetId)
    .lte('due_at', new Date(startOfUtcDay(now)).toISOString());

  if (isMissingTable(error)) return legacyDueLevelsForSet(studySetId, now, db);
  if (error) {
    console.warn(`[review] due levels unavailable: ${error.message}`);
    return {};
  }

  const counts: Partial<Record<Level, number>> = {};
  for (const row of completeRows('dueLevelsForSet', { data, count }) as { level: Level }[]) {
    counts[row.level] = (counts[row.level] ?? 0) + 1;
  }
  return counts;
}

/** The pre-0021 query. See `legacyDueCountsBySet` for why this exists. */
async function legacyDueLevelsForSet(
  studySetId: string,
  now: number,
  db: Db,
): Promise<Partial<Record<Level, number>>> {
  const { data, error, count } = await db
    .from('review_state')
    .select('study_items!inner(hidden, level)', { count: 'exact' })
    .eq('study_set_id', studySetId)
    .eq('study_items.hidden', false)
    .lte('due_at', new Date(startOfUtcDay(now)).toISOString());

  if (error) {
    console.warn(`[review] due levels unavailable: ${error.message}`);
    return {};
  }

  const counts: Partial<Record<Level, number>> = {};
  for (const row of completeRows('dueLevelsForSet/legacy', { data, count }) as {
    study_items: { level: Level } | { level: Level }[] | null;
  }[]) {
    const item = Array.isArray(row.study_items) ? row.study_items[0] : row.study_items;
    if (!item) continue;
    counts[item.level] = (counts[item.level] ?? 0) + 1;
  }
  return counts;
}

/** Due count for one set. */
export async function dueCountForSet(
  studySetId: string,
  now: number = Date.now(),
  db: Db = supabase,
): Promise<number> {
  return (await dueCountsBySet(now, db)).get(studySetId) ?? 0;
}

/**
 * The current schedule for one card, or NEW_CARD if it has never been reviewed.
 *
 * Returned as plain state rather than Scheduled: the caller is about to compute
 * the next state, and a due date it is about to overwrite would be noise.
 */
export async function currentState(studyItemId: string, db: Db = supabase) {
  const { data, error } = await db
    .from('review_state')
    .select(COLUMNS)
    .eq('study_item_id', studyItemId)
    .maybeSingle();

  if (error || !data) return NEW_CARD;
  const s = toScheduled(data as unknown as ReviewRow);
  return { reps: s.reps, intervalDays: s.intervalDays, ease: s.ease, lapses: s.lapses };
}

/**
 * Write a card's next schedule.
 *
 * ## The conflict target changed in 0021, and the order matters
 *
 * It used to be `study_item_id` alone, which 0005 declared unique on the then
 * true premise that a card belonged to exactly one person. A set shared with
 * everyone is studied in place, so two people answer one card and each needs
 * their own due date — under the old key the second person's upsert targets a
 * row RLS hides from them, and their schedule is either refused or written
 * nowhere at all.
 *
 * `(user_id, study_item_id)` is added by 0021 and the old single-column unique
 * is dropped by 0022, IN THAT ORDER, with this deploy in between. PostgREST
 * needs a matching unique constraint for the conflict target it is given: run
 * 0022 before this code is live and every schedule write in the app answers
 * 42P10 instead. See the header of 0022.
 *
 * Two tabs grading the same card still race to a well-defined winner; they are
 * now the same person's two tabs rather than any two tabs anywhere.
 */
export async function saveSchedule(
  input: {
    userId: string;
    studyItemId: string;
    studySetId: string;
    state: Scheduled;
    lastResult: AttemptResult;
  },
  db: Db = supabase,
): Promise<void> {
  const { error } = await db.from('review_state').upsert(
    {
      user_id: input.userId,
      study_item_id: input.studyItemId,
      study_set_id: input.studySetId,
      due_at: new Date(input.state.dueAt).toISOString(),
      interval_days: input.state.intervalDays,
      ease: input.state.ease,
      reps: input.state.reps,
      lapses: input.state.lapses,
      last_result: input.lastResult,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,study_item_id' },
  );

  // This result was thrown away until now, and it is the single most important
  // place in the app not to. A failure here loses a card's schedule silently:
  // the answer is still graded, the deck still moves on, and the card simply
  // never comes back. It is also exactly what a wrong conflict target produces
  // (42P10, see above), so the one error that would tell you 0022 was applied
  // too early was the one error nothing was reading.
  //
  // Warned, not thrown: a lost schedule must not end a study session mid-deck.
  // "Anything that fails silently will cost you a wrong conclusion" — HANDOFF.
  if (error) {
    console.warn(
      `[review] schedule not saved for card ${input.studyItemId}: ${error.message}` +
        (error.code ? ` (${error.code})` : ''),
    );
  }
}
