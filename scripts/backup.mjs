/**
 * Local database backup. The manual counterpart to .github/workflows/backup.yml.
 *
 * Supabase Free includes no automatic backups at all (NOTES §2.5), so this and
 * the monthly workflow are the only copies of every set, note and answer in the
 * project.
 *
 * Run before anything risky — a migration, a bulk delete, a schema change:
 *
 *   SUPABASE_DB_URL=postgresql://... npm run backup
 *
 * SUPABASE_DB_URL is a FULL-ACCESS database credential, not the publishable
 * key: a dump has to read every user's rows, which is exactly what RLS exists
 * to prevent, so the publishable key cannot do it. Pass it inline as above
 * rather than putting it in .env, so it does not sit on disk between uses.
 *
 * Output lands in backups/<timestamp>/ and is gitignored.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const url = process.env.SUPABASE_DB_URL;
if (!url) {
  console.error(
    'Set SUPABASE_DB_URL.\n\n' +
      '  Supabase dashboard -> Project Settings -> Database -> Connection string -> URI\n' +
      '  Percent-encode the password if it contains @ : / ? # or %\n\n' +
      '  SUPABASE_DB_URL=postgresql://... npm run backup\n',
  );
  process.exit(2);
}

const TABLES = [
  'profiles',
  'study_sets',
  'documents',
  'document_pages',
  'study_items',
  'attempts',
  'heartbeat',
];

// Colons are illegal in Windows paths, so the timestamp is flattened.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = join('backups', stamp);
mkdirSync(dir, { recursive: true });

function dump(label, args) {
  process.stdout.write(`  ${label}… `);
  // execFileSync, not a shell string: the connection string carries a password
  // and must never be interpolated into a command line.
  execFileSync('npx', ['--yes', 'supabase@2', 'db', 'dump', '--db-url', url, ...args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  });
  console.log('done');
}

const schemaPath = join(dir, 'schema.sql');
const dataPath = join(dir, 'data.sql');

console.log(`Backing up to ${dir}\n`);
// `db dump` is schema-only by default, so data needs its own pass. Restoring
// means applying schema.sql first, then data.sql.
dump('schema', ['-f', schemaPath]);
dump('data', ['--data-only', '--use-copy', '-f', dataPath]);

// A backup that silently produced an empty file is worse than no backup,
// because it looks like protection. Verify before claiming success.
let failed = false;
for (const [label, path] of [['schema', schemaPath], ['data', dataPath]]) {
  const bytes = statSync(path).size;
  if (bytes === 0) {
    console.error(`\n  FAIL ${label}.sql is empty — the dump did not work.`);
    failed = true;
  } else {
    console.log(`  ${label}.sql  ${(bytes / 1024).toFixed(1)} KB`);
  }
}

if (!failed) {
  const schema = readFileSync(schemaPath, 'utf8');
  const missing = TABLES.filter((t) => !new RegExp(`CREATE TABLE[^;]*"?${t}"?`, 'i').test(schema));
  if (missing.length > 0) {
    console.error(`\n  FAIL schema.sql is missing: ${missing.join(', ')}`);
    failed = true;
  } else {
    console.log(`  all ${TABLES.length} tables present`);
  }
}

if (failed) process.exit(1);
console.log('\nBackup complete. It contains real user notes — keep it accordingly.');
