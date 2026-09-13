/**
 * How Nomi "types" a line: a moment of thinking, then the words appear.
 *
 * Pure: times in, character counts out. The component owns the clock.
 *
 * The owner, on Home: the line was *"static, it's not changing … make it
 * dynamic, add some animations! like Nomi is thinking for about 1 second and it
 * will say that with the animation like it is typing, letter by letter"*
 * (NOTES §37).
 *
 * ## Paced like speech, capped like a chart
 *
 * A fixed delay per character makes a long line crawl and a short one blink,
 * so commas and full stops get a small pause — the rhythm of someone typing a
 * sentence — and the whole line is squeezed to at most `MAX_TYPING_MS`. Home
 * is somewhere you pass through; a companion that takes four seconds to finish
 * a sentence is one you stop waiting for.
 */

/** The "thinking" beat before the first letter. The owner's "about 1 second". */
export const THINK_MS = 1000;

export const CHAR_MS = 26;

/** Extra time after punctuation, so a sentence reads as one. */
export const PAUSE_MS: Readonly<Record<string, number>> = { ',': 110, ';': 110, '.': 200, '!': 200, '?': 200 };

/** No line takes longer than this to type, however long it is. */
export const MAX_TYPING_MS = 2000;

/** When each character appears, in ms after typing starts. Non-decreasing. */
export function revealSchedule(text: string): number[] {
  const raw: number[] = [];
  let t = 0;
  for (const ch of text) {
    t += CHAR_MS;
    raw.push(t);
    t += PAUSE_MS[ch] ?? 0;
  }
  const last = raw.at(-1) ?? 0;
  const scale = last > MAX_TYPING_MS ? MAX_TYPING_MS / last : 1;
  return raw.map((ms) => Math.round(ms * scale));
}

/** How many characters are showing `elapsedMs` after typing started. */
export function revealedCount(schedule: readonly number[], elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  let n = 0;
  while (n < schedule.length && schedule[n]! <= elapsedMs) n++;
  return n;
}

/** How long the whole line takes to type. */
export function typingDuration(text: string): number {
  return revealSchedule(text).at(-1) ?? 0;
}
