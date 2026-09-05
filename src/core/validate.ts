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
 * only yield 4 cards?" gets answered.
 */

import { jaccard, normalize, splitSentences, stripEnumeration, tokenize } from './text';
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
  | 'over_budget';

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

/** Counts by reason, small enough to persist on the set's plan. */
export type DropSummary = Partial<Record<DropReason, number>>;

export function summariseDrops(dropped: DroppedItem[]): DropSummary {
  const out: DropSummary = {};
  for (const d of dropped) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}

/**
 * Plain-English reasons. This text goes on screen, so: no jargon, and grammar
 * that survives both "1 card" and "3 cards".
 *
 * `one`/`many` complete the sentence "We left out N cards because …".
 * `short` is a bare noun phrase for when several reasons are listed together.
 */
const DROP_WORDING: Record<DropReason, { one: string; many: string; short: string }> = {
  duplicate: {
    one: 'it repeated another card',
    many: 'they repeated other cards',
    short: 'repeated another card',
  },
  excerpt_unmatched: {
    one: "we couldn't match it to your notes",
    many: "we couldn't match them to your notes",
    short: "couldn't be matched to your notes",
  },
  leak: {
    one: 'it gave away its own answer',
    many: 'they gave away their own answers',
    short: 'gave away the answer',
  },
  mc_invalid: {
    one: "its answer choices didn't work",
    many: "their answer choices didn't work",
    short: "had answer choices that didn't work",
  },
  schema: {
    one: 'it came back incomplete',
    many: 'they came back incomplete',
    short: 'came back incomplete',
  },
  over_budget: {
    one: 'we already had enough like it',
    many: 'we already had enough like them',
    short: 'were more than we needed',
  },
};

/**
 * One sentence explaining why cards were left out, or null when none were.
 *
 * Exists because "19 cards ready" when you asked for 20 is otherwise a mystery:
 * the drop reasons were being collected and then thrown away.
 */
export function describeDrops(summary: DropSummary): string | null {
  const parts = (Object.entries(summary) as [DropReason, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const total = parts.reduce((sum, [, n]) => sum + n, 0);
  if (total === 0) return null;

  const cards = (n: number) => `${n} card${n === 1 ? '' : 's'}`;

  if (parts.length === 1) {
    const [reason, n] = parts[0]!;
    const wording = DROP_WORDING[reason];
    return `We left out ${cards(n)} because ${n === 1 ? wording.one : wording.many}.`;
  }

  const list = parts.map(([reason, n]) => `${n} ${DROP_WORDING[reason].short}`).join(', ');
  return `We left out ${cards(total)}: ${list}.`;
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

/**
 * Full validation pass for one section's candidates.
 *
 * @param candidates   Items as returned by the model (already schema-parsed).
 * @param pageTexts    page_index -> stored page text, for excerpt verification.
 * @param budget       Per-tier cap from the plan; excess is dropped.
 * @param existingPrompts Prompts already stored for this set, so dedup works
 *                        across sections and across resumed runs, not just
 *                        within one batch.
 */
export function validateItems(
  candidates: CandidateItem[],
  pageTexts: Map<number, string>,
  budget: TierBudget,
  existingPrompts: string[] = [],
): ValidationResult {
  const kept: ValidatedItem[] = [];
  const dropped: DroppedItem[] = [];
  const seenPrompts: string[] = [...existingPrompts];
  const used: TierBudget = { remember: 0, understand: 0, apply: 0 };

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
    const item = cleanCandidate(raw);

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
    if (item.kind === 'mcq') {
      const problem = validateMultipleChoice(item);
      if (problem) {
        drop(item, 'mc_invalid', problem);
        continue;
      }
    }

    // --- answer leak ------------------------------------------------------
    // Skipped for MCQ: the correct option is supposed to be visible among the
    // choices, and validateMultipleChoice already checks the prompt itself.
    if (item.kind !== 'mcq' && detectLeak(item.prompt, item.answer)) {
      drop(item, 'leak', 'answer appears in the prompt');
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
    const duplicate = seenPrompts.find((p) => jaccard(p, item.prompt) > DEDUP_JACCARD_THRESHOLD);
    if (duplicate !== undefined) {
      drop(item, 'duplicate', 'prompt overlaps an existing card');
      continue;
    }

    // --- per-tier budget --------------------------------------------------
    if (used[item.level] >= budget[item.level]) {
      drop(item, 'over_budget', `${item.level} budget of ${budget[item.level]} already met`);
      continue;
    }

    used[item.level]++;
    seenPrompts.push(item.prompt);
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
