import { completeRows, supabase, type Db } from './supabase';
import { NEW_CARD, startOfUtcDay, type Scheduled } from '../core/schedule';
import type { AttemptResult } from '../core/grade';

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
  const { data, error, count } = await db
    .from('review_state')
    // The inner join is the fix for a real defect, not tidiness. A reported
    // card is hidden from every deck by `listItems`, but nothing deletes its
    // schedule — so counting these rows unfiltered promised cards the app
    // would then refuse to deal, and the badge drifted further from the deck
    // with every card reported. `!inner` drops the row when the card is gone
    // or hidden, in the same round trip.
    // count: §21 was a due badge that disagreed with the deck. A truncated
    // read reintroduces exactly that, from the other direction.
    .select('study_set_id, study_items!inner(hidden)', { count: 'exact' })
    .eq('study_items.hidden', false)
    .lte('due_at', new Date(startOfUtcDay(now)).toISOString());

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
 * Upserts on study_item_id, which the table declares unique — so two tabs
 * grading the same card race to a well-defined winner instead of inserting two
 * schedules for one item.
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
  await db.from('review_state').upsert(
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
    { onConflict: 'study_item_id' },
  );
}
