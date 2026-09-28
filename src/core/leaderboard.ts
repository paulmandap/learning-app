/**
 * The friends' leaderboard — the parts decidable without a database or a screen
 * (NOTES §54, migration 0029).
 *
 * The owner chose the measure: **longest streak**, shown as the streak running
 * now with the best ever beside it. Ranked by the one running now, because that
 * is the one anybody can still do something about today.
 */

/** A row of `friends_leaderboard()` (0029). */
export interface LeaderboardRow {
  person_id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  current_streak: number;
  best_streak: number;
  is_me: boolean;
}

export interface RankedRow extends LeaderboardRow {
  /**
   * 1-based. Equal streaks share a rank, and the next one skips. Null for no
   * streak at all: two friends on nothing were both "1" on the first photograph
   * of this board (NOTES §54.5), and a rank for nothing reads as a win. The Top
   * sets rule — a set with no stars is unrated, not last.
   */
  rank: number | null;
}

/**
 * Most days in a row first.
 *
 * ## Ties share a rank
 *
 * Two friends on 12 days are both second — the same rule as the Top sets
 * ranking (`rankSets`), for the same reason: breaking a tie for display would
 * print one of them as third and invite the question of why.
 *
 * ## The order within a tie is for ORDER only
 *
 * The better best streak first, then the name, then the id — so the list does
 * not shuffle on every refresh. Plain `<` rather than localeCompare, which sorts
 * differently depending on where it runs.
 */
export function rankLeaderboard(rows: readonly LeaderboardRow[]): RankedRow[] {
  const nameOf = (r: LeaderboardRow) => (r.name ?? r.username ?? '').toLowerCase();
  const sorted = rows.slice().sort((a, b) => {
    if (a.current_streak !== b.current_streak) return b.current_streak - a.current_streak;
    if (a.best_streak !== b.best_streak) return b.best_streak - a.best_streak;
    const an = nameOf(a);
    const bn = nameOf(b);
    if (an !== bn) return an < bn ? -1 : 1;
    return a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0;
  });

  const out: RankedRow[] = [];
  let lastStreak = Number.NaN;
  let lastRank = 0;
  sorted.forEach((row, i) => {
    if (row.current_streak <= 0) {
      out.push({ ...row, rank: null });
      return;
    }
    if (row.current_streak !== lastStreak) {
      lastRank = i + 1;
      lastStreak = row.current_streak;
    }
    out.push({ ...row, rank: lastRank });
  });
  return out;
}

/** "12 days" / "1 day" / "No streak". */
export function streakDays(days: number): string {
  if (days <= 0) return 'No streak';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** "Best 30" — only when it says something the current streak does not. */
export function bestLabel(row: Pick<LeaderboardRow, 'current_streak' | 'best_streak'>): string | null {
  if (row.best_streak <= 0 || row.best_streak <= row.current_streak) return null;
  return `Best ${row.best_streak}`;
}

/**
 * A board with only you on it is not a board: what to say instead, and where
 * to go. True when there is nobody else to compare with.
 */
export function aloneOnBoard(rows: readonly LeaderboardRow[]): boolean {
  return rows.every((r) => r.is_me);
}
