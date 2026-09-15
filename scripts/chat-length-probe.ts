/**
 * A long message and a paste, in the built app (NOTES §45).
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/chat-length-probe.ts [--out <dir>]
 *
 * The owner: a message of more than about 80 words, "no matter the context",
 * was offered as a set of flashcards; and it was cut to "…", so Nomi no longer
 * knew what it said. This sends, as TEST_USER_A at phone width in dark:
 *
 *  1. a 71-word message about a day at school — which must show whole, carry no
 *     offer, go to Gemini (refused on the account's placeholder key, which is
 *     fine: the point is where it went), and be SAVED whole;
 *  2. a paste of over 1,000 characters with no request — which must show as
 *     "Pasted notes, N words", carry the offer, and be saved whole.
 *
 * Photographs both, and deletes the chats it made.
 */
import { join } from 'node:path';
import { openPage, type Page } from './screenshot';
import { supabase } from '../src/data/supabase';
import { deleteConversation, listConversations, listMessages } from '../src/data/nomi-chat';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt === -1 ? '.' : args[outAt + 1]!;

const ABOUT_MY_DAY =
  "hi nomi, so today was really tiring. our teacher in computer programming gave us a surprise quiz and i think i did badly because i didn't review last night. i'm kinda stressed because midterms are next week and i still have so many topics to cover, like loops, arrays and functions. can you give me some tips on how to manage my time so i can study everything before the exam?";

// §37's stand-in ballad, three times over: past 1,000 characters.
const VERSE = [
  'I drove up north with the windows down in late October',
  'You had a thermos full of cider and a map you never read',
  'The radio kept cutting out between the pines and the water',
  "And you sang the parts you didn't know in your own words instead",
  'We stopped at a gas station where the owner knew your grandpa',
  'He gave us two free peaches and a warning about the rain',
  'You laughed and said the sky was only practicing its thunder',
  "And I believed you like I'd believe you over and over again",
].join('\n');
const PASTE = [VERSE, VERSE, VERSE].join('\n\n');

async function say(page: Page, text: string): Promise<void> {
  await page.waitFor(`document.querySelector('textarea') ? 'y' : ''`, 'the message box');
  const typed = await page.evaluate<string>(`(() => {
    const el = document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value === ${JSON.stringify(text)} ? 'ok' : '';
  })()`);
  if (!typed) throw new Error(`Could not type ${JSON.stringify(text.slice(0, 40))}`);
  await new Promise((r) => setTimeout(r, 300));
  await page.click('Send');
}

const rootText = (page: Page) => page.evaluate<string>(`document.querySelector('#root').innerText`);

async function newestConversationText(before: Set<string>): Promise<string> {
  const made = ((await listConversations()) ?? []).filter((c) => !before.has(c.id));
  if (made.length === 0) throw new Error('no conversation was saved');
  const messages = await listMessages(made[0]!.id);
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

async function main() {
  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  if (!email || !password) throw new Error('Set TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD.');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in: ${error.message}`);

  console.log(`message: ${ABOUT_MY_DAY.split(/\s+/).length} words, ${ABOUT_MY_DAY.length} characters`);
  console.log(`paste:   ${PASTE.split(/\s+/).length} words, ${PASTE.length} characters`);

  const chatsBefore = new Set(((await listConversations()) ?? []).map((c) => c.id));
  const page = await openPage({ width: 393, height: 900, dark: true });
  const results: string[] = [];
  let failed = false;

  try {
    await page.goto('/nomi');
    await page.click('New chat');

    // 1. A long message about their day.
    await say(page, ABOUT_MY_DAY);
    const reply = await page.waitFor<string>(
      `(document.querySelector('#root').innerText.match(/That key didn't work[^\\n]*|Add your Gemini key[^\\n]*|Gemini is busy[^\\n]*|I couldn't come up[^\\n]*/) ?? [''])[0]`,
      'the reply to the message',
      90_000,
    );
    const screen1 = await rootText(page);
    await page.screenshot(join(OUT, 'nomi-45-1-long-message.png'));
    const shownWhole = screen1.includes('before the exam?') && !screen1.includes('Pasted notes');
    const noOffer = !/New set|Make it|I picked/.test(screen1);
    const saved1 = await newestConversationText(chatsBefore);
    results.push(`long message shown whole: ${shownWhole}`);
    results.push(`long message carries no offer: ${noOffer}; went to Gemini, which said ${JSON.stringify(reply)}`);
    results.push(`long message saved whole: ${saved1 === ABOUT_MY_DAY}`);
    failed ||= !shownWhole || !noOffer || saved1 !== ABOUT_MY_DAY;

    // 2. A paste with no request.
    const chatsMid = new Set(((await listConversations()) ?? []).map((c) => c.id));
    await page.click('New chat');
    await say(page, PASTE);
    await page.waitFor(`document.querySelector('#root').innerText.includes('Make it') ? 'y' : ''`, 'the offer', 30_000);
    const screen2 = await rootText(page);
    await page.screenshot(join(OUT, 'nomi-45-2-paste.png'));
    const compact = /Pasted notes, \d+ words: "/.test(screen2);
    const saved2 = await newestConversationText(chatsMid);
    results.push(`paste shown as ${JSON.stringify(screen2.match(/Pasted notes, \d+ words/)?.[0] ?? 'NOT COMPACT')}, with the offer`);
    results.push(`paste saved whole: ${saved2 === PASTE} (${saved2.length} characters)`);
    failed ||= !compact || saved2 !== PASTE;
    await page.click('Not now');
  } finally {
    const logs = page.logs().filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
    if (logs.length > 0) console.log(`--- page errors ---\n${logs.slice(-10).join('\n')}`);
    await page.close();
    const made = ((await listConversations()) ?? []).filter((c) => !chatsBefore.has(c.id));
    for (const c of made) await deleteConversation(c.id);
    console.log(`CLEANED UP ${made.length} chat(s)`);
  }

  for (const line of results) console.log(`${line.includes('false') || line.includes('NOT') ? 'NO ' : 'OK '} ${line}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
