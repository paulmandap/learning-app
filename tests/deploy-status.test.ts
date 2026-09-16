import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { destructiveDrops } from '../scripts/deploy-status';

/**
 * The drop detector in `scripts/deploy-status.ts`.
 *
 * It exists to stop NOTES §31 happening again — a migration that removes
 * something the live build is still using, applied before the deploy that stops
 * using it. On 2026-09-16 it failed at that job in both possible directions at
 * once (§46.7), so its answers about those two exact files are pinned here.
 *
 * Reading the real migrations rather than fixtures is the point: a fixture would
 * have gone on passing while the thing it stood for changed.
 */

const sql = (file: string) => readFileSync(`supabase/migrations/${file}`, 'utf8');

describe('what counts as a dangerous migration', () => {
  it('0022 is dangerous — it drops a constraint the live build upserts on', () => {
    // The miss that took production down. `drop constraint` was not in the old
    // pattern at all, so the script said nothing about the only file that could
    // break the deployed bundle. It did: 42P10 on every schedule write.
    const drops = destructiveDrops(sql('0022_one_schedule_per_person.sql'));
    expect(drops.length).toBeGreaterThan(0);
    expect(drops.join(' ')).toMatch(/constraint/i);
  });

  it('0021 is NOT dangerous — every view it drops, it creates again', () => {
    // The false alarm. `drop view if exists public.public_sets` is the standard
    // idempotent idiom and the view is recreated three lines later. Calling an
    // additive migration DANGER is how a warning stops being read.
    expect(destructiveDrops(sql('0021_community.sql'))).toEqual([]);
  });

  it('0015 is dangerous — the migration that actually caused NOTES §31', () => {
    expect(destructiveDrops(sql('0015_retire_topic_stats_and_form.sql')).length).toBeGreaterThan(0);
  });

  it('reads the SQL, not the prose around it', () => {
    // This project's migrations discuss dropping things at length. 0022's own
    // header is several paragraphs about what it drops and why.
    expect(destructiveDrops('-- this migration will drop table users one day\nselect 1;')).toEqual([]);
  });

  it('forgives a replacement, and only a real one', () => {
    expect(
      destructiveDrops('drop view if exists public.v;\ncreate view public.v as select 1;'),
    ).toEqual([]);
    expect(destructiveDrops('drop view if exists public.v;')).toHaveLength(1);
    // A different object being created does not excuse the one that went.
    expect(
      destructiveDrops('drop view if exists public.v;\ncreate view public.other as select 1;'),
    ).toHaveLength(1);
  });

  it('never forgives a drop whose name is built at run time', () => {
    // Finding a constraint by WHAT IT CHECKS rather than by a guessed name is
    // the correct way to write it (HANDOFF) — and it means there is no literal
    // name to look for a replacement of. Unprovable must mean dangerous.
    const drops = destructiveDrops(
      `do $$ begin execute format('alter table t drop constraint %I', n); end $$;`,
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatch(/built at run time/);
  });

  it('covers the kinds a live build can actually be using', () => {
    for (const kind of ['table t', 'column c', 'view v', 'constraint k', 'index i', 'policy p']) {
      expect(destructiveDrops(`alter table x drop ${kind};`), kind).toHaveLength(1);
    }
    expect(destructiveDrops('alter table x rename to y;')).toHaveLength(1);
    expect(destructiveDrops('alter table x rename column a to b;')).toHaveLength(1);
  });
});
