/**
 * Friends, blocking and reporting — in the built app, as two real people
 * (NOTES §51).
 *
 * `scripts/isolation-test.ts` proves the database half: who can read and write
 * what. This proves the screens: that Profile shows a request that is waiting,
 * that search finds a person and says where you stand with them, that Accept,
 * Block, Unblock and Report each do what their button says — and, after every
 * step, that the DATABASE agrees with what the screen claims. A screen that
 * says "You blocked Probe B" over a block that never landed is the silent
 * failure this project keeps paying for (HANDOFF: five times now).
 *
 * Run:
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/friends-probe.ts [--out <dir>]
 *
 * Needs migration 0026, and TEST_USER_A_* / TEST_USER_B_* like the isolation
 * test. Signs in to the app as A; B asks A to be friends from the data layer.
 *
 * Cleans up after itself, apart from one thing it cannot: the report it sends.
 * Reports have no delete policy on purpose (0026), so it is marked
 * `friends probe - not a real report` and the SQL to clear it is printed.
 *
 * A plain hyphen, not a dash: the owner retyped the first version's "—" as "-"
 * copying the cleanup SQL, and it would have matched nothing (NOTES §51.10).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { openPage, type Page } from './screenshot';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const publishable = process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
const creds = {
  a: { email: process.env.TEST_USER_A_EMAIL, password: process.env.TEST_USER_A_PASSWORD },
  b: { email: process.env.TEST_USER_B_EMAIL, password: process.env.TEST_USER_B_PASSWORD },
};
if (!url || !publishable || !creds.a.email || !creds.b.email) {
  console.error('Missing the Supabase settings or TEST_USER_A_* / TEST_USER_B_*.');
  process.exit(2);
}

const A_USERNAME = 'isoprobe_a';
const B_USERNAME = 'isoprobe_b';
const B_NAME = 'Probe B';
const PROBE_REPORT = 'friends probe - not a real report';

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

/**
 * Wait for words on screen — anywhere in the BODY, not just #root. The report
 * and block sheets are Modals, which react-native-web draws outside #root;
 * measured on this probe's first run, where a sheet that had opened was
 * reported as never appearing.
 */
const showing = (page: Page, words: string, timeoutMs?: number) =>
  page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(words)}) ? 'y' : ''`,
    `"${words}" on screen`,
    timeoutMs,
  );

/** Wait for words to be gone. */
const gone = (page: Page, words: string) =>
  page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(words)}) ? '' : 'y'`,
    `"${words}" gone`,
  );

/** Type into one field, found by its placeholder — Profile has two. */
async function typeInto(page: Page, placeholder: string, value: string): Promise<void> {
  const done = await page.evaluate<string>(`(() => {
    const el = [...document.querySelectorAll('input, textarea')]
      .find((e) => e.getAttribute('placeholder') === ${JSON.stringify(placeholder)});
    if (!el) return '';
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(value)} ? 'ok' : '';
  })()`);
  if (!done) throw new Error(`Could not type into "${placeholder}"`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (outDir) await page.screenshot(join(outDir, name));
}

async function main() {
  console.log('Friends probe\n');
  const A = await signIn('a');
  const B = await signIn('b');

  const gate = await A.client.from('my_friends').select('id').limit(1);
  if (gate.error) {
    console.error(`my_friends is not readable (${gate.error.code}): is migration 0026 applied?`);
    process.exit(2);
  }

  // What B looked like before, so the probe can put it back.
  const before = await B.client.from('profiles').select('display_name, username').eq('id', B.userId).maybeSingle();
  const bBefore = (before.data ?? { display_name: null, username: null }) as {
    display_name: string | null;
    username: string | null;
  };

  // A clean start, whatever an earlier run left.
  const clean = async () => {
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await B.client.from('blocks').delete().eq('blocker_id', B.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  };
  await clean();
  await A.client.from('profiles').update({ display_name: 'Probe A', username: null }).eq('id', A.userId);
  await B.client.from('profiles').update({ display_name: B_NAME, username: B_USERNAME }).eq('id', B.userId);

  const page = await openPage({ width: 393, height: 852, dark: true });
  try {
    console.log('A, in the built app:');

    // --- the one-time notice on Home -------------------------------------
    await page.goto('/');
    await showing(page, 'New: friends');
    await shot(page, '00-home-whats-new.png');
    await page.click('Got it');
    await gone(page, 'New: friends');
    await page.goto('/');
    await showing(page, 'Your sets');
    if ((await page.text()).includes('New: friends')) fail("what's new", 'came back after "Got it"');
    else ok("what's new", 'shown once, and gone after "Got it" — across a reload');

    // --- a username, saved from the screen --------------------------------
    await page.goto('/profile');
    await showing(page, 'Pick a username');
    await shot(page, '01-profile-no-username.png');

    await typeInto(page, 'probe_a', B_USERNAME).catch(async () => {
      // The placeholder is a suggestion made from the name; find it by label instead.
      await page.fill(B_USERNAME);
    });
    await page.click('Save username');
    await showing(page, 'That username is taken');
    ok('username (taken)', "B's username refused, in words");

    await page.fill(A_USERNAME);
    await page.click('Save username');
    await showing(page, 'Saved.');
    const saved = await A.client.from('profiles').select('username').eq('id', A.userId).maybeSingle();
    if ((saved.data as { username?: string } | null)?.username === A_USERNAME) ok('username', 'saved, and the database has it');
    else fail('username', `the screen said Saved and the database has ${JSON.stringify(saved.data)}`);
    await showing(page, `@${A_USERNAME}`);
    if ((await page.text()).includes('Pick a username')) fail('username folds away', 'the editor is still open after saving');
    else ok('username folds away', 'saved, and the editor gives the screen back');

    // --- a request, waiting ---------------------------------------------
    const asked = await B.client.rpc('send_friend_request', { p_to: A.userId });
    if (asked.error) throw new Error(`B could not ask A: ${asked.error.message}`);
    await page.goto('/profile');
    await showing(page, 'Friend requests (1)');
    const waiting = await page.text();
    if (waiting.includes(B_NAME) && waiting.includes(`@${B_USERNAME}`)) ok('request shown', "B's request waits on Profile");
    else fail('request shown', 'Profile does not show who is asking');
    await shot(page, '02-profile-request.png');

    // --- search ---------------------------------------------------------
    await typeInto(page, 'A name or @username', `@${B_USERNAME.slice(0, 6)}`);
    // Only the search result says "Wants to be friends" — the request row above
    // leaves it to its heading — so this cannot pass before search answers.
    await page.waitFor(
      `[...document.querySelectorAll('[role="button"]')].some((n) => (n.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(
        `${B_NAME}, @${B_USERNAME}. Wants to be friends`,
      )})) ? 'y' : ''`,
      'B in the search results, with where A stands',
    );
    ok('search', 'B found by the start of their username, marked "Wants to be friends"');
    await shot(page, '03-search.png');

    // --- accept -----------------------------------------------------------
    await page.click('Accept');
    await showing(page, 'Friends (1)');
    const accepted = await A.client.from('my_friends').select('status').eq('person_id', B.userId).maybeSingle();
    if ((accepted.data as { status?: string } | null)?.status === 'accepted') ok('accept', 'friends, on screen and in the database');
    else fail('accept', `the screen says friends and the database says ${JSON.stringify(accepted.data)}`);
    await typeInto(page, 'A name or @username', '');
    await shot(page, '04-profile-friends.png');

    // --- friends' streaks on Progress (NOTES §54) ------------------------------
    const board = await A.client.rpc('friends_leaderboard');
    if (board.error) {
      console.log('  ----  leaderboard — not present (migration 0029), not checked');
    } else {
      await page.goto('/progress');
      await showing(page, "Friends' streaks");
      await page.waitFor(
        `[...document.querySelectorAll('[role="button"]')].some((b) => /^(\\d+\\. )?${B_NAME},/.test(b.getAttribute('aria-label') ?? '')) ? 'y' : ''`,
        'B on the board',
      );
      ok('leaderboard', "B is on A's board, ranked, now that they are friends");
      await shot(page, '04b-leaderboard.png');

      // The switch in Settings, and the database agreeing.
      await page.goto('/settings');
      await showing(page, 'Show my streak to friends');
      await page.evaluate(`(() => {
        const s = document.querySelector('[aria-label="Show my streak to friends"]');
        s.click();
      })()`);
      let shown: boolean | undefined = true;
      for (let i = 0; i < 20 && shown !== false; i++) {
        await new Promise((r) => setTimeout(r, 300));
        shown = ((await A.client.from('profiles').select('show_streak').eq('id', A.userId).maybeSingle()).data as {
          show_streak?: boolean;
        } | null)?.show_streak;
      }
      const bSeesA = (((await B.client.rpc('friends_leaderboard')).data ?? []) as { person_id: string }[]).some(
        (r) => r.person_id === A.userId,
      );
      if (shown === false && !bSeesA) ok('show my streak', "switched off in Settings: saved, and A is off B's board");
      else fail('show my streak', `saved: ${shown === false}, still on B's board: ${bSeesA}`);
      await A.client.from('profiles').update({ show_streak: true }).eq('id', A.userId);
    }

    // --- their page ---------------------------------------------------------
    await page.goto(`/person/${B.userId}`);
    await showing(page, "You're friends.");
    const theirs = await page.text();
    if (theirs.includes(`@${B_USERNAME}`)) ok('person page', 'name, username, and "You\'re friends."');
    else fail('person page', 'no username on their page');
    await shot(page, '05-person-friends.png');

    // --- block, from the ⋯ ------------------------------------------------
    await page.click(`More about ${B_NAME}`);
    await page.click(`Block ${B_NAME}`);
    await showing(page, "won't be able to find you");
    // The ⋯ menu fades out as the sheet fades in, and its item is ALSO labelled
    // "Block Probe B" — so pressing that label while the menu is still in the
    // page pressed the menu item again, blocked nobody, and failed two runs in
    // three once a person's page grew a Posts section and the timing moved
    // (NOTES §52.8). Wait for the menu to be gone first; "Report Probe B" is
    // only ever in the menu.
    await page.waitFor(
      `[...document.querySelectorAll('[role="button"]')].some((b) => b.innerText.trim() === ${JSON.stringify(`Report ${B_NAME}`)}) ? '' : 'y'`,
      'the ⋯ menu to close',
    );
    await shot(page, '06-block-sheet.png');
    await page.click(`Block ${B_NAME}`);
    await showing(page, `You blocked ${B_NAME}.`);
    const blockRow = await A.client.from('blocks').select('blocked_id').eq('blocked_id', B.userId);
    const friendsAfter = await A.client.from('my_friends').select('id').eq('person_id', B.userId);
    if ((blockRow.data ?? []).length === 1 && (friendsAfter.data ?? []).length === 0) {
      ok('block', 'blocked, and no longer friends — on screen and in the database');
    } else {
      fail('block', `blocks: ${JSON.stringify(blockRow.data)}, friendships: ${JSON.stringify(friendsAfter.data)}`);
    }
    await shot(page, '07-person-blocked.png');

    // What B sees now: nobody.
    const bLooks = await B.client.from('public_profiles').select('id').eq('id', A.userId);
    if ((bLooks.data ?? []).length === 0) ok('block (as B)', 'A is gone from B’s side');
    else fail('block (as B)', 'B can still see A');

    // --- unblock, from Profile ------------------------------------------------
    await page.goto('/profile');
    await showing(page, 'Blocked');
    await shot(page, '08-profile-blocked-list.png');
    await page.click('Unblock');
    await gone(page, 'Unblock');
    const unblocked = await A.client.from('blocks').select('blocked_id').eq('blocked_id', B.userId);
    if ((unblocked.data ?? []).length === 0) ok('unblock', 'gone from the list and from the database');
    else fail('unblock', 'the list says unblocked and the block is still there');

    // --- report, from the ⋯ -------------------------------------------------
    await page.goto(`/person/${B.userId}`);
    await showing(page, 'Add friend');
    await page.click(`More about ${B_NAME}`);
    await page.click(`Report ${B_NAME}`);
    await showing(page, 'What is wrong with it?');
    await page.click('Send report');
    await showing(page, 'Pick what is wrong first.');
    ok('report needs a reason', 'refused in words before anything is sent');
    await page.click('Spam');
    await typeInto(page, 'What happened', PROBE_REPORT);
    await shot(page, '09-report-sheet.png');
    await page.click('Send report');
    await showing(page, 'Report sent');
    const report = await A.client
      .from('reports')
      .select('target_kind, reason, details, snapshot')
      .eq('target_id', B.userId)
      .eq('details', PROBE_REPORT)
      .maybeSingle();
    const row = report.data as { target_kind?: string; reason?: string; snapshot?: string } | null;
    if (row?.target_kind === 'person' && row.reason === 'spam' && row.snapshot?.includes(`@${B_USERNAME}`)) {
      ok('report', 'sent, with the database’s own copy of who it is about');
    } else {
      fail('report', `the screen says sent and the database has ${JSON.stringify(report.data)}`);
    }
    // The sheet is a Modal, which react-native-web draws OUTSIDE #root — so
    // `page.text()` cannot see it. The whole body can.
    const sheet = await page.evaluate<string>('document.body.innerText');
    if (sheet.includes(`Block ${B_NAME}`)) ok('report offers the block', 'one tap away');
    else fail('report offers the block', 'no block offered after reporting');
    await shot(page, '10-report-sent.png');
    await page.click('Done');

    // --- Settings, from the top right of Profile ---------------------------
    await page.goto('/profile');
    await showing(page, 'Change username');
    await page.click('Settings');
    await page.waitFor(`location.pathname === '/settings' ? 'y' : ''`, 'Settings to open');
    await showing(page, 'Your Gemini key');
    ok('settings', 'opens from Profile’s top right');

    const errors = page.logs().filter((l) => /uncaught|TypeError|ReferenceError/i.test(l));
    if (errors.length > 0) fail('browser console', errors.join(' | '));
    else ok('browser console', 'no uncaught errors');
  } catch (err) {
    fail('probe', err instanceof Error ? err.message : String(err));
    if (outDir) await page.screenshot(join(outDir, 'failed.png')).catch(() => {});
  } finally {
    await page.close();
    await clean();
    await A.client.from('profiles').update({ username: null }).eq('id', A.userId);
    await B.client
      .from('profiles')
      .update({ display_name: bBefore.display_name, username: bBefore.username })
      .eq('id', B.userId);
  }

  console.log(
    `\n  (the report cannot be deleted from the app, by design. To clear it, in the Supabase SQL editor (not PowerShell):\n` +
      `   delete from public.reports where details like '%probe%not a real report';)`,
  );
  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
