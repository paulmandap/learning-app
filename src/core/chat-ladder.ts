/**
 * How long a chat reply may take, and which model it asks first (NOTES §67).
 * Pure: tested in tests/chat-ladder.test.ts.
 *
 * The owner, with the ✦ panel stuck on "Nomi is thinking…" over a flashcard:
 * *"nomi is taking way too much time to respond ... i think there's a bug."*
 * Measured the same hour: three of the four models on `LIGHT_LADDER` answered
 * 503 "high demand" — the first after 14 s — and one sat for a full minute
 * without answering; only the last rung replied, in about 3 s. A chat message
 * rode the generation settings — 100 s a model, four models, and the queue's
 * whole ladder again after 10 s and 20 s — which is minutes, with nothing said.
 *
 * A reply in a conversation is a few sentences. So a chat call gets its own
 * limits: 15 s a model, 45 s for the whole message, no backoff round after
 * that; and it starts with the model that answered the last message, for ten
 * minutes, so once one rung is found the next reply does not wait on the
 * overloaded ones again. Card-making keeps its own, longer limits.
 */

/** One model's time to answer a chat message. */
export const CHAT_CALL_TIMEOUT_MS = 15_000;
/** The whole message: every model tried, then "busy". */
export const CHAT_DEADLINE_MS = 45_000;
/** How long the model that last answered goes first. */
export const CHAT_STICKY_MS = 10 * 60_000;
/** When the screen says it is still trying rather than only "thinking". */
export const CHAT_SLOW_MS = 8_000;

export interface Served {
  model: string;
  at: number;
}

/**
 * The ladder to try, in order: the model that answered last first (while that
 * was recent), then the rest in their usual order. A model no longer on the
 * ladder is ignored.
 */
export function chatLadder(ladder: readonly string[], last: Served | null, now: number): string[] {
  if (!last || now - last.at > CHAT_STICKY_MS || !ladder.includes(last.model)) return [...ladder];
  return [last.model, ...ladder.filter((m) => m !== last.model)];
}

/** How long the next model may take: its own limit, or what is left of the message's. */
export function nextCallTimeout(startedAt: number, now: number): number {
  return Math.min(CHAT_CALL_TIMEOUT_MS, CHAT_DEADLINE_MS - (now - startedAt));
}
