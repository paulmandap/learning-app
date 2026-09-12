/**
 * If a partial stopped counting as a miss, how much would Progress move?
 *
 * `sectionSplit` scores a partial exactly as a wrong answer
 * (`src/core/progress.ts`):
 *
 *     correct  = attempts - misses - partials
 *     accuracy = correct / attempts
 *
 * Its docstring once claimed the opposite. §26.7 corrected the words rather
 * than the arithmetic, deliberately, because changing it moves every accuracy
 * figure on the screen — and flagged the decision as the owner's. It has sat
 * open since, because nobody knew how far it would move them.
 *
 * ## Why this reads the backup and not the database
 *
 * Partials come only from short-answer rubric grading (`grade.ts`), and the
 * test account has **zero** in 33 attempts. RLS correctly hides the real
 * history from any script, so the only place all 312 answers exist together is
 * the backup dump. This reads it, counts, and deletes it.
 *
 * ## What it reads, and what it refuses to
 *
 * Three columns of `attempts` (`user_id`, `study_item_id`, `result`) and two of
 * `study_items` (`id`, `section_title`). It never touches `answer_text` or
 * `feedback`, which are what students actually wrote.
 *
 * Section titles are fragments of seven people's notes, so they are **withheld
 * by default** and reported as `section N`. `--name-sections <user>` names them
 * for one account, for when the owner wants to read his own.
 *
 * The plaintext is written only to a temp directory and deleted in `finally` —
 * on success and on failure. §29 recorded an ad-hoc `trap` failing to fire and
 * leaving decrypted notes in %TEMP%; that is why this lives in the script.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/partial-impact.ts --file <backup.tar.gz.gpg>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCopyRows } from '../src/core/dump';
import {
  MIN_SECTION_ATTEMPTS,
  STRONG_ACCURACY,
  sectionSplit,
  type ItemHistory,
} from '../src/core/progress';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

interface Scored {
  section: string;
  attempts: number;
  partials: number;
  /** attempts - misses - partials */
  correct: number;
}

/**
 * The proposed arithmetic: a partial counts as neither right nor wrong.
 *
 * A local variant by necessity — it does not exist in the codebase yet, which
 * is the whole question. The "today" column below comes from the REAL
 * `sectionSplit`, never from a reimplementation, so the comparison is against
 * what actually ships.
 *
 * `assertAgreesWhenNoPartials` checks this variant against the real function on
 * partial-free input, which is the one case where they must agree exactly. If
 * that fails, this file is wrong and no number it prints can be trusted.
 */
function proposedAccuracy(s: Scored): number | null {
  const denominator = s.attempts - s.partials;
  if (denominator <= 0) return null; // nothing left to score
  return s.correct / denominator;
}

function assertAgreesWhenNoPartials(rows: ItemHistory[]): void {
  const clean = rows.filter((r) => r.partials === 0);
  if (clean.length === 0) return;
  const real = sectionSplit(clean, 1000);
  const byName = new Map([...real.strong, ...real.weak].map((s) => [s.section, s.accuracy]));

  const mine = new Map<string, Scored>();
  for (const r of clean) {
    if (!r.section || r.attempts <= 0) continue;
    const t = mine.get(r.section) ?? { section: r.section, attempts: 0, partials: 0, correct: 0 };
    t.attempts += r.attempts;
    t.partials += r.partials;
    t.correct += Math.max(0, r.attempts - r.misses - r.partials);
    mine.set(r.section, t);
  }

  for (const [section, expected] of byName) {
    const got = proposedAccuracy(mine.get(section)!);
    if (got === null || Math.abs(got - expected) > 1e-9) {
      throw new Error(
        `self-check failed: with no partials the proposed arithmetic must equal the shipped one ` +
          `(${section}: ${got} vs ${expected})`,
      );
    }
  }
  console.log(`  self-check: the two agree exactly on ${byName.size} partial-free section(s).`);
}

async function main() {
  const file = arg('--file');
  if (!file) throw new Error('pass --file <backup.tar.gz.gpg>');
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error('BACKUP_PASSPHRASE not set — run with --env-file=.env');
  const nameFor = arg('--name-sections');

  const work = mkdtempSync(join(tmpdir(), 'partial-impact-'));
  try {
    execFileSync(
      'gpg',
      ['--batch', '--yes', '--quiet', '--decrypt', '--passphrase-fd', '0', '--output', join(work, 'b.tar.gz'), file],
      { input: passphrase, stdio: ['pipe', 'ignore', 'inherit'] },
    );
    execFileSync('tar', ['-xzf', 'b.tar.gz'], { cwd: work, stdio: 'inherit' });
    const data = readFileSync(join(work, 'data.sql'), 'utf-8');

    // Only the columns this needs. answer_text and feedback are never read.
    const attempts = readCopyRows(data, 'public.attempts').map((r) => ({
      user: r.user_id ?? '',
      item: r.study_item_id ?? '',
      result: r.result ?? '',
    }));
    const sections = new Map(
      readCopyRows(data, 'public.study_items').map((r) => [r.id ?? '', r.section_title]),
    );

    console.log(`${'='.repeat(78)}\nPARTIAL SCORING — WHAT WOULD CHANGE\n${'='.repeat(78)}`);
    console.log(`  ${attempts.length} answers, ${sections.size} cards, from the backup.\n`);

    const byResult = new Map<string, number>();
    for (const a of attempts) byResult.set(a.result, (byResult.get(a.result) ?? 0) + 1);
    for (const [k, v] of [...byResult].sort((x, y) => y[1] - x[1])) {
      console.log(`  ${k.padEnd(10)} ${String(v).padStart(4)}  ${pct(v / attempts.length)}`);
    }

    const partials = byResult.get('partial') ?? 0;
    if (partials === 0) {
      console.log('\n  NO PARTIALS EXIST. The change is cosmetic: it cannot move any figure');
      console.log('  on Progress today, and only starts to matter once short answers are');
      console.log('  graded partially. That makes this a cheap decision, not a risky one.');
      return;
    }

    // ---- per item, then per user ---------------------------------------
    const perItem = new Map<string, { user: string; attempts: number; misses: number; partials: number }>();
    for (const a of attempts) {
      const t = perItem.get(a.item) ?? { user: a.user, attempts: 0, misses: 0, partials: 0 };
      t.attempts++;
      if (a.result === 'incorrect') t.misses++;
      if (a.result === 'partial') t.partials++;
      perItem.set(a.item, t);
    }

    const users = [...new Set([...perItem.values()].map((v) => v.user))].sort();
    console.log(`\n  ${users.length} account(s) with answers.`);

    let movedSide = 0;
    let droppedOff = 0;
    let sectionsCompared = 0;
    let biggestDelta = 0;

    for (const [n, user] of users.entries()) {
      const history: ItemHistory[] = [];
      const scored = new Map<string, Scored>();
      for (const [itemId, v] of perItem) {
        if (v.user !== user) continue;
        const section = sections.get(itemId) ?? null;
        history.push({ section, attempts: v.attempts, misses: v.misses, partials: v.partials });
        if (!section || v.attempts <= 0) continue;
        const t = scored.get(section) ?? { section, attempts: 0, partials: 0, correct: 0 };
        t.attempts += v.attempts;
        t.partials += v.partials;
        t.correct += Math.max(0, v.attempts - v.misses - v.partials);
        scored.set(section, t);
      }

      const today = sectionSplit(history, 1000);
      const todayByName = new Map([...today.strong, ...today.weak].map((s) => [s.section, s]));
      const label = (s: string, i: number) => (user === nameFor ? s : `section ${n + 1}.${i + 1}`);

      const rows = [...scored.values()].filter((s) => s.attempts >= MIN_SECTION_ATTEMPTS);
      if (rows.length === 0) continue;

      console.log(`\n  --- account ${n + 1} ---`);
      rows.forEach((s, i) => {
        const now = todayByName.get(s.section)?.accuracy ?? s.correct / s.attempts;
        const next = proposedAccuracy(s);
        sectionsCompared++;

        const stillShown = s.attempts - s.partials >= MIN_SECTION_ATTEMPTS;
        if (!stillShown) droppedOff++;
        const sideNow = now >= STRONG_ACCURACY;
        const sideNext = next !== null && next >= STRONG_ACCURACY;
        if (next !== null && sideNow !== sideNext) movedSide++;
        if (next !== null) biggestDelta = Math.max(biggestDelta, Math.abs(next - now));

        const flags = [
          next !== null && sideNow !== sideNext ? (sideNext ? '-> Doing well' : '-> Worth another look') : '',
          stillShown ? '' : 'FALLS BELOW THE GATE',
        ]
          .filter(Boolean)
          .join('  ');

        console.log(
          `    ${label(s.section, i).slice(0, 34).padEnd(34)} ` +
            `n=${String(s.attempts).padStart(3)} p=${String(s.partials).padStart(2)}  ` +
            `${pct(now).padStart(6)} -> ${(next === null ? '   n/a' : pct(next)).padStart(6)}  ${flags}`,
        );
      });
    }

    console.log(`\n${'-'.repeat(78)}\nWHAT THIS MEANS\n${'-'.repeat(78)}`);
    console.log(`  sections compared           ${sectionsCompared}`);
    console.log(`  change which list they are in ${movedSide}   (Doing well <-> Worth another look)`);
    console.log(`  fall below the ${MIN_SECTION_ATTEMPTS}-answer gate  ${droppedOff}   (would vanish from the screen)`);
    console.log(`  largest single move         ${pct(biggestDelta)}`);
    console.log('\n  Every accuracy on Progress moves UP or stays equal: partials leave the');
    console.log('  denominator, never the numerator. Nothing can look worse than it does now.');

    console.log(`\n${'-'.repeat(78)}\nSELF-CHECK\n${'-'.repeat(78)}`);
    // Real section titles, not a single collapsed bucket. An earlier version
    // passed 'x' for every row, so the check compared ONE aggregated section
    // and would have missed any per-section grouping error — the exact class
    // of bug it is here to catch.
    const allHistory: ItemHistory[] = [...perItem.entries()].map(([itemId, v]) => ({
      section: sections.get(itemId) ?? null,
      attempts: v.attempts,
      misses: v.misses,
      partials: v.partials,
    }));
    assertAgreesWhenNoPartials(allHistory);
  } finally {
    rmSync(work, { recursive: true, force: true });
    console.log(`\nplaintext deleted: ${work}`);
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
