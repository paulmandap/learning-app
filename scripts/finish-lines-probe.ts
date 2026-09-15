/**
 * What Nomi says when a round ends, in the built app (NOTES §45).
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/finish-lines-probe.ts [--out <dir>]
 *
 * The owner: Nomi should comment when a round ends, the words varying with the
 * result, and still cheering below 50%. As TEST_USER_A at phone width in dark,
 * on a probe set of three flashcards: a round of 3 of 3, then 1 of 3 twice, then
 * 0 of 3. Each time it reads which line Nomi said, checks it is one of that
 * result's lines, checks the second 1-of-3 did not repeat the first, and
 * photographs the bubble. Deletes the probe set afterwards.
 */
import { join } from 'node:path';
import { openPage, type Page } from './screenshot';
import { supabase } from '../src/data/supabase';
import { FINISH_LINES, type FinishBand } from '../src/core/celebrate';

const args = process.argv.slice(2);
const outAt = args.indexOf('--out');
const OUT = outAt === -1 ? '.' : args[outAt + 1]!;
const TITLE = 'Nomi finish lines probe set';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Answer the deck with the keyboard: → got it, ← missed. */
async function answer(page: Page, gotIt: boolean[]): Promise<void> {
  for (const got of gotIt) {
    await page.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { code: '${got ? 'ArrowRight' : 'ArrowLeft'}' }))`);
    await pause(450);
  }
  await page.waitFor(`document.querySelector('#root').innerText.includes('Done —') ? 'y' : ''`, 'the finished round');
}

/** Which of every line Nomi has is on screen now, once it has been typed. */
async function said(page: Page): Promise<string> {
  const all = Object.values(FINISH_LINES).flat();
  // The bubble holds the whole line invisibly while it types, so wait for the
  // typing to finish: the line then appears twice in the page's text.
  return page.waitFor<string>(
    `(() => {
      const text = document.querySelector('#root').innerText;
      return ${JSON.stringify(all)}.find((line) => text.split(line).length > 2) ?? '';
    })()`,
    "Nomi's line to be typed",
    20_000,
  );
}

async function main() {
  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  if (!email || !password) throw new Error('Set TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD.');
  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in: ${error.message}`);
  const uid = auth.user!.id;

  await supabase.from('study_sets').delete().eq('title', TITLE);
  const { data: set, error: setError } = await supabase
    .from('study_sets')
    .insert({ user_id: uid, title: TITLE, status: 'ready' })
    .select('id')
    .single();
  if (setError || !set) throw new Error(`probe set: ${setError?.message}`);
  const { error: itemsError } = await supabase.from('study_items').insert(
    [
      ['What do plants release during photosynthesis?', 'Oxygen'],
      ['Where does the Calvin cycle take place?', 'The stroma'],
      ['Which pigment absorbs light in a leaf?', 'Chlorophyll'],
    ].map(([prompt, answerText]) => ({
      user_id: uid,
      study_set_id: set.id,
      kind: 'flashcard',
      level: 'remember',
      prompt,
      answer: answerText,
      source_excerpt: answerText,
      excerpt_verified: true,
      topic: 'probe',
    })),
  );
  if (itemsError) throw new Error(`probe cards: ${itemsError.message}`);

  const page = await openPage({ width: 393, height: 900, dark: true, reducedMotion: 'no-preference' });
  const results: string[] = [];
  let failed = false;
  const check = (ok: boolean, line: string) => {
    results.push(`${ok ? 'OK ' : 'NO '} ${line}`);
    failed ||= !ok;
  };

  try {
    // Opened from Home by moving within the app: a reload would forget what
    // Nomi said last, which is what stops a line repeating (NOTES §45.6).
    await page.waitFor(`document.querySelector('[aria-label^="Talk to Nomi."]') ? 'y' : ''`, "Nomi's card on Home", 20_000);
    await page.evaluate(`(() => {
      history.pushState({}, '', '/set/${set.id}/flashcards?level=remember');
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    })()`);
    await page.waitFor(`document.querySelector('#root').innerText.includes('0 of 3') ? 'y' : ''`, 'the deck');

    const rounds: { name: string; answers: boolean[]; band: FinishBand; shot: string }[] = [
      { name: '3 of 3', answers: [true, true, true], band: 'perfect', shot: 'finish-45-perfect.png' },
      { name: '1 of 3', answers: [false, true, false], band: 'tough', shot: 'finish-45-tough.png' },
      { name: '1 of 3 again', answers: [false, false, true], band: 'tough', shot: 'finish-45-tough-again.png' },
      { name: '0 of 3', answers: [false, false, false], band: 'none', shot: 'finish-45-none.png' },
    ];
    const lines: string[] = [];
    for (const [i, round] of rounds.entries()) {
      if (i > 0) {
        await page.click('Start again');
        await page.waitFor(`document.querySelector('#root').innerText.includes('0 of 3') ? 'y' : ''`, 'the deck again');
      }
      await answer(page, round.answers);
      const line = await said(page);
      await pause(600);
      await page.screenshot(join(OUT, round.shot));
      lines.push(line);
      check(FINISH_LINES[round.band].includes(line), `${round.name}: "${line}" — one of the ${round.band} lines`);
    }
    check(lines[1] !== lines[2], 'the same result twice running got different words');
  } finally {
    const errors = page.logs().filter((l) => l.startsWith('[exception]') || l.startsWith('[error]'));
    if (errors.length) console.log(`--- page errors ---\n${errors.slice(-10).join('\n')}`);
    await page.close();
    const { error: cleanup } = await supabase.from('study_sets').delete().eq('id', set.id);
    console.log(cleanup ? `could not delete the probe set: ${cleanup.message}` : 'deleted the probe set');
  }

  for (const line of results) console.log(line);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
