/**
 * Fill-in-the-blank (spec §6 "Later": fill-in-the-blank; D5's postponement).
 *
 * Pure and deterministic — no react-native, no expo-*, no model call. A blank is
 * cut out of the student's own notes, and grading compares two short strings.
 *
 * ## Why D5 postponed this, and what actually changes here
 *
 * D5: *"Exact-match grading of free typing frustrates ('ATP' vs 'adenosine
 * triphosphate'); auto-generated blanks are low value."* Two separate objections
 * needing two separate answers.
 *
 * **The blanks.** They are low value when a machine picks a word out of a
 * sentence at random. Here the gap is the card's own answer, so it is always the
 * thing the card was already asking about — and it is cut from the notes rather
 * than written by the model, so the expected text is the student's own wording.
 * That is what shrinks the "ATP" vs "adenosine triphosphate" problem: the gap
 * expects whichever of the two the notes use, inside the sentence they read.
 *
 * **The grading.** This is the part that had to be measured rather than
 * asserted, and the measurement said the specified design does not work. See
 * `gradeTypedAnswer`: no character-similarity threshold can separate a typo from
 * a near-miss the student must not be told they got right, so nothing but an
 * exact match is auto-accepted and the ambiguous band becomes one tap.
 */

import { diceCoefficient, normalize } from './text';

/** What a gap looks like in the rendered sentence. */
export const BLANK = '_____';

/**
 * Longest answer that may become a blank.
 *
 * Three words, and the reason is D5 rather than tidiness: the longer the
 * expected text, the more ways there are to write it correctly and still be
 * marked wrong. One to three words is a term, and a term has few spellings.
 * Anything longer is a sentence, and grading sentences by string comparison is
 * exactly the frustration D5 refused. Measured on real generated cards, this
 * cut-off is also where the supply is — see `ARCHITECTURE_NOTES.md` §9.
 */
export const MAX_BLANK_WORDS = 3;

/**
 * Words that must survive around the gaps for the sentence to still be a question.
 *
 * "support & _____" is not a fill-in-the-blank, it is a coin toss. Four words of
 * remaining context is the floor at which the sentence still says what it wants.
 */
export const MIN_CONTEXT_WORDS = 4;

/**
 * Below this, two answers share too little to be worth a second look.
 *
 * NOT an accept threshold — see `gradeTypedAnswer`. It decides only whether the
 * student is *offered* the benefit of the doubt, so a bad value here costs one
 * tap rather than a wrong grade. Set at 0.5 because the lowest score measured
 * for a genuine single-character typo was 0.571 ("stoma" typed "stma"), and a
 * five-letter term is about as short as a real answer gets.
 */
export const NEAR_MISS_THRESHOLD = 0.5;

/**
 * Articles are dropped from the front of an answer, everywhere in this module.
 *
 * Two jobs, both load-bearing. When locating the gap: real cards answer "The
 * mesophyll." while the notes say "the internal mesophyll", so matching the
 * article along with the term loses the card — measured, it lost 2 of 6
 * otherwise-usable blanks. When grading: "leaf" and "the leaf" are the same
 * answer, and an article cannot change which structure is meant.
 */
const ARTICLES = new Set(['the', 'a', 'an']);

/**
 * Enough of a grammatical skeleton to tell a sentence from a list of labels.
 *
 * A transcribed diagram reads "FRUIT seed dispersal structure STEM" — four
 * words, so it clears the context floor, and blanking one label leaves
 * "_____ seed dispersal structure STEM", which is noise rather than a question.
 * Real prose always carries at least one of these; a label dump carries none.
 *
 * Not a diagram-only problem, which is why it is worth a rule: glossaries,
 * vocabulary lists and any term/definition notes have the same shape
 * (`ARCHITECTURE_NOTES.md` §6.2).
 */
const FUNCTION_WORDS = new Set([
  'the','a','an','of','in','on','at','to','for','from','by','with','into','through','over',
  'is','are','was','were','be','been','being','has','have','had','do','does','did',
  'and','or','but','that','which','while','when','because','as','than','then','if','so',
  'its','their','it','they','this','these','those','not','no','can','may','will','each',
]);

export type ClozeReject =
  /** Only flashcards become blanks: MCQ has options, short answers have rubrics. */
  | 'not_flashcard'
  | 'answer_too_long'
  /** The answer is nowhere in the cited sentence, so there is nothing to cut out. */
  | 'answer_not_in_notes'
  | 'too_little_context'
  /** The excerpt is a list of labels, not a sentence with a gap in it. */
  | 'not_a_sentence';

export interface Cloze {
  /** The notes' own sentence, with every occurrence of the answer replaced by BLANK. */
  text: string;
  /** What belongs in the gap, spelled as the NOTES spell it, not as the model did. */
  answer: string;
  /** The untouched sentence, so the answer can be shown back in place. */
  source: string;
  /** Where the answer sits in `source`, for highlighting the reveal. */
  spans: { start: number; end: number }[];
}

export type ClozeResult = { ok: true; cloze: Cloze } | { ok: false; reason: ClozeReject };

/**
 * A word, and where it sits in the ORIGINAL string.
 *
 * Matching happens over words rather than characters because both ends are
 * messy in ways characters cannot absorb: the model writes "The mesophyll."
 * where the notes write "the internal mesophyll", so the needle carries an
 * article and a full stop the haystack does not have. Comparing token runs
 * makes punctuation, case and spacing irrelevant by construction, and the
 * offsets still point back into the untouched sentence — which is what lets the
 * gap be cut without disturbing anything around it.
 *
 * Hyphens and apostrophes join a word rather than splitting it, so "sino-atrial"
 * and "Bowman's" each stay one token.
 */
interface Word {
  text: string;
  start: number;
  end: number;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’‘\-‐-―][\p{L}\p{N}]+)*/gu;

function words(input: string): Word[] {
  const out: Word[] = [];
  // A fresh regex per call: /g regexes carry lastIndex between calls, which is
  // the same trap text.ts documents for its own single-character classes.
  const re = new RegExp(WORD_RE.source, WORD_RE.flags);
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    out.push({ text: normalize(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** The answer's words, with any leading article removed. */
function answerWords(answer: string): string[] {
  const list = words(answer).map((w) => w.text);
  return list.length > 1 && ARTICLES.has(list[0]!) ? list.slice(1) : list;
}

/**
 * Turn one flashcard into a fill-in-the-blank, or say why it cannot be one.
 *
 * The gap is cut from `sourceExcerpt` — text the app resolved from the user's
 * own stored notes (see `resolveSource`), never text the model wrote. A blank
 * therefore inherits the grounding guarantee the source chip has: the sentence
 * around the gap provably came from the notes.
 *
 * Every occurrence of the answer is blanked, not just the first. A sentence that
 * shows the word once and hides it once is not a question.
 */
export function makeCloze(input: {
  kind: string;
  answer: string;
  sourceExcerpt: string;
}): ClozeResult {
  if (input.kind !== 'flashcard') return { ok: false, reason: 'not_flashcard' };

  const needle = answerWords(input.answer);
  if (needle.length === 0 || needle.length > MAX_BLANK_WORDS) {
    return { ok: false, reason: 'answer_too_long' };
  }

  const hay = words(input.sourceExcerpt);

  // Every run of consecutive words in the sentence that spells the answer.
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let hit = true;
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j]!.text !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;
    spans.push({ start: hay[i]!.start, end: hay[i + needle.length - 1]!.end });
    i += needle.length - 1; // never overlap two gaps
  }

  if (spans.length === 0) return { ok: false, reason: 'answer_not_in_notes' };

  // Rebuild the sentence with gaps where the answer was.
  let text = '';
  let cursor = 0;
  for (const span of spans) {
    text += input.sourceExcerpt.slice(cursor, span.start) + BLANK;
    cursor = span.end;
  }
  text += input.sourceExcerpt.slice(cursor);

  // What is left around the gaps has to still be a question. Two tests: enough
  // of it, and enough grammar in it to be a sentence rather than a label list.
  const blanked = new Set(spans.map((s) => s.start));
  const context: string[] = [];
  for (let i = 0; i < hay.length; i++) {
    const w = hay[i]!;
    if (blanked.has(w.start)) {
      i += needle.length - 1;
      continue;
    }
    context.push(w.text);
  }

  if (context.length < MIN_CONTEXT_WORDS) return { ok: false, reason: 'too_little_context' };
  if (!context.some((w) => FUNCTION_WORDS.has(w))) {
    return { ok: false, reason: 'not_a_sentence' };
  }

  return {
    ok: true,
    cloze: {
      text,
      // The notes' spelling, not the model's. This is the whole reason the gap
      // is cut from the source: the student is asked for the word they read.
      answer: input.sourceExcerpt.slice(spans[0]!.start, spans[0]!.end),
      source: input.sourceExcerpt,
      spans,
    },
  };
}

/**
 * `correct` — indistinguishable from the expected answer.
 * `near` — close enough that the student should be asked, not told.
 * `incorrect` — nothing like it.
 */
export type TypedVerdict = 'correct' | 'near' | 'incorrect';

export interface TypedGrade {
  verdict: TypedVerdict;
  /** Bigram-Dice similarity, 0..1. Diagnostic only — it never decides `correct`. */
  score: number;
}

/**
 * Comparison form: words only, lowercased, no punctuation, no leading article.
 *
 * Hyphens and apostrophes are split here rather than joined, unlike `words`,
 * because hyphenation is orthographic — "sino-atrial" and "sino atrial" are the
 * same answer, and a student should not lose a card to a punctuation choice.
 */
function comparable(input: string): string {
  const list = (input.match(/[\p{L}\p{N}]+/gu) ?? []).map((w) => normalize(w));
  const trimmed = list.length > 1 && ARTICLES.has(list[0]!) ? list.slice(1) : list;
  return trimmed.join(' ');
}

/**
 * Grade a typed answer against the word the notes use.
 *
 * ## The specified rule was measured and does not work
 *
 * The roadmap called for `normalize` + the bigram-Dice matcher from
 * `excerpt.ts` at ≥ 0.85, "so 'ATP' vs 'atp.' passes and a typo does not fail
 * you". Over 49 hand-built cases (2026-09-05, `ARCHITECTURE_NOTES.md` §9) that
 * rule scored 28/49, with **20 false rejects**:
 *
 *   - Its own headline example fails. "ATP" vs "atp." scores **0.800**, because
 *     `normalize` deliberately keeps punctuation. Comparing words instead of
 *     raw normalised text fixes that one case, which is what `comparable` does.
 *   - "a typo does not fail you" is false: **12 of 16** single-character typos
 *     scored below 0.85. "ribosome" typed "ribsoome" is 0.714.
 *   - Fatally, the two populations OVERLAP. "afferent" vs "efferent" — two
 *     structures a student must tell apart — scores **0.857 and would be marked
 *     RIGHT**, while the genuine typo "photosynthasis" scores 0.846 and would
 *     be marked wrong.
 *
 * That last point is not a threshold in need of tuning. A one-character typo and
 * a minimal-pair confusable are *the same edit distance apart*, so no measure
 * over characters can separate them. Any band wide enough to forgive typing is
 * wide enough to accept "efferent" for "afferent" — and being told a wrong
 * answer was right is worse than the frustration D5 set out to avoid.
 *
 * ## So nothing is auto-accepted but an exact match
 *
 * Exact after dropping case, punctuation and a leading article — none of which
 * can change which thing is meant — is `correct`. Anything else with real
 * overlap is `near`: the student is shown the expected word and asked whether
 * they had it. That is one tap, and it is the same self-report the Missed /
 * Got it buttons have always run on, so it is not a new kind of trust.
 *
 * The threshold therefore decides only who is *offered* that tap. Getting it
 * wrong costs a tap, never a grade — which is what makes the feature shippable
 * on a matcher that measurably cannot do the job it was specified for.
 */
export function gradeTypedAnswer(typed: string, expected: string): TypedGrade {
  const t = comparable(typed);
  const e = comparable(expected);

  if (e.length === 0 || t.length === 0) return { verdict: 'incorrect', score: 0 };
  if (t === e) return { verdict: 'correct', score: 1 };

  const score = diceCoefficient(t, e);
  return { verdict: score >= NEAR_MISS_THRESHOLD ? 'near' : 'incorrect', score };
}
