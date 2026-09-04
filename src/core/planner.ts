/**
 * Planning (spec §3.2.2). Entirely deterministic — no model involved.
 *
 * Code decides how many items the notes can support and how they are shared out
 * across sections and levels. The model only writes the items themselves. This
 * is the line that keeps "padding to 60 produces junk" (D3) from happening.
 */

import { wordCount } from './text';

/** One item per this many words is what notes realistically support (D3). */
export const WORDS_PER_ITEM = 70;

/** Pages below this readability are unusable and are reported, not guessed at. */
export const MIN_READABILITY = 0.6;

/** A section needs at least this many words to be worth one item. */
export const MIN_WORDS_FOR_ITEM = 40;

/** Fallback window size when a document has no usable headings. */
export const FALLBACK_WINDOW_WORDS = 400;

/** Tier mix, Remember/Understand/Apply (D2). */
export const TIER_MIX = { remember: 0.5, understand: 0.3, apply: 0.2 } as const;

export type Level = 'remember' | 'understand' | 'apply';

export interface PageInput {
  page_index: number;
  text: string;
  readability: number;
  headings: string[];
}

export interface TierBudget {
  remember: number;
  understand: number;
  apply: number;
}

export interface PlannedSection {
  /** Stable id so generation can resume per section after a refresh. */
  id: string;
  title: string;
  /** Page indexes this section spans, in order. */
  pages: number[];
  words: number;
  budget: TierBudget;
  total: number;
}

export interface Plan {
  sections: PlannedSection[];
  /** Pages skipped for low readability — surfaced to the user, never silently dropped. */
  unreadablePages: number[];
  totalWords: number;
  /** What the notes support, before the user's cap is applied. */
  supported: number;
  /** What was requested. */
  requested: number;
  /** min(requested, supported) — the real ceiling. */
  maxTotal: number;
}

/** A list item or Q&A pair needs at least this many words to count as a card. */
export const MIN_WORDS_PER_UNIT = 5;

/** However dense the structure, a card still needs this much text behind it. */
export const MIN_WORDS_PER_ITEM_FLOOR = 10;

/**
 * Count self-contained units already present in the notes.
 *
 * D3's "1 card per 70 words" assumes prose. It badly undercounts notes that are
 * already structured — a page of 11 Q&A pairs in 160 words scores 2 by the word
 * rule, when each pair is plainly already a flashcard.
 *
 * Counted: numbered items ("1.", "2)"), bullets ("-", "*", "•"), and explicit
 * Q&A markers ("Q:", "Answer:"). A unit must carry MIN_WORDS_PER_UNIT words to
 * count, so a list of two-word fragments cannot inflate the estimate.
 */
export function countAtomicUnits(text: string): number {
  const lines = text.split(/\r?\n/);

  // Only these START a unit. An "Answer:" line is deliberately NOT here: a Q&A
  // pair is ONE card, so the answer is absorbed into the question above it.
  const START = /^\s*(?:\d+\s*[.)]|[-*•‣▪])\s*|^\s*(?:Q|Question)\s*[:.]\s*/i;
  // Stripped from a continuation line before it is folded in.
  const ANSWER = /^\s*(?:A|Answer)\s*[:.]\s*/i;

  let units = 0;
  let current: string | null = null;

  const flush = () => {
    if (current !== null && wordCount(current) >= MIN_WORDS_PER_UNIT) units++;
    current = null;
  };

  for (const line of lines) {
    if (START.test(line)) {
      flush();
      current = line.replace(START, '');
    } else if (current !== null) {
      // Continuation: the answer, or a wrapped second line of the same item.
      current += ` ${line.replace(ANSWER, '')}`;
    }
  }
  flush();

  return units;
}

/**
 * How many good cards a piece of text can support.
 *
 * The higher of the two measures wins — prose is limited by word count, dense
 * notes by how many distinct things they actually contain — but never more than
 * one card per MIN_WORDS_PER_ITEM_FLOOR words, so structure alone cannot
 * manufacture cards out of nothing.
 */
export function supportedFor(text: string): number {
  const words = wordCount(text);
  const byWords = Math.floor(words / WORDS_PER_ITEM);
  const byStructure = Math.min(countAtomicUnits(text), Math.floor(words / MIN_WORDS_PER_ITEM_FLOOR));
  return Math.max(byWords, byStructure);
}

/** "Your notes support about N good cards." */
export function estimateSupported(pages: PageInput[]): number {
  return pages
    .filter((p) => p.readability >= MIN_READABILITY)
    .reduce((sum, p) => sum + supportedFor(p.text), 0);
}

/**
 * Split usable pages into sections by heading, falling back to fixed-size word
 * windows when the notes have no headings (loose lecture notes, photographed
 * pages). A section never spans an unreadable page.
 */
export function splitIntoSections(
  pages: PageInput[],
): { title: string; pages: number[]; words: number; capacity: number }[] {
  const usable = pages
    .filter((p) => p.readability >= MIN_READABILITY)
    .sort((a, b) => a.page_index - b.page_index);

  if (usable.length === 0) return [];

  type Section = { title: string; pages: number[]; words: number; capacity: number };
  const hasHeadings = usable.some((p) => p.headings.length > 0);

  if (hasHeadings) {
    const sections: Section[] = [];
    let current: Section | null = null;

    for (const page of usable) {
      const heading = page.headings[0];
      if (heading || current === null) {
        current = { title: heading ?? 'Your notes', pages: [], words: 0, capacity: 0 };
        sections.push(current);
      }
      current.pages.push(page.page_index);
      current.words += wordCount(page.text);
      // Capacity is measured per page and summed, so a dense Q&A page and a
      // prose page in the same section each contribute on their own terms.
      current.capacity += supportedFor(page.text);
    }
    return sections.filter((s) => s.words > 0);
  }

  // --- fallback: ~400-word windows ----------------------------------------
  const sections: Section[] = [];
  let current: Section = { title: 'Your notes', pages: [], words: 0, capacity: 0 };

  for (const page of usable) {
    const words = wordCount(page.text);
    if (current.words >= FALLBACK_WINDOW_WORDS && current.pages.length > 0) {
      sections.push(current);
      current = { title: 'Your notes', pages: [], words: 0, capacity: 0 };
    }
    current.pages.push(page.page_index);
    current.words += words;
    current.capacity += supportedFor(page.text);
  }
  if (current.pages.length > 0 && current.words > 0) sections.push(current);

  return sections.map((s, i) =>
    sections.length > 1 ? { ...s, title: `Part ${i + 1}` } : s,
  );
}

/**
 * Split a total into the 50/30/20 tier mix.
 *
 * Uses largest-remainder so the parts always sum to exactly `total` — naive
 * rounding of each tier independently drifts, and a budget that does not sum
 * lets a section quietly produce more items than the plan allowed.
 */
export function allocateTiers(total: number): TierBudget {
  if (total <= 0) return { remember: 0, understand: 0, apply: 0 };

  const levels: Level[] = ['remember', 'understand', 'apply'];
  const exact = levels.map((l) => total * TIER_MIX[l]);
  const floors = exact.map(Math.floor);
  let remainder = total - floors.reduce((a, b) => a + b, 0);

  const order = levels
    .map((level, i) => ({ level, i, frac: exact[i]! - floors[i]! }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const out = { remember: floors[0]!, understand: floors[1]!, apply: floors[2]! };
  for (const { level } of order) {
    if (remainder <= 0) break;
    out[level]++;
    remainder--;
  }
  return out;
}

/**
 * Build the full plan. Persisted on the study set so a refresh mid-generation
 * resumes instead of restarting (Phase 2 acceptance criterion).
 */
export function buildPlan(pages: PageInput[], requested: number): Plan {
  const unreadablePages = pages
    .filter((p) => p.readability < MIN_READABILITY)
    .map((p) => p.page_index)
    .sort((a, b) => a - b);

  const rawSections = splitIntoSections(pages);
  const totalWords = rawSections.reduce((sum, s) => sum + s.words, 0);

  // Kept for diagnostics only — it no longer decides anything. See maxTotal.
  const supported = rawSections.reduce((sum, s) => sum + s.capacity, 0);
  // The number the user chose IS the target.
  //
  // This used to be min(requested, floor(words/70)) per D3. In practice the
  // estimate always won: 251 words of dense prose yielded 3 cards whether you
  // asked for 10 or for 60, which made the picker decoration and under-served
  // notes that plainly held more. Asking a student to choose and then ignoring
  // the choice is worse than not asking.
  //
  // Anti-padding — D3's actual concern — has not been abandoned, it has moved
  // to where it belongs: the generation prompt instructs the model to return
  // FEWER items when the text does not support the budget, dedup drops
  // near-identical prompts, and excerpt verification drops anything invented.
  // Those act on what was really written, rather than guessing from word count.
  const maxTotal = Math.max(0, requested);

  if (maxTotal === 0 || rawSections.length === 0) {
    return {
      sections: [],
      unreadablePages,
      totalWords,
      supported,
      requested,
      maxTotal,
    };
  }

  // Proportional share by words, largest-remainder again so the section totals
  // sum to exactly maxTotal and never exceed the user's cap.
  const eligible = rawSections.filter((s) => s.words >= MIN_WORDS_FOR_ITEM);
  const pool = eligible.length > 0 ? eligible : rawSections;

  // Share out by capacity so a dense Q&A section is not starved in favour of a
  // wordier prose section that actually supports fewer distinct cards. Falls
  // back to words when nothing has measurable structure.
  const totalCapacity = pool.reduce((sum, s) => sum + s.capacity, 0);
  const useCapacity = totalCapacity > 0;
  const weightOf = (s: (typeof pool)[number]) => (useCapacity ? s.capacity : s.words);
  const poolWeight = pool.reduce((sum, s) => sum + weightOf(s), 0) || 1;

  const exact = pool.map((s) => (weightOf(s) / poolWeight) * maxTotal);
  const counts = exact.map((v) => Math.max(s0(v), 0));
  let assigned = counts.reduce((a, b) => a + b, 0);

  // Hand out what rounding left over, biggest fractional part first.
  const byFrac = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  let leftover = maxTotal - assigned;
  for (const { i } of byFrac) {
    if (leftover <= 0) break;
    counts[i] = (counts[i] ?? 0) + 1;
    leftover--;
  }
  // If still short (many tiny sections floored to 0), top up in word order.
  if (leftover > 0) {
    const byWords = pool.map((s, i) => ({ i, w: s.words })).sort((a, b) => b.w - a.w);
    while (leftover > 0) {
      for (const { i } of byWords) {
        if (leftover <= 0) break;
        counts[i] = (counts[i] ?? 0) + 1;
        leftover--;
      }
    }
  }

  // Trim if largest-remainder overshot (possible when min-1 rules interact).
  assigned = counts.reduce((a, b) => a + b, 0);
  let excess = assigned - maxTotal;
  if (excess > 0) {
    const bySmall = pool.map((s, i) => ({ i, w: s.words })).sort((a, b) => a.w - b.w);
    for (const { i } of bySmall) {
      while (excess > 0 && (counts[i] ?? 0) > 0) {
        counts[i] = (counts[i] ?? 0) - 1;
        excess--;
      }
      if (excess <= 0) break;
    }
  }

  const sections: PlannedSection[] = pool.map((s, i) => {
    const total = counts[i] ?? 0;
    return {
      id: `s${i}-${s.pages[0] ?? 0}`,
      title: s.title,
      pages: s.pages,
      words: s.words,
      total,
      budget: allocateTiers(total),
    };
  });

  return {
    sections: sections.filter((s) => s.total > 0),
    unreadablePages,
    totalWords,
    supported,
    requested,
    maxTotal,
  };
}

/** Floor, but a section with enough words is worth at least one item (§3.2.2). */
function s0(v: number): number {
  return Math.floor(v);
}
