/**
 * Phase G2 — how big can each read in `src/data` actually get?
 *
 * §26.3 recorded that the Phase C trend query was "the first `.limit()` in
 * src/data" and that "every other read is still unbounded — that stays on the
 * Phase G list". This is that measurement, and it exists because the obvious
 * response to "28 unbounded reads" is to add 28 limits, which would be wrong.
 *
 * ## An unbounded read is not automatically a bug. A truncated one can be.
 *
 * The reads here fall into two kinds and they want opposite treatment:
 *
 *   ANALYTICS   history, aggregates, "how am I doing". Truncating the oldest
 *               data costs a little accuracy in a figure nobody can check to
 *               the row. Bounding is free.
 *
 *   CORRECTNESS the deck, the due counts, the pages a section is generated
 *               from. A limit here does not slow anything down — it silently
 *               deals fewer cards than the student has, and the app cannot
 *               tell that it happened. §21 and §23.1 are both bugs of exactly
 *               this shape, where a count and the thing it counted drifted.
 *
 * So this reports SIZE and GROWTH per read, and the fix is chosen per read.
 *
 * ## What actually bounds these queries today
 *
 * RLS scopes every one of them to a single user, so "unbounded" means
 * "unbounded per user" — the ceiling is the heaviest student, not the whole
 * table. That is why the raw table counts below are reported per user as well
 * as in total.
 *
 * READ-ONLY. Signs in, counts, and writes nothing.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/read-bounds-probe.ts
 *
 * Needs TEST_USER_A_EMAIL / TEST_USER_A_PASSWORD.
 */
import { supabase } from '../src/data/supabase';

/** Tables every read ultimately draws from, with what drives their growth. */
const TABLES: { name: string; grows: string }[] = [
  { name: 'attempts', grows: 'every answer, forever' },
  { name: 'study_items', grows: 'every card made' },
  { name: 'review_state', grows: 'one row per card' },
  { name: 'document_pages', grows: 'one row per page uploaded' },
  { name: 'documents', grows: 'one row per upload' },
  { name: 'study_sets', grows: 'one row per set' },
  { name: 'notes', grows: 'one row per note written' },
  { name: 'study_days', grows: 'one row per day studied' },
  { name: 'chat_usage', grows: 'one row per day Nomi is used' },
  { name: 'heartbeat', grows: 'bounded by design' },
  { name: 'profiles', grows: 'one row per user' },
];

async function countOf(table: string): Promise<number> {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

async function main() {
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: process.env.TEST_USER_A_EMAIL!,
    password: process.env.TEST_USER_A_PASSWORD!,
  });
  if (authErr) throw new Error(`sign-in: ${authErr.message}`);

  console.log(`${'='.repeat(78)}\nPHASE G2 — READ BOUNDS\n${'='.repeat(78)}`);
  console.log('Everything below is what THIS signed-in user can see, under RLS.\n');

  console.log(`  ${'table'.padEnd(16)} ${'rows'.padStart(7)}   grows with`);
  const counts = new Map<string, number>();
  for (const t of TABLES) {
    const n = await countOf(t.name);
    counts.set(t.name, n);
    console.log(`  ${t.name.padEnd(16)} ${String(n).padStart(7)}   ${t.grows}`);
  }

  // ---- the fastest-growing table, measured rather than assumed ----------
  const { data: attempts, error } = await supabase
    .from('attempts')
    .select('created_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);

  const rows = (attempts ?? []) as { created_at: string }[];
  if (rows.length > 0) {
    const days = new Map<string, number>();
    for (const r of rows) days.set(r.created_at.slice(0, 10), (days.get(r.created_at.slice(0, 10)) ?? 0) + 1);
    const perDay = [...days.values()];
    const busiest = Math.max(...perDay);
    const mean = perDay.reduce((s, n) => s + n, 0) / perDay.length;
    const first = rows[rows.length - 1]!.created_at.slice(0, 10);
    const last = rows[0]!.created_at.slice(0, 10);

    console.log(`\n${'-'.repeat(78)}\nATTEMPTS — the fastest-growing table\n${'-'.repeat(78)}`);
    console.log(`  ${rows.length} answers across ${days.size} distinct day(s), ${first} .. ${last}`);
    console.log(`  busiest day ${busiest}, mean ${mean.toFixed(1)} per active day`);
    console.log(`  at this rate: ${Math.round(mean * 365)}/yr, ${Math.round(mean * 365 * 5)} after five years`);
    console.log(`  a heavy day of ${busiest} sustained: ${busiest * 365}/yr`);
  }

  // ---- per-set ceilings: what one screen has to hold --------------------
  const { data: sets } = await supabase.from('study_sets').select('id, title');
  console.log(`\n${'-'.repeat(78)}\nPER-SET — what one study screen loads at once\n${'-'.repeat(78)}`);
  let worstItems = 0;
  let worstPages = 0;
  for (const s of (sets ?? []) as { id: string; title: string }[]) {
    const [{ count: items }, { count: pages }] = await Promise.all([
      supabase.from('study_items').select('*', { count: 'exact', head: true }).eq('study_set_id', s.id),
      supabase.from('document_pages').select('*', { count: 'exact', head: true }).eq('study_set_id', s.id),
    ]);
    worstItems = Math.max(worstItems, items ?? 0);
    worstPages = Math.max(worstPages, pages ?? 0);
    console.log(`  ${String(items ?? 0).padStart(4)} cards  ${String(pages ?? 0).padStart(4)} pages   ${s.title.slice(0, 44)}`);
  }
  console.log(`  worst set: ${worstItems} cards, ${worstPages} pages`);

  // ---- the silent-truncation hazard -------------------------------------
  console.log(`\n${'-'.repeat(78)}\nSILENT TRUNCATION — the hazard that matters more than speed\n${'-'.repeat(78)}`);
  const biggest = TABLES.map((t) => counts.get(t.name) ?? 0).reduce((a, b) => Math.max(a, b), 0);
  console.log(`  largest table this user can see: ${biggest} rows`);
  console.log('  PostgREST applies a server-side max-rows cap and returns the truncated');
  console.log('  page WITHOUT an error. If that cap is set, a read past it loses rows');
  console.log('  silently — a shorter deck, a lower count, and no way for the app to');
  console.log('  tell. It cannot be detected from here while every table is under it.');
  console.log('  CHECK: Supabase dashboard -> Settings -> API -> Max rows.');

  // ---- do the REAL reads come back complete? ---------------------------
  // §24.6's trick: hand the shipped functions a signed-in client and watch
  // what they actually do. completeRows reports on console.warn, so
  // capturing it turns 'is anything truncated today' into a yes or a no.
  const { fetchDashboard } = await import('../src/data/dashboard');
  const { dueCountsBySet, reviewStatesForSet } = await import('../src/data/review');
  const { listItems } = await import('../src/data/items');
  const { pagesForSet } = await import('../src/data/documents');
  const { itemStatsForSet, continueTarget } = await import('../src/data/attempts');

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.map(String).join(' '));

  const setId = ((sets ?? []) as { id: string }[])[0]?.id;
  const dash = await fetchDashboard();
  const due = await dueCountsBySet();
  const cards = setId ? await listItems(setId) : [];
  const pages = setId ? await pagesForSet(setId) : [];
  const stats = setId ? await itemStatsForSet(setId) : [];
  const states = setId ? await reviewStatesForSet(setId) : new Map();
  const cont = await continueTarget();
  console.warn = realWarn;

  console.log('');
  console.log('-'.repeat(78));
  console.log('THE SHIPPED READS, RUN FOR REAL');
  console.log('------------------------------------------------------------------------------');
  console.log(`  fetchDashboard      dueToday=${dash.dueToday} toRetry=${dash.toRetry}`);
  console.log(`  dueCountsBySet      ${due.size} set(s)`);
  console.log(`  listItems           ${cards.length} card(s)`);
  console.log(`  pagesForSet         ${pages.length} page(s)`);
  console.log(`  itemStatsForSet     ${stats.length} row(s)`);
  console.log(`  reviewStatesForSet  ${states.size} row(s)`);
  console.log(`  continueTarget      ${cont ? 'a target' : 'none'}`);
  const truncations = warnings.filter((w) => w.includes('truncated'));
  console.log('');
  if (truncations.length === 0) {
    console.log('  NO read was truncated. Every query returned every matching row.');
  } else {
    console.log(`  ${truncations.length} TRUNCATED READ(S):`);
    for (const t of truncations) console.log(`    ${t}`);
  }
  for (const w of warnings.filter((x) => !x.includes('truncated'))) console.log(`  note: ${w}`);

  console.log('\nNothing was written.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
