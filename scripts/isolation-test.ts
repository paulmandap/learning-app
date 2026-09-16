/**
 * Cross-user isolation test (spec §7).
 *
 * Signs in as two real users against the live project and asserts what user B
 * can and cannot reach of user A's data. This is the only test that can prove
 * RLS, because RLS is enforced by Postgres, not by anything we could unit test.
 *
 * ## The claim this script makes changed with migration 0021
 *
 * It used to be "B cannot reach ANY of A's data", full stop. Since sets can be
 * shared with everyone, that sentence is no longer the guarantee — and a test
 * still asserting it would have to be either wrong or weakened until it proved
 * nothing. The claim is now narrower and it is checked in BOTH directions:
 *
 *   B reaches exactly three things of A's, and only when A chose it:
 *     - a set A SHARED, and its cards, through public_sets / public_set_items
 *     - A's chosen name and drawn face, through public_profiles
 *     - what A said in the global chat
 *
 *   B reaches nothing else. In particular, and asserted separately below:
 *     - A's PRIVATE set stays invisible even while another of A's sets is shared
 *     - the base tables still return zero of A's rows — no policy was relaxed,
 *       and this is the guard that says so
 *     - A's uploaded photo, files, notes, pages, schedule and Gemini key
 *
 * The POSITIVE assertions matter as much as the negative ones here. The four
 * cross-user views run as their owner, and if that ever stopped bypassing RLS
 * they would return nothing at all — the Community tab would look like "nobody
 * has shared anything yet" and every negative assertion below would still pass.
 *
 * Coverage, each asserted separately:
 *   - every user-scoped base table: study_sets, documents, document_pages,
 *     study_items, attempts, review_state (Phase 6), notes (0012),
 *     chat_usage (0010), study_days (0009), and Nomi's saved conversations,
 *     nomi_conversations and nomi_messages (0016)
 *   - B writing a message into A's conversation, which RLS must refuse
 *   - reminders (0020): push_subscriptions and reminder_settings, a direct
 *     write of a device, and the sender's functions refusing anyone without
 *     its secret
 *   - storage objects under A's prefix in every bucket: documents, avatars and
 *     note-images (each checked once its migration is applied)
 *   - item_stats and topic_stats  <-- the views, tested in their own right
 *   - storage objects under A's prefix
 *   - profiles.gemini_api_key specifically
 *   - heartbeat: direct writes refused, the RPC accepted
 *   - community (0021), both directions: B DOES see A's shared set, its cards
 *     and A's name; B does NOT see A's private set on the same account, the
 *     reported card inside the shared one, A's generation plan, A's key, A's
 *     uploaded photo, A's due dates, or anything extra through study_sets and
 *     study_items directly. Plus: starring a private set is refused, a star
 *     cannot be given in someone else's name, nobody can see WHO starred what,
 *     one room means B reads what A said, B cannot delete A's message, two
 *     people can each schedule the same shared card (0022), and unsharing
 *     actually takes the set and its cards away again
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
 * A's shared set, and the two things said in the chat.
 *
 * Distinctive strings rather than ids, so the cleanup at the end also sweeps up
 * whatever an earlier run left behind when it failed part way — the same reason
 * the private probe set is deleted by title.
 */
const SHARED_SET_TITLE = 'Isolation probe SHARED set';
const CHAT_PROBE_A = 'isolation probe message from A';
const CHAT_PROBE_B = 'isolation probe message from B';

/**
 * A token that appears ONLY on A's private card.
 *
 * It exists because the first version of this test searched the shared view's
 * response for the private card's excerpt, `probe excerpt` — and the shared
 * card's excerpt is `shared probe excerpt`, which ENDS with it. Serialized, the
 * shared row reads `"source_excerpt":"shared probe excerpt"`, so a search for
 * `probe excerpt"` matched the shared card's own closing quote and the test
 * reported **A'S PRIVATE CARD IS EXPOSED** on 2026-09-16 against a view that was
 * returning exactly one correct row (NOTES §46.8).
 *
 * A sentinel that can be a substring of the thing it is distinguished from is
 * not a sentinel. This one cannot appear anywhere else.
 */
const PRIVATE_MARKER = 'private-only-a7f3c1';

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
      // Carries PRIVATE_MARKER so the shared view can be searched for it — see
      // the note on that constant for why it is not just 'probe excerpt'.
      source_excerpt: `probe excerpt ${PRIVATE_MARKER}`,
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

  // 0016: a conversation with Nomi. After notes, the most personal thing here —
  // what someone chose to say, in their own words, to what feels like a friend.
  // Seeded only if the tables exist; before the migration they cannot leak, and
  // counting "blocked: no such table" as a pass would be a vacuous one.
  const convo = await A.client
    .from('nomi_conversations')
    .insert({ user_id: A.userId, title: 'probe conversation' })
    .select('id')
    .single();
  const nomiSeeded = !convo.error;
  if (nomiSeeded) {
    await A.client.from('nomi_messages').insert({
      conversation_id: (convo.data as { id: string }).id,
      user_id: A.userId,
      role: 'user',
      content: 'probe message — private to A',
    });
  } else {
    console.log(`  (nomi tables not seeded: ${convo.error?.message} — is 0016 applied?)`);
  }

  // 0020: a device that gets A's reminders, and when. An address that puts a
  // notification on A's phone, and the hours A wants to be reminded.
  const reminderEndpoint = 'https://push.example.test/isolation-probe';
  const deviceKeys = { p_p256dh: `B${'A'.repeat(86)}`, p_auth: 'A'.repeat(22) };
  const deviceSeed = await A.client.rpc('save_push_subscription', { p_endpoint: reminderEndpoint, ...deviceKeys });
  const remindersSeeded = !deviceSeed.error;
  if (remindersSeeded) {
    await A.client.from('reminder_settings').upsert({ user_id: A.userId, slots: ['evening'] }, { onConflict: 'user_id' });
  } else {
    console.log(`  (reminders not seeded: ${deviceSeed.error?.message} — is 0020 applied?)`);
  }

  // TWO photos, and the difference between them is the whole point (0023): one
  // A merely uploaded, one A is actually using. Only the second may be readable
  // by anybody else.
  const avatarPath = `${A.userId}/avatar-probe.jpg`;
  const chosenPath = `${A.userId}/avatar-probe-chosen.jpg`;
  const avatarUpload = await A.client.storage
    .from('avatars')
    .upload(avatarPath, new Blob(['probe'], { type: 'image/jpeg' }), { upsert: true });
  const avatarsSeeded = !avatarUpload.error;
  if (!avatarsSeeded) console.log(`  (avatar seed note: ${avatarUpload.error?.message})`);

  let chosenAvatarPath: string | null = null;
  if (avatarsSeeded) {
    const chosenUpload = await A.client.storage
      .from('avatars')
      .upload(chosenPath, new Blob(['chosen'], { type: 'image/jpeg' }), { upsert: true });
    if (!chosenUpload.error) {
      // Only counts as "in use" once the profile actually points at it.
      const { error } = await A.client
        .from('profiles')
        .update({ avatar: `photo:${chosenPath}` })
        .eq('id', A.userId);
      if (!error) chosenAvatarPath = chosenPath;
      else console.log(`  (chosen avatar not set: ${error.message} — is 0023 applied?)`);
    }
  }

  // Pictures in notes (0018): photos of someone's own notes and diagrams.
  const notePicturePath = `${A.userId}/isolation-probe/picture.jpg`;
  const notePictureUpload = await A.client.storage
    .from('note-images')
    .upload(notePicturePath, new Blob(['probe'], { type: 'image/jpeg' }), { upsert: true });
  const notePicturesSeeded = !notePictureUpload.error;
  if (!notePicturesSeeded) console.log(`  (note picture seed note: ${notePictureUpload.error?.message})`);

  // 0021: a SECOND set, which A shares with everyone. Two sets is the whole
  // point — one shared and one private, on the same account, so "B can see A's
  // set" and "B cannot see A's set" are both assertable at once. A test with
  // only a shared set could not tell a correct filter from no filter at all.
  const { data: sharedSet, error: sharedErr } = await A.client
    .from('study_sets')
    .insert({
      user_id: A.userId,
      title: SHARED_SET_TITLE,
      status: 'ready',
      visibility: 'public',
      published_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  const communitySeeded = !sharedErr && !!sharedSet;
  let sharedItemId: string | null = null;
  if (communitySeeded) {
    // A name on the profile, so public_profiles has something to show and
    // "B sees A's name" is not vacuously true of an empty column.
    //
    // It sets the NAME ONLY, and that is load-bearing. This block runs AFTER
    // the avatar seeding above, so an `avatar:` here would overwrite the photo
    // that block just pointed the profile at — and then `is_chosen_avatar` would
    // rightly answer false, the download would be rightly refused, and the test
    // would report two failures against a policy doing exactly its job.
    // Measured 2026-09-16, on the first run after 0023 was applied.
    await A.client.from('profiles').update({ display_name: 'Probe A' }).eq('id', A.userId);

    const { data: sharedItem } = await A.client
      .from('study_items')
      .insert({
        user_id: A.userId,
        study_set_id: (sharedSet as { id: string }).id,
        document_id: doc?.id ?? null,
        page_index: 0,
        kind: 'flashcard',
        level: 'remember',
        prompt: 'shared probe prompt',
        answer: 'shared probe answer',
        source_excerpt: 'shared probe excerpt',
        excerpt_verified: true,
      })
      .select('id')
      .single();
    sharedItemId = (sharedItem as { id: string } | null)?.id ?? null;

    // A reported card in the SAME shared set. It must not reach B: `hidden`
    // has always removed a card from every deck for its owner, and sharing
    // must not be a way around that for everyone else.
    await A.client.from('study_items').insert({
      user_id: A.userId,
      study_set_id: (sharedSet as { id: string }).id,
      kind: 'flashcard',
      level: 'remember',
      prompt: 'shared probe REPORTED prompt',
      answer: 'shared probe reported answer',
      source_excerpt: 'shared probe reported excerpt',
      excerpt_verified: true,
      hidden: true,
    });
  } else {
    console.log(`  (community not seeded: ${sharedErr?.message} — is 0021 applied?)`);
  }

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
    // 0016. What a student said to Nomi, and the names of those conversations.
    'nomi_conversations',
    'nomi_messages',
    // 0020. An address that puts a notification on someone's phone, and when
    // they want to be reminded to study.
    'push_subscriptions',
    'reminder_settings',
  ] as const;

  for (const table of tables) {
    if ((table === 'nomi_conversations' || table === 'nomi_messages') && !nomiSeeded) {
      console.log(`  ----  ${table} — not present (migration 0016), not checked`);
      continue;
    }
    if ((table === 'push_subscriptions' || table === 'reminder_settings') && !remindersSeeded) {
      console.log(`  ----  ${table} — not present (migration 0020), not checked`);
      continue;
    }
    const { data, error } = await B.client.from(table).select('*');
    if (error) {
      ok(table, `blocked (${error.code ?? 'error'})`);
      continue;
    }
    const leaked = (data ?? []).filter((r: Record<string, unknown>) => r.user_id === A.userId);
    if (leaked.length > 0) fail(table, `LEAKED ${leaked.length} of A's rows`);
    else ok(table, `${data?.length ?? 0} own rows, 0 of A's`);
  }

  // The insert policy, not only the select one. Knowing someone's conversation
  // id must not let you write into it under your own name.
  if (nomiSeeded) {
    const intrusion = await B.client.from('nomi_messages').insert({
      conversation_id: (convo.data as { id: string }).id,
      user_id: B.userId,
      role: 'user',
      content: 'intruder',
    });
    if (!intrusion.error) fail('nomi_messages write', "B wrote a message into A's conversation");
    else ok('nomi_messages write', `blocked (${intrusion.error.code ?? 'error'})`);
  }

  // 0020. A device is added only through save_push_subscription, and the
  // sender's functions answer only to its secret — never to a signed-in person,
  // and never to the publishable key with a guess.
  if (remindersSeeded) {
    const direct = await B.client
      .from('push_subscriptions')
      .insert({ user_id: A.userId, endpoint: 'https://push.example.test/intruder', p256dh: deviceKeys.p_p256dh, auth: deviceKeys.p_auth });
    if (!direct.error) fail('push_subscriptions write', "B wrote a device into A's reminders");
    else ok('push_subscriptions write', `blocked (${direct.error.code ?? 'error'})`);

    const asPerson = await B.client.rpc('reminders_to_send', { p_secret: 'a guess', p_slot: 'evening' });
    if (!asPerson.error) fail('reminders_to_send as B', 'a signed-in person read who gets reminders');
    else ok('reminders_to_send as B', `blocked (${asPerson.error.code ?? 'error'})`);

    const anon = createClient(url!, publishable!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const guessed = await anon.rpc('reminders_to_send', { p_secret: 'a guess', p_slot: 'evening' });
    if (!guessed.error) fail('reminders_to_send without the secret', 'answered a wrong secret');
    else ok('reminders_to_send without the secret', `refused (${guessed.error.code ?? 'error'})`);

    const marked = await anon.rpc('reminders_sent', { p_secret: 'a guess', p_sent: [], p_gone: [] });
    if (!marked.error) fail('reminders_sent without the secret', 'answered a wrong secret');
    else ok('reminders_sent without the secret', `refused (${marked.error.code ?? 'error'})`);

    const hash = await B.client.from('reminder_sender').select('*');
    if ((hash.data ?? []).length > 0) fail('reminder_sender', "the sender's secret hash is readable");
    else ok('reminder_sender', 'nothing readable');
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

  // ------------------------------------------------------------ community --
  //
  // The only place in this script where B is SUPPOSED to see something of A's.
  // Read the header before changing anything here: the negative assertions are
  // worthless on their own, because a definer view that had stopped bypassing
  // RLS would return nothing and pass every one of them while the feature
  // quietly showed an empty tab.
  if (communitySeeded) {
    console.log('\nWhat B may see of A (0021 — shared on purpose):');

    // POSITIVE. A shared it; B must find it.
    const { data: publicSets, error: psErr } = await B.client.from('public_sets').select('*');
    if (psErr) {
      fail('public_sets (as B)', `B cannot read shared sets at all: ${psErr.message}`);
    } else {
      const rows = (publicSets ?? []) as Record<string, unknown>[];
      const shared = rows.find((r) => r.id === (sharedSet as { id: string }).id);
      if (!shared) {
        fail('public_sets (as B)', "B cannot see A's SHARED set — does the view still bypass RLS?");
      } else {
        ok('public_sets (as B)', `A's shared set visible, ${String(shared.cards)} card(s)`);
      }

      // NEGATIVE, and the one that matters most on this line: A's OTHER set is
      // private, on the same account, and must not have come along with it.
      if (rows.some((r) => r.id === set.id)) {
        fail('public_sets (private set)', "B CAN SEE A'S PRIVATE SET through public_sets");
      } else {
        ok('public_sets (private set)', "A's private set not in the shared list");
      }

      // The plan quotes A's notes and is not a column of this view.
      if (JSON.stringify(rows).includes('"plan"')) {
        fail('public_sets (plan)', 'the generation plan is exposed');
      } else {
        ok('public_sets (plan)', 'no generation plan');
      }
    }

    // POSITIVE, then NEGATIVE, on the cards.
    const { data: sharedItems, error: siErr } = await B.client
      .from('public_set_items')
      .select('*');
    if (siErr) {
      fail('public_set_items (as B)', `B cannot read shared cards at all: ${siErr.message}`);
    } else {
      const rows = (sharedItems ?? []) as Record<string, unknown>[];
      const serialized = JSON.stringify(rows);

      if (!rows.some((r) => r.id === sharedItemId)) {
        fail('public_set_items (as B)', "B cannot see the SHARED set's card");
      } else {
        ok('public_set_items (as B)', `${rows.length} shared card(s) visible`);
      }

      // A's private set's card must not be here — checked by the set's id AND
      // by a marker that appears nowhere else, because the two answers failing
      // together is much stronger evidence than either alone.
      //
      // Note what is NOT asserted: that every row belongs to A's probe set.
      // public_set_items serves every shared set in the app, so on a database
      // where somebody has really shared something, that would fail for the
      // right reason and look like the wrong one.
      const fromPrivate = rows.filter((r) => r.study_set_id === set.id);
      const marked = serialized.includes(PRIVATE_MARKER);
      if (fromPrivate.length > 0 || marked) {
        fail(
          'public_set_items (private set)',
          `A'S PRIVATE CARD IS EXPOSED — ${fromPrivate.length} row(s) carry the private set's id` +
            `${marked ? `, and ${PRIVATE_MARKER} is in the response` : ''}`,
        );
      } else {
        ok('public_set_items (private set)', "A's private card not exposed");
      }

      // A reported card is gone for everyone, not only for its owner.
      if (serialized.includes('REPORTED')) {
        fail('public_set_items (reported)', 'a reported card is served to other people');
      } else {
        ok('public_set_items (reported)', 'reported card not served');
      }

      // Nothing here may point at A's files. document_id is deliberately not a
      // column of the view — with it, the screen would offer "Open page" for a
      // file in A's private bucket.
      if (rows.length > 0 && 'document_id' in rows[0]!) {
        fail('public_set_items (files)', 'document_id is exposed; it points into A’s bucket');
      } else {
        ok('public_set_items (files)', 'no link to the owner’s files');
      }
    }

    // POSITIVE: a name and a face. NEGATIVE: the key, and the uploaded photo.
    const { data: profiles, error: ppErr } = await B.client.from('public_profiles').select('*');
    if (ppErr) {
      fail('public_profiles (as B)', `B cannot read names at all: ${ppErr.message}`);
    } else {
      const rows = (profiles ?? []) as Record<string, unknown>[];
      const aRow = rows.find((r) => r.id === A.userId);
      if (!aRow) {
        fail('public_profiles (as B)', "B cannot see A's name — the chat would attribute nothing");
      } else if (aRow.display_name !== 'Probe A') {
        fail('public_profiles (as B)', `expected A's chosen name, got ${String(aRow.display_name)}`);
      } else {
        ok('public_profiles (as B)', "A's chosen name and face visible");
      }

      const serialized = JSON.stringify(rows);
      if (serialized.includes('A-SECRET-KEY-VALUE') || serialized.includes('gemini_api_key')) {
        fail('public_profiles (key)', "B CAN READ A'S GEMINI KEY THROUGH THE VIEW");
      } else {
        ok('public_profiles (key)', 'no Gemini key');
      }
      // Since 0023 a photo path is SUPPOSED to be here — but only the one that
      // person is using. A path A merely uploaded and replaced must not appear;
      // `avatar-probe.jpg` is exactly that photo.
      if (serialized.includes('avatar-probe.jpg')) {
        fail('public_profiles (spare photo)', "a photo A is NOT using is exposed");
      } else {
        ok('public_profiles (spare photo)', 'only the picture in use');
      }
    }

    // THE REGRESSION GUARD. Sharing must not have widened a base table. If a
    // permissive policy is ever added to study_sets or study_items, every query
    // in the app that trusts RLS as its only filter widens with it — starting
    // with the unfiltered read on the Progress screen, which would begin
    // counting other people's cards as yours, silently.
    for (const table of ['study_sets', 'study_items'] as const) {
      const { data } = await B.client.from(table).select('id, user_id');
      const leaked = (data ?? []).filter((r: Record<string, unknown>) => r.user_id === A.userId);
      if (leaked.length > 0) {
        fail(`${table} (base table, A sharing)`, `${leaked.length} of A's rows readable directly`);
      } else {
        ok(`${table} (base table, A sharing)`, "0 of A's rows, even with a set shared");
      }
    }

    // ---- stars ----
    const starOwn = await B.client
      .from('set_stars')
      .insert({ user_id: B.userId, study_set_id: (sharedSet as { id: string }).id });
    if (starOwn.error) fail('set_stars insert', `B cannot star a shared set: ${starOwn.error.message}`);
    else ok('set_stars insert', "B starred A's shared set");

    // A private set cannot be starred — can_star_set says so, and it is a
    // definer function precisely so a policy can ask about a row B cannot read.
    const starPrivate = await B.client
      .from('set_stars')
      .insert({ user_id: B.userId, study_set_id: set.id });
    if (!starPrivate.error) fail('set_stars (private set)', "B starred A's PRIVATE set");
    else ok('set_stars (private set)', `blocked (${starPrivate.error.code ?? 'error'})`);

    // And a star cannot be given in somebody else's name.
    const starAsA = await B.client
      .from('set_stars')
      .insert({ user_id: A.userId, study_set_id: (sharedSet as { id: string }).id });
    if (!starAsA.error) fail('set_stars (as A)', 'B gave a star in A’s name');
    else ok('set_stars (as A)', `blocked (${starAsA.error.code ?? 'error'})`);

    // Who starred what is nobody's business: the count is public, the rows are
    // not. B has just starred A's set; A must not be able to see that row.
    const starsAsA = await A.client.from('set_stars').select('*');
    const seenB = (starsAsA.data ?? []).filter((r: Record<string, unknown>) => r.user_id === B.userId);
    if (seenB.length > 0) fail('set_stars (who)', 'A can see who starred their set');
    else ok('set_stars (who)', 'stars are counted, not named');

    // The count, computed inside the view where set_stars' own policy cannot
    // reach. If this is 0 the ranking is broken even though every row exists.
    const counted = await A.client
      .from('public_sets')
      .select('stars')
      .eq('id', (sharedSet as { id: string }).id)
      .maybeSingle();
    const stars = Number((counted.data as { stars?: number } | null)?.stars ?? 0);
    if (stars < 1) fail('public_sets.stars', `star given but the view counts ${stars}`);
    else ok('public_sets.stars', `${stars} counted`);

    // ---- the global chat ----
    const sentA = await A.client.rpc('send_global_message', { message: CHAT_PROBE_A });
    const sentB = await B.client.rpc('send_global_message', { message: CHAT_PROBE_B });
    if (sentA.error || sentB.error) {
      fail('send_global_message', `${sentA.error?.message ?? ''} ${sentB.error?.message ?? ''}`.trim());
    } else {
      ok('send_global_message', 'both accounts sent a message');
    }

    // POSITIVE: one room means B reads what A said, with A's name beside it.
    const { data: chat, error: chatErr } = await B.client.from('global_chat').select('*');
    if (chatErr) {
      fail('global_chat (as B)', `B cannot read the chat: ${chatErr.message}`);
    } else {
      const rows = (chat ?? []) as Record<string, unknown>[];
      const fromA = rows.find((r) => r.body === CHAT_PROBE_A);
      if (!fromA) fail('global_chat (as B)', "B cannot see A's message in a shared room");
      else if (fromA.author_name !== 'Probe A') fail('global_chat (as B)', 'a message with no name beside it');
      else ok('global_chat (as B)', "A's message readable, attributed to A");

      if (JSON.stringify(rows).includes('avatar-probe.jpg')) {
        fail('global_chat (spare photo)', "a photo A is NOT using is exposed");
      } else {
        ok('global_chat (spare photo)', 'only the picture in use');
      }
    }

    // NEGATIVE: you can take back what YOU said, and nothing else.
    const { data: aMsg } = await A.client
      .from('global_messages')
      .select('id')
      .eq('body', CHAT_PROBE_A)
      .maybeSingle();
    if (aMsg) {
      await B.client.from('global_messages').delete().eq('id', (aMsg as { id: string }).id);
      const still = await A.client.from('global_messages').select('id').eq('body', CHAT_PROBE_A);
      if ((still.data ?? []).length === 0) fail('global_messages delete', "B DELETED A'S MESSAGE");
      else ok('global_messages delete', "A's message survived B's delete");
    }

    // ---- my_schedule ----
    // A's due dates are A's. The view's privilege exists to look up the CARD
    // beside a schedule row, never to read somebody else's schedule.
    const { data: sched, error: schedErr } = await B.client.from('my_schedule').select('*');
    if (schedErr) {
      fail('my_schedule (as B)', `unreadable: ${schedErr.message}`);
    } else if ((sched ?? []).some((r: Record<string, unknown>) => r.study_item_id === item?.id)) {
      fail('my_schedule (as B)', "B can see A's due dates");
    } else {
      ok('my_schedule (as B)', "0 of A's schedule rows");
    }

    // ---- one schedule per card PER PERSON (0021 + 0022) ----
    // A has scheduled a card. B studying a SHARED card needs their own row for
    // it. This is the assertion that says whether 0022 has been applied yet:
    // under 0005's single-column unique, B's upsert targets a row RLS hides
    // from them and is refused or writes nothing at all.
    if (sharedItemId) {
      await A.client.from('review_state').insert({
        user_id: A.userId,
        study_item_id: sharedItemId,
        study_set_id: (sharedSet as { id: string }).id,
        due_at: new Date().toISOString(),
        interval_days: 1,
        ease: 2.5,
        reps: 1,
        lapses: 0,
        last_result: 'correct',
      });

      const bSchedule = await B.client.from('review_state').upsert(
        {
          user_id: B.userId,
          study_item_id: sharedItemId,
          study_set_id: (sharedSet as { id: string }).id,
          due_at: new Date().toISOString(),
          interval_days: 1,
          ease: 2.5,
          reps: 1,
          lapses: 0,
          last_result: 'correct',
        },
        { onConflict: 'user_id,study_item_id' },
      );

      if (bSchedule.error) {
        fail(
          'review_state (two people, one card)',
          `${bSchedule.error.message} (${bSchedule.error.code ?? 'no code'}) — ` +
            'apply 0022, which drops the old single-column unique on study_item_id',
        );
      } else {
        const mine = await B.client
          .from('review_state')
          .select('user_id')
          .eq('study_item_id', sharedItemId);
        if ((mine.data ?? []).length === 0) {
          fail('review_state (two people, one card)', 'the upsert reported success and wrote nothing');
        } else {
          ok('review_state (two people, one card)', 'B has their own schedule for a shared card');
        }
      }
    }

    // ---- unsharing is live ----
    // The filter is one line in each view. Turning it back off must actually
    // take the set away, or "stop sharing" is a button that does nothing.
    await A.client.from('study_sets').update({ visibility: 'private' }).eq('id', (sharedSet as { id: string }).id);
    const after = await B.client
      .from('public_sets')
      .select('id')
      .eq('id', (sharedSet as { id: string }).id);
    if ((after.data ?? []).length > 0) fail('unsharing', 'an unshared set is still listed');
    else ok('unsharing', 'the set went away when A stopped sharing');

    const cardsAfter = await B.client
      .from('public_set_items')
      .select('id')
      .eq('study_set_id', (sharedSet as { id: string }).id);
    if ((cardsAfter.data ?? []).length > 0) fail('unsharing (cards)', "an unshared set's cards are still readable");
    else ok('unsharing (cards)', 'its cards went with it');
  } else {
    console.log('\n  ----  community — not present (migration 0021), not checked');
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

  // A profile photo is a picture of a person.
  //
  // Since 0023 this is the sharpest pair of assertions in the file, because the
  // two photos differ only in whether A is USING one of them. `avatarPath` is a
  // spare upload; `chosenAvatarPath` is the value in A's profiles.avatar. The
  // first must stay private and the second must be readable — if the policy
  // were written as "any file in the avatars bucket" both would pass a naive
  // test and every photo anybody had ever uploaded would be published,
  // including the ones they replaced because they did not like them.
  if (avatarsSeeded) {
    // Listing is a SELECT on storage.objects, so 0023's read policy necessarily
    // makes the chosen photo listable — there is no way to serve a file and
    // hide its name. What must not happen is the rest of the folder coming with
    // it: the filenames are `avatar-<timestamp>.jpg`, so a full listing would
    // say how many pictures somebody has tried and when they changed each one.
    //
    // Before 0023 this was "nothing visible", and that assertion failing on the
    // first run after it was applied is the policy working, not leaking.
    const avLs = await B.client.storage.from('avatars').list(A.userId);
    const listed = (avLs.data ?? []).map((f) => f.name);
    const spares = listed.filter((n) => n !== chosenPath.split('/')[1]);
    if (spares.length > 0) {
      fail('avatars list', `B listed picture(s) A is not using: ${spares.join(', ')}`);
    } else {
      ok('avatars list', listed.length === 0 ? 'nothing visible' : 'only the picture in use');
    }

    const avWr = await B.client.storage
      .from('avatars')
      .upload(`${A.userId}/intruder.jpg`, new Blob(['x'], { type: 'image/jpeg' }));
    if (!avWr.error) fail('avatars write', "B wrote into A's picture folder");
    else ok('avatars write', 'blocked');

    // NEGATIVE: a photo A uploaded but is not using.
    const spare = await B.client.storage.from('avatars').download(avatarPath);
    if (spare.data) fail('avatars download (not in use)', "B downloaded a photo A is NOT using");
    else ok('avatars download (not in use)', 'blocked');

    // Is 0023 applied? Asked directly, because otherwise a database without it
    // fails the positive check below and reports a leak-shaped alarm for a
    // migration that simply has not been pasted yet — the same reason this
    // script gates the Nomi and reminder checks on their own seeds.
    const gate = await B.client.rpc('is_chosen_avatar', { object_name: 'nobody/none.jpg' });
    const picturesShared = !(gate.error?.code === 'PGRST202' || gate.error?.code === '42883');

    if (chosenAvatarPath && !picturesShared) {
      console.log('  ----  avatars download (in use) — pictures not shared yet (migration 0023), not checked');
    } else if (chosenAvatarPath) {
      // POSITIVE: the one A is using. Without this the negative above passes
      // just as well against a policy that serves nobody, and the chat would
      // show a drawn face for everyone while looking entirely correct.
      const chosen = await B.client.storage.from('avatars').download(chosenAvatarPath);
      if (chosen.data) ok('avatars download (in use)', "B can see the picture A is using");
      else fail('avatars download (in use)', `B cannot see A's chosen picture: ${chosen.error?.message}`);

      // And the view hands out the path, or there is nothing to fetch.
      const shown = await B.client
        .from('public_profiles')
        .select('avatar')
        .eq('id', A.userId)
        .maybeSingle();
      const value = (shown.data as { avatar?: string } | null)?.avatar ?? '';
      if (value === `photo:${chosenAvatarPath}`) ok('public_profiles (picture)', 'the chosen photo is offered');
      else fail('public_profiles (picture)', `expected the chosen photo, got "${value}"`);
    }
  } else {
    console.log('  ----  avatars — bucket not present (migration 0016), not checked');
  }

  // A picture in a note is a photo of someone's own notes. Same three checks, third bucket.
  if (notePicturesSeeded) {
    const npDl = await B.client.storage.from('note-images').download(notePicturePath);
    if (npDl.data) fail('note-images download', "B downloaded a picture from A's note");
    else ok('note-images download', 'blocked');

    const npLs = await B.client.storage.from('note-images').list(A.userId);
    if ((npLs.data?.length ?? 0) > 0) fail('note-images list', "B listed A's note pictures");
    else ok('note-images list', 'nothing visible');

    const npWr = await B.client.storage
      .from('note-images')
      .upload(`${A.userId}/intruder/picture.jpg`, new Blob(['x'], { type: 'image/jpeg' }));
    if (!npWr.error) fail('note-images write', "B wrote into A's note pictures");
    else ok('note-images write', 'blocked');
  } else {
    console.log('  ----  note-images — bucket not present (migration 0018), not checked');
  }

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
  if (notePicturesSeeded) await A.client.storage.from('note-images').remove([notePicturePath]);
  if (avatarsSeeded) {
    // The profile must stop pointing at the chosen photo BEFORE it is removed,
    // or A is left with an avatar value whose file is gone. `parseAvatar` would
    // fall back to a face, so it is not a crash — but leaving a dangling
    // pointer on a shared test account is how a later run measures the wrong
    // thing (NOTES §9.4).
    if (chosenAvatarPath) await A.client.from('profiles').update({ avatar: 'face:3' }).eq('id', A.userId);
    await A.client.storage.from('avatars').remove([avatarPath, chosenPath]);
  }
  if (remindersSeeded) {
    await A.client.from('push_subscriptions').delete().eq('endpoint', reminderEndpoint);
    await A.client.from('reminder_settings').delete().eq('user_id', A.userId);
  }
  // Messages cascade from the conversation.
  if (nomiSeeded) await A.client.from('nomi_conversations').delete().eq('title', 'probe conversation');
  await A.client.from('notes').delete().eq('title', 'probe note title');
  await A.client
    .from('chat_usage')
    .delete()
    .eq('day', new Date().toISOString().slice(0, 10));
  // Exact, and safe because no real streak day can fall on the sentinel.
  await A.client.from('study_days').delete().eq('day', STUDY_DAY_PROBE);

  // 0021. Stars and messages do NOT cascade from a set — a star is a row about
  // somebody else's set and a message belongs to no set at all — so each side
  // deletes its own, which is all RLS allows either of them to do anyway.
  // Matched by value rather than by this run's ids, so a failed earlier run is
  // swept up too. The shared set is deleted with the private one below; its
  // stars go with it.
  if (communitySeeded) {
    await B.client.from('set_stars').delete().eq('user_id', B.userId);
    await A.client.from('global_messages').delete().eq('body', CHAT_PROBE_A);
    await B.client.from('global_messages').delete().eq('body', CHAT_PROBE_B);
    // B's schedule for A's shared card. It would cascade when the set goes, but
    // only if 0022 let it be written at all — delete it explicitly so a re-run
    // starts clean either way.
    if (sharedItemId) await B.client.from('review_state').delete().eq('study_item_id', sharedItemId);
    const { error: sharedSweep } = await A.client
      .from('study_sets')
      .delete()
      .eq('title', SHARED_SET_TITLE);
    if (sharedSweep) console.log(`  (cleanup note: ${sharedSweep.message})`);
  }

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
