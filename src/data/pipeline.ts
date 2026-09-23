import { GeminiBrowserProvider, GeminiCallError } from '../ai/gemini';
import { renderPagesForPrompt } from '../ai/prompts';
import { reasonToMessage } from '../core/ai-errors';
import { CallQueue, GeminiBusyError } from '../core/queue';
import {
  allocateTiers,
  buildPlan,
  MAX_ITEMS_PER_CALL,
  MIN_READABILITY,
  type PageInput,
  type PlannedSection,
  type TierBudget,
} from '../core/planner';
import {
  fillQuotas,
  flattenLines,
  inSpan,
  lineKey,
  locateExcerpt,
  planBands,
  shareOut,
  shortfallBySection,
  splitSpans,
  type Band,
  type Line,
  type SentenceRef,
  type SentenceSpan,
} from '../core/coverage';
import { normalize, splitSentences } from '../core/text';
import { summariseDrops, validateItems, type DroppedItem, type ExistingCard, type ValidatedItem } from '../core/validate';
import { numberSetPages, type SetPage, type SetPages } from '../core/set-pages';
import {
  findQaPairs,
  keptOnPages,
  keptTarget,
  locatePointed,
  looksLikeQa,
  mergeKept,
  newCards,
  pairToItem,
  type KeptPairs,
} from '../core/qa-pairs';
import {
  createDocument,
  listDocuments,
  markDocumentFailed,
  pagesForSet,
  storeReadResult,
  uploadOriginal,
  type DocumentKind,
} from './documents';
import { existingCards, insertItems, type ExistingCardRow } from './items';
import { verifyRubrics } from './rubrics';
import { addQuizChoices } from './quiz-options';
import { locatePictureLabels } from './picture-labels';
import { getSet, markSectionComplete, updateSet, type StoredPlan } from './sets';

/**
 * Orchestration: Read → Plan → Generate → Validate → store.
 *
 * Three properties matter more than speed here:
 *
 *  - **Resumable.** The plan lives on the set and each section is marked done
 *    as it lands, so a refresh mid-generation picks up where it stopped.
 *  - **Incremental.** Items are inserted per request, so cards appear while
 *    the rest is still being written.
 *  - **The count asked for is the count made** (NOTES §37). Every section is
 *    asked once; then, for as long as the set holds fewer cards than were asked
 *    for, bounded fill passes ask for what is still owed — from the parts of the
 *    notes with fewest cards, never repeating a question or an answer.
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

/**
 * The set's pages, numbered across its documents (NOTES §43).
 *
 * Every page number the card-maker plans, asks and checks with is a SET page
 * number from here, and `insertItems` writes each card back with its own
 * document and that document's page. A set with one document is numbered as it
 * always was. See `src/core/set-pages.ts` for what went wrong before.
 */
async function setPages(setId: string): Promise<SetPages> {
  const [docs, pages] = await Promise.all([listDocuments(setId), pagesForSet(setId)]);
  return numberSetPages(
    docs.map((d) => d.id),
    pages,
  );
}

function plannerPage(p: SetPage): PageInput {
  return { page_index: p.set_page, text: p.text, readability: p.readability, headings: p.headings };
}

/**
 * Most characters sent for Gemini to point at, in one document. Past this the
 * notes are made into cards the ordinary way, and it is logged: pointing means
 * the reply repeats the notes back, and a reply that long is one that gets cut
 * off halfway.
 */
export const MAX_POINT_CHARS = 20_000;

/**
 * The student's own questions and answers in these documents (NOTES §49).
 *
 * Read by the keeper, `findQaPairs`, with no model at all. Where a page still
 * looks like Q:A in a layout the keeper cannot read, Gemini is asked to point at
 * the pairs, and `locatePointed` keeps the ones really in the notes. A pointer
 * that fails costs only that: the notes are made into cards as they were before
 * any of this existed.
 */
async function findKept(pages: readonly SetPage[], documentIds: readonly string[], apiKey?: string): Promise<KeptPairs> {
  const keep: KeptPairs = { documentIds: [...documentIds], pointed: [], pairs: 0 };
  for (const documentId of documentIds) {
    const own = pages.filter((p) => p.document_id === documentId && p.readability >= MIN_READABILITY);
    const found = new Map(own.map((p) => [p.page_index, findQaPairs(p.text, p.headings)]));
    for (const pairs of found.values()) keep.pairs += pairs.length;

    const unread = own.filter((p) => looksLikeQa(p.text, found.get(p.page_index) ?? [], p.headings));
    if (!apiKey || unread.length === 0) continue;
    const chars = unread.reduce((n, p) => n + p.text.length, 0);
    if (chars > MAX_POINT_CHARS) {
      console.warn(`[pipeline] Q:A pointer skipped: ${chars} characters is more than ${MAX_POINT_CHARS}`);
      continue;
    }
    try {
      const provider = new GeminiBrowserProvider(apiKey);
      const pointed = await new CallQueue().run(() =>
        provider.pointQaPairs({ pages: unread.map((p) => ({ page_index: p.page_index, text: p.text })) }),
      );
      let kept = 0;
      for (const page of unread) {
        const located = locatePointed(
          page.text,
          pointed.filter((x) => x.page_index === page.page_index),
          found.get(page.page_index) ?? [],
        );
        keep.pointed.push(...located.map((l) => ({ documentId, pageIndex: page.page_index, span: l.span })));
        kept += located.length;
      }
      keep.pairs += kept;
      console.warn(`[pipeline] Q:A pointer: ${pointed.length} named, ${kept} found in the notes and kept`);
    } catch (err) {
      console.warn(`[pipeline] Q:A pointer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return keep;
}

/** What `planSet` and `extendPlanForDocuments` are told about keeping the student's wording. */
export interface KeepOptions {
  /** Make the student's own questions and answers into cards as written (NOTES §49). */
  keepWording?: boolean;
  /** For asking Gemini to point at pairs in a layout the keeper cannot read. */
  apiKey?: string;
}

/**
 * Build and persist the plan for everything currently in the set.
 *
 * With `keepWording`, the student's own pairs are made into cards as written,
 * all of them, and the sections plan only what the count asks for on top
 * (`keptTarget`, NOTES §49).
 */
export async function planSet(setId: string, requestedCount: number, options: KeepOptions = {}): Promise<StoredPlan> {
  const { pages } = await setPages(setId);
  const keep = options.keepWording
    ? await findKept(pages, [...new Set(pages.map((p) => p.document_id))], options.apiKey)
    : null;
  const { target, extra } = keptTarget(requestedCount, keep?.pairs ?? 0);
  const plan = buildPlan(pages.map(plannerPage), extra);
  const stored: StoredPlan = {
    ...plan,
    completedSectionIds: [],
    requestedCount: target,
    ...(keep && keep.pairs > 0 ? { keep } : {}),
  };

  await updateSet(setId, { plan: stored, status: 'generating' });
  return stored;
}

/**
 * Extend an existing set's plan to cover newly added documents — one, or a
 * note's text and each of its pictures (NOTES §43).
 *
 * Phase 4 acceptance criterion: "adding a document to an existing set generates
 * only for the new document." That is achieved by planning over the new
 * documents' pages alone and appending those sections, while every section
 * already generated stays in `completedSectionIds` — so the resume logic skips
 * them exactly as it would after a refresh. Nothing is regenerated, and no
 * existing card is touched.
 */
export async function extendPlanForDocuments(
  input: {
    setId: string;
    documentIds: string[];
    requestedCount: number;
  } & KeepOptions,
): Promise<StoredPlan> {
  const { setId, documentIds, requestedCount } = input;

  const set = await getSet(setId);
  const existing = set?.plan ?? null;

  const adding = new Set(documentIds);
  const newPages = (await setPages(setId)).pages.filter((p) => adding.has(p.document_id));

  // The student's own pairs in what is being added, and only there: a set's
  // earlier notes keep whatever was decided when they were added (NOTES §49).
  const keep = input.keepWording ? await findKept(newPages, documentIds, input.apiKey) : null;
  const { target, extra } = keptTarget(requestedCount, keep?.pairs ?? 0);
  const addition = buildPlan(newPages.map(plannerPage), extra);

  // Section ids are derived from page index. Set page numbers no longer collide
  // with an earlier document's, but a plan stored before §43 numbered every
  // document from 0 — so ids stay namespaced by document, and "already done"
  // keeps meaning what it did. Without it a new section could be skipped as
  // complete.
  const namespace = (documentIds[0] ?? 'added').slice(0, 8);
  const namespaced = addition.sections.map((s) => ({
    ...s,
    id: `${namespace}:${s.id}`,
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
    requestedCount: (existing?.requestedCount ?? 0) + target,
  };
  const kept = mergeKept(existing?.keep, keep);
  if (kept) merged.keep = kept;

  await updateSet(setId, { plan: merged, status: 'generating' });
  return merged;
}

/**
 * Rounds of asking for what is still owed, once every section has been asked.
 *
 * Three, and bounded so a run always ends. The first two hold each request to
 * the thinnest parts of the notes; the last lets a card come from anywhere in
 * the section, and a round that adds nothing ends the run early. Notes that
 * genuinely cannot hold N different cards — a few sentences asked for sixty —
 * stop there rather than loop, and the set is finished with what exists.
 */
export const MAX_FILL_PASSES = 3;

type Failure = { kind: 'busy' | 'error'; message: string } | null;

const GENERIC_FAILURE = 'Something went wrong making cards. Your finished cards are saved.';

/**
 * The worst thing that went wrong in a round of requests, logged either way.
 *
 * Busy wins, because it is the one that says "wait and retry". A refusal Google
 * explains (an invalid key) is said plainly rather than as "something went
 * wrong" — the same lesson as NOTES §36, where an invalid key read as an outage.
 */
function failureOf(results: PromiseSettledResult<unknown>[], current: Failure): Failure {
  let out = current;
  for (const r of results) {
    if (r.status !== 'rejected') continue;
    const err: unknown = r.reason;
    console.warn(`[pipeline] a request failed: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof GeminiBusyError) {
      out = { kind: 'busy', message: err.message };
    } else if (out === null) {
      out = {
        kind: 'error',
        message: err instanceof GeminiCallError ? reasonToMessage(err.reason) : GENERIC_FAILURE,
      };
    }
  }
  return out;
}

/**
 * Generate items until the set holds the number asked for.
 *
 * Safe to call repeatedly: completed sections are skipped and the fill passes
 * count what is already stored, which is exactly what makes a refresh resume
 * rather than restart.
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
  // Keyed by SET page (NOTES §43). Keyed by each document's own page number, a
  // note's text and its pictures all had a page 0, and every card was checked
  // against — and filed under — whichever of them came last.
  const numbered = await setPages(setId);
  const pageText = new Map(numbered.pages.map((p) => [p.set_page, p.text]));

  // The student's own questions and answers, where the plan keeps them (NOTES
  // §49): the pages they are on, and every line they cover — lines the
  // card-writer is kept off, so what Nomi writes comes from the rest.
  const kept = plan.keep ? keptOnPages(numbered.pages, plan.keep, MIN_READABILITY) : null;

  const done = new Set(plan.completedSectionIds ?? []);
  const pending = plan.sections.filter((s) => !done.has(s.id));

  const provider = new GeminiBrowserProvider(apiKey);
  const queue = new CallQueue();

  const dropped: DroppedItem[] = [];
  let itemsCreated = 0;
  let generateMs = 0;
  let dbMs = 0;
  let calls = 0;

  // Sections only: `done` also holds the kept pairs' own marks (`verbatim:…`).
  const sectionsDone = () => plan.sections.filter((s) => done.has(s.id)).length;
  const report = () =>
    onProgress?.({
      phase: 'generating',
      sectionsDone: sectionsDone(),
      sectionsTotal: plan.sections.length,
      itemsSoFar: itemsCreated,
    });
  report();

  // Every card already in the set, read ONCE up front and then extended as
  // requests land. Sections run concurrently, so dedup has to see siblings
  // that have already landed — otherwise two sections can write the same card.
  const seen: ExistingCard[] = (await existingCards(setId)).map(({ prompt, answer, source_excerpt }) => ({
    prompt,
    answer,
    excerpt: source_excerpt,
  }));
  let failure: Failure = null;

  const pagesOf = (section: PlannedSection) =>
    section.pages
      .map((idx) => ({ page_index: idx, text: pageText.get(idx) ?? '' }))
      .filter((p) => p.text.length > 0);

  /** Ask the model once, validate what comes back, store what survives. */
  const ask = async (
    section: PlannedSection,
    request: {
      budget: TierBudget;
      bands: Band[];
      maxTotal: number;
      /** A fill pass: any level, this part of the notes, and — while strict — only these lines. */
      fill?: { span: SentenceSpan; angles: boolean; onlyLines?: Line[] };
      /** Only these lines, outside a fill pass: the ones that are not the student's own pairs (NOTES §49). */
      only?: Line[];
    },
  ): Promise<number> => {
    const bands = request.bands.filter((b) => b.quota > 0);
    const onlyLines = request.fill?.onlyLines ?? request.only;
    const callStart = Date.now();
    const generated = await provider.generateItems({
      sectionText: renderPagesForPrompt(pagesOf(section), request.fill?.span ?? section.span),
      sectionTitle: section.title,
      budget: request.budget,
      pageRange: {
        from: section.pages[0] ?? 0,
        to: section.pages[section.pages.length - 1] ?? 0,
      },
      bands,
      avoid: seen.length > 0 ? [...seen] : undefined,
      flexibleLevels: request.fill !== undefined,
      angles: request.fill?.angles,
      onlyLines,
    });
    generateMs += Date.now() - callStart;
    calls++;

    // A fill pass takes a card at whatever level the notes give it; what is
    // owed is the total. The same validators run either way.
    const n = request.maxTotal;
    const caps: TierBudget = request.fill ? { remember: n, understand: n, apply: n } : request.budget;
    const { kept, dropped: lost } = validateItems(generated, pageText, caps, seen, {
      bands,
      maxTotal: n,
      lines: onlyLines ? new Set(onlyLines.map(lineKey)) : undefined,
    });
    for (const k of kept) seen.push({ prompt: k.prompt, answer: k.answer, excerpt: k.source_excerpt });
    dropped.push(...lost);

    const dbStart = Date.now();
    const inserted = await insertItems(setId, numbered.locate, section.title, kept);
    dbMs += Date.now() - dbStart;
    itemsCreated += inserted;
    return inserted;
  };

  // ------------------------------------------ the student's own, as written --
  //
  // NOTES §49. No model: each pair IS the card, read out of the notes by
  // `findQaPairs` (or pointed at by Gemini when the plan was made, and found in
  // the notes). First, because they are instant and the student's own, and
  // before the card-writer, whose avoid-list then carries them. Marked done per
  // document, and never inserted twice either way — `newCards` drops a pair
  // already in the set, so a run cut off between the two still resumes cleanly.
  const keptRun = await Promise.allSettled([
    (async () => {
      if (!plan.keep || !kept) return;
      const titleOf = (setPage: number): string => {
        const page = numbered.pages.find((p) => p.set_page === setPage);
        return plan.sections.find((s) => s.pages.includes(setPage))?.title ?? page?.headings[0] ?? 'Your notes';
      };
      for (const documentId of plan.keep.documentIds) {
        const mark = `verbatim:${documentId}`;
        if (done.has(mark)) continue;
        const items = numbered.pages
          .filter((p) => p.document_id === documentId)
          .flatMap((p) => (kept.byPage.get(p.set_page) ?? []).map((pair) => pairToItem(p.text, p.set_page, pair)))
          .filter((item): item is ValidatedItem => item !== null);
        const fresh = newCards(items, seen);

        // Filed under the section the plan gives their page, like every other card.
        const byTitle = new Map<string, ValidatedItem[]>();
        for (const item of fresh) {
          const title = titleOf(item.page_index);
          byTitle.set(title, [...(byTitle.get(title) ?? []), item]);
        }
        const dbStart = Date.now();
        for (const [title, group] of byTitle) {
          itemsCreated += await insertItems(setId, numbered.locate, title, group);
          for (const k of group) seen.push({ prompt: k.prompt, answer: k.answer, excerpt: k.source_excerpt });
        }
        await markSectionComplete(setId, mark);
        dbMs += Date.now() - dbStart;
        done.add(mark);
        console.warn(`[pipeline] kept as written: ${fresh.length} of ${items.length} pair(s) in one document`);
        report();
      }
    })(),
  ]);
  failure = failureOf(keptRun, failure);

  // ------------------------------------------------------ every section once --
  //
  // Sections run THROUGH THE QUEUE, concurrently. This used to be a sequential
  // `for` loop, so the queue's concurrency of 2 was never exercised. Each
  // section still settles independently: one failing does not cancel the
  // others, and completed sections are recorded as they land so a refresh
  // resumes rather than restarting.
  const results = await Promise.allSettled(
    pending.map((section) =>
      queue.run(async () => {
        const all = flattenLines(pagesOf(section), section.span);
        // Never the student's own pairs: those are cards already, as written.
        const lines = kept ? all.filter((line) => !kept.lines.has(lineKey(line))) : all;
        if (lines.length > 0) {
          await ask(section, {
            budget: section.budget,
            bands: planBands(lines, section.total),
            maxTotal: section.total,
            ...(lines.length < all.length ? { only: lines } : {}),
          });
        }
        const dbStart = Date.now();
        await markSectionComplete(setId, section.id);
        dbMs += Date.now() - dbStart;
        done.add(section.id);
        report();
      }),
    ),
  );
  failure = failureOf(results, failure);

  // ------------------------------------------------- until the count is met --
  //
  // This replaced a single "top-up" that asked again only for cards OUR checks
  // had dropped, on the grounds that a model writing fewer meant the notes held
  // fewer. On the owner's song the model wrote 2 of 10 and nothing was dropped,
  // so nothing was asked again; at 60 the one top-up wrote near-copies of cards
  // already kept (NOTES §37). The owner's decision is that the count asked for
  // is the count made. So: count what is stored, ask for the difference from the
  // parts of the notes with fewest cards, and repeat — within MAX_FILL_PASSES.
  const allSectionsDone = plan.sections.every((s) => done.has(s.id));
  if (allSectionsDone && failure === null) {
    const citedLine = (card: ExistingCardRow): SentenceRef | null => {
      // A stored card holds its own document's page; the plan speaks in set pages.
      const page = numbered.setPageOf(card.document_id, card.page_index);
      if (page === null) return null;
      const text = pageText.get(page);
      const sentence = text === undefined ? -1 : locateExcerpt(text, card.source_excerpt);
      return sentence < 0 ? null : { page, sentence };
    };
    const inSection = (section: PlannedSection, ref: SentenceRef) =>
      section.pages.includes(ref.page) && (!section.span || inSpan(ref, section.span));

    let relaxed = false;
    for (let pass = 1; pass <= MAX_FILL_PASSES; pass++) {
      const cards = (await existingCards(setId)).filter((c) => !c.hidden);
      const short = plan.requestedCount - cards.length;
      if (short <= 0) break;

      const cited = cards.map(citedLine).filter((ref): ref is SentenceRef => ref !== null);
      // Lines that already have a card, by their TEXT: a chorus line with a card
      // has one everywhere it repeats.
      const usedText = new Set(
        cited.map((ref) => normalize(splitSentences(pageText.get(ref.page) ?? '')[ref.sentence] ?? '')),
      );
      // Every line of the student's own pairs has its card: the question AND
      // the answer, where a citation only names the line it starts on (§49).
      for (const text of kept?.texts ?? []) usedText.add(text);
      const have = new Map(plan.sections.map((s) => [s.id, cited.filter((ref) => inSection(s, ref)).length]));
      const owed = shortfallBySection(plan.sections, have, short);
      const strict = !relaxed && pass < MAX_FILL_PASSES;

      const before = itemsCreated;
      const requests: Promise<number>[] = [];
      for (const section of plan.sections) {
        const n = owed.get(section.id) ?? 0;
        if (n <= 0) continue;
        const lines = flattenLines(pagesOf(section), section.span);
        if (lines.length === 0) continue;

        // While strict, only lines with no card yet. The 55-of-60 run before
        // this spent its fill passes rewording lines that already had cards —
        // five cards on one chorus line — while verse lines went unasked
        // (NOTES §37). The notes are still shown whole, for context; the prompt
        // names the lines and the validator holds the model to them.
        const fresh = strict ? lines.filter((line) => !usedText.has(normalize(line.text))) : [];
        const pool = fresh.length > 0 ? fresh : lines;

        // No request asked for more than one should write; parts run two at a time.
        const parts = splitSpans(pool, Math.ceil(n / MAX_ITEMS_PER_CALL));
        const counts = shareOut(n, parts.map(() => 1));
        parts.forEach((part, k) => {
          const want = counts[k] ?? 0;
          if (want <= 0) return;
          const partLines = pool.filter((line) => inSpan(line, part.span));
          // Held to lines with no card, a request needs no quota per part as
          // well: the lines ARE the spread. With both, a request for 2 threw
          // away 6 answers for landing in a part that had its share, and a
          // request for 10 ended at 9 (NOTES §37). Quotas per part are kept
          // for when every line already has a card.
          const base = strict && fresh.length === 0 ? planBands(partLines, want) : [];
          const bands =
            base.length > 0
              ? fillQuotas(base, base.map((b) => cited.filter((ref) => inSpan(ref, b)).length), want)
              : [{ ...part.span, quota: want }];
          requests.push(
            queue.run(() =>
              ask(section, {
                budget: allocateTiers(want),
                bands,
                maxTotal: want,
                fill: {
                  span: part.span,
                  angles: pass > 1,
                  onlyLines: fresh.length > 0 ? partLines : undefined,
                },
              }),
            ),
          );
        });
      }

      const settled = await Promise.allSettled(requests);
      failure = failureOf(settled, failure);
      const gained = itemsCreated - before;
      console.warn(
        `[pipeline] fill pass ${pass}${strict ? '' : ' (anywhere in the notes)'}: owed ${short}, made ${gained}`,
      );
      report();

      if (failure !== null) break;
      if (gained === 0) {
        if (!strict) break;
        relaxed = true;
      }
    }
  }

  if (dropped.length > 0) {
    // Logged, not shown (NOTES §37) — but never silently thrown away.
    console.warn(`[pipeline] ${dropped.length} card(s) dropped: ${JSON.stringify(summariseDrops(dropped))}`);
  }

  // A set is finished when every section has run and nothing failed. A failed
  // round leaves it "generating", so opening the set again carries on from the
  // cards already stored rather than calling a short set done.
  const finished = allSectionsDone && failure === null;
  await updateSet(setId, {
    status: finished ? 'ready' : 'generating',
    plan: { ...plan, completedSectionIds: [...done] },
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
  if (finished) {
    const pass = await verifyRubrics({ setId, apiKey });
    if (pass.checked > 0 || pass.failed > 0) {
      console.warn(
        `[pipeline] rubric check: ${pass.checked} checked, ${pass.flagged} flagged, ` +
          `${pass.failed} could not be checked`,
      );
    }

    // Answer choices for every card that has none, so the whole set can be
    // asked in the quiz (NOTES §38). After ready, for the rubric pass's reason:
    // the cards are usable the moment the set is, and the quiz writes choices
    // itself for any card this did not reach.
    try {
      const choices = await addQuizChoices({ setId, apiKey });
      if (choices.written > 0 || choices.notWritten > 0) {
        console.warn(`[pipeline] quiz choices: ${choices.written} written, ${choices.notWritten} not`);
      }
    } catch (err) {
      console.warn(`[pipeline] quiz choices failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Where the labels are on each picture, so a card can cover its answer
    // (NOTES §44). After ready, for the same reason as the two passes above;
    // until it lands, a picture shows with the answer.
    try {
      const pictures = await locatePictureLabels({ setId, apiKey });
      if (pictures.located > 0 || pictures.failed > 0) {
        console.warn(`[pipeline] picture labels: ${pictures.located} found, ${pictures.failed} not`);
      }
    } catch (err) {
      console.warn(`[pipeline] picture labels failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const totalMs = Date.now() - startedAt;
  const queueWaitMs = Math.max(
    0,
    (queue.startTimes[queue.startTimes.length - 1] ?? 0) - (queue.startTimes[0] ?? 0),
  );

  onProgress?.({
    phase: finished ? 'done' : 'failed',
    sectionsDone: sectionsDone(),
    sectionsTotal: plan.sections.length,
    itemsSoFar: itemsCreated,
    // Carried on the last event, so the screen still has the reason once the
    // run has ended — an earlier event of its own was overwritten by this one.
    ...(failure ? { message: failure.message } : {}),
  });

  return {
    itemsCreated,
    dropped,
    unreadablePages: plan.unreadablePages,
    timing: { totalMs, readMs: 0, generateMs, dbMs, queueWaitMs, sections: plan.sections.length, calls },
  };
}
