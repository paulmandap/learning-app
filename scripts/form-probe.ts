/**
 * Phase E1 — is question-type ("form") control viable at all?
 *
 * This script does not build a feature. It runs the experiment that decides
 * whether one is worth building, and it is designed so that a NEGATIVE result
 * can be attributed to the right cause rather than collapsed into "forms don't
 * work". Three separable failures (see `src/core/form.ts`):
 *
 *   TAXONOMY   the six labels do not carve real distinctions
 *   RULE       they do, and the surface heuristic cannot see it
 *   MODEL      the model cannot produce the forms, or cannot self-report them
 *
 * ## Modes
 *
 *   --baseline   E1.1  classify the cards already in the database. ZERO model
 *                      calls, zero writes. Answers "is the deck monotonous
 *                      today?" — if it is already varied there is no problem.
 *
 *   --ceiling    E1.2  the model's BEST case: notes written to contain a clean
 *                      three-step process, a real comparison and a causal
 *                      chain. If distinguishable forms cannot be produced here
 *                      they cannot be produced anywhere, and the phase ends
 *                      cheaply with the failure attributed to MODEL.
 *                      Also runs E1.5: arm A (unconstrained, the shipped path)
 *                      and arm B (form requested), each repeated --runs times.
 *                      Temperature is 0.4, so two identical runs already
 *                      differ: an A-B distance is only an effect if it exceeds
 *                      every WITHIN-condition distance. Measuring the treatment
 *                      without that floor would be §26.1's mistake in a new
 *                      costume — and one within-pair is a single sample of a
 *                      random quantity, not a floor, so --runs 3 is the
 *                      minimum that can decide anything.
 *
 *                      PIN THE MODEL (--model). The first ceiling run compared
 *                      arms served by different rungs of LIGHT_LADDER and so
 *                      measured the model as much as the treatment.
 *
 * ## It writes nothing, anywhere
 *
 * No database writes, no set created, so no cleanup to forget (§9.4). The
 * baseline reads `study_items`; the ceiling talks only to Gemini. Generated
 * items are written to files under --out for the blind labelling step, split
 * so that labelling CANNOT see the model's claim:
 *
 *   items.jsonl   id, arm, prompt, answer          <- what gets labelled
 *   claims.jsonl  id, claimed form, classifier     <- opened only afterwards
 *
 * ## The seam: no production code changes
 *
 * `GeminiBrowserProvider` already accepts `{ fetchImpl }`, so the probe wraps
 * fetch and edits the outgoing request in flight — adding `form` to the
 * response schema and one clause to the prompt. Everything else is the shipped
 * path: the same `buildGeneratePrompt`, the same `GENERATE_RESPONSE_SCHEMA` as
 * its base, the same `LIGHT_LADDER` fallback, the same `parseItemsLoose`.
 *
 * It works because `form?: string` survives end to end — `generatedItemSchema`
 * → `GeneratedItem` → `CandidateItem`. The field migration 0015 left behind is
 * what makes the experiment free.
 *
 * `form` is added to `properties` but NOT to `required`, exactly as `topic` is
 * handled in the shipped schema. Making it required would force a value and
 * measure nothing: the question is whether the model can CHOOSE a form, not
 * whether it can fill a mandatory field.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/form-probe.ts --baseline
 *   npx tsx --env-file=.env scripts/form-probe.ts --ceiling --model gemini-3.8-flash [--runs 3] [--out DIR]
 *
 * --baseline needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD.
 * --ceiling  needs GEMINI_API_KEY (or GK) and touches no database at all.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GeminiBrowserProvider } from '../src/ai/gemini';
import { renderPagesForPrompt } from '../src/ai/prompts';
import { CallQueue } from '../src/core/queue';
import {
  CANDIDATE_FORMS,
  classificationSpread,
  classifyForm,
  type FormCandidate,
  type FormLabel,
} from '../src/core/form';

// --------------------------------------------------------------- helpers --

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}
const has = (name: string) => process.argv.includes(name);

const bar = (n: number, width = 28) => '█'.repeat(Math.min(width, n));
const pct = (n: number, d: number) => (d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1)}%`);

/**
 * Total variation distance between two label distributions.
 *
 * Half the sum of absolute differences: 0 = identical, 1 = disjoint. Used for
 * arm comparison in E1.5, where the number that matters is not B-vs-A on its
 * own but B-vs-A measured against the A-vs-A floor.
 */
function totalVariation(a: Record<string, number>, b: Record<string, number>): number {
  const sum = (r: Record<string, number>) => Object.values(r).reduce((s, n) => s + n, 0) || 1;
  const [sa, sb] = [sum(a), sum(b)];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  let total = 0;
  for (const k of keys) total += Math.abs((a[k] ?? 0) / sa - (b[k] ?? 0) / sb);
  return total / 2;
}

function reportSpread(title: string, items: FormCandidate[]) {
  const spread = classificationSpread(items);
  console.log(`\n${title}  (n=${spread.total})`);
  for (const label of CANDIDATE_FORMS) {
    const n = spread.byLabel[label];
    console.log(`  ${label.padEnd(20)} ${String(n).padStart(3)}  ${pct(n, spread.total)}  ${bar(n)}`);
  }
  console.log(`  ${'— claimed by nothing'.padEnd(20)} ${String(spread.unclaimed).padStart(3)}  ${pct(spread.unclaimed, spread.total)}`);
  console.log(`  ${'— claimed by several'.padEnd(20)} ${String(spread.multiple).padStart(3)}  ${pct(spread.multiple, spread.total)}`);
  return spread;
}

// -------------------------------------------------------------- baseline --

async function baseline() {
  const { supabase } = await import('../src/data/supabase');

  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (authErr) throw new Error(`sign-in: ${authErr.message}`);

  const { data, error } = await supabase
    .from('study_items')
    .select('id, kind, level, prompt, answer, section_title')
    .eq('hidden', false);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as { kind: string; level: string; prompt: string; answer: string }[];
  console.log(`${'='.repeat(78)}\nE1.1 BASELINE — cards already in the database\n${'='.repeat(78)}`);
  console.log('Zero model calls. Nothing written.');

  const spread = reportSpread('Deterministic classification of the real deck', rows);

  console.log('\nPer card:');
  for (const r of rows) {
    const { accepted } = classifyForm(r);
    const verdict = accepted.length === 0 ? '(none)' : accepted.join(' + ');
    console.log(`  [${r.level.padEnd(10)} ${r.kind.padEnd(12)}] ${verdict}`);
    console.log(`      Q: ${r.prompt.slice(0, 96)}`);
  }

  console.log(
    `\nREAD THIS AS: ${spread.unclaimed}/${spread.total} of the real deck matches no candidate form.`,
  );
  console.log(
    'A high unclaimed rate here is NOT yet a taxonomy failure — this corpus is\n' +
      'labelled-figure notes, which can only legitimately yield definitions and\n' +
      'part/function pairs. That is what --ceiling exists to control for.',
  );
}

// ------------------------------------------------------- the wrapped call --

/** Synthetic notes: a process, a comparison and a causal chain, all explicit. */
const CEILING_PAGES = [
  {
    page_index: 0,
    text: [
      'MUNICIPAL WATER TREATMENT',
      'Raw water drawn from a river is not safe to drink and must be treated in stages.',
      'First, the water enters a coagulation tank where alum is added.',
      'The alum makes suspended clay particles clump together into larger flocs.',
      'Then the water moves to a sedimentation basin and the heavy flocs sink to the bottom.',
      'Finally the clarified water passes through a sand filter that traps the remaining fine particles.',
      'Chlorine is added at the end of the process because it destroys bacteria and viruses that survive filtration.',
      'A residual dose of chlorine is kept in the pipes so that contamination entering later is also killed.',
      'Where chlorine contact time is too short, pathogens survive and outbreaks of waterborne disease follow.',
    ].join('\n'),
  },
  {
    page_index: 1,
    text: [
      'COMPARING THE TWO CLARIFICATION STAGES',
      'Sedimentation and filtration both remove solids, but they work on different particle sizes.',
      'Sedimentation removes heavy flocs using gravity alone and needs no replaceable medium.',
      'Filtration removes fine particles that gravity cannot settle, whereas sedimentation leaves those in suspension.',
      'Filtration requires a sand bed that must be backwashed regularly, while a sedimentation basin needs only desludging.',
      'Hardness is caused by dissolved calcium and magnesium, which neither stage removes.',
      'Because hard water leaves scale inside boilers, a separate softening step is required where hardness is high.',
      'Turbidity is a measure of cloudiness and is recorded before and after each stage.',
    ].join('\n'),
  },
];

const FORM_CLAUSE = (forms: readonly string[]) =>
  `12. Set "form" on every item to the ONE entry from this list that best describes the item you wrote: ${forms.join(', ')}. Choose the form that matches how the question is actually built, not the topic.\n`;

/**
 * A fetch that edits the outgoing generateContent request in flight.
 *
 * **Both arms use this wrapper**, the control with `askForm: false`. An
 * unwrapped control would differ from the treatment in two ways at once, and
 * only one of them is the thing under test.
 *
 * ## Why the model is pinned
 *
 * The first ceiling run compared arms served by DIFFERENT models: the ladder
 * gave A1/A2 to `gemini-3.5-flash-lite` (rung 4) and B1 to `gemini-3.8-flash`
 * (rung 3), because availability rotates on the free tier. That distance
 * measured "a different model" as much as "asked for a form" and was not a
 * controlled comparison at all. `pin` holds the model fixed across arms; the
 * served model is recorded either way so a fallback cannot pass unnoticed.
 */
type Mutation = 'none' | 'askForm' | 'stripFormsLine';

function probeFetch(opts: { mutate: Mutation; pin?: string; seen: { model?: string } }): typeof fetch {
  const real = globalThis.fetch.bind(globalThis);

  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let url = typeof input === 'string' ? input : String(input);
    if (!init?.body || !url.includes(':generateContent')) return real(input, init);

    if (opts.pin) url = url.replace(/\/models\/[^:]+:generateContent/, `/models/${opts.pin}:generateContent`);
    opts.seen.model = /\/models\/([^:]+):generateContent/.exec(url)?.[1];

    if (opts.mutate === 'none') return real(url, init);

    const body = JSON.parse(String(init.body));
    const part = body?.contents?.[0]?.parts?.[0];
    const schema = body?.generationConfig?.responseSchema?.properties?.items?.items;

    // Only touch a body that is shaped the way generateItems builds one. A
    // silent no-op here would mean the treatment arm was secretly the control,
    // and this project has paid four times for something that failed quietly.
    if (typeof part?.text !== 'string' || !schema?.properties) {
      throw new Error('form-probe: unexpected request shape — refusing to run a silent control');
    }

    if (opts.mutate === 'askForm') {
      part.text = part.text.replace('\nNOTES:\n', `${FORM_CLAUSE(CANDIDATE_FORMS)}\nNOTES:\n`);
      schema.properties.form = { type: 'string', enum: [...CANDIDATE_FORMS] };
    } else {
      // Remove the dead "Allowed forms: …" instruction. Asserted rather than
      // assumed: a regex that silently matched nothing would make this arm
      // identical to the control and manufacture a "no regression" result.
      const before = part.text;
      part.text = before.replace(/\nAllowed forms: [^\n]*\n/, '\n');
      if (part.text === before) {
        throw new Error('form-probe: the "Allowed forms:" line was not found — nothing was stripped');
      }
    }

    return real(url, { ...init, body: JSON.stringify(body) });
  }) as typeof fetch;
}

interface ProbeItem {
  id: string;
  arm: string;
  level: string;
  kind: string;
  prompt: string;
  answer: string;
  claimed: string | null;
  servedBy: string;
}

async function generateArm(
  arm: string,
  apiKey: string,
  mutate: Mutation,
  pin?: string,
): Promise<ProbeItem[]> {
  const seen: { model?: string } = {};
  const provider = new GeminiBrowserProvider(apiKey, {
    fetchImpl: probeFetch({ mutate, pin, seen }),
  });
  const queue = new CallQueue();

  // Exactly the call `generateSet` makes (src/data/pipeline.ts).
  const generated = await queue.run(() =>
    provider.generateItems({
      sectionText: renderPagesForPrompt(CEILING_PAGES),
      sectionTitle: 'Municipal water treatment',
      budget: { remember: 4, understand: 4, apply: 4 },
      pageRange: { from: 0, to: 1 },
    }),
  );

  return generated.map((g, i) => ({
    id: `${arm}-${String(i).padStart(2, '0')}`,
    arm,
    level: g.level,
    kind: g.kind,
    prompt: g.prompt,
    answer: g.answer,
    claimed: g.form ?? null,
    servedBy: seen.model ?? 'unknown',
  }));
}

// --------------------------------------------------------------- ceiling --

async function ceiling() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GK ?? '';
  if (!apiKey) throw new Error('set GEMINI_API_KEY');

  // Defaults OUTSIDE the repository on purpose: `tmp-form-probe/` is not in
  // .gitignore, so a run without --out would leave generated cards sitting in
  // the working tree waiting to be committed by accident.
  const outDir = arg('--out') ?? join(tmpdir(), 'form-probe');
  mkdirSync(outDir, { recursive: true });
  const runs = Number(arg('--runs') ?? 3);
  const pin = arg('--model');

  console.log(`${'='.repeat(78)}\nE1.2 / E1.5 CEILING — the model's best case\n${'='.repeat(78)}`);
  console.log('Notes contain a 3-step process, a real comparison and a causal chain.');
  console.log('Nothing is written to the database.\n');

  const all: ProbeItem[] = [];

  // Arm A twice: the run-to-run noise floor. Without it, any A-vs-B difference
  // is uninterpretable at temperature 0.4.
  console.log(pin ? `Model pinned to ${pin} across every arm.\n` : 'Model NOT pinned — pass --model to control it.\n');

  for (let i = 0; i < runs; i++) {
    const items = await generateArm(`A${i + 1}`, apiKey, 'none', pin);
    console.log(
      `arm A${i + 1} (unconstrained) -> ${String(items.length).padStart(2)} items  served by ${items[0]?.servedBy ?? 'n/a'}`,
    );
    all.push(...items);
  }
  for (let i = 0; i < runs; i++) {
    const items = await generateArm(`B${i + 1}`, apiKey, 'askForm', pin);
    console.log(
      `arm B${i + 1} (form asked)   -> ${String(items.length).padStart(2)} items  served by ${items[0]?.servedBy ?? 'n/a'}`,
    );
    all.push(...items);
  }

  // ---- did the model answer at all? (MODEL failure, first half) ----------
  const bItems = all.filter((i) => i.arm.startsWith('B'));
  const claimed = bItems.filter((i) => i.claimed !== null);
  console.log(`\n${'-'.repeat(78)}\nSUPPLY — did the model set a form when asked?\n${'-'.repeat(78)}`);
  console.log(`  ${claimed.length}/${bItems.length} items carried a form  (${pct(claimed.length, bItems.length)})`);
  const claimCounts: Record<string, number> = {};
  for (const i of claimed) claimCounts[i.claimed!] = (claimCounts[i.claimed!] ?? 0) + 1;
  for (const [form, n] of Object.entries(claimCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${form.padEnd(20)} ${String(n).padStart(3)}  ${bar(n)}`);
  }
  if (claimed.length === 0) {
    console.log('  => the model returned NO form. Attribute to MODEL (cannot self-report).');
  }

  // ---- what the rules see in each arm ------------------------------------
  const byArm = new Map<string, ProbeItem[]>();
  for (const i of all) byArm.set(i.arm, [...(byArm.get(i.arm) ?? []), i]);

  const dists: Record<string, Record<string, number>> = {};
  for (const [arm, items] of byArm) {
    const spread = reportSpread(`arm ${arm} — deterministic classification`, items);
    dists[arm] = { ...spread.byLabel, unclaimed: spread.unclaimed };
  }

  // ---- E1.5: does asking for a form change the output at all? ------------
  console.log(`\n${'-'.repeat(78)}\nE1.5 — does requesting a form change what comes back?\n${'-'.repeat(78)}`);

  const aArms = [...byArm.keys()].filter((a) => a.startsWith('A')).sort();
  const bArms = [...byArm.keys()].filter((a) => a.startsWith('B')).sort();

  const within = (arms: string[]) => {
    const out: number[] = [];
    for (let i = 0; i < arms.length; i++) {
      for (let j = i + 1; j < arms.length; j++) out.push(totalVariation(dists[arms[i]!]!, dists[arms[j]!]!));
    }
    return out;
  };
  const cross: number[] = [];
  for (const a of aArms) for (const b of bArms) cross.push(totalVariation(dists[a]!, dists[b]!));

  const withinPairs = [...within(aArms), ...within(bArms)];
  const show = (xs: number[]) => xs.map((x) => x.toFixed(3)).join(', ');

  console.log(`  within-condition (A-A, B-B) : ${withinPairs.length ? show(withinPairs) : 'none'}`);
  console.log(`  across-condition (A-B)      : ${cross.length ? show(cross) : 'none'}`);

  // The served model must be identical across arms or the distance measures
  // the model as much as the treatment. This exact confound invalidated the
  // first ceiling run.
  const models = [...new Set(all.map((i) => i.servedBy))];
  if (models.length > 1) {
    console.log(`  => NOT COMPARABLE. Arms were served by different models: ${models.join(', ')}.`);
    console.log('     Re-run with --model to pin one. No effect may be read from this.');
  } else if (withinPairs.length < 2) {
    console.log('  => NOT DECIDABLE. A single within-condition pair is one sample of a');
    console.log('     random quantity, not a noise floor. Re-run with --runs 3 or more.');
  } else if (Math.min(...cross) > Math.max(...withinPairs)) {
    console.log(
      `  => SEPARATED: every A-B distance (min ${Math.min(...cross).toFixed(3)}) exceeds every`,
    );
    console.log(`     within-condition distance (max ${Math.max(...withinPairs).toFixed(3)}).`);
  } else {
    console.log(
      `  => WITHIN NOISE: A-B distances overlap the within-condition range, so asking`,
    );
    console.log('     for a form did not measurably change what came back.');
  }

  // ---- intervention rate: claim vs rule ----------------------------------
  console.log(`\n${'-'.repeat(78)}\nINTERVENTION RATE — how often would a validator relabel?\n${'-'.repeat(78)}`);
  let disagree = 0;
  for (const item of claimed) {
    const { accepted } = classifyForm(item);
    if (!accepted.includes(item.claimed as FormLabel)) disagree++;
  }
  console.log(`  ${disagree}/${claimed.length} claims the rules do not accept  (${pct(disagree, claimed.length)})`);
  console.log(
    '  NOTE: this is claim-vs-rule, NOT correctness. Which of the two is wrong\n' +
      '  is decided by the blind human labels in E1.4, not here.',
  );

  // ---- files for the blind labelling pass --------------------------------
  const itemsPath = join(outDir, 'items.jsonl');
  const claimsPath = join(outDir, 'claims.jsonl');
  writeFileSync(
    itemsPath,
    all.map((i) => JSON.stringify({ id: i.id, prompt: i.prompt, answer: i.answer })).join('\n'),
    'utf-8',
  );
  writeFileSync(
    claimsPath,
    all
      .map((i) =>
        JSON.stringify({ id: i.id, arm: i.arm, level: i.level, kind: i.kind, servedBy: i.servedBy, claimed: i.claimed, rules: classifyForm(i).accepted }),
      )
      .join('\n'),
    'utf-8',
  );

  console.log(`\nFor the blind labelling pass (E1.4):`);
  console.log(`  ${itemsPath}   <- label from this; it carries NO claim and NO rule output`);
  console.log(`  ${claimsPath}  <- open only after every label is written`);
  console.log(`\nItems collected: ${all.length}. The floor for a judgement is 60.`);
}

// ----------------------------------------------------------------- inert --

/**
 * Does deleting the dead "Allowed forms: …" line change generation at all?
 *
 * A cleanup check, not a feature. The line has never had a field to answer it
 * (§28.1), but removing anything from a prompt can move output, so it is
 * measured before it is deleted rather than after.
 *
 * The instrument is deliberately NOT this file's own classifiers: E1.4
 * measured them as precise but blind, and an instrument that fails its own
 * coverage gate is a poor way to detect a change. `kind`, `level` and item
 * count come straight from the model and need no interpretation, so they lead;
 * the label distribution is reported second.
 */
async function inert() {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GK ?? '';
  if (!apiKey) throw new Error('set GEMINI_API_KEY');
  const runs = Number(arg('--runs') ?? 3);
  const pin = arg('--model');

  console.log(`${'='.repeat(78)}\nINERT-LINE REGRESSION — does removing "Allowed forms:" change anything?\n${'='.repeat(78)}`);
  console.log(pin ? `Model pinned to ${pin}.\n` : 'Model NOT pinned — pass --model.\n');

  const all: ProbeItem[] = [];
  for (let i = 0; i < runs; i++) {
    const items = await generateArm(`L${i + 1}`, apiKey, 'none', pin);
    console.log(`arm L${i + 1} (line present) -> ${String(items.length).padStart(2)} items  served by ${items[0]?.servedBy ?? 'n/a'}`);
    all.push(...items);
  }
  for (let i = 0; i < runs; i++) {
    const items = await generateArm(`N${i + 1}`, apiKey, 'stripFormsLine', pin);
    console.log(`arm N${i + 1} (line removed) -> ${String(items.length).padStart(2)} items  served by ${items[0]?.servedBy ?? 'n/a'}`);
    all.push(...items);
  }

  const models = [...new Set(all.map((i) => i.servedBy))];
  const group = (prefix: string) => all.filter((i) => i.arm.startsWith(prefix));
  const countBy = (items: ProbeItem[], key: 'kind' | 'level') => {
    const out: Record<string, number> = {};
    for (const i of items) out[i[key]] = (out[i[key]] ?? 0) + 1;
    return out;
  };
  const labelDist = (items: ProbeItem[]) => {
    const s = classificationSpread(items);
    return { ...s.byLabel, unclaimed: s.unclaimed };
  };

  const L = group('L');
  const N = group('N');

  console.log(`\n${'-'.repeat(78)}\nPRIMARY — straight from the model, no interpretation\n${'-'.repeat(78)}`);
  console.log(`  items per run   L: ${runs === 0 ? 0 : (L.length / runs).toFixed(1)}   N: ${runs === 0 ? 0 : (N.length / runs).toFixed(1)}`);
  for (const key of ['kind', 'level'] as const) {
    const [dl, dn] = [countBy(L, key), countBy(N, key)];
    console.log(`\n  ${key}:`);
    for (const k of new Set([...Object.keys(dl), ...Object.keys(dn)])) {
      console.log(`    ${k.padEnd(14)} L ${String(dl[k] ?? 0).padStart(3)}  N ${String(dn[k] ?? 0).padStart(3)}`);
    }
    console.log(`    ${'total variation'.padEnd(14)} ${totalVariation(dl, dn).toFixed(3)}`);
  }

  // Same within-vs-across discipline as E1.5: at temperature 0.4 two identical
  // runs differ, so a raw L-vs-N number means nothing on its own.
  const armDist = new Map<string, Record<string, number>>();
  for (const a of new Set(all.map((i) => i.arm))) armDist.set(a, labelDist(all.filter((i) => i.arm === a)));
  const names = [...armDist.keys()].sort();
  const within: number[] = [];
  const across: number[] = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const d = totalVariation(armDist.get(names[i]!)!, armDist.get(names[j]!)!);
      (names[i]![0] === names[j]![0] ? within : across).push(d);
    }
  }
  console.log(`\n${'-'.repeat(78)}\nSECONDARY — label distribution, within vs across\n${'-'.repeat(78)}`);
  console.log(`  within-condition : ${within.map((x) => x.toFixed(3)).join(', ')}`);
  console.log(`  across-condition : ${across.map((x) => x.toFixed(3)).join(', ')}`);

  console.log(`\n${'-'.repeat(78)}\nVERDICT\n${'-'.repeat(78)}`);
  if (models.length > 1) {
    console.log(`  NOT COMPARABLE — arms served by different models: ${models.join(', ')}.`);
  } else if (within.length < 2) {
    console.log('  NOT DECIDABLE — need --runs 3 or more for a within-condition floor.');
  } else if (Math.min(...across) > Math.max(...within)) {
    console.log('  REGRESSION: removing the line moved output beyond run-to-run noise.');
    console.log('  Do NOT delete it without a closer look.');
  } else {
    console.log('  NO MEASURABLE REGRESSION: across-condition distances sit inside the');
    console.log('  within-condition range. The line can be removed as dead text.');
  }
}

// ------------------------------------------------------------------ main --

async function main() {
  if (has('--baseline')) return baseline();
  if (has('--ceiling')) return ceiling();
  if (has('--inert')) return inert();
  console.log('Pick a mode: --baseline (E1.1, free), --ceiling (E1.2/E1.5) or --inert (cleanup check).');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
