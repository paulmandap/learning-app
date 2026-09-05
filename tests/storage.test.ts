import { describe, expect, it } from 'vitest';
import {
  checkUpload,
  formatBytes,
  MAX_FILE_BYTES,
  MAX_USER_BYTES,
  summariseUsage,
  USAGE_NUDGE_FRACTION,
} from '../src/core/storage';
import { MAX_INLINE_BYTES } from '../src/ai/gemini';

const MB = 1024 * 1024;

describe('the limits themselves', () => {
  it('never accepts a file the reader cannot read', () => {
    // The binding constraint is Gemini's inline request cap, not the bucket.
    // Accepting a 40 MB PDF would spend storage on something readDocument then
    // refuses, failing one step later and less clearly. If the Files API path
    // is ever built, these two move together or this test fails.
    expect(MAX_FILE_BYTES).toBeLessThanOrEqual(MAX_INLINE_BYTES);
  });

  it('leaves the project headroom with five users', () => {
    // Supabase Free gives 1 GB for the whole project. Five users at the limit
    // must not be able to fill it, or the sixth upload fails for someone who
    // did nothing wrong.
    const FREE_PLAN_BYTES = 1024 * MB;
    expect(MAX_USER_BYTES * 5).toBeLessThan(FREE_PLAN_BYTES);
  });
});

describe('checkUpload', () => {
  it('accepts a normal file', () => {
    expect(checkUpload({ fileBytes: 2 * MB, usedBytes: 0 }).ok).toBe(true);
  });

  it('accepts a file exactly at the per-file limit', () => {
    expect(checkUpload({ fileBytes: MAX_FILE_BYTES, usedBytes: 0 }).ok).toBe(true);
  });

  it('refuses a file over the per-file limit', () => {
    const r = checkUpload({ fileBytes: MAX_FILE_BYTES + 1, usedBytes: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('file_too_large');
  });

  it('refuses a file that would overflow the allowance', () => {
    const r = checkUpload({ fileBytes: 10 * MB, usedBytes: MAX_USER_BYTES - 5 * MB });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_enough_room');
  });

  it('accepts a file that exactly fills the allowance', () => {
    expect(checkUpload({ fileBytes: 5 * MB, usedBytes: MAX_USER_BYTES - 5 * MB }).ok).toBe(true);
  });

  it('checks the file size before the allowance', () => {
    // An enormous file on an empty account is "too large", not "no room" —
    // telling someone to free space they already have would send them off to
    // delete things for nothing.
    const r = checkUpload({ fileBytes: 500 * MB, usedBytes: 0 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('file_too_large');
  });

  it('explains itself without jargon or byte counts', () => {
    const r = checkUpload({ fileBytes: 40 * MB, usedBytes: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/MB/);
    // No developer vocabulary on a student's screen.
    for (const word of ['quota', 'bucket', 'bytes', 'storage limit', 'MAX_']) {
      expect(r.message.toLowerCase()).not.toContain(word.toLowerCase());
    }
    // It has to say what to DO, not only what went wrong.
    expect(r.message).toMatch(/splitting|smaller|lower quality/i);
  });

  it('tells someone out of room that their cards survive', () => {
    // The whole point of freeUpSpace. Without this sentence the only obvious
    // way out is deleting a set, which is the thing worth avoiding.
    const r = checkUpload({ fileBytes: 10 * MB, usedBytes: MAX_USER_BYTES - 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/cards and your progress are kept/i);
  });
});

describe('summariseUsage', () => {
  it('stays quiet well below the limit', () => {
    expect(summariseUsage(10 * MB).worthMentioning).toBe(false);
  });

  it('speaks up at the nudge point', () => {
    expect(summariseUsage(MAX_USER_BYTES * USAGE_NUDGE_FRACTION).worthMentioning).toBe(true);
  });

  it('clamps an overshoot rather than reporting more than full', () => {
    // Rows uploaded before byte_size existed count as 0, so a legacy account
    // can be over its allowance. The bar must still render.
    expect(summariseUsage(MAX_USER_BYTES * 3).fraction).toBe(1);
  });

  it('handles an empty account', () => {
    expect(summariseUsage(0)).toEqual({ usedBytes: 0, fraction: 0, worthMentioning: false });
  });
});

describe('formatBytes', () => {
  it('reads the way a person would say it', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(900)).toBe('900 bytes');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * MB)).toBe('1.5 MB');
    expect(formatBytes(9.44 * MB)).toBe('9.4 MB');
  });

  it('drops the decimal once it stops being useful', () => {
    // "23.7 MB" is noise next to "24 MB".
    expect(formatBytes(23.7 * MB)).toBe('24 MB');
    expect(formatBytes(150 * MB)).toBe('150 MB');
  });

  it('never renders a negative size', () => {
    expect(formatBytes(-5)).toBe('0 bytes');
  });
});
