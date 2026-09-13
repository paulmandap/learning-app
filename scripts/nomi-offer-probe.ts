/**
 * Nomi's offers, driven in the built app (NOTES §39).
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/nomi-offer-probe.ts [--out <dir>]
 *
 * Signs in as TEST_USER_A, opens a new chat at phone width in dark, and sends
 * the owner's three messages from §39 — the reviewer request, the title sent on
 * its own, and the Taglish paste (with §37's stand-in ballad, not the lyrics) —
 * photographing the offer after each. Then taps "Write it" on the test
 * account's placeholder key, which Google refuses, and checks that nothing was
 * saved: the reviewer is written before any note or set exists. Deletes the
 * chats it made. No Gemini quota is spent: every step before the tap is
 * recognised by Nomi itself.
 */
import { join } from 'node:path';
import { openPage, type Page } from './screenshot';
import { supabase } from '../src/data/supabase';
import { deleteConversation, listConversations } from '../src/data/nomi-chat';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt === -1 ? '.' : args[outAt + 1]!;

// §37's stand-in ballad, not the real lyrics.
const SONG = [
  'I drove up north with the windows down in late October',
  'You had a thermos full of cider and a map you never read',
  'The radio kept cutting out between the pines and the water',
  "And you sang the parts you didn't know in your own words instead",
  'We stopped at a gas station where the owner knew your grandpa',
  'He gave us two free peaches and a warning about the rain',
  'You laughed and said the sky was only practicing its thunder',
  "And I believed you like I'd believe you over and over again",
].join('\n');

const onScreen = (page: Page, text: string, timeoutMs = 20_000) =>
  page.waitFor(
    `document.querySelector('#root').innerText.includes(${JSON.stringify(text)}) ? 'y' : ''`,
    JSON.stringify(text),
    timeoutMs,
  );

async function say(page: Page, text: string): Promise<void> {
  await page.waitFor(`document.querySelector('textarea') ? 'y' : ''`, 'the message box');
  // The composer is a multiline field — a <textarea> — and page.fill() looks
  // for an <input>. The same native-setter route, on the other prototype.
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

async function counts(): Promise<{ notes: number; sets: number }> {
  const [notes, sets] = await Promise.all([supabase.from('notes').select('id'), supabase.from('study_sets').select('id')]);
  if (notes.error || sets.error) throw new Error(notes.error?.message ?? sets.error?.message);
  return { notes: notes.data.length, sets: sets.data.length };
}

async function main() {
  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  if (!email || !password) throw new Error('Set TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD.');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in: ${error.message}`);

  const before = await counts();
  const chatsBefore = new Set(((await listConversations()) ?? []).map((c) => c.id));
  const page = await openPage({ width: 393, height: 900, dark: true });
  const results: string[] = [];

  try {
    await page.goto('/nomi');
    await page.click('New chat');

    await say(page, 'pwede mo ba ako gawan ng reviewer about computer parts?');
    await onScreen(page, 'Computer Parts · 20 cards');
    await page.screenshot(join(OUT, 'nomi-39-1-reviewer-offer.png'));
    results.push('the reviewer request is an offer: "Computer Parts · 20 cards"');

    await say(page, 'make the title "PC Hardware Basics"');
    await onScreen(page, 'PC Hardware Basics · 20 cards');
    await page.screenshot(join(OUT, 'nomi-39-2-retitled.png'));
    results.push('the title sent on its own changed the offer: "PC Hardware Basics · 20 cards"');

    await page.click('Write it');
    const said = await page.waitFor<string>(
      `(document.querySelector('#root').innerText.match(/That key didn't work[^\\n]*|Add your Gemini key[^\\n]*|Gemini is busy[^\\n]*|Couldn't reach Google[^\\n]*|Something went wrong[^\\n]*/) ?? [''])[0]`,
      'the tap to finish',
      120_000,
    );
    await page.screenshot(join(OUT, 'nomi-39-3-refused.png'));
    const after = await counts();
    results.push(
      `"Write it" on the placeholder key: ${JSON.stringify(said)}; notes ${before.notes}→${after.notes}, sets ${before.sets}→${after.sets}`,
    );
    if (after.notes !== before.notes || after.sets !== before.sets) throw new Error('a refused reviewer left something saved');
    await page.click('Not now');

    await page.click('New chat');
    await say(page, `nomi gawan mo nga ako reviewer, yung title ay "All Too Well by Taylor Swift" tapos ito yung contents:\n${SONG}`);
    await onScreen(page, 'All Too Well by Taylor Swift · 10 cards');
    await page.screenshot(join(OUT, 'nomi-39-4-taglish-paste.png'));
    results.push('the Taglish paste is titled "All Too Well by Taylor Swift"');
    await page.click('Not now');
  } finally {
    console.log('--- last of the page ---');
    console.log((await page.text()).split('\n').slice(-14).join('\n'));
    const logs = page.logs();
    if (logs.length > 0) console.log(`--- browser console ---\n${logs.slice(-10).join('\n')}`);
    await page.close();
    const made = ((await listConversations()) ?? []).filter((c) => !chatsBefore.has(c.id));
    for (const c of made) await deleteConversation(c.id);
    console.log(`CLEANED UP ${made.length} chat(s)`);
  }

  for (const line of results) console.log(`OK  ${line}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
