import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MONTHLY_STREAK_RESTORES,
  RESTORE_WINDOW_HOURS,
  restorableStreak,
  restoresLeftThisMonth,
  studyStreak,
  utcDayString,
} from '../src/core/progress';

/**
 * Bringing a broken streak back (NOTES §47).
 *
 * The owner: *"i just broke my streak. implement just like tiktok, having the
 * restore streak button. maximum of 5 restore every month, 48 hours between
 * each restore before it expires to start from 0 again."*
 */

const DAY = 24 * 60 * 60 * 1000;
/** A fixed UTC midnight, so nothing here depends on when the tests run. */
const D0 = Date.UTC(2026, 8, 1);
const day = (n: number) => D0 + n * DAY;
/** Mid-afternoon on day n — a real answer is never at midnight exactly. */
const at = (n: number) => day(n) + 15 * 60 * 60 * 1000;

describe('a streak that has not broken', () => {
  it('counts consecutive days', () => {
    expect(studyStreak([at(1), at(2), at(3)], at(3))).toBe(3);
  });

  it('survives a today nobody has studied yet', () => {
    // The existing kindness at the edge: you have not missed today until it is
    // over. Restores must not change this.
    expect(studyStreak([at(1), at(2)], at(3))).toBe(2);
  });

  it('is offered no restore, because there is nothing to restore', () => {
    expect(restorableStreak([at(1), at(2)], at(3))).toBeNull();
  });
});

describe('a streak that has broken', () => {
  // Studied days 1-10, missed day 11, and it is now day 12.
  const studied = [at(8), at(9), at(10)];

  it('reads as zero', () => {
    expect(studyStreak(studied, at(12))).toBe(0);
  });

  it('can be restored on the day the break shows', () => {
    const offer = restorableStreak(studied, at(12));
    expect(offer).not.toBeNull();
    expect(offer!.missedDay).toBe(day(11));
    expect(offer!.expiresAt).toBe(day(11) + RESTORE_WINDOW_HOURS * 60 * 60 * 1000);
    // Three days studied plus the day forgiven.
    expect(offer!.streak).toBe(4);
  });

  it('comes back to the number the offer promised', () => {
    const offer = restorableStreak(studied, at(12))!;
    expect(studyStreak(studied, at(12), [offer.missedDay])).toBe(offer.streak);
  });

  it('lapses once the 48 hours are up', () => {
    // Day 13 is 48h after the start of day 11.
    expect(restorableStreak(studied, day(13))).toBeNull();
    expect(restorableStreak(studied, at(13))).toBeNull();
    // And right up to the edge it is still there.
    expect(restorableStreak(studied, day(13) - 1)).not.toBeNull();
  });

  it('refuses a gap of more than one day', () => {
    // Two clear days is a stop, not a lapse. Forgiving only the more recent one
    // would spend a restore and leave the same broken streak on screen.
    expect(restorableStreak([at(8), at(9)], at(12))).toBeNull();
  });

  it('refuses when nothing was ever studied', () => {
    expect(restorableStreak([], at(12))).toBeNull();
  });
});

describe('a streak already held together by a restore', () => {
  const studied = [at(8), at(9), at(10)];

  it('counts the forgiven day as part of the run', () => {
    expect(studyStreak([...studied, at(12)], at(12), [day(11)])).toBe(5);
  });

  it('offers nothing more while it is alive', () => {
    expect(restorableStreak([...studied, at(12)], at(12), [day(11)])).toBeNull();
  });

  it('can be restored again after a second lapse, if there is one to spend', () => {
    // Studied 8, 9, 10; day 11 forgiven; studied 12; missed 13; now day 14.
    const offer = restorableStreak([...studied, at(12)], at(14), [day(11)]);
    expect(offer).not.toBeNull();
    expect(offer!.missedDay).toBe(day(13));
    expect(offer!.streak).toBe(6);
  });
});

describe('the monthly allowance', () => {
  it('is five', () => {
    expect(MONTHLY_STREAK_RESTORES).toBe(5);
  });

  it('matches what the database will actually enforce', () => {
    // The function is the authority; this constant only lets a screen say how
    // many are left before a round trip. `tests/community.test.ts` holds the
    // chat limits the same way.
    const sql = readFileSync(
      'supabase/migrations/0024_folders_unsend_and_streak_restores.sql',
      'utf8',
    );
    expect(sql).toMatch(
      new RegExp(`streak_restore_limit\\(\\)[\\s\\S]{0,120}select ${MONTHLY_STREAK_RESTORES}`),
    );
  });

  it('counts only this calendar month', () => {
    const now = Date.UTC(2026, 8, 20);
    const used = [Date.UTC(2026, 8, 3), Date.UTC(2026, 8, 9), Date.UTC(2026, 7, 28)];
    // Two in September; August's does not count against it.
    expect(restoresLeftThisMonth(used, now)).toBe(3);
  });

  it('never goes below zero', () => {
    const now = Date.UTC(2026, 8, 20);
    const used = Array.from({ length: 9 }, (_, i) => Date.UTC(2026, 8, i + 1));
    expect(restoresLeftThisMonth(used, now)).toBe(0);
  });
});

describe('the day a restore is claimed for', () => {
  it('is the plain UTC date the database stores', () => {
    expect(utcDayString(day(11))).toBe('2026-09-12');
    expect(utcDayString(Date.UTC(2026, 0, 1))).toBe('2026-01-01');
  });
});
