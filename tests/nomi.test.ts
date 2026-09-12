import { createClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { getNomiContext } from '../src/data/nomi';
import { emptyNomiContext } from '../src/core/nomi';
import type { Db } from '../src/data/supabase';

/**
 * Nomi's context boundary, driven with no network.
 *
 * ## What is actually being pinned here
 *
 * Not "does Nomi work" — Nomi does nothing yet, deliberately. What matters at
 * this stage is the SHAPE: that the boundary goes through the Phase B `Db`
 * seam like every other data function, that it asks for one thing rather than
 * quietly growing a dashboard's worth of queries, and that a failed read
 * degrades instead of taking a screen down.
 *
 * Those are exactly the properties that are cheap to hold now and expensive to
 * retrofit once Phase C starts hanging real learning data off it.
 *
 * ## A local stub, not the one in data.test.ts
 *
 * `tests/data.test.ts` has a fuller `fakeDb`, and extracting it into a shared
 * module would mean editing a Phase B test file for a Phase-C-shaped reason.
 * This needs one table and no auth, so it gets its own small stub — the same
 * thing `gemini-provider.test.ts` and `gemini-grade.test.ts` already do with
 * their two different `stubFetch` helpers.
 */

/** Every request the boundary made, as the stub saw it. */
interface Call {
  method: string;
  /** `study_sets`, or whatever else someone adds without meaning to. */
  target: string;
  query: string;
}

/**
 * A client that answers `study_sets` from a canned list.
 *
 * `createClient` with an injected fetch routes PostgREST through the stub, so
 * this exercises the real query builder rather than a hand-written mock of it.
 */
function stubDb(
  rows: unknown[] | { error: string } = [],
): { db: Db; calls: Call[] } {
  const calls: Call[] = [];

  const fetchImpl = (async (input: Request | string, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw);
    calls.push({
      method: init?.method ?? 'GET',
      target: url.pathname.split('/rest/v1/')[1] ?? url.pathname,
      query: decodeURIComponent(url.search.replace(/^\?/, '')),
    });

    if (!Array.isArray(rows)) {
      return new Response(JSON.stringify({ message: rows.error }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(rows), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const db = createClient('https://stub.supabase.co', 'sb_publishable_stub', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: fetchImpl },
  }) as Db;

  return { db, calls };
}

/** A study_sets row shaped the way listSets asks for it. */
function setRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 's1',
    title: 'Cardiac conduction',
    status: 'ready',
    plan: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-10T00:00:00Z',
    study_items: [{ count: 12 }],
    ...over,
  };
}

describe('getNomiContext', () => {
  it('goes through the Phase B seam rather than the module singleton', async () => {
    // If it reached for `supabase` directly, the stub would see nothing and the
    // call would go to a host that does not exist.
    const { db, calls } = stubDb([setRow()]);
    await getNomiContext(db);
    expect(calls).not.toHaveLength(0);
  });

  it('asks for one thing, and that thing is the study sets', async () => {
    // The guard against this quietly becoming a second dashboard. Every field
    // Nomi will eventually want needs Phase C or D to exist before it can be
    // answered truthfully, so a second query appearing here now would be a
    // speculative one.
    const { db, calls } = stubDb([setRow()]);
    await getNomiContext(db);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.target).toBe('study_sets');
  });

  it('reuses listSets rather than writing its own query', async () => {
    // Not a second definition of "the student's sets". The embedded count and
    // the hidden-card filter are listSets' rules, and Nomi inherits them.
    const { db, calls } = stubDb([setRow()]);
    await getNomiContext(db);
    expect(calls[0]!.query).toContain('study_items(count)');
    expect(calls[0]!.query).toContain('study_items.hidden=eq.false');
  });

  it('carries through what Nomi can talk about', async () => {
    const { db } = stubDb([setRow(), setRow({ id: 's2', title: 'Renal', study_items: [{ count: 4 }] })]);
    const context = await getNomiContext(db);

    expect(context.sets).toEqual([
      { id: 's1', title: 'Cardiac conduction', cardCount: 12 },
      { id: 's2', title: 'Renal', cardCount: 4 },
    ]);
  });

  it('says it knows of no sets rather than throwing', async () => {
    // A companion that cannot list your sets should say so, not take down the
    // screen it sits on — the same trade review.ts and dashboard.ts make.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db } = stubDb({ error: 'permission denied' });

    const context = await getNomiContext(db);

    expect(context.sets).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[nomi]'));
    warn.mockRestore();
  });

  it('reads an empty account as empty, not as broken', async () => {
    const { db } = stubDb([]);
    const context = await getNomiContext(db);
    expect(context.sets).toEqual([]);
  });

  it('never hands out a shared empty context to be mutated', async () => {
    // The bug §24.4 records against EMPTY_DASHBOARD, not repeated here: one
    // caller pushing into a returned array would edit the constant for every
    // later failed read in the process.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = await getNomiContext(stubDb({ error: 'boom' }).db);
    first.sets.push({ id: 'x', title: 'mutated' });

    const second = await getNomiContext(stubDb({ error: 'boom' }).db);
    expect(second.sets).toEqual([]);
    expect(emptyNomiContext().sets).toEqual([]);
    warn.mockRestore();
  });
});
