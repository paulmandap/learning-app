import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { getAppSnapshot } from '../src/data/nomi';
import { formatSetTitle } from '../src/core/title';
import type { Db } from '../src/data/supabase';

/**
 * What Nomi knows about the student, driven with no network.
 *
 * The owner's report was that Nomi could not say what his streak was. So the
 * test that matters is end to end through the real query builder: rows as
 * PostgREST would return them go in, and the numbers Nomi will quote come out.
 */

interface Call {
  target: string;
  query: string;
}

type Reply = unknown[] | { error: string };

/** A client that answers each table from a canned reply; anything undeclared is empty. */
function stubDb(replies: Record<string, Reply>): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: Request | string) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const target = url.pathname.split('/rest/v1/')[1] ?? url.pathname;
    calls.push({ target, query: decodeURIComponent(url.search) });
    const reply = replies[target] ?? [];
    if (!Array.isArray(reply)) {
      return new Response(JSON.stringify({ message: reply.error }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    const n = reply.length;
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-range': n === 0 ? '*/0' : `0-${n - 1}/${n}`,
      },
    });
  }) as unknown as typeof fetch;

  const db = createClient('https://stub.supabase.co', 'sb_publishable_stub', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  }) as Db;
  return { db, calls };
}

const NOON = Date.UTC(2026, 8, 11, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** One set, one card known and due, one card missed. */
const account: Record<string, Reply> = {
  profiles: [{ display_name: 'Paul Mandap' }],
  study_days: [
    { day: '2026-09-11', answers: 3 },
    { day: '2026-09-10', answers: 2 },
  ],
  study_items: [
    { id: 'i1', section_title: null, level: 'remember' },
    { id: 'i2', section_title: null, level: 'understand' },
  ],
  review_state: [
    { study_item_id: 'i1', study_set_id: 's1', reps: 3, interval_days: 16, lapses: 0, due_at: iso(NOON - DAY) },
    { study_item_id: 'i2', study_set_id: 's1', reps: 0, interval_days: 1, lapses: 1, due_at: iso(NOON + 2 * DAY) },
  ],
  item_stats: [
    { study_item_id: 'i2', study_set_id: 's1', attempts: 2, misses: 1, partials: 0, last_result: 'incorrect' },
  ],
  study_sets: [
    {
      id: 's1',
      title: 'Cardiac conduction',
      status: 'ready',
      plan: null,
      created_at: iso(NOON - 5 * DAY),
      updated_at: iso(NOON - DAY),
      study_items: [{ count: 2 }],
    },
  ],
};

describe('getAppSnapshot', () => {
  it("knows the student's name, streak, and what is waiting in each set", async () => {
    const { db } = stubDb(account);
    const snapshot = await getAppSnapshot(db, NOON);

    expect(snapshot).toEqual({
      name: 'Paul',
      streak: 2,
      studiedToday: true,
      dueToday: 1,
      toRetry: 1,
      totalAnswers: 5,
      sets: [
        { id: 's1', title: formatSetTitle('Cardiac conduction'), cards: 2, due: 1, missed: 1, known: 1 },
      ],
    });
  });

  it('goes through the Phase B seam, and reads the name from profiles', async () => {
    const { db, calls } = stubDb(account);
    await getAppSnapshot(db, NOON);
    const targets = new Set(calls.map((c) => c.target));
    for (const t of ['profiles', 'study_sets', 'study_days', 'review_state', 'item_stats']) {
      expect(targets.has(t), t).toBe(true);
    }
  });

  it('still knows the streak when the sets cannot be read, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = stubDb({ ...account, study_sets: { error: 'permission denied' } });

    const snapshot = await getAppSnapshot(db, NOON);

    expect(snapshot.sets).toEqual([]);
    expect(snapshot.streak).toBe(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[nomi] could not read study sets'));
    warn.mockRestore();
  });

  it('has no name rather than a wrong one when the profile cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = stubDb({ ...account, profiles: { error: 'boom' } });
    expect((await getAppSnapshot(db, NOON)).name).toBeNull();
    warn.mockRestore();
  });

  it('reads a new account as empty, not as broken', async () => {
    const { db } = stubDb({});
    const snapshot = await getAppSnapshot(db, NOON);
    expect(snapshot).toMatchObject({ name: null, streak: 0, dueToday: 0, toRetry: 0, sets: [] });
  });

  it('never hands out a shared snapshot to be mutated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = await getAppSnapshot(stubDb({ study_sets: { error: 'x' } }).db, NOON);
    first.sets.push({ id: 'x', title: 'mutated', cards: 0, due: 0, missed: 0, known: 0 });
    const second = await getAppSnapshot(stubDb({ study_sets: { error: 'x' } }).db, NOON);
    expect(second.sets).toEqual([]);
    warn.mockRestore();
  });
});
