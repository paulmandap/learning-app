/**
 * Phase F — does Home's "Continue" ever send you somewhere with nothing to do?
 *
 * ## The question, and why it comes before any code
 *
 * Home offers **"Continue: <set>"**, chosen by `continueTarget` as the set with
 * the most recent answer — *"where you left off, not wherever the biggest
 * backlog happens to be"*. Progress offers a different button, chosen by
 * `busiestSet` — most work, not most recent. §23.1 made that split
 * deliberately: *"Home answers where was I, Progress answers where is the
 * work."*
 *
 * Phase F proposes a recommendation on Home. Before building one, the gap it
 * would fill has to exist. The failure worth fixing is specific:
 *
 *   **Home points at a set with nothing due and nothing missed, while another
 *   set has work waiting.**
 *
 * That is a student being told to carry on with the one thing that is finished.
 * If it never happens, Phase F is solving nothing and should be declined —
 * this project has turned down three features on measured grounds and all
 * three were right.
 *
 * ## Why the backup and not the database
 *
 * RLS hides every account but the caller's, and the test account has two sets
 * of probe data. The dump holds all of it — 9 sets and 4 accounts with real
 * history — which is the only place this is answerable. Read, counted, and the
 * plaintext deleted in `finally` (§29's lesson: not in an ad-hoc shell line).
 *
 * Reads `attempts`, `review_state` and `study_items`. Never `answer_text`,
 * `feedback`, `prompt` or `notes` — the counts do not need them and they are
 * what people wrote.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/continue-probe.ts --file <backup.tar.gz.gpg>
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCopyRows } from '../src/core/dump';
import { startOfUtcDay } from '../src/core/schedule';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface SetState {
  due: number;
  missed: number;
  cards: number;
  lastAnswerAt: number | null;
}

async function main() {
  const file = arg('--file');
  if (!file) throw new Error('pass --file <backup.tar.gz.gpg>');
  const passphrase = process.env.BACKUP_PASSPHRASE;
  if (!passphrase) throw new Error('BACKUP_PASSPHRASE not set — run with --env-file=.env');

  const now = Number(arg('--now') ?? Date.now());
  const work = mkdtempSync(join(tmpdir(), 'continue-probe-'));

  try {
    execFileSync(
      'gpg',
      ['--batch', '--yes', '--quiet', '--decrypt', '--passphrase-fd', '0', '--output', join(work, 'b.tar.gz'), file],
      { input: passphrase, stdio: ['pipe', 'ignore', 'inherit'] },
    );
    execFileSync('tar', ['-xzf', 'b.tar.gz'], { cwd: work, stdio: 'inherit' });
    const data = readFileSync(join(work, 'data.sql'), 'utf-8');

    const hidden = new Set(
      readCopyRows(data, 'public.study_items')
        .filter((r) => r.hidden === 't' || r.hidden === 'true')
        .map((r) => r.id ?? ''),
    );
    const setOfItem = new Map(
      readCopyRows(data, 'public.study_items').map((r) => [r.id ?? '', r.study_set_id ?? '']),
    );

    const attempts = readCopyRows(data, 'public.attempts').map((r) => ({
      user: r.user_id ?? '',
      item: r.study_item_id ?? '',
      set: r.study_set_id ?? '',
      result: r.result ?? '',
      at: Date.parse(r.created_at ?? ''),
    }));

    // item_stats, reconstructed: the LAST answer per card is what decides both
    // the continue target and whether a card is in the missed pile.
    const last = new Map<string, { user: string; set: string; result: string; at: number }>();
    for (const a of attempts) {
      if (!Number.isFinite(a.at)) continue;
      const prev = last.get(a.item);
      if (!prev || a.at > prev.at) last.set(a.item, { user: a.user, set: a.set, result: a.result, at: a.at });
    }

    const today = startOfUtcDay(now);
    const due = readCopyRows(data, 'public.review_state').filter((r) => {
      const at = Date.parse(r.due_at ?? '');
      return Number.isFinite(at) && at <= today && !hidden.has(r.study_item_id ?? '');
    });

    // Per user, per set.
    const byUser = new Map<string, Map<string, SetState>>();
    const ensure = (user: string, set: string): SetState => {
      const sets = byUser.get(user) ?? new Map<string, SetState>();
      byUser.set(user, sets);
      const s = sets.get(set) ?? { due: 0, missed: 0, cards: 0, lastAnswerAt: null };
      sets.set(set, s);
      return s;
    };

    for (const [item, l] of last) {
      if (hidden.has(item)) continue;
      const s = ensure(l.user, l.set);
      s.cards++;
      if (l.result === 'incorrect' || l.result === 'partial') s.missed++;
      if (s.lastAnswerAt === null || l.at > s.lastAnswerAt) s.lastAnswerAt = l.at;
    }
    for (const r of due) {
      const item = r.study_item_id ?? '';
      const owner = last.get(item)?.user ?? r.user_id ?? '';
      const set = setOfItem.get(item) ?? r.study_set_id ?? '';
      ensure(owner, set).due++;
    }

    console.log(`${'='.repeat(78)}\nPHASE F — IS HOME'S "CONTINUE" EVER USELESS?\n${'='.repeat(78)}`);
    console.log(`  as of ${new Date(today).toISOString().slice(0, 10)} (UTC day boundary)\n`);

    let usersWithGap = 0;
    let usersChecked = 0;

    for (const [user, sets] of [...byUser.entries()].sort()) {
      const answered = [...sets.entries()].filter(([, s]) => s.lastAnswerAt !== null);
      if (answered.length === 0) continue;
      usersChecked++;

      // continueTarget: the set holding the most recently answered card.
      const [continueSet, cont] = answered.sort((a, b) => (b[1].lastAnswerAt ?? 0) - (a[1].lastAnswerAt ?? 0))[0]!;
      const contWaiting = cont.due + cont.missed;

      const others = [...sets.entries()].filter(([id]) => id !== continueSet);
      const bestOther = others.sort((a, b) => b[1].due + b[1].missed - (a[1].due + a[1].missed))[0];
      const otherWaiting = bestOther ? bestOther[1].due + bestOther[1].missed : 0;

      const gap = contWaiting === 0 && otherWaiting > 0;
      if (gap) usersWithGap++;

      console.log(`  account ${usersChecked}  (${sets.size} set(s))`);
      console.log(
        `    Home would offer   : set ${continueSet.slice(0, 8)} — ${cont.due} due, ${cont.missed} to retry`,
      );
      if (bestOther) {
        console.log(
          `    busiest other set  : set ${bestOther[0].slice(0, 8)} — ${bestOther[1].due} due, ${bestOther[1].missed} to retry`,
        );
      }
      console.log(
        gap
          ? '    >> GAP: Home points at a finished set while another has work.'
          : contWaiting === 0 && otherWaiting === 0
            ? '    (nothing waiting anywhere — Home has nothing to recommend either)'
            : '    ok: the set Home offers has work in it.',
      );
      console.log('');
    }

    // ---- the same question, at every past point in time -----------------
    //
    // One snapshot is one sample. The gap arises when you FINISH your most
    // recent set while work sits elsewhere, which is a transient state — it
    // could be common and simply absent today.
    //
    // Due dates cannot be reconstructed historically without replaying the
    // scheduler, so this replays the MISSED PILE only, which is derivable from
    // `attempts` alone. That makes it deliberately over-permissive: ignoring
    // due counts can only INVENT gaps that the real screen would have filled,
    // never hide one. So "no gap here" is strong evidence and "gaps here"
    // would be inconclusive.
    console.log(`${'-'.repeat(78)}\nEVERY DAY IN THE HISTORY, not just today\n${'-'.repeat(78)}`);

    let dayChecks = 0;
    let dayGaps = 0;

    for (const user of new Set(attempts.map((a) => a.user))) {
      const mine = attempts.filter((a) => a.user === user && Number.isFinite(a.at)).sort((x, y) => x.at - y.at);
      const days = [...new Set(mine.map((a) => new Date(a.at).toISOString().slice(0, 10)))];

      for (const day of days) {
        const cutoff = Date.parse(`${day}T23:59:59.999Z`);
        const asOf = new Map<string, { set: string; result: string; at: number }>();
        for (const a of mine) {
          if (a.at > cutoff) break;
          if (hidden.has(a.item)) continue;
          asOf.set(a.item, { set: a.set, result: a.result, at: a.at });
        }
        if (asOf.size === 0) continue;

        const missedBySet = new Map<string, number>();
        let newest: { set: string; at: number } | null = null;
        for (const v of asOf.values()) {
          if (v.result === 'incorrect' || v.result === 'partial') {
            missedBySet.set(v.set, (missedBySet.get(v.set) ?? 0) + 1);
          }
          if (!newest || v.at > newest.at) newest = { set: v.set, at: v.at };
        }
        if (!newest) continue;

        dayChecks++;
        const here = missedBySet.get(newest.set) ?? 0;
        const elsewhere = [...missedBySet.entries()].filter(([s]) => s !== newest!.set).reduce((n, [, c]) => n + c, 0);
        if (here === 0 && elsewhere > 0) dayGaps++;
      }
    }

    console.log(`  account-days checked : ${dayChecks}`);
    console.log(`  of those, Home's set had NO misses while another set did : ${dayGaps}`);
    console.log(
      '  (missed pile only — due counts would fill some of these in, so this',
    );
    console.log('   over-counts rather than under-counts the gap.)');

    console.log(`\n${'-'.repeat(78)}`);
    console.log(`  accounts with history : ${usersChecked}`);
    console.log(`  accounts where Home points at a finished set : ${usersWithGap}`);
    console.log(
      usersWithGap === 0
        ? '\n  The gap Phase F would close does not occur in this data.'
        : '\n  The gap is real. Phase F has something to fix.',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
    console.log(`\nplaintext deleted: ${work}`);
  }
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
