import { describe, expect, it } from 'vitest';
import { isMissingColumn, isMissingTable } from '../src/core/db-errors';

describe('isMissingColumn', () => {
  it('knows both ways a missing column is reported', () => {
    // A SELECT naming it reaches Postgres: 42703. An upsert naming it is
    // refused by PostgREST first: PGRST204 — measured on the live project
    // before migration 0016, choosing a face (NOTES §37).
    expect(isMissingColumn({ code: '42703' })).toBe(true);
    expect(isMissingColumn({ code: 'PGRST204' })).toBe(true);
  });

  it('is not fooled by other errors, or by no error', () => {
    expect(isMissingColumn({ code: '23514' })).toBe(false); // a check constraint
    expect(isMissingColumn({ code: 'PGRST205' })).toBe(false); // a table, not a column
    expect(isMissingColumn({})).toBe(false);
    expect(isMissingColumn(null)).toBe(false);
  });
});

describe('isMissingTable', () => {
  it('knows both ways a missing table is reported (§19.4)', () => {
    expect(isMissingTable({ code: '42P01' })).toBe(true);
    expect(isMissingTable({ code: 'PGRST205' })).toBe(true);
    expect(isMissingTable({ code: 'PGRST204' })).toBe(false);
    expect(isMissingTable(undefined)).toBe(false);
  });
});
