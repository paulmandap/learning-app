/**
 * Messages between friends — in the built app, as two real people (NOTES §53).
 *
 * The isolation test proves who can read and write what. This proves what A
 * sees, and asks the DATABASE after every step whether it agrees: the unread
 * badge on the Community tab; the conversation first in the inbox, counted;
 * opening it clears the count; a reply from the box lands; "Seen" once B has
 * read it; the Message button on B's page finds the same conversation; and,
 * unfriended, the conversation still there with the reason it is closed in
 * place of the box.
 *
 * Run:
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/messages-probe.ts [--out <dir>]
 *
 * Needs 0026–0028, and TEST_USER_A_* / TEST_USER_B_*. Signs in to the app as A;
 * B writes from the data layer. Cleans up its messages; the conversation row
 * stays, as every conversation does (0028).
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

const MARK = 'messages probe';
const FROM_B = `${MARK}: hi from B`;
const FROM_A = `${MARK}: hi back from A`;

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

async function shot(page: Page, name: string): Promise<void> {
  if (outDir) await page.screenshot(join(outDir, name));
}

async function main() {
  console.log('Messages probe\n');
  const A = await signIn('a');
  const B = await signIn('b');

  // Both test accounts agree to the community rules (0030, NOTES §55): every
  // social act below is refused with 'RULES' until they have. A database
  // without 0030 has no such function, which is fine.
  await A.client.rpc('accept_community_rules');
  await B.client.rpc('accept_community_rules');

  const gate = await A.client.from('my_conversations').select('id').limit(1);
  if (gate.error) {
    console.error(`my_conversations is not readable (${gate.error.code}): is migration 0028 applied?`);
    process.exit(2);
  }

  const clean = async () => {
    await A.client.from('direct_messages').delete().like('body', `${MARK}%`);
    await B.client.from('direct_messages').delete().like('body', `${MARK}%`);
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

  const opened = await B.client.rpc('start_conversation', { p_other: A.userId });
  if (opened.error) throw new Error(`B could not open a conversation: ${opened.error.message}`);
  const conversationId = opened.data as string;
  // A has read everything up to now, so exactly one message is new.
  await A.client.rpc('mark_conversation_read', { p_conversation: conversationId });
  const sent = await B.client.rpc('send_direct_message', { p_conversation: conversationId, p_body: FROM_B });
  if (sent.error) throw new Error(`B could not send: ${sent.error.message}`);

  const page = await openPage({ width: 393, height: 852, dark: true });
  try {
    console.log('A, in the built app:');

    // ---- the badge, and the inbox ----
    await page.goto('/');
    await page.waitFor(
      `[...document.querySelectorAll('[role="tab"]')].some((t) => (t.getAttribute('aria-label') ?? '') === 'Community, 1 new') ? 'y' : ''`,
      'the unread badge on Community',
    );
    ok('badge', 'Community says 1 new');

    await page.goto('/community');
    await page.click('Chat');
    await showing(page, FROM_B);
    await page.waitFor(
      `[...document.querySelectorAll('[role="button"]')].some((b) => (b.getAttribute('aria-label') ?? '') === ${JSON.stringify(`Probe B. ${FROM_B}. 1 new`)}) ? 'y' : ''`,
      'the conversation, counted',
    );
    ok('inbox', 'Everyone first, then B, with the new message counted');
    await shot(page, '01-inbox.png');

    // ---- open it: read, and cleared ----
    await page.click(`Probe B. ${FROM_B}. 1 new`);
    await page.waitFor(`location.pathname === '/messages/${conversationId}' ? 'y' : ''`, 'the conversation to open');
    await showing(page, FROM_B);
    // Polled, not waited on the screen: the claim is about the database.
    let unread = 1;
    for (let i = 0; i < 20 && unread !== 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const row = await A.client.from('my_conversations').select('unread').eq('id', conversationId).maybeSingle();
      unread = (row.data as { unread?: number } | null)?.unread ?? -1;
    }
    if (unread === 0) ok('read', 'opening it marked it read, in the database');
    else fail('read', `still ${unread} unread after opening it`);

    // ---- reply ----
    await page.evaluate(`document.querySelector('textarea').focus()`);
    await page.type(FROM_A);
    await page.click('Send');
    await showing(page, FROM_A);
    const landed = await B.client.from('conversation_messages').select('id').eq('body', FROM_A);
    if ((landed.data ?? []).length === 1) ok('reply', 'sent from the box, and B has it');
    else fail('reply', 'on screen, not in the database');

    // ---- Seen ----
    await B.client.rpc('mark_conversation_read', { p_conversation: conversationId });
    await showing(page, 'Seen', 15_000);
    ok('seen', '"Seen" under the reply once B read it');
    await shot(page, '02-conversation.png');

    // ---- the Message button on B's page finds the same conversation ----
    await page.goto(`/person/${B.userId}`);
    await page.click('Message Probe B');
    await page.waitFor(`location.pathname === '/messages/${conversationId}' ? 'y' : ''`, 'the same conversation');
    ok("B's page", '"Message Probe B" opens the conversation there already is');

    // ---- unfriended: readable, closed ----
    await A.client.from('friendships').delete().or(`requester_id.eq.${B.userId},addressee_id.eq.${B.userId}`);
    await page.goto(`/messages/${conversationId}`);
    await showing(page, 'this conversation is closed');
    const text = await page.evaluate<string>('document.body.innerText');
    const hasBox = await page.evaluate<boolean>(`!!document.querySelector('textarea')`);
    if (text.includes(FROM_B) && !hasBox) ok('unfriended', 'still readable, and closed — the reason where the box was');
    else fail('unfriended', `readable: ${text.includes(FROM_B)}, box still there: ${hasBox}`);
    await shot(page, '03-closed.png');

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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(2);
});
