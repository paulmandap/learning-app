/**
 * Phase G1 — restore the backup, for the first time ever.
 *
 * The monthly workflow has dumped since it shipped and **no dump has ever been
 * restored**. It verifies structure against `supabase/migrations/` and row
 * counts for two tables, which proves the dump HAS rows — not that anything
 * can be recovered from it. That gap is the only failure mode in this project
 * where the loss is permanent and silent.
 *
 * Two things the existing checks structurally cannot ask, because
 * `backup.yml:116` considers `public.` objects only:
 *
 *   R4  is `auth.users` in the dump? If not, every user-scoped row references
 *       an account that no longer exists — the data is recoverable, the
 *       SERVICE is not, and the recovery procedure needs a step nobody wrote.
 *   R5  do the RLS policies come back? If not, a restore is a security
 *       regression as well as a data one.
 *
 * ## Stages, each able to stop the drill
 *
 *   verify    the artifact is what the workflow produced — the same two
 *             assertions backup.yml:239-246 makes before uploading
 *   decrypt   gpg + tar into the scratchpad
 *   inspect   R4, R5, R6 and the source Postgres version, FROM THE TEXT, with
 *             no database in existence. Free, and it may settle the biggest
 *             question before anything is installed.
 *   restore   apply schema.sql then data.sql to a scratch database
 *   compare   row counts, dump vs restored
 *
 * ## The plaintext is every student's notes
 *
 * It is written only under --out (default: outside the repository), deleted on
 * success AND on failure, and never printed — this script reports counts and
 * object names, never row contents. The passphrase comes from the environment
 * and is passed to gpg on stdin, never on a command line, for the reason
 * backup.yml:222 gives: argv is readable by other processes.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/restore-drill.ts --file <backup.tar.gz.gpg>
 *   npx tsx --env-file=.env scripts/restore-drill.ts --file <...> --restore
 *
 * --restore additionally needs psql on PATH and a running local Postgres.
 * Without it the drill stops after `inspect`, which is still a real result.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  carriesAuthUsers,
  countCopyRows,
  inspectSchema,
  tablesFromMigrations,
} from '../src/core/dump';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(name);

const rule = (s: string) => console.log(`\n${'-'.repeat(78)}\n${s}\n${'-'.repeat(78)}`);
const answer = (id: string, yes: boolean, detail: string) =>
  console.log(`  ${id}  ${yes ? 'YES' : 'NO '}  ${detail}`);

function have(cmd: string): boolean {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Scratch database name. Fixed, so a re-run cannot leave a trail of them. */
const DB = 'restore_drill';
const PORT = arg('--port') ?? '5433';

interface PsqlResult {
  /** stdout only — what a `-tAc` query answers. */
  out: string;
  /** How many errors psql reported. */
  errors: number;
  /** stdout AND stderr, for reporting what went wrong. */
  all: string;
}

/**
 * Run psql and count its errors HONESTLY.
 *
 * Two traps here, both found by running this against a synthetic dump before
 * it ever saw real data, and either one would have reported a clean restore
 * over a broken one:
 *
 *  1. **psql writes errors to stderr.** `execFileSync` returns stdout, so the
 *     first version of this counted zero errors while twelve were printing to
 *     the console beside it.
 *  2. **With ON_ERROR_STOP=0 the exit code is 0 anyway**, so the process
 *     status cannot be used either.
 *
 * The match is on `ERROR:` anywhere, not anchored: psql prefixes file errors
 * as `psql:schema.sql:15: ERROR: …`, so `/^ERROR:/m` misses every one that
 * comes from a script — which is all of the ones that matter.
 */
function psql(args: string[], opts: { db?: string; input?: string } = {}): PsqlResult {
  const password = process.env.PGPASSWORD_LOCAL ?? 'restore-drill-local';
  const r = spawnSync(
    'psql',
    ['-h', '127.0.0.1', '-p', PORT, '-U', 'postgres', '-d', opts.db ?? 'postgres', '-v', 'ON_ERROR_STOP=0', ...args],
    {
      encoding: 'utf-8',
      input: opts.input,
      env: { ...process.env, PGPASSWORD: password },
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  if (r.error) throw r.error;
  const out = r.stdout ?? '';
  const all = `${out}${r.stderr ?? ''}`;
  return { out, all, errors: (all.match(/\bERROR:/g) ?? []).length };
}

/** The distinct error messages psql produced, deduplicated for reporting. */
function errorKinds(text: string): string[] {
  const kinds = new Set<string>();
  for (const m of text.matchAll(/\bERROR:\s*([^\n]+)/g)) {
    kinds.add((m[1] ?? '').replace(/"[^"]*"/g, '"…"').trim());
  }
  return [...kinds];
}

async function main() {
  const file = arg('--file');
  if (!file) throw new Error('pass --file <backup.tar.gz.gpg>');
  if (!existsSync(file)) throw new Error(`no such file: ${file}`);

  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase) {
    throw new Error(
      'BACKUP_PASSPHRASE is not set. Add it to .env (which is gitignored) and run with --env-file=.env',
    );
  }

  // Outside the repository by default: tmp-form-probe was not gitignored
  // either, and a dump of real student notes must never be one `git add -A`
  // away from a public repo.
  const work = mkdtempSync(join(arg('--out') ?? tmpdir(), 'restore-drill-'));
  let ok = false;

  try {
    console.log(`${'='.repeat(78)}\nPHASE G1 — RESTORE DRILL\n${'='.repeat(78)}`);
    console.log(`artifact  : ${file}`);
    console.log(`workspace : ${work}   (deleted when this exits)`);

    // ---------------------------------------------------------- verify --
    rule('VERIFY — is this really the artifact the workflow produced?');
    const raw = readFileSync(file);
    // GPG symmetric output starts with a packet tag byte: 0x8C or 0xC3.
    const tag = raw[0] ?? 0;
    const looksEncrypted = tag === 0x8c || tag === 0xc3;
    console.log(`  first byte 0x${tag.toString(16)} — ${looksEncrypted ? 'GPG packet' : 'NOT a GPG packet'}`);
    if (raw.includes(Buffer.from('COPY public.'))) {
      throw new Error('plaintext SQL found inside the artifact — refusing to continue');
    }
    console.log('  no plaintext "COPY public." inside  (backup.yml:243 makes the same check)');
    console.log(`  ${raw.length} bytes`);
    if (!looksEncrypted) throw new Error('not a GPG-encrypted file');

    // --------------------------------------------------------- decrypt --
    rule('DECRYPT — R1');
    const tarPath = join(work, 'backup.tar.gz');
    execFileSync(
      'gpg',
      ['--batch', '--yes', '--quiet', '--decrypt', '--passphrase-fd', '0', '--output', tarPath, file],
      { input: passphrase, stdio: ['pipe', 'ignore', 'inherit'] },
    );
    // Relative filename with cwd, NOT an absolute path: GNU tar reads the
    // colon in "C:\…" as a remote host and answers "Cannot connect to C:".
    // --force-local would fix GNU tar and break Windows' bundled bsdtar, which
    // does not have the flag; staying relative works for both.
    execFileSync('tar', ['-xzf', 'backup.tar.gz'], { cwd: work, stdio: 'inherit' });

    const produced = readdirSync(work).filter((f) => f.endsWith('.sql')).sort();
    answer('R1', produced.length > 0, `decrypted and extracted: ${produced.join(', ') || 'nothing'}`);
    if (!produced.includes('schema.sql') || !produced.includes('data.sql')) {
      throw new Error(`expected schema.sql and data.sql, got: ${produced.join(', ')}`);
    }

    const schemaSql = readFileSync(join(work, 'schema.sql'), 'utf-8');
    const dataSql = readFileSync(join(work, 'data.sql'), 'utf-8');

    // --------------------------------------------------------- inspect --
    rule('INSPECT — no database needed');
    const found = inspectSchema(schemaSql);
    const counts = countCopyRows(dataSql);

    console.log(`  dumped from Postgres : ${found.dumpedFrom ?? 'not stated'}`);
    console.log(`  schemas present      : ${found.schemas.join(', ') || 'none'}`);
    console.log(`  tables               : ${found.tables.length}`);
    console.log(`  views                : ${found.views.join(', ') || 'none'}`);
    console.log(`  functions            : ${found.functions.join(', ') || 'none'}`);
    console.log(`  extensions           : ${found.extensions.join(', ') || 'none'}`);
    console.log(`  policies             : ${found.policies.length}`);
    console.log(`  roles it EXPECTS     : ${found.roles.join(', ') || 'none'}`);

    console.log('\n  rows per table in the dump:');
    let totalRows = 0;
    for (const [table, n] of [...counts.entries()].sort()) {
      totalRows += n;
      console.log(`    ${table.padEnd(34)} ${String(n).padStart(7)}`);
    }
    console.log(`    ${'TOTAL'.padEnd(34)} ${String(totalRows).padStart(7)}`);

    // Against the repo's own migrations, the same derivation backup.yml uses.
    const migrations = readdirSync('supabase/migrations')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => readFileSync(join('supabase/migrations', f), 'utf-8'));
    const expected = tablesFromMigrations(migrations);
    const dumpedPublic = new Set(
      found.tables.filter((t) => t.startsWith('public.')).map((t) => t.slice('public.'.length)),
    );
    const missing = expected.filter((t) => !dumpedPublic.has(t));
    console.log(`\n  migrations expect ${expected.length} public tables; dump has ${dumpedPublic.size}`);
    if (missing.length > 0) console.log(`  MISSING FROM THE DUMP: ${missing.join(', ')}`);

    rule('THE TWO QUESTIONS THE EXISTING CHECKS CANNOT ASK');
    // R4 needs BOTH halves, and they disagree in this project's dump.
    //
    // `supabase db dump` emits public-only DDL but --data-only emits data for
    // auth and storage too. So the accounts are in the backup and the tables
    // to hold them are not: measured 2026-09-12, auth.users carried 7 rows and
    // restored 0. Reporting "the rows are there" as a YES would have been an
    // overclaim, and the first version of this line made exactly that mistake
    // until the restore stage contradicted it.
    const auth = carriesAuthUsers(schemaSql, dataSql);
    answer(
      'R4',
      auth.data && auth.schema,
      auth.data && auth.schema
        ? `auth.users: ${auth.rows} row(s) AND its definition — accounts restore anywhere`
        : auth.data
          ? `auth.users carries ${auth.rows} row(s) but the dump has NO auth DDL — the accounts load only into a target that already provides the auth schema (a real Supabase project), and are silently LOST restoring anywhere else`
          : 'auth.users is not in the dump at all — restored rows would reference accounts that do not exist',
    );
    answer(
      'R5',
      found.policies.length > 0 && found.enablesRowLevelSecurity,
      `${found.policies.length} policies, RLS ${found.enablesRowLevelSecurity ? 'enabled' : 'NOT enabled'} in the dump`,
    );
    // R6 is about the FILES, not the rows about the files. storage.objects is
    // metadata; the bytes live in Supabase's object store and a database dump
    // cannot contain them. "storage rows present" was the first version of
    // this line and it read as though the uploads were safe. They are not.
    const objectRows = counts.get([...counts.keys()].find((k) => /^storage\.objects$/i.test(k)) ?? '') ?? 0;
    answer(
      'R6',
      false,
      objectRows > 0
        ? `${objectRows} storage.objects METADATA row(s), but a database dump cannot carry the file bytes — a restore yields rows pointing at originals that no longer exist. Page text is in the database, so cards survive; the "Source · p.14" image does not`
        : 'no storage rows at all — uploaded originals are not recoverable from a database dump',
    );

    // --------------------------------------------------------- restore --
    if (!has('--restore')) {
      rule('RESTORE — skipped');
      console.log('  Pass --restore to apply this to a scratch database (needs psql).');
      console.log('  R2, R3 and R5-in-practice are NOT ANSWERED without it.');
      ok = true;
      return;
    }

    rule('RESTORE — R2, R3');
    if (!have('psql')) {
      throw new Error('psql is not on PATH — install PostgreSQL first, or omit --restore');
    }

    psql(['-c', `drop database if exists ${DB}`]);
    psql(['-c', `create database ${DB}`]);

    // ------------------------------------------------------------------
    // EVERYTHING THE DUMP ASSUMES BUT DOES NOT CREATE.
    //
    // This block IS the missing half of the recovery procedure.
    // backup.yml:46-49 says "psql -f schema.sql && psql -f data.sql" and
    // mentions none of it, because it has never been run: a `supabase db
    // dump` is public-only, and the objects it references live in schemas
    // Supabase provides for you and vanilla Postgres does not.
    //
    // Each item is recorded, because "what you must build before the backup
    // will load" is the part of a restore nobody has written down.
    // ------------------------------------------------------------------
    const prepared: string[] = [];

    // Roles are CLUSTER-wide, not per-database, so they survive the drop and
    // create above. Reporting only the ones this run happened to create would
    // shrink the list on every re-run — and this list is the deliverable, not
    // a progress log. Each is reported as required either way.
    for (const role of found.roles) {
      const existed =
        psql(['-tAc', `select 1 from pg_roles where rolname = '${role}'`], { db: DB }).out.trim() === '1';
      if (!existed) psql(['-c', `create role "${role}"`], { db: DB });
      prepared.push(`role ${role}${existed ? ' (already on this cluster)' : ''}`);
    }
    // Schemas the dump qualifies into but never creates.
    for (const schema of ['extensions', 'auth', 'storage', 'graphql_public']) {
      const r = psql(['-c', `create schema if not exists "${schema}"`], { db: DB });
      if (r.errors === 0) prepared.push(`schema ${schema}`);
    }
    // Every RLS policy in this database calls auth.uid(). Without it the
    // policies fail to create and the restore silently loses its security
    // model — which is R5 failing for a reason that has nothing to do with
    // the dump being incomplete.
    const uid = psql(
      [
        '-c',
        'create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$',
      ],
      { db: DB },
    );
    if (uid.errors === 0) prepared.push('function auth.uid() [stub]');

    console.log('  had to create before the dump would load:');
    for (const p of prepared) console.log(`    - ${p}`);

    const schemaRun = psql(['-f', join(work, 'schema.sql')], { db: DB });
    answer('R2', schemaRun.errors === 0, `schema.sql applied with ${schemaRun.errors} error(s)`);
    for (const kind of errorKinds(schemaRun.all)) console.log(`      ${kind}`);

    const dataRun = psql(['-f', join(work, 'data.sql')], { db: DB });
    const dataErrors = dataRun.errors;
    for (const kind of errorKinds(dataRun.all)) console.log(`      ${kind}`);

    rule('COMPARE — dump vs restored');

    // Split by schema, because the two halves fail for different reasons and
    // averaging them hides the result. `public` is this app's own data and is
    // what the backup exists to protect; `auth` and `storage` are platform
    // tables whose DDL the dump does not carry, so they can only land in a
    // target that already provides them.
    let appMismatch = 0;
    let appTables = 0;
    let platformMismatch = 0;
    let platformRowsLost = 0;

    for (const [table, dumped] of [...counts.entries()].sort()) {
      if (table.includes('UNTERMINATED')) continue;
      let live = -1;
      try {
        live = Number(psql(['-tAc', `select count(*) from ${table}`], { db: DB }).out.trim());
      } catch {
        /* table absent in the restore; counted as a mismatch below */
      }
      const same = live === dumped;
      const isApp = table.startsWith('public.');
      if (isApp) {
        appTables++;
        if (!same) appMismatch++;
      } else if (!same) {
        platformMismatch++;
        platformRowsLost += Math.max(0, dumped - Math.max(0, live));
      }
      console.log(
        `    ${same ? ' ok ' : 'MISS'}  ${table.padEnd(34)} dump ${String(dumped).padStart(6)}  restored ${String(live).padStart(6)}`,
      );
    }

    answer(
      'R3',
      appMismatch === 0,
      `APPLICATION data: ${appTables - appMismatch}/${appTables} public tables match exactly`,
    );
    if (platformMismatch > 0) {
      console.log(
        `      platform data: ${platformMismatch} auth/storage table(s) lost ${platformRowsLost} row(s) — no DDL for them in the dump (see R4)`,
      );
    }
    if (dataErrors > 0) console.log(`      ${dataErrors} COPY error(s), all from the missing platform tables`);

    const livePolicies = Number(psql(['-tAc', 'select count(*) from pg_policies'], { db: DB }).out.trim());
    answer('R5', livePolicies > 0, `${livePolicies} policies exist in the restored database`);

    console.log(`\n  Scratch database "${DB}" left in place for inspection.`);
    console.log(`  Drop it with:  psql -h 127.0.0.1 -p ${PORT} -U postgres -c "drop database ${DB}"`);
    ok = true;
  } finally {
    // On success AND on failure. The plaintext must not outlive the run.
    rmSync(work, { recursive: true, force: true });
    console.log(`\n${ok ? '' : '(failed) '}workspace deleted: ${work}`);
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
