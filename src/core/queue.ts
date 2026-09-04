/**
 * Rate limiting (spec §3.2.6). Deterministic, injectable clock, testable.
 *
 * Free-tier Gemini limits are PER GOOGLE PROJECT, not per key, and Google no
 * longer publishes the numbers. So this never encodes a quota: it enforces a
 * conservative floor (concurrency 2, ~7s between call starts), and otherwise
 * reacts to what the API actually says.
 *
 * Backoff is 10/20/40s. `Retry-After` is honoured when readable — but the
 * Phase 0 probe showed the browser is NOT given that header (it is absent from
 * Access-Control-Expose-Headers), so the fixed ladder is the real mechanism and
 * has to be correct on its own.
 */

/** Minimum gap between the starts of two calls. */
export const MIN_GAP_MS = 7_000;

/** Simultaneous in-flight calls. */
export const CONCURRENCY = 2;

/** Backoff ladder, used when Retry-After is unavailable (i.e. in the browser). */
export const BACKOFF_MS = [10_000, 20_000, 40_000] as const;

/** Attempts per task before giving up. */
export const MAX_ATTEMPTS = 3;

export class RateLimitedError extends Error {
  constructor(public readonly retryAfterMs: number | null) {
    super('rate limited');
    this.name = 'RateLimitedError';
  }
}

/** Thrown after MAX_ATTEMPTS failures. The message is the user-facing one. */
export class GeminiBusyError extends Error {
  constructor() {
    super('Gemini is busy right now — try again in a minute.');
    this.name = 'GeminiBusyError';
  }
}

export interface QueueOptions {
  concurrency?: number;
  minGapMs?: number;
  maxAttempts?: number;
  /** Injectable for tests: default uses real time. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Compute the delay before attempt N+1 after a rate-limit response.
 *
 * @param attempt      1-based attempt number that just failed.
 * @param retryAfterMs From the header, or null when unreadable.
 */
export function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  const ladder = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length) - 1] ?? BACKOFF_MS[0];
  // Trust the server when it tells us, but never wait less than the ladder:
  // a too-eager retry is what turns one 429 into a run of them.
  if (retryAfterMs !== null && retryAfterMs > 0) return Math.max(retryAfterMs, ladder);
  return ladder;
}

/**
 * Single queue shared by every Gemini call in the app.
 *
 * Tasks are started in submission order, at most `concurrency` at a time, with
 * at least `minGapMs` between starts. Because generation state is per section,
 * a task that ultimately fails does not lose the sections that succeeded.
 */
export class CallQueue {
  readonly #concurrency: number;
  readonly #minGapMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  #active = 0;
  /** Virtual time of the last call start; null until the first call. */
  #lastStart: number | null = null;

  /**
   * Timestamp of every call start, in order.
   *
   * Not diagnostics-for-its-own-sake: spec §6 requires reporting the measured
   * wall clock and the exact bottleneck for the Phase 2 two-minute target, and
   * separating "waiting on the rate limiter" from "waiting on Gemini" needs
   * these. Also the only sound way to assert pacing in a test, since a task
   * body runs a microtask after its slot is acquired.
   */
  readonly startTimes: number[] = [];
  /** Reservation mutex: each acquirer waits for the previous one to finish reserving. */
  #lock: Promise<void> = Promise.resolve();

  constructor(options: QueueOptions = {}) {
    this.#concurrency = options.concurrency ?? CONCURRENCY;
    this.#minGapMs = options.minGapMs ?? MIN_GAP_MS;
    this.#maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
    this.#now = options.now ?? (() => Date.now());
    this.#sleep =
      options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Run `task`, retrying rate-limit failures with backoff.
   *
   * A task should throw RateLimitedError for a 429; anything else is treated as
   * a real failure and surfaces immediately rather than burning retries.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquireSlot();
    try {
      let lastRateLimit: RateLimitedError | null = null;

      for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
        try {
          return await task();
        } catch (err) {
          if (!(err instanceof RateLimitedError)) throw err;
          lastRateLimit = err;
          if (attempt === this.#maxAttempts) break;
          await this.#sleep(backoffDelay(attempt, err.retryAfterMs));
        }
      }

      void lastRateLimit;
      throw new GeminiBusyError();
    } finally {
      this.#active--;
    }
  }

  /** Map over inputs with the queue's concurrency and pacing. */
  async all<T, R>(inputs: T[], task: (input: T, index: number) => Promise<R>): Promise<R[]> {
    return Promise.all(inputs.map((input, i) => this.run(() => task(input, i))));
  }

  /**
   * Wait for a free slot AND for the minimum gap since the last start.
   *
   * Reservation is serialised behind an explicit mutex. Without it two callers
   * both read the same #lastStart, both conclude the gap has elapsed, and start
   * together — which silently turns a "7 second gap" into no gap at all. That
   * is the exact bug tests/queue.test.ts pins down, so it is worth the lock.
   */
  async #acquireSlot(): Promise<void> {
    // Take the lock: wait for the previous reservation, and install our own
    // barrier that the next caller will wait on.
    const previous = this.#lock;
    let release!: () => void;
    this.#lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      // Wait for an in-flight slot to free up.
      while (this.#active >= this.#concurrency) {
        await this.#sleep(10);
      }

      // Wait out the minimum gap. The very first call waits for nothing.
      if (this.#lastStart !== null) {
        const earliest = this.#lastStart + this.#minGapMs;
        const now = this.#now();
        if (now < earliest) await this.#sleep(earliest - now);
      }

      this.#lastStart = this.#now();
      this.startTimes.push(this.#lastStart);
      this.#active++;
    } finally {
      release();
    }
  }
}

/** Parse a Retry-After header. Returns null when absent or unreadable. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;

  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}
