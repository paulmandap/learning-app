/**
 * Cross-user isolation test (spec §7).
 *
 * Signs in as two real users against the live project and asserts that user B
 * cannot reach ANY of user A's data. This is the only test that can prove RLS,
 * because RLS is enforced by Postgres, not by anything we could unit test.
 *
 * Coverage, each asserted separately:
 *   - every user-scoped base table: study_sets, documents, document_pages,
 *     study_items, attempts, review_state (Phase 6), notes (0012),
 *     chat_usage (0010) and study_days (0009)
 *   - item_stats and topic_stats  <-- the views, tested in their own right
 *   - storage objects under A's prefix
 *   - profiles.gemini_api_key specifically
 *   - heartbeat: direct writes refused, the RPC accepted
 *
 * The views matter most. A Postgres view runs as its OWNER by default, which
 * bypasses RLS on the tables underneath. Testing only base tables would pass
 * while item_stats happily served every user's history to everyone.
 *
 * Run:
 *   npx tsx scripts/isolation-test.ts
 *
 * Requires (all disposable, none committed):
 *   EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
 *   TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD
 *   TEST_USER_B_EMAIL, TEST_USER_B_PASSWORD
 *
 * Uses the PUBLISHABLE key only — deliberately. A service-role key bypasses
 * RLS, so running this with one would make every assertion below meaningless.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishable = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!url || !publishable) {
  console.error('Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY.');
  process.exit(2);
}

const creds = {
  a: { email: process.env.TEST_USER_A_EMAIL, password: process.env.TEST_USER_A_PASSWORD },
  b: { email: process.env.TEST_USER_B_EMAIL, password: process.env.TEST_USER_B_PASSWORD },
};

if (!creds.a.email || !creds.a.password || !creds.b.email || !creds.b.password) {
  console.error(
    'Missing test user credentials. Set TEST_USER_A_EMAIL/PASSWORD and TEST_USER_B_EMAIL/PASSWORD.\n' +
      'Create two disposable users in the Supabase dashboard (Authentication → Users → Add user,\n' +
      'with "Auto Confirm User" ticked). They exist only for this test.',
  );
  process.exit(2);
}

/**
 * The day this test writes a streak row on.
 *
 * Deliberately impossible: the app did not exist in 2000, so a row on this day
 * is unambiguously the test's and nothing else's. Seeding today instead would
 * put a synthetic day inside A's real streak and the cleanup would then delete
 * a day they had actually studied.
 */
const STUDY_DAY_PROBE = '2000-01-01';

/**
 * The views this test covers, and the ones that may legitimately be gone.
 *
 * A view runs as its OWNER unless created with security_invoker, which would
 * bypass RLS on the tables underneath — so testing the base tables alone would
 * pass while these leaked everything. That is why they are here at all.
 *
 * `topic_stats` is on its way out: measured 2026-09-12, 26 distinct labels
 * across 28 cards and still 24 after normalising, so it can never group
 * anything. Migration 0015 drops it. Until an owner pastes that SQL the view is
 * still live and still worth checking, so this script tolerates either state
 * rather than depending on the order the two land in.
 */
const VIEWS = ['item_stats', 'topic_stats'] as const;
const RETIRED_VIEWS: readonly string[] = ['topic_stats'];

/** PostgREST answers PGRST205 for an unknown relation; Postgres says 42P01. */
function isMissingRelation(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST205' || error.code === '42P01';
}

let failures = 0;
let checks = 0;

function ok(name: string, detail = '') {
  checks++;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string) {
  checks++;
  failures++;
  console.error(`  FAIL  ${name} — ${detail}`);
}

async function signIn(which: 'a' | 'b'): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(url!, publishable!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: creds[which].email!,
    password: creds[which].password!,
  });
  if (error || !data.user) {
    throw new Error(`Could not sign in test user ${which.toUpperCase()}: ${error?.message}`);
  }
  return { client, userId: data.user.id };
}

async function main() {
  console.log('Cross-user isolation test\n');

  const A = await signIn('a');
  const B = await signIn('b');
  console.log(`  user A = ${A.userId}`);
  console.log(`  user B = ${B.userId}\n`);

  if (A.userId === B.userId) {
    console.error('Both credentials resolve to the same user. Use two distinct accounts.');
    process.exit(2);
  }

  // ---------------------------------------------------------------- seed --
  // A creates a full chain of rows so there is something real for B to fail
  // to reach. Also gives item_stats/topic_stats non-empty input.
  console.log('Seeding data as user A…');

  await A.client.from('profiles').upsert({ id: A.userId, gemini_api_key: 'A-SECRET-KEY-VALUE' });

  const { data: set, error: setErr } = await A.client
    .from('study_sets')
    .insert({ user_id: A.userId, title: 'Isolation probe set', status: 'ready' })
    .select()
    .single();
  if (setErr || !set) throw new Error(`Seed failed (study_sets): ${setErr?.message}`);

  const { data: doc } = await A.client
    .from('documents')
    .insert({
      user_id: A.userId,
      study_set_id: set.id,
      kind: 'text',
      title: 'probe doc',
      page_count: 1,
      status: 'read',
    })
    .select()
    .single();

  const { data: item } = await A.client
    .from('study_items')
    .insert({
      user_id: A.userId,
      study_set_id: set.id,
      document_id: doc?.id ?? null,
      page_index: 0,
      kind: 'flashcard',
      level: 'remember',
      prompt: 'probe prompt',
      answer: 'probe answer',
      source_excerpt: 'probe excerpt',
      excerpt_verified: true,
      topic: 'probe topic',
    })
    .select()
    .single();

  if (item) {
    await A.client.from('attempts').insert({
      user_id: A.userId,
      study_item_id: item.id,
      study_set_id: set.id,
      mode: 'flashcards',
      result: 'incorrect',
    });
  }

  // Phase 6: a schedule row for A, so B reading zero of them means something.
  if (item) {
    await A.client.from('review_state').insert({
      user_id: A.userId,
      study_item_id: item.id,
      study_set_id: set.id,
      due_at: new Date().toISOString(),
      interval_days: 6,
      ease: 2.5,
      reps: 2,
      lapses: 0,
      last_result: 'correct',
    });
  }

  await A.client.from('document_pages').insert({
    user_id: A.userId,
    document_id: doc?.id ?? null,
    page_index: 0,
    text: 'probe page text',
    readability: 0.9,
  });

  // Phase 10: a note for A. This is the strongest case in the whole app for
  // this test — every other table holds something DERIVED from what a student
  // uploaded, and `notes` holds what they actually wrote, in their own words,
  // during a lecture. If anything here must not leak, it is this.
  await A.client.from('notes').insert({
    user_id: A.userId,
    title: 'probe note title',
    body: 'probe note body — private to A',
  });

  // Phase 9c: A's assistant usage for today. It holds no content, but the count
  // is a behavioural record — how much someone leaned on help, and on which
  // days — and it is the same class of thing as review_state.
  await A.client.from('chat_usage').insert({
    user_id: A.userId,
    day: new Date().toISOString().slice(0, 10),
    messages: 1,
  });

  // Phase 9b: A's streak days — the last user-scoped table this test did not
  // cover. It survives deleting a set on purpose (it references only
  // auth.users), so it is the one record here that outlives everything else a
  // student might tidy away, and a leak would expose exactly when someone
  // studies and how long they have kept it up.
  //
  // Seeded on a SENTINEL DAY rather than today, which is the difference between
  // a test and a bug. `study_days` is real streak data on this account, so a
  // row dated today would join A's actual run and the cleanup below would then
  // delete a day they really studied. No day in 2000 can be genuine, the unique
  // (user_id, day) constraint makes a re-run idempotent, and deleting exactly
  // that day cannot touch anything real.
  await A.client
    .from('study_days')
    .upsert({ user_id: A.userId, day: STUDY_DAY_PROBE, answers: 1 }, { onConflict: 'user_id,day' });

  const storagePath = `${A.userId}/${doc?.id ?? 'x'}/probe.txt`;
  const upload = await A.client.storage
    .from('documents')
    .upload(storagePath, new Blob(['probe']), { upsert: true });
  if (upload.error) console.log(`  (storage seed note: ${upload.error.message})`);

  console.log('Seeded.\n');

  // ------------------------------------------------------- base tables ----
  console.log('B reading A\'s base tables (all must return zero rows):');
  const tables = [
    'study_sets',
    'documents',
    'document_pages',
    'study_items',
    'attempts',
    // Phase 6. Holds no notes, but it maps a user's item ids to a study
    // rhythm — leaking it would leak what someone is struggling with.
    'review_state',
    // Phase 10. Holds a student's own writing, verbatim. Every other table
    // here holds something derived from what they uploaded; this one holds
    // what they typed.
    'notes',
    // Phase 9c. No content, but a per-day record of how much someone leaned on
    // the assistant.
    'chat_usage',
    // Phase 9b. When someone studies and how long they have kept it up. The
    // only user-scoped table that deliberately survives deleting a set, so it
    // is also the longest-lived record of a person's habits in the database.
    'study_days',
  ] as const;

  for (const table of tables) {
    const { data, error } = await B.client.from(table).select('*');
    if (error) {
      ok(table, `blocked (${error.code ?? 'error'})`);
      continue;
    }
    const leaked = (data ?? []).filter((r: Record<string, unknown>) => r.user_id === A.userId);
    if (leaked.length > 0) fail(table, `LEAKED ${leaked.length} of A's rows`);
    else ok(table, `${data?.length ?? 0} own rows, 0 of A's`);
  }

  // ------------------------------------------------------------ profiles --
  const { data: profs } = await B.client.from('profiles').select('*');
  const aProfile = (profs ?? []).find((p: Record<string, unknown>) => p.id === A.userId);
  if (aProfile) fail('profiles', "B can read A's profile row");
  else ok('profiles', "A's row not visible");

  // The specific one that matters: the stored Gemini key.
  const serialized = JSON.stringify(profs ?? []);
  if (serialized.includes('A-SECRET-KEY-VALUE')) {
    fail('profiles.gemini_api_key', "B CAN READ A'S GEMINI KEY");
  } else {
    ok('profiles.gemini_api_key', "A's key not readable by B");
  }

  // ---------------------------------------------------------------- views --
  // Non-vacuity guard, FIRST. "B sees 0 rows" proves nothing if the view is
  // simply empty — a passing test that asserts nothing is worse than no test.
  // A must see their own rows before B's zero means anything.
  console.log('\nA can see their own view rows (guards against a vacuous pass):');
  for (const view of VIEWS) {
    const { data, error } = await A.client.from(view).select('*');
    if (error) {
      // A view this test knows about may have been RETIRED rather than broken.
      // `topic_stats` is dropped by migration 0015 — measured useless, roughly
      // one card per label — and migrations here are applied by hand, so this
      // script has to be correct both before and after that happens. Treating
      // "gone" as a failure would make the test cry wolf for however long the
      // two are out of step, which is how a suite stops being believed.
      if (RETIRED_VIEWS.includes(view) && isMissingRelation(error)) {
        console.log(`  ----  ${view} — retired (migration 0015), no longer checked`);
        continue;
      }
      fail(`${view} (as A)`, `A cannot read own rows: ${error.message}`);
    } else if ((data ?? []).length === 0) {
      fail(`${view} (as A)`, 'view is EMPTY for its owner — B seeing 0 rows proves nothing');
    } else {
      ok(`${view} (as A)`, `${data!.length} own row(s) visible`);
    }
  }

  // The reason security_invoker = true exists. Without it these two leak
  // everything while every check above still passes.
  console.log('\nB reading the VIEWS (security_invoker must make RLS apply):');
  for (const view of VIEWS) {
    const { data, error } = await B.client.from(view).select('*');
    if (error) {
      if (RETIRED_VIEWS.includes(view) && isMissingRelation(error)) continue;
      ok(view, `blocked (${error.code ?? 'error'})`);
      continue;
    }
    const leaked = (data ?? []).filter((r: Record<string, unknown>) => r.user_id === A.userId);
    if (leaked.length > 0) {
      fail(view, `LEAKED ${leaked.length} of A's rows — is security_invoker set?`);
    } else {
      ok(view, `${data?.length ?? 0} own rows, 0 of A's`);
    }
  }

  // -------------------------------------------------------------- storage --
  console.log('\nB reaching A\'s storage objects:');
  const dl = await B.client.storage.from('documents').download(storagePath);
  if (dl.data) fail('storage download', "B downloaded A's file");
  else ok('storage download', 'blocked');

  const ls = await B.client.storage.from('documents').list(A.userId);
  if ((ls.data?.length ?? 0) > 0) fail('storage list', "B listed A's folder");
  else ok('storage list', 'nothing visible');

  const wr = await B.client.storage
    .from('documents')
    .upload(`${A.userId}/intruder.txt`, new Blob(['x']));
  if (!wr.error) fail('storage write', "B wrote into A's prefix");
  else ok('storage write', 'blocked');

  // -------------------------------------------------------------- heartbeat --
  console.log('\nHeartbeat table is RPC-only:');
  const hbDirect = await B.client.from('heartbeat').insert({});
  if (!hbDirect.error) fail('heartbeat direct insert', 'direct write allowed; RLS not enforced');
  else ok('heartbeat direct insert', 'blocked');

  const hbRpc = await B.client.rpc('touch_heartbeat');
  if (hbRpc.error) fail('touch_heartbeat RPC', `RPC failed: ${hbRpc.error.message}`);
  else ok('touch_heartbeat RPC', 'write succeeded through the RPC');

  // --------------------------------------------------------------- tidy up --
  //
  // Every run used to leave its probe set, note and usage row behind, and they
  // accumulated: four study_sets on the test account, two of them called
  // "Isolation probe set". That is the hazard this project has already paid
  // for once — synthetic data left in a shared test account produced a wrong
  // conclusion (NOTES §9.4) — so the test now clears up after itself.
  //
  // Deleting the set cascades its documents, pages, items, attempts and
  // schedules. Matched by title rather than by the id from this run, so a
  // sweep also collects what earlier runs left.
  await A.client.storage.from('documents').remove([storagePath]);
  await A.client.from('notes').delete().eq('title', 'probe note title');
  await A.client
    .from('chat_usage')
    .delete()
    .eq('day', new Date().toISOString().slice(0, 10));
  // Exact, and safe because no real streak day can fall on the sentinel.
  await A.client.from('study_days').delete().eq('day', STUDY_DAY_PROBE);
  const { error: sweepError } = await A.client
    .from('study_sets')
    .delete()
    .eq('title', 'Isolation probe set');
  if (sweepError) console.log(`  (cleanup note: ${sweepError.message})`);

  // ---------------------------------------------------------------- report --
  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.error(`${failures} ISOLATION FAILURE(S). Do not deploy.`);
    process.exit(1);
  }
  console.log('No cross-user access. Isolation holds.');
}

main().catch((err) => {
  console.error('\nIsolation test could not run:', err instanceof Error ? err.message : err);
  process.exit(2);
});
