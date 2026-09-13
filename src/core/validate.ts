/**
 * Deterministic validation (spec §3.2.4). Runs before insert, every time.
 *
 * D7: this replaces a second AI verification pass in the MVP. It is free,
 * instant and testable, and it catches the failures that actually happen —
 * invented quotes, multiple-choice questions that give themselves away,
 * answers leaked into their own prompts, and near-duplicate cards.
 *
 * Malformed items are dropped individually. The batch is never discarded: one
 * bad item out of eight should cost one item, not the whole section.
 *
 * Every drop is recorded with a reason. That log — not `excerpt_verified`, which
 * is true for every stored row by construction — is how "why did this section
 * only yield 4 cards?" gets answered. It is logged, not shown: the owner asked
 * for the on-screen "We left out 12 cards…" line to go (NOTES §37), because the
 * pipeline now replaces what it drops until the set holds the count asked for.
 */

import { jaccard, normalize, splitSentences, stripEnumeration, tokenize } from './text';
import { bandIndex, describeBand, lineKey, type Band } from './coverage';
import type { Level, TierBudget } from './planner';

/** Prompts more similar than this are treated as the same card (§3.2.4). */
export const DEDUP_JACCARD_THRESHOLD = 0.8;

/**
 * How much of the answer's substance must appear in the cited sentence.
 *
 * An index alone proves the source text is REAL (the app resolves it from its
 * own stored notes, so it cannot be fabricated) but not that it SUPPORTS the
 * answer — a model could cite sentence 0 for everything and the citation would
 * become decorative. This threshold is the second half of the guarantee.
 *
 * Tuned against real generated output rather than picked round: because the
 * model deliberately rewrites answers in its own words, content overlap with
 * the source runs well below 0.5 even for perfectly grounded cards. Measuring
 * live output put genuine citations mostly in the 0.3-0.7 band and unrelated
 * ones below 0.15, so 0.22 separates them while leaving headroom for short
 * answers ("Gorilla") that legitimately share few words with their sentence.
 */
export const SOURCE_SUPPORT_THRESHOLD = 0.22;

/** Words too common to count as evidence that a sentence supports an answer. */
const STOPWORDS = new Set([
  'the','a','an','and','or','but','of','to','in','on','at','for','with','by','from',
  'is','are','was','were','be','been','being','it','its','this','that','these','those',
  'as','which','who','whom','into','than','then','so','such','can','could','may','might',
  'will','would','shall','should','do','does','did','has','have','had','not','no','if',
  'when','while','because','they','them','their','there','also','more','most','each','one',
]);

/**
 * Fraction of the answer's meaningful words that appear in the cited sentence.
 *
 * Asymmetric on purpose: a long sentence supporting a short answer should pass,
 * so this measures coverage OF THE ANSWER rather than similarity between the two.
 */
export function sourceSupportScore(answer: string, sentence: string): number {
  const answerWords = tokenize(answer).filter((w) => !STOPWORDS.has(w) && w.length > 2);
  if (answerWords.length === 0) return 1; // nothing substantive to check

  const sentenceWords = new Set(tokenize(sentence));
  let hits = 0;
  for (const w of new Set(answerWords)) {
    if (sentenceWords.has(w)) hits++;
  }
  return hits / new Set(answerWords).size;
}

export interface ResolvedSource {
  /** The real sentence, taken from the app's stored page text. */
  text: string;
  score: number;
}

/**
 * How many sentences either side of the citation may be pulled in as evidence.
 *
 * One. Enough to reunite a label with the line under it, not enough to let a
 * citation drift into a different topic.
 */
export const SOURCE_WINDOW = 1;

/**
 * Resolve a model citation against the app's own stored page text.
 *
 * Returns null when the index does not exist, which is how a fabricated or
 * hallucinated citation is caught.
 *
 * **Why a neighbouring line can count as evidence.** `splitSentences` treats a
 * line break as a sentence boundary, so label-and-annotation notes split into
 * separate sentences:
 *
 *     "LEAF"
 *     "primary photosynthetic organ"
 *
 * A card asking which organ is the primary photosynthetic organ answers "the
 * leaf" and cites the function line — and those two strings share no words at
 * all, so the support score is exactly 0 and a perfectly good card was dropped.
 * Measured on a labelled diagram: 2 of 6 organs were lost this way. It is not a
 * diagram problem either; glossaries, vocabulary lists and any term/definition
 * notes have the same shape.
 *
 * So when the cited sentence alone does not support the answer, the immediate
 * neighbours are tried WITH IT. This does not weaken the guarantee: the text is
 * still resolved from the user's own stored notes and cannot be fabricated, the
 * threshold is unchanged, and the window is one sentence either side. The
 * widened text becomes the excerpt, so the user sees the label and its meaning
 * together — which is the more useful quote anyway.
 */
export function resolveSource(
  pageText: string,
  sentenceIndex: number,
  answer: string,
): ResolvedSource | null {
  const sentences = splitSentences(pageText);
  const sentence = sentences[sentenceIndex];
  if (sentence === undefined) return null;

  const direct = sourceSupportScore(answer, sentence);
  if (direct >= SOURCE_SUPPORT_THRESHOLD) return { text: sentence, score: direct };

  // Widen by one sentence either side and re-check.
  const from = Math.max(0, sentenceIndex - SOURCE_WINDOW);
  const to = Math.min(sentences.length - 1, sentenceIndex + SOURCE_WINDOW);
  const window = sentences.slice(from, to + 1).join(' ');
  const widened = sourceSupportScore(answer, window);

  // Report the better of the two. A window that still fails leaves the original
  // sentence as the excerpt, so the drop log names what the model actually cited.
  return widened >= SOURCE_SUPPORT_THRESHOLD
    ? { text: window, score: widened }
    : { text: sentence, score: direct };
}

export type DropReason =
  | 'schema'
  | 'excerpt_unmatched'
  | 'mc_invalid'
  | 'leak'
  | 'duplicate'
  | 'over_budget'
  /** Points at the notes by number — "according to line 93" — which the student never sees. */
  | 'self_reference';

export interface CandidateItem {
  kind: 'flashcard' | 'mcq' | 'short_answer';
  level: Level;
  form?: string;
  prompt: string;
  answer: string;
  options?: { text: string; correct: boolean }[];
  rubric?: { expected_concepts: { id: string; text: string }[]; model_answer: string };
  /** Citation by index — the model no longer reproduces source text. */
  page_index: number;
  source_sentence: number;
  topic?: string;
  check_flag?: string;
}

export interface ValidatedItem extends CandidateItem {
  excerpt_verified: true;
  /**
   * Filled in by the APP from its own stored page text, never by the model.
   * This is what gets written to study_items.source_excerpt.
   */
  source_excerpt: string;
  /** How well the cited sentence covers the answer, for the drop log. */
  source_score: number;
}

export interface DroppedItem {
  reason: DropReason;
  detail: string;
  prompt: string;
  excerpt: string;
  page_index: number;
}

export interface ValidationResult {
  kept: ValidatedItem[];
  dropped: DroppedItem[];
}

/** A card already in the set: what it asks, what it answers, and the quote it came from. */
export interface ExistingCard {
  prompt: string;
  answer: string;
  /** Its `source_excerpt`, when known — for spotting a second card about the same line. */
  excerpt?: string;
}

/** Counts by reason — for the console, so a short run can still be explained. */
export type DropSummary = Partial<Record<DropReason, number>>;

export function summariseDrops(dropped: DroppedItem[]): DropSummary {
  const out: DropSummary = {};
  for (const d of dropped) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}

/** Answers this short are judged on a lower overlap — one differing word is a lot of a short answer. */
export const SHORT_ANSWER_WORDS = 6;
export const SAME_ANSWER_SHORT = 0.6;
export const SAME_ANSWER_LONG = 0.8;

/** The words of an answer that make it this answer and not another. */
function answerWords(answer: string): string[] {
  return [
    ...new Set(
      tokenize(answer).filter((w) => !STOPWORDS.has(w) && (w.length > 2 || /\d/.test(w))),
    ),
  ];
}

/**
 * Do two cards give the same answer?
 *
 * ## Why prompt dedup was not enough (NOTES §37)
 *
 * The owner's first report: three flashcards about one detail of a song, and a
 * three-question quiz whose correct answer was the same phrase every time. The
 * only dedup was on PROMPTS, at a Jaccard of 0.8, and a model asking about one
 * fact three ways writes three prompts that share half their words. Reproduced
 * on a 60-card run, where the top-up wrote "Two peaches and a warning about the
 * rain" beside "Two free peaches and a warning about the rain", and "The plates
 * she had saved for Easter" beside "Plates saved for Easter".
 *
 * So answers are compared on their content words. Those two pairs score 0.83
 * and 0.75; "the sinoatrial node" against "the atrioventricular node" scores
 * 0.33 and stays two cards. The cost is honest: two genuinely different
 * questions whose answer is the same word ("Roots") are now one card — and the
 * pipeline replaces the dropped one with a different fact.
 */
export function sameAnswer(a: string, b: string): boolean {
  const plain = (s: string) => normalize(s).replace(/[.!?]+$/, '');
  const pa = plain(a);
  if (pa.length > 0 && pa === plain(b)) return true;

  const wa = answerWords(a);
  const wb = answerWords(b);
  if (wa.length === 0 || wb.length === 0) return false;
  const shared = wa.filter((w) => wb.includes(w)).length;
  const overlap = shared / (wa.length + wb.length - shared);
  const threshold = Math.max(wa.length, wb.length) <= SHORT_ANSWER_WORDS ? SAME_ANSWER_SHORT : SAME_ANSWER_LONG;
  return overlap >= threshold;
}

/**
 * How much of the shorter answer the other repeats: 0 to 1.
 *
 * For two cards drawn from the SAME line, where rewording is the whole
 * difference. Measured on the 60-card run after the fill passes (NOTES §37):
 * "The speaker still knows it all by heart and note for note" beside "I still
 * know it all by heart and note for note" scores 0.57 on `sameAnswer` — under
 * its bar, because one says "knows" — and 0.8 here. On three sentences asked
 * for sixty, "The required intake is oxygen and glucose" beside "Functional
 * inputs are oxygen and glucose": 0.5. Two different facts from one line —
 * "Two free peaches" and "Rain", from "He gave us two free peaches and a
 * warning about the rain" — share nothing and both stay.
 */
export function answerOverlap(a: string, b: string): number {
  const wa = answerWords(a);
  const wb = answerWords(b);
  if (wa.length === 0 || wb.length === 0) return 0;
  const shared = wa.filter((w) => wb.includes(w)).length;
  return shared / Math.min(wa.length, wb.length);
}

/** Two cards about one line whose answers overlap this much are one card. */
export const SAME_LINE_OVERLAP = 0.5;

const POSITION =
  /\b(?:line|sentence|page|paragraph)s?\s+(?:#\s*)?(?:\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/**
 * Does a card point at where it came from — "referenced in line 93",
 * "according to sentence two"?
 *
 * The numbers exist so the model can CITE; a student sees one card and never
 * sees them. Asking for parts of the notes by line number made the model start
 * writing them into cards, measured on the first 60-card run (NOTES §37), and
 * the prompt rule against it needs this behind it.
 */
export function mentionsPosition(text: string): boolean {
  return POSITION.test(text);
}

/**
 * Remove enumeration markers a quiz-shaped source drags into the card.
 *
 * Applied to what the user reads — prompt, answer and option text — and never
 * to `source_excerpt`, which must remain a verbatim quote for verification.
 */
export function cleanCandidate(item: CandidateItem): CandidateItem {
  return {
    ...item,
    prompt: stripEnumeration(item.prompt ?? ''),
    answer: stripEnumeration(item.answer ?? ''),
    ...(item.options
      ? { options: item.options.map((o) => ({ ...o, text: stripEnumeration(o.text) })) }
      : {}),
  };
}

/** Multiple-choice sanity (§3.2.4). */
export function validateMultipleChoice(item: CandidateItem): string | null {
  const options = item.options ?? [];
  if (options.length < 3 || options.length > 4) {
    return `expected 3-4 options, got ${options.length}`;
  }

  const correct = options.filter((o) => o.correct);
  if (correct.length !== 1) {
    return `expected exactly 1 correct option, got ${correct.length}`;
  }

  const seen = new Set<string>();
  for (const option of options) {
    const key = normalize(option.text);
    if (key.length === 0) return 'option text is empty';
    if (seen.has(key)) return 'options are not unique after normalisation';
    seen.add(key);
  }

  // A correct answer quoted verbatim in the question is not a question.
  const promptNorm = normalize(item.prompt);
  const correctNorm = normalize(correct[0]!.text);
  if (correctNorm.length > 0 && promptNorm.includes(correctNorm)) {
    return 'correct option appears verbatim in the prompt';
  }

  return null;
}

/**
 * Leak check (§3.2.4): the answer must not be sitting in the prompt.
 *
 * Only meaningful for answers with some substance — a one-word answer like
 * "yes" or a number legitimately appears in its own prompt often enough that
 * flagging it would drop good cards.
 */
export function detectLeak(prompt: string, answer: string): boolean {
  const a = normalize(answer);
  const p = normalize(prompt);
  if (a.length < 4) return false;
  return p.includes(a);
}

export interface ValidateOptions {
  /**
   * The parts of the notes this request covers and how many cards each may
   * give (`src/core/coverage.ts`). A card citing a part that already has its
   * share, or a line in no part at all, is dropped — which is what makes "take
   * two from lines 12–23" a rule rather than a suggestion.
   */
  bands?: readonly Band[];
  /** The most cards to keep from this batch: the number this request asked for. */
  maxTotal?: number;
  /**
   * Only lines with these keys (`lineKey`) may be cited — a fill request that
   * named the lines still without a card holds the model to them.
   */
  lines?: ReadonlySet<string>;
}

/**
 * Full validation pass for one section's candidates.
 *
 * @param candidates   Items as returned by the model (already schema-parsed).
 * @param pageTexts    page_index -> stored page text, for excerpt verification.
 * @param budget       Per-tier cap from the plan; excess is dropped.
 * @param existing     Cards already stored for this set — prompts alone, or
 *                     prompts with answers — so dedup works across sections,
 *                     fill passes and resumed runs, not just within one batch.
 * @param options      Where in the notes the cards must come from, and how many.
 */
export function validateItems(
  candidates: CandidateItem[],
  pageTexts: Map<number, string>,
  budget: TierBudget,
  existing: readonly (string | ExistingCard)[] = [],
  options: ValidateOptions = {},
): ValidationResult {
  const kept: ValidatedItem[] = [];
  const dropped: DroppedItem[] = [];
  const seen: ExistingCard[] = existing.map((e) => (typeof e === 'string' ? { prompt: e, answer: '' } : e));
  const used: TierBudget = { remember: 0, understand: 0, apply: 0 };
  const bands = options.bands ?? null;
  const bandUsed = (bands ?? []).map(() => 0);
  const maxTotal = options.maxTotal ?? Number.POSITIVE_INFINITY;

  const drop = (item: CandidateItem, reason: DropReason, detail: string) => {
    dropped.push({
      reason,
      detail,
      prompt: item.prompt,
      excerpt: `page ${item.page_index}, sentence ${item.source_sentence}`,
      page_index: item.page_index,
    });
  };

  for (const raw of candidates) {
    // --- clean before checking -------------------------------------------
    // Notes that are already lettered quizzes leak their option markers into
    // the card ("A. To unify different forms of words"). The letter is
    // meaningless once the option list is gone, so it is stripped here —
    // BEFORE the leak and MC checks, so they compare the text a user will
    // actually see. source_excerpt is deliberately untouched: it must stay
    // verbatim or excerpt verification becomes meaningless.
    let item = cleanCandidate(raw);

    // --- basic shape ------------------------------------------------------
    if (!item.prompt?.trim() || !item.answer?.trim()) {
      drop(item, 'schema', 'prompt or answer is empty');
      continue;
    }
    if (!Number.isInteger(item.source_sentence) || item.source_sentence < 0) {
      drop(item, 'schema', `source_sentence is not a valid index (${item.source_sentence})`);
      continue;
    }

    // --- multiple choice --------------------------------------------------
    // A model sometimes labels an item "mcq" and then sends NO options at all
    // — seen twice in one afternoon of diagram testing, and dropped both times
    // as mc_invalid. But the prompt and answer are still a perfectly good pair;
    // only the option list is missing. So it becomes a flashcard instead of
    // being thrown away. A genuinely broken list (two options, no correct one)
    // still fails validateMultipleChoice below and is dropped.
    if (item.kind === 'mcq' && (item.options?.length ?? 0) === 0) {
      item = { ...item, kind: 'flashcard', options: undefined };
    }
    if (item.kind === 'mcq') {
      const problem = validateMultipleChoice(item);
      if (problem) {
        drop(item, 'mc_invalid', problem);
        continue;
      }
    }

    // --- a written answer with nothing to mark it against ------------------
    // Same failure, same salvage. The prompt requires a rubric on every
    // "short_answer" (buildGeneratePrompt rule 7) and nothing checked it, so
    // items arrived with the rubric missing entirely or holding zero expected
    // concepts. Measured on real stored cards: 2 of 9 written answers, 22%.
    //
    // Those reached the quiz and dead-ended it — gradeAnswer has no checklist to
    // mark against, so the screen says "This question can't be marked. Skip it
    // for now." That is a card occupying a slot in the deck and giving nothing
    // back. The prompt and answer are still a good pair, so it becomes a
    // flashcard, exactly as an option-less MCQ does above.
    if (item.kind === 'short_answer' && (item.rubric?.expected_concepts.length ?? 0) === 0) {
      item = { ...item, kind: 'flashcard', rubric: undefined };
    }

    // --- answer leak ------------------------------------------------------
    // Skipped for MCQ: the correct option is supposed to be visible among the
    // choices, and validateMultipleChoice already checks the prompt itself.
    if (item.kind !== 'mcq' && detectLeak(item.prompt, item.answer)) {
      drop(item, 'leak', 'answer appears in the prompt');
      continue;
    }

    // --- a card that points at the notes by number --------------------------
    if ([item.prompt, item.answer, ...(item.options ?? []).map((o) => o.text)].some(mentionsPosition)) {
      drop(item, 'self_reference', 'refers to a line or page number the student cannot see');
      continue;
    }

    // --- source grounding -------------------------------------------------
    // Two distinct checks. The index must RESOLVE (proving the source is real
    // text from the user's own notes — the app looks it up, so it cannot be
    // fabricated), and the resolved sentence must actually SUPPORT the answer
    // (proving the citation is not decorative).
    const pageText = pageTexts.get(item.page_index);
    if (pageText === undefined) {
      drop(item, 'excerpt_unmatched', `no stored text for page ${item.page_index}`);
      continue;
    }
    const source = resolveSource(pageText, item.source_sentence, item.answer);
    if (source === null) {
      drop(
        item,
        'excerpt_unmatched',
        `sentence ${item.source_sentence} does not exist on page ${item.page_index}`,
      );
      continue;
    }
    if (source.score < SOURCE_SUPPORT_THRESHOLD) {
      drop(
        item,
        'excerpt_unmatched',
        `cited sentence does not support the answer (${source.score.toFixed(2)} < ${SOURCE_SUPPORT_THRESHOLD})`,
      );
      continue;
    }

    // --- dedup ------------------------------------------------------------
    // Prompt rule 5 asks for no question twice and no answer twice; these two
    // checks are what hold it.
    const duplicate = seen.find((c) => jaccard(c.prompt, item.prompt) > DEDUP_JACCARD_THRESHOLD);
    if (duplicate !== undefined) {
      drop(item, 'duplicate', 'prompt overlaps an existing card');
      continue;
    }
    const sameAs = seen.find((c) => c.answer.length > 0 && sameAnswer(c.answer, item.answer));
    if (sameAs !== undefined) {
      drop(item, 'duplicate', `answer repeats an existing card ("${sameAs.answer.slice(0, 60)}")`);
      continue;
    }
    // The same line, asked again with the answer reworded. Compared by the
    // line's TEXT, not its number, so a chorus that repeats a line counts as
    // the one line it is.
    const citedLine = normalize(splitSentences(pageText)[item.source_sentence] ?? '');
    const sameLine =
      citedLine.length > 0
        ? seen.find(
            (c) =>
              c.excerpt !== undefined &&
              normalize(c.excerpt).includes(citedLine) &&
              answerOverlap(c.answer, item.answer) >= SAME_LINE_OVERLAP,
          )
        : undefined;
    if (sameLine !== undefined) {
      drop(item, 'duplicate', `asks about the same line as an existing card, with the same answer reworded`);
      continue;
    }

    // --- where in the notes -----------------------------------------------
    if (options.lines && !options.lines.has(lineKey({ page: item.page_index, sentence: item.source_sentence }))) {
      drop(item, 'over_budget', `page ${item.page_index} line ${item.source_sentence} already has a card`);
      continue;
    }
    let band = -1;
    if (bands) {
      band = bandIndex(bands, { page: item.page_index, sentence: item.source_sentence });
      if (band === -1) {
        drop(item, 'over_budget', `page ${item.page_index} line ${item.source_sentence} is outside the part asked for`);
        continue;
      }
      if (bandUsed[band]! >= bands[band]!.quota) {
        drop(item, 'over_budget', `${describeBand(bands[band]!)} already has its ${bands[band]!.quota}`);
        continue;
      }
    }

    // --- per-tier budget --------------------------------------------------
    if (used[item.level] >= budget[item.level]) {
      drop(item, 'over_budget', `${item.level} budget of ${budget[item.level]} already met`);
      continue;
    }

    // --- the number asked for ---------------------------------------------
    if (kept.length >= maxTotal) {
      drop(item, 'over_budget', `already have the ${maxTotal} asked for`);
      continue;
    }

    used[item.level]++;
    if (band >= 0) bandUsed[band]!++;
    seen.push({ prompt: item.prompt, answer: item.answer, excerpt: source.text });
    kept.push({
      ...item,
      excerpt_verified: true,
      // From the app's stored notes, not from the model.
      source_excerpt: source.text,
      source_score: source.score,
      // Rubrics are only meaningful for written answers; drop any the model
      // volunteered elsewhere rather than storing data nothing reads.
      ...(item.kind === 'short_answer' ? {} : { rubric: undefined }),
    });
  }

  return { kept, dropped };
}
