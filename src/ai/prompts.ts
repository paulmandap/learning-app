/**
 * Prompts. Kept here rather than inline so they can be reviewed as text.
 *
 * Every rule in the generation prompt maps to a deterministic validator that
 * enforces it (§3.2.4). The prompt asks; the validator checks. That pairing is
 * the point — a prompt rule with no validator behind it is a wish.
 */

import { splitSentences } from '../core/text';
import type { TierBudget } from '../core/planner';

export const READ_SYSTEM_PROMPT = `You extract text from study notes, page by page.

Return one entry per page, in order, with:
- page_index: 0-based page number.
- headings: any section headings visible on that page, in reading order. Empty array if none.
- blocks: the page's content split into blocks. Use type "paragraph" for prose,
  "list" for bulleted or numbered lists (one block per list, items separated by newlines),
  "table" for tables rendered as GitHub-flavoured markdown, and "figure" for images or
  diagrams — for figures give the caption plus any labels legible in the image.
- readability: 0..1, how confidently you could read that page.
  1.0 = clean digital text. 0.7 = a decent scan or clear handwriting.
  0.4 = blurry, badly lit, or heavily obscured — you are guessing at words.
  0.0 = you cannot read it at all.

Rules:
- Transcribe only what is actually there. Never fill gaps with plausible content.
- If a page is unreadable, still return the page with a low readability score and
  whatever blocks you could make out, even if that is an empty list.
- Do not summarise, correct, reword or reorder anything. This is transcription.
- Preserve the author's own wording exactly, including any errors.`;

/** Wording matters: excerpts must be verbatim or the validator drops the item. */
export function buildGeneratePrompt(input: {
  sectionTitle: string;
  budget: TierBudget;
  pagesText: string;
  allowedForms: string[];
}): string {
  const { sectionTitle, budget, pagesText, allowedForms } = input;
  const total = budget.remember + budget.understand + budget.apply;

  return `You write study questions from a student's own notes.

SECTION: ${sectionTitle}

Write at most ${total} items from the notes below:
- ${budget.remember} at level "remember" — recall a fact, definition or name.
- ${budget.understand} at level "understand" — explain, compare, or say why something follows.
- ${budget.apply} at level "apply" — use the idea on a new case or scenario.

Allowed forms: ${allowedForms.join(', ')}.

Item kinds:
- "flashcard": a prompt and a short answer.
- "mcq": a question with 3 or 4 options, exactly one correct. Wrong options must be
  sibling concepts drawn from THESE notes — plausible to someone who has not studied,
  clearly wrong to someone who has. Never use "all of the above" or joke options.
- "short_answer": a question answered in one or two sentences. Include a rubric listing
  the concepts a correct answer must mention, each with a short stable id, plus a
  model_answer. Use this kind for most "understand" and "apply" items.

WRITE IN YOUR OWN WORDS. This is the difference between a good card and a bad one:
- The "prompt" and "answer" must be written as clean, natural questions and answers,
  phrased by you. Do NOT copy sentences out of the notes into them.
- Every card must stand on its own. A student sees ONE card with no notes beside it,
  so never write "as shown above", "option B", "the third one", or "see the diagram".
- If the notes are ALREADY a quiz, do not copy it. Rewrite each question so it reads
  naturally, and write the answer as a plain statement of the fact — never as a letter
  or a number. "A. To unify word forms" is wrong; "To unify word forms" is right.
- Strip any numbering or lettering. The card must contain no "1.", "A.", "b)" markers.
- Keep the meaning exactly as the notes have it. Rewording is required; changing,
  correcting or embellishing the facts is not.

HARD RULES — an item breaking any of these is discarded:
1. Use ONLY the facts in the text provided below. Do not add outside knowledge,
   context or examples, even if you are confident they are correct.
2. CITE YOUR SOURCE BY NUMBER. Every sentence in the notes below is numbered. Set
   "source_sentence" to the number of the sentence your answer came from, and
   "page_index" to its [PAGE n]. Do NOT copy the sentence text — just give the number.
   The number is checked automatically: if it does not exist, or the sentence does not
   actually support your answer, the card is thrown away. Cite the sentence that
   contains the answer, not one that merely mentions the topic.
3. Never put the answer inside its own prompt.
4. For "mcq", the correct option's text must not appear word-for-word in the prompt.
5. Do not write two items that ask the same thing in different words.
6. If the notes do not support the number of items asked for, return FEWER. Padding with
   weak or repetitive questions is worse than returning nothing.
7. Include "rubric" ONLY on "short_answer" items. Leave it out entirely for flashcards
   and multiple choice — it is not used for them.
8. Set "check_flag" ONLY if the notes clearly contradict established knowledge, and say
   what the conflict is. Do not flag things you merely find surprising or incomplete.
9. Each item needs a short "topic" — a two-to-four-word label for what it is about.
10. Make cards about the SUBJECT, not about the course. Real study material is full
    of housekeeping: instructions to students, marking schemes, what to bring, dates,
    room numbers, how an assessment is run, who prepared a specimen. None of that is
    worth memorising. Ask yourself whether knowing a sentence would help someone
    understand the topic itself — if not, skip it and return fewer items.
11. A figure or diagram is study material. When the notes label parts of something and
    give a function or meaning for each, those pairings are exactly what gets examined,
    so make cards from them. Ask for the part given its function, or the function given
    its part. Where a label has no function printed beside it, only the name is known —
    do not invent one.

NOTES:
${pagesText}`;
}

/** Forms allowed by §3.2.3. */
export const ALLOWED_FORMS = [
  'definition',
  'question and answer',
  'compare',
  'process',
  'cause and effect',
  'application',
] as const;

/**
 * Render a section's pages with [PAGE n] markers and NUMBERED SENTENCES.
 *
 * The page markers make "Source · p.14" possible. The sentence numbers are what
 * let the model cite its source as an integer instead of reproducing the text —
 * the change that removed the largest field from the model's output.
 *
 * Numbering here MUST use the same splitSentences() the validator uses to
 * resolve the citation, or an index would mean two different things on the two
 * sides of the round trip.
 */
export function renderPagesForPrompt(pages: { page_index: number; text: string }[]): string {
  return pages
    .slice()
    .sort((a, b) => a.page_index - b.page_index)
    .map((p) => {
      const numbered = splitSentences(p.text)
        .map((s, i) => `[${i}] ${s}`)
        .join('\n');
      return `[PAGE ${p.page_index}]\n${numbered}`;
    })
    .join('\n\n');
}

/**
 * Grading prompt (spec §3.2.5).
 *
 * The rubric goes in the prompt so a small model can be reliable (D11): it is
 * matching an answer against a fixed checklist, not exercising judgement about
 * what a good answer looks like.
 */
export function buildGradePrompt(input: {
  question: string;
  expectedConcepts: { id: string; text: string }[];
  studentAnswer: string;
}): string {
  const list = input.expectedConcepts.map((c) => `- ${c.id}: ${c.text}`).join('\n');

  return [
    "You are marking a student's short written answer against a checklist.",
    '',
    'QUESTION:',
    input.question,
    '',
    'The answer should cover these points. Each has an id:',
    list,
    '',
    "STUDENT'S ANSWER:",
    input.studentAnswer,
    '',
    'Return:',
    '- "concepts_hit": the ids of ONLY the points the answer actually covers.',
    '  Judge the meaning, not the wording — a correct point counts even if the',
    '  student phrased it differently or used a synonym. Do not give credit for a',
    '  point the answer does not actually make, and do not invent ids.',
    '- "feedback": at most two short sentences, addressed to the student as "you".',
    '  Say what was right and what was missing. Be encouraging and specific.',
    '  Do not repeat the question, do not restate the whole answer, and do not',
    '  explain your reasoning.',
  ].join('\n');
}
