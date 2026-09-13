/**
 * What the model wrote, what the checks dropped, what was stored, and where
 * in the notes it came from — for one real run of the card pipeline.
 *
 *   npx tsx --env-file=.env scripts/generation-probe.ts --file <text file> [--count 10] [--keep]
 *
 * Built to reproduce the owner's report (NOTES §37): a pasted song asked for 10
 * cards came back with 4, several about one detail. The first run of this probe
 * showed the model writing 2 of 10 from lines 0 and 5 with nothing dropped —
 * which is what located the fault in the prompt rather than in the checks.
 *
 * Drives the REAL pipeline (addDocumentToSet → planSet → generateSet) as
 * TEST_USER_A with GEMINI_API_KEY from .env — the test account's stored key is
 * a placeholder (NOTES §36). Wraps generateItems to record the model's output
 * BEFORE validation, so a shortfall can be attributed. Deletes the set it makes
 * unless --keep.
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD. Spends real Gemini quota:
 * a 60-card run is about a dozen requests.
 */
import { readFileSync } from 'node:fs';
import { supabase } from '../src/data/supabase';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { addDocumentToSet, generateSet, planSet } from '../src/data/pipeline';
import { createSet, deleteSet } from '../src/data/sets';
import { listItems } from '../src/data/items';
import { pagesForSet } from '../src/data/documents';
import { normalize, splitSentences, wordCount } from '../src/core/text';

function arg(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

type RawItem = { kind: string; level: string; prompt: string; answer: string; source_sentence: number };
const calls: { budget: unknown; items: RawItem[]; ms: number }[] = [];
const original = GeminiBrowserProvider.prototype.generateItems;
GeminiBrowserProvider.prototype.generateItems = async function (input) {
  const t0 = Date.now();
  const items = await original.call(this, input);
  calls.push({ budget: input.budget, items: items as RawItem[], ms: Date.now() - t0 });
  return items;
};

async function main() {
  const file = arg('--file');
  const count = Number(arg('--count') ?? 10);
  const keep = process.argv.includes('--keep');
  if (!file) throw new Error('--file is required');
  const apiKey = process.env.GEMINI_API_KEY ?? '';
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const { error } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (error) throw new Error(`sign-in: ${error.message}`);

  const text = readFileSync(file, 'utf8');
  console.log(`INPUT   ${wordCount(text)} words, ${splitSentences(text).length} lines, asked for ${count}`);

  const set = await createSet(`__probe generation ${new Date().toISOString()}`);
  try {
    await addDocumentToSet({ setId: set.id, apiKey, title: 'probe', source: { text } });
    const plan = await planSet(set.id, count);
    console.log('PLAN   ', plan.sections.map((s) => ({ words: s.words, total: s.total, span: s.span ?? 'all' })));

    const t0 = Date.now();
    const result = await generateSet({ setId: set.id, apiKey });
    console.log(`\nRUN     ${((Date.now() - t0) / 1000).toFixed(1)}s, ${calls.length} request(s)`);

    for (const [i, c] of calls.entries()) {
      console.log(`\nCALL ${i + 1}  asked ${JSON.stringify(c.budget)}  -> model wrote ${c.items.length} in ${(c.ms / 1000).toFixed(1)}s`);
      for (const it of c.items) console.log(`   [${it.kind}/${it.level}] line ${it.source_sentence}  Q: ${it.prompt}\n        A: ${it.answer}`);
    }

    console.log(`\nDROPPED ${result.dropped.length}`);
    for (const d of result.dropped) console.log(`   ${d.reason}: ${d.detail}  | ${d.prompt}`);

    const items = await listItems(set.id);
    console.log(`\nSTORED  ${items.length} of ${count} requested`);
    for (const it of items) {
      console.log(`   [${it.kind}/${it.level}] Q: ${it.prompt}\n        A: ${it.answer}\n        from: "${it.source_excerpt}"`);
    }

    const byAnswer = new Map<string, number>();
    for (const it of items) byAnswer.set(normalize(it.answer), (byAnswer.get(normalize(it.answer)) ?? 0) + 1);
    const repeats = [...byAnswer].filter(([, n]) => n > 1);
    console.log(`\nREPEATED ANSWERS ${repeats.length ? JSON.stringify(repeats) : 'none'}`);

    const pages = await pagesForSet(set.id);
    const total = splitSentences(pages[0]?.text ?? '').length;
    const cited = calls.flatMap((c) => c.items.map((it) => it.source_sentence)).sort((a, b) => a - b);
    console.log(`COVERAGE lines cited ${JSON.stringify(cited)} of 0..${total - 1}`);
  } finally {
    if (keep) console.log(`\nkept set ${set.id}`);
    else {
      await deleteSet(set.id);
      console.log(`\ndeleted set ${set.id}`);
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
