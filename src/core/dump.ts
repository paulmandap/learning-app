/**
 * Reading a `supabase db dump` without a database — Phase G1.
 *
 * The monthly backup has never been restored. Before any of it is applied
 * anywhere, most of what matters can be answered from the text itself: which
 * tables are present, how many rows each carries, and — the two questions the
 * existing checks structurally cannot ask — whether anything outside the
 * `public` schema survived, and whether the RLS policies came with it.
 *
 * ## Why this is in src/core and not in the script that uses it
 *
 * No app code imports this. It lives here under the project's own rule:
 * deterministic logic goes in `src/core` **so Vitest can reach it**. Getting
 * this parsing wrong does not throw — it silently reports a healthy backup,
 * which is precisely the failure the derived table list in `backup.yml` was
 * written to kill. A checker nothing can test is the same shape of problem it
 * is meant to detect.
 *
 * ## Deliberately loose matching
 *
 * `backup.yml:189-194` already had to match `COPY` headers loosely "because
 * the CLI has quoted the identifiers differently across versions". That is a
 * measured fact about the tool, not a guess, so every matcher here accepts an
 * identifier with or without double quotes and with or without a schema
 * qualifier. Being strict would mean a version bump reports an empty backup.
 */

/** `public.study_items`, `"public"."study_items"`, `study_items` -> parts. */
function unquote(identifier: string): string {
  return identifier.replace(/"/g, '').trim();
}

/**
 * Split a possibly schema-qualified identifier.
 *
 * An unqualified name is reported as schema `null` rather than assumed to be
 * `public`: in a dump the difference between "it said public" and "it did not
 * say" is exactly what the `search_path` questions turn on.
 */
export function splitQualified(raw: string): { schema: string | null; name: string } {
  const cleaned = unquote(raw);
  const dot = cleaned.indexOf('.');
  if (dot === -1) return { schema: null, name: cleaned };
  return { schema: cleaned.slice(0, dot), name: cleaned.slice(dot + 1) };
}

/** An identifier, quoted or not, optionally schema-qualified. */
const QUALIFIED = String.raw`((?:"[^"]+"|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z0-9_$]+))?)`;

function matchAll(sql: string, pattern: string): string[] {
  const out: string[] = [];
  for (const m of sql.matchAll(new RegExp(pattern, 'gi'))) {
    if (m[1] !== undefined) out.push(m[1]);
  }
  return out;
}

const unique = (xs: string[]) => [...new Set(xs)].sort();

export interface SchemaContents {
  /** From the `-- Dumped from database version …` header, if present. */
  dumpedFrom: string | null;
  /** Every schema named by a CREATE SCHEMA or by a qualified CREATE. */
  schemas: string[];
  /** Qualified table names, exactly as the dump spells them (unquoted). */
  tables: string[];
  views: string[];
  policies: string[];
  functions: string[];
  extensions: string[];
  /** Roles the dump expects to exist already — from OWNER TO and GRANT … TO. */
  roles: string[];
  /** True if row-level security is switched on for at least one table. */
  enablesRowLevelSecurity: boolean;
}

/**
 * What a schema dump actually contains.
 *
 * Every list is of things the dump WILL CREATE, plus `roles`, which is the
 * opposite: things it expects to find. That distinction is the whole recovery
 * question — a dump that creates 11 tables and silently assumes four roles is
 * not self-contained, and nothing in the project has ever said so.
 */
export function inspectSchema(sql: string): SchemaContents {
  const versionMatch = /--\s*Dumped from database version\s+([^\s\n]+)/i.exec(sql);

  const tables = matchAll(sql, String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`);
  const views = matchAll(
    sql,
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${QUALIFIED}`,
  );
  const functions = matchAll(
    sql,
    String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${QUALIFIED}`,
  );
  const policies = matchAll(sql, String.raw`CREATE\s+POLICY\s+("[^"]+"|[A-Za-z0-9_$]+)`);
  const extensions = matchAll(
    sql,
    String.raw`CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z0-9_$]+)`,
  );

  const declaredSchemas = matchAll(
    sql,
    String.raw`CREATE\s+SCHEMA\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z0-9_$]+)`,
  ).map(unquote);

  const impliedSchemas = [...tables, ...views, ...functions]
    .map((t) => splitQualified(t).schema)
    .filter((s): s is string => s !== null);

  const owners = matchAll(sql, String.raw`OWNER\s+TO\s+("[^"]+"|[A-Za-z0-9_$]+)`).map(unquote);
  const grantees = matchAll(
    sql,
    String.raw`GRANT\s+[^;]*?\sTO\s+("[^"]+"|[A-Za-z0-9_$]+)`,
  ).map(unquote);

  return {
    dumpedFrom: versionMatch?.[1] ?? null,
    schemas: unique([...declaredSchemas, ...impliedSchemas]),
    tables: unique(tables.map(unquote)),
    views: unique(views.map(unquote)),
    policies: unique(policies.map(unquote)),
    functions: unique(functions.map((f) => unquote(f))),
    extensions: unique(extensions.map(unquote)),
    // PUBLIC is a keyword in GRANT, not a role anyone has to create.
    roles: unique([...owners, ...grantees].filter((r) => r.toUpperCase() !== 'PUBLIC')),
    enablesRowLevelSecurity: /ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql),
  };
}

/**
 * Rows per table in a `--data-only --use-copy` dump.
 *
 * pg_dump writes `COPY <table> (cols) FROM stdin;`, then one row per line,
 * then a line containing only `\.`. Values that contain a newline are escaped
 * as `\n` inside the row, so "one line, one row" holds — which is what makes
 * counting lines a correct count rather than an approximation.
 *
 * A table dumped with zero rows still emits its COPY block, so a table present
 * here with a count of 0 means "empty in the source", while a table absent
 * means "not dumped at all". Those must not be conflated: the first is fine,
 * the second is data loss.
 */
export function countCopyRows(sql: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = sql.split(/\r?\n/);

  let table: string | null = null;
  let rows = 0;

  for (const line of lines) {
    if (table === null) {
      const start = /^\s*COPY\s+((?:"[^"]+"|[A-Za-z0-9_$]+)(?:\s*\.\s*(?:"[^"]+"|[A-Za-z0-9_$]+))?)[^;]*FROM\s+stdin\s*;/i.exec(
        line,
      );
      if (start?.[1] !== undefined) {
        table = unquote(start[1]);
        rows = 0;
      }
      continue;
    }

    // A lone `\.` ends the block. A data line that merely starts with a
    // backslash does not — pg_dump escapes those.
    if (/^\\\.\s*$/.test(line)) {
      counts.set(table, (counts.get(table) ?? 0) + rows);
      table = null;
      continue;
    }
    rows++;
  }

  // An unterminated final block means the file was truncated. Recording what
  // was counted and letting the caller compare totals is more useful than
  // throwing, but it must not look like a clean read.
  if (table !== null) counts.set(`${table} (UNTERMINATED)`, rows);

  return counts;
}

/**
 * Does the dump carry the accounts the rows belong to?
 *
 * The one question that decides whether this backup restores DATA or restores
 * a SERVICE. Supabase keeps users in `auth.users`, and every user-scoped table
 * in this schema references it. If the dump omits them, a restored database is
 * full of rows owned by nobody: recoverable as records, not as an app anyone
 * can sign into.
 *
 * Checked on both halves, because they fail differently — the schema half
 * missing means the table is not even created, the data half missing means it
 * is created and empty.
 */
export function carriesAuthUsers(schemaSql: string, dataSql: string): {
  schema: boolean;
  data: boolean;
  rows: number | null;
} {
  const inSchema = inspectSchema(schemaSql).tables.some(
    (t) => splitQualified(t).schema === 'auth' && splitQualified(t).name === 'users',
  );
  const counts = countCopyRows(dataSql);
  const key = [...counts.keys()].find((k) => /^auth\.users$/i.test(k));
  return {
    schema: inSchema,
    data: key !== undefined,
    rows: key === undefined ? null : (counts.get(key) ?? 0),
  };
}

/**
 * Tables this repo's migrations create, minus any a later migration dropped.
 *
 * The same derivation `backup.yml` does in shell, so the drill checks the
 * restore against the same definition the backup checks the dump against —
 * rather than a second hand-kept list, which is the thing that failed four
 * times out of four.
 */
export function tablesFromMigrations(migrationSql: string[]): string[] {
  const joined = migrationSql.join('\n');
  const created = matchAll(
    joined,
    String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\s*\.\s*("[^"]+"|[A-Za-z0-9_$]+)`,
  ).map(unquote);
  const dropped = matchAll(
    joined,
    String.raw`DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?public\s*\.\s*("[^"]+"|[A-Za-z0-9_$]+)`,
  ).map(unquote);
  const gone = new Set(dropped.map((d) => d.toLowerCase()));
  return unique(created.filter((c) => !gone.has(c.toLowerCase())));
}
