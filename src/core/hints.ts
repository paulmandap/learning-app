/**
 * Hints, when the student is stuck on a card (NOTES §69). Pure: tested in
 * tests/hints.test.ts.
 *
 * The owner: *"maybe when the user is stuck for some seconds on the flashcard,
 * quiz, fill in the blanks, nomi can give hints."* His choices, put to him with
 * the options: after **20 seconds**; Nomi beside the count **asks, and the hint
 * shows only on a tap**, so it never spoils a card he was about to get; a
 * **quick clue first** — instant, free, from the answer itself — then "a bigger
 * hint" from Gemini if he wants more; and a right answer after a hint **counts
 * as right but comes back sooner** (`nextState`'s `hinted`).
 *
 * ## The quick clue, by the shape of the answer
 *
 * - A short answer (four words or fewer, a leading "the" or "a" aside): its
 *   first letter and its length — "It starts with “M”. One word, 9 letters."
 *   The classic hangman nudge. "The mesophyll." starting with "T" helped
 *   nobody — measured on the first run of `scripts/hint-probe.ts`.
 * - A longer one: the first letter of every word, the way people learn a
 *   passage by heart. Its opening words were the first try, and on these cards
 *   they are filler — "It starts with “It serves…”".
 * - A choice: two wrong choices crossed out (`crossOut`), leaving the right one
 *   and one other — a fifty-fifty.
 * - A written answer that is marked on points: how many points it should cover.
 *
 * ## The bigger hint, and the check behind it
 *
 * Gemini is asked for a nudge that does not say the answer. The prompt asks;
 * `givesAway` checks. On the first run it caught nothing and one hint did say
 * the answer — "The root collar marks this transition area." for "The root
 * collar, marked by a dashed line." — because a longer answer was only checked
 * whole. Now any two of its key words side by side, or one long distinctive
 * word, give it away too.
 */
import { normalize } from './text';
import { shuffleSeeded } from './grade';

/** How long on one card counts as stuck. */
export const HINT_AFTER_MS = 20_000;

/** Up to this many words an answer is short, and gets a letter-count clue. */
export const SHORT_ANSWER_WORDS = 4;

/** A word this long is distinctive enough that naming it names the answer. */
const DISTINCTIVE_LETTERS = 8;

/** The most first letters a long answer's clue lists. */
const MOST_LETTERS = 12;

/** Words that carry no clue, and are never a give-away. */
const SMALL = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'and', 'or', 'is', 'are', 'was', 'were', 'it', 'its',
  'they', 'them', 'their', 'by', 'for', 'as', 'with', 'from', 'that', 'this', 'be',
]);

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four'];

function wordsOf(answer: string): string[] {
  return answer.trim().split(/\s+/).filter(Boolean);
}

/** Letters and digits only — "cell's" is 5 letters, "ATP," is 3. */
function bare(word: string): string {
  return word.replace(/[^\p{L}\p{N}]/gu, '');
}

/** The answer's words without a leading "the", "a" or "an" — never all of them. */
function withoutArticle(words: string[]): string[] {
  return words.length > 1 && ['the', 'a', 'an'].includes(bare(words[0]!).toLowerCase()) ? words.slice(1) : words;
}

/**
 * The quick clue for a typed or remembered answer — a flashcard's, or a blank's.
 * Null when there is nothing to go on.
 */
export function quickClue(answer: string): string | null {
  const all = wordsOf(answer).filter((w) => bare(w).length > 0);
  if (all.length === 0) return null;
  const words = withoutArticle(all);

  if (words.length <= SHORT_ANSWER_WORDS) {
    const first = bare(words[0]!)[0]!.toUpperCase();
    const starts = `It starts with “${first}”.`;
    if (words.length === 1) return `${starts} One word, ${bare(words[0]!).length} letters.`;
    const counts = words.map((w) => bare(w).length);
    return `${starts} ${NUMBER_WORDS[words.length]} words: ${counts.slice(0, -1).join(', ')} and ${counts.at(-1)} letters.`;
  }

  const letters = all.slice(0, MOST_LETTERS).map((w) => bare(w)[0]!);
  return `The first letter of each word: ${letters.join(', ')}${all.length > MOST_LETTERS ? ', …' : '.'}`;
}

/** For a written answer marked on points: how many to cover. */
export function pointsClue(points: number): string | null {
  if (points <= 0) return null;
  return points === 1 ? 'A good answer makes one main point.' : `A good answer covers ${points} points.`;
}

/** What a choice's hint says it did. */
export function crossedClue(crossed: number): string | null {
  if (crossed <= 0) return null;
  return crossed === 1 ? 'One wrong answer is crossed out.' : `${NUMBER_WORDS[crossed] ?? crossed} wrong answers are crossed out.`;
}

/**
 * Which choices to cross out: every wrong one but one, so the right answer and
 * one other are left. The same ones for the same card every time (seeded), so
 * asking twice does not reveal more.
 */
export function crossOut(options: readonly { correct: boolean }[], seed: string): Set<number> {
  const wrong = options.map((o, i) => (o.correct ? -1 : i)).filter((i) => i >= 0);
  if (wrong.length <= 1) return new Set();
  const keep = shuffleSeeded(wrong, `hint:${seed}`)[0]!;
  return new Set(wrong.filter((i) => i !== keep));
}

/** The stem of a word, so a plural or a tense does not slip past: "mitochondri". */
const stem = (w: string) => w.slice(0, Math.max(4, w.length - 2));

/**
 * Does a hint give the answer away?
 *
 * True when it holds the whole answer; any two of the answer's key words side
 * by side ("root collar"); a key word of a short answer ("mitochondrion" for
 * "Mitochondria"); or a long, distinctive word of a longer one
 * ("photosynthetic"). Small words never count — "the" is in every hint.
 */
export function givesAway(hint: string, answer: string): boolean {
  const h = normalize(hint);
  const a = normalize(answer).replace(/[.!?]+$/, '');
  if (!a) return false;
  if (h.includes(a)) return true;

  const words = wordsOf(a).map((w) => bare(w).toLowerCase());
  const key = words.filter((w) => w.length >= 3 && !SMALL.has(w));
  // Two key words together, as the answer has them.
  const hintWords = wordsOf(h).map((w) => bare(w).toLowerCase());
  for (let i = 0; i + 1 < words.length; i++) {
    const [x, y] = [words[i]!, words[i + 1]!];
    if (!key.includes(x) || !key.includes(y)) continue;
    for (let j = 0; j + 1 < hintWords.length; j++) {
      if (hintWords[j]!.startsWith(stem(x)) && hintWords[j + 1]!.startsWith(stem(y))) return true;
    }
  }
  const short = withoutArticle(wordsOf(a)).length <= SHORT_ANSWER_WORDS;
  return key
    .filter((w) => (short ? w.length >= 4 : w.length >= DISTINCTIVE_LETTERS))
    .some((w) => hintWords.some((hw) => hw.startsWith(stem(w))));
}
