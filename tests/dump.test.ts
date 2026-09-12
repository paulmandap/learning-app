import { describe, expect, it } from 'vitest';
import {
  carriesAuthUsers,
  countCopyRows,
  inspectSchema,
  readCopyRows,
  splitQualified,
  tablesFromMigrations,
} from '../src/core/dump';

/**
 * Fixtures shaped like a real `supabase db dump`, including the parts that
 * have historically broken naive parsing: quoted identifiers, a table dumped
 * with zero rows, and a data value that begins with a backslash.
 */
const SCHEMA = `--
-- PostgreSQL database dump
--

-- Dumped from database version 15.8
-- Dumped by pg_dump version 17.0

CREATE SCHEMA IF NOT EXISTS "extensions";

CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;

CREATE TABLE public.study_sets (
    id uuid NOT NULL,
    user_id uuid NOT NULL
);

ALTER TABLE public.study_sets OWNER TO postgres;

CREATE TABLE IF NOT EXISTS "public"."study_items" (
    id uuid NOT NULL
);

ALTER TABLE "public"."study_items" OWNER TO "supabase_admin";

CREATE VIEW public.item_stats AS SELECT 1;

CREATE OR REPLACE FUNCTION public.claim_chat_message() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;

ALTER TABLE public.study_sets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "study_sets_select_own" ON public.study_sets FOR SELECT USING (true);
CREATE POLICY study_items_select_own ON public.study_items FOR SELECT USING (true);

GRANT SELECT ON TABLE public.study_sets TO anon;
GRANT ALL ON TABLE public.study_items TO authenticated;
GRANT ALL ON TABLE public.study_items TO PUBLIC;
`;

const DATA = `COPY public.study_sets (id, user_id) FROM stdin;
1\tabc
2\tdef
\\.

COPY "public"."study_items" (id) FROM stdin;
9
\\.

COPY public.notes (id, body) FROM stdin;
\\.
`;

describe('splitQualified', () => {
  it('separates schema from name and strips quotes', () => {
    expect(splitQualified('"public"."study_items"')).toEqual({
      schema: 'public',
      name: 'study_items',
    });
  });

  it('reports an unqualified name as schema null, not as public', () => {
    // "it said public" and "it did not say" are different facts in a dump,
    // and assuming the first would hide a search_path problem.
    expect(splitQualified('study_items')).toEqual({ schema: null, name: 'study_items' });
  });
});

describe('inspectSchema', () => {
  const found = inspectSchema(SCHEMA);

  it('reads the source Postgres version from the header', () => {
    expect(found.dumpedFrom).toBe('15.8');
  });

  it('finds tables whether or not the identifiers are quoted', () => {
    // backup.yml already had to match loosely "because the CLI has quoted the
    // identifiers differently across versions". Being strict here would mean a
    // CLI bump silently reports an empty backup.
    expect(found.tables).toEqual(['public.study_items', 'public.study_sets']);
  });

  it('finds views, functions, policies and extensions', () => {
    expect(found.views).toEqual(['public.item_stats']);
    expect(found.functions).toEqual(['public.claim_chat_message']);
    expect(found.policies).toEqual(['study_items_select_own', 'study_sets_select_own']);
    expect(found.extensions).toEqual(['pgcrypto']);
  });

  it('notices row level security is switched on', () => {
    expect(found.enablesRowLevelSecurity).toBe(true);
  });

  it('collects the roles the dump EXPECTS to already exist', () => {
    // The opposite of every other list here, and the recovery question: a dump
    // that creates the tables but assumes the roles is not self-contained.
    expect(found.roles).toEqual(['anon', 'authenticated', 'postgres', 'supabase_admin']);
  });

  it('does not treat GRANT … TO PUBLIC as a role someone must create', () => {
    expect(found.roles).not.toContain('PUBLIC');
    expect(found.roles).not.toContain('public');
  });

  it('reports a dump with no policies as having none, rather than guessing', () => {
    const bare = inspectSchema('CREATE TABLE public.x (id int);');
    expect(bare.policies).toEqual([]);
    expect(bare.enablesRowLevelSecurity).toBe(false);
  });
});

describe('countCopyRows', () => {
  const counts = countCopyRows(DATA);

  it('counts rows per table, quoted or not', () => {
    expect(counts.get('public.study_sets')).toBe(2);
    expect(counts.get('public.study_items')).toBe(1);
  });

  it('keeps an empty table as 0 rather than dropping it', () => {
    // Present-with-0 means "empty in the source". Absent means "never dumped".
    // Conflating them turns data loss into a clean bill of health.
    expect(counts.get('public.notes')).toBe(0);
    expect(counts.has('public.notes')).toBe(true);
  });

  it('does not end a block on a data line that merely starts with a backslash', () => {
    // The escaped value must be the FIRST column, or the line does not start
    // with a backslash and this asserts nothing. An earlier version of this
    // fixture put it after a tab: the test passed, and passed just as happily
    // against a parser that ended the block on any backslash line.
    //
    // pg_dump escapes a leading backslash by doubling it, so a row whose first
    // value is \begin{document} is written as \\begin{document} — two
    // backslashes, which the terminator (a lone \.) must not match.
    const tricky = `COPY public.notes (body, id) FROM stdin;
\\\\begin{document}\t1
ordinary\t2
\\.
`;
    expect(tricky.split('\n')[1]!.startsWith('\\')).toBe(true);
    expect(countCopyRows(tricky).get('public.notes')).toBe(2);
  });

  it('flags a truncated file instead of reporting a clean read', () => {
    const cut = `COPY public.notes (id) FROM stdin;
1
2
`;
    const out = countCopyRows(cut);
    expect([...out.keys()].some((k) => k.includes('UNTERMINATED'))).toBe(true);
  });
});

describe('readCopyRows', () => {
  it('returns rows keyed by the dumped column names', () => {
    expect(readCopyRows(DATA, 'public.study_sets')).toEqual([
      { id: '1', user_id: 'abc' },
      { id: '2', user_id: 'def' },
    ]);
  });

  it('finds the table whether or not the header quotes it', () => {
    expect(readCopyRows(DATA, 'public.study_items')).toEqual([{ id: '9' }]);
  });

  it('distinguishes NULL from an empty string', () => {
    // `\N` is NULL; an empty field is the empty string. Collapsing the two
    // would silently turn "never answered" into "answered with nothing".
    const sql = 'COPY public.t (a, b) FROM stdin;\n\\N\t\n\\.\n';
    expect(readCopyRows(sql, 'public.t')).toEqual([{ a: null, b: '' }]);
  });

  it('unescapes tabs, newlines and backslashes inside a value', () => {
    // Without this a value containing an escaped tab would split into two
    // columns and shift every field after it by one.
    const sql = 'COPY public.t (a, b) FROM stdin;\nx\\ty\\nz\\\\w\tsecond\n\\.\n';
    expect(readCopyRows(sql, 'public.t')).toEqual([{ a: 'x\ty\nz\\w', b: 'second' }]);
  });

  it('returns nothing for a table the dump does not contain', () => {
    expect(readCopyRows(DATA, 'public.nope')).toEqual([]);
  });

  it('stops at the block terminator and does not run into the next table', () => {
    const rows = readCopyRows(DATA, 'public.study_sets');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => 'user_id' in r)).toBe(true);
  });
});

describe('carriesAuthUsers', () => {
  it('reports absent when the dump is public-only', () => {
    // The expected result for this project's backup, and the finding that
    // decides whether it restores DATA or restores a SERVICE.
    expect(carriesAuthUsers(SCHEMA, DATA)).toEqual({ schema: false, data: false, rows: null });
  });

  it('distinguishes the table existing from the table having rows', () => {
    const withTable = `${SCHEMA}\nCREATE TABLE auth.users (id uuid NOT NULL);`;
    expect(carriesAuthUsers(withTable, DATA)).toEqual({ schema: true, data: false, rows: null });

    const withRows = `${DATA}\nCOPY auth.users (id) FROM stdin;\nu1\nu2\n\\.\n`;
    expect(carriesAuthUsers(withTable, withRows)).toEqual({ schema: true, data: true, rows: 2 });
  });
});

describe('tablesFromMigrations', () => {
  it('derives the expected tables and subtracts dropped ones', () => {
    // The same derivation backup.yml does in shell, so the restore is checked
    // against the same definition the dump is — not a second hand-kept list,
    // which is the thing that failed four times out of four.
    expect(
      tablesFromMigrations([
        'create table public.study_sets (id uuid);',
        'CREATE TABLE IF NOT EXISTS public.notes (id uuid);',
        'create table public.scratch (id uuid);',
        'drop table if exists public.scratch;',
      ]),
    ).toEqual(['notes', 'study_sets']);
  });

  it('ignores tables in other schemas', () => {
    expect(tablesFromMigrations(['create table auth.users (id uuid);'])).toEqual([]);
  });
});
