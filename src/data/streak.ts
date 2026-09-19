import { supabase, type Db } from './supabase';
import { isMissingTable } from '../core/db-errors';
import { MONTHLY_STREAK_RESTORES, utcDayString } from '../core/progress';

/**
 * Days forgiven with a streak restore (NOTES §47).
 *
 * The owner: *"i just broke my streak. implement just like tiktok, having the
 * restore streak button. maximum of 5 restore every month, 48 hours between
 * each restore before it expires to start from 0 again."*
 *
 * ## Why this is not a row in study_days
 *
 * The tempting version writes a `study_days` row for the missed day, and the
 * existing streak sum just works. It would also be a lie: Progress counts days
 * studied and total answers from that table, so a restored day would show as
 * studying that never happened — and the number people are proudest of would be
 * the one that was not true. `study_days` stays a record of what happened; this
 * records what was forgiven, and `studyStreak` reads both.
 *
 * ## Why the month's allowance is not checked here
 *
 * `claim_streak_restore` (0024) counts and inserts in one statement, for the
 * same reason as `claim_chat_message`: checking from the client and then
 * writing is two round trips with a race in the middle, and two taps both read
 * "4 used" and both proceed. What this module knows is only what to SHOW before
 * the tap.
 */

/** A restore that could not be granted, and why — in words for the person. */
export class NoRestoresLeftError extends Error {
  constructor() {
    super(`You have used all ${MONTHLY_STREAK_RESTORES} streak restores this month.`);
    this.name = 'NoRestoresLeftError';
  }
}

/**
 * The days this account has had forgiven, as UTC day starts.
 *
 * Returns nothing at all before 0024 is applied, which is the right answer:
 * nothing has been restored, so every streak is exactly what the answers say.
 */
export async function listStreakRestores(db: Db = supabase): Promise<number[]> {
  const { data, error } = await db.from('streak_restores').select('restored_day');

  if (isMissingTable(error)) return [];
  if (error) {
    // Degrades rather than throwing, like everything the streak touches: a
    // missing restore shows a shorter streak, and a Progress screen that will
    // not load is worse. Logged, because a silent one would look like the
    // restore never happened.
    console.warn(`[streak] restores unavailable: ${error.message}`);
    return [];
  }

  // A `date` column arrives as "2026-09-19"; parsing it as UTC midnight is what
  // lines it up with startOfUtcDay rather than drifting by a time zone.
  return ((data ?? []) as { restored_day: string }[]).map((r) =>
    Date.parse(`${r.restored_day}T00:00:00Z`),
  );
}

/**
 * Forgive one missed day.
 *
 * Returns how many restores are left this month afterwards. Throws
 * `NoRestoresLeftError` when the five are already spent — the function answers
 * -1 for that, and a screen must say so rather than appearing to work, since
 * "restore" that silently did nothing is the worst possible answer to somebody
 * who has just lost a streak.
 */
export async function claimStreakRestore(dayStart: number, db: Db = supabase): Promise<number> {
  const { data, error } = await db.rpc('claim_streak_restore', { p_day: utcDayString(dayStart) });

  if (isMissingTable(error) || error?.code === 'PGRST202') {
    throw new Error('Streak restores are not switched on yet.');
  }
  if (error) throw new Error(error.message);

  const left = Number(data);
  if (left < 0) throw new NoRestoresLeftError();
  return left;
}
