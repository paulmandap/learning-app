/**
 * Group chats and replies — in the built app, as two real people (NOTES §58).
 *
 * The isolation test proves who can read and write what in a group. This
 * proves the screens, and asks the DATABASE after every step whether it agrees:
 * a group made from the pencil in Chat, with a friend ticked; a message sent
 * from its box; B's message arriving; a reply to it from the message's sheet,
 * saved as a reply to that message; the group renamed from who is in it; and
 * leaving it, which hands it to B.
 *
 * Run:
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/groups-probe.ts [--out <dir>]
 *
 * Needs 0032, and TEST_USER_A_* / TEST_USER_B_*. Signs in to the app as A; B
 * writes from the data layer. Cleans up after itself: B leaves last, and a
 * group nobody is in is gone.
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

const MARK = 'groups probe';
const TITLE = `${MARK} study group`;
const RENAMED = `${MARK} renamed`;
const FROM_A = `${MARK}: hello group`;
const FROM_B = `${MARK}: hi from B`;
const REPLY = `${MARK}: answering B`;

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

/** Words anywhere on the page — sheets are Modals, drawn outside #root (NOTES §51.8). */
const showing = (page: Page, words: string, timeoutMs?: number) =>
  page.waitFor(
    `document.body.innerText.includes(${JSON.stringify(words)}) ? 'y' : ''`,
    `"${words}" on screen`,
    timeoutMs,
  );

/** Type into one field, found by its placeholder. */
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

/**
 * Press the control with this label that sits with these words — every
 * message has its own "More", so a plain click would press the first one's.
 * The nearest ancestor holding the words wins (posts-probe's lesson).
 */
async function clickNear(page: Page, words: string, label: string): Promise<void> {
  const done = await page.evaluate<string>(`(() => {
    let best = null, bestDepth = Infinity;
    for (const b of document.querySelectorAll('[role="button"]')) {
      if (b.getAttribute('aria-label') !== ${JSON.stringify(label)}) continue;
      let el = b;
      for (let i = 0; i < 12 && el; i++, el = el.parentElement) {
        if (el.innerText && el.innerText.includes(${JSON.stringify(words)})) {
          if (i < bestDepth) { best = b; bestDepth = i; }
          break;
        }
      }
    }
    if (!best) return '';
    best.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    best.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    best.click();
    return 'ok';
  })()`);
  if (!done) throw new Error(`No "${label}" near "${words}"`);
}

async function shot(page: Page, name: string): Promise<void> {
  if (outDir) await page.screenshot(join(outDir, name));
}

async function main() {
  console.log('Groups probe\n');
  const A = await signIn('a');
  const B = await signIn('b');
  await A.client.rpc('accept_community_rules');
  await B.client.rpc('accept_community_rules');

  const gate = await A.client.from('my_groups').select('id').limit(1);
  if (gate.error) {
    console.error(`my_groups is not readable (${gate.error.code}): is migration 0032 applied?`);
    process.exit(2);
  }

  const leaveAll = async (who: { client: SupabaseClient }) => {
    const mine = await who.client.from('my_groups').select('id').like('title', `${MARK}%`);
    for (const g of (mine.data ?? []) as { id: string }[]) await who.client.rpc('leave_group', { p_group: g.id });
  };
  const clean = async () => {
    await leaveAll(A);
    await leaveAll(B);
    await A.client.from('blocks').delete().eq('blocker_id', A.userId);
    await B.client.from('blocks').delete().eq('blocker_id', B.userId);
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
  };
  await clean();

  const bBefore = await B.client.from('profiles').select('display_name').eq('id', B.userId).maybeSingle();
  await A.client.from('profiles').update({ display_name: 'Probe A' }).eq('id', A.userId);
  await B.client.from('profiles').update({ display_name: 'Probe B' }).eq('id', B.userId);
  await B.client.rpc('send_friend_request', { p_to: A.userId });
  await A.client.rpc('accept_friend_request', { p_from: B.userId });

  const page = await openPage({ width: 393, height: 852, dark: true });
  let groupId: string | null = null;
  try {
    console.log('A, in the built app:');

    // ---- make a group, from the pencil in Chat ----
    await page.goto('/community');
    await showing(page, 'Share something');
    await page.click('Chat');
    await showing(page, 'Search messages');
    await page.click('New message');
    await showing(page, 'New group');
    await page.click('New group');
    await page.waitFor(`location.pathname === '/groups/new' ? 'y' : ''`, 'the new group screen');
    await showing(page, 'Probe B');
    await typeInto(page, 'Bio study group', TITLE);
    await page.click('Probe B');
    await shot(page, '01-new-group.png');
    await page.click('Make the group');
    await page.waitFor(`/^\\/groups\\/[0-9a-f-]{36}$/.test(location.pathname) ? 'y' : ''`, 'the group to open');
    groupId = (await page.evaluate<string>('location.pathname')).split('/')[2]!;
    const bSees = await B.client.from('my_groups').select('title, member_count').eq('id', groupId).maybeSingle();
    if ((bSees.data as { title?: string; member_count?: number } | null)?.member_count === 2) {
      ok('make a group', 'from the pencil in Chat, with B ticked — and B is in it');
    } else fail('make a group', `B sees ${JSON.stringify(bSees.data)}`);

    // ---- send ----
    await typeInto(page, `Message ${TITLE}`, FROM_A);
    await page.click('Send');
    await showing(page, FROM_A);
    const sent = await A.client.from('group_messages').select('id').eq('group_id', groupId).eq('body', FROM_A);
    if ((sent.data ?? []).length === 1) ok('send', 'from the box, and in the database');
    else fail('send', `the database has ${JSON.stringify(sent.data)}`);

    // ---- B writes; A answers it with a reply ----
    const bSent = await B.client.rpc('send_group_message', { p_group: groupId, p_body: FROM_B });
    if (bSent.error) throw new Error(`B could not send: ${bSent.error.message}`);
    await showing(page, FROM_B, 20_000);
    ok("B's message", 'arrives in the room');

    await clickNear(page, FROM_B, 'More');
    await showing(page, 'Hide this from my screen');
    await page.click('Reply');
    await showing(page, 'Replying to Probe B');
    await typeInto(page, `Message ${TITLE}`, REPLY);
    await page.click('Send');
    await showing(page, REPLY);
    const replied = await A.client.from('group_messages').select('reply_to').eq('group_id', groupId).eq('body', REPLY).maybeSingle();
    if ((replied.data as { reply_to?: string } | null)?.reply_to === bSent.data) {
      ok('reply', "saved as an answer to B's message, and shown with it");
    } else fail('reply', `the database has ${JSON.stringify(replied.data)}`);
    await shot(page, '02-group-room.png');

    // ---- rename, from who is in it ----
    await page.click(`${TITLE}, 2 people. Who is in it`);
    await page.waitFor(`location.pathname.endsWith('/info') ? 'y' : ''`, 'who is in it');
    await showing(page, 'Made the group');
    await typeInto(page, 'A name for the group', RENAMED);
    await page.click('Save the name');
    await page.waitFor(`document.body.innerText.includes(${JSON.stringify('Save the name')}) ? '' : 'y'`, 'the name to save');
    const renamed = await B.client.from('my_groups').select('title').eq('id', groupId).maybeSingle();
    if ((renamed.data as { title?: string } | null)?.title === RENAMED) ok('rename', 'saved, and B sees the new name');
    else fail('rename', `B sees ${JSON.stringify(renamed.data)}`);
    await shot(page, '03-who-is-in-it.png');

    // ---- leave: it passes to B ----
    await page.click('Leave this group');
    await showing(page, `Leave ${RENAMED}?`);
    await page.click('Leave group');
    await page.waitFor(`location.pathname === '/community' ? 'y' : ''`, 'back to Community');
    const aGone = await A.client.from('my_groups').select('id').eq('id', groupId);
    const heir = await B.client.from('my_groups').select('i_own').eq('id', groupId).maybeSingle();
    if ((aGone.data ?? []).length === 0 && (heir.data as { i_own?: boolean } | null)?.i_own === true) {
      ok('leave', 'A is out, and B has taken the group over');
    } else fail('leave', `A: ${JSON.stringify(aGone.data)}, B: ${JSON.stringify(heir.data)}`);

    const errors = page.logs().filter((l) => /uncaught|TypeError|ReferenceError/i.test(l));
    if (errors.length > 0) fail('browser console', errors.join(' | '));
    else ok('browser console', 'no uncaught errors');
  } catch (err) {
    fail('probe', err instanceof Error ? err.message : String(err));
    if (outDir) await page.screenshot(join(outDir, 'failed.png')).catch(() => {});
  } finally {
    await page.close();
    await clean();
    await B.client
      .from('profiles')
      .update({ display_name: (bBefore.data as { display_name?: string | null } | null)?.display_name ?? null })
      .eq('id', B.userId);
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exit(1);
}

void main();
