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
 * Replies from Gemini per day.
 *
 * Sixty, raised from twenty when Nomi became a chat (NOTES §36). Twenty was set
 * for one question at a time and priced a whole day at about one study set;
 * the owner asked for everyday conversation, and twenty greetings would spend
 * it before lunch. Sixty prices a worst-case day at under three sets.
 *
 * What makes that affordable is not the number: **Nomi's own answers do not
 * count.** "Hi", "what's my streak", "what's due" and the rest are answered
 * from the app by `src/core/nomi-brain.ts` with no model call at all, so the
 * allowance is only ever spent on replies that need Gemini.
 */
export const DAILY_MESSAGE_LIMIT = 60;

/**
 * How many earlier messages go with each new one.
 *
 * A conversation re-sends its thread on every turn — the cost D14 was written
 * to avoid. Twenty keeps a real conversation's context (about ten exchanges)
 * while a long chat costs the same per message as a short one.
 */
export const HISTORY_WINDOW = 20;

/**
 * When a conversation was last active, the way a messenger's chat list says it:
 * a time today, "Yesterday", a weekday within the week, a date before that.
 * In the phone's own time zone — this is for a person to read, not to compare.
 */
export function describeWhen(ms: number, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(ms) === day(now)) {
    return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  if (day(ms) === day(now - 24 * 60 * 60 * 1000)) return 'Yesterday';
  if (now - ms < 6 * 24 * 60 * 60 * 1000) {
    return new Date(ms).toLocaleDateString('en-US', { weekday: 'long' });
  }
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** One message in a conversation, as the model sees it. */
export interface ChatTurn {
  role: 'user' | 'nomi';
  text: string;
}

/**
 * The most recent turns, starting with something the student said.
 *
 * A window that opened on one of Nomi's replies would hand the model an answer
 * to a question it cannot see.
 */
export function historyWindow(turns: readonly ChatTurn[], limit: number = HISTORY_WINDOW): ChatTurn[] {
  const recent = turns.slice(-limit);
  const firstUser = recent.findIndex((t) => t.role === 'user');
  return firstUser === -1 ? [] : recent.slice(firstUser);
}

/**
 * A conversation's name in the history list: its first message, shortened.
 *
 * The way Claude names a chat, without spending a model call to do it. Cut on a
 * word, so a title never ends half-way through one.
 */
export function conversationTitle(firstMessage: string, max = 60): string {
  const clean = firstMessage.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

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

/** Longest message accepted. A chat message, not an essay pasted in. */
export const MAX_QUESTION_CHARS = 1000;

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

/**
 * Can this be sent? Anything that is not blank and not too long.
 *
 * It used to demand three characters, so the owner could not send "Hi" at all
 * (NOTES §36). That floor existed to stop an empty box spending one of twenty
 * questions; a greeting is now answered by Nomi's own brain and spends
 * nothing, so the floor is gone.
 */
export function isAskable(question: string): boolean {
  const clean = question.trim();
  return clean.length >= 1 && clean.length <= MAX_QUESTION_CHARS;
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
    return "That's all my replies for today — they come back tomorrow. I can still tell you your streak and what's due.";
  }
  if (remaining === 0) {
    return 'That was my last reply for today. More tomorrow.';
  }
  if (remaining <= LOW_REMAINING) {
    return `${remaining} more ${remaining === 1 ? 'reply' : 'replies'} from me today.`;
  }
  return null;
}
