/**
 * The study assistant's limits and context handling (Phase 9c).
 *
 * Pure and deterministic. Nothing here talks to Gemini or to the database — it
 * decides what the assistant is allowed to see, how much of it, and what to say
 * when the day's allowance runs out.
 *
 * ## Why an extra needs a budget at all
 *
 * Making cards is the product; the assistant is a convenience beside it. They
 * draw on the same free-tier allowance, and that allowance is **per Google
 * project, not per key or per device** (`ARCHITECTURE_NOTES.md` §2.2). So an
 * afternoon of chatting can cost someone the cards they actually came for, on a
 * different device, with no visible connection between the two.
 *
 * Three limits, and each does a different job:
 *
 *  - a **short reply**, so no single answer is expensive;
 *  - a **bounded context**, so no single question is expensive;
 *  - a **daily count**, so no number of cheap questions adds up to the cards.
 *
 * The first two live here. The third is a database row, because a counter in
 * one browser cannot bound a quota shared across devices — see migration 0010.
 */

/**
 * Questions per day.
 *
 * Twenty. Generous for asking about what you are studying, and bounded: at the
 * context and reply sizes below, a full day of questions costs roughly what
 * generating one study set costs. That is the comparison that matters — the cap
 * is set so the assistant can never quietly become the more expensive half.
 */
export const DAILY_MESSAGE_LIMIT = 20;

/**
 * Ceiling on `maxOutputTokens` for a reply.
 *
 * ## This is a truncation guard, NOT a spend control — measured
 *
 * The obvious reading is that a small number here makes each answer cheap. It
 * does not, and the first version of this file was built on that mistake.
 *
 * On Gemini 3.x, **`maxOutputTokens` budgets the model's internal thinking AND
 * the answer together**. Measured live on 2026-09-05 with a realistic prompt:
 *
 * | Cap | Model | Thinking | Answer | Result |
 * |---|---|---|---|---|
 * | 320 | 3.7-flash | 303 | 76 chars | **MAX_TOKENS — cut mid-sentence** |
 * | 640 | 3.7-flash | 511 | 42 tok | STOP, complete |
 * | 640 | 3.5-flash-lite | 0 | 46 tok | STOP, complete |
 *
 * At 320 the thinking consumed the whole budget and the student got half a
 * sentence — or, with a longer prompt, nothing at all and "I couldn't come up
 * with an answer to that one". The thinking tokens are spent either way, so a
 * low cap does not save them; it only throws away the answer they paid for.
 * `thinkingConfig: { thinkingBudget: 0 }` was tried and is ignored by these
 * models — thinking still ran to 303 tokens.
 *
 * So this is set generously, and the real cost controls are the two that
 * actually bound spend: the daily message count, and the four-sentence rule in
 * the prompt that keeps the answer itself short.
 */
export const MAX_REPLY_TOKENS = 1024;

/**
 * How much of the notes one question may carry.
 *
 * The notes are the expensive part of an ungrounded-versus-grounded trade: send
 * none and the answer is worse than the Gemini web app, send everything and one
 * question costs more than a section of generation. Four thousand characters is
 * roughly a page — enough to answer "how does this relate to that", far short of
 * a whole document.
 */
export const MAX_NOTES_CHARS = 4000;

/** Longest question accepted. Past this it is an essay, not a question. */
export const MAX_QUESTION_CHARS = 500;

/** Remaining questions at or below which the screen starts saying so. */
export const LOW_REMAINING = 5;

/**
 * What the assistant can see, decided by where it was opened.
 *
 * Two contexts rather than one, at the owner's choice: on a study screen the
 * card in front of you is almost always what the question is about, and sending
 * a page of notes to answer "why is this the answer?" would be paying for
 * context the question does not need.
 */
export type AssistantContext =
  | {
      kind: 'card';
      /** The question as the student is being shown it. */
      prompt: string;
      answer: string;
      /** The sentence from their own notes that grounds it. */
      source: string;
    }
  | { kind: 'set'; title: string; notes: string }
  | { kind: 'none' };

/**
 * Cut notes to the budget on a sentence-ish boundary.
 *
 * Cutting mid-word leaves the model finishing a fragment, which reads as though
 * the notes themselves are damaged. Falling back to a hard cut matters for
 * transcribed diagrams, which can be one long line with no full stop in it.
 */
export function trimNotes(notes: string, max: number = MAX_NOTES_CHARS): string {
  const clean = notes.trim();
  if (clean.length <= max) return clean;

  const cut = clean.slice(0, max);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  // Only honour the boundary if it is not so far back that most of the budget
  // is thrown away.
  return (lastStop > max * 0.6 ? cut.slice(0, lastStop + 1) : cut).trim();
}

/** Is this worth spending a question on? A cheap gate, not a judgement. */
export function isAskable(question: string): boolean {
  const clean = question.trim();
  return clean.length >= 3 && clean.length <= MAX_QUESTION_CHARS;
}

/**
 * What to say about the allowance, or nothing at all.
 *
 * Silent until it is nearly gone. The owner asked not to be told about limits
 * every time, and a counter sitting on screen through nineteen unremarkable
 * questions is exactly that — it makes an allowance feel like a meter running.
 *
 * No jargon: never "quota", "tokens" or "rate limit". A student is being told
 * how many more questions they can ask today, which is the only part that
 * concerns them.
 */
export function describeRemaining(remaining: number): string | null {
  if (remaining < 0) {
    return "That's all the questions for today — they come back tomorrow.";
  }
  if (remaining === 0) {
    return 'That was your last question for today. More tomorrow.';
  }
  if (remaining <= LOW_REMAINING) {
    return `${remaining} more question${remaining === 1 ? '' : 's'} today.`;
  }
  return null;
}
