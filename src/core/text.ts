/**
 * Text normalisation and counting. Pure, no dependencies.
 *
 * Everything that compares two pieces of text in this app goes through
 * `normalize` first, so the rules live in exactly one place: excerpt matching,
 * leak detection, dedup and MC option uniqueness all agree on what "the same
 * text" means.
 */

/** Curly quotes, dashes and odd spaces that models emit and notes contain. */
const QUOTE_MAP: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '‚': "'",
  '‛': "'",
  '“': '"',
  '”': '"',
  '„': '"',
  '′': "'",
  '″': '"',
  '«': '"',
  '»': '"',
};

const DASH_RE = /[‐‑‒–—―−]/g;
const SPACE_RE = /[   -   　\t\r\n\f\v]+/g;

// Single-character variants, deliberately NOT global: `.test()` on a /g regex
// advances lastIndex, so repeated calls on the same regex alternate answers.
// Built from the sources above so the two can never drift apart.
const DASH_CHAR = new RegExp(DASH_RE.source);
// `\s` already covers ASCII space/tab/newline plus NBSP, en/em spaces, U+3000
// and friends — broader and more reliable than hand-listing code points. The
// exotic class is unioned in so nothing SPACE_RE caught is missed.
const SPACE_CHAR = new RegExp(`\\s|${SPACE_RE.source.replace(/\+$/, '')}`);

/**
 * Canonical form for comparison, plus a map back to the original string.
 *
 * `map[i]` is the index in `input` that produced normalised character `i`. The
 * map exists because the UI highlights the matched phrase inside the user's
 * ORIGINAL page text, and normalisation collapses whitespace runs — so offsets
 * shift and cannot be assumed to line up. Deriving the map here, in the same
 * pass that does the normalising, is the only way the two cannot disagree.
 */
export function normalizeWithMap(input: string): { text: string; map: number[] } {
  let text = '';
  const map: number[] = [];
  let pendingSpace = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;

    // Whitespace: remember that a gap occurred, emit at most one space, and
    // only once something has already been emitted (that trims the start).
    if (SPACE_CHAR.test(ch)) {
      if (text.length > 0) pendingSpace = true;
      continue;
    }

    let out = QUOTE_MAP[ch] ?? (DASH_CHAR.test(ch) ? '-' : ch);
    out = out.normalize('NFKC').toLowerCase();

    if (pendingSpace) {
      text += ' ';
      map.push(i);
      pendingSpace = false;
    }
    // NFKC can expand one character into several; each maps to the same source.
    for (const c of out) {
      text += c;
      map.push(i);
    }
  }

  // A trailing pendingSpace is never flushed, which trims the end.
  return { text, map };
}

/**
 * Canonical form for comparison: lowercase, straight quotes, plain hyphens,
 * single spaces, trimmed. Deliberately does NOT strip punctuation — dropping
 * it would let "cells divide" match "cells divide?" and also "cells, divide"
 * in ways that hide real differences between a question and a statement.
 */
export function normalize(input: string): string {
  return normalizeWithMap(input).text;
}

/**
 * Strip a leading enumeration marker: "A. ", "b) ", "3. ", "- ", "• ".
 *
 * Notes that are already quizzes carry option letters, and a model copying an
 * option verbatim drags "A. " along with it — so a card's answer reads
 * "A. To unify different forms of words" instead of the answer itself. The
 * letter is meaningless once the option list is gone.
 *
 * A separator is REQUIRED after the letter, so "A Pangolin" and "A cell wall"
 * survive intact while "A. Pangolin" is cleaned. Getting that wrong would
 * silently eat the first word of every answer beginning with an article.
 */
export function stripEnumeration(input: string): string {
  return input
    .replace(/^\s*(?:[A-Za-z][.)]|\d{1,2}[.)]|[-*•‣▪])\s+/, '')
    .trim();
}

/**
 * Split page text into sentences, stably.
 *
 * This is the backbone of source grounding: the model cites a sentence by
 * INDEX and the app resolves the real text itself, so the quote shown to the
 * user provably comes from their own notes rather than from the model.
 *
 * That makes the split contract-critical — the same page text must always
 * produce the same sentences, or a stored index would drift and point at the
 * wrong line later. Deliberately simple and deterministic: split on sentence
 * punctuation followed by whitespace, and treat a line break as a boundary so
 * headings and list items become their own sentences.
 *
 * Common abbreviations are protected so "e.g." and "Fig. 3" do not split a
 * sentence in half.
 */
const ABBREVIATIONS = /\b(?:e\.g|i\.e|etc|vs|cf|approx|fig|eq|no|vol|pp|dr|mr|mrs|ms|prof|st)\.$/i;

export function splitSentences(text: string): string[] {
  const out: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0) continue;

    let start = 0;
    for (let i = 0; i < trimmedLine.length; i++) {
      const ch = trimmedLine[i]!;
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;

      // Consume runs like "?!" or "..." so they end one sentence, not several.
      let end = i;
      while (end + 1 < trimmedLine.length && /[.!?]/.test(trimmedLine[end + 1]!)) end++;

      const next = trimmedLine[end + 1];
      const atEnd = end + 1 >= trimmedLine.length;
      if (!atEnd && next !== undefined && !/\s/.test(next)) {
        i = end;
        continue; // e.g. a decimal point: "34.5"
      }

      const candidate = trimmedLine.slice(start, end + 1).trim();
      if (ABBREVIATIONS.test(candidate)) {
        i = end;
        continue;
      }

      if (candidate.length > 0) out.push(candidate);
      start = end + 1;
      i = end;
    }

    const tail = trimmedLine.slice(start).trim();
    if (tail.length > 0) out.push(tail);
  }

  return out;
}

/** Word tokens for counting and Jaccard. Punctuation-stripped, unlike normalize. */
export function tokenize(input: string): string[] {
  return normalize(input)
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Word count used by the planner's budget arithmetic. */
export function wordCount(input: string): number {
  return tokenize(input).length;
}

/** Character bigrams of a normalised string, as a multiset count map. */
export function bigrams(input: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i < input.length - 1; i++) {
    const gram = input.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/**
 * Sørensen–Dice over character bigram multisets: 2·|A∩B| / (|A|+|B|).
 * 1 means identical, 0 means nothing shared.
 */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const aGrams = bigrams(a);
  const bGrams = bigrams(b);

  let total = 0;
  let overlap = 0;
  for (const [, n] of aGrams) total += n;
  for (const [gram, n] of bGrams) {
    total += n;
    const inA = aGrams.get(gram);
    if (inA !== undefined) overlap += Math.min(inA, n);
  }

  return total === 0 ? 0 : (2 * overlap) / total;
}

/** Token-set Jaccard: |A∩B| / |A∪B|. Used for prompt dedup. */
export function jaccard(a: string, b: string): number {
  const setA = new Set(tokenize(a));
  const setB = new Set(tokenize(b));
  if (setA.size === 0 && setB.size === 0) return 1;

  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
