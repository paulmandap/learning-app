/**
 * Prompts. Kept here rather than inline so they can be reviewed as text.
 *
 * Every rule in the generation prompt maps to a deterministic validator that
 * enforces it (§3.2.4). The prompt asks; the validator checks. That pairing is
 * the point — a prompt rule with no validator behind it is a wish.
 */

import { splitSentences } from '../core/text';
import type { TierBudget } from '../core/planner';
import type { AssistantContext } from '../core/chat';

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
}): string {
  const { sectionTitle, budget, pagesText } = input;
  const total = budget.remember + budget.understand + budget.apply;

  return `You write study questions from a student's own notes.

SECTION: ${sectionTitle}

Write at most ${total} items from the notes below:
- ${budget.remember} at level "remember" — recall a fact, definition or name.
- ${budget.understand} at level "understand" — explain, compare, or say why something follows.
- ${budget.apply} at level "apply" — use the idea on a new case or scenario.

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

// §3.2.3's ALLOWED_FORMS list used to live here and be sent with every
// generation. It is gone, and this note is what you are looking for if you
// came here to find it.
//
// It never had a field to answer it: GENERATE_RESPONSE_SCHEMA has no `form`
// property, so structured output could not carry one and no card ever claimed
// a form (NOTES §28.1). The instruction was dead text for its whole life.
//
// Removed after a controlled check rather than on the reasoning alone — six
// runs on one pinned model, line present vs line removed, 2026-09-12: `kind`
// total variation 0.015, `level` 0.020, and the across-condition label
// distances sat inside the within-condition range. No measurable regression
// (NOTES §28.9).
//
// The vocabulary now lives in src/core/form.ts as CANDIDATE_FORMS, where E1
// measured it. It is a descriptive vocabulary and is on no code path.

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
 * Rephrase a question the student keeps getting wrong (spec §3.3).
 *
 * Deliberately narrow. The model is given one card and asked for one field
 * back, with the answer stated so it cannot drift into asking something else.
 * The source sentence is included because rule 1 everywhere else in this file
 * applies here too: the rewrite may use only what the notes say.
 */
export function buildVariantPrompt(input: {
  prompt: string;
  answer: string;
  sourceExcerpt: string;
}): string {
  return [
    'A student keeps getting this question wrong. Rewrite the QUESTION so it asks',
    'the same thing in a different way.',
    '',
    'CURRENT QUESTION:',
    input.prompt,
    '',
    'THE ANSWER (this must not change):',
    input.answer,
    '',
    "FROM THE STUDENT'S NOTES:",
    input.sourceExcerpt,
    '',
    'Rules:',
    '1. The answer above must still be the correct answer, unchanged. Do not ask for',
    '   something narrower, wider, or different.',
    '2. Use only what the notes say. Do not add outside knowledge or new examples.',
    '3. Change the wording and the angle — come at it from a different direction, or',
    '   ask for it in plainer words. Do not just reorder the original.',
    '4. Never put the answer inside the question.',
    '5. One sentence. No preamble, no "in other words", no explanation.',
    '6. The student sees this card alone, so never refer to the notes, the previous',
    '   wording, a diagram, or anything not in the question itself.',
  ].join('\n');
}

/**
 * Check an Apply-tier marking checklist against its source (D7's second pass).
 *
 * The model NAMES the points it cannot support; `src/core/rubric.ts` decides the
 * verdict. Asking for the verdict directly would put the judgement somewhere
 * nothing can check it, which is the mistake §3.3 exists to avoid.
 */
export function buildRubricCheckPrompt(input: {
  question: string;
  expectedConcepts: { id: string; text: string }[];
  modelAnswer: string;
  sourceExcerpt: string;
  /**
   * The whole page the card came from.
   *
   * Load-bearing, and it was missing on the first live run. Judging a checklist
   * against `sourceExcerpt` alone — ONE resolved sentence — flagged **4 of 4**
   * real Apply rubrics, every one of them wrongly. A card drawn from a diagram
   * cites a fragment like "water/nutrient absorption", so a checklist point
   * "identifies roots as the affected organ" genuinely is not in that string,
   * and the model said so correctly. But the rubric was written from the whole
   * section, and marking it unfair because one sentence does not restate it is
   * the wrong test. See ARCHITECTURE_NOTES §10.
   */
  sourceText: string;
}): string {
  const list = input.expectedConcepts.map((c) => `- ${c.id}: ${c.text}`).join('\n');
  // Bounded: a long page would otherwise dominate a call whose whole job is a
  // list of ids. Generous enough to carry a section's worth of context.
  const page = input.sourceText.slice(0, 4000);

  return [
    'You are checking a marking checklist for fairness before it is used on a student.',
    '',
    'QUESTION:',
    input.question,
    '',
    "THE STUDENT'S NOTES THIS CAME FROM:",
    page,
    '',
    'THE LINE THE CARD CITES (part of the notes above):',
    input.sourceExcerpt,
    '',
    'EXPECTED ANSWER:',
    input.modelAnswer,
    '',
    'CHECKLIST — a student must mention these to score full marks:',
    list,
    '',
    'For each point, ask: could a student who had read the notes above be expected',
    'to make this point when answering this question? Judge it against the WHOLE of',
    'the notes, not only the cited line — the cited line is where the card was',
    'drawn from, not the limit of what the student read.',
    '',
    'Return:',
    '- "unsupported": the ids of points that fail that test — points the source does',
    '  not support, or that do not belong in an answer to this question. Return an',
    '  empty array if every point is fair. Do not invent ids.',
    '- "note": at most one short sentence saying what is wrong, addressed to nobody',
    '  in particular. Empty string if nothing is wrong.',
    '',
    'Be strict about evidence and generous about wording: a point phrased differently',
    'from the source is fine, a point the source never makes is not.',
  ].join('\n');
}

/**
 * Nomi's system instruction (Phase 9c, D14 — reversed by the owner, NOTES §36).
 *
 * It used to be a one-shot prompt that ended "if the question is not about
 * studying, say briefly that you can only help with their notes" — which is
 * exactly what the owner got for saying "Hi Nomi". Nomi is a companion now:
 * warm, simple and direct, happy to chat, and still grounded where it matters.
 *
 * Two rules carry over unchanged in spirit, because the failures they prevent
 * are still the ones that matter:
 *
 *  - **Facts about the student come only from the brief.** A companion that
 *    rounds "3 days" into "about a week" gets believed.
 *  - **The notes win when a card or a set is open.** A confident answer that
 *    contradicts what they will be examined on is worse than no answer.
 *
 * The conversation itself goes in `contents`, turn by turn; this is only the
 * standing instruction, so it is sent as `systemInstruction`.
 */
export function buildNomiSystemPrompt(input: { brief: string; context: AssistantContext }): string {
  const lines = [
    "You are Nomi, a friendly owl who is the student's study companion inside their flashcard app.",
    "You're chatting with them like a friend in a messenger app.",
    '',
    'How to reply:',
    '1. Simple and direct. Usually one to three sentences; go longer only when they ask for',
    '   detail or an explanation genuinely needs it. No preamble, no "great question".',
    '2. Everyday chat and small talk are welcome. Say hi back, be warm, answer general',
    '   questions, and offer study help when it fits — never refuse because a message is',
    '   not about studying.',
    '3. For anything about the student themselves — their name, streak, sets, what is due,',
    '   what they missed, their progress — use ONLY the facts below. Never guess or estimate',
    "   a number that is not there. If it isn't in the facts, say you can't see that.",
    '4. Plain language. No headings, no bullet lists, no markdown.',
    '',
    input.brief,
  ];

  if (input.context.kind === 'card') {
    lines.push(
      '',
      'They are looking at this card right now:',
      `  Question: ${input.context.prompt}`,
      `  Answer:   ${input.context.answer}`,
      'It came from this line of their notes:',
      `  ${input.context.source}`,
    );
  } else if (input.context.kind === 'set') {
    lines.push('', `They have this set open, "${input.context.title}". Its notes:`, input.context.notes);
  }

  if (input.context.kind !== 'none') {
    lines.push(
      '',
      'When a question is about this card or these notes, answer from their notes first —',
      'they will be examined on them, so where you know better, say so plainly rather than',
      'quietly answering something different. If the notes do not cover it, say so in a few',
      'words, then answer from general knowledge.',
    );
  }

  return lines.join('\n');
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
