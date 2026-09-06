/**
 * Does the notebook actually keep what you typed?
 *
 * The one thing this feature must never do is lose a note. That cannot be
 * checked by a unit test — the saving lives in a react-native screen, behind a
 * debounce, against a real table — so it is checked here, against the built
 * bundle and the live database, the way a student would find out.
 *
 *   npx expo export --platform web
 *   npx tsx --env-file=.env scripts/notes-probe.ts
 *
 * Needs migration 0012 applied, plus TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD.
 * Creates a note, checks it survives a reload, checks the hand-off to card
 * making, and deletes it again. Pass --keep to leave the note behind.
 *
 * It deliberately stops SHORT of generating cards: that costs model quota and
 * is already covered by verify-phase2.ts. What is new here is the notebook, and
 * the join between the two is the "Make flashcards" button landing on a screen
 * with the right text in it.
 */
import { openPage } from './screenshot';

type Page = Awaited<ReturnType<typeof openPage>>;

/** Enough words to clear MIN_WORDS_FOR_CARDS, with a canary to find again. */
const BODY = [
  'Specimen NB-4417 was examined during the practical session this morning.',
  'The xylem carries water upward from the roots while the phloem carries',
  'sugars in both directions. Guard cells open the stomatal pore when they',
  'take up potassium ions, and the resulting turgor bends them apart. The',
  'cortex stores starch in the mature root and lies between the epidermis',
  'and the vascular cylinder of the plant.',
].join('\n');

const CANARY = 'NB-4417';

async function typeInto(page: Page, selectorIndex: number, value: string) {
  // React tracks an input's value on the DOM node, so assigning .value is
  // silently ignored — the native setter plus an input event is what reaches
  // onChangeText. Same trap screenshot.ts documents for its own fill().
  const ok = await page.evaluate<string>(`(() => {
    const fields = [...document.querySelectorAll('input, textarea')]
      .filter((e) => !['checkbox','radio','hidden','submit','button'].includes(e.type));
    const el = fields[${selectorIndex}];
    if (!el) return '';
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`);
  if (!ok) throw new Error(`no field at index ${selectorIndex}`);
}

async function main() {
  const keep = process.argv.includes('--keep');
  const page = await openPage({ width: 393, height: 1000, dark: true });
  let failures = 0;
  const check = (name: string, pass: boolean, detail = '') => {
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    if (!pass) failures++;
  };

  try {
    await page.goto('/notes');
    const before = await page.text();
    if (before.includes("isn't switched on")) {
      throw new Error('Migration 0012 has not been applied — the notebook is off.');
    }

    // --- write one -------------------------------------------------------
    await page.click('+ New note');
    // Waits on the word count, NOT on "Start typing" — that is the body's
    // placeholder, and placeholder text is not innerText. Cost one confusing
    // "timed out waiting for the editor" against an editor that was plainly on
    // screen in the dump underneath it.
    await page.waitFor(
      `document.querySelector('#root').innerText.includes('words') ? 'y' : ''`,
      'the editor',
    );
    const noteUrl = await page.evaluate<string>('location.pathname');

    await typeInto(page, 0, 'Plant transport');
    await typeInto(page, 1, BODY);

    // The debounce is 1.2s; give it room, then look for the reassurance.
    await page.waitFor(
      `document.querySelector('#root').innerText.includes('Saved') ? 'y' : ''`,
      'the note to save itself',
      15_000,
    );
    check('autosaves without a Save button', true);

    const wordLine = await page.text();
    check('counts the words', /\b\d+ words\b/.test(wordLine));
    check(
      'offers to make cards once there is enough',
      wordLine.includes('Make flashcards from this') && !wordLine.includes('more words and I can'),
    );

    // --- does it survive being closed? -----------------------------------
    //
    // Read the FIELD VALUES, not the page text. A textarea's contents and an
    // input's value are not innerText, so waiting for the canary to appear in
    // the page text times out against an editor that is plainly showing the
    // note. Cost one run to work out.
    await page.goto('/notes');
    await page.goto(noteUrl);
    await page.waitFor(
      `[...document.querySelectorAll('textarea')].some((f) => f.value.includes(${JSON.stringify(CANARY)})) ? 'y' : ''`,
      'the note to come back from the database',
    );
    check('the note survives a reload', true);

    const titleValue = await page.evaluate<string>(
      `[...document.querySelectorAll('input')].filter((e) => e.type === 'text' || !e.type)[0]?.value ?? ''`,
    );
    check('the title survives too', titleValue === 'Plant transport', `got "${titleValue}"`);

    // --- the hand-off to card making -------------------------------------
    await page.click('Make flashcards from this');
    await page.waitFor(
      `document.querySelector('#root').innerText.includes('Make cards from your note') ? 'y' : ''`,
      'the card-making screen',
    );
    const handoff = await page.evaluate<string>(`(() => {
      const fields = [...document.querySelectorAll('textarea')];
      return fields.map((f) => f.value).join(' ');
    })()`);
    check('carries the note text over', handoff.includes(CANARY), `${handoff.length} chars`);

    // --- optional: actually make the cards --------------------------------
    //
    // Off by default because it spends model quota on a free tier shared with
    // real studying. On, it is the only check that proves the headline claim
    // rather than the plumbing under it.
    if (process.argv.includes('--generate')) {
      await page.click('10');
      await page.click('Make my study set');
      // Waits for the URL, NOT for words on the page. Matching /Ready|cards/
      // succeeded instantly against "How many cards at most?" on the screen it
      // was still standing on, so it never waited and then reported the set as
      // not made. The route changing is the unambiguous signal.
      await page.waitFor(
        `location.pathname.startsWith('/set/') ? location.pathname : ''`,
        'the set to be made',
        180_000,
      );
      const setUrl = await page.evaluate<string>('location.pathname');
      check('the note became a set', /^\/set\//.test(setUrl), setUrl);

      await page.goto(noteUrl);
      await page.waitFor(
        `document.querySelector('#root').innerText.includes('Open the cards') ? 'y' : ''`,
        'the note to link back to its cards',
        15_000,
      );
      check('the note links back to its cards', true);
    }

    // --- and the list shows it -------------------------------------------
    await page.goto('/notes');
    const list = await page.text();
    check('appears in the list', list.includes('Plant transport'));

    if (!keep) {
      await page.goto(noteUrl);
      await page.waitFor(
        `document.querySelector('#root').innerText.includes('Delete note') ? 'y' : ''`,
        'the delete control',
      );
      await page.click('Delete note');
      await page.click('Yes, delete it');
      await new Promise((r) => setTimeout(r, 1200));
      const after = await page.text();
      check('deleting removes it', !after.includes('Plant transport'));
    }

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    await page.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
