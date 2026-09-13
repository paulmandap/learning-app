/**
 * Where in the notes the cards come from, and how many are still owed.
 *
 * Pure. No react-native, no database, no model.
 *
 * ## Why this exists (NOTES §37)
 *
 * The owner pasted a long song and asked for 10 cards. The model wrote 2, both
 * from the first six of 104 lines, and nothing asked it to look further. Asked
 * for 60, it wrote 15, none from the last quarter of the text, and three facts
 * came back twice. A request that says only "write N items from these notes"
 * lets the model stop early and stay near the top — so a request now says how
 * many to take from each PART of the text, and `validateItems` holds it to that.
 *
 * The prompt asks; the validator checks. A band quota with no check behind it
 * would be a wish.
 */
import { normalize, splitSentences, wordCount } from './text';

/** A sentence, by where it is: the same address a card cites. */
export interface SentenceRef {
  page: number;
  sentence: number;
}

/** A contiguous run of sentences, inclusive at both ends. */
export interface SentenceSpan {
  from: SentenceRef;
  to: SentenceRef;
}

export interface Line extends SentenceRef {
  text: string;
  words: number;
}

/** A part of the notes, and how many cards to take from it. */
export interface Band extends SentenceSpan {
  quota: number;
}

/**
 * Roughly how many lines one part of the text covers.
 *
 * Twelve: a verse, a paragraph, a short list. Few enough that "take 2 from
 * here" pins a card to a place, many enough that a part is not a single line
 * with nothing in it.
 */
export const LINES_PER_BAND = 12;

export function compareRef(a: SentenceRef, b: SentenceRef): number {
  return a.page - b.page || a.sentence - b.sentence;
}

export function inSpan(ref: SentenceRef, span: SentenceSpan): boolean {
  return compareRef(ref, span.from) >= 0 && compareRef(ref, span.to) <= 0;
}

/**
 * Every sentence of these pages, in reading order — optionally only those in a
 * span. Uses the same `splitSentences` as the prompt's numbering and the
 * validator's lookup, so a line number means one thing everywhere.
 */
export function flattenLines(
  pages: readonly { page_index: number; text: string }[],
  span?: SentenceSpan,
): Line[] {
  const out: Line[] = [];
  for (const page of [...pages].sort((a, b) => a.page_index - b.page_index)) {
    splitSentences(page.text).forEach((text, sentence) => {
      const ref = { page: page.page_index, sentence };
      if (span && !inSpan(ref, span)) return;
      out.push({ ...ref, text, words: Math.max(1, wordCount(text)) });
    });
  }
  return out;
}

/**
 * Split `total` across `weights` so the parts sum to exactly `total`.
 *
 * Largest remainder, like `allocateTiers`. `minEach` guarantees every entry at
 * least that many when there is enough to go round — a part of the text that
 * gets zero cards is a part nobody asked about.
 */
export function shareOut(total: number, weights: readonly number[], minEach = 0): number[] {
  const n = weights.length;
  if (n === 0 || total <= 0) return weights.map(() => 0);

  const base = total >= n * minEach ? minEach : 0;
  const out = weights.map(() => base);
  const rest = total - base * n;

  const clean = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
  const sum = clean.reduce((a, b) => a + b, 0);
  const exact = clean.map((w) => (sum > 0 ? (w / sum) * rest : rest / n));

  let left = rest;
  exact.forEach((x, i) => {
    const whole = Math.floor(x + 1e-9);
    out[i]! += whole;
    left -= whole;
  });
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i]!++;
    left--;
  }
  return out;
}

function splitEvenly<T>(items: readonly T[], parts: number): T[][] {
  const size = items.length / parts;
  const out: T[][] = [];
  for (let i = 0; i < parts; i++) {
    out.push(items.slice(Math.round(i * size), Math.round((i + 1) * size)));
  }
  return out.filter((group) => group.length > 0);
}

const refOf = (line: Line): SentenceRef => ({ page: line.page, sentence: line.sentence });

/**
 * Contiguous parts of the text, each asked for its share of `total`.
 *
 * Never more parts than cards, so every part is asked for at least one. Shares
 * follow word count, so a part of short lines is not asked for as much as a
 * part of long ones.
 */
export function planBands(lines: readonly Line[], total: number, linesPerBand = LINES_PER_BAND): Band[] {
  if (lines.length === 0 || total <= 0) return [];
  const count = Math.max(1, Math.min(total, Math.ceil(lines.length / linesPerBand)));
  const groups = splitEvenly(lines, count);
  const quotas = shareOut(
    total,
    groups.map((g) => g.reduce((n, l) => n + l.words, 0)),
    1,
  );
  return groups.map((g, i) => ({ from: refOf(g[0]!), to: refOf(g[g.length - 1]!), quota: quotas[i]! }));
}

/** Contiguous spans of roughly equal length — how a big request is split into parts. */
export function splitSpans(lines: readonly Line[], parts: number): { span: SentenceSpan; words: number }[] {
  if (lines.length === 0 || parts <= 0) return [];
  return splitEvenly(lines, Math.min(parts, lines.length)).map((g) => ({
    span: { from: refOf(g[0]!), to: refOf(g[g.length - 1]!) },
    words: g.reduce((n, l) => n + l.words, 0),
  }));
}

/** Which band a citation falls in, or -1 when it is outside all of them. */
export function bandIndex(bands: readonly Band[], ref: SentenceRef): number {
  return bands.findIndex((b) => inSpan(ref, b));
}

/** "[PAGE 0] lines 12–23", in the same terms the numbered notes use. */
export function describeBand(band: SentenceSpan): string {
  const { from, to } = band;
  if (from.page === to.page) {
    return from.sentence === to.sentence
      ? `[PAGE ${from.page}] line ${from.sentence}`
      : `[PAGE ${from.page}] lines ${from.sentence}–${to.sentence}`;
  }
  return `[PAGE ${from.page}] line ${from.sentence} to [PAGE ${to.page}] line ${to.sentence}`;
}

/**
 * Share `n` more cards across the bands, most to the parts with fewest so far.
 *
 * A fill pass that spread its cards evenly would keep whatever lopsidedness the
 * first pass left: in the reproduction nothing came from the last quarter of
 * the song, and an even top-up would have left it the thinnest part.
 */
export function fillQuotas(bands: readonly Band[], existing: readonly number[], n: number): Band[] {
  const shares = bands.map((b) => b.quota);
  const totalShare = shares.reduce((a, b) => a + b, 0) || 1;
  const current = existing.reduce((a, b) => a + b, 0);
  const deficits = bands.map((_, i) =>
    Math.max(0, (shares[i]! / totalShare) * (current + n) - (existing[i] ?? 0)),
  );
  const quotas = shareOut(n, deficits.some((d) => d > 0) ? deficits : shares);
  return bands.map((b, i) => ({ ...b, quota: quotas[i]! }));
}

/**
 * Which line a stored card's quote starts at, or -1.
 *
 * A card stores its quote, not the line number it cited. The quote is either
 * that line or the line with a neighbour either side (`resolveSource`), so it
 * begins with a whole line of the page — which is enough to count where a set's
 * cards already come from.
 */
export function locateExcerpt(pageText: string, excerpt: string): number {
  const lines = splitSentences(pageText).map(normalize);
  const target = normalize(excerpt);
  const exact = lines.indexOf(target);
  if (exact >= 0) return exact;
  return lines.findIndex((line) => line.length > 0 && target.startsWith(`${line} `));
}

/**
 * Cards still owed, section by section.
 *
 * The shortfall goes first to the sections furthest below what they were
 * planned to hold; if they are all at their share (a card was dropped from a
 * section that then refilled elsewhere), it follows the plan's own weights.
 */
export function shortfallBySection(
  sections: readonly { id: string; total: number }[],
  have: ReadonlyMap<string, number>,
  short: number,
): Map<string, number> {
  const deficits = sections.map((s) => Math.max(0, s.total - (have.get(s.id) ?? 0)));
  const weights = deficits.some((d) => d > 0) ? deficits : sections.map((s) => s.total);
  const shares = shareOut(Math.max(0, short), weights);
  return new Map(sections.map((s, i) => [s.id, shares[i]!]));
}

/** How a line is known in a set of lines: "0:12". */
export function lineKey(ref: SentenceRef): string {
  return `${ref.page}:${ref.sentence}`;
}

/** "[PAGE 0] lines 3, 6, 7" — lines named one by one, page by page. */
export function describeLines(refs: readonly SentenceRef[]): string {
  const byPage = new Map<number, number[]>();
  for (const ref of [...refs].sort(compareRef)) {
    byPage.set(ref.page, [...(byPage.get(ref.page) ?? []), ref.sentence]);
  }
  return [...byPage]
    .map(([page, lines]) => `[PAGE ${page}] ${lines.length === 1 ? 'line' : 'lines'} ${lines.join(', ')}`)
    .join('; ');
}
