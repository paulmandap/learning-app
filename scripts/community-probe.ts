/**
 * Sharing, stars and the chat — in the built app, as two real people.
 *
 * ## What this is for, and why the isolation test is not enough
 *
 * `scripts/isolation-test.ts` proves the DATABASE half: which rows cross
 * between accounts and which do not. It says nothing about whether the app
 * shows them. The plumbing this feature added is mostly in the screens —
 * `readableSet` deciding `owned`, three study screens keeping it in their query
 * key, the ••• menu and "Report" coming off, the card count coming from a
 * different place — and every one of those fails in the same quiet way: an
 * empty deck on a set full of cards, with no error anywhere, because RLS is
 * right to return nothing and nothing asks the other relation.
 *
 * So this seeds a shared set through the data layer, then drives the BUILT
 * bundle as the OTHER person and looks at what is on screen.
 *
 * ## Needs migration 0021 applied
 *
 * Without it every check here fails at the first step, and says so rather than
 * reporting a feature that is missing as a feature that is broken.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/community-probe.ts [--out <dir>]
 *
 * Requires TEST_USER_A_* and TEST_USER_B_* in the environment, like the
 * isolation test. It cleans up after itself — synthetic data left in a shared
 * test account has already produced one wrong conclusion (NOTES §9.4).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openPage } from './screenshot';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishable = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

const creds = {
  a: { email: process.env.TEST_USER_A_EMAIL, password: process.env.TEST_USER_A_PASSWORD },
  b: { email: process.env.TEST_USER_B_EMAIL, password: process.env.TEST_USER_B_PASSWORD },
};

if (!url || !publishable || !creds.a.email || !creds.b.email) {
  console.error(
    'Missing EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY, or the test users.\n' +
      'Set TEST_USER_A_EMAIL/PASSWORD and TEST_USER_B_EMAIL/PASSWORD.',
  );
  process.exit(2);
}

/** Distinctive, so the cleanup also sweeps what a failed run left behind. */
const SET_TITLE = 'Community probe set';
const CARD_PROMPT = 'What does the community probe card ask?';
const CARD_ANSWER = 'Exactly this.';
const CHAT_LINE = `community probe message ${Date.now()}`;

const outDir = (() => {
  const i = process.argv.indexOf('--out');
  if (i === -1) return null;
  const dir = process.argv[i + 1]!;
  mkdirSync(dir, { recursive: true });
  return dir;
})();

let failures = 0;
let checks = 0;
const ok = (name: string, detail = '') => {
  checks++;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
};
const fail = (name: string, detail: string) => {
  checks++;
  failures++;
  console.error(`  FAIL  ${name} — ${detail}`);
};

async function signIn(which: 'a' | 'b'): Promise<{ client: SupabaseClient; userId: string }> {
  const client = createClient(url!, publishable!, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: creds[which].email!,
    password: creds[which].password!,
  });
  if (error || !data.user) throw new Error(`Could not sign in ${which}: ${error?.message}`);
  return { client, userId: data.user.id };
}

async function main() {
  console.log('Community probe\n');

  const A = await signIn('a');
  const B = await signIn('b');

  // ------------------------------------------------------------- seed (A) --
  // A real set with real cards, shared. Made directly rather than generated:
  // this probe is about what the screens do with a shared set, and spending a
  // Gemini quota to arrive at the same two rows would only add a way to fail.
  await A.client.from('profiles').update({ display_name: 'Probe A', avatar: 'face:5' }).eq('id', A.userId);

  const { data: set, error: setErr } = await A.client
    .from('study_sets')
    .insert({
      user_id: A.userId,
      title: SET_TITLE,
      status: 'ready',
      visibility: 'public',
      published_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (setErr || !set) {
    console.error(
      `\nCould not share a set: ${setErr?.message}\n` +
        'Is migration 0021 applied? Nothing below can run without it.',
    );
    process.exit(2);
  }
  const setId = (set as { id: string }).id;

  // `hidden` is spelled out on BOTH rows, and that is not tidiness. PostgREST
  // builds one INSERT for a batch, so a key present on one row and absent from
  // another is sent as NULL for the row that omitted it — it does NOT fall back
  // to the column default. Measured on this probe's first run: "null value in
  // column hidden of relation study_items violates not-null constraint", from an
  // insert where only the second row mentioned it.
  const { error: itemErr } = await A.client.from('study_items').insert([
    {
      user_id: A.userId,
      study_set_id: setId,
      page_index: 0,
      kind: 'flashcard',
      level: 'remember',
      prompt: CARD_PROMPT,
      answer: CARD_ANSWER,
      source_excerpt: 'The community probe card asks exactly this.',
      excerpt_verified: true,
      hidden: false,
    },
    {
      user_id: A.userId,
      study_set_id: setId,
      page_index: 0,
      kind: 'flashcard',
      level: 'remember',
      prompt: 'A reported card nobody should ever see',
      answer: 'not this',
      source_excerpt: 'A reported card nobody should ever see.',
      excerpt_verified: true,
      hidden: true,
    },
  ]);
  if (itemErr) {
    await A.client.from('study_sets').delete().eq('title', SET_TITLE);
    throw new Error(`Seed failed (study_items): ${itemErr.message}`);
  }

  console.log(`Seeded: A shared "${SET_TITLE}" (${setId})\n`);

  // ------------------------------------------------ the app, as the OTHER --
  const page = await openPage({
    width: 393,
    height: 852,
    dark: true,
    // The OTHER person. Everything below is about what a set looks like to
    // somebody who does not own it.
    as: { email: creds.b.email!, password: creds.b.password! },
  });

  try {
    // --- Community lists it ------------------------------------------------
    console.log('B, in the built app:');
    await page.goto('/community');
    await page.waitFor(
      `document.body.innerText.includes(${JSON.stringify(SET_TITLE)}) ? 'y' : ''`,
      'the shared set in Community',
    );
    const listed = await page.text();
    if (listed.includes('Probe A')) ok('Community lists it', "with A's name beside it");
    else fail('Community lists it', "the set is there but nobody's name is");
    if (outDir) await page.screenshot(join(outDir, '01-community.png'));

    // --- opening it gives a read-only set screen ---------------------------
    //
    // Not `page.click(SET_TITLE)`. That helper matches a control whose visible
    // text or aria-label EQUALS the label, and a shared set's row is labelled
    // for a screen reader as "<title>, by <who>, <n> stars" — so an exact match
    // never fires. Matching the start of the label keeps the good label and
    // still names one row. Measured: the exact match timed out against a row
    // that was on screen and correct.
    await page.evaluate(`(() => {
      const el = [...document.querySelectorAll('[role="button"]')]
        .find((n) => (n.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(SET_TITLE + ',')}));
      if (!el) throw new Error('no row for the shared set');
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      el.click();
    })()`);
    await page.waitFor(
      `location.pathname.includes('/set/') ? 'y' : ''`,
      'the set screen',
    );
    await page.waitFor(
      `document.body.innerText.includes('Shared by') ? 'y' : ''`,
      '"Shared by" on the set screen',
    );
    const setScreen = await page.text();

    if (setScreen.includes('Shared by Probe A')) ok('set screen', 'says whose it is');
    else fail('set screen', `no "Shared by Probe A" — saw: ${setScreen.slice(0, 160)}`);

    // The card count comes from public_sets, not from countItems — which reads
    // study_items and would answer 0, hiding every "Study this set" row.
    if (/\b1 card\b/.test(setScreen)) ok('card count', 'counted through the shared view');
    else fail('card count', 'the count is wrong or missing; does it still call countItems?');

    if (setScreen.includes('Study this set')) ok('study rows', 'offered on a shared set');
    else fail('study rows', 'no way to study a set that has a card in it');

    // Nothing that writes to somebody else's set may be offered.
    const menu = await page.evaluate<string>(
      `document.querySelector('[aria-label="More"], [aria-label="More actions"]') ? 'present' : 'absent'`,
    );
    if (menu === 'absent') ok('the ••• menu', 'not offered on a set that is not yours');
    else fail('the ••• menu', 'a set you do not own offers actions that would do nothing');

    if (outDir) await page.screenshot(join(outDir, '02-shared-set.png'));

    // --- the deck deals A's cards -----------------------------------------
    //
    // `?level=remember` and not the bare route, because a deck with no level in
    // its link opens on UNDERSTAND (`startingLevel`, src/core/deck.ts) and this
    // probe's cards are all Remember. Without it the screen correctly shows
    // "Remember 1 · Understand 0 · Apply 0" and "No cards at this level yet",
    // and the probe reads that as a shared set dealing nothing — which is how
    // its first run accused the feature of a bug the app does not have. The set
    // screen passes the same parameter when it knows where the work is.
    await page.goto(`/set/${setId}/flashcards?level=remember`);
    await page.waitFor(
      `document.body.innerText.includes(${JSON.stringify(CARD_PROMPT)}) ? 'y' : ''`,
      "A's card in B's deck",
    );
    const deck = await page.text();
    ok('the deck', "deals the shared set's cards");

    // The reported card is hidden for everyone, not only for its owner.
    if (deck.includes('reported card nobody')) fail('reported card', 'served to another person');
    else ok('reported card', 'not dealt');

    // "Open page" would point at a file in A's private bucket, and "Report"
    // would update no rows and say "you won't see that one again" about a card
    // that is coming back.
    if (deck.includes('Open page')) fail('Open page', "offered for a file B cannot open");
    else ok('Open page', 'not offered');
    if (/\bReport\b/.test(deck)) fail('Report', 'offered where it would silently do nothing');
    else ok('Report', 'not offered on somebody else’s card');

    if (outDir) await page.screenshot(join(outDir, '03-deck.png'));

    // --- the chat round-trips ---------------------------------------------
    await page.goto('/community');
    await page.click('Chat');
    await page.waitFor(
      `document.querySelector('textarea') ? 'y' : ''`,
      'the chat box',
    );
    // `fill` only finds `input` elements, and a multiline TextInput renders as
    // a textarea — so focus it and send real key events, the same way the note
    // editor has to be typed into (NOTES §43.6).
    await page.evaluate(`document.querySelector('textarea').focus()`);
    await page.type(CHAT_LINE);
    await page.click('Send');
    await page.waitFor(
      `document.body.innerText.includes(${JSON.stringify(CHAT_LINE)}) ? 'y' : ''`,
      'the message B sent',
    );
    ok('chat', 'a message sent from the app appears in the room');

    // And A can read it, which is the whole point of one room.
    const asA = await A.client.from('global_chat').select('body').eq('body', CHAT_LINE);
    if ((asA.data ?? []).length === 1) ok('chat (as A)', "the other person can read it");
    else fail('chat (as A)', 'the message did not reach the other account');

    if (outDir) await page.screenshot(join(outDir, '04-chat.png'));
  } finally {
    await page.close();

    // In the `finally`, so a check that throws half way still tidies up. The
    // first run of this probe left its shared set on the test account because
    // the cleanup sat after the try block — and synthetic data left in a shared
    // account has already produced one wrong conclusion here (NOTES §9.4).
    await B.client.from('set_stars').delete().eq('user_id', B.userId).eq('study_set_id', setId);
    await B.client.from('global_messages').delete().eq('body', CHAT_LINE);
    await B.client.from('review_state').delete().eq('study_set_id', setId);
    await B.client.from('attempts').delete().eq('study_set_id', setId);
    const { error: sweep } = await A.client.from('study_sets').delete().eq('title', SET_TITLE);
    if (sweep) console.log(`  (cleanup note: ${sweep.message})`);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (outDir) console.log(`Pictures in ${outDir}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(2);
});
