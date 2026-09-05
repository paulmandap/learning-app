/**
 * Does the pipeline understand a labelled diagram?
 *
 * Runs the real Read -> Plan -> Generate -> Validate path over a document whose
 * contents are known exactly, and reports:
 *
 *   1. what the READ stage extracted (are figure labels captured at all?)
 *   2. which of the six ground-truth labels reached the stored page text
 *   3. every card that was generated, in full
 *   4. which labels ended up covered by a card
 *
 * The document is synthetic on purpose: every label and every function was
 * authored here, so a claim in a card can be checked against the truth rather
 * than argued about.
 */
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { supabase } from '../src/data/supabase';
import { addDocumentToSet, generateSet, planSet } from '../src/data/pipeline';
import { createSet, deleteSet } from '../src/data/sets';
import { listItems } from '../src/data/items';
import { pagesForSet } from '../src/data/documents';

const REQUESTED = 20;

/** The six labels drawn in the figure, with the single function given for each. */
const GROUND_TRUTH = [
  { label: 'flower', fn: 'reproductive' },
  { label: 'leaf', fn: 'photosynthetic' },
  { label: 'fruit', fn: 'seed dispersal' },
  { label: 'stem', fn: 'support' },
  { label: 'roots', fn: 'absorption' },
  { label: 'taproot', fn: 'central' },
] as const;

/**
 * Facts that exist nowhere but in this document.
 *
 * If one appears in a card, the model genuinely read the page. If cards discuss
 * the diagram without any of these, it may be leaning on general plant biology
 * instead — which for a diagram test is the failure worth catching.
 */
const CANARIES = ['VR-118', '320', 'Vance'] as const;

function mimeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case '.pdf': return 'application/pdf';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    default: throw new Error(`unsupported: ${ext}`);
  }
}

async function main() {
  const path = process.argv[2];
  const keep = process.argv.includes('--keep');
  if (!path) throw new Error('usage: diagram-probe <file> [--keep]');

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GK ?? '';
  if (!apiKey) throw new Error('set GEMINI_API_KEY');

  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (authErr) throw new Error(`sign-in: ${authErr.message}`);

  const bytes = readFileSync(path);
  const mime = mimeFor(extname(path));
  const name = basename(path);
  const kind = mime === 'application/pdf' ? 'pdf' : 'image';

  console.log(`\n${'='.repeat(78)}`);
  console.log(`DIAGRAM PROBE — ${name} (${mime}, ${Math.round(bytes.length / 1024)} KB)`);
  console.log('='.repeat(78));

  const set = await createSet(`__diagram ${new Date().toISOString()}`);
  let cleanUp = !keep;

  try {
    // ------------------------------------------------------------- read --
    const t0 = Date.now();
    const { pagesRead, unreadablePages } = await addDocumentToSet({
      setId: set.id,
      apiKey,
      title: name,
      source: { kind, file: new Blob([bytes], { type: mime }), mime, filename: name },
    });
    const readMs = Date.now() - t0;
    console.log(`\n[READ] ${pagesRead} page(s) in ${(readMs / 1000).toFixed(1)}s` +
      `${unreadablePages.length ? `, unreadable: ${unreadablePages.join(', ')}` : ''}`);

    const pages = await pagesForSet(set.id);
    for (const p of pages) {
      console.log(`\n  --- page ${p.page_index} (readability ${p.readability}) ---`);
      if (p.headings.length) console.log(`  headings: ${p.headings.join(' | ')}`);
      console.log(`  ${p.text.length} chars of text`);
      console.log(p.text.split('\n').map((l) => `    ${l}`).join('\n').slice(0, 2600));
    }

    // ------------------------------------ did the labels survive READ? --
    const allText = pages.map((p) => p.text).join('\n').toLowerCase();
    console.log(`\n[LABELS IN EXTRACTED TEXT]`);
    for (const { label, fn } of GROUND_TRUTH) {
      const hasLabel = allText.includes(label);
      const hasFn = allText.includes(fn);
      console.log(
        `  ${label.padEnd(9)} label:${hasLabel ? 'YES' : 'no '}  function:${hasFn ? 'YES' : 'no '}`,
      );
    }
    console.log(`\n[CANARIES IN EXTRACTED TEXT] (exist only in this document)`);
    for (const c of CANARIES) {
      console.log(`  ${c.padEnd(8)} ${allText.includes(c.toLowerCase()) ? 'FOUND' : 'missing'}`);
    }

    // --------------------------------------------------------- generate --
    const plan = await planSet(set.id, REQUESTED);
    console.log(`\n[PLAN] ${plan.sections.length} section(s), ${plan.maxTotal} requested`);

    const t1 = Date.now();
    const result = await generateSet({
      setId: set.id,
      apiKey,
      // Without this a failed section is indistinguishable from a model that
      // simply returned nothing — and those have opposite fixes.
      onProgress: (p) => {
        if (p.phase === 'failed') console.log(`  !! GENERATION FAILED: ${p.message}`);
      },
    });
    console.log(
      `\n[GENERATE] ${result.itemsCreated} card(s) in ${((Date.now() - t1) / 1000).toFixed(1)}s, ` +
      `${result.dropped.length} dropped`,
    );
    for (const d of result.dropped) {
      console.log(`  DROPPED [${d.reason}] ${d.detail} — "${d.prompt.slice(0, 70)}"`);
    }

    // ------------------------------------------------------------ cards --
    const items = await listItems(set.id);
    console.log(`\n[CARDS] ${items.length} stored\n`);
    items.forEach((it, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. [${it.kind}/${it.level}] ${it.prompt}`);
      console.log(`      A: ${it.answer}`);
      if (it.options) {
        console.log(`      options: ${it.options.map((o) => `${o.correct ? '*' : ' '}${o.text}`).join(' | ')}`);
      }
      console.log(`      src p.${(it.page_index ?? 0) + 1}: "${it.source_excerpt.slice(0, 110)}"`);
    });

    // --------------------------------------------- page attribution --
    // "Source · p.N" is only useful if N is right. With the figure isolated on
    // its own page, cards drawn from it must cite that page and not page 1.
    const byPage = new Map<number, number>();
    for (const it of items) {
      const p = (it.page_index ?? 0) + 1;
      byPage.set(p, (byPage.get(p) ?? 0) + 1);
    }
    console.log(`\n[PAGE ATTRIBUTION]`);
    for (const [p, n] of [...byPage].sort((a, b) => a[0] - b[0])) {
      console.log(`  p.${p}: ${n} card(s)`);
    }

    // --------------------------------------------------- label coverage --
    const cardText = items.map((i) => `${i.prompt} ${i.answer}`).join(' ').toLowerCase();
    console.log(`\n[LABEL COVERAGE IN CARDS]`);
    let covered = 0;
    for (const { label } of GROUND_TRUTH) {
      const hit = cardText.includes(label);
      if (hit) covered++;
      console.log(`  ${label.padEnd(9)} ${hit ? 'covered' : '—'}`);
    }
    console.log(`  => ${covered}/${GROUND_TRUTH.length} organs appear in at least one card`);

    console.log(`\n[CANARIES IN CARDS]`);
    for (const c of CANARIES) {
      console.log(`  ${c.padEnd(8)} ${cardText.includes(c.toLowerCase()) ? 'PRESENT' : '—'}`);
    }
  } catch (err) {
    console.error('\nPROBE FAILED:', err instanceof Error ? err.message : err);
    cleanUp = false;
  } finally {
    if (cleanUp) await deleteSet(set.id).catch(() => undefined);
    else console.log(`\n  set kept: ${set.id}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
