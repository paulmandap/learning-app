import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { fetchDashboard } from '../src/data/dashboard';
import { recordAttempt } from '../src/data/attempts';
import { dueCountsBySet } from '../src/data/review';
import type { Db } from '../src/data/supabase';
import { startOfUtcDay } from '../src/core/schedule';

/**
 * The data layer, driven with no network (Phase B).
 *
 * ## Why these exist
 *
 * Until now nothing under `src/data/**` had a single test. 447 of them covered
 * `src/core` and `src/ai`, and the reason this directory was excluded was
 * convention rather than any technical barrier — it imports no react-native.
 * The cost was concrete: a dashboard button whose every branch navigated to the
 * wrong place shipped, and stayed shipped, because no test could reach the
 * function that built it.
 *
 * ## Why a real client over a stubbed fetch, not a mock builder
 *
 * `createClient(url, key, { global: { fetch } })` routes PostgREST, Auth, RPC
 * and Storage through one injected fetch — the same `fetchImpl` seam
 * `GeminiBrowserProvider` uses. So these tests exercise the REAL query builder
 * and can assert on the URL it produces.
 *
 * That is the whole point rather than a nicety. `dueCountsBySet` filters on an
 * embedded relationship, and NOTES §21.1 records that an embedded filter which
 * fails to resolve returns ROWS RATHER THAN AN ERROR — a silently wrong answer
 * that looks like a working screen. A hand-written builder mock would agree
 * with whatever the code asked it for. A URL assertion catches it.
 */

/** One request the data layer made, as the stub saw it. */
interface Call {
  method: string;
  /** `review_state`, `rpc/touch_study_day`, `auth/user`. */
  target: string;
  /** Decoded query string, so a test can read the filters as PostgREST got them. */
  query: string;
  body: unknown;
}

/** A canned reply: rows, or the error PostgREST would return. */
type Reply = { rows: unknown[] } | { error: { message: string; code?: string; status?: number } };

/** Rows coming back from a query. */
const rows = (...r: unknown[]): Reply => ({ rows: r });

/** A query that fails. `code` is what `error.code` becomes on the client. */
const fails = (message: string, code?: string): Reply => ({ error: { message, code } });

/**
 * A Supabase client that answers from a script instead of a database.
 *
 * `replies` is keyed by target, and each value is a QUEUE whose last entry
 * repeats for ever — the same shape as `scripted` in gemini-provider.test.ts,
 * and for the same reason: it lets a one-element script drive any number of
 * calls while a two-element one describes "fails, then succeeds".
 *
 * A target nobody declared answers with no rows, so a test only has to say what
 * it cares about. Every request is recorded in `calls` regardless, which is
 * what makes "and nothing else was asked for" testable.
 */
function fakeDb(
  replies: Record<string, Reply[]> = {},
  options: { userId?: string } = {},
): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const cursors = new Map<string, number>();

  const next = (target: string): Reply => {
    const script = replies[target];
    if (!script || script.length === 0) return { rows: [] };
    const i = cursors.get(target) ?? 0;
    cursors.set(target, i + 1);
    return script[Math.min(i, script.length - 1)]!;
  };

  const fetchImpl = (async (input: Request | string, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw);
    const method = init?.method ?? (typeof input === 'string' ? 'GET' : input.method) ?? 'GET';

    let target: string;
    if (url.pathname.startsWith('/auth/v1/')) target = `auth/${url.pathname.split('/auth/v1/')[1]}`;
    else target = url.pathname.split('/rest/v1/')[1] ?? url.pathname;

    const bodyText = typeof init?.body === 'string' ? init.body : undefined;
    calls.push({
      method,
      target,
      query: decodeURIComponent(url.search.replace(/^\?/, '')),
      body: bodyText ? JSON.parse(bodyText) : undefined,
    });

    // The one endpoint with a fixed shape: every currentUserId() goes here.
    if (target === 'auth/user') {
      return new Response(JSON.stringify({ id: options.userId ?? 'user-a' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    const reply = next(target);
    if ('error' in reply) {
      return new Response(JSON.stringify(reply.error), {
        status: reply.error.status ?? 400,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(reply.rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  /**
   * A signed-in session, in storage, so `auth.getUser()` resolves offline.
   *
   * `expires_at` is load-bearing and its absence is not obvious: auth-js
   * computes that field itself when it saves a session, and discards a
   * recovered one without it as "Auth session missing!". That is the same
   * omission that had been quietly breaking scripts/screenshot.ts.
   */
  const session = JSON.stringify({
    access_token: 'stub.jwt',
    refresh_token: 'stub.refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: options.userId ?? 'user-a' },
  });
  const store = new Map<string, string>([['sb-stub-auth-token', session]]);

  const db = createClient('https://stub.supabase.co', 'sb_publishable_stub', {
    auth: {
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'sb-stub-auth-token',
      storage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    },
    global: { fetch: fetchImpl },
  }) as Db;

  return { db, calls };
}

/** A fixed UTC noon, so nothing here depends on when the tests run. */
const NOON = Date.UTC(2026, 8, 11, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('dueCountsBySet', () => {
  it('asks the database for only the cards it could actually deal', async () => {
    // The defect this pins: a reported card keeps its review_state row, so an
    // unfiltered count promised work every deck would then refuse to hand over.
    // The fix is an embedded inner join, and NOTES §21.1 records why it has to
    // be asserted rather than assumed — an embedded filter that fails to
    // resolve its relationship returns ROWS, not an error. It cannot be caught
    // by looking at the result.
    const { db, calls } = fakeDb();
    await dueCountsBySet(NOON, db);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('review_state');
    expect(calls[0]!.query).toContain('study_items!inner(hidden)');
    expect(calls[0]!.query).toContain('study_items.hidden=eq.false');
  });

  it('asks for cards due up to the START of today, not the current moment', async () => {
    // Due dates sit on UTC day boundaries so "due today" has one answer all
    // day. Comparing against `now` would make a card appear mid-morning.
    const { db, calls } = fakeDb();
    await dueCountsBySet(NOON, db);
    expect(calls[0]!.query).toContain(`due_at=lte.${iso(startOfUtcDay(NOON))}`);
  });

  it('counts per set', async () => {
    const { db } = fakeDb({
      review_state: [
        rows(
          { study_set_id: 'a' },
          { study_set_id: 'b' },
          { study_set_id: 'a' },
          { study_set_id: 'a' },
        ),
      ],
    });
    const counts = await dueCountsBySet(NOON, db);
    expect(counts.get('a')).toBe(3);
    expect(counts.get('b')).toBe(1);
  });

  it('degrades to no counts rather than throwing', async () => {
    // review.ts degrades on purpose: a home screen that will not load is worse
    // than a missing badge. The trade is that an outage looks like "nothing
    // due", which is why the warning below is not optional.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = fakeDb({ review_state: [fails('relation does not exist')] });

    const counts = await dueCountsBySet(NOON, db);

    expect(counts.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('fetchDashboard', () => {
  /** A dashboard with one overdue, once-missed card in set `s1`. */
  const oneMissedCard = {
    study_days: [rows({ day: '2026-09-11', answers: 4 })],
    review_state: [
      rows({
        study_item_id: 'i1',
        study_set_id: 's1',
        reps: 0,
        interval_days: 1,
        lapses: 2,
        due_at: iso(NOON - DAY),
      }),
    ],
    item_stats: [
      rows({
        study_item_id: 'i1',
        study_set_id: 's1',
        attempts: 4,
        misses: 3,
        partials: 0,
        last_result: 'incorrect',
      }),
    ],
    study_items: [rows({ id: 'i1', section_title: 'Renal physiology' })],
    documents: [rows({ byte_size: 1024 })],
  };

  it('answers the whole screen in one round of queries, and names them', async () => {
    // The screen is one batch by design. The guard is not the NUMBER — it went
    // from five to six in Phase C when section trends arrived, deliberately —
    // it is that the set is fixed and flat. A per-set or per-card lookup would
    // show up here as a table appearing twice, which is how a dashboard starts
    // costing a request per row.
    const { db, calls } = fakeDb(oneMissedCard);
    await fetchDashboard(NOON, db);

    expect(calls.map((c) => c.target).sort()).toEqual([
      'attempts',
      'documents',
      'item_stats',
      'review_state',
      'study_days',
      'study_items',
    ]);
  });

  it('bounds the one query that reads a table growing without limit', async () => {
    // attempts is the fastest-growing table in the app and the trend query is
    // the only read on this screen that touches it. Unbounded, it would get
    // slower every week a student used the app — and silently, because a
    // dashboard that degrades to empty looks the same as one with no history.
    const { db, calls } = fakeDb(oneMissedCard);
    await fetchDashboard(NOON, db);

    const trend = calls.find((c) => c.target === 'attempts');
    expect(trend, 'the trend query is gone').toBeDefined();
    expect(trend!.query).toContain('limit=');
    expect(trend!.query).toContain('created_at=gte.');
    // Newest first, so a cap that does bite keeps recent history rather than an
    // arbitrary slice.
    expect(trend!.query).toContain('order=created_at.desc');
  });

  it('points the retry button at the set the missed cards are in', async () => {
    // Phase A's fix, end to end. busiestSet is unit-tested on its own; this is
    // the part that was actually broken — the id never reaching the screen.
    const { db } = fakeDb(oneMissedCard);
    const data = await fetchDashboard(NOON, db);

    expect(data.toRetry).toBe(1);
    expect(data.retryTarget).toBe('s1');
    expect(data.dueToday).toBe(1);
    expect(data.dueTarget).toBe('s1');
  });

  it('does not count a reported card as work waiting', async () => {
    // A stat row outlives the card it describes. study_items is the list of
    // cards that can still be dealt, so anything missing from it is gone — and
    // both the count and the destination have to agree with that, or the button
    // opens a deck with nothing in it.
    const { db } = fakeDb({ ...oneMissedCard, study_items: [rows()] });
    const data = await fetchDashboard(NOON, db);

    expect(data.toRetry).toBe(0);
    expect(data.retryTarget).toBeNull();
    expect(data.dueToday).toBe(0);
    expect(data.dueTarget).toBeNull();
  });

  it('survives one query failing, and says so', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = fakeDb({ ...oneMissedCard, item_stats: [fails('item_stats exploded')] });

    const data = await fetchDashboard(NOON, db);

    // The failed section is empty; the rest of the screen still renders.
    expect(data.sections).toEqual({ strong: [], weak: [], tooEarly: 0 });
    expect(data.toRetry).toBe(0);
    expect(data.streak).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('item_stats'));
    warn.mockRestore();
  });

  it('falls back to attempts when study_days is not there yet', async () => {
    // study_days needs migration 0009. Telling someone with months of history
    // that they have never studied is a worse failure than the slower query.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, calls } = fakeDb({
      ...oneMissedCard,
      study_days: [fails('relation "study_days" does not exist', '42P01')],
      attempts: [rows({ created_at: iso(NOON) }, { created_at: iso(NOON - DAY) })],
    });

    const data = await fetchDashboard(NOON, db);

    expect(calls.map((c) => c.target)).toContain('attempts');
    expect(data.totalAttempts).toBe(2);
    expect(data.streak).toBe(2);
    warn.mockRestore();
  });

  it('turns a section that has turned around into a direction', async () => {
    // End to end: rows out of `attempts`, joined to their section through the
    // study_items query, ordered by their timestamps, gated, and labelled.
    // sectionTrends is unit-tested on its own; this is the wiring.
    const answers = Array.from({ length: 20 }, (_, i) => ({
      study_item_id: 'i1',
      // Oldest ten wrong, newest ten right. PostgREST returns newest first.
      result: i < 10 ? 'correct' : 'incorrect',
      created_at: iso(NOON - i * 60_000),
    }));

    const { db } = fakeDb({ ...oneMissedCard, attempts: [rows(...answers)] });
    const data = await fetchDashboard(NOON, db);

    expect(data.trends).toHaveLength(1);
    expect(data.trends[0]).toMatchObject({
      section: 'Renal physiology',
      direction: 'improving',
    });
  });

  it('says nothing about a section without enough recent history', async () => {
    // Silence is the designed answer below twenty answers, not an empty list
    // meaning "steady". A trend claimed on six answers is noise 38% of the time
    // — see the measurement in tests/trend.test.ts.
    const answers = Array.from({ length: 8 }, (_, i) => ({
      study_item_id: 'i1',
      result: i < 4 ? 'correct' : 'incorrect',
      created_at: iso(NOON - i * 60_000),
    }));

    const { db } = fakeDb({ ...oneMissedCard, attempts: [rows(...answers)] });
    expect((await fetchDashboard(NOON, db)).trends).toEqual([]);
  });

  it('does not let a reported card steer the direction', async () => {
    // Its answers survive in `attempts` but the card is gone from study_items,
    // so it resolves to no section and drops out — the same rule the counts
    // above follow.
    const answers = Array.from({ length: 20 }, (_, i) => ({
      study_item_id: 'reported-card',
      result: i < 10 ? 'correct' : 'incorrect',
      created_at: iso(NOON - i * 60_000),
    }));

    const { db } = fakeDb({ ...oneMissedCard, attempts: [rows(...answers)] });
    expect((await fetchDashboard(NOON, db)).trends).toEqual([]);
  });

  it('keeps the screen up when only the trend query fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = fakeDb({ ...oneMissedCard, attempts: [fails('attempts exploded')] });

    const data = await fetchDashboard(NOON, db);

    expect(data.trends).toEqual([]);
    expect(data.dueToday).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('attempts'));
    warn.mockRestore();
  });

  it('never hands out the shared empty constant to be mutated', async () => {
    // EMPTY_DASHBOARD is an exported mutable object and the error paths used to
    // return its sub-objects BY REFERENCE. One caller sorting a forecast in
    // place would have corrupted every later degraded dashboard in the process.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = { study_items: [fails('boom')], review_state: [fails('boom')] };

    const first = await fetchDashboard(NOON, fakeDb(broken).db);
    first.mastery.known = 999;
    first.forecast.push({ dayStart: 0, due: 999 });

    const second = await fetchDashboard(NOON, fakeDb(broken).db);
    expect(second.mastery.known).toBe(0);
    expect(second.forecast).toEqual([]);
    warn.mockRestore();
  });
});

describe('recordAttempt', () => {
  const answer = {
    studyItemId: 'i1',
    studySetId: 's1',
    mode: 'quiz' as const,
    result: 'correct' as const,
  };

  it('writes the answer first, then the day, then the schedule', async () => {
    // The order is load-bearing and documented: the attempt row is the record
    // of truth that the missed pile and every schedule are built from, so it
    // lands before anything that could fail.
    const { db, calls } = fakeDb();
    await recordAttempt(answer, db);

    expect(calls.map((c) => `${c.method} ${c.target}`)).toEqual([
      'GET auth/user',
      'POST attempts',
      'POST rpc/touch_study_day',
      'GET review_state',
      'POST review_state',
    ]);
  });

  it('records the grade and the answer text on the row', async () => {
    const { db, calls } = fakeDb();
    await recordAttempt(
      { ...answer, result: 'partial', score: 2, maxScore: 3, answerText: 'the SA node' },
      db,
    );

    const insert = calls.find((c) => c.method === 'POST' && c.target === 'attempts');
    expect(insert!.body).toMatchObject({
      user_id: 'user-a',
      study_item_id: 'i1',
      study_set_id: 's1',
      mode: 'quiz',
      result: 'partial',
      score: 2,
      max_score: 3,
      answer_text: 'the SA node',
    });
  });

  it("re-records as 'flashcards' when the database has never heard of 'blanks'", async () => {
    // Migration 0006 added the mode. Against a project without it the honest
    // choice is between losing the answer and recording it under the closest
    // older mode, and losing it is worse.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, calls } = fakeDb({
      attempts: [fails('violates check constraint "attempts_mode_check"', '23514'), rows()],
    });

    await recordAttempt({ ...answer, mode: 'blanks' }, db);

    const inserts = calls.filter((c) => c.method === 'POST' && c.target === 'attempts');
    expect(inserts).toHaveLength(2);
    expect((inserts[0]!.body as { mode: string }).mode).toBe('blanks');
    expect((inserts[1]!.body as { mode: string }).mode).toBe('flashcards');
    // Loud, so a mislabelled row is never a mystery.
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('throws when the answer itself cannot be written', async () => {
    // The one thing here that must NOT degrade quietly. Everything downstream
    // is rebuildable; a lost answer is not.
    const { db } = fakeDb({ attempts: [fails('permission denied')] });
    await expect(recordAttempt(answer, db)).rejects.toThrow(/permission denied/);
  });

  it('keeps the answer when the schedule cannot be written', async () => {
    // review_state needs migration 0005, and a scheduling failure is not worth
    // losing an answer over. Verified live in §7.3 with the table absent.
    const { db, calls } = fakeDb({ review_state: [fails('relation does not exist', '42P01')] });

    await expect(recordAttempt(answer, db)).resolves.toBeUndefined();
    expect(calls.some((c) => c.method === 'POST' && c.target === 'attempts')).toBe(true);
  });

  it('does not reach for the model when no key was passed', async () => {
    // The rephrase pass is fire-and-forget and makes a live Gemini call. It is
    // gated on an apiKey the screen may not have, which is also what keeps it
    // out of these tests — a floating promise would leak into the next one.
    const { db, calls } = fakeDb({
      review_state: [
        rows({
          study_item_id: 'i1',
          study_set_id: 's1',
          due_at: iso(NOON),
          interval_days: 1,
          ease: '2.5',
          reps: 0,
          lapses: 9,
          last_result: 'incorrect',
        }),
        rows(),
      ],
    });

    await recordAttempt({ ...answer, result: 'incorrect' }, db);

    expect(calls.every((c) => c.target !== 'study_items')).toBe(true);
  });
});
