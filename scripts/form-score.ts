/**
 * Phase E1.4 — score the blind labels against the rules and the model's claims.
 *
 * Reads three files produced by, and for, `scripts/form-probe.ts`:
 *
 *   items.jsonl    id, prompt, answer                 (what was labelled)
 *   labels.json    id -> human label(s), written BEFORE claims.jsonl was opened
 *   claims.jsonl   id, arm, the model's claimed form  (opened only afterwards)
 *
 * and prints the four metrics the phase is gated on, per candidate form.
 *
 * ## Why four and not two
 *
 * Precision alone hides the failure that matters most here. A rule that fires
 * on three impeccable examples and misses forty is precise and useless, so
 * COVERAGE is reported first and weighs equally.
 *
 *   coverage             of items humans labelled F, the fraction rule_F accepts
 *   true-form acceptance of items the model CLAIMED F and humans confirmed F,
 *                        the fraction rule_F accepts
 *   non-form acceptance  of items humans labelled not-F, the fraction rule_F
 *                        accepts — the §26.1 false-alarm analogue
 *   intervention rate    of all claims, the fraction the rules would relabel
 *
 * ## The gates are engineering gates
 *
 * coverage >= 0.80 and non-form acceptance <= 0.20. They are thresholds for
 * deciding whether to build something, NOT statistical claims. With ~10 items
 * in a class the interval around any of these numbers is wide, and a form
 * under the floor is reported UNMEASURED rather than passing.
 *
 * Run:
 *   npx tsx scripts/form-score.ts --dir <the probe's --out directory>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CANDIDATE_FORMS, classifyForm, type FormLabel } from '../src/core/form';

/** Below this many human-labelled examples, a form is not judged at all. */
const PER_FORM_FLOOR = 10;
/** Below this many items overall, nothing is judged. */
const TOTAL_FLOOR = 60;

const COVERAGE_GATE = 0.8;
const NON_FORM_GATE = 0.2;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const jsonl = <T>(path: string): T[] =>
  readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);

const pct = (n: number, d: number) => (d === 0 ? '  —  ' : `${((n / d) * 100).toFixed(0)}%`.padStart(5));

function main() {
  const dir = arg('--dir');
  if (!dir) throw new Error('pass --dir <probe output directory>');

  const items = jsonl<{ id: string; prompt: string; answer: string }>(join(dir, 'items.jsonl'));
  const claims = jsonl<{ id: string; arm: string; claimed: string | null; servedBy?: string }>(
    join(dir, 'claims.jsonl'),
  );
  const labelFile = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf-8')) as {
    labels: Record<string, string[]>;
  };

  const byId = new Map(items.map((i) => [i.id, i]));
  const claimById = new Map(claims.map((c) => [c.id, c]));
  const human = labelFile.labels;

  console.log(`${'='.repeat(78)}\nE1.4 — blind human labels vs the rules vs the model\n${'='.repeat(78)}`);
  console.log(`items ${items.length}   labelled ${Object.keys(human).length}   floor ${TOTAL_FLOOR}`);
  if (items.length < TOTAL_FLOOR) console.log('*** BELOW THE FLOOR — nothing here is a judgement. ***');

  // ---- what the taxonomy itself did -------------------------------------
  const multi = Object.values(human).filter((l) => l.length > 1).length;
  const none = Object.values(human).filter((l) => l.length === 0).length;
  console.log(`\n${'-'.repeat(78)}\nTAXONOMY — could a human assign ONE form?\n${'-'.repeat(78)}`);
  console.log(`  carried several forms : ${multi}/${items.length}  ${pct(multi, items.length)}`);
  console.log(`  carried none          : ${none}/${items.length}  ${pct(none, items.length)}`);

  const humanCounts: Record<string, number> = {};
  for (const labels of Object.values(human)) for (const l of labels) humanCounts[l] = (humanCounts[l] ?? 0) + 1;
  console.log('\n  human label distribution:');
  for (const f of CANDIDATE_FORMS) {
    const n = humanCounts[f] ?? 0;
    const flag = n < PER_FORM_FLOOR ? `  << under the ${PER_FORM_FLOOR}-item floor: UNMEASURED` : '';
    console.log(`    ${f.padEnd(20)} ${String(n).padStart(3)}${flag}`);
  }

  // ---- the four metrics --------------------------------------------------
  console.log(`\n${'-'.repeat(78)}\nRULES — four metrics per form\n${'-'.repeat(78)}`);
  console.log(`  ${'form'.padEnd(20)} ${'coverage'.padStart(9)} ${'true-form'.padStart(10)} ${'non-form'.padStart(9)}   verdict`);

  for (const form of CANDIDATE_FORMS) {
    let isF = 0;
    let isFAccepted = 0;
    let notF = 0;
    let notFAccepted = 0;
    let claimedAndConfirmed = 0;
    let claimedAndConfirmedAccepted = 0;

    for (const [id, labels] of Object.entries(human)) {
      const item = byId.get(id);
      if (!item) continue;
      const accepted = classifyForm(item).accepted.includes(form as FormLabel);
      const isThisForm = labels.includes(form);

      if (isThisForm) {
        isF++;
        if (accepted) isFAccepted++;
        if (claimById.get(id)?.claimed === form) {
          claimedAndConfirmed++;
          if (accepted) claimedAndConfirmedAccepted++;
        }
      } else {
        notF++;
        if (accepted) notFAccepted++;
      }
    }

    const coverage = isF === 0 ? 0 : isFAccepted / isF;
    const nonForm = notF === 0 ? 0 : notFAccepted / notF;

    let verdict: string;
    if (isF < PER_FORM_FLOOR) verdict = `UNMEASURED (n=${isF})`;
    else if (coverage >= COVERAGE_GATE && nonForm <= NON_FORM_GATE) verdict = 'PASSES both gates';
    else if (coverage < COVERAGE_GATE && nonForm > NON_FORM_GATE) verdict = 'fails BOTH';
    else if (coverage < COVERAGE_GATE) verdict = 'fails COVERAGE';
    else verdict = 'fails NON-FORM';

    console.log(
      `  ${form.padEnd(20)} ${pct(isFAccepted, isF)}(${String(isF).padStart(2)}) ` +
        `${pct(claimedAndConfirmedAccepted, claimedAndConfirmed)}(${String(claimedAndConfirmed).padStart(2)}) ` +
        `${pct(notFAccepted, notF)}   ${verdict}`,
    );
  }

  // ---- the model's claim against the human label -------------------------
  console.log(`\n${'-'.repeat(78)}\nMODEL — was its own claim right?\n${'-'.repeat(78)}`);
  let claimed = 0;
  let claimAgrees = 0;
  const confusion = new Map<string, number>();
  for (const [id, labels] of Object.entries(human)) {
    const claim = claimById.get(id)?.claimed;
    if (!claim) continue;
    claimed++;
    if (labels.includes(claim)) claimAgrees++;
    else confusion.set(`${claim} -> ${labels.join('+') || 'none'}`, (confusion.get(`${claim} -> ${labels.join('+') || 'none'}`) ?? 0) + 1);
  }
  console.log(`  claims made               : ${claimed}`);
  console.log(`  agreed with a human label : ${claimAgrees}/${claimed}  ${pct(claimAgrees, claimed)}`);
  console.log('\n  where it disagreed (claimed -> humans said):');
  for (const [k, n] of [...confusion.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(2)}  ${k}`);
  }

  // ---- intervention ------------------------------------------------------
  let wouldRelabel = 0;
  for (const [id] of Object.entries(human)) {
    const claim = claimById.get(id)?.claimed;
    const item = byId.get(id);
    if (!claim || !item) continue;
    if (!classifyForm(item).accepted.includes(claim as FormLabel)) wouldRelabel++;
  }
  console.log(
    `\n  INTERVENTION RATE (rules would relabel the claim): ${wouldRelabel}/${claimed}  ${pct(wouldRelabel, claimed)}`,
  );
}

main();
