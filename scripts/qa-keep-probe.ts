/**
 * The student's own questions and answers, kept as written — end to end, on the
 * real pipeline and the live database (NOTES §49).
 *
 *   npx tsx --env-file=.env scripts/qa-keep-probe.ts [--only labelled] [--keep]
 *
 * For each layout the owner writes in — and one no rule reads, for Gemini to
 * point at — this pastes the notes as TEST_USER_A, plans with `keepWording`,
 * makes the set, and checks:
 *
 *  - every pair the keeper finds is a stored card with EXACTLY that question and
 *    that answer, character for character;
 *  - nothing else was stored when the count asked for no more, and the card
 *    writer (`generateItems`) was never called;
 *  - running the set again — a refresh — stores nothing twice;
 *  - with a count above the pairs, Nomi's extra cards repeat none of his.
 *
 * Wraps `generateItems` and `pointQaPairs` to count the model calls. Deletes
 * every set it makes unless --keep. Needs TEST_USER_A_EMAIL /
 * TEST_USER_A_PASSWORD, and GEMINI_API_KEY — the test account's stored key is a
 * placeholder (NOTES §36). Spends real Gemini quota: quiz choices once per set,
 * one pointer call, and the extra cards' requests.
 */
import { supabase } from '../src/data/supabase';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { addDocumentToSet, generateSet, planSet } from '../src/data/pipeline';
import { createSet, deleteSet, getSet } from '../src/data/sets';
import { listItems } from '../src/data/items';
import { pagesForSet } from '../src/data/documents';
import { findQaPairs } from '../src/core/qa-pairs';
import { normalize } from '../src/core/text';

const FIXTURES: { name: string; text: string; count?: number; pointed?: boolean }[] = [
  {
    name: 'labelled',
    text: [
      '# Cells',
      'Q: What is osmosis?',
      'A: Water moving across a membrane.',
      '',
      'Q: Whats the powerhouse of teh cell?',
      'A: Mitochondria (the "powerhouse")',
      '',
      '1. Question: Ano ang photosynthesis?',
      'Answer: Paggawa ng pagkain gamit ang araw.',
      '',
      'Q: What are the parts of a cell?',
      'A:',
      '- nucleus',
      '- membrane',
      '- cytoplasm',
      '',
      'Q: Why do cells divide? A: To grow, and to repair damage.',
    ].join('\n'),
  },
  {
    name: 'one line',
    text: [
      'What is osmosis? : Water moving across a membrane',
      'What is diffusion? - Particles spreading out',
      'What is ATP? = The energy of the cell',
      'What is a gene? -> A unit of heredity',
    ].join('\n'),
  },
  {
    name: 'next line',
    text: [
      'What is osmosis?',
      'Water moving across a membrane.',
      '',
      'What is diffusion?',
      'Particles spreading from high to low concentration.',
      '',
      'Why do cells need ATP?',
      'It is their energy.',
      'Without it nothing moves.',
      '',
      'What is a ribosome?',
      'Where proteins are built.',
    ].join('\n'),
  },
  {
    name: 'term: definition',
    text: [
      '# Cell words',
      'Osmosis: water moving across a membrane',
      'Diffusion - particles spreading out',
      'Mitochondria: makes the cell’s energy',
      'Ribosome: builds proteins',
      'Nucleus: holds the genetic material',
    ].join('\n'),
  },
  {
    name: 'table',
    text: ['| Question | Answer |', '|---|---|', '| What is osmosis? | Water moving |', '| What is ATP? | Energy |', '| What is DNA? | Genetic material |'].join('\n'),
  },
  {
    name: 'alternating',
    text: ['Frage: Was ist Osmose?', 'Antwort: Wasserbewegung', 'Frage: Was ist ATP?', 'Antwort: Energie', 'Frage: Was ist DNA?', 'Antwort: Erbgut'].join('\n'),
  },
  {
    // No rule reads ">>" — so Gemini is asked to point, and code checks.
    name: 'pointed',
    pointed: true,
    text: [
      'What is osmosis? >> Water moving across a membrane',
      'What is diffusion? >> Particles spreading out',
      'What is ATP? >> The energy of the cell',
      'What is a gene? >> A unit of heredity',
    ].join('\n'),
  },
  {
    // His 5, and Nomi writes 5 more (the owner's choice: "my 25 + 15 from Nomi").
    name: 'with extras',
    count: 10,
    text: [
      'The cell is the basic unit of life. Every living thing is made of one or more cells.',
      'Cells come from other cells by division, and they carry genetic material in DNA.',
      'The membrane controls what enters and leaves, and the cytoplasm holds the organelles.',
      '',
      'Q: What is osmosis?',
      'A: Water moving across a membrane.',
      'Q: What is diffusion?',
      'A: Particles spreading out.',
      'Q: What is ATP?',
      'A: The energy of the cell.',
      'Q: What is a gene?',
      'A: A unit of heredity.',
      'Q: What is a ribosome?',
      'A: Where proteins are built.',
    ].join('\n'),
  },
];

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

let written = 0;
let pointedCalls = 0;
const generate = GeminiBrowserProvider.prototype.generateItems;
GeminiBrowserProvider.prototype.generateItems = async function (input) {
  written++;
  return generate.call(this, input);
};
const point = GeminiBrowserProvider.prototype.pointQaPairs;
GeminiBrowserProvider.prototype.pointQaPairs = async function (input) {
  pointedCalls++;
  const out = await point.call(this, input);
  console.log(`   pointer named: ${JSON.stringify(out)}`);
  return out;
};

async function main() {
  const only = arg('--only');
  const keepSets = process.argv.includes('--keep');
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (error) throw new Error(`sign-in: ${error.message}`);

  const failures: string[] = [];
  const fail = (name: string, what: string) => {
    failures.push(`${name}: ${what}`);
    console.log(`   FAIL ${what}`);
  };

  for (const fixture of FIXTURES) {
    if (only && fixture.name !== only) continue;
    console.log(`\n== ${fixture.name}`);
    written = 0;
    pointedCalls = 0;
    const set = await createSet(`__probe qa-keep ${fixture.name} ${new Date().toISOString()}`);
    try {
      await addDocumentToSet({ setId: set.id, apiKey, title: 'probe', source: { text: fixture.text } });
      const [page] = await pagesForSet(set.id);
      const stored = page?.text ?? '';
      const expected = findQaPairs(stored, page?.headings ?? []);
      const count = fixture.count ?? Math.max(1, expected.length);

      const plan = await planSet(set.id, count, { keepWording: true, apiKey });
      console.log(`   keeper found ${expected.length}; plan keeps ${plan.keep?.pairs ?? 0}; target ${plan.requestedCount}; Gemini sections ${plan.sections.length}`);
      const t0 = Date.now();
      await generateSet({ setId: set.id, apiKey });
      console.log(`   made in ${((Date.now() - t0) / 1000).toFixed(1)}s; card-writer called ${written}x, pointer ${pointedCalls}x`);

      const items = await listItems(set.id);
      const has = (q: string, a: string) => items.some((it) => it.prompt === q && it.answer === a);
      for (const pair of expected) {
        if (!has(pair.question, pair.answer)) fail(fixture.name, `missing, or not word for word: ${JSON.stringify([pair.question, pair.answer])}`);
      }

      const kept = plan.keep?.pairs ?? 0;
      if (fixture.pointed) {
        if (pointedCalls !== 1) fail(fixture.name, `pointer called ${pointedCalls}x, expected once`);
        if (kept === 0) fail(fixture.name, 'Gemini pointed at nothing that was found in the notes');
        // Whatever it kept is the notes' own text.
        for (const it of items.slice(0, kept)) {
          if (!normalize(stored).includes(normalize(it.prompt)) || !normalize(stored).includes(normalize(it.answer))) {
            fail(fixture.name, `a kept card is not in the notes: ${JSON.stringify([it.prompt, it.answer])}`);
          }
        }
      }

      if (!fixture.count) {
        if (written !== 0) fail(fixture.name, `the card-writer was called ${written}x for notes that are all his`);
        if (items.length !== kept) fail(fixture.name, `stored ${items.length}, expected exactly his ${kept}`);
      } else {
        const own = new Set(expected.map((p) => normalize(p.answer)));
        const extras = items.filter((it) => !expected.some((p) => p.question === it.prompt && p.answer === it.answer));
        console.log(`   his ${expected.length} + Nomi's ${extras.length} = ${items.length} of ${plan.requestedCount}`);
        for (const x of extras) {
          console.log(`     Nomi: ${x.prompt} → ${x.answer}`);
          if (own.has(normalize(x.answer))) fail(fixture.name, `Nomi repeated one of his answers: ${x.answer}`);
        }
      }

      // A refresh: the same run again must store nothing twice.
      const before = items.length;
      await generateSet({ setId: set.id, apiKey });
      const after = (await listItems(set.id)).length;
      if (after !== before) fail(fixture.name, `a second run changed the count from ${before} to ${after}`);

      const status = (await getSet(set.id))?.status;
      if (status !== 'ready') fail(fixture.name, `set is "${status}", not ready`);

      console.log(`   stored ${items.length}:`);
      for (const it of items) console.log(`     [${it.level}] ${JSON.stringify(it.prompt)} → ${JSON.stringify(it.answer)}`);
    } finally {
      if (keepSets) console.log(`   kept set ${set.id}`);
      else await deleteSet(set.id);
    }
  }

  console.log(failures.length === 0 ? '\nOK — every pair kept word for word' : `\n${failures.length} FAILURE(S)\n${failures.join('\n')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
