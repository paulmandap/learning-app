import { supabase } from './supabase';
import {
  busiestSet,
  dueForecast,
  masteryCounts,
  schedulesForVisibleCards,
  sectionSplit,
  studyStreak,
  type ForecastDay,
  type ItemHistory,
  type MasteryCounts,
  type SectionSplit,
} from '../core/progress';
import { startOfUtcDay, type ReviewState } from '../core/schedule';
import { summariseUsage, type UsageSummary } from '../core/storage';
import { storageUsedBytes } from './documents';

/**
 * Everything the Progress screen shows, in one round of queries (Phase 9b).
 *
 * The arithmetic lives in `src/core/progress.ts`, pure and tested. This file
 * only fetches rows and hands them over — the same split `src/data/review.ts`
 * keeps with the scheduler.
 *
 * ## Degrades rather than throws, like review.ts
 *
 * Every query here is wrapped, and a failure yields an empty section of the
 * screen rather than an error. A progress screen is the least important thing in
 * the app: it is worth nothing if the study loop breaks to show it. The
 * trade-off is the one already accepted in review.ts — a genuine outage looks
 * like "no history yet" — and it is accepted for the same reason, except that
 * here the screen also has to look right when there genuinely is no history,
 * which is the normal case for a new user.
 *
 * ## Why several small queries and not a view
 *
 * A `progress_stats` view would need a migration, and every input already exists
 * under RLS: `study_days` for the streak, `review_state` for mastery,
 * `item_stats` for per-card history, `study_items` for the section each card
 * belongs to, and `documents` for storage used. The joining is a few lines in
 * memory over a five-user dataset.
 */

export interface DashboardData {
  /** Consecutive days studied, counting back from the last day with an answer. */
  streak: number;
  /** Cards reviewed and now due again, across every set. */
  dueToday: number;
  /** Cards whose last answer was wrong or partly right — the missed pile (D8). */
  toRetry: number;
  mastery: MasteryCounts;
  sections: SectionSplit;
  /** Total answers ever recorded. Drives the "nothing here yet" state. */
  totalAttempts: number;
  /** How full the storage allowance is. Only surfaced when it matters. */
  usage: UsageSummary;
  /** Cards falling due over the week ahead, starting today. */
  forecast: ForecastDay[];
  /**
   * Where "Retry what you missed" should go — the set holding most of the
   * missed pile, or null when there is nowhere valid to send anyone.
   *
   * A count on this screen spans every set; a button has to lead to one. Null
   * is a real answer and the caller must not navigate on it: the alternative is
   * a route built from an id that is not there.
   */
  retryTarget: string | null;
  /** Where "Study what's due" should go, chosen the same way. */
  dueTarget: string | null;
}

export const EMPTY_DASHBOARD: DashboardData = {
  streak: 0,
  dueToday: 0,
  toRetry: 0,
  mastery: { known: 0, getting: 0, needsWork: 0, notStarted: 0 },
  sections: { strong: [], weak: [], tooEarly: 0 },
  totalAttempts: 0,
  usage: { usedBytes: 0, fraction: 0, worthMentioning: false },
  forecast: [],
  retryTarget: null,
  dueTarget: null,
};

interface StatsRow {
  study_item_id: string;
  study_set_id: string;
  attempts: number;
  misses: number;
  partials: number;
  last_result: 'correct' | 'partial' | 'incorrect' | null;
}

/**
 * Degrading quietly is right; degrading SILENTLY is not.
 *
 * Every query here returns an empty section rather than throwing, so one failed
 * query cannot take the screen down. But an empty section and a failed section
 * look identical to the user, and this project has already paid three times for
 * a failure that left no trace — an invisible model fallback read as a prompt
 * regression, a swallowed top-up read as dead code, and a fire-and-forget write
 * read as data loss. So each one says so.
 */
function warnIfFailed(what: string, error: { message: string } | null): void {
  if (error) console.warn(`[dashboard] ${what} query failed: ${error.message}`);
}

export async function fetchDashboard(now: number = Date.now()): Promise<DashboardData> {
  const [days, schedules, stats, items, usedBytes] = await Promise.all([
    // The streak reads from study_days, NOT from attempts. attempts cascades
    // from study_sets, so deleting a set would erase the days its answers
    // happened on and reset a streak for having tidied up. study_days
    // references only auth.users. It is also far cheaper: one small row per day
    // studied, instead of every answer ever recorded.
    supabase.from('study_days').select('day, answers'),
    // study_set_id rides along on both of these so the "what next" button has
    // somewhere to go. Both already carry the column, so this is two more
    // fields on queries that were being made anyway, not a sixth round trip.
    supabase
      .from('review_state')
      .select('study_item_id, study_set_id, reps, interval_days, lapses, due_at'),
    // Runs with security_invoker, so RLS applies and this is only ever the
    // caller's own history (the isolation test asserts that explicitly).
    supabase
      .from('item_stats')
      .select('study_item_id, study_set_id, attempts, misses, partials, last_result'),
    supabase.from('study_items').select('id, section_title').eq('hidden', false),
    storageUsedBytes(),
  ]);

  warnIfFailed('study_days', days.error);
  warnIfFailed('review_state', schedules.error);
  warnIfFailed('item_stats', stats.error);
  warnIfFailed('study_items', items.error);

  // --- streak --------------------------------------------------------------
  // A date column comes back as "2026-09-05"; parsing it as UTC midnight is
  // what makes it line up with startOfUtcDay rather than drifting by a timezone.
  const dayRows = (days.data ?? []) as { day: string; answers: number }[];
  let times = dayRows.map((r) => Date.parse(`${r.day}T00:00:00Z`));
  let totalAttempts = dayRows.reduce((n, r) => n + r.answers, 0);

  if (days.error) {
    // study_days needs migration 0009. Falling back to `attempts` matters
    // because the alternative is telling someone with months of history that
    // they have never studied — a far worse failure than the slower query this
    // replaced. Only on the error path, so it costs nothing once 0009 is in.
    const fallback = await supabase.from('attempts').select('created_at');
    if (!fallback.error) {
      const rows = (fallback.data ?? []) as { created_at: string }[];
      times = rows.map((r) => Date.parse(r.created_at));
      totalAttempts = rows.length;
    }
  }

  const streak = studyStreak(times, now);

  // --- mastery, and what is due -------------------------------------------
  const scheduleRows = (schedules.data ?? []) as {
    study_item_id: string;
    study_set_id: string;
    reps: number;
    interval_days: number;
    lapses: number;
    due_at: string;
  }[];

  const stateById = new Map<string, ReviewState>(
    scheduleRows.map((r) => [
      r.study_item_id,
      { reps: r.reps, intervalDays: r.interval_days, ease: 0, lapses: r.lapses },
    ]),
  );

  const today = startOfUtcDay(now);
  const itemRows = (items.data ?? []) as { id: string; section_title: string | null }[];

  // Only cards the student could actually be dealt. `itemRows` is already
  // filtered to hidden = false, so this is free — and without it a reported
  // card counts as due for ever, which is exactly what the owner saw: eleven
  // promised on this screen against a handful he could open.
  const visibleItemIds = new Set(itemRows.map((i) => i.id));
  const liveSchedules = schedulesForVisibleCards(
    scheduleRows.map((r) => ({
      studyItemId: r.study_item_id,
      studySetId: r.study_set_id,
      dueAt: Date.parse(r.due_at),
    })),
    visibleItemIds,
  );

  const dueNow = liveSchedules.filter((s) => s.dueAt <= today);
  const dueToday = schedules.error || items.error ? 0 : dueNow.length;
  // Null when nothing is due, which is the same condition that hides the
  // button — so the two cannot disagree.
  const dueTarget = schedules.error || items.error ? null : busiestSet(dueNow);

  // The week ahead, from the same rows the mastery bands come from — no extra
  // query. Overdue cards fold into today inside dueForecast.
  const forecast =
    schedules.error || items.error ? EMPTY_DASHBOARD.forecast : dueForecast(liveSchedules, now);


  // Every card in the account, bucketed. Cards with no schedule are new, which
  // masteryOf handles, so an untouched set shows as new rather than vanishing.
  const mastery = items.error
    ? EMPTY_DASHBOARD.mastery
    : masteryCounts(itemRows, (item) => stateById.get(item.id));

  // --- per-section history -------------------------------------------------
  const sectionById = new Map(itemRows.map((i) => [i.id, i.section_title]));
  const statRows = (stats.data ?? []) as StatsRow[];

  const history: ItemHistory[] = statRows.map((s) => ({
    // A stat row for a hidden or deleted card has no section and is ignored by
    // sectionSplit, which is the right outcome — a reported card should not
    // steer what the student studies next.
    section: sectionById.get(s.study_item_id) ?? null,
    attempts: s.attempts,
    misses: s.misses,
    partials: s.partials,
  }));

  const sections = stats.error || items.error ? EMPTY_DASHBOARD.sections : sectionSplit(history);

  // Keyed on the LAST result rather than on ever having missed it, matching
  // missedItemIds — something you got wrong once and have since learned should
  // leave the pile.
  //
  // Restricted to cards the app would actually deal, for the reason §21 records
  // about due counts: a stat row outlives the card it describes, so a reported
  // card kept inflating this number while every deck refused to show it. That
  // mattered less when the figure was decoration; it matters now that a button
  // promises to open it. `retryItems` is what the retry deck will contain, so
  // the count, the destination and the deck cannot drift apart.
  const retryItems = stats.error
    ? []
    : statRows.filter(
        (s) =>
          visibleItemIds.has(s.study_item_id) &&
          (s.last_result === 'incorrect' || s.last_result === 'partial'),
      );

  const toRetry = retryItems.length;
  const retryTarget = busiestSet(retryItems.map((s) => ({ studySetId: s.study_set_id })));

  return {
    streak,
    dueToday,
    toRetry,
    mastery,
    sections,
    totalAttempts,
    usage: summariseUsage(usedBytes),
    forecast,
    retryTarget,
    dueTarget,
  };
}
