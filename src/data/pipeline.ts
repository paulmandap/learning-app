import { GeminiBrowserProvider } from '../ai/gemini';
import { renderPagesForPrompt } from '../ai/prompts';
import { CallQueue, GeminiBusyError } from '../core/queue';
import { buildPlan, MIN_READABILITY, type PageInput } from '../core/planner';
import { summariseDrops, validateItems, type DroppedItem } from '../core/validate';
import {
  createDocument,
  markDocumentFailed,
  pagesForSet,
  storeReadResult,
  uploadOriginal,
  type DocumentKind,
} from './documents';
import { countItems, existingPrompts, insertItems } from './items';
import { verifyRubrics } from './rubrics';
import { getSet, markSectionComplete, updateSet, type StoredPlan } from './sets';

/**
 * Orchestration: Read → Plan → Generate → Validate → store.
 *
 * Two properties matter more than speed here:
 *
 *  - **Resumable.** The plan lives on the set and each section is marked done
 *    as it lands, so a refresh mid-generation picks up where it stopped.
 *  - **Incremental.** Items are inserted per section, so cards appear while
 *    the rest is still being written.
 *
 * The 2-minute target for a 10-page PDF is a measured goal, not a licence to
 * raise concurrency or skip validation. Pacing stays at concurrency 2 with a
 * ~7s gap; if the target is missed, the numbers below say exactly why.
 */

export interface Progress {
  phase: 'reading' | 'planning' | 'generating' | 'done' | 'failed';
  /** Pages read so far, for "Reading your notes… (42 pages)". */
  pagesRead?: number;
  sectionsDone?: number;
  sectionsTotal?: number;
  itemsSoFar?: number;
  message?: string;
}

export interface TimingReport {
  totalMs: number;
  readMs: number;
  generateMs: number;
  /**
   * Database time spent INSIDE the queue slot — inserting a section's items and
   * marking it complete.
   *
   * Measured because it is not obviously part of the picture and turned out to
   * dominate: CallQueue holds its concurrency slot for the whole task, not just
   * the model call, so these writes are paced by a rate limiter meant for
   * Gemini. Like generateMs this is a SUM over concurrent sections, not a
   * duration.
   */
  dbMs: number;
  /** Time spent waiting on the rate limiter rather than on Gemini. */
  queueWaitMs: number;
  sections: number;
  calls: number;
}

export type ProgressFn = (p: Progress) => void;

/** Pasted text: no file, no upload, no model call to read it. */
export interface PasteSource {
  text: string;
}

/** An uploaded PDF or image. `kind` excludes 'text' so the union discriminates. */
export interface FileSource {
  kind: Exclude<DocumentKind, 'text'>;
  file: Blob;
  mime: string;
  filename: string;
}

/** Drops are logged here for diagnosis — never surfaced as "verified". */
export interface RunResult {
  itemsCreated: number;
  dropped: DroppedItem[];
  unreadablePages: number[];
  timing: TimingReport;
}

/**
 * Read one document into the set. Pasted text costs no model call.
 */
export async function addDocumentToSet(input: {
  setId: string;
  apiKey: string;
  title: string;
  // Discriminated on the PRESENCE of `text` rather than on `kind`: DocumentKind
  // already contains 'text', so `kind === 'text'` narrows nothing and the file
  // branch would still be typed as possibly-text.
  source: PasteSource | FileSource;
  onProgress?: ProgressFn;
}): Promise<{ documentId: string; pagesRead: number; unreadablePages: number[] }> {
  const { setId, apiKey, title, source, onProgress } = input;
  const provider = new GeminiBrowserProvider(apiKey);

  const isPaste = 'text' in source;
  const kind: DocumentKind = isPaste ? 'text' : source.kind;
  const doc = await createDocument({ studySetId: setId, kind, title });

  try {
    onProgress?.({ phase: 'reading', message: 'Reading your notes…' });

    if (!isPaste) {
      await uploadOriginal(doc.id, source.file, source.filename);
    }

    // Pasted text costs no model call, so it needs no pacing or retry.
    //
    // A FILE read goes through the queue, and must: it is a single Gemini call
    // that the whole document depends on, and Gemini answers it with 503
    // UNAVAILABLE ("high demand") often enough to matter — observed live on a
    // 10-page PDF, where the very next attempt after a 10s backoff returned 200.
    // Generation has always been retried this way; the read was not, so one
    // transient 503 destroyed the entire document read and surfaced the internal
    // string "rate limited" to the user. After MAX_ATTEMPTS the queue throws
    // GeminiBusyError, whose message is the friendly one §3.2.6 asks for.
    const read = isPaste
      ? await provider.readDocument({ text: source.text })
      : await new CallQueue().run(() =>
          provider.readDocument({ file: source.file, mime: source.mime }),
        );

    const { pageCount, unreadablePages } = await storeReadResult(
      doc.id,
      read,
      MIN_READABILITY,
    );

    onProgress?.({ phase: 'reading', pagesRead: pageCount });
    return { documentId: doc.id, pagesRead: pageCount, unreadablePages };
  } catch (err) {
    await markDocumentFailed(doc.id);
    throw err;
  }
}

/** Build and persist the plan for everything currently in the set. */
export async function planSet(setId: string, requestedCount: number): Promise<StoredPlan> {
  const pages = await pagesForSet(setId);

  const pageInputs: PageInput[] = pages.map((p) => ({
    page_index: p.page_index,
    text: p.text,
    readability: p.readability,
    headings: p.headings,
  }));

  const plan = buildPlan(pageInputs, requestedCount);
  const stored: StoredPlan = {
    ...plan,
    completedSectionIds: [],
    requestedCount,
  };

  await updateSet(setId, { plan: stored, status: 'generating' });
  return stored;
}

/**
 * Extend an existing set's plan to cover ONE newly added document.
 *
 * Phase 4 acceptance criterion: "adding a document to an existing set generates
 * only for the new document." That is achieved by planning over the new
 * document's pages alone and appending those sections, while every section
 * already generated stays in `completedSectionIds` — so the resume logic skips
 * them exactly as it would after a refresh. Nothing is regenerated, and no
 * existing card is touched.
 */
export async function extendPlanForDocument(input: {
  setId: string;
  documentId: string;
  requestedCount: number;
}): Promise<StoredPlan> {
  const { setId, documentId, requestedCount } = input;

  const set = await getSet(setId);
  const existing = set?.plan ?? null;

  const allPages = await pagesForSet(setId);
  const newPages = allPages.filter((p) => p.document_id === documentId);

  const pageInputs: PageInput[] = newPages.map((p) => ({
    page_index: p.page_index,
    text: p.text,
    readability: p.readability,
    headings: p.headings,
  }));

  const addition = buildPlan(pageInputs, requestedCount);

  // Section ids are derived from page index, so a second document could collide
  // with the first document's ids. Namespacing by document keeps "already done"
  // meaningful — without this, a new section could be skipped as complete.
  const namespaced = addition.sections.map((s) => ({
    ...s,
    id: `${documentId.slice(0, 8)}:${s.id}`,
  }));

  const merged: StoredPlan = {
    ...(existing ?? addition),
    sections: [...(existing?.sections ?? []), ...namespaced],
    unreadablePages: [
      ...new Set([...(existing?.unreadablePages ?? []), ...addition.unreadablePages]),
    ].sort((a, b) => a - b),
    totalWords: (existing?.totalWords ?? 0) + addition.totalWords,
    supported: (existing?.supported ?? 0) + addition.supported,
    requested: requestedCount,
    maxTotal: (existing?.maxTotal ?? 0) + addition.maxTotal,
    // Everything previously generated stays marked done, so only the new
    // sections run.
    completedSectionIds: existing?.completedSectionIds ?? [],
    requestedCount: (existing?.requestedCount ?? 0) + requestedCount,
  };

  await updateSet(setId, { plan: merged, status: 'generating' });
  return merged;
}

/**
 * Generate items for every section not already done.
 *
 * Safe to call repeatedly: completed sections are skipped, which is exactly
 * what makes a refresh resume rather than restart.
 */
export async function generateSet(input: {
  setId: string;
  apiKey: string;
  onProgress?: ProgressFn;
}): Promise<RunResult> {
  const { setId, apiKey, onProgress } = input;
  const startedAt = Date.now();

  const set = await getSet(setId);
  if (!set?.plan) throw new Error('This set has no plan yet.');

  const plan = set.plan;
  const pages = await pagesForSet(setId);
  const pageText = new Map(pages.map((p) => [p.page_index, p.text]));
  const documentIdByPage = new Map(pages.map((p) => [p.page_index, p.document_id]));

  const done = new Set(plan.completedSectionIds ?? []);
  const pending = plan.sections.filter((s) => !done.has(s.id));

  const provider = new GeminiBrowserProvider(apiKey);
  const queue = new CallQueue();

  const dropped: DroppedItem[] = [];
  let itemsCreated = 0;
  let generateMs = 0;
  let dbMs = 0;
  let calls = 0;

  onProgress?.({
    phase: 'generating',
    sectionsDone: done.size,
    sectionsTotal: plan.sections.length,
    itemsSoFar: 0,
  });

  // Sections run THROUGH THE QUEUE, concurrently.
  //
  // This used to be a sequential `for` loop that awaited the Gemini call and
  // four database round-trips before starting the next section, so the queue's
  // concurrency of 2 was never exercised — only one call was ever in flight.
  // On a multi-section document that was most of the wall-clock time.
  //
  // Each section still settles independently: one failing does not cancel the
  // others, and completed sections are recorded as they land so a refresh
  // resumes rather than restarting.
  //
  // Prompts already stored are read ONCE up front rather than per section. The
  // per-section re-read was a serialising database round-trip; dedup within
  // this run is handled by the shared accumulator below.
  const priorPrompts = await existingPrompts(setId);
  const seenPrompts: string[] = [...priorPrompts];
  let failure: 'busy' | 'error' | null = null;

  const results = await Promise.allSettled(
    pending.map((section) =>
      queue.run(async () => {
        const sectionPages = section.pages
          .map((idx) => ({ page_index: idx, text: pageText.get(idx) ?? '' }))
          .filter((p) => p.text.length > 0);

        if (sectionPages.length === 0) {
          await markSectionComplete(setId, section.id);
          return;
        }

        const callStart = Date.now();
        const generated = await provider.generateItems({
          sectionText: renderPagesForPrompt(sectionPages),
          sectionTitle: section.title,
          budget: section.budget,
          pageRange: {
            from: section.pages[0] ?? 0,
            to: section.pages[section.pages.length - 1] ?? 0,
          },
        });
        generateMs += Date.now() - callStart;
        calls++;

        // Snapshot the shared prompt list, then append what this section kept.
        // Sections finish concurrently, so dedup has to see siblings that have
        // already landed — otherwise two sections can write the same card.
        const { kept, dropped: sectionDropped } = validateItems(
          generated,
          pageText,
          section.budget,
          seenPrompts,
        );
        for (const k of kept) seenPrompts.push(k.prompt);
        dropped.push(...sectionDropped);

        const dbStart = Date.now();
        const inserted = await insertItems(setId, documentIdByPage, section.title, kept);
        itemsCreated += inserted;

        await markSectionComplete(setId, section.id);
        dbMs += Date.now() - dbStart;
        done.add(section.id);

        // Reported as each section lands, so cards appear while the rest run.
        onProgress?.({
          phase: 'generating',
          sectionsDone: done.size,
          sectionsTotal: plan.sections.length,
          itemsSoFar: itemsCreated,
        });
      }),
    ),
  );

  for (const r of results) {
    if (r.status !== 'rejected') continue;
    failure = r.reason instanceof GeminiBusyError ? 'busy' : failure ?? 'error';
  }

  if (failure === 'busy') {
    onProgress?.({ phase: 'failed', message: new GeminiBusyError().message });
  } else if (failure === 'error') {
    onProgress?.({
      phase: 'failed',
      message: 'Something went wrong making cards. Your finished cards are saved.',
    });
  }

  // ------------------------------------------------- replace what we dropped --
  //
  // A card discarded by our own validators is not the notes falling short, and
  // the user should not pay for it. Asking for 10 and receiving 9 because one
  // citation would not resolve is our problem, so one extra pass asks for the
  // difference.
  //
  // Bounded three ways, so this cannot become the padding D3 warned about:
  //  - only up to the number we DROPPED. If the model deliberately wrote fewer
  //    because the text did not support more (prompt rule 6), that is respected
  //    and not topped up.
  //  - one pass, never a loop.
  //  - the replacements go through exactly the same validators, so a bad
  //    replacement is dropped like any other card.
  const allSectionsDone = plan.sections.every((s) => done.has(s.id));
  if (allSectionsDone && dropped.length > 0 && failure === null) {
    const stored = await countItems(setId);
    const replaceable = Math.min(plan.requestedCount - stored, dropped.length);

    // Generate from the section with the most words: the best chance of finding
    // something genuinely new rather than a near-duplicate.
    const richest = [...plan.sections].sort((a, b) => b.words - a.words)[0];

    if (replaceable > 0 && richest) {
      try {
        const sectionPages = richest.pages
          .map((idx) => ({ page_index: idx, text: pageText.get(idx) ?? '' }))
          .filter((p) => p.text.length > 0);

        if (sectionPages.length > 0) {
          const callStart = Date.now();
          const extra = await queue.run(() =>
            provider.generateItems({
              sectionText: renderPagesForPrompt(sectionPages),
              sectionTitle: richest.title,
              // Ask at every level and take the best `replaceable` of what
              // comes back, rather than dictating which level the replacement
              // must be — the notes decide that better than we can.
              budget: { remember: replaceable, understand: replaceable, apply: replaceable },
              pageRange: {
                from: richest.pages[0] ?? 0,
                to: richest.pages[richest.pages.length - 1] ?? 0,
              },
            }),
          );
          generateMs += Date.now() - callStart;
          calls++;

          // seenPrompts already holds every prompt kept this run and everything
          // stored before it, so a replacement cannot repeat an existing card.
          // The budget allows `replaceable` at EVERY level, and the result is
          // then sliced to that many. allocateTiers(1) would have permitted one
          // "remember" item and nothing else, so a replacement written at any
          // other level was discarded as over_budget — replacing a dropped card
          // with a second dropped card. A replacement is welcome at whatever
          // level the notes support.
          const generous = { remember: replaceable, understand: replaceable, apply: replaceable };
          const { kept, dropped: extraDropped } = validateItems(
            extra,
            pageText,
            generous,
            seenPrompts,
          );
          dropped.push(...extraDropped);
          const take = kept.slice(0, replaceable);
          itemsCreated += await insertItems(setId, documentIdByPage, richest.title, take);
          console.warn(
            `[pipeline] replaced ${take.length} of ${replaceable} dropped card(s)` +
              `${extraDropped.length ? `; ${extraDropped.length} replacement(s) also dropped` : ''}`,
          );
        }
      } catch (err) {
        // Best effort: the set is already complete and usable, so a failed
        // top-up must not turn a finished run into a failed one. But it is
        // logged rather than swallowed — a silently failing top-up is
        // indistinguishable from one that never ran, and that ambiguity has
        // already cost one wrong conclusion in this codebase.
        console.warn(
          `[pipeline] top-up failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const allDone = allSectionsDone;
  // Persist WHY cards were left out. Without this the reasons are collected and
  // then thrown away, leaving "19 of 20" unexplainable.
  await updateSet(setId, {
    status: allDone ? 'ready' : 'generating',
    plan: { ...plan, completedSectionIds: [...done], droppedSummary: summariseDrops(dropped) },
  });

  // ------------------------------------- D7's second pass over Apply rubrics --
  //
  // Deliberately AFTER the set is marked ready. Spec §6 forbids buying the
  // two-minute target by weakening the architecture, and the reverse holds too:
  // an extra call per Apply item must not be added to the path that target
  // measures. The cards are usable the moment the line above commits; this
  // catches up behind them, and a card studied before it lands simply has no
  // verdict yet, which is what rubric_verified = null means.
  //
  // Awaited rather than detached so a caller that wants to know can wait, and so
  // the run is not cut off by the page navigating away the instant cards appear.
  if (allDone && failure === null) {
    const pass = await verifyRubrics({ setId, apiKey });
    if (pass.checked > 0 || pass.failed > 0) {
      console.warn(
        `[pipeline] rubric check: ${pass.checked} checked, ${pass.flagged} flagged, ` +
          `${pass.failed} could not be checked`,
      );
    }
  }

  const totalMs = Date.now() - startedAt;
  const queueWaitMs = Math.max(
    0,
    (queue.startTimes[queue.startTimes.length - 1] ?? 0) - (queue.startTimes[0] ?? 0),
  );

  onProgress?.({
    phase: allDone ? 'done' : 'failed',
    sectionsDone: done.size,
    sectionsTotal: plan.sections.length,
    itemsSoFar: itemsCreated,
  });

  return {
    itemsCreated,
    dropped,
    unreadablePages: plan.unreadablePages,
    timing: { totalMs, readMs: 0, generateMs, dbMs, queueWaitMs, sections: plan.sections.length, calls },
  };
}
