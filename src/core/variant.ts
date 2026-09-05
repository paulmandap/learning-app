/**
 * Variants of missed items (spec §3.3: "Gemini does … (later) write variants of
 * missed items").
 *
 * Pure and deterministic. The model rewrites the question; everything about
 * WHEN that is allowed and WHETHER the result is usable is decided here.
 *
 * ## Why rephrase at all
 *
 * A card failed repeatedly is often not a fact the student cannot learn — it is
 * a question they have learned to bounce off. The wording itself becomes the
 * obstacle: an ambiguous stem, an unfamiliar phrasing, a question that reads as
 * asking for something narrower than it wants. Spaced repetition alone answers
 * this by showing the same wall more often.
 *
 * ## What is deliberately NOT changed
 *
 * The answer, the page, the cited sentence and the stored excerpt all stay
 * exactly as they were. Only `prompt` gets an alternative. That keeps the
 * grounding guarantee intact for free — the source still supports the answer,
 * because neither of them moved — and it means a variant can never quietly turn
 * a card into a question about something else.
 */

import { detectLeak, sourceSupportScore, SOURCE_SUPPORT_THRESHOLD } from './validate';
import { jaccard } from './text';

/**
 * Lapses before a card is rephrased.
 *
 * Three, from the roadmap. One lapse is ordinary — most cards are missed once
 * and that is the whole point of the missed pile. Two is a hard card. Three is
 * the point at which "you do not know this yet" stops being the most likely
 * explanation and "this question is not asking clearly" becomes worth a call.
 *
 * Checked with `===`, not `>=`: a card is rephrased on the lapse that reaches
 * the threshold and never again. `variant_prompt` being set is the durable
 * guard; this is what stops a burst of calls before the first one lands.
 */
export const VARIANT_LAPSE_THRESHOLD = 3;

/**
 * A rewrite this similar to the original is not a variant.
 *
 * The same threshold dedup uses (§3.2.4), pointed the other way: dedup rejects
 * a NEW card that overlaps an existing one, and this rejects a REPHRASING that
 * does not. Reusing the number is deliberate — "these two prompts are the same
 * question" should mean one thing in this codebase.
 */
export const VARIANT_MIN_DIFFERENCE = 0.8;

export interface VariantCandidate {
  /** The prompt as it stands today. */
  original: string;
  /** What the model proposes instead. */
  rephrased: string;
  /** Unchanged — the variant must still be a question with this answer. */
  answer: string;
  /** Unchanged — the sentence from the user's notes that grounds the card. */
  sourceExcerpt: string;
}

/**
 * Phrasings that break a card out of its own frame.
 *
 * A student sees ONE card with no notes beside it, so a question that says
 * "based on the student's notes…" is asking about a thing that is not in front
 * of them. The generation prompt has carried this rule from the start ("Every
 * card must stand on its own"); the rephrase prompt repeats it, and a weaker
 * model on the fallback ladder still produced exactly that opening on the first
 * live run — which is why it is a check and not only an instruction.
 *
 * Narrow by design. It matches referential constructions, not any mention of a
 * word: "the layer above the mesophyll" is a fine question, "as shown above" is
 * not. A false positive costs nothing anyway — the card keeps its original.
 */
const REFERS_TO_NOTES = [
  /\b(?:the|your|these|this|his|her|their)\s+(?:student'?s?\s+)?(?:notes?|passage|excerpt|reviewer)\b/i,
  /\b(?:based on|according to)\s+(?:the|your|these|this)\b/i,
  /\bin the\s+(?:text|passage|notes?|source|material)\b/i,
  /\bas\s+(?:shown|described|mentioned|stated|given|listed)\b/i,
  /\b(?:the\s+)?(?:above|below|preceding|following)\s+(?:text|passage|notes?|diagram|figure|list)\b/i,
];

export type VariantReject =
  | 'empty'
  | 'leak'
  /** Too close to the original to be worth showing. */
  | 'not_different'
  /** The stored source no longer supports the answer, so nothing may be rewritten. */
  | 'ungrounded'
  /** Points outside the card, which the student cannot see. */
  | 'refers_to_notes';

export type VariantResult =
  | { ok: true; prompt: string }
  | { ok: false; reason: VariantReject };

/** Is this card due to be rephrased? */
export function shouldRephrase(input: {
  lapses: number;
  /** True once `variant_prompt` is set — a card is rephrased at most once. */
  alreadyRephrased: boolean;
}): boolean {
  return !input.alreadyRephrased && input.lapses === VARIANT_LAPSE_THRESHOLD;
}

/**
 * Re-validate a proposed rewrite before it is allowed anywhere near a card.
 *
 * The same checks a freshly generated item faces, minus the ones that cannot
 * have changed. Source grounding IS re-checked rather than assumed: the answer
 * and excerpt are untouched so it should pass by construction, and that is
 * exactly why a failure here means something upstream is wrong and the card
 * should be left alone.
 */
export function validateVariant(candidate: VariantCandidate): VariantResult {
  const prompt = candidate.rephrased.trim();
  if (prompt.length === 0) return { ok: false, reason: 'empty' };

  // A rewrite is free to be clumsy; it is not free to give the answer away.
  if (detectLeak(prompt, candidate.answer)) return { ok: false, reason: 'leak' };

  // …nor to point at something the student cannot see.
  if (REFERS_TO_NOTES.some((re) => re.test(prompt))) {
    return { ok: false, reason: 'refers_to_notes' };
  }

  if (jaccard(prompt, candidate.original) > VARIANT_MIN_DIFFERENCE) {
    return { ok: false, reason: 'not_different' };
  }

  if (
    sourceSupportScore(candidate.answer, candidate.sourceExcerpt) < SOURCE_SUPPORT_THRESHOLD
  ) {
    return { ok: false, reason: 'ungrounded' };
  }

  return { ok: true, prompt };
}
