/**
 * Fill the test account with a plausible study history, so the Progress screen
 * can be looked at without waiting a month for one to accumulate.
 *
 * The dashboard has three genuinely different looks — empty, thin, and a real
 * month of use — and the empty one is the only one that occurs naturally on a
 * fresh account. Everything the screen has to get right (a streak with a gap in
 * it, columns at wildly different heights, sections held back for want of
 * answers) is invisible until there is history to draw.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/seed-progress.ts [--days 30] [--clear]
 *
 * ---------------------------------------------------------------------------
 * REFUSES TO RUN AGAINST ANYTHING BUT THE TEST USERS.
 *
 * This writes fabricated answers. On a real account that would corrupt the one
 * thing the app is trusted to remember — what you actually got wrong — and it
 * would do so invisibly, mixed in with genuine history. The guard is on the
 * signed-in email, checked after sign-in rather than trusted from the argument.
 * ---------------------------------------------------------------------------
 */
import { supabase } from '../src/data/supabase';

/** Only these accounts may be seeded. Both are disposable isolation-test users. */
const ALLOWED = ['iso-a@example.test', 'iso-b@example.test'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (ms: number) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

/**
 * A month that looks like someone studying, not like a random number generator.
 *
 * Deliberately uneven: a keen first week, a four-day gap, a quiet stretch, then
 * a steady run into today. The gap is the important part — it is what proves the
 * streak counts back from the last day rather than totalling every day studied,
 * and what makes the columns worth plotting at all.
 */
function plausibleAnswers(daysAgo: number): number {
  if (daysAgo > 27) return 12;
  if (daysAgo > 25) return 18;
  if (daysAgo > 21) return 0; // a four-day gap
  if (daysAgo > 17) return 6;
  if (daysAgo > 14) return 0; // a weekend off
  if (daysAgo > 8) return 9 + ((daysAgo * 7) % 11);
  if (daysAgo > 5) return 21;
  return 4 + ((daysAgo * 5) % 9);
}

async function main() {
  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  if (!email || !password) {
    throw new Error('Set TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD.');
  }

  const { data: auth, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in: ${error.message}`);

  // Checked on the account that actually signed in, not on the argument that
  // was passed — the argument is what would be wrong in the dangerous case.
  const signedInAs = auth.user?.email ?? '';
  if (!ALLOWED.includes(signedInAs)) {
    throw new Error(
      `Refusing to seed ${signedInAs}. This writes fabricated answers and is only ` +
        `for the disposable test users (${ALLOWED.join(', ')}).`,
    );
  }
  const userId = auth.user!.id;

  if (process.argv.includes('--clear')) {
    const { error: clearError } = await supabase.from('study_days').delete().eq('user_id', userId);
    if (clearError) throw new Error(clearError.message);
    console.log(`Cleared study_days for ${signedInAs}.`);
    return;
  }

  const days = Number(arg('--days') ?? 30);
  const now = Date.now();

  const rows = [];
  for (let i = days - 1; i >= 0; i--) {
    const answers = plausibleAnswers(i);
    if (answers === 0) continue; // a day off has no row, as in real use
    rows.push({ user_id: userId, day: utcDay(now - i * DAY_MS), answers });
  }

  const { error: upsertError } = await supabase
    .from('study_days')
    .upsert(rows, { onConflict: 'user_id,day' });
  if (upsertError) throw new Error(upsertError.message);

  const total = rows.reduce((n, r) => n + r.answers, 0);
  console.log(
    `Seeded ${rows.length} study day(s) over the last ${days}, ${total} answers, for ${signedInAs}.`,
  );
  console.log('Only study_days was touched — no fabricated attempts, cards or schedules.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
