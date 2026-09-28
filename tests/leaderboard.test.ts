import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aloneOnBoard,
  bestLabel,
  rankLeaderboard,
  streakDays,
  type LeaderboardRow,
} from '../src/core/leaderboard';
import { PRIVACY_POLICY } from '../src/core/legal';

/**
 * The friends' leaderboard (NOTES §54, migration 0029).
 *
 * The first time anybody else sees a streak — so the tests that matter most
 * here are the ones that hold WHO sees it to the SQL, and the Privacy Policy's
 * account of it to both.
 */

const SQL = readFileSync('supabase/migrations/0029_friends_leaderboard.sql', 'utf8').replace(/--[^\n]*/g, '');

function fn(name: string): string {
  const start = SQL.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  return SQL.slice(start, SQL.indexOf('$$;', start)).replace(/\s+/g, ' ');
}

function row(over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    person_id: 'p',
    name: 'Maria',
    username: null,
    avatar: null,
    current_streak: 0,
    best_streak: 0,
    is_me: false,
    ...over,
  };
}

describe('ranking', () => {
  it('most days in a row first; equal streaks share a rank and the next skips', () => {
    const ranked = rankLeaderboard([
      row({ person_id: 'a', name: 'Ana', current_streak: 3 }),
      row({ person_id: 'b', name: 'Ben', current_streak: 12 }),
      row({ person_id: 'c', name: 'Cy', current_streak: 12 }),
      row({ person_id: 'd', name: 'Di', current_streak: 0 }),
    ]);
    expect(ranked.map((r) => r.person_id)).toEqual(['b', 'c', 'a', 'd']);
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3, null]);
  });

  it('no streak is no rank — two friends on nothing are not both first (NOTES §54.5)', () => {
    const ranked = rankLeaderboard([
      row({ person_id: 'me', name: 'Me', best_streak: 3, is_me: true }),
      row({ person_id: 'b', name: 'Probe B' }),
    ]);
    expect(ranked.map((r) => r.rank)).toEqual([null, null]);
    expect(ranked.map((r) => r.person_id)).toEqual(['me', 'b']);
  });

  it('within a tie: the better best first, then by name — never reshuffled', () => {
    const rows = [
      row({ person_id: 'x', name: 'Zed', current_streak: 5, best_streak: 5 }),
      row({ person_id: 'y', name: 'Amy', current_streak: 5, best_streak: 5 }),
      row({ person_id: 'z', name: 'Kim', current_streak: 5, best_streak: 20 }),
    ];
    const once = rankLeaderboard(rows).map((r) => r.person_id);
    expect(once).toEqual(['z', 'y', 'x']);
    expect(rankLeaderboard(rows.slice().reverse()).map((r) => r.person_id)).toEqual(once);
  });
});

describe('what a row says', () => {
  it('days, in words', () => {
    expect(streakDays(0)).toBe('No streak');
    expect(streakDays(1)).toBe('1 day');
    expect(streakDays(12)).toBe('12 days');
  });

  it('shows the best only when it says something the current streak does not', () => {
    expect(bestLabel({ current_streak: 3, best_streak: 30 })).toBe('Best 30');
    expect(bestLabel({ current_streak: 30, best_streak: 30 })).toBeNull();
    expect(bestLabel({ current_streak: 0, best_streak: 0 })).toBeNull();
  });

  it('a board with only you on it is not a board', () => {
    expect(aloneOnBoard([row({ is_me: true })])).toBe(true);
    expect(aloneOnBoard([row({ is_me: true }), row({ person_id: 'f' })])).toBe(false);
  });
});

describe('who is on somebody’s board', () => {
  it('the caller always; a friend only while friends, shown, and not across a block', () => {
    const board = fn('friends_leaderboard');
    expect(board).toContain('where p.id = me or (');
    expect(board).toContain('p.show_streak');
    expect(board).toContain("f.status = 'accepted'");
    expect(board).toContain('(b.blocker_id = me and b.blocked_id = p.id) or (b.blocker_id = p.id and b.blocked_id = me)');
    expect(board).toContain("raise exception 'Not signed in.'");
  });

  it('streaks come from the database, and nobody can ask for anybody’s directly', () => {
    const board = fn('friends_leaderboard');
    expect(board).toContain('public.streak_of(p.id)');
    expect(board).toContain('public.best_streak_of(p.id)');
    expect(SQL).toContain('revoke all on function public.best_streak_of(uuid) from public, anon, authenticated');
    expect(SQL).not.toMatch(/grant execute on function public\.(best_streak_of|streak_of)/);
    expect(SQL).toContain('grant execute on function public.friends_leaderboard() to authenticated');
    expect(SQL).toContain('revoke all on function public.friends_leaderboard() from public, anon');
  });

  it('the best streak is the longest run of days studied or forgiven, with at least one studied', () => {
    const best = fn('best_streak_of');
    expect(best).toContain('from public.study_days d');
    expect(best).toContain('from public.streak_restores r');
    expect(best).toContain('day - (row_number() over (order by day))::integer as run');
    expect(best).toContain('having bool_or(studied)');
  });

  it('shown by default, a column with a default so no row is left without an answer', () => {
    expect(SQL).toContain('add column if not exists show_streak boolean not null default true');
  });
});

const privacy = PRIVACY_POLICY.sections.flatMap((s) => s.body.flat()).join('\n');

describe('what the Privacy Policy says is what the board does', () => {
  it('friends see your current and best streak, and how to stop that', () => {
    expect(privacy).toMatch(/Your friends see how many days in a row you have studied, and your best ever, on a leaderboard/);
    expect(privacy).toMatch(/Only friends — not everyone, and nobody across a block/);
    expect(privacy).toMatch(/You can turn this off in Settings \("Show my streak to friends"\)/);
    const settings = readFileSync('app/settings.tsx', 'utf8');
    expect(settings).toContain('accessibilityLabel="Show my streak to friends"');
    expect(settings).toContain('saveShowStreak(on)');
  });

  it('the board itself says friends see your streak, and links to where to change it', () => {
    const board = readFileSync('src/ui/leaderboard.tsx', 'utf8');
    expect(board).toContain('Your friends see your streak here.');
    expect(board).toContain("router.push('/settings')");
  });
});

describe('on screen', () => {
  it('Progress shows the board right after your own streak', () => {
    const progress = readFileSync('app/(tabs)/progress.tsx', 'utf8');
    expect(progress).toMatch(/<Streak data=\{data\} \/>[\s\S]*?<FriendsBoard \/>[\s\S]*?<Mastery data=\{data\} \/>/);
  });

  it('medals are not handed out — the number, like Top sets', () => {
    expect(readFileSync('src/ui/leaderboard.tsx', 'utf8')).not.toMatch(/🥇|🥈|🥉/);
  });
});
