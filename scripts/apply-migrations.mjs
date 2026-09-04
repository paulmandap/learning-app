/**
 * Apply supabase/migrations/*.sql in order via the Supabase Management API.
 *
 * Uses a personal access token (SUPABASE_ACCESS_TOKEN), which is a developer
 * credential for schema work — not a client key, and never shipped in the app.
 * This exists because the Free plan has no CI database and `supabase db push`
 * wants the database password; the Management API needs neither.
 *
 * Run:
 *   SUPABASE_ACCESS_TOKEN=sbp_... SUPABASE_PROJECT_REF=xxx node scripts/apply-migrations.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.SUPABASE_PROJECT_REF;

if (!token || !ref) {
  console.error('Set SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF.');
  process.exit(2);
}

const dir = 'supabase/migrations';
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error(`No .sql files in ${dir}`);
  process.exit(2);
}

async function runSql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 1200)}`);
  }
  return text;
}

let failed = false;
for (const file of files) {
  const sql = readFileSync(join(dir, file), 'utf8');
  process.stdout.write(`${file} … `);
  try {
    await runSql(sql);
    console.log('OK');
  } catch (err) {
    failed = true;
    console.log('FAILED');
    console.error(`\n  ${err.message}\n`);
    // Stop on first failure: later migrations assume earlier ones applied.
    break;
  }
}

process.exit(failed ? 1 : 0);
