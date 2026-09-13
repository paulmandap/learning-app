import { supabase, type Db } from './supabase';
import { listSets, type StudySet } from './sets';
import { EMPTY_DASHBOARD, fetchDashboard, type DashboardData } from './dashboard';
import { EMPTY_SNAPSHOT, type AppSnapshot } from '../core/nomi-brain';
import { greetingName } from '../core/avatar';
import { formatSetTitle } from '../core/title';

/**
 * Everything Nomi knows about the student, assembled once.
 *
 * ## What changed, and why
 *
 * This boundary was built early and kept deliberately almost empty — "only
 * `listSets`" — on the grounds that anything more would be speculative until
 * the learning data existed. It exists now, and the owner asked for exactly
 * what the boundary was for: *"when I asked Nomi 'what is my streak today',
 * Nomi didn't know the answer. Nomi must know me as the user and the overall
 * app."* (NOTES §36.)
 *
 *     Nomi (brain + chat)  →  this module  →  existing src/data functions
 *
 * It still composes rather than queries. The dashboard already computes the
 * streak, due counts, missed pile and per-set numbers from its own round of
 * queries; this adds the set titles `listSets` already reads and the one thing
 * neither has, the student's name. A second copy of any of those rules here
 * would drift from Progress the first time either changed.
 *
 * ## Degrades part by part
 *
 * A snapshot with no name is still worth having, and one with no sets still
 * knows the streak. Each part fails on its own, loudly in the console, so
 * "Nomi doesn't know my name" is never indistinguishable from "I never gave
 * it one".
 */
export async function getAppSnapshot(
  db: Db = supabase,
  now: number = Date.now(),
): Promise<AppSnapshot> {
  const [dashboard, sets, profile] = await Promise.all([
    fetchDashboard(now, db).catch((err): DashboardData => {
      warn('progress', err);
      return { ...EMPTY_DASHBOARD, setStats: [], forecast: [], trends: [] };
    }),
    listSets(db).catch((err): StudySet[] => {
      warn('study sets', err);
      return [];
    }),
    // One column, the caller's own row — RLS returns nothing else. `limit(1)`
    // rather than maybeSingle so a missing row is an empty list, not an error.
    db.from('profiles').select('display_name').limit(1),
  ]);

  if (profile.error) warn('name', profile.error);
  const displayName = profile.error
    ? null
    : ((profile.data?.[0] as { display_name: string | null } | undefined)?.display_name ?? null);

  const statsById = new Map(dashboard.setStats.map((s) => [s.setId, s]));

  return {
    ...EMPTY_SNAPSHOT,
    name: greetingName(displayName),
    streak: dashboard.streak,
    studiedToday: dashboard.studiedToday,
    dueToday: dashboard.dueToday,
    toRetry: dashboard.toRetry,
    totalAnswers: dashboard.totalAttempts,
    sets: sets.map((s) => {
      const stat = statsById.get(s.id);
      return {
        id: s.id,
        title: formatSetTitle(s.title),
        cards: s.cardCount ?? 0,
        due: stat?.due ?? 0,
        missed: stat?.missed ?? 0,
        known: stat?.known ?? 0,
      };
    }),
  };
}

function warn(what: string, err: unknown): void {
  const message = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err);
  // Loud, not silent: "Nomi knows nothing about you" must never look like a
  // new account when it is really a failed read.
  console.warn(`[nomi] could not read ${what}: ${message}`);
}
