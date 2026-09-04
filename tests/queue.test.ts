import { describe, expect, it } from 'vitest';
import {
  BACKOFF_MS,
  backoffDelay,
  CallQueue,
  GeminiBusyError,
  MIN_GAP_MS,
  parseRetryAfter,
  RateLimitedError,
} from '../src/core/queue';

/** Virtual clock: no real waiting, exact assertions about pacing. */
function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get sleeps() {
      return sleeps;
    },
    get time() {
      return now;
    },
  };
}

describe('backoffDelay', () => {
  it('follows the 10/20/40 ladder when Retry-After is unreadable', () => {
    expect(backoffDelay(1, null)).toBe(10_000);
    expect(backoffDelay(2, null)).toBe(20_000);
    expect(backoffDelay(3, null)).toBe(40_000);
  });

  it('clamps past the end of the ladder', () => {
    expect(backoffDelay(9, null)).toBe(BACKOFF_MS[BACKOFF_MS.length - 1]);
  });

  it('honours a longer Retry-After', () => {
    expect(backoffDelay(1, 30_000)).toBe(30_000);
  });

  it('never waits LESS than the ladder, even if the server says to hurry', () => {
    // A too-eager retry is what turns one 429 into a run of them.
    expect(backoffDelay(2, 1_000)).toBe(20_000);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('30')).toBe(30_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('reads an HTTP date', () => {
    const future = new Date(Date.now() + 20_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(10_000);
  });

  it('returns null for absent or junk values — the browser case', () => {
    // The Phase 0 probe showed Retry-After is not exposed to browser JS, so
    // null is the normal path in production, not an edge case.
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

describe('CallQueue pacing', () => {
  // Pacing is asserted on q.startTimes, the moment each slot was ACQUIRED.
  // Timing inside a task body is not equivalent: the body runs a microtask
  // later, by which point another acquirer's virtual sleep may have moved the
  // clock. Measuring the body would test the harness, not the queue.
  it('enforces the ~7s minimum gap between call starts', async () => {
    const clock = fakeClock();
    const q = new CallQueue({ now: clock.now, sleep: clock.sleep, concurrency: 1 });

    for (const _ of [0, 1, 2]) {
      await q.run(async () => undefined);
    }

    expect(q.startTimes).toHaveLength(3);
    expect(q.startTimes[0]).toBe(0); // the first call waits for nothing
    expect(q.startTimes[1]! - q.startTimes[0]!).toBeGreaterThanOrEqual(MIN_GAP_MS);
    expect(q.startTimes[2]! - q.startTimes[1]!).toBeGreaterThanOrEqual(MIN_GAP_MS);
  });

  it('does not collapse the gap under concurrency 2', async () => {
    // The bug this guards: two callers both read the same lastStart, both
    // conclude the gap elapsed, and start together — a "7 second gap" that is
    // silently no gap at all.
    const clock = fakeClock();
    const q = new CallQueue({ now: clock.now, sleep: clock.sleep, concurrency: 2 });

    await Promise.all([0, 1, 2, 3].map(() => q.run(async () => undefined)));

    expect(q.startTimes).toHaveLength(4);
    for (let i = 1; i < q.startTimes.length; i++) {
      expect(q.startTimes[i]! - q.startTimes[i - 1]!).toBeGreaterThanOrEqual(MIN_GAP_MS);
    }
  });

  it('returns the task result', async () => {
    const clock = fakeClock();
    const q = new CallQueue({ now: clock.now, sleep: clock.sleep });
    await expect(q.run(async () => 'done')).resolves.toBe('done');
  });
});

describe('CallQueue retries', () => {
  it('retries a rate limit and succeeds', async () => {
    const clock = fakeClock();
    const q = new CallQueue({ now: clock.now, sleep: clock.sleep });
    let attempts = 0;

    const result = await q.run(async () => {
      attempts++;
      if (attempts < 3) throw new RateLimitedError(null);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(clock.sleeps).toContain(10_000);
    expect(clock.sleeps).toContain(20_000);
  });

  it('gives up after 3 attempts with the friendly message', async () => {
    const clock = fakeClock();
    const q = new CallQueue({ now: clock.now, sleep: clock.sleep });
    let attempts = 0;

    await expect(
      q.run(async () => {
        attempts++;
        throw new RateLimitedError(null);
      }),
    ).rejects.toBeInstanceOf(GeminiBusyError);

    expect(attempts).toBe(3);
    await expect(
      new CallQueue({ now: clock.now, sleep: clock.sleep }).run(async () => {
        throw new RateLimitedError(null);
      }),
    ).rejects.toThrow('Gemini is busy right now — try again in a minute.');
  });

  it('does not retry a non-rate-limit error', async () => {
    const clock = fakeClock();
    const q = new CallQueue({ now: clock.now, sleep: clock.sleep });
    let attempts = 0;

    await expect(
      q.run(async () => {
        attempts++;
        throw new Error('bad request');
      }),
    ).rejects.toThrow('bad request');

    expect(attempts).toBe(1);
  });

  it('one failing task does not lose the others', async () => {
    // Generation state is per section, so a failure must not take the batch.
    const clock = fakeClock();
    const q = new CallQueue({ now: clock.now, sleep: clock.sleep });

    const results = await Promise.allSettled([
      q.run(async () => 'a'),
      q.run(async () => {
        throw new Error('section b failed');
      }),
      q.run(async () => 'c'),
    ]);

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });
});
