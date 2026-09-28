import { supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import type { LeaderboardRow } from '../core/leaderboard';

/**
 * The friends' leaderboard, and whether I am on it (NOTES §54, migration 0029).
 *
 * One function call: `friends_leaderboard()` computes every streak as its owner,
 * because nobody may read anybody's streak directly — not even their friends',
 * except through this board, and only while that friend shows it.
 */

export class LeaderboardUnavailableError extends Error {
  constructor() {
    super('The leaderboard is not switched on yet.');
    this.name = 'LeaderboardUnavailableError';
  }
}

function unavailable(error: { code?: string | null } | null | undefined): boolean {
  return (
    isMissingTable(error) || isMissingColumn(error) || !!error && (error.code === 'PGRST202' || error.code === '42883')
  );
}

async function currentUserId(db: Db = supabase): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/** Me and my friends who show their streak. Unordered — `rankLeaderboard` decides. */
export async function friendsLeaderboard(db: Db = supabase): Promise<LeaderboardRow[]> {
  const { data, error } = await db.rpc('friends_leaderboard');
  if (unavailable(error)) throw new LeaderboardUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? []) as LeaderboardRow[];
}

/**
 * Do my friends see my streak? True unless I said no — and true before 0029,
 * when there is no board to be on, so Settings never shows a switch that lies.
 *
 * Its own read, not a column in `fetchProfile`, for §51's reason: a missing
 * column there costs every screen that reads the profile a retry.
 */
export async function fetchShowStreak(db: Db = supabase): Promise<boolean | null> {
  const { data, error } = await db.from('profiles').select('show_streak').maybeSingle();
  if (unavailable(error)) return null;
  if (error) throw new Error(error.message);
  return (data as { show_streak?: boolean } | null)?.show_streak ?? true;
}

export async function saveShowStreak(on: boolean, db: Db = supabase): Promise<void> {
  const id = await currentUserId(db);
  const { error } = await db.from('profiles').upsert({ id, show_streak: on }, { onConflict: 'id' });
  if (unavailable(error)) throw new LeaderboardUnavailableError();
  if (error) throw new Error(error.message);
}
