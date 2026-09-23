/**
 * Prompts. Kept here rather than inline so they can be reviewed as text.
 *
 * Every rule in the generation prompt maps to a deterministic validator that
 * enforces it (§3.2.4). The prompt asks; the validator checks. That pairing is
 * the point — a prompt rule with no validator behind it is a wish.
 */

import { splitSentences } from '../core/text';
import {
  describeBand,
  describeLines,
  inSpan,
  type Band,
  type SentenceRef,
  type SentenceSpan,
} from '../core/coverage';
import type { TierBudget } from '../core/planner';
import type { AssistantContext } from '../core/chat';
import { askLine, type NomiAction } from '../core/nomi-actions';
import { OPERATOR } from '../core/legal';

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

/** Longest list of existing cards sent with a request. The newest are kept. */
export const MAX_AVOID = 80;

/**
 * The generation prompt.
 *
 * ## What changed, and the measurement behind it (NOTES §37)
 *
 * It said "Write AT MOST N items" and "if the notes do not support the number
 * of items asked for, return FEWER". On the owner's pasted song — 965 words,
 * 104 lines — that turned a request for 10 into 2 cards from the first six
 * lines, with nothing dropped, so nothing was replaced. Asked for 60 it wrote
 * 15. The owner's call: the count asked for is the count wanted, weak notes or
 * strong. So it now asks for EXACTLY N, says how many to take from each part
 * of the text, and forbids a repeated answer — and each of those has a check
 * behind it: the fill passes in `src/data/pipeline.ts`, the band quota and
 * `sameAnswer` in `src/core/validate.ts`.
 *
 * Wording matters: citations must resolve or the validator drops the item.
 */
export function buildGeneratePrompt(input: {
  sectionTitle: string;
  budget: TierBudget;
  pagesText: string;
  /** How many to take from each part of the notes. */
  bands?: readonly Band[];
  /** Cards already in the set; none of these questions or answers may be repeated. */
  avoid?: readonly { prompt: string; answer: string }[];
  /** A fill pass: the levels are a guide and the total is the target. */
  flexibleLevels?: boolean;
  /** The notes have been used already; ask about facts from a new angle. */
  angles?: boolean;
  /** Only these lines may be cited — the ones with no card yet. */
  onlyLines?: readonly SentenceRef[];
}): string {
  const {
    sectionTitle,
    budget,
    pagesText,
    bands = [],
    avoid = [],
    flexibleLevels,
    angles,
    onlyLines = [],
  } = input;
  const total = budget.remember + budget.understand + budget.apply;

  const spread =
    bands.length > 0
      ? `
Spread them across the WHOLE of the notes. Take this many from each part:
${bands.map((b) => `- ${describeBand(b)}: ${b.quota}`).join('\n')}
A part that already has its share is full, and an extra item from it is thrown away.
`
      : '';

  const fresh =
    onlyLines.length > 0
      ? `
Every other line of these notes already has a card. Take every item from THESE lines only —
an item citing any other line is thrown away:
${describeLines(onlyLines)}
`
      : '';

  const angleRule = angles
    ? `
MORE CARDS FROM NOTES ALREADY USED. Cards have already been made from these notes — they
are listed below. Where the new facts run out, ask about a detail from a different angle:
the other way round ("what did she give him?" becomes "who gave him the book?"), as a
choice between options, or what comes just before or after a line. The answer must still be
different from every card listed.
`
    : '';

  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const written =
    avoid.length > 0
      ? `
ALREADY WRITTEN — do not repeat any of these questions, and do not reuse any of these answers:
${avoid
  .slice(-MAX_AVOID)
  .map((c) => `- ${clip(c.prompt, 120)} → ${clip(c.answer, 80)}`)
  .join('\n')}
`
      : '';

  return `You write study questions from a student's own notes.

SECTION: ${sectionTitle}

Write exactly ${total} items from the notes below${flexibleLevels ? ', roughly' : ''}:
- ${budget.remember} at level "remember" — recall a fact, definition or name.
- ${budget.understand} at level "understand" — explain, compare, or say why something follows.
- ${budget.apply} at level "apply" — use the idea on a new case or scenario.
${flexibleLevels ? `The levels are a guide. The total of ${total} is what matters.\n` : ''}${spread}${fresh}
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
  so never write "as shown above", "option B", "the third one", or "see the diagram" —
  and never mention a line, sentence or page number: those are for "source_sentence" only.
- If the notes are ALREADY a quiz, do not copy it. Rewrite each question so it reads
  naturally, and write the answer as a plain statement of the fact — never as a letter
  or a number. "A. To unify word forms" is wrong; "To unify word forms" is right.
- Strip any numbering or lettering. The card must contain no "1.", "A.", "b)" markers.
- Keep the meaning exactly as the notes have it. Rewording is required; changing,
  correcting or embellishing the facts is not.

ANY TEXT IS STUDY MATERIAL. Lecture notes, a textbook page, a story, a poem, a speech,
song lyrics, a list — whatever the student gave you is what they want to learn. Ask about
its people, places, events, details, images, wording, the order things happen in, and what
it means. Never decide the text is not worth studying.

HARD RULES — an item breaking any of these is discarded:
1. Use ONLY the facts in the text provided below. Do not add outside knowledge,
   context or examples, even if you are confident they are correct.
2. CITE YOUR SOURCE BY NUMBER. Every sentence in the notes below is numbered. Set
   "source_sentence" to the number of the sentence your answer came from, and
   "page_index" to its [PAGE n]. Do NOT copy the sentence text — just give the number.
   The number is checked automatically: if it does not exist, or the sentence does not
   actually support your answer, the card is thrown away. Cite the sentence that
   contains the answer, not one that merely mentions the topic. For "understand" and
   "apply" items, use the key words of the line you cite in your answer — the check
   compares the two, and an answer that shares none of that line's words is thrown away.
3. Never put the answer inside its own prompt.
4. For "mcq", the correct option's text must not appear word-for-word in the prompt.
5. Do not write two items that ask the same thing in different words, and NO TWO ITEMS
   MAY HAVE THE SAME ANSWER — reworded counts: "The left ventricle" and "Left ventricle"
   are the same answer.
6. Write the full number asked for. When the obvious facts run out, look for the smaller
   details, then the order things happen in, then what a line means — every line of the
   notes is a possible item.
7. Include "rubric" ONLY on "short_answer" items. Leave it out entirely for flashcards
   and multiple choice — it is not used for them.
8. Set "check_flag" ONLY if the notes clearly contradict established knowledge, and say
   what the conflict is. Do not flag things you merely find surprising or incomplete.
9. Each item needs a short "topic" — a two-to-four-word label for what it is about.
10. Prefer the SUBJECT to the housekeeping. Real study material is full of instructions
    to students, marking schemes, what to bring, dates, room numbers, how an assessment
    is run, who prepared a specimen. Make cards about the subject itself first, and use
    housekeeping only when nothing else in that part of the notes is left.
11. A figure or diagram is study material. When the notes label parts of something and
    give a function or meaning for each, those pairings are exactly what gets examined,
    so make cards from them. Ask for the part given its function, or the function given
    its part. Where a label has no function printed beside it, only the name is known —
    do not invent one.
${angleRule}${written}
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
export function renderPagesForPrompt(
  pages: { page_index: number; text: string }[],
  /**
   * Only these lines, for one part of a split section (NOTES §37). They keep
   * their ORIGINAL numbers, so a citation still resolves against the whole page.
   */
  span?: SentenceSpan,
): string {
  return pages
    .slice()
    .sort((a, b) => a.page_index - b.page_index)
    .map((p) => {
      const numbered = splitSentences(p.text)
        .map((s, i) => ({ s, i }))
        .filter(({ i }) => !span || inSpan({ page: p.page_index, sentence: i }, span))
        .map(({ s, i }) => `[${i}] ${s}`)
        .join('\n');
      return numbered ? `[PAGE ${p.page_index}]\n${numbered}` : '';
    })
    .filter((block) => block.length > 0)
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
 * Wrong answers for turning flashcards into quiz questions (NOTES §38).
 *
 * The owner: *"everything must have quiz. gemini can think of what to put in
 * the quiz based on the notes."* The model writes the wrong answers; the right
 * one is the card's own and is never the model's to change. `choicesFrom` in
 * `src/core/quiz.ts` checks each one — not the answer reworded, not a
 * duplicate, not a paragraph — so the rules below each have a check behind them.
 */
export function buildWrongOptionsPrompt(input: {
  notes: string;
  cards: readonly { n: number; prompt: string; answer: string }[];
}): string {
  return [
    'These flashcards are being asked as multiple-choice questions in a quiz.',
    'For every card, write exactly three WRONG answers.',
    '',
    'Rules:',
    '1. Take them from the notes below where you can: other people, places, things, numbers or',
    '   phrases from the same notes, of the same kind as the right answer — a name for a name, a',
    '   place for a place, a number for a number.',
    '2. Plausible to someone who has not studied, clearly wrong to someone who has.',
    '3. About as long as the right answer, and written the same way.',
    '4. Never the right answer in other words, never partly right, never "all of the above", never a',
    '   joke. Three different wrong answers for each card.',
    '5. Return one entry for every card, with its number.',
    '',
    'NOTES:',
    input.notes,
    '',
    'CARDS:',
    ...input.cards.map((c) => `${c.n}. Question: ${c.prompt}\n   Right answer: ${c.answer}`),
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
 * Point at the questions and answers in notes whose layout `findQaPairs` could
 * not read (NOTES §49).
 *
 * The one prompt in this file that asks for the student's own text back. It is
 * never trusted with it: `locatePointed` in `src/core/qa-pairs.ts` keeps a pair
 * only when both halves are found in the notes, and then keeps the notes' own
 * characters. So rule 1 is a request and the finding is the check — a model
 * that "tidies" a question has pointed at nothing, and that pair is not kept.
 */
export function buildPointQaPrompt(input: { pages: readonly { page_index: number; text: string }[] }): string {
  return [
    'These study notes are written as questions with their answers, in a layout the app could not read by itself.',
    'List every question and its answer, exactly as they are written in the notes.',
    '',
    'Rules:',
    '1. Copy the characters exactly: the same words, spelling, punctuation and capital letters. Never fix, shorten,',
    '   reword or translate anything.',
    '2. "question" is the whole question as written. "answer" is the whole of its answer as written.',
    '3. A label or number in front, like "Q:", "A:" or "1.", can be left out.',
    '4. Only pairs that are really in the notes. Leave out a question with no answer written, and a multiple-choice',
    '   question with options.',
    '5. "page_index" is the [PAGE n] the pair is on.',
    '6. If the notes are not written as questions with answers, return an empty list.',
    '',
    'NOTES:',
    ...input.pages.map((p) => `[PAGE ${p.page_index}]\n${p.text}`),
  ].join('\n');
}

/**
 * A reviewer on a topic the student named, for Nomi to make cards from (NOTES
 * §39). The owner: *"i want nomi to be the one to do it, not me handing things."*
 *
 * These facts are the model's, so the rules are about keeping them sure rather
 * than many. The format is what the rest of the app already reads: "# "
 * headings, which reading a paste turns into sections, and one fact per "- "
 * line, which the planner counts as a card's worth each. `checkReviewer` in
 * `src/core/reviewer.ts` is the check behind the shape and the length.
 */
export function buildReviewerPrompt(input: { topic: string; facts: number }): string {
  return [
    'A student asked for a reviewer — study notes they will learn from and be quizzed on — about this topic:',
    input.topic,
    '',
    `Write about ${input.facts} facts, grouped under 3 to 8 short headings.`,
    '',
    'Format, as plain text in "notes":',
    '- Each heading on a line of its own, starting with "# ".',
    '- Under each heading, one fact per line, starting with "- ".',
    '- Each fact is one complete sentence that makes sense on its own: a term and what it means, a part',
    '  and what it does, a cause and its effect, a name and why it matters, a step and what it is for.',
    '- No introduction, no conclusion, no bold, no tables, no numbering.',
    '',
    'Rules:',
    '1. Cover what a class on this topic would teach and test, from the basics up.',
    '2. Only well-established facts you are sure of. Leave out a date, number or name you are not sure of',
    '   rather than guess.',
    '3. Every fact different. Never the same fact twice in other words.',
    '4. Write in the language the topic is written in.',
    '5. If the topic could mean more than one thing, take the meaning a student is most likely studying.',
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
export function buildNomiSystemPrompt(input: {
  brief: string;
  context: AssistantContext;
  /** What the app has offered to do and is waiting on a tap for (NOTES §39). */
  pending?: NomiAction | null;
}): string {
  const lines = [
    "You are Nomi, a friendly owl who is the student's study companion inside their flashcard app.",
    // Who made Nomi, and what it is (NOTES §49): *"i want nomi to know that it's
    // name is Nomi, and i created Nomi."* Honest about Gemini, as the app is.
    `${OPERATOR} made you, and built the app you live in. When they ask who made you, or about you, say so.`,
    "If asked what you are or what runs you, say honestly that you're Nomi and you use Google's Gemini to help you",
    'think. Never say you are ChatGPT, Gemini itself, or any other assistant.',
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
    '5. The app itself can do a few things for the student, each only after they tap to confirm: make a',
    '   study set from notes they paste, add pasted notes to a set ("add these to Biology", then the notes),',
    '   rename a set ("rename Biology to Bio 101"), save text as a note ("save this as a note", then the',
    '   text), change their name ("call me Sam"), study pet ("switch my pet to the cat") or picture ("use',
    '   face 3") — and write a reviewer on any topic and make cards from it. If they ask for one of the',
    '   others in words the app did not catch, tell them the words to use. Nothing can delete anything,',
    '   sign them out, or change their key from this chat — say so if asked.',
    '6. A reviewer on a topic is yours to set going. When they want you to make or write a reviewer,',
    '   notes, flashcards or a quiz ABOUT A TOPIC and have not pasted notes — in any language, Filipino',
    '   and Taglish included, or as a follow-up such as "you write the notes" or "ikaw na bahala" — put',
    '   the topic in "reviewer_topic", in a few words ("computer parts"), and keep "answer" to one short',
    '   sentence. The app writes the reviewer: never write it in "answer", and never tell them to paste',
    '   notes for it. Leave "reviewer_topic" out when they only ask a question about a topic.',
    '7. Set "pasted_notes" to true only when their latest message IS study material they pasted to learn',
    '   from — lecture notes, a textbook passage, a list of facts or definitions — and they ask nothing about',
    '   it. Lines of a song or a poem with nothing else around them are pasted notes too: students learn lyrics',
    '   and poems for class. Keep "answer" to one short sentence then; the app offers to make cards from it.',
    '   A message telling you about their day, their feelings, their plans or their classes is never pasted',
    '   notes, however long it is, and neither is any message that asks you something.',
    '',
    input.brief,
  ];

  if (input.pending) {
    const titled = input.pending.kind === 'make_set' || input.pending.kind === 'write_reviewer';
    lines.push(
      '',
      'Waiting on their tap right now, the app offered:',
      `  ${askLine(input.pending)}`,
      ...(titled
        ? [
            'If they want it called something else, in any words or language, put the title they want in',
            '"set_title" — the WHOLE title, every word, exactly as they typed it — and keep "answer" short.',
            'They change the number of cards with the buttons.',
          ]
        : []),
    );
  }

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
