/**
 * Every card can be asked in the quiz (NOTES §38).
 *
 * Pure: cards in, answer choices out.
 *
 * ## Why this exists
 *
 * The quiz asked multiple-choice and written questions only — "flashcards have
 * no way to be marked". A set whose cards all came out as flashcards therefore
 * had no quiz at all: measured on the test account, 11 flashcards and 0
 * questions at every level, and the screen opened straight onto "0 of 0 right.
 * No questions at this level yet." with no way to pick another level. The
 * owner: *"why no quiz? everything must have quiz. gemini can think of what to
 * put in the quiz based on the notes."*
 *
 * So a flashcard is asked as a choice between its answer and three wrong ones.
 * Gemini writes the wrong ones from the notes (`src/data/quiz-options.ts`), and
 * `choicesFrom` checks them — the prompt asks, the validator checks. Until they
 * exist, or when they cannot be written, `choicesFromSet` takes them from the
 * other cards' answers, so the quiz is never empty for want of a model call.
 */
import { normalize } from './text';
import { sameAnswer, validateMultipleChoice } from './validate';

export interface Option {
  text: string;
  correct: boolean;
}

export interface QuizCard {
  id: string;
  kind: 'flashcard' | 'mcq' | 'short_answer';
  level: string;
  prompt: string;
  answer: string;
  options: Option[] | null;
  rubric: { expected_concepts: { id: string; text: string }[] } | null;
}

/** Wrong answers per question: four choices in all, the usual shape. */
export const WRONG_CHOICES = 3;

/** A choice longer than this is a paragraph, not a choice. */
export const MAX_CHOICE_CHARS = 120;

/** A written question that can be marked. Everything else is asked as a choice. */
export function isWritten(card: Pick<QuizCard, 'kind' | 'rubric'>): boolean {
  return card.kind === 'short_answer' && (card.rubric?.expected_concepts.length ?? 0) > 0;
}

/** Does this card still need answer choices written for it? */
export function needsChoices(card: Pick<QuizCard, 'kind' | 'rubric' | 'options'>): boolean {
  return !isWritten(card) && (card.options?.length ?? 0) < WRONG_CHOICES;
}

function checked(card: Pick<QuizCard, 'prompt' | 'answer'>, wrong: readonly string[]): Option[] | null {
  const options: Option[] = [
    { text: card.answer.trim(), correct: true },
    ...wrong.map((text) => ({ text, correct: false })),
  ];
  const problem = validateMultipleChoice({
    kind: 'mcq',
    level: 'remember',
    prompt: card.prompt,
    answer: card.answer,
    options,
    page_index: 0,
    source_sentence: 0,
  });
  return problem ? null : options;
}

/**
 * The choices for a card from the wrong answers Gemini wrote, or null.
 *
 * Each wrong answer must be there, short, different from the others, and NOT
 * the right answer in other words — `sameAnswer`, the same rule that keeps two
 * cards from sharing an answer (§37). Then the usual multiple-choice checks.
 * Three survivors or nothing: a question with the right answer and one wrong
 * one is a coin toss.
 */
export function choicesFrom(card: Pick<QuizCard, 'prompt' | 'answer'>, wrong: readonly string[]): Option[] | null {
  const kept: string[] = [];
  for (const raw of wrong) {
    const text = raw.trim();
    if (text.length === 0 || text.length > MAX_CHOICE_CHARS) continue;
    if (sameAnswer(text, card.answer)) continue;
    if (kept.some((k) => normalize(k) === normalize(text) || sameAnswer(k, text))) continue;
    kept.push(text);
  }
  if (kept.length < WRONG_CHOICES) return null;
  return checked(card, kept.slice(0, WRONG_CHOICES));
}

/**
 * Choices taken from the set itself: the other cards' answers.
 *
 * They are facts from the same notes, which is what the generation prompt asks
 * wrong options to be, so this is a fair question even with no model call —
 * weaker than choices written for the card, and never absent. Same level first,
 * then nearest in length, so a one-word answer is not offered among sentences.
 * Null only when the set has too few different answers to choose from.
 */
export function choicesFromSet(card: QuizCard, set: readonly QuizCard[]): Option[] | null {
  const candidates: { text: string; score: number }[] = [];
  for (const other of set) {
    if (other.id === card.id) continue;
    const text = other.answer.trim();
    if (text.length === 0 || text.length > MAX_CHOICE_CHARS || sameAnswer(text, card.answer)) continue;
    if (candidates.some((c) => normalize(c.text) === normalize(text) || sameAnswer(c.text, text))) continue;
    const lengthGap = Math.abs(text.length - card.answer.length) / Math.max(text.length, card.answer.length, 1);
    candidates.push({ text, score: (other.level === card.level ? 0 : 1) + lengthGap });
  }
  candidates.sort((a, b) => a.score - b.score || a.text.localeCompare(b.text));
  const wrong = candidates.slice(0, WRONG_CHOICES).map((c) => c.text);
  if (wrong.length < 2) return null;
  return checked(card, wrong);
}

/** The choices to show: the card's own when it has them, the set's otherwise. */
export function choicesFor(card: QuizCard, set: readonly QuizCard[]): Option[] | null {
  if (card.options && card.options.length >= WRONG_CHOICES) return card.options;
  return choicesFromSet(card, set);
}
