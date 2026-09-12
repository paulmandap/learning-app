/**
 * What is actually live, and is it dangerously behind?
 *
 * ## The failure this exists for
 *
 * On 2026-09-12 the live site could not deal a single deck. Migration 0015
 * dropped `study_items.form`; the code that stopped selecting that column had
 * been committed six days earlier and **never deployed**. Every `listItems`
 * on production answered `42703: column study_items.form does not exist`.
 *
 * §26.5 had called 0015 "safe to run in either order", reasoning that
 * `items.ts` stopped selecting the column *first*. That is true and it quietly
 * assumes *first* means DEPLOYED, not committed. Nothing was watching the gap
 * between the two, so nothing noticed when it opened.
 *
 * ## The signal that was missing
 *
 * Not "is production behind" — six days of drift was survivable. It is
 * **"is production behind a MIGRATION"**, which is the case where drift stops
 * being latency and becomes an outage. That is the loud line below.
 *
 * Reads only: the Cloudflare Pages API, git, and the live index.html.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/deploy-status.ts
 *
 * Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (already in .env for
 * deploys). The token is sent in a header and never printed.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const PROJECT = 'learning-app';
const LIVE_URL = 'https://learning-app-6kk.pages.dev/';
const BUNDLE = /_expo\/static\/js\/web\/entry-([a-f0-9]+)\.js/;

const git = (...args: string[]): string =>
  execFileSync('git', args, { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 }).trim();

const rule = (s: string) => console.log(`\n${'-'.repeat(78)}\n${s}\n${'-'.repeat(78)}`);

async function main() {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !account) throw new Error('CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set');

  console.log(`${'='.repeat(78)}\nDEPLOY STATUS\n${'='.repeat(78)}`);

  // ---- what Cloudflare says is live -------------------------------------
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}/pages/projects/${PROJECT}/deployments?per_page=10`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = (await res.json()) as {
    success: boolean;
    errors?: { message: string }[];
    result?: {
      created_on: string;
      environment: string;
      latest_stage?: { status?: string };
      deployment_trigger?: { metadata?: { commit_hash?: string } };
    }[];
  };
  if (!body.success) {
    throw new Error(`Cloudflare API: ${(body.errors ?? []).map((e) => e.message).join('; ')}`);
  }

  const live = (body.result ?? []).find(
    (d) => d.environment === 'production' && d.latest_stage?.status === 'success',
  );
  if (!live) throw new Error('no successful production deployment found');

  const deployed = live.deployment_trigger?.metadata?.commit_hash ?? '';
  const head = git('rev-parse', 'HEAD');
  console.log(`  live commit   ${deployed.slice(0, 7) || '(unknown)'}   deployed ${live.created_on.slice(0, 19)}`);
  console.log(`  local HEAD    ${head.slice(0, 7)}`);

  // A commit Cloudflare names but git does not have is not a comparison —
  // saying "0 behind" there would be the most dangerous possible answer.
  let known = false;
  try {
    git('cat-file', '-e', `${deployed}^{commit}`);
    known = true;
  } catch {
    known = false;
  }
  if (!known) {
    console.log('\n  The live commit is not in this repository (unpushed, rebased, or a');
    console.log('  different branch). Nothing below can be compared against it.');
    return;
  }

  const behind = Number(git('rev-list', '--count', `${deployed}..HEAD`));
  const ahead = Number(git('rev-list', '--count', `HEAD..${deployed}`));

  rule('COMMITS');
  if (behind === 0 && ahead === 0) console.log('  production is exactly HEAD.');
  else {
    console.log(`  production is ${behind} commit(s) behind HEAD${ahead ? `, and ${ahead} ahead` : ''}.`);
    for (const line of git('log', '--oneline', `${deployed}..HEAD`).split('\n').filter(Boolean)) {
      console.log(`    ${line}`);
    }
  }

  // ---- the line this script exists for ----------------------------------
  rule('MIGRATIONS ADDED SINCE THE LIVE BUILD');
  const changed = git('diff', '--name-only', `${deployed}..HEAD`, '--', 'supabase/migrations')
    .split('\n')
    .filter(Boolean);

  if (changed.length === 0) {
    console.log('  none. The live code and the schema it was written against agree.');
  } else {
    for (const f of changed) console.log(`    ${f}`);
    // Dropping or renaming is what turns drift into an outage: the live build
    // goes on SELECTing something the database no longer has, and PostgREST
    // answers 42703 on every query that touches it.
    const destructive = changed.filter((f) => {
      if (!existsSync(f)) return false;
      return /\b(drop\s+(table|column|view)|rename\s+(to|column))\b/i.test(readFileSync(f, 'utf-8'));
    });

    console.log('');
    if (destructive.length > 0) {
      console.log('  *** DANGER ***  These REMOVE or RENAME schema objects:');
      for (const f of destructive) console.log(`      ${f}`);
      console.log('');
      console.log('  If they have been applied, production is running code written against');
      console.log('  the OLD schema and will fail with 42703 on every query that touches a');
      console.log('  dropped object. Deploy BEFORE applying, or the app is down until you do.');
      console.log('  This is exactly what happened on 2026-09-12 (NOTES §31).');
    } else {
      console.log('  None of them drops or renames anything, so an old build keeps working.');
      console.log('  Additive migrations are safe to apply before deploying.');
    }
  }

  // ---- is the built bundle the live bundle? -----------------------------
  rule('BUNDLE');
  const localHtml = existsSync('dist/index.html') ? readFileSync('dist/index.html', 'utf-8') : '';
  const localHash = BUNDLE.exec(localHtml)?.[1] ?? null;
  let liveHash: string | null = null;
  try {
    liveHash = BUNDLE.exec(await (await fetch(LIVE_URL)).text())?.[1] ?? null;
  } catch {
    liveHash = null;
  }

  console.log(`  local dist/   ${localHash ? localHash.slice(0, 12) : '(not built)'}`);
  console.log(`  live          ${liveHash ? liveHash.slice(0, 12) : '(unreachable)'}`);
  if (localHash && liveHash) {
    console.log(
      localHash === liveHash
        ? '  match — what is live is what is built here.'
        : '  DIFFERENT. Cloudflare takes a few seconds to propagate, so re-read this' +
            '\n  before investigating if you have only just deployed.',
    );
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
