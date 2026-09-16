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

    console.log('');
    const destructive = changed
      .filter(existsSync)
      .map((f) => ({ file: f, drops: destructiveDrops(readFileSync(f, 'utf-8')) }))
      .filter((r) => r.drops.length > 0);

    if (destructive.length > 0) {
      console.log('  *** DANGER ***  These REMOVE or RENAME schema objects:');
      for (const { file, drops } of destructive) {
        console.log(`      ${file}`);
        for (const d of drops) console.log(`        ${d}`);
      }
      console.log('');
      console.log('  If they have been applied, production is running code written against');
      console.log('  the OLD schema and will fail on every query that touches a dropped');
      console.log('  object — 42703 for a column, 42P10 for a constraint an upsert names.');
      console.log('  Deploy BEFORE applying, or the app is down until you do.');
      console.log('  2026-09-12 was a column (NOTES §31); 2026-09-16 was a constraint (§46.7).');
    } else {
      console.log('  None of them drops or renames anything an old build could still be using,');
      console.log('  so an old build keeps working. Safe to apply before deploying.');
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

/**
 * Which drops in a migration could actually break a build that is already live.
 *
 * ## Why this is not one regular expression any more
 *
 * It was: `/\b(drop\s+(table|column|view)|rename\s+(to|column))\b/i` over the
 * whole file. On 2026-09-16 that got BOTH answers wrong on the same pair of
 * migrations, and the pair took production down (NOTES §46.7).
 *
 *  - **False positive on 0021.** It matched `drop view if exists
 *    public.public_sets`, which is the standard idempotent idiom and is followed
 *    three lines later by `create view public.public_sets`. Nothing is removed;
 *    the view is replaced. The migration was additive and perfectly safe to
 *    apply first, and the script called it DANGER.
 *  - **False negative on 0022, which is the one that mattered.** It drops a
 *    unique CONSTRAINT, and `constraint` was not in the pattern. So the script
 *    said nothing about the only file that could break the live build — and it
 *    did: the deployed bundle upserted `on_conflict=study_item_id`, the
 *    constraint satisfying that was gone, and Postgres answered 42P10 on every
 *    schedule write in the app.
 *
 * A warning that cries wolf on the safe file and stays silent on the dangerous
 * one is worse than no warning, because it teaches you to scroll past it.
 *
 * ## What it does instead
 *
 * Comments are stripped first — this project's migrations discuss dropping
 * things at length, and prose must not set off a schema alarm. Then every drop
 * is matched with the KIND of object and, where there is one, its literal name.
 * A drop is forgiven only if the same file creates that same name again.
 *
 * A drop with no literal name — `execute format('… drop constraint %I', …)`
 * inside a DO block, which is how a constraint is correctly found by what it
 * checks rather than by a guessed name — can never be proved to be recreated,
 * so it always counts. That is the right way round: unprovable means dangerous.
 */
export function destructiveDrops(sql: string): string[] {
  // Prose first. Without this, 0022's own explanation of what it drops and why
  // would trip every pattern below.
  const code = sql.replace(/--[^\n]*/g, '');

  const KINDS = 'table|column|view|materialized\\s+view|constraint|index|policy|function|trigger|type|sequence|schema';
  const found: string[] = [];

  for (const m of code.matchAll(new RegExp(`\\bdrop\\s+(${KINDS})\\b([^;]*)`, 'gi'))) {
    const kind = m[1]!.replace(/\s+/g, ' ').toLowerCase();
    const rest = m[2] ?? '';
    // The first identifier after the optional IF EXISTS is the name. A `%I`
    // placeholder is not one, which is exactly the case we must not forgive.
    const name = /^\s*(?:if\s+exists\s+)?([A-Za-z_][\w.$]*)/i.exec(rest)?.[1] ?? null;

    if (name) {
      // Replaced, not removed? `create view public.x` after `drop view public.x`.
      const recreated = new RegExp(
        `\\bcreate\\s+(?:or\\s+replace\\s+)?(?:${KINDS})\\b[^;]*?\\b${name.replace(/[.$]/g, '\\$&')}\\b`,
        'i',
      ).test(code);
      if (recreated) continue;
      found.push(`drops ${kind} ${name}`);
    } else {
      found.push(`drops a ${kind} whose name is built at run time — cannot be shown to be replaced`);
    }
  }

  for (const m of code.matchAll(/\brename\s+(to|column)\b/gi)) {
    found.push(`renames (${m[1]!.toLowerCase()})`);
  }

  return [...new Set(found)];
}

// Only when run directly, so `destructiveDrops` can be imported and tested —
// the same guard scripts/screenshot.ts uses for the same reason.
if (process.argv[1]?.endsWith('deploy-status.ts')) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
