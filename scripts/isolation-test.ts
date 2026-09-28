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
 *   - friends, blocks and reports (0026, NOTES §51), both directions: B finds A
 *     by username, asks, and only A can say yes; nobody can make themselves a
 *     friend, block, or report by writing to a table directly; a block ends the
 *     friendship and hides the two people from each other in every view and in
 *     search, and only the blocker can see or undo it; a report keeps the
 *     database's copy of what was said, is invisible to the person reported,
 *     cannot be deleted, and cannot be used to find a private set
 *   - posts (0027, NOTES §52), both directions: a friends-only post hidden from a
 *     stranger and shown to a friend; nothing written around create_post,
 *     add_comment or edit_post; no reacting, commenting or reporting on a post
 *     you cannot see; a post's author removing a comment on it and nobody else
 *     removing theirs; a streak brag counted by the database and nobody's streak
 *     readable; a photo readable only while its post is, and never postable from
 *     somebody else's folder; a block hiding posts both ways
 *   - messages between friends (0028, NOTES §53), both directions: nothing
 *     written around the functions; one conversation per pair; read, counted,
 *     marked read and "Seen"; only the sender edits or unsends; reactions in
 *     your own name only; a message reportable and the report invisible to its
 *     sender; unfriended, readable and closed; blocked, gone for both
 *   - the friends' leaderboard (0029, NOTES §54): a stranger's streak not on
 *     your board, a friend's on it, off when they turn it off (and only they
 *     can), gone across a block, and nobody's best streak readable directly
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

  // Both test accounts agree to the community rules (0030, NOTES §55): every
  // social act below is refused with 'RULES' until they have. A database
  // without 0030 has no such function, which is fine.
  await A.client.rpc('accept_community_rules');
  await B.client.rpc('accept_community_rules');
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

    // ---- reactions and edits (0025) ----
    // A reaction is readable by everyone on purpose — it is a reply, in a room
    // where everything is attributed — so what is asserted is that nobody can
    // react, un-react or edit IN SOMEBODY ELSE'S NAME.
    const reactionsProbe = await B.client.from('message_reactions').select('message_id').limit(1);
    const has0025 = !(reactionsProbe.error && isMissingRelation(reactionsProbe.error));
    const aMessage = await A.client
      .from('global_messages')
      .select('id')
      .eq('body', CHAT_PROBE_A)
      .maybeSingle();
    const aMessageId = (aMessage.data as { id: string } | null)?.id ?? null;

    if (!has0025) {
      console.log('  ----  reactions and edits — not present (migration 0025), not checked');
    } else if (aMessageId) {
      const bReacts = await B.client
        .from('message_reactions')
        .insert({ message_id: aMessageId, user_id: B.userId, emoji: '❤️' });
      if (bReacts.error) fail('message_reactions insert', `B cannot react: ${bReacts.error.message}`);
      else ok('message_reactions insert', "B reacted to A's message");

      const asA = await B.client
        .from('message_reactions')
        .insert({ message_id: aMessageId, user_id: A.userId, emoji: '😠' });
      if (!asA.error) fail('message_reactions (as A)', "B left a reaction in A's name");
      else ok('message_reactions (as A)', `blocked (${asA.error.code ?? 'error'})`);

      // A can see B's reaction, attributed — the positive half.
      const seen = await A.client
        .from('message_reaction_people')
        .select('user_id, name, emoji')
        .eq('message_id', aMessageId);
      const fromB = (seen.data ?? []).find((r: Record<string, unknown>) => r.user_id === B.userId);
      if (!fromB) fail('message_reaction_people', "A cannot see B's reaction on A's own message");
      else ok('message_reaction_people', 'reaction visible, with who left it');

      // A reacts too, and B must not be able to take A's away.
      await A.client.from('message_reactions').insert({ message_id: aMessageId, user_id: A.userId, emoji: '👍' });
      await B.client.from('message_reactions').delete().eq('message_id', aMessageId).eq('user_id', A.userId);
      const aStill = await A.client
        .from('message_reactions')
        .select('emoji')
        .eq('message_id', aMessageId)
        .eq('user_id', A.userId);
      if ((aStill.data ?? []).length === 0) fail('message_reactions delete', "B REMOVED A'S REACTION");
      else ok('message_reactions delete', "A's reaction survived B's delete");

      // Editing: only your own, and only through the function.
      const bEdits = await B.client.rpc('edit_global_message', { p_id: aMessageId, p_body: 'hijacked' });
      if (!bEdits.error) fail('edit_global_message (as B)', "B EDITED A'S MESSAGE");
      else ok('edit_global_message (as B)', `refused (${bEdits.error.code ?? 'error'})`);

      const aEdits = await A.client.rpc('edit_global_message', { p_id: aMessageId, p_body: `${CHAT_PROBE_A} (edited)` });
      if (aEdits.error) fail('edit_global_message (as A)', `A cannot edit their own new message: ${aEdits.error.message}`);
      else {
        const edited = await B.client.from('global_chat').select('body, edited_at').eq('id', aMessageId).maybeSingle();
        const row = edited.data as { body?: string; edited_at?: string | null } | null;
        if (!row?.edited_at) fail('edit_global_message (as A)', 'edited without being marked — an edit must never be silent');
        else ok('edit_global_message (as A)', 'edited, and marked edited for everyone');
      }

      // And no update policy exists to go around the function: a direct update
      // could move created_at forward and make the twenty minutes last for ever.
      const direct = await A.client
        .from('global_messages')
        .update({ created_at: new Date().toISOString() })
        .eq('id', aMessageId)
        .select('id');
      if (!direct.error && (direct.data ?? []).length > 0) {
        fail('global_messages update', 'a direct UPDATE reached the table — the edit window can be reset');
      } else {
        ok('global_messages update', 'no direct update; editing only through the function');
      }
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

    // ---- friends, blocks and reports (0026, NOTES §51) ----
    await checkFriendsBlocksAndReports(A, B, {
      sharedSetId: (sharedSet as { id: string }).id,
      privateSetId: set.id,
      sharedItemId,
      aMessageId,
    });

    // ---- posts, comments, reactions and photos (0027, NOTES §52) ----
    await checkPosts(A, B, { privateSetId: set.id });

    // ---- replies, hearts on comments and saved posts (0031, NOTES §57) ----
    await checkRepliesHeartsAndSaves(A, B);

    // ---- messages between friends (0028, NOTES §53) ----
    await checkMessages(A, B);

    // ---- replies, and group chats (0032, NOTES §58) ----
    await checkRepliesAndGroups(A, B);

    // ---- the friends' leaderboard (0029, NOTES §54) ----
    await checkLeaderboard(A, B);

    // ---- the community rules, and who may moderate (0030, NOTES §55) ----
    await checkModeration(A, B);

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
    // `like`, not `eq`: the edit check (0025) changes this message's body to
    // "… (edited)", and an exact match would leave it in the owner's live chat.
    // Its reactions cascade with it.
    await A.client.from('global_messages').delete().like('body', `${CHAT_PROBE_A}%`);
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

/**
 * Friends, blocks and reports (0026, NOTES §51), both directions.
 *
 * The positives matter here as much as anywhere: every write in 0026 goes
 * through a function that runs as its owner, precisely because none of the three
 * tables has an insert or update policy. If that ever stopped bypassing RLS, the
 * negatives below would all pass while nobody could make a friend.
 *
 * Runs while A's shared set, A's chat message and B's schedule for A's shared
 * card all still exist, so a block can be seen to take every one of them away —
 * and an unblock to bring them back before the unsharing checks run.
 *
 * ## Reports cannot be cleaned up, on purpose
 *
 * `reports` has no delete policy: a report is kept until it has been dealt with,
 * and Delete my data does not remove it (the Privacy Policy says so). So every
 * run leaves its reports behind, marked `isolation probe` in their details so
 * the operator can tell them from real ones. The SQL to clear them is printed.
 */
const PROBE_USERNAME_A = 'isoprobe_a';
// A plain hyphen, not a dash, so the cleanup SQL survives being retyped (NOTES §51.10).
const PROBE_REPORT = 'isolation probe - not a real report';

async function checkFriendsBlocksAndReports(
  A: { client: SupabaseClient; userId: string },
  B: { client: SupabaseClient; userId: string },
  ids: { sharedSetId: string; privateSetId: string; sharedItemId: string | null; aMessageId: string | null },
) {
  const gate = await B.client.from('my_friends').select('id').limit(1);
  if (gate.error && (isMissingRelation(gate.error) || gate.error.code === '42703')) {
    console.log('\n  ----  friends, blocks and reports — not present (migration 0026), not checked');
    return;
  }
  console.log('\nFriends, blocks and reports (0026):');

  // A clean start, whatever an earlier run left.
  await A.client.from('blocks').delete().eq('blocker_id', A.userId).eq('blocked_id', B.userId);
  await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);

  // ---- usernames ----
  const named = await A.client.from('profiles').update({ username: PROBE_USERNAME_A }).eq('id', A.userId);
  if (named.error) fail('username (as A)', `A cannot choose a username: ${named.error.message}`);
  else ok('username (as A)', 'chosen');

  const seen = await B.client.from('public_profiles').select('username').eq('id', A.userId).maybeSingle();
  if ((seen.data as { username?: string } | null)?.username !== PROBE_USERNAME_A) {
    fail('public_profiles.username (as B)', "B cannot see A's username — nobody could find A");
  } else ok('public_profiles.username (as B)', "A's username visible");

  const taken = await B.client.from('profiles').update({ username: PROBE_USERNAME_A }).eq('id', B.userId);
  if (taken.error?.code === '23505') ok('username (taken)', 'one person per username');
  else fail('username (taken)', `B took A's username: ${taken.error?.message ?? 'no error'}`);

  const bad = await B.client.from('profiles').update({ username: 'Not Allowed' }).eq('id', B.userId);
  if (bad.error?.code === '23514') ok('username (shape)', 'refused by profiles_username_check');
  else fail('username (shape)', `a username with capitals and a space was accepted: ${bad.error?.message ?? 'no error'}`);

  const reserved = await B.client.from('profiles').update({ username: 'nomi' }).eq('id', B.userId);
  if (reserved.error?.code === '23514') ok('username (reserved)', '"nomi" refused');
  else fail('username (reserved)', 'somebody can call themselves nomi');

  await B.client.from('profiles').update({ username: PROBE_USERNAME_A.replace('_a', '_x') }).eq('id', A.userId);
  const stillA = await A.client.from('profiles').select('username').eq('id', A.userId).maybeSingle();
  if ((stillA.data as { username?: string } | null)?.username !== PROBE_USERNAME_A) {
    fail('username (as B)', "B CHANGED A'S USERNAME");
  } else ok('username (as B)', "A's username survived B's update");

  const found = await B.client.rpc('search_people', { p_query: 'isoprobe' });
  if (found.error) fail('search_people (as B)', found.error.message);
  else if (!((found.data ?? []) as { id: string }[]).some((p) => p.id === A.userId)) {
    fail('search_people (as B)', 'B cannot find A by username');
  } else ok('search_people (as B)', 'A found by username');

  // ---- friends ----
  const forged = await B.client
    .from('friendships')
    .insert({ requester_id: B.userId, addressee_id: A.userId, status: 'accepted' });
  if (!forged.error) {
    fail('friendships insert', 'B made themselves A’s friend with a direct insert');
    await B.client.from('friendships').delete().eq('requester_id', B.userId);
  } else ok('friendships insert', `refused (${forged.error.code ?? 'error'}) — only through the function`);

  const asked = await B.client.rpc('send_friend_request', { p_to: A.userId });
  if (asked.error || asked.data !== 'requested') {
    fail('send_friend_request', `B cannot ask A: ${asked.error?.message ?? String(asked.data)}`);
  } else ok('send_friend_request', 'B asked A');

  const selfAccept = await B.client.rpc('accept_friend_request', { p_from: A.userId });
  if (!selfAccept.error) fail('accept_friend_request (as B)', 'B ACCEPTED THEIR OWN REQUEST on A’s behalf');
  else ok('accept_friend_request (as B)', `refused (${selfAccept.error.code ?? 'error'})`);

  const bumped = await B.client
    .from('friendships')
    .update({ status: 'accepted' })
    .eq('requester_id', B.userId)
    .select('id');
  if (!bumped.error && (bumped.data ?? []).length > 0) fail('friendships update', 'B accepted by updating the row directly');
  else ok('friendships update', 'no direct update');

  const inbox = await A.client.from('my_friends').select('person_id, status, sent_by_me, name');
  const fromB = ((inbox.data ?? []) as { person_id: string; status: string; sent_by_me: boolean }[]).find(
    (l) => l.person_id === B.userId,
  );
  if (!fromB || fromB.status !== 'pending' || fromB.sent_by_me) {
    fail('my_friends (as A)', `A does not see B's request the right way round: ${JSON.stringify(fromB)}`);
  } else ok('my_friends (as A)', "B's request waiting for A");

  const yes = await A.client.rpc('accept_friend_request', { p_from: B.userId });
  if (yes.error) fail('accept_friend_request (as A)', yes.error.message);
  else {
    const both = await B.client.from('my_friends').select('person_id, status').eq('person_id', A.userId).maybeSingle();
    if ((both.data as { status?: string } | null)?.status !== 'accepted') fail('friends', 'accepted, but B does not see it');
    else ok('friends', 'A accepted; both see it');
  }

  // ---- blocking ----
  const forgedBlock = await B.client.from('blocks').insert({ blocker_id: B.userId, blocked_id: A.userId });
  if (!forgedBlock.error) {
    fail('blocks insert', 'a direct insert went around block_person, leaving the friendship standing');
    await B.client.from('blocks').delete().eq('blocker_id', B.userId);
  } else ok('blocks insert', `refused (${forgedBlock.error.code ?? 'error'}) — only through the function`);

  const blocked = await A.client.rpc('block_person', { p_other: B.userId });
  if (blocked.error) {
    fail('block_person (as A)', blocked.error.message);
    return;
  }
  ok('block_person (as A)', 'A blocked B');

  const friendsAfter = await B.client.from('my_friends').select('person_id').eq('person_id', A.userId);
  if ((friendsAfter.data ?? []).length > 0) fail('block (friendship)', 'still friends after a block');
  else ok('block (friendship)', 'the friendship ended with the block');

  const bSeesBlock = await B.client.from('blocks').select('blocker_id').eq('blocker_id', A.userId);
  if ((bSeesBlock.data ?? []).length > 0) fail('blocks (as B)', 'B can see that A blocked them');
  else ok('blocks (as B)', 'the block is A’s alone to see');

  await B.client.from('blocks').delete().eq('blocker_id', A.userId);
  const stillBlocked = await A.client.from('blocks').select('blocked_id').eq('blocked_id', B.userId);
  if ((stillBlocked.data ?? []).length === 0) fail('blocks delete (as B)', "B UNDID A'S BLOCK");
  else ok('blocks delete (as B)', 'only the blocker can unblock');

  const listed = await A.client.from('my_blocks').select('person_id').eq('person_id', B.userId);
  if ((listed.data ?? []).length === 0) fail('my_blocks (as A)', 'A cannot see who they blocked, so cannot unblock');
  else ok('my_blocks (as A)', 'B listed, so A can unblock');

  // Hidden, both ways, everywhere.
  const hides: [string, () => PromiseLike<{ data: unknown[] | null }>][] = [
    ['public_profiles (B → A)', () => B.client.from('public_profiles').select('id').eq('id', A.userId)],
    ['public_profiles (A → B)', () => A.client.from('public_profiles').select('id').eq('id', B.userId)],
    ['public_sets (B → A)', () => B.client.from('public_sets').select('id').eq('id', ids.sharedSetId)],
    ['public_set_items (B → A)', () => B.client.from('public_set_items').select('id').eq('study_set_id', ids.sharedSetId)],
    ['global_chat (B → A)', () => B.client.from('global_chat').select('id').eq('author_id', A.userId)],
    ['global_chat (A → B)', () => A.client.from('global_chat').select('id').eq('author_id', B.userId)],
    ['message_reaction_people (A → B)', () => A.client.from('message_reaction_people').select('user_id').eq('user_id', B.userId)],
  ];
  if (ids.sharedItemId) {
    const itemId = ids.sharedItemId;
    hides.push(['my_schedule (B → A)', () => B.client.from('my_schedule').select('study_item_id').eq('study_item_id', itemId)]);
  }
  for (const [name, read] of hides) {
    const { data } = await read();
    if ((data ?? []).length > 0) fail(`block hides ${name}`, 'still visible across a block');
    else ok(`block hides ${name}`, 'hidden');
  }

  const searched = await B.client.rpc('search_people', { p_query: 'isoprobe' });
  if (((searched.data ?? []) as { id: string }[]).some((p) => p.id === A.userId)) {
    fail('block hides search', 'B can still find A');
  } else ok('block hides search', 'A not found');

  const askAgain = await B.client.rpc('send_friend_request', { p_to: A.userId });
  if (!askAgain.error) fail('block refuses requests', 'B asked a person who blocked them');
  else ok('block refuses requests', `refused (${askAgain.error.code ?? 'error'})`);

  // And undone: A unblocks, and B is back.
  await A.client.from('blocks').delete().eq('blocker_id', A.userId).eq('blocked_id', B.userId);
  const back = await B.client.from('public_sets').select('id').eq('id', ids.sharedSetId);
  if ((back.data ?? []).length === 0) fail('unblock', 'A unblocked B and B still cannot see A’s shared set');
  else ok('unblock', 'everything came back');

  // ---- reports ----
  const reportsGate = await B.client.from('reports').select('id').limit(1);
  if (reportsGate.error) {
    fail('reports (as B)', reportsGate.error.message);
    return;
  }

  const forgedReport = await B.client.from('reports').insert({
    reporter_id: B.userId,
    target_kind: 'person',
    target_id: A.userId,
    reason: 'other',
    snapshot: 'words A never said',
  });
  if (!forgedReport.error) fail('reports insert', 'a report with a made-up copy went straight in');
  else ok('reports insert', `refused (${forgedReport.error.code ?? 'error'}) — the copy is the database's to take`);

  if (ids.aMessageId) {
    const r = await B.client.rpc('report_content', {
      p_kind: 'message',
      p_target: ids.aMessageId,
      p_reason: 'other',
      p_details: PROBE_REPORT,
    });
    if (r.error) fail('report_content (message)', r.error.message);
    else {
      const mine = await B.client.from('reports').select('snapshot, reported_user_id').eq('id', r.data as string).maybeSingle();
      const row = mine.data as { snapshot?: string; reported_user_id?: string } | null;
      if (!row?.snapshot?.startsWith('isolation probe message from A')) {
        fail('report_content (message)', `the copy is not the message: ${String(row?.snapshot)}`);
      } else if (row.reported_user_id !== A.userId) {
        fail('report_content (message)', 'reported, but not against the person who said it');
      } else ok('report_content (message)', 'reported, with a copy of what was said');

      const again = await B.client.rpc('report_content', {
        p_kind: 'message',
        p_target: ids.aMessageId,
        p_reason: 'spam',
        p_details: PROBE_REPORT,
      });
      if (again.data !== r.data) fail('report_content (twice)', 'the same thing reported twice made two reports');
      else ok('report_content (twice)', 'one open report per thing');

      const aSees = await A.client.from('reports').select('id').eq('id', r.data as string);
      if ((aSees.data ?? []).length > 0) fail('reports (as A)', 'A CAN SEE WHO REPORTED THEM');
      else ok('reports (as A)', 'the reported person cannot see the report');

      await B.client.from('reports').delete().eq('id', r.data as string);
      const kept = await B.client.from('reports').select('id').eq('id', r.data as string);
      if ((kept.data ?? []).length === 0) fail('reports delete', 'a report was deleted; the evidence is gone');
      else ok('reports delete', 'kept until it is dealt with');
    }
  }

  const privateReport = await B.client.rpc('report_content', {
    p_kind: 'set',
    p_target: ids.privateSetId,
    p_reason: 'wrong',
    p_details: PROBE_REPORT,
  });
  if (!privateReport.error) fail('report_content (private set)', 'B reported a set they cannot see — set ids can be probed');
  else ok('report_content (private set)', `refused (${privateReport.error.code ?? 'error'}), same as one that does not exist`);

  const setReport = await B.client.rpc('report_content', {
    p_kind: 'set',
    p_target: ids.sharedSetId,
    p_reason: 'wrong',
    p_details: PROBE_REPORT,
  });
  if (setReport.error) fail('report_content (shared set)', setReport.error.message);
  else ok('report_content (shared set)', 'a wrong shared set can be flagged at last (NOTES §46.5)');

  const selfReport = await A.client.rpc('report_content', {
    p_kind: 'person',
    p_target: A.userId,
    p_reason: 'other',
    p_details: PROBE_REPORT,
  });
  if (!selfReport.error) fail('report_content (yourself)', 'A reported A');
  else ok('report_content (yourself)', 'refused');

  // ---- tidy up ----
  await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  await A.client.from('profiles').update({ username: null }).eq('id', A.userId);
  console.log(
    `  (reports cannot be deleted from the app, by design. To clear this run's, in the Supabase SQL editor (not PowerShell):\n` +
      `   delete from public.reports where details like '%probe%not a real report';)`,
  );
}

/**
 * Posts, comments, reactions and photos (0027, NOTES §52), both directions.
 *
 * 0027 has one rule for who sees a post — the author; or, across no block,
 * everyone-posts and friends of friends-only posts — and seven places that must
 * use it. Every one is checked here as B posts and A looks: the feed, reacting,
 * commenting, the photo in storage, reporting, and a block over all of them.
 * B is the author throughout, A the reader, and they start as strangers.
 */
const POST_PROBE = 'isolation probe post';

async function checkPosts(
  A: { client: SupabaseClient; userId: string },
  B: { client: SupabaseClient; userId: string },
  ids: { privateSetId: string },
) {
  const gate = await A.client.from('feed_posts').select('id').limit(1);
  if (gate.error && (isMissingRelation(gate.error) || gate.error.code === '42703')) {
    console.log('\n  ----  posts — not present (migration 0027), not checked');
    return;
  }
  console.log('\nPosts, comments, reactions and photos (0027):');

  const strangers = async () => {
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  };
  await strangers();
  await B.client.from('posts').delete().like('body', `${POST_PROBE}%`);

  const post = async (body: string, audience: 'friends' | 'everyone', extra: Record<string, unknown> = {}) =>
    B.client.rpc('create_post', { p_body: `${POST_PROBE} ${body}`, p_audience: audience, ...extra });
  const aSees = async (id: string) =>
    ((await A.client.from('feed_posts').select('id').eq('id', id)).data ?? []).length > 0;

  // ---- writing ----
  const forged = await B.client.from('posts').insert({ user_id: B.userId, body: 'straight in', audience: 'everyone' });
  if (!forged.error) {
    fail('posts insert', 'a post went straight into the table, around create_post');
    await B.client.from('posts').delete().eq('body', 'straight in');
  } else ok('posts insert', `refused (${forged.error.code ?? 'error'}) — only through create_post`);

  const friendsOnly = await post('for friends', 'friends');
  const everyone = await post('for everyone', 'everyone');
  if (friendsOnly.error || everyone.error) {
    fail('create_post', `${friendsOnly.error?.message ?? ''} ${everyone.error?.message ?? ''}`.trim());
    return;
  }
  const friendsId = friendsOnly.data as string;
  const everyoneId = everyone.data as string;
  ok('create_post', 'B posted twice, once for friends and once for everyone');

  const ownFeed = await B.client.from('feed_posts').select('id').in('id', [friendsId, everyoneId]);
  if ((ownFeed.data ?? []).length !== 2) fail('feed_posts (as author)', 'B cannot see their own posts');
  else ok('feed_posts (as author)', 'both of their own posts');

  // ---- strangers: everyone yes, friends no ----
  if (await aSees(friendsId)) fail('friends-only (stranger)', "A SEES B'S FRIENDS-ONLY POST WITHOUT BEING FRIENDS");
  else ok('friends-only (stranger)', 'hidden from somebody who is not a friend');
  if (!(await aSees(everyoneId))) fail('everyone (stranger)', "A cannot see B's post for everyone");
  else ok('everyone (stranger)', 'visible to anybody signed in');

  const reactHidden = await A.client.from('post_reactions').insert({ post_id: friendsId, user_id: A.userId, emoji: '❤️' });
  if (!reactHidden.error) fail('react (hidden post)', 'A reacted to a post A cannot see');
  else ok('react (hidden post)', `refused (${reactHidden.error.code ?? 'error'})`);

  const commentHidden = await A.client.rpc('add_comment', { p_post: friendsId, p_body: 'can I see this?' });
  if (!commentHidden.error) fail('comment (hidden post)', 'A commented on a post A cannot see');
  else ok('comment (hidden post)', `refused (${commentHidden.error.code ?? 'error'}), as if it were not there`);

  const reportHidden = await A.client.rpc('report_content', {
    p_kind: 'post',
    p_target: friendsId,
    p_reason: 'other',
    p_details: PROBE_REPORT,
  });
  if (!reportHidden.error) fail('report (hidden post)', 'A reported a post A cannot see — post ids can be probed');
  else ok('report (hidden post)', `refused (${reportHidden.error.code ?? 'error'})`);

  // ---- on the public one: react, comment, and B sees both, named ----
  const reacted = await A.client.from('post_reactions').insert({ post_id: everyoneId, user_id: A.userId, emoji: '👍' });
  if (reacted.error) fail('react', `A cannot react: ${reacted.error.message}`);
  else ok('react', "A reacted to B's public post");
  const asB = await A.client.from('post_reactions').insert({ post_id: everyoneId, user_id: B.userId, emoji: '😠' });
  if (!asB.error) fail('react (as B)', "A reacted in B's name");
  else ok('react (as B)', `refused (${asB.error.code ?? 'error'})`);

  const commented = await A.client.rpc('add_comment', { p_post: everyoneId, p_body: `${POST_PROBE} comment from A` });
  if (commented.error) fail('add_comment', commented.error.message);
  else ok('add_comment', "A commented on B's public post");
  const forgedComment = await A.client
    .from('post_comments')
    .insert({ post_id: everyoneId, user_id: A.userId, body: 'around the limit' });
  if (!forgedComment.error) fail('post_comments insert', 'a comment went straight in, around the per-minute limit');
  else ok('post_comments insert', `refused (${forgedComment.error.code ?? 'error'})`);

  const seenByB = await B.client.from('post_comment_people').select('author_id, author_name').eq('post_id', everyoneId);
  const reactionsByB = await B.client.from('post_reaction_people').select('user_id').eq('post_id', everyoneId);
  if (!(seenByB.data ?? []).some((c: Record<string, unknown>) => c.author_id === A.userId)) {
    fail('post_comment_people (as author)', "B cannot see A's comment on B's own post");
  } else ok('post_comment_people (as author)', "A's comment visible, named");
  if (!(reactionsByB.data ?? []).some((r: Record<string, unknown>) => r.user_id === A.userId)) {
    fail('post_reaction_people (as author)', "B cannot see A's reaction");
  } else ok('post_reaction_people (as author)', "A's reaction visible, named");

  // ---- friends: now the friends-only post shows ----
  await B.client.rpc('send_friend_request', { p_to: A.userId });
  await A.client.rpc('accept_friend_request', { p_from: B.userId });
  if (!(await aSees(friendsId))) fail('friends-only (friend)', "A is B's friend and still cannot see the post");
  else ok('friends-only (friend)', 'visible once they are friends');

  // ---- the author moderates their own post ----
  const aComment = await A.client.from('post_comments').select('id').eq('post_id', everyoneId).eq('user_id', A.userId);
  const aCommentId = ((aComment.data ?? [])[0] as { id: string } | undefined)?.id;
  const bOwn = await B.client.rpc('add_comment', { p_post: everyoneId, p_body: `${POST_PROBE} comment from B` });
  if (aCommentId) {
    const removed = await B.client.from('post_comments').delete().eq('id', aCommentId).select('id');
    if ((removed.data ?? []).length !== 1) fail('comment delete (post author)', "B cannot take A's comment off B's own post");
    else ok('comment delete (post author)', "B removed A's comment from B's post");
  }
  if (!bOwn.error) {
    await A.client.from('post_comments').delete().eq('id', bOwn.data as string);
    const still = await B.client.from('post_comments').select('id').eq('id', bOwn.data as string);
    if ((still.data ?? []).length === 0) fail('comment delete (as A)', "A DELETED B'S COMMENT on B's post");
    else ok('comment delete (as A)', "only a comment's author or the post's author can remove it");
  }

  const bEdits = await A.client.rpc('edit_post', { p_id: everyoneId, p_body: 'hijacked', p_audience: 'everyone' });
  if (!bEdits.error) fail('edit_post (as A)', "A EDITED B'S POST");
  else ok('edit_post (as A)', `refused (${bEdits.error.code ?? 'error'})`);

  const edited = await B.client.rpc('edit_post', { p_id: everyoneId, p_body: `${POST_PROBE} for everyone (edited)`, p_audience: 'everyone' });
  const afterEdit = await A.client.from('feed_posts').select('edited_at').eq('id', everyoneId).maybeSingle();
  if (edited.error) fail('edit_post (as B)', edited.error.message);
  else if (!(afterEdit.data as { edited_at?: string } | null)?.edited_at) fail('edit_post (as B)', 'edited without being marked');
  else ok('edit_post (as B)', 'edited, and marked for the reader');

  // ---- a streak brag is the database's number ----
  const brag = await post('streak', 'friends', { p_streak: true });
  if (brag.error?.code === '22023') ok('streak brag', 'no streak, no brag — the database checked, not the app');
  else if (brag.error) fail('streak brag', brag.error.message);
  else {
    const row = await B.client.from('posts').select('streak_days').eq('id', brag.data as string).maybeSingle();
    const days = (row.data as { streak_days?: number } | null)?.streak_days ?? 0;
    const studied = await B.client.from('study_days').select('day', { count: 'exact', head: true });
    if (days < 1 || days > (studied.count ?? 0) + 5) fail('streak brag', `a streak of ${days} from ${studied.count} days studied`);
    else ok('streak brag', `${days} day(s), counted by the database`);
  }
  const peek = await B.client.rpc('streak_of', { p_user: A.userId });
  if (!peek.error) fail('streak_of', "B READ A'S STREAK — a streak is not public");
  else ok('streak_of', `not callable (${peek.error.code ?? 'error'})`);

  // ---- a set in a post must be shared ----
  const privateSet = await post('private set', 'everyone', { p_set_id: ids.privateSetId });
  if (!privateSet.error) fail('set post (private)', "B posted A's PRIVATE set");
  else ok('set post (private)', `refused (${privateSet.error.code ?? 'error'})`);

  // ---- a photo follows its post ----
  const photoPath = `${B.userId}/isolation-probe.jpg`;
  const up = await B.client.storage
    .from('post-images')
    .upload(photoPath, new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: 'image/jpeg' }), { upsert: true });
  if (up.error) {
    fail('post-images upload', up.error.message);
  } else {
    const intruder = await A.client.rpc('create_post', {
      p_body: `${POST_PROBE} stolen photo`,
      p_audience: 'everyone',
      p_image_path: photoPath,
      p_image_width: 10,
      p_image_height: 10,
    });
    if (!intruder.error) fail('photo post (not yours)', "A posted a photo from B's folder");
    else ok('photo post (not yours)', `refused (${intruder.error.code ?? 'error'})`);

    const intoB = await A.client.storage.from('post-images').upload(`${B.userId}/intruder.jpg`, new Blob(['x'], { type: 'image/jpeg' }));
    if (!intoB.error) fail('post-images write', "A wrote into B's folder");
    else ok('post-images write', 'refused');

    const unposted = await A.client.storage.from('post-images').download(photoPath);
    if (unposted.data) fail('post-images (not posted)', 'A downloaded a photo that is on no post');
    else ok('post-images (not posted)', 'a photo on no post is its owner’s alone');

    const photoPost = await post('photo', 'friends', { p_image_path: photoPath, p_image_width: 10, p_image_height: 10 });
    if (photoPost.error) fail('photo post', photoPost.error.message);
    else {
      const asFriend = await A.client.storage.from('post-images').download(photoPath);
      if (!asFriend.data) fail('post-images (friend)', `A, a friend, cannot see the photo: ${asFriend.error?.message}`);
      else ok('post-images (friend)', 'visible to who can see the post');

      await strangers();
      // With a FRESH session. Measured 2026-09-28 (NOTES §52.7): Supabase's
      // storage cache keeps a copy per session, so the session that downloaded
      // this as a friend is still served it from the cache after the friendship
      // ends — while a new session, and anybody who was never allowed, is
      // refused. The rule is the database's and it is enforced; the cache is a
      // window on what that person already had, and it is reported, not hidden.
      const fresh = await signIn('a');
      const asStranger = await fresh.client.storage.from('post-images').download(photoPath);
      if (asStranger.data) fail('post-images (stranger)', "A STRANGER DOWNLOADED A FRIENDS-ONLY PHOTO");
      else ok('post-images (stranger)', 'refused once the friendship ended');
      const sameSession = await A.client.storage.from('post-images').download(photoPath);
      console.log(
        sameSession.data
          ? '  NOTE  post-images (same session) — still served from the storage cache to the session that saw it as a friend (NOTES §52.7)'
          : '  NOTE  post-images (same session) — refused too; the storage cache did not hold it this time',
      );
    }
  }

  // ---- a block hides it all, both ways ----
  const aPost = await A.client.rpc('create_post', { p_body: `${POST_PROBE} from A`, p_audience: 'everyone' });
  await A.client.rpc('block_person', { p_other: B.userId });
  if (await aSees(everyoneId)) fail('block (A → B posts)', "A still sees B's public post after blocking B");
  else ok('block (A → B posts)', 'hidden');
  if (!aPost.error) {
    const bSees = await B.client.from('feed_posts').select('id').eq('id', aPost.data as string);
    if ((bSees.data ?? []).length > 0) fail('block (B → A posts)', 'B still sees the public post of somebody who blocked them');
    else ok('block (B → A posts)', 'hidden the other way too');
  }
  const blockedComment = await B.client.rpc('add_comment', { p_post: aPost.data as string, p_body: 'still here?' });
  if (!blockedComment.error) fail('block (comment)', 'B commented on the post of somebody who blocked them');
  else ok('block (comment)', `refused (${blockedComment.error.code ?? 'error'})`);

  // ---- tidy up ----
  await strangers();
  await A.client.from('posts').delete().like('body', `${POST_PROBE}%`);
  await B.client.from('posts').delete().like('body', `${POST_PROBE}%`);
  await B.client.storage.from('post-images').remove([photoPath]);
}

/**
 * Replies and hearts on comments, and saved posts (0031, NOTES §57).
 *
 * B posts and comments, A reads — strangers first, then a block. Everything new
 * asks 0027's one rule through `can_see_post` or `can_see_comment`, and the two
 * new tables are their owners' alone: nobody can list who gave a heart or who
 * saved a post.
 */
async function checkRepliesHeartsAndSaves(
  A: { client: SupabaseClient; userId: string },
  B: { client: SupabaseClient; userId: string },
) {
  const gate = await A.client.from('comment_likes').select('comment_id').limit(1);
  if (gate.error && isMissingRelation(gate.error)) {
    console.log('\n  ----  replies, hearts and saves — not present (migration 0031), not checked');
    return;
  }
  console.log('\nReplies, hearts on comments, and saved posts (0031):');

  const strangers = async () => {
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  };
  await strangers();
  await B.client.from('posts').delete().like('body', `${POST_PROBE}%`);

  const friendsPost = await B.client.rpc('create_post', { p_body: `${POST_PROBE} 0031 friends`, p_audience: 'friends' });
  const openPost = await B.client.rpc('create_post', { p_body: `${POST_PROBE} 0031 everyone`, p_audience: 'everyone' });
  if (friendsPost.error || openPost.error) {
    fail('0031 seed', `${friendsPost.error?.message ?? ''} ${openPost.error?.message ?? ''}`.trim());
    return;
  }
  const hiddenPostId = friendsPost.data as string;
  const openPostId = openPost.data as string;
  const onHidden = await B.client.rpc('add_comment', { p_post: hiddenPostId, p_body: `${POST_PROBE} hidden comment` });
  const onOpen = await B.client.rpc('add_comment', { p_post: openPostId, p_body: `${POST_PROBE} open comment` });
  if (onHidden.error || onOpen.error) {
    fail('0031 seed', `${onHidden.error?.message ?? ''} ${onOpen.error?.message ?? ''}`.trim());
    return;
  }
  const hiddenComment = onHidden.data as string;
  const openComment = onOpen.data as string;

  // ---- hearts ----
  const heartHidden = await A.client.from('comment_likes').insert({ comment_id: hiddenComment, user_id: A.userId });
  if (!heartHidden.error) fail('heart (hidden post)', "A gave a heart to a comment on a post A cannot see");
  else ok('heart (hidden post)', `refused (${heartHidden.error.code ?? 'error'})`);

  const heart = await A.client.from('comment_likes').insert({ comment_id: openComment, user_id: A.userId });
  if (heart.error) fail('heart', heart.error.message);
  else ok('heart', "A gave a heart to B's comment on a public post");

  const heartAsB = await A.client.from('comment_likes').insert({ comment_id: openComment, user_id: B.userId });
  if (!heartAsB.error) fail('heart (as B)', "A gave a heart in B's name");
  else ok('heart (as B)', `refused (${heartAsB.error.code ?? 'error'})`);

  const bReadsHearts = await B.client.from('comment_likes').select('user_id').eq('comment_id', openComment);
  if ((bReadsHearts.data ?? []).some((r: { user_id: string }) => r.user_id === A.userId)) {
    fail('comment_likes (as B)', 'B CAN SEE WHO GAVE A HEART — hearts are counted, not named');
  } else ok('comment_likes (as B)', "B cannot list who gave hearts on B's own comment");

  const counted = await B.client.from('post_comment_people').select('likes, liked').eq('id', openComment).maybeSingle();
  const mineCounted = await A.client.from('post_comment_people').select('likes, liked').eq('id', openComment).maybeSingle();
  const bRow = counted.data as { likes?: number; liked?: boolean } | null;
  const aRow = mineCounted.data as { likes?: number; liked?: boolean } | null;
  if (bRow?.likes === 1 && bRow.liked === false && aRow?.liked === true) {
    ok('post_comment_people (hearts)', 'counted for B, marked as A’s own for A');
  } else fail('post_comment_people (hearts)', `B sees ${JSON.stringify(bRow)}, A sees ${JSON.stringify(aRow)}`);

  // ---- replies ----
  const replyHidden = await A.client.rpc('add_reply', { p_comment: hiddenComment, p_body: 'can I see this?' });
  if (!replyHidden.error) fail('reply (hidden post)', 'A replied to a comment on a post A cannot see');
  else ok('reply (hidden post)', `refused (${replyHidden.error.code ?? 'error'}), as if it were not there`);

  const reply = await A.client.rpc('add_reply', { p_comment: openComment, p_body: `${POST_PROBE} reply from A` });
  if (reply.error) fail('add_reply', reply.error.message);
  else {
    const row = await B.client.from('post_comment_people').select('parent_id, author_id').eq('id', reply.data as string).maybeSingle();
    if ((row.data as { parent_id?: string } | null)?.parent_id === openComment) ok('add_reply', "under B's comment, and B sees it there");
    else fail('add_reply', `B sees ${JSON.stringify(row.data)}`);

    const deeper = await B.client.rpc('add_reply', { p_comment: reply.data as string, p_body: `${POST_PROBE} reply to the reply` });
    const deepRow = deeper.error
      ? null
      : await A.client.from('post_comment_people').select('parent_id').eq('id', deeper.data as string).maybeSingle();
    if ((deepRow?.data as { parent_id?: string } | null)?.parent_id === openComment) {
      ok('one level deep', 'a reply to a reply landed under the comment above it');
    } else fail('one level deep', deeper.error?.message ?? `parent is ${JSON.stringify(deepRow?.data)}`);
  }

  const forgedReply = await A.client
    .from('post_comments')
    .insert({ post_id: openPostId, user_id: A.userId, body: 'around add_reply', parent_id: openComment });
  if (!forgedReply.error) fail('post_comments insert (reply)', 'a reply went straight in, around add_reply');
  else ok('post_comments insert (reply)', `refused (${forgedReply.error.code ?? 'error'})`);

  // ---- saves ----
  const saveHidden = await A.client.from('post_saves').insert({ post_id: hiddenPostId, user_id: A.userId });
  if (!saveHidden.error) fail('save (hidden post)', 'A saved a post A cannot see');
  else ok('save (hidden post)', `refused (${saveHidden.error.code ?? 'error'})`);

  const save = await A.client.from('post_saves').insert({ post_id: openPostId, user_id: A.userId });
  if (save.error) fail('save', save.error.message);
  else ok('save', "A saved B's public post");

  const saveAsB = await A.client.from('post_saves').insert({ post_id: openPostId, user_id: B.userId });
  if (!saveAsB.error) fail('save (as B)', "A saved a post in B's name");
  else ok('save (as B)', `refused (${saveAsB.error.code ?? 'error'})`);

  const bReadsSaves = await B.client.from('post_saves').select('user_id').eq('post_id', openPostId);
  if ((bReadsSaves.data ?? []).length > 0) fail('post_saves (as author)', 'B CAN SEE WHO SAVED B’S POST — saves are private');
  else ok('post_saves (as author)', 'the author cannot see who saved their post');

  // ---- a block: A's heart stops counting for B, and A cannot reply ----
  await A.client.rpc('block_person', { p_other: B.userId });
  const countAcross = await B.client.from('post_comment_people').select('likes').eq('id', openComment).maybeSingle();
  if ((countAcross.data as { likes?: number } | null)?.likes === 0) {
    ok('block (hearts)', 'a heart from across a block is not counted');
  } else fail('block (hearts)', `B still counts ${JSON.stringify(countAcross.data)} after A blocked B`);

  const aReplyToB = await A.client.rpc('add_reply', { p_comment: openComment, p_body: 'across a block' });
  if (!aReplyToB.error) fail('block (reply)', 'A replied to B across a block');
  else ok('block (reply)', `refused (${aReplyToB.error.code ?? 'error'})`);

  // ---- a comment deleted takes its replies with it ----
  await strangers();
  await B.client.from('post_comments').delete().eq('id', openComment);
  const orphans = await A.client.from('post_comments').select('id').eq('parent_id', openComment);
  if ((orphans.data ?? []).length > 0) fail('cascade', "A's reply outlived the comment it answered");
  else ok('cascade', 'the replies went with the comment');

  // ---- tidy up ----
  await A.client.from('post_saves').delete().eq('user_id', A.userId);
  await A.client.from('comment_likes').delete().eq('user_id', A.userId);
  await B.client.from('posts').delete().like('body', `${POST_PROBE}%`);
}

/**
 * Replies, and group chats (0032, NOTES §58), both directions.
 *
 * Replies: a reply must answer a message in the same room, and a quote comes
 * back through the room's view. Groups: members only, since they joined; only
 * friends can be added; only the owner renames or takes people out; a block
 * hides the two people's messages from each other inside a group; leaving
 * hands the group on. A and B start as friends — a group needs a friend in it.
 */
const GROUP_PROBE = 'group probe';

async function checkRepliesAndGroups(
  A: { client: SupabaseClient; userId: string },
  B: { client: SupabaseClient; userId: string },
) {
  const gate = await A.client.from('my_groups').select('id').limit(1);
  if (gate.error && (isMissingRelation(gate.error) || gate.error.code === '42703')) {
    console.log('\n  ----  replies and groups — not present (migration 0032), not checked');
    return;
  }
  console.log('\nReplies, and group chats (0032):');

  const reset = async () => {
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await B.client.from('blocks').delete().eq('blocker_id', B.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
    await B.client.rpc('send_friend_request', { p_to: A.userId });
    await A.client.rpc('accept_friend_request', { p_from: B.userId });
  };
  const leaveProbeGroups = async (who: { client: SupabaseClient }) => {
    const mine = await who.client.from('my_groups').select('id').like('title', `${GROUP_PROBE}%`);
    for (const g of (mine.data ?? []) as { id: string }[]) await who.client.rpc('leave_group', { p_group: g.id });
  };
  await reset();
  await leaveProbeGroups(A);
  await leaveProbeGroups(B);
  await A.client.from('global_messages').delete().like('body', `${GROUP_PROBE}%`);
  await B.client.from('global_messages').delete().like('body', `${GROUP_PROBE}%`);

  // ---- a reply in the Everyone room ----
  const original = await A.client.rpc('send_global_message', { message: `${GROUP_PROBE} original` });
  const originalId = (original.data as { id?: string } | null)?.id;
  if (!originalId) {
    fail('0032 seed', original.error?.message ?? 'no message');
    return;
  }
  const reply = await B.client.rpc('send_global_message', { message: `${GROUP_PROBE} reply`, p_reply_to: originalId });
  const replyId = (reply.data as { id?: string } | null)?.id;
  const quoted = replyId
    ? await A.client.from('global_chat').select('reply_to, reply_body').eq('id', replyId).maybeSingle()
    : null;
  if ((quoted?.data as { reply_to?: string; reply_body?: string } | null)?.reply_body === `${GROUP_PROBE} original`) {
    ok('reply (Everyone room)', 'answers A’s message, quoted back through the view');
  } else fail('reply (Everyone room)', reply.error?.message ?? `A sees ${JSON.stringify(quoted?.data)}`);

  const replyNowhere = await B.client.rpc('send_global_message', {
    message: `${GROUP_PROBE} reply to nothing`,
    p_reply_to: '00000000-0000-0000-0000-000000000000',
  });
  if (!replyNowhere.error) fail('reply (no such message)', 'a reply to a message that does not exist went');
  else ok('reply (no such message)', `refused (${replyNowhere.error.code ?? 'error'})`);

  await A.client.from('global_messages').delete().eq('id', originalId);
  const afterUnsend = replyId
    ? await A.client.from('global_chat').select('reply_to, reply_body').eq('id', replyId).maybeSingle()
    : null;
  const unsent = afterUnsend?.data as { reply_to?: string; reply_body?: string | null } | null;
  if (unsent?.reply_to === originalId && unsent.reply_body === null) ok('reply (unsent)', 'the reply stays, and says what it answered is gone');
  else fail('reply (unsent)', JSON.stringify(unsent));

  // ---- a group ----
  const nonFriend = await A.client.rpc('create_group', {
    p_title: `${GROUP_PROBE} strangers`,
    p_members: ['00000000-0000-0000-0000-000000000000'],
  });
  if (!nonFriend.error) fail('create_group (not a friend)', 'A put somebody who is not a friend in a group');
  else ok('create_group (not a friend)', `refused (${nonFriend.error.code ?? 'error'})`);

  const forgedGroup = await A.client.from('group_chats').insert({ title: 'straight in', created_by: A.userId, owner_id: A.userId });
  if (!forgedGroup.error) fail('group_chats insert', 'a group went straight into the table');
  else ok('group_chats insert', `refused (${forgedGroup.error.code ?? 'error'})`);

  const made = await A.client.rpc('create_group', { p_title: `${GROUP_PROBE} one`, p_members: [B.userId] });
  if (made.error) {
    fail('create_group', made.error.message);
    return;
  }
  const groupId = made.data as string;
  const bGroups = await B.client.from('my_groups').select('id, i_own, member_count').eq('id', groupId).maybeSingle();
  const bRow = bGroups.data as { i_own?: boolean; member_count?: number } | null;
  if (bRow && bRow.member_count === 2 && bRow.i_own === false) ok('create_group', 'B is in it, and it is A’s');
  else fail('create_group', JSON.stringify(bGroups.data));

  const forgedMember = await B.client.from('group_members').insert({ group_id: groupId, user_id: B.userId });
  if (!forgedMember.error) fail('group_members insert', 'a membership went straight into the table');
  else ok('group_members insert', `refused (${forgedMember.error.code ?? 'error'})`);

  const bRenames = await B.client.rpc('rename_group', { p_group: groupId, p_title: `${GROUP_PROBE} hijacked` });
  if (!bRenames.error) fail('rename_group (not the owner)', 'B renamed A’s group');
  else ok('rename_group (not the owner)', `refused (${bRenames.error.code ?? 'error'})`);
  const bRemoves = await B.client.rpc('remove_group_member', { p_group: groupId, p_user: A.userId });
  if (!bRemoves.error) fail('remove_group_member (not the owner)', 'B took A out of A’s group');
  else ok('remove_group_member (not the owner)', `refused (${bRemoves.error.code ?? 'error'})`);

  const first = await A.client.rpc('send_group_message', { p_group: groupId, p_body: `${GROUP_PROBE} first` });
  const firstId = first.data as string | null;
  const bSees = await B.client.from('group_chat_messages').select('id').eq('group_id', groupId);
  if (firstId && (bSees.data ?? []).some((m: { id: string }) => m.id === firstId)) ok('group message', 'B, in it, reads A’s message');
  else fail('group message', first.error?.message ?? 'B cannot see it');

  const forgedMessage = await B.client.from('group_messages').insert({ group_id: groupId, user_id: B.userId, body: 'around the limit' });
  if (!forgedMessage.error) fail('group_messages insert', 'a message went straight in, around send_group_message');
  else ok('group_messages insert', `refused (${forgedMessage.error.code ?? 'error'})`);

  const crossReply = await B.client.rpc('send_group_message', { p_group: groupId, p_body: `${GROUP_PROBE} cross`, p_reply_to: replyId });
  if (!crossReply.error) fail('group reply (another room)', 'a group message answered a message from the Everyone room');
  else ok('group reply (another room)', `refused (${crossReply.error.code ?? 'error'})`);

  // ---- taken out: nothing; back in: only what is said from now ----
  await A.client.rpc('remove_group_member', { p_group: groupId, p_user: B.userId });
  const outside = await B.client.from('group_chat_messages').select('id').eq('group_id', groupId);
  const outsideSend = await B.client.rpc('send_group_message', { p_group: groupId, p_body: `${GROUP_PROBE} still here?` });
  if ((outside.data ?? []).length === 0 && outsideSend.error) ok('taken out', 'B reads nothing and sends nothing');
  else fail('taken out', `B reads ${JSON.stringify(outside.data)}, send: ${outsideSend.error?.message ?? 'went'}`);

  await A.client.rpc('add_group_members', { p_group: groupId, p_members: [B.userId] });
  const later = await A.client.rpc('send_group_message', { p_group: groupId, p_body: `${GROUP_PROBE} after` });
  const back = await B.client.from('group_chat_messages').select('id').eq('group_id', groupId);
  const backIds = ((back.data ?? []) as { id: string }[]).map((m) => m.id);
  if (backIds.includes(later.data as string) && !backIds.includes(firstId ?? '')) {
    ok('added again', 'B sees what is said from when they joined, not before');
  } else fail('added again', `B sees ${JSON.stringify(backIds)}`);

  // ---- a report, from inside ----
  const reported = await B.client.rpc('report_content', {
    p_kind: 'group_message',
    p_target: later.data as string,
    p_reason: 'other',
    p_details: PROBE_REPORT,
  });
  if (reported.error) fail('report (group message)', reported.error.message);
  else ok('report (group message)', 'a member reported a message they can see');
  const reportedOld = await B.client.rpc('report_content', {
    p_kind: 'group_message',
    p_target: firstId,
    p_reason: 'other',
    p_details: PROBE_REPORT,
  });
  if (!reportedOld.error) fail('report (before joining)', 'B reported a message from before they joined — ids can be probed');
  else ok('report (before joining)', `refused (${reportedOld.error.code ?? 'error'})`);

  // ---- a block, inside a group ----
  const bSays = await B.client.rpc('send_group_message', { p_group: groupId, p_body: `${GROUP_PROBE} from B` });
  await A.client.rpc('block_person', { p_other: B.userId });
  const aReads = await A.client.from('group_chat_messages').select('id').eq('group_id', groupId);
  const aMembers = await A.client.from('group_member_people').select('user_id').eq('group_id', groupId);
  if (
    !((aReads.data ?? []) as { id: string }[]).some((m) => m.id === bSays.data) &&
    !((aMembers.data ?? []) as { user_id: string }[]).some((m) => m.user_id === B.userId)
  ) {
    ok('block (in a group)', 'A no longer sees B’s messages, or B among the members');
  } else fail('block (in a group)', 'B is still visible to A in the group');
  await A.client.from('blocks').delete().eq('blocker_id', A.userId);

  // ---- leaving hands it on ----
  await A.client.rpc('leave_group', { p_group: groupId });
  const heir = await B.client.from('my_groups').select('i_own, member_count').eq('id', groupId).maybeSingle();
  if ((heir.data as { i_own?: boolean } | null)?.i_own === true) ok('leave_group (owner)', 'B took it over when A left');
  else fail('leave_group (owner)', JSON.stringify(heir.data));
  const aGone = await A.client.from('group_chat_messages').select('id').eq('group_id', groupId);
  if ((aGone.data ?? []).length === 0) ok('leave_group (reading)', 'A reads nothing once out');
  else fail('leave_group (reading)', 'A still reads the group after leaving');

  // ---- tidy up ----
  await leaveProbeGroups(B);
  await leaveProbeGroups(A);
  await B.client.from('global_messages').delete().like('body', `${GROUP_PROBE}%`);
  await A.client.from('global_messages').delete().like('body', `${GROUP_PROBE}%`);
}

/**
 * Messages between friends (0028, NOTES §53), both directions.
 *
 * A conversation is never deleted from the app — it outlives unfriending on
 * purpose — so after the first run there is always one between the two test
 * accounts. "Strangers cannot start one" can therefore only be checked while
 * there is none; what is checked every run is the stronger claim: strangers
 * cannot SEND in one.
 */
const DM_PROBE = 'dm probe';

async function checkMessages(
  A: { client: SupabaseClient; userId: string },
  B: { client: SupabaseClient; userId: string },
) {
  const gate = await A.client.from('my_conversations').select('id').limit(1);
  if (gate.error && (isMissingRelation(gate.error) || gate.error.code === '42703')) {
    console.log('\n  ----  messages — not present (migration 0028), not checked');
    return;
  }
  console.log('\nMessages between friends (0028):');

  const strangers = async () => {
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await B.client.from('blocks').delete().eq('blocker_id', B.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  };
  const befriend = async () => {
    await B.client.rpc('send_friend_request', { p_to: A.userId });
    await A.client.rpc('accept_friend_request', { p_from: B.userId });
  };
  await strangers();
  await A.client.from('direct_messages').delete().like('body', `${DM_PROBE}%`);
  await B.client.from('direct_messages').delete().like('body', `${DM_PROBE}%`);

  // ---- starting ----
  const existing = await A.client.from('my_conversations').select('id').eq('person_id', B.userId);
  if ((existing.data ?? []).length === 0) {
    const early = await A.client.rpc('start_conversation', { p_other: B.userId });
    if (!early.error) fail('start_conversation (strangers)', 'A opened a conversation with somebody who is not a friend');
    else ok('start_conversation (strangers)', `refused (${early.error.code ?? 'error'})`);
  } else {
    console.log('  ----  start_conversation (strangers) — a conversation from an earlier run exists; sending is checked instead');
  }

  const forgedConversation = await A.client
    .from('conversations')
    .insert({ user_low: A.userId < B.userId ? A.userId : B.userId, user_high: A.userId < B.userId ? B.userId : A.userId });
  if (!forgedConversation.error) fail('conversations insert', 'a conversation went straight into the table');
  else ok('conversations insert', `refused (${forgedConversation.error.code ?? 'error'}) — only through start_conversation`);

  await befriend();
  const opened = await A.client.rpc('start_conversation', { p_other: B.userId });
  if (opened.error) {
    fail('start_conversation (friends)', opened.error.message);
    await strangers();
    return;
  }
  const conversationId = opened.data as string;
  const again = await B.client.rpc('start_conversation', { p_other: A.userId });
  if (again.data !== conversationId) fail('start_conversation (once per pair)', 'B and A got two different conversations');
  else ok('start_conversation', 'friends, one conversation per pair whoever opens it');

  // ---- sending, reading, "Seen" ----
  const forgedMessage = await A.client
    .from('direct_messages')
    .insert({ conversation_id: conversationId, user_id: A.userId, body: 'around the limit' });
  if (!forgedMessage.error) fail('direct_messages insert', 'a message went straight in, around send_direct_message');
  else ok('direct_messages insert', `refused (${forgedMessage.error.code ?? 'error'})`);

  const sent = await A.client.rpc('send_direct_message', { p_conversation: conversationId, p_body: `${DM_PROBE} from A` });
  if (sent.error) {
    fail('send_direct_message', sent.error.message);
  } else {
    const aMessageId = sent.data as string;
    const bReads = await B.client.from('conversation_messages').select('id, body').eq('conversation_id', conversationId);
    if (!(bReads.data ?? []).some((m: { id: string }) => m.id === aMessageId)) fail('conversation_messages (as B)', "B cannot read A's message");
    else ok('conversation_messages (as B)', "B reads A's message");

    const unread = await B.client.from('my_conversations').select('unread').eq('id', conversationId).maybeSingle();
    if (((unread.data as { unread?: number } | null)?.unread ?? 0) < 1) fail('unread', 'B has an unread message the inbox does not count');
    else ok('unread', 'counted for B');

    await B.client.rpc('mark_conversation_read', { p_conversation: conversationId });
    const seen = await A.client.from('my_conversations').select('their_read_at, unread').eq('id', conversationId).maybeSingle();
    if (!(seen.data as { their_read_at?: string } | null)?.their_read_at) fail('seen', 'B read it and A cannot tell');
    else ok('seen', 'B read it, and A can see that');
    const bAfter = await B.client.from('my_conversations').select('unread').eq('id', conversationId).maybeSingle();
    if (((bAfter.data as { unread?: number } | null)?.unread ?? 1) !== 0) fail('mark read', 'still unread after B read it');
    else ok('mark read', 'nothing unread once read');

    const bEdits = await B.client.rpc('edit_direct_message', { p_id: aMessageId, p_body: 'hijacked' });
    if (!bEdits.error) fail('edit_direct_message (as B)', "B EDITED A'S MESSAGE");
    else ok('edit_direct_message (as B)', `refused (${bEdits.error.code ?? 'error'})`);
    const aEdits = await A.client.rpc('edit_direct_message', { p_id: aMessageId, p_body: `${DM_PROBE} from A (edited)` });
    const edited = await B.client.from('conversation_messages').select('edited_at').eq('id', aMessageId).maybeSingle();
    if (aEdits.error || !(edited.data as { edited_at?: string } | null)?.edited_at) {
      fail('edit_direct_message (as A)', aEdits.error?.message ?? 'edited without being marked');
    } else ok('edit_direct_message (as A)', 'edited, and marked for B');

    await B.client.from('direct_messages').delete().eq('id', aMessageId);
    const survived = await A.client.from('direct_messages').select('id').eq('id', aMessageId);
    if ((survived.data ?? []).length === 0) fail('unsend (as B)', "B UNSENT A'S MESSAGE");
    else ok('unsend (as B)', 'only the sender can take it back');

    const bReacts = await B.client.from('direct_message_reactions').insert({ message_id: aMessageId, user_id: B.userId, emoji: '❤️' });
    const asA = await B.client.from('direct_message_reactions').insert({ message_id: aMessageId, user_id: A.userId, emoji: '😠' });
    const aSeesReaction = await A.client.from('direct_message_reactions').select('user_id').eq('message_id', aMessageId);
    if (bReacts.error || !(aSeesReaction.data ?? []).some((r: { user_id: string }) => r.user_id === B.userId)) {
      fail('react', bReacts.error?.message ?? "A cannot see B's reaction");
    } else ok('react', "B reacted; A sees it");
    if (!asA.error) fail('react (as A)', "B reacted in A's name");
    else ok('react (as A)', `refused (${asA.error.code ?? 'error'})`);

    // ---- reporting a message only the two of them can see ----
    const report = await B.client.rpc('report_content', {
      p_kind: 'direct_message',
      p_target: aMessageId,
      p_reason: 'harassment',
      p_details: PROBE_REPORT,
    });
    if (report.error) fail('report_content (direct message)', report.error.message);
    else {
      const aSeesReport = await A.client.from('reports').select('id').eq('id', report.data as string);
      if ((aSeesReport.data ?? []).length > 0) fail('report (as A)', 'A CAN SEE THAT B REPORTED THEM');
      else ok('report_content (direct message)', 'reported with a copy, invisible to the sender');
    }

    // ---- unfriended: readable, closed ----
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
    const stillReads = await B.client.from('conversation_messages').select('id').eq('conversation_id', conversationId);
    const closed = await B.client.rpc('send_direct_message', { p_conversation: conversationId, p_body: `${DM_PROBE} after` });
    const canSend = await B.client.from('my_conversations').select('can_send').eq('id', conversationId).maybeSingle();
    if ((stillReads.data ?? []).length === 0) fail('unfriended (read)', 'the conversation vanished — it should stay readable');
    else ok('unfriended (read)', 'still readable');
    if (!closed.error) fail('unfriended (send)', 'B sent to somebody who is not a friend any more');
    else ok('unfriended (send)', `refused (${closed.error.code ?? 'error'})`);
    if ((canSend.data as { can_send?: boolean } | null)?.can_send !== false) fail('unfriended (inbox)', 'the inbox says B can still send');
    else ok('unfriended (inbox)', 'closed in the inbox too');

    // ---- blocked: gone, both ways ----
    await befriend();
    await A.client.rpc('block_person', { p_other: B.userId });
    const bInbox = await B.client.from('my_conversations').select('id').eq('id', conversationId);
    const bMessages = await B.client.from('conversation_messages').select('id').eq('conversation_id', conversationId);
    const bTable = await B.client.from('direct_messages').select('id').eq('conversation_id', conversationId);
    const aInbox = await A.client.from('my_conversations').select('id').eq('id', conversationId);
    if ((bInbox.data ?? []).length + (bMessages.data ?? []).length + (bTable.data ?? []).length > 0) {
      fail('block (B side)', 'B still sees the conversation of somebody who blocked them');
    } else ok('block (B side)', 'the conversation is gone for the blocked person');
    if ((aInbox.data ?? []).length > 0) fail('block (A side)', 'A still sees the conversation with somebody A blocked');
    else ok('block (A side)', 'and for the one who blocked');
    const bSends = await B.client.rpc('send_direct_message', { p_conversation: conversationId, p_body: `${DM_PROBE} blocked` });
    if (!bSends.error) fail('block (send)', 'B sent a message to somebody who blocked them');
    else ok('block (send)', `refused (${bSends.error.code ?? 'error'})`);
  }

  // ---- tidy up ----
  await strangers();
  await A.client.from('direct_messages').delete().like('body', `${DM_PROBE}%`);
  await B.client.from('direct_messages').delete().like('body', `${DM_PROBE}%`);
}

/**
 * The friends' leaderboard (0029, NOTES §54) — the first time anybody else sees
 * a streak, so every way onto somebody's board is checked, and every way off.
 */
async function checkLeaderboard(
  A: { client: SupabaseClient; userId: string },
  B: { client: SupabaseClient; userId: string },
) {
  const gate = await A.client.rpc('friends_leaderboard');
  if (gate.error && (gate.error.code === 'PGRST202' || gate.error.code === '42883')) {
    console.log('\n  ----  leaderboard — not present (migration 0029), not checked');
    return;
  }
  console.log("\nThe friends' leaderboard (0029):");

  type Row = { person_id: string; current_streak: number; best_streak: number; is_me: boolean };
  const board = async (who: { client: SupabaseClient }) =>
    ((await who.client.rpc('friends_leaderboard')).data ?? []) as Row[];
  const strangers = async () => {
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await B.client.from('blocks').delete().eq('blocker_id', B.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  };
  const befriend = async () => {
    await B.client.rpc('send_friend_request', { p_to: A.userId });
    await A.client.rpc('accept_friend_request', { p_from: B.userId });
  };
  await strangers();
  await B.client.from('profiles').update({ show_streak: true }).eq('id', B.userId);

  const alone = await board(A);
  if (alone.some((r) => r.person_id === B.userId)) fail('leaderboard (strangers)', "A SEES B'S STREAK WITHOUT BEING FRIENDS");
  else ok('leaderboard (strangers)', 'a stranger’s streak is not on the board');
  const me = alone.find((r) => r.is_me);
  if (!me || me.person_id !== A.userId) fail('leaderboard (self)', 'A is not on their own board');
  else if (me.current_streak > me.best_streak) fail('leaderboard (self)', `a streak of ${me.current_streak} beats the best ever, ${me.best_streak}`);
  else ok('leaderboard (self)', `A, ${me.current_streak} now, best ${me.best_streak}`);

  await befriend();
  const aBoard = await board(A);
  const bBoard = await board(B);
  if (!aBoard.some((r) => r.person_id === B.userId) || !bBoard.some((r) => r.person_id === A.userId)) {
    fail('leaderboard (friends)', 'friends are not on each other’s boards');
  } else ok('leaderboard (friends)', 'each on the other’s board');

  // B turns it off: gone from A's board, still on their own.
  const off = await B.client.from('profiles').update({ show_streak: false }).eq('id', B.userId);
  if (off.error) fail('show_streak', off.error.message);
  const hidden = await board(A);
  const ownStill = await board(B);
  if (hidden.some((r) => r.person_id === B.userId)) fail('show_streak off', "B turned it off and A still sees B's streak");
  else ok('show_streak off', "gone from A's board");
  if (!ownStill.some((r) => r.is_me)) fail('show_streak off (self)', 'B vanished from their own board');
  else ok('show_streak off (self)', 'still on their own');

  // Nobody else can flip it.
  await A.client.from('profiles').update({ show_streak: true }).eq('id', B.userId);
  const stillOff = await B.client.from('profiles').select('show_streak').eq('id', B.userId).maybeSingle();
  if ((stillOff.data as { show_streak?: boolean } | null)?.show_streak !== false) fail('show_streak (as A)', "A TURNED B'S STREAK BACK ON");
  else ok('show_streak (as A)', 'only B decides');
  await B.client.from('profiles').update({ show_streak: true }).eq('id', B.userId);

  const direct = await B.client.rpc('best_streak_of', { p_user: A.userId });
  if (!direct.error) fail('best_streak_of', "B READ A'S BEST STREAK DIRECTLY");
  else ok('best_streak_of', `not callable (${direct.error.code ?? 'error'})`);

  await A.client.rpc('block_person', { p_other: B.userId });
  if ((await board(B)).some((r) => r.person_id === A.userId)) fail('leaderboard (block)', 'B still sees the streak of somebody who blocked them');
  else ok('leaderboard (block)', 'gone across a block');

  await strangers();
}

/**
 * The community rules, and who may moderate (0030, NOTES §55).
 *
 * The test accounts are not moderators and must never be — HANDOFF prints their
 * password — so what is checked is that EVERY moderator door is shut to them,
 * that the rules gate really refuses before agreeing and really opens after,
 * and that nobody can write their own standing. A restriction in force cannot
 * be checked end to end from here without a moderator's session; the SQL that
 * enforces it is held line for line by tests/moderation.test.ts.
 */
async function checkModeration(
  A: { client: SupabaseClient; userId: string },
  B: { client: SupabaseClient; userId: string },
) {
  const gate = await A.client.rpc('is_admin');
  if (gate.error && (gate.error.code === 'PGRST202' || gate.error.code === '42883')) {
    console.log('\n  ----  rules and moderation — not present (migration 0030), not checked');
    return;
  }
  console.log('\nThe community rules, and who may moderate (0030):');

  // ---- the rules gate ----
  await B.client.from('profiles').update({ rules_accepted_at: null }).eq('id', B.userId);
  const refused = await B.client.rpc('send_global_message', { message: 'rules probe — should never land' });
  if (refused.error?.code === 'RULES') ok('rules (before)', 'a message refused until the rules are agreed to');
  else {
    fail('rules (before)', `expected RULES, got ${refused.error?.code ?? 'a sent message'}`);
    await B.client.from('global_messages').delete().like('body', 'rules probe%');
  }
  const sharing = await B.client
    .from('study_sets')
    .insert({ user_id: B.userId, title: 'Rules probe set', status: 'ready', visibility: 'public' });
  if (sharing.error?.code === 'RULES') ok('rules (sharing)', 'a set cannot be shared before the rules either');
  else fail('rules (sharing)', `expected RULES, got ${sharing.error?.code ?? 'a shared set'}`);
  await B.client.from('study_sets').delete().eq('title', 'Rules probe set');

  const agreed = await B.client.rpc('accept_community_rules');
  const after = await B.client.rpc('send_global_message', { message: 'rules probe — agreed' });
  if (agreed.error || after.error) fail('rules (after)', `${agreed.error?.message ?? ''} ${after.error?.message ?? ''}`.trim());
  else ok('rules (after)', 'agreed, and the message goes');
  await B.client.from('global_messages').delete().like('body', 'rules probe%');

  // ---- nobody writes their own standing ----
  const selfRestrict = await B.client.from('restrictions').insert({ user_id: A.userId, until: null });
  if (!selfRestrict.error) fail('restrictions insert', 'B restricted A with a direct insert');
  else ok('restrictions insert', `refused (${selfRestrict.error.code ?? 'error'})`);
  const selfWarn = await B.client.from('warnings').insert({ user_id: A.userId, rule: 'kind' });
  if (!selfWarn.error) fail('warnings insert', 'B warned A with a direct insert');
  else ok('warnings insert', `refused (${selfWarn.error.code ?? 'error'})`);
  const selfAdmin = await B.client.from('app_admins').insert({ user_id: B.userId });
  if (!selfAdmin.error) {
    fail('app_admins insert', 'B MADE THEMSELVES A MODERATOR');
    await B.client.from('app_admins').delete().eq('user_id', B.userId);
  } else ok('app_admins insert', `refused (${selfAdmin.error.code ?? 'error'})`);

  // ---- every moderator door, shut ----
  const isAdmin = await B.client.rpc('is_admin');
  if (isAdmin.data !== false) fail('is_admin', 'the test account is a moderator — it must never be');
  else ok('is_admin', 'not a moderator');
  const queue = await B.client.from('report_queue').select('id').limit(1);
  if ((queue.data ?? []).length > 0) fail('report_queue', 'B CAN READ THE REPORT QUEUE');
  else ok('report_queue', 'empty to somebody who is not a moderator');
  for (const [fnName, args] of [
    ['resolve_reports', { p_kind: 'person', p_target: A.userId, p_status: 'dismissed' }],
    ['moderate_remove', { p_kind: 'post', p_target: A.userId }],
    ['restrict_account', { p_user: A.userId, p_days: 7, p_reason: 'probe' }],
    ['lift_restriction', { p_user: A.userId }],
    ['warn_account', { p_user: A.userId, p_rule: 'kind', p_note: 'probe' }],
  ] as const) {
    const r = await B.client.rpc(fnName, args);
    if (!r.error) fail(fnName, `B CALLED ${fnName.toUpperCase()} AS IF A MODERATOR`);
    else ok(fnName, `refused (${r.error.code ?? 'error'})`);
  }
  const standing = await A.client.from('restrictions').select('user_id').eq('user_id', A.userId);
  if ((standing.data ?? []).length > 0) fail('restrictions (A)', 'A ended up restricted by a probe');
  else ok('restrictions (A)', 'nothing written');
}

main().catch((err) => {
  console.error('\nIsolation test could not run:', err instanceof Error ? err.message : err);
  process.exit(2);
});
