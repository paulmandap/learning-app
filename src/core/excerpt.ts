/**
 * Excerpt verification (spec §3.2.4).
 *
 * A generated item claims a verbatim quote from the notes. This checks that the
 * quote is really there. If it is not, the item is dropped before insertion —
 * an item whose source cannot be found is exactly the kind of confident
 * fabrication the product exists to avoid.
 *
 * Reminder on what a pass means, and only means: the stored excerpt matched the
 * stored page text under these rules. It says nothing about whether the notes
 * are factually right or the question is any good.
 */

import { diceCoefficient, normalize, normalizeWithMap } from './text';

/** Dice score at or above this counts as a match (spec §3.2.4). */
export const EXCERPT_MATCH_THRESHOLD = 0.85;

export interface ExcerptMatch {
  matched: boolean;
  /** Best similarity found, 0..1. Exactly 1 for a normalised exact substring. */
  score: number;
  /**
   * The span of the ORIGINAL page text that matched, when one was found.
   * Used to highlight the phrase in the UI rather than re-searching there.
   */
  span?: { start: number; end: number; text: string };
}

/**
 * Does `excerpt` appear in `pageText`?
 *
 * 1. Normalised exact substring → match, score 1.
 * 2. Otherwise the best sliding window of comparable length is scored with
 *    bigram Dice, and ≥ 0.85 matches.
 *
 * The fuzzy tier exists because models reliably reflow whitespace, swap quote
 * characters and occasionally drop a stray word, none of which mean the quote
 * was invented. Below 0.85 the item is dropped.
 */
export function excerptMatches(excerpt: string, pageText: string): ExcerptMatch {
  const needle = normalize(excerpt);
  const { text: haystack, map } = normalizeWithMap(pageText);

  if (needle.length === 0 || haystack.length === 0) {
    return { matched: false, score: 0 };
  }

  // --- tier 1: exact substring after normalisation --------------------------
  const exactAt = haystack.indexOf(needle);
  if (exactAt !== -1) {
    return {
      matched: true,
      score: 1,
      span: mapSpanToOriginal(pageText, map, exactAt, needle.length),
    };
  }

  // A needle longer than the haystack cannot be a quote from it. Compare the
  // whole thing once rather than sliding a window wider than the text.
  if (needle.length >= haystack.length) {
    const score = diceCoefficient(needle, haystack);
    return score >= EXCERPT_MATCH_THRESHOLD
      ? { matched: true, score, span: { start: 0, end: pageText.length, text: pageText } }
      : { matched: false, score };
  }

  // --- tier 2: best sliding window ----------------------------------------
  // Step is a fraction of the needle so long excerpts do not cost O(n·m) with
  // m windows at every character, while still landing close enough that the
  // bigram score is representative.
  const windowLen = needle.length;
  const step = Math.max(1, Math.floor(windowLen / 12));

  let best = 0;
  let bestAt = -1;
  for (let start = 0; start + windowLen <= haystack.length; start += step) {
    const score = diceCoefficient(needle, haystack.slice(start, start + windowLen));
    if (score > best) {
      best = score;
      bestAt = start;
      if (best === 1) break;
    }
  }

  // Refine around the best coarse offset: the true optimum may sit between
  // steps, and a near-miss at 0.84 would otherwise fail on grid alignment.
  if (bestAt !== -1 && step > 1) {
    const from = Math.max(0, bestAt - step);
    const to = Math.min(haystack.length - windowLen, bestAt + step);
    for (let start = from; start <= to; start++) {
      const score = diceCoefficient(needle, haystack.slice(start, start + windowLen));
      if (score > best) {
        best = score;
        bestAt = start;
      }
    }
  }

  if (best >= EXCERPT_MATCH_THRESHOLD && bestAt !== -1) {
    return {
      matched: true,
      score: best,
      span: mapSpanToOriginal(pageText, map, bestAt, windowLen),
    };
  }

  return { matched: false, score: best };
}

/**
 * Translate a span of normalised text back to the original string.
 *
 * `map` comes from normalizeWithMap, so this is a lookup rather than a second
 * walk that could disagree with the first. It has to be exact: this span is
 * what gets highlighted next to "Source · p.14", and an off-by-a-few span
 * highlights the wrong words in the user's own notes.
 */
function mapSpanToOriginal(
  original: string,
  map: number[],
  normStart: number,
  normLength: number,
): { start: number; end: number; text: string } {
  if (map.length === 0) {
    return { start: 0, end: 0, text: '' };
  }

  const firstIdx = Math.min(Math.max(normStart, 0), map.length - 1);
  const lastIdx = Math.min(Math.max(normStart + normLength - 1, 0), map.length - 1);

  const start = map[firstIdx]!;
  // +1 because map holds the index of the character that produced the last
  // normalised char; the slice end must sit just past it.
  const end = Math.min(map[lastIdx]! + 1, original.length);

  return { start, end, text: original.slice(start, end) };
}
