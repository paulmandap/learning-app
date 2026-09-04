/**
 * Phase 2 acceptance verification (spec §6).
 *
 * Closes the two acceptance criteria that were never verified because both need
 * input files:
 *
 *   A. "a deliberately blurry photo is reported as unreadable, not turned into cards"
 *   B. "a 10-page text PDF yields cards in under 2 minutes with cards visible
 *       before completion"
 *
 * This drives the REAL pipeline — addDocumentToSet → planSet → generateSet from
 * src/data/pipeline.ts — against the live Supabase project and the live Gemini
 * API. It is not a reimplementation: src/data/** and src/ai/** import nothing
 * from react-native or expo-*, which is what makes them reachable from Node at
 * all (assessment §5.2). A reimplementation would prove the criteria for code
 * that does not ship.
 *
 * Spec §6 requires more than a pass/fail on the two-minute target: if the target
 * is missed, the MEASURED wall-clock and the EXACT bottleneck (read latency vs.
 * enforced gap vs. per-section generate latency) must be reported so the
 * criterion can be changed deliberately rather than silently. That report is
 * printed on every run, pass or fail.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/verify-phase2.ts --blurry "C:\path\blurry.jpg" --pdf "C:\path\notes.pdf"
 *
 * Either flag alone works; both together give one combined report.
 * `--keep` leaves the created sets in place instead of deleting them.
 *
 * Requires:
 *   EXPO_PUBLIC_SUPABASE_URL, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY  (from --env-file=.env)
 *   TEST_USER_A_EMAIL, TEST_USER_A_PASSWORD
 *   GEMINI_API_KEY (or GK)
 *
 * Signs in as the isolation test user, NOT as the owner: the app is OTP-only
 * (D10), so the owner's account has no password a script could use. The Gemini
 * key is passed straight into the pipeline, so no profiles row is needed either.
 *
 * Uses the PUBLISHABLE key only. A service-role key bypasses RLS and must never
 * appear here — same rule as scripts/isolation-test.ts.
 *
 * Exit codes: 0 every check passed · 1 a criterion FAILED · 2 could not run.
 */

import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';

import { supabase } from '../src/data/supabase';
import {
  addDocumentToSet,
  generateSet,
  planSet,
  type Progress,
} from '../src/data/pipeline';
import { createSet, deleteSet, getSet } from '../src/data/sets';
import { countItems, listItems } from '../src/data/items';
import { pagesForSet } from '../src/data/documents';
import { MIN_READABILITY } from '../src/core/planner';
import { MIN_GAP_MS } from '../src/core/queue';

/** Cards requested for both runs. Matches the app's default picker value. */
const REQUESTED = 20;

/** The Phase 2 target being measured (spec §6). */
const BUDGET_MS = 120_000;

/** Pages the PDF criterion is stated in terms of. */
const EXPECTED_PDF_PAGES = 10;

// ---------------------------------------------------------------- reporting --

let checks = 0;
let failures = 0;

function ok(name: string, detail = '') {
  checks++;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name: string, detail: string) {
  checks++;
  failures++;
  console.error(`  FAIL  ${name} — ${detail}`);
}

/** Neither pass nor fail: a measurement the report needs but nothing turns on. */
function info(label: string, detail: string) {
  console.log(`  ····  ${label}: ${detail}`);
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// -------------------------------------------------------------------- input --

interface LoadedFile {
  blob: Blob;
  mime: string;
  name: string;
  bytes: number;
}

/**
 * MIME from the extension.
 *
 * Deliberately a switch rather than a lookup object: with
 * noUncheckedIndexedAccess an object lookup is `string | undefined` anyway, and
 * an unknown extension should be an explicit failure rather than a guess that
 * Gemini rejects thirty seconds later.
 */
function mimeFor(ext: string): string | null {
  switch (ext.toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.heic':
      return 'image/heic';
    case '.pdf':
      return 'application/pdf';
    default:
      return null;
  }
}

function loadFile(path: string): LoadedFile {
  const bytes = readFileSync(path);
  const mime = mimeFor(extname(path));
  if (mime === null) {
    throw new Error(`Unsupported file type: ${extname(path) || '(no extension)'} — ${path}`);
  }
  // Node 22 has Blob as a global; blobToBase64 in src/ai/gemini.ts needs only
  // arrayBuffer() and the global btoa, both present here.
  return {
    blob: new Blob([bytes], { type: mime }),
    mime,
    name: basename(path),
    bytes: bytes.byteLength,
  };
}

// -------------------------------------------------------- check A: blurry ----

/**
 * Facts written on the generated blurry page, with two deliberately wrong
 * numbers and one invented eponym.
 *
 * These matter ONLY if the criterion fails. If cards appear, they separate
 * "the model read the page" from "the model fell back on world knowledge",
 * which is the difference between a readability-threshold problem and a
 * hallucination problem — and the two have opposite fixes.
 */
const CANARIES = [
  {
    label: 'Arctic tern distance',
    onPage: ['12,000', '12000'],
    realWorld: ['70,000', '70000', '80,000', '80000', '90,000', '90000'],
  },
  {
    label: 'Pistol shrimp temperature',
    onPage: ['1,200', '1200'],
    realWorld: ['4,700', '4700', '4,000', '4000'],
  },
  {
    label: 'Invented eponym',
    onPage: ['okonkwo', 'ferrand'],
    realWorld: [],
  },
] as const;

function reportCanaries(cardText: string) {
  console.log('\n  Canary analysis (did it READ the page, or invent from priors?):');
  for (const canary of CANARIES) {
    const read = canary.onPage.some((needle) => cardText.includes(needle));
    const invented = canary.realWorld.some((needle) => cardText.includes(needle));
    const verdict = read
      ? 'matches the PAGE — it read the image'
      : invented
        ? 'matches the REAL WORLD, not the page — invented from priors'
        : 'not mentioned';
    console.log(`    ${canary.label}: ${verdict}`);
  }
}

async function checkBlurry(path: string, apiKey: string, keep: boolean): Promise<void> {
  console.log('\n=== A. Blurry photo must be reported as unreadable ===\n');

  const file = loadFile(path);
  if (!file.mime.startsWith('image/')) {
    fail('blurry input', `expected an image, got ${file.mime}`);
    return;
  }
  info('input', `${file.name} (${file.mime}, ${Math.round(file.bytes / 1024)} KB)`);

  const set = await createSet(`__verify blurry ${new Date().toISOString()}`);
  let cleanUp = !keep;

  try {
    const { pagesRead, unreadablePages } = await addDocumentToSet({
      setId: set.id,
      apiKey,
      title: file.name,
      source: { kind: 'image', file: file.blob, mime: file.mime, filename: file.name },
    });

    // The number the whole criterion turns on. Printed either way — a passing
    // run with every page at 0.59 is a very different result from one at 0.05,
    // and the report should not hide which one happened.
    const pages = await pagesForSet(set.id);
    const scores = pages.map((p) => p.readability);
    info(
      'readability per page',
      scores.length > 0 ? scores.map((s) => s.toFixed(2)).join(', ') : '(no pages)',
      );
    info('threshold', `pages below ${MIN_READABILITY} are treated as unreadable`);

    const readable = pages.filter((p) => p.readability >= MIN_READABILITY);
    if (readable.length > 0) {
      fail(
        'every page scores below the readability threshold',
        `${readable.length} of ${pages.length} page(s) scored >= ${MIN_READABILITY} ` +
          `(${readable.map((p) => `p${p.page_index}=${p.readability.toFixed(2)}`).join(', ')})`,
      );
    } else {
      ok('every page scores below the readability threshold', `${pages.length} page(s)`);
    }

    if (unreadablePages.length === pagesRead && pagesRead > 0) {
      ok('all pages recorded as unreadable', `${unreadablePages.length}/${pagesRead}`);
    } else {
      fail(
        'all pages recorded as unreadable',
        `${unreadablePages.length} flagged of ${pagesRead} read`,
      );
    }

    const plan = await planSet(set.id, REQUESTED);
    if (plan.sections.length === 0) {
      ok('planner produced no sections', 'nothing to generate from');
    } else {
      fail('planner produced no sections', `${plan.sections.length} section(s) planned`);
    }

    if (plan.unreadablePages.length > 0) {
      ok(
        'unreadable pages recorded on the plan',
        `pages ${plan.unreadablePages.map((p) => p + 1).join(', ')} — this is what the ` +
          'set screen renders its notice from',
      );
    } else {
      fail('unreadable pages recorded on the plan', 'none recorded, so no notice would show');
    }

    const result = await generateSet({ setId: set.id, apiKey });
    const stored = await countItems(set.id);

    if (result.itemsCreated === 0 && stored === 0) {
      ok('no cards were made', 'confirmed from the database, not just the return value');
    } else {
      fail('no cards were made', `${result.itemsCreated} created, ${stored} stored`);

      // The diagnostic that makes a failure actionable rather than just bad news.
      const items = await listItems(set.id);
      console.log('\n  Cards that should not exist:');
      for (const item of items) {
        console.log(`    Q: ${item.prompt}`);
        console.log(`    A: ${item.answer}`);
        console.log(`       source: "${item.source_excerpt}"`);
      }
      reportCanaries(items.map((i) => `${i.prompt} ${i.answer} ${i.source_excerpt}`).join(' ').toLowerCase());
    }

    const finalSet = await getSet(set.id);
    if (finalSet?.status === 'ready') {
      ok('set finished', "status 'ready' — the screen shows the notice, it does not spin");
    } else {
      fail('set finished', `status is '${finalSet?.status ?? 'missing'}', not 'ready'`);
    }

    console.log(
      "\n  The notice wording lives in app/set/[id]/index.tsx (\"We couldn't read page N…\").\n" +
        '  This script asserts the DATA behind it; confirming it renders is the manual\n' +
        '  check in the live app.',
    );
  } catch (err) {
    fail('blurry run', err instanceof Error ? err.message : String(err));
    cleanUp = false; // leave the set for inspection when something broke
  } finally {
    if (cleanUp) {
      await deleteSet(set.id).catch(() => undefined);
    } else {
      console.log(`\n  Set kept: ${set.id}`);
    }
  }
}

// ----------------------------------------------------------- check B: PDF ----

interface TimedProgress {
  atMs: number;
  progress: Progress;
}

async function checkPdf(path: string, apiKey: string, keep: boolean): Promise<void> {
  console.log('\n=== B. 10-page text PDF must yield cards in under 2 minutes ===\n');

  const file = loadFile(path);
  if (file.mime !== 'application/pdf') {
    fail('pdf input', `expected a PDF, got ${file.mime}`);
    return;
  }
  info('input', `${file.name} (${Math.round(file.bytes / 1024)} KB)`);

  const set = await createSet(`__verify pdf ${new Date().toISOString()}`);
  let cleanUp = !keep;

  try {
    // Timed here rather than inside the pipeline: addDocumentToSet does not
    // report its own duration, and instrumenting production code to make a
    // measurement easier is the wrong trade.
    const readStart = Date.now();
    const { pagesRead } = await addDocumentToSet({
      setId: set.id,
      apiKey,
      title: file.name,
      source: { kind: 'pdf', file: file.blob, mime: file.mime, filename: file.name },
    });
    const readMs = Date.now() - readStart;

    if (pagesRead === EXPECTED_PDF_PAGES) {
      ok('read 10 pages', `${pagesRead} pages in ${seconds(readMs)}`);
    } else {
      fail(
        'read 10 pages',
        `${pagesRead} pages read, expected ${EXPECTED_PDF_PAGES} — the criterion is ` +
          'stated for a 10-page PDF, so the timing below is not comparable',
      );
    }

    // The free control for check A: these pages MUST score at or above the
    // threshold, which is what proves the readability score discriminates
    // rather than rating everything low.
    const pages = await pagesForSet(set.id);
    const lowest = pages.reduce((min, p) => Math.min(min, p.readability), 1);
    if (pages.length > 0 && lowest >= MIN_READABILITY) {
      ok(
        'readability control',
        `lowest page scored ${lowest.toFixed(2)} (>= ${MIN_READABILITY}) — the score ` +
          'discriminates, it does not rate everything low',
      );
    } else {
      fail('readability control', `lowest page scored ${lowest.toFixed(2)}`);
    }

    const planStart = Date.now();
    const plan = await planSet(set.id, REQUESTED);
    const planMs = Date.now() - planStart;
    info('plan', `${plan.sections.length} section(s) in ${seconds(planMs)}`);

    const events: TimedProgress[] = [];
    const generateStart = Date.now();
    const result = await generateSet({
      setId: set.id,
      apiKey,
      onProgress: (p) => events.push({ atMs: Date.now() - generateStart, progress: { ...p } }),
    });
    const generateWallMs = Date.now() - generateStart;
    const totalMs = readMs + planMs + generateWallMs;

    // --- the criterion ----------------------------------------------------
    if (totalMs < BUDGET_MS) {
      ok('cards in under 2 minutes', `${seconds(totalMs)} of ${seconds(BUDGET_MS)}`);
    } else {
      fail(
        'cards in under 2 minutes',
        `${seconds(totalMs)} — over budget by ${seconds(totalMs - BUDGET_MS)}`,
      );
    }

    // --- cards visible before completion ----------------------------------
    // Asserted in its own right, not inferred from the total: spec §6 names
    // this as the criterion to protect if the two ever conflict.
    const firstCard = events.findIndex(
      (e) => e.progress.phase === 'generating' && (e.progress.itemsSoFar ?? 0) > 0,
    );
    const finished = events.findIndex(
      (e) => e.progress.phase === 'done' || e.progress.phase === 'failed',
    );
    if (firstCard >= 0 && (finished < 0 || firstCard < finished)) {
      ok(
        'cards visible before completion',
        `first card at ${seconds(events[firstCard]!.atMs)} into generation`,
      );
    } else {
      fail(
        'cards visible before completion',
        firstCard < 0
          ? 'no progress event reported a card before the run ended'
          : 'the first card arrived only with the final event',
      );
    }

    // --- the other Phase 2 criteria, free from this run -------------------
    if (result.itemsCreated <= REQUESTED) {
      ok('item count within the requested cap', `${result.itemsCreated} <= ${REQUESTED}`);
    } else {
      fail('item count within the requested cap', `${result.itemsCreated} > ${REQUESTED}`);
    }

    const items = await listItems(set.id);
    const unverified = items.filter((i) => !i.excerpt_verified);
    if (items.length > 0 && unverified.length === 0) {
      ok('every stored item has excerpt_verified = true', `${items.length} item(s)`);
    } else if (items.length === 0) {
      fail('every stored item has excerpt_verified = true', 'no items were stored at all');
    } else {
      fail('every stored item has excerpt_verified = true', `${unverified.length} without it`);
    }

    // --- bottleneck attribution (spec §6) ---------------------------------
    const calls = result.timing.calls;
    const meanCallMs = calls > 0 ? result.timing.generateMs / calls : 0;
    const startSpanMs = result.timing.queueWaitMs;
    const pacingFloorMs = Math.max(0, (calls - 1) * MIN_GAP_MS);

    console.log('\n  Where the time went:');
    console.log(`    read (1 call, whole PDF)      ${seconds(readMs)}`);
    console.log(`    plan (deterministic, no call) ${seconds(planMs)}`);
    console.log(`    generate (wall clock)         ${seconds(generateWallMs)}`);
    console.log(`    TOTAL                         ${seconds(totalMs)} of ${seconds(BUDGET_MS)}`);
    console.log('');
    console.log(`    generate calls                ${calls} (one per section)`);
    console.log(`    mean latency per call         ${seconds(meanCallMs)}`);
    console.log(`    first-to-last call start      ${seconds(startSpanMs)}`);
    console.log(`    pacing floor at ${MIN_GAP_MS / 1000}s gap       ${seconds(pacingFloorMs)}`);
    console.log(
      `    (sum of call latencies        ${seconds(result.timing.generateMs)} — a SUM over ` +
        'concurrent calls,\n     so it can exceed wall clock and is NOT a duration)',
    );

    // Every call start is spaced by at least MIN_GAP_MS, so the span between
    // the first and last start can never be below the floor. How far ABOVE it
    // sits is the discriminator: at the floor, the gap is what holds things up;
    // well above it, calls are queueing behind slower ones.
    const overFloor = startSpanMs - pacingFloorMs;
    const verdict =
      calls < 2
        ? 'only one call — nothing to pace, read latency dominates'
        : overFloor <= pacingFloorMs * 0.1
          ? `the enforced ${MIN_GAP_MS / 1000}s gap is the binding constraint ` +
            `(starts sat ${seconds(overFloor)} above the floor)`
          : `model latency is the binding constraint — starts ran ${seconds(overFloor)} ` +
            'beyond the pacing floor, i.e. calls waited for a concurrency slot';
    console.log(`\n  Bottleneck: ${verdict}`);

    if (totalMs >= BUDGET_MS) {
      console.log(
        '\n  Spec §6: missing this number is a reportable measurement, NOT a licence to\n' +
          '  raise concurrency, weaken validation or drop rate limiting. Reported above;\n' +
          '  the decision is the owner\'s.',
      );
    }
  } catch (err) {
    fail('pdf run', err instanceof Error ? err.message : String(err));
    cleanUp = false;
  } finally {
    if (cleanUp) {
      await deleteSet(set.id).catch(() => undefined);
    } else {
      console.log(`\n  Set kept: ${set.id}`);
    }
  }
}

// -------------------------------------------------------------------- main ----

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  return value !== undefined && !value.startsWith('--') ? value : null;
}

async function main() {
  const blurryPath = argValue('--blurry');
  const pdfPath = argValue('--pdf');
  const keep = process.argv.includes('--keep');

  if (!blurryPath && !pdfPath) {
    console.error(
      'Nothing to verify. Pass --blurry <image> and/or --pdf <file>.\n\n' +
        '  npx tsx --env-file=.env scripts/verify-phase2.ts \\\n' +
        '    --blurry "C:\\path\\blurry.jpg" --pdf "C:\\path\\notes.pdf"\n',
    );
    process.exit(2);
  }

  // GEMINI_API_KEY matches tests/gemini-live.test.ts; GK is the owner's inline
  // shorthand. The app itself never reads a key from the environment — a user's
  // key lives in profiles.gemini_api_key under RLS (D12). This is harness input.
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GK ?? '';
  if (!apiKey) {
    console.error('Set GEMINI_API_KEY (or GK) to a working Gemini key.');
    process.exit(2);
  }

  const email = process.env.TEST_USER_A_EMAIL;
  const password = process.env.TEST_USER_A_PASSWORD;
  if (!email || !password) {
    console.error(
      'Set TEST_USER_A_EMAIL and TEST_USER_A_PASSWORD.\n' +
        'The app is OTP-only, so a script cannot sign in as the owner — use the\n' +
        'disposable isolation-test user instead.',
    );
    process.exit(2);
  }

  console.log('Phase 2 acceptance verification (spec §6)\n');

  // Signing in on the SHARED singleton from src/data/supabase.ts is what lets
  // every src/data/** function below run under this session.
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.user) {
    console.error(`Could not sign in: ${error?.message ?? 'no user returned'}`);
    process.exit(2);
  }
  console.log(`  signed in as ${email} (${data.user.id})`);

  if (blurryPath) await checkBlurry(blurryPath, apiKey, keep);
  if (pdfPath) await checkPdf(pdfPath, apiKey, keep);

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.error(
      `${failures} ACCEPTANCE FAILURE(S). Report the numbers above — do not tune ` +
        'thresholds to make them pass.',
    );
    process.exit(1);
  }
  console.log('Both Phase 2 criteria hold.');
}

main().catch((err) => {
  console.error('\nVerification could not run:', err instanceof Error ? err.message : err);
  process.exit(2);
});
