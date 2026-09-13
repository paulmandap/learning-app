/**
 * A reviewer Nomi writes on a topic (NOTES §39).
 *
 * Pure: how much to ask for, what to call it, and whether what came back can be
 * made into cards. The call is `src/data/reviewer.ts`; the words it sends are
 * `buildReviewerPrompt` in `src/ai/prompts.ts`.
 *
 * ## What the owner asked for
 *
 * *"pwede mo ba ako gawan ng reviewer about computer parts?"* got "paste your
 * notes here", and *"ikaw na bahala sa notes pls"* ("you handle the notes") got
 * "I cannot write the notes for you myself". The owner: *"i want nomi to be the
 * one to do it, not me handing things."*
 *
 * ## Where the facts come from
 *
 * Everywhere else, cards come from the student's own notes and nothing else.
 * Here the notes are Gemini's, from what it knows. So the reviewer is saved in
 * Notes as well as made into cards — somewhere the student can read it and put
 * right anything wrong — and the cards cite it exactly as they would cite a
 * paste, through the same checks.
 */

import { countAtomicUnits, supportedFor } from './planner';
import { wordCount } from './text';
import { MAX_PASTE_CHARS } from './chat';

/** Cards to make from a reviewer when the student gave no number: the 20 Add notes starts at. */
export const TOPIC_CARD_COUNT = 20;

/** Fewest facts a reviewer may have and still be made into cards. */
export const MIN_REVIEWER_FACTS = 8;

/** Fewest words, for the same reason. A refusal or a one-line answer is not a reviewer. */
export const MIN_REVIEWER_WORDS = 60;

/**
 * How many facts to ask for: half as many again as the cards, between 15 and 90.
 *
 * One fact per card would leave the fill passes nothing to choose from when a
 * card is dropped as a repeat, and the planner counts one "- " line as one
 * card's worth — so 20 cards asks for 30 facts.
 */
export function reviewerFacts(count: number): number {
  return Math.min(90, Math.max(15, Math.ceil(count * 1.5)));
}

const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'ng', 'sa', 'o', 'mga']);

/**
 * A title from a topic: "computer parts" → "Computer Parts".
 *
 * A topic typed with its own capitals keeps them — "the French Revolution",
 * "DNA replication" — because a student's "DNA" is not ours to lower.
 */
export function topicTitle(topic: string): string {
  const clean = topic.replace(/\s+/g, ' ').trim().replace(/^(?:the|a|an|ang|mga)\s+/i, '');
  if (!clean) return 'My reviewer';
  if (/\p{Lu}/u.test(clean)) return clean.charAt(0).toUpperCase() + clean.slice(1);
  return clean
    .split(' ')
    .map((word, i) => (i > 0 && SMALL_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

export type ReviewerCheck =
  | {
      ok: true;
      notes: string;
      /** "- " lines, as the planner counts them. */
      facts: number;
      /** Cards the planner estimates these notes hold. */
      supports: number;
    }
  | { ok: false; reason: 'empty' | 'too_short' };

/**
 * Whether a written reviewer can be made into cards, tidied into the shape the
 * rest of the app reads.
 *
 * The prompt asks for "# " headings and one "- " fact per line; this is the
 * check behind it. Bold and a code fence are stripped, every bullet becomes
 * "- " and every heading "# ", and anything past the largest paste Nomi takes
 * is cut at a line. Too few facts or too few words — a refusal, a one-liner —
 * is not a reviewer.
 */
export function checkReviewer(raw: string): ReviewerCheck {
  const lines = raw
    .trim()
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/\s*```$/, '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/__(.+?)__/g, '$1')
        .replace(/^\s*(?:[*•‣▪]|\d{1,3}[.)])\s+/, '- ')
        .replace(/^\s*#{1,6}\s+/, '# ')
        .trim(),
    )
    // A fact written without its "- " is still a fact. Measured 2026-09-14:
    // asked for 30 facts on computer parts, Gemini wrote 28 good sentences,
    // one per line under seven headings, and not one bullet — and this check
    // turned it away as having no facts at all. A full sentence on a line of
    // its own is a fact; a short line with no full stop is left as a heading.
    .map((line) => (line && !/^(?:# |- )/.test(line) && /[.!?]["”')\]]?$/.test(line) ? `- ${line}` : line));

  let notes = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (notes.length > MAX_PASTE_CHARS) {
    const cut = notes.slice(0, MAX_PASTE_CHARS);
    const lastLine = cut.lastIndexOf('\n');
    notes = (lastLine > 0 ? cut.slice(0, lastLine) : cut).trim();
  }
  if (notes.length === 0) return { ok: false, reason: 'empty' };

  const facts = countAtomicUnits(notes);
  if (facts < MIN_REVIEWER_FACTS || wordCount(notes) < MIN_REVIEWER_WORDS) return { ok: false, reason: 'too_short' };
  return { ok: true, notes, facts, supports: supportedFor(notes) };
}
