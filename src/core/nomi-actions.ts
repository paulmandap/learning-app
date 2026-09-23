/**
 * What Nomi can do in the app, not just say (NOTES §37, §39).
 *
 * Pure. A message and what Nomi knows go in; a proposed action — or nothing —
 * comes out. Nothing here writes anything: `src/data/nomi-agent.ts` carries an
 * action out, and only after the student taps to confirm it.
 *
 * ## What the owner asked for
 *
 * *"it would be cool if Nomi could act as an agent as well. like it can execute
 * users instructions. for example, the user pasted their notes to Nomi, and nomi
 * will be the one to handle it such as adding it a new set, and letting Nomi
 * choose the number of flashcards (10, 20, 40, 60) if it was not stated"* — and
 * *"give Nomi write access to the app but don't give to critical writes such as
 * deleting user's account or signing out."* Asked whether Nomi should act at
 * once or check first, he chose one tap to confirm; asked which writes, all four
 * that were offered. Then, of a topic with no notes: *"i want nomi to be the one
 * to do it, not me handing things"* — so Nomi can write the reviewer too.
 *
 * ## The allow-list is the type
 *
 * `NomiAction` is every write Nomi can make. There is no delete in it, no
 * sign-out and no key: an action that is not in the union cannot be proposed,
 * and the executor imports none of the functions that do those things —
 * `tests/screens.test.ts` reads it to make sure.
 *
 * ## Recognised here first, and by the model only where these miss
 *
 * Like the brain's questions, each request is matched by narrow patterns: free,
 * instant and testable, with near-misses in the tests that must NOT become an
 * action ("call me later", "is a cat a pet?", "explain this: …", "quiz me on …").
 *
 * The owner types Taglish, and the patterns missed him twice running (NOTES
 * §38, §39). So when a message they miss goes to Gemini anyway, the reply may
 * name two things — a topic to write a reviewer on, and a new title for the
 * offer on screen — and `proposeReviewer` and `retitle` put those through the
 * same checks a typed request gets. The model names a topic or a title; it
 * never proposes a write of its own, and nothing is written without the tap.
 */

import { supportedFor } from './planner';
import { normalize, splitSentences, wordCount } from './text';
import { findQaPairs, keptTarget } from './qa-pairs';
import { FACE_COUNT } from './avatar';
import { MAX_NOTES_CHARS, MAX_QUESTION_CHARS, trimNotes, type ChatTurn } from './chat';
import { TOPIC_CARD_COUNT, topicTitle } from './reviewer';
import type { PetSpecies } from './pet';
import type { AppSnapshot, BrainSet } from './nomi-brain';

/** The counts the app offers — the same four as Add notes. */
export const CARD_COUNTS = [10, 20, 40, 60] as const;

/** The most cards one request can make, whatever number is typed. */
export const MAX_CARDS = 60;

/** Below this many words, a message is a message rather than notes. */
export const NOTES_MIN_WORDS = 50;

/** The longest name Nomi gives a set or a note. */
export const MAX_TITLE_CHARS = 80;

/**
 * `kept`: how many of the student's own questions and answers are made into
 * cards exactly as written (NOTES §49). Absent or 0 when the notes hold none,
 * or when they asked Nomi to reword them. `count` is still the count picked:
 * the set makes all of their questions, and Nomi writes the rest (`keptTarget`).
 */
export type NomiAction =
  | { kind: 'make_set'; title: string; notes: string; count: number; countPicked: boolean; kept?: number }
  | {
      kind: 'add_notes';
      setId: string;
      setTitle: string;
      notes: string;
      count: number;
      countPicked: boolean;
      kept?: number;
    }
  | { kind: 'write_reviewer'; topic: string; title: string; count: number; countPicked: boolean }
  | { kind: 'rename_set'; setId: string; from: string; to: string }
  | { kind: 'save_note'; title: string; body: string }
  | { kind: 'set_name'; name: string }
  | { kind: 'set_pet'; pet: PetSpecies }
  | { kind: 'set_face'; index: number };

export type NomiActionKind = NomiAction['kind'];

export interface Proposal {
  /** Null when all Nomi can do is explain — "I couldn't find a set called …". */
  action: NomiAction | null;
  /** What Nomi says, asking to go ahead. */
  say: string;
}

const PETS: readonly PetSpecies[] = ['potato', 'cat', 'dog'];

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * How many cards to make when the student did not say.
 *
 * The largest of 10, 20, 40 and 60 that the notes support without stretching,
 * by the planner's own estimate (`supportedFor`: a card per ~70 words of prose,
 * or per self-contained item in structured notes), and never below 10, the
 * smallest the app offers. Because the count asked for is now the count made,
 * picking above what the notes hold would be choosing padding on the student's
 * behalf; they can still tap a bigger number before confirming.
 *
 * The owner's pasted song, 965 words: supports 13, so 10.
 */
export function chooseCardCount(notes: string): number {
  const supported = supportedFor(notes);
  let pick: number = CARD_COUNTS[0];
  for (const count of CARD_COUNTS) if (count <= supported) pick = count;
  return pick;
}

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
};

const clampCount = (n: number) => Math.max(1, Math.min(MAX_CARDS, n));

function countFromWord(raw: string): number {
  const word = raw.toLowerCase();
  return clampCount(/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word]!);
}

/** "make 20 flashcards", "twenty cards" — the number they asked for, or null. */
export function statedCount(instruction: string): number | null {
  const match = instruction.match(
    /\b(\d{1,3}|five|ten|fifteen|twenty|thirty|forty|fifty|sixty)\s+(?:flash\s*cards?|cards?|questions?|items?)\b/i,
  );
  return match ? countFromWord(match[1]!) : null;
}

/**
 * Asks to make cards: a verb, then something cards come in.
 *
 * "reviewer" is what the owner calls a set of study notes, and Filipino's
 * "gawa" (make) — "gawan", "gumawa" — is a verb here too (NOTES §39). "write"
 * and "gawa" need a card-ish word, not "set": "Write the set of real numbers
 * as…" opens a page of maths notes.
 */
const MAKE =
  /\b(?:(?:make|create|turn|generate|build)\b[\s\S]*?\b(?:flash\s*cards?|cards?|quiz(?:zes)?|set|deck|reviewers?)|(?:write|prepare|g(?:um)?awa(?:an|in|n)?|magawa|gagawa|ginawa(?:an)?)\b[\s\S]*?\b(?:flash\s*cards?|cards?|quiz(?:zes)?|reviewers?))\b/i;
/** "add these to my Biology set". */
const ADD_TO =
  /\badd\s+(?:this|these|them|it|these notes|this note|the notes)\s+(?:to|into)\s+(?:my\s+|the\s+)?["“']?(.+?)["”']?(?:\s+(?:set|deck))?\s*[:.!]*$/i;
/** "save this as a note", "put these in my notes". */
const SAVE = /\b(?:save|keep|put|store)\b[\s\S]*?\bnotes?\b/i;
/** A paste that comes with a question about it, which is Gemini's, not an action. */
const ASK =
  /^(?:(?:can|could) you\s+|please\s+)?(?:explain|summari[sz]e|what does|what do|what is this|tell me about|help me understand|quiz me)\b/i;
/** "can you …", "please …", "pwede …" — the way a request starts. */
const REQUESTING =
  /^(?:(?:can|could|would|will) you|please|pls|i want|i need|i'?d like|help me|nomi|pwede|puwede|sana)\b/i;

/**
 * Where a title starts, in every way the owner has given one.
 *
 * "call it", "titled", "title is", "title:", "the title should be" (NOTES §38);
 * then "yung title ay" inside a paste and "make the title" as a message of its
 * own, which the first two versions did not know (NOTES §39). Filipino's "ay"
 * is "is"; "palitan ang title ng" is "change the title to".
 */
const TITLE_MARKER = new RegExp(
  [
    String.raw`\b(?:make|change|set|update|switch|use|palitan|ibahin)\s+(?:(?:the|its|ang|yung)\s+)?(?:set'?s?\s+|reviewer'?s?\s+)?(?:title|name|pamagat|pangalan)\b(?:\s+(?:to|into|as|ng|sa|ay|is)\b)?(?:\s*[:=])?`,
    String.raw`\b(?:call|name|title|rename|retitle)\s+it\b(?:\s+(?:to|as|into)\b)?(?:\s*[:=])?`,
    String.raw`\b(?:called|named|titled)\b(?:\s*[:=])?`,
    String.raw`\b(?:(?:the|its|ang|yung)\s+)?(?:title|name|pamagat|pangalan)\s*(?:(?:is|ay|should be|will be|must be)\b|[:=])`,
  ].join('|'),
  'gi',
);
/** A sentence that gives a title. */
const TITLE_GIVEN = new RegExp(TITLE_MARKER.source, 'i');
/** "my name is Sam" is about the student, not the set. */
const POSSESSIVE = /\b(?:my|your|his|her|their|our|aking|iyong)\s*$/i;

/**
 * A title that opens with a quote ends at its closing quote — so
 * `"All Too Well by Taylor Swift" tapos ito yung contents` is the song's name
 * and nothing after it. Curly quotes too: an iPhone types them.
 */
const QUOTED: Readonly<Record<string, RegExp>> = {
  '"': /^"([^"“”]+)["”]/,
  '“': /^“([^"“”]+)["”]/,
  "'": /^'(.+?)['’](?![\p{L}\p{N}])/u,
  '‘': /^‘(.+?)['’](?![\p{L}\p{N}])/u,
};

/**
 * Where an unquoted title ends: punctuation before a space or the end ("Bio
 * 3.1" keeps its decimal), the next part of the request ("tapos", "then",
 * "with 20 cards"), or a "please" at the very end.
 */
const TITLE_END =
  /[.,!?;:](?=\s|$)|\s+(?:tapos|then|and then|and make|at ito|ito ang|ito yung|here are|here is|here's)\b|\s+(?:with|and)\s+\d+\s+(?:flash\s*cards?|cards?|questions?|items?)\b|\s+(?:please|pls|po|thanks|thank you|instead|nomi)\s*[.!]*$/i;

const NOT_A_TITLE = /^(?:a day|later|this|that|it|something|anything|whatever)$/i;

function takeTitle(rest: string): string {
  const text = rest.trimStart();
  const quoted = QUOTED[text.charAt(0)]?.exec(text)?.[1];
  let title: string;
  if (quoted !== undefined) {
    title = quoted;
  } else {
    const bare = text.replace(/^["“'‘]/, '');
    const end = TITLE_END.exec(bare);
    title = (end ? bare.slice(0, end.index) : bare).replace(/["”'’]+$/, '');
  }
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS).trim();
}

/** The title a request gives — "call it Bio 3.1", `yung title ay "…"` — or null. */
export function readTitle(text: string): string | null {
  for (const match of text.matchAll(TITLE_MARKER)) {
    const at = match.index ?? 0;
    if (POSSESSIVE.test(text.slice(0, at))) continue;
    const title = takeTitle(text.slice(at + match[0].length));
    if (title && !NOT_A_TITLE.test(title)) return title;
  }
  return null;
}

const RENAME =
  /^(?:(?:please|pls|can you|could you)[\s,]+)*(?:rename|change the name of)\s+(?:my\s+|the\s+)?["“']?(.+?)["”']?\s+(?:set\s+|deck\s+)?(?:to|as|into)\s+["“']?(.+?)["”']?\s*[.!]*$/i;
const NAME = /^(?:(?:please|pls)[\s,]+)?(?:call me|my name is|i'?m called|you can call me)\s+([\p{L}][\p{L}'’ -]{0,39}?)\s*[.!]*$/iu;
/** Words that follow "call me" without being a name. */
const NOT_A_NAME = /^(?:later|back|maybe|tomorrow|now|when|if|anytime|sometime)\b/i;
const PET =
  /\b(?:change|switch|set|make|swap|turn)\s+(?:my\s+)?(?:study\s+)?pet\s+(?:to|into|for)\s+(?:a\s+|an\s+|the\s+)?(potato|cat|dog)\b|\bi\s*(?:want|'?d like)\s+(?:the\s+|a\s+)?(potato|cat|dog)\b/i;
const FACE =
  /\b(?:use|pick|choose|switch to|change to|set)\s+(?:my\s+)?(?:(?:profile\s+)?(?:picture|avatar|pic|photo)\s+(?:to\s+)?)?face\s*(?:number\s*|#\s*)?(\d{1,2})\b/i;

const hasIntent = (text: string) => MAKE.test(text) || ADD_TO.test(text) || SAVE.test(text);

/** One sentence of a request, rather than of the notes. */
function isRequestSentence(sentence: string): boolean {
  return (
    wordCount(sentence) <= 20 &&
    (REQUESTING.test(sentence) || hasIntent(sentence) || TITLE_GIVEN.test(sentence) || statedCount(sentence) !== null)
  );
}

/**
 * Separate an instruction from the notes it is about.
 *
 * Three shapes, the third being the one the owner typed in NOTES §38:
 *
 *  - "Turn this into a set: <notes>", or an instruction ending in a colon on a
 *    line of its own — `nomi gawan mo nga ako reviewer, yung title ay "…" tapos
 *    ito yung contents: I walked…` is this shape (NOTES §39);
 *  - an instruction on its own first line;
 *  - requests typed straight into the paste, on the same line as the first line
 *    of the notes — "can you make me a notes of this? make 10 flash cards.
 *    title is All Too Well. I walked through the door…" — taken sentence by
 *    sentence until one is not part of a request.
 *
 * Whatever is taken must actually ask for something (make, add, save): a first
 * line that merely names something ("Set theory basics", "I said your name
 * once") is notes. And the colon in "…, title: Bio 3.1" belongs to the title.
 */
export function splitMessage(message: string): { instruction: string; notes: string } {
  const text = message.trim();
  const [first = '', ...rest] = text.split(/\r?\n/);

  const colon = first.match(/^([^:]{3,200}):\s*(.*)$/);
  if (
    colon &&
    !/\b(?:title|name|pamagat|pangalan)(?:\s+(?:is|ay))?\s*$/i.test(colon[1]!) &&
    wordCount(colon[1]!) <= 30 &&
    hasIntent(colon[1]!)
  ) {
    const sameLine = colon[2]!.trim();
    return {
      instruction: sameLine ? colon[1]!.trim() : first.trim(),
      notes: [sameLine, ...rest].filter((part) => part.length > 0).join('\n').trim(),
    };
  }

  const taken: string[] = [];
  for (const sentence of splitSentences(first)) {
    if (!isRequestSentence(sentence)) break;
    taken.push(sentence);
  }
  const request = taken.join(' ');
  if (taken.length > 0 && hasIntent(request)) {
    let cursor = 0;
    for (const sentence of taken) cursor = text.indexOf(sentence, cursor) + sentence.length;
    return { instruction: request, notes: text.slice(cursor).trim() };
  }
  return { instruction: '', notes: text };
}

/** "Q:", "1. Question:" — a label the student wrote, which is not part of any name (NOTES §49). */
const QUESTION_LABEL = /^(?:\d{1,3}[.)]\s*)?(?:q|ques|question|tanong)\s*\d{0,3}\s*[:.)\-–—]\s*/i;

/** A name for a set or note: the notes' first line, kept short. */
export function suggestTitle(notes: string): string {
  const first =
    notes
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s+/, '').replace(QUESTION_LABEL, '').replace(/[:\s]+$/, '').trim())
      .find((line) => line.length > 0) ?? '';
  const words = first.split(/\s+/).filter(Boolean);
  const short = words.length <= 8 ? first : words.slice(0, 6).join(' ');
  const clipped = short.length > 60 ? short.slice(0, 60).replace(/\s+\S*$/, '') : short;
  return clipped || 'My notes';
}

// --- a topic, with no notes: Nomi writes the reviewer (NOTES §39) ----------

/** Verbs that ask for something to be made, English and Filipino. */
const TOPIC_VERB = String.raw`(?:make|create|generate|build|write|prepare|draft|give|g(?:um)?awa(?:an|in|n)?|magawa|gagawa|ginawa(?:an)?|maghanda|ihanda)`;
/** Words that may stand between the verb and the thing: "make me 20 …", "gawan mo ba ako ng …". */
const FILLER_WORDS = ['me', 'us', 'ako', 'akin', 'mo', 'ba', 'nga', 'ng', 'na', 'a', 'an', 'some', 'more', 'new', 'quick', 'short', 'simple', 'good', 'few', 'po', 'please', 'pls', 'study', 'another', 'set', 'of'];
const FILLER = String.raw`(?:${FILLER_WORDS.join('|')}|\d{1,3}|five|ten|fifteen|twenty|thirty|forty|fifty|sixty)`;
/** What a reviewer comes as. "note" alone is left out: "write a note about my day" is a note. */
const MATERIAL = String.raw`(?:reviewers?|flash\s*cards?|cards?|quiz(?:zes)?|(?:study\s+)?notes|study\s+note|set|deck|questions?)`;
const ABOUT = String.raw`(?:about|on|regarding|covering|tungkol\s+sa|ukol\s+sa|para\s+sa|sa|ng|for|of)`;

/** "make me a reviewer about computer parts", "gawan ako ng reviewer tungkol sa …". */
const TOPIC_AFTER = new RegExp(
  String.raw`\b${TOPIC_VERB}(?:\s+${FILLER}){0,6}?\s+${MATERIAL}(?:\s+(?:for\s+me|para\s+(?:sa\s+)?akin|po))?\s+${ABOUT}\s+(.+)$`,
  'i',
);
/** "gawan ako ng computer parts reviewer", "make me biology flashcards". */
const TOPIC_BEFORE = new RegExp(
  String.raw`\b${TOPIC_VERB}\s+((?:[\p{L}\p{N}'’-]+\s+){1,8}?)(?:reviewers?|flash\s*cards?)\s*(?:please|pls|po|nomi)?\s*[?.!]*$`,
  'iu',
);
/** "flashcards about the heart" left over from "a set of flashcards about the heart". */
const MATERIAL_ABOUT = new RegExp(String.raw`^${MATERIAL}\s+${ABOUT}\s+`, 'i');
/** Where a topic ends and the rest of the request starts. */
const TOPIC_END = new RegExp(
  [
    String.raw`[?.!;:](?=\s|$)`,
    // A comma ends a topic only where the rest of the request follows it:
    // "about cells, tissues and organs" is one topic; "about cells, call it
    // Bio" and "about cells, thanks" are not.
    String.raw`,\s*(?=(?:call|name|title|make|with|please|pls|po|nomi|thanks|thank you|tapos|then|and\s+(?:call|name|title|make))\b|\d|$)`,
    String.raw`\s+(?:please|pls|po|nomi|thanks|thank you)\b`,
    String.raw`\s+(?:with|and|at)\s+\d`,
    String.raw`\s+(?:tapos|then|and\s+(?:call|name|title|make)|call\s+it|name\s+it|title\s+it|titled|named|called)\b`,
    String.raw`\s+for\s+(?:my|our|the|an?|tomorrow'?s?)\s+(?:exam|test|quiz|class|finals?|midterms?|quarterly)\b`,
  ].join('|'),
  'i',
);
/** A question about making cards is not a request for them: "how do I make flashcards about …?" */
const QUESTION = /^(?:how|what|why|when|where|which|who|whose|is|are|was|were|do|does|did|should|shall|am)\b/i;
/** Words that point at notes rather than name a topic: "this", "these", "ito". */
const DEICTIC =
  /^(?:me|us|you|here|now|later|today|tomorrow|tonight|what i|my notes|the notes)\b|\b(?:this|these|those|them|that|ito|nito|iyan|iyon|dito|ko|akin|aking)\b/i;
const LEADING_FILLER = new Set(['me', 'us', 'ako', 'akin', 'mo', 'ba', 'nga', 'ng', 'na', 'a', 'an', 'some', 'more', 'po', 'please', 'pls', 'of']);
/** A "topic" made only of these is no topic: "make me a new reviewer". */
const GENERIC_WORDS = new Set([
  'new', 'good', 'short', 'quick', 'simple', 'big', 'small', 'another', 'sample', 'practice', 'some', 'more',
  'few', 'study', 'own', 'easy', 'hard', 'long', 'full', 'whole', 'the', 'my', 'reviewer', 'reviewers', 'flashcard',
  'flashcards', 'card', 'cards', 'quiz', 'notes', 'note', 'set', 'deck', 'question', 'questions',
]);

/**
 * A topic fit to write a reviewer on, tidied, or null.
 *
 * The check a typed topic and a topic Gemini named both go through: under nine
 * words, not pointing at notes ("this", "ito", "it" — but not "IT"), not a
 * count ("20 cards"), and not only generic words.
 */
export function cleanTopic(raw: string): string | null {
  let topic = raw.replace(/\s+/g, ' ').trim();
  const end = TOPIC_END.exec(topic);
  if (end) topic = topic.slice(0, end.index);
  topic = topic.replace(MATERIAL_ABOUT, '').replace(/^["“'‘]+|["”'’]+$/g, '').trim();

  const words = topic.split(' ').filter(Boolean);
  while (words.length > 0 && LEADING_FILLER.has(words[0]!.toLowerCase())) words.shift();
  topic = words.join(' ');

  if (topic.length < 2 || topic.length > 60 || words.length > 8) return null;
  if (DEICTIC.test(topic) || /\bit\b/.test(topic)) return null;
  if (statedCount(topic) !== null && /^\S+\s+\S+$/.test(topic)) return null;
  if (words.every((w) => GENERIC_WORDS.has(w.toLowerCase()) || /^\d+$/.test(w))) return null;
  return topic;
}

/** The topic a message asks Nomi to write a reviewer on, or null. */
export function topicOf(message: string): string | null {
  const text = message.replace(/\s+/g, ' ').trim();
  if (wordCount(text) > 30 || QUESTION.test(text) || ASK.test(text)) return null;
  for (const shape of [TOPIC_AFTER, TOPIC_BEFORE]) {
    const raw = shape.exec(text)?.[1];
    const topic = raw ? cleanTopic(raw) : null;
    if (topic) return topic;
  }
  return null;
}

/**
 * Offer to write a reviewer on a topic and make cards from it.
 *
 * Shared by a request Nomi recognised and a topic Gemini named: either way the
 * topic is checked here, the title and count are read from the student's own
 * message, and nothing happens until the tap.
 */
export function proposeReviewer(topic: string, message: string): Proposal | null {
  const clean = cleanTopic(topic);
  if (!clean) return null;
  const title = readTitle(message);
  // Read the count with the title taken out: "call it 20 Questions" is a name.
  const stated = statedCount(title ? message.replace(title, ' ') : message);
  return propose({
    kind: 'write_reviewer',
    topic: clean,
    title: title ?? topicTitle(clean),
    count: stated ?? TOPIC_CARD_COUNT,
    countPicked: stated === null,
  });
}

function simplify(title: string): string {
  return normalize(title)
    .replace(/["“”'’]/g, '')
    .replace(/\b(?:my|the|set|deck|flash\s*cards?|cards?)\b/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const wordsOf = (simplified: string) => simplified.split(' ').filter(Boolean);

/**
 * Every set a typed name could mean: the exact matches if there are any, else
 * the sets whose name holds every word typed (or whose every word was typed).
 */
export function setsMatching(name: string, sets: readonly BrainSet[]): BrainSet[] {
  const want = simplify(name);
  if (!want) return [];
  const exact = sets.filter((s) => simplify(s.title) === want);
  if (exact.length > 0) return exact;
  const wanted = wordsOf(want);
  return sets.filter((s) => {
    const have = wordsOf(simplify(s.title));
    return have.length > 0 && (wanted.every((w) => have.includes(w)) || have.every((w) => wanted.includes(w)));
  });
}

/**
 * The set a student means by a name they typed, or null when it is not clear.
 *
 * Never a guess between two. "history" with "World History" and "History of
 * Art" both there is a question to ask, not a coin to toss: renaming the wrong
 * set is a write the student would have to notice, and one tap is not enough
 * friction to rely on for that.
 */
export function findSet(name: string, sets: readonly BrainSet[]): BrainSet | null {
  const matches = setsMatching(name, sets);
  return matches.length === 1 ? matches[0]! : null;
}

function listTitles(sets: readonly BrainSet[], joiner: string): string {
  const names = sets.slice(0, 4).map((s) => `"${s.title}"`);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)}`;
  return `${list}${sets.length > 4 ? ', and more' : ''}`;
}

/** What Nomi says when a typed set name does not pick out exactly one set. */
function couldNotFind(name: string, sets: readonly BrainSet[]): string {
  const clean = name.trim().replace(/^["“']|["”']$/g, '');
  const matches = setsMatching(name, sets);
  if (matches.length > 1) return `Which set do you mean: ${listTitles(matches, 'or')}?`;
  if (sets.length === 0) return `I couldn't find a set called "${clean}" — you don't have any sets yet.`;
  return `I couldn't find a set called "${clean}". Your sets are ${listTitles(sets, 'and')}.`;
}

const propose = (action: NomiAction): Proposal => ({ action, say: askLine(action) });

/**
 * Something Nomi could do for this message, or null to answer it as chat.
 */
export function proposeAction(message: string, snapshot: AppSnapshot): Proposal | null {
  const text = message.trim();
  if (text.length === 0) return null;
  const oneLine = !/\n/.test(text);
  const words = wordCount(text);

  // --- short instructions ------------------------------------------------
  if (oneLine && words <= 20) {
    const rename = RENAME.exec(text);
    if (rename) {
      const set = findSet(rename[1]!, snapshot.sets);
      const to = rename[2]!.trim().slice(0, MAX_TITLE_CHARS);
      if (!set) return { action: null, say: couldNotFind(rename[1]!, snapshot.sets) };
      if (to.length > 0) return propose({ kind: 'rename_set', setId: set.id, from: set.title, to });
    }

    const pet = PET.exec(text);
    if (pet) {
      const species = (pet[1] ?? pet[2])!.toLowerCase() as PetSpecies;
      if (PETS.includes(species)) return propose({ kind: 'set_pet', pet: species });
    }

    const face = FACE.exec(text);
    if (face) {
      const n = Number(face[1]);
      if (n < 1 || n > FACE_COUNT) {
        return { action: null, say: `There are ${FACE_COUNT} faces. Pick a number from 1 to ${FACE_COUNT}.` };
      }
      return propose({ kind: 'set_face', index: n - 1 });
    }

    if (words <= 6) {
      const name = NAME.exec(text);
      const given = name?.[1]?.trim();
      if (given && !NOT_A_NAME.test(given)) return propose({ kind: 'set_name', name: given });
    }
  }

  // --- notes --------------------------------------------------------------
  const { instruction, notes } = splitMessage(text);
  const long = text.length > MAX_QUESTION_CHARS;

  // A topic with no notes to go with it: Nomi writes them.
  if (!long && (notes.length === 0 || !instruction)) {
    const topic = topicOf(text);
    const reviewer = topic ? proposeReviewer(topic, text) : null;
    if (reviewer) return reviewer;
  }

  if (notes.length === 0) return null;

  if (instruction && SAVE.test(instruction) && !MAKE.test(instruction)) {
    return propose({ kind: 'save_note', title: readTitle(instruction) ?? suggestTitle(notes), body: notes });
  }

  // A message that asks for nothing is taken for notes only when it is too long
  // to be a chat message (NOTES §45). Anything shorter used to be notes from 50
  // words, so the owner telling Nomi about their day in 71 was offered a set
  // called "hi nomi, so today was really". No pattern tells a paragraph of notes
  // from a paragraph about someone's day. Gemini, reading it in the
  // conversation, can — and says so, which comes back through `proposeNotesSet`.
  if (!instruction && !long) return null;
  if (!long && !enoughNotes(notes)) return null;
  if (!instruction && ASK.test(text)) return null;

  return offerForNotes(instruction, notes, snapshot);
}

/**
 * Enough to make cards from: 50 words — or any of the student's own questions
 * with their answers, which are cards already however few words they take
 * (NOTES §49). Five short Q:A pairs are forty words.
 */
function enoughNotes(notes: string): boolean {
  return wordCount(notes) >= NOTES_MIN_WORDS || findQaPairs(notes).length > 0;
}

/**
 * The offer for a message Gemini said is study material pasted to learn from
 * (NOTES §45): the same split, title, count and words as a request Nomi
 * recognised itself. Null when there is too little to make cards from.
 */
export function proposeNotesSet(message: string, snapshot: AppSnapshot): Proposal | null {
  const { instruction, notes } = splitMessage(message);
  if (!enoughNotes(notes)) return null;
  return offerForNotes(instruction, notes, snapshot);
}

/**
 * A new set from notes, or the notes added to the set the instruction names.
 *
 * The student's own questions are kept as written, and when they did not say
 * how many cards, Nomi picks exactly as many as they wrote — their questions,
 * nothing added. A bigger count is one tap on the card (NOTES §49).
 */
function offerForNotes(instruction: string, notes: string, snapshot: AppSnapshot): Proposal {
  const kept = findQaPairs(notes).length;
  const stated = instruction ? statedCount(instruction) : null;
  const count = stated ?? (kept > 0 ? kept : chooseCardCount(notes));
  const own = kept > 0 ? { kept } : {};

  const add = instruction ? ADD_TO.exec(instruction) : null;
  if (add) {
    const set = findSet(add[1]!, snapshot.sets);
    if (!set) return { action: null, say: couldNotFind(add[1]!, snapshot.sets) };
    return propose({
      kind: 'add_notes',
      setId: set.id,
      setTitle: set.title,
      notes,
      count,
      countPicked: stated === null,
      ...own,
    });
  }

  return propose({
    kind: 'make_set',
    title: (instruction ? readTitle(instruction) : null) ?? suggestTitle(notes),
    notes,
    count,
    countPicked: stated === null,
    ...own,
  });
}

// --- changing an offer before the tap (NOTES §39) ---------------------------

/** "make it 20", "use 40", "40 instead", or only "40". */
const COUNT_ONLY =
  /^(?:(?:ok(?:ay)?|and|also|actually|sige)[\s,]+)?(?:(?:make it|change it to|use|go with|switch to)\s+)?(\d{1,3}|ten|twenty|forty|sixty)(?:\s+(?:instead|please|pls|po))?\s*[.!]*$/i;

function withChanges(pending: NomiAction, title: string | null, count: number | null): NomiAction {
  switch (pending.kind) {
    case 'make_set':
    case 'write_reviewer':
      return {
        ...pending,
        ...(title ? { title } : {}),
        ...(count !== null ? { count, countPicked: false } : {}),
      };
    case 'add_notes':
      return count !== null ? { ...pending, count, countPicked: false } : pending;
    default:
      return pending;
  }
}

/** Nomi saying it has changed the offer. Short: the card under it already shows the rest. */
function amendLine(action: NomiAction, changed: { title: boolean; count: boolean }): string {
  const title = 'title' in action ? action.title : '';
  const count = 'count' in action ? plural(action.count, 'card') : '';
  if (changed.title && changed.count) return `Okay, "${title}" with ${count}.`;
  if (changed.title) return `Okay, I'll call it "${title}".`;
  return `Okay, ${count}.`;
}

/**
 * A message that changes the offer waiting on a tap, or null.
 *
 * *"make the title "All Too Well by Taylor Swift""*, sent under an offer of a
 * set named after the first line of his paste, went to Gemini as chat — which
 * told him to paste the notes again, and the offer was gone (NOTES §39). A new
 * title or a new count now changes the offer in place, notes and all.
 */
export function amendProposal(message: string, pending: NomiAction): Proposal | null {
  const text = message.trim();
  if (text.length === 0 || /\n/.test(text) || wordCount(text) > 25) return null;
  const titled = pending.kind === 'make_set' || pending.kind === 'write_reviewer';
  if (!titled && pending.kind !== 'add_notes') return null;

  const wording = pending.kind === 'make_set' || pending.kind === 'add_notes' ? rewording(text, pending) : null;
  if (wording) return wording;

  const title = titled ? readTitle(text) : null;
  const rest = title ? text.replace(title, ' ') : text;
  const onlyCount = COUNT_ONLY.exec(text)?.[1];
  // A count inside a longer message only when it is short and not a question:
  // "what are 20 questions I could ask?" is not a new count.
  const count =
    onlyCount !== undefined
      ? countFromWord(onlyCount)
      : wordCount(rest) <= 8 && !rest.includes('?')
        ? statedCount(rest)
        : null;
  if (title === null && count === null) return null;

  const action = withChanges(pending, title, count);
  return { action, say: amendLine(action, { title: title !== null, count: count !== null }) };
}

/** "keep them as is", "don't reword", "word for word", "as I wrote them". Before REWORD: "don't reword" says reword. */
const KEEP_WORDING =
  /\b(?:keep (?:them|it|my (?:questions|wording|words))|as (?:is|written|i wrote (?:them|it))|(?:don'?t|do not|never|no need to) (?:change|reword|rewrite|rephrase)|word for word|exactly as)\b|\bwag (?:mong )?(?:baguhin|palitan)\b/i;
/** "reword them", "rewrite them", "in your own words". */
const REWORD = /\b(?:re-?word|re-?write|re-?phrase|paraphrase)\b|\b(?:your|in your) own words\b/i;

/**
 * Keeping the student's own questions as written, or letting Nomi reword them,
 * changed on the offer before the tap (NOTES §49) — the chat's half of the
 * choice Add notes offers. Null when the message says neither.
 */
function rewording(text: string, pending: Extract<NomiAction, { kind: 'make_set' | 'add_notes' }>): Proposal | null {
  if (KEEP_WORDING.test(text)) {
    const kept = findQaPairs(pending.notes).length;
    if (kept === 0) {
      return { action: pending, say: "I couldn't find questions with their answers in those notes, so I'll write the cards." };
    }
    return { action: { ...pending, kept }, say: `Okay, I'll keep your ${questions(kept)} exactly as you wrote them.` };
  }
  if (REWORD.test(text)) {
    const { kept: _dropped, ...rest } = pending;
    return { action: rest, say: "Okay, I'll write new questions from your notes." };
  }
  return null;
}

const questions = (n: number) => `${n} ${n === 1 ? 'question' : 'questions'}`;

/** How many cards an offer makes: all of the student's own questions, and the count's worth. */
function cardsOf(action: { count: number; kept?: number }): number {
  return keptTarget(action.count, action.kept ?? 0).target;
}

/**
 * The offer with a title Gemini read from a message the patterns missed.
 * Null when the offer has no title to change, or the title is not one.
 */
export function retitle(pending: NomiAction, raw: string): Proposal | null {
  if (pending.kind !== 'make_set' && pending.kind !== 'write_reviewer') return null;
  const title = raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
  if (!title || NOT_A_TITLE.test(title)) return null;
  const action = withChanges(pending, title, null);
  return { action, say: amendLine(action, { title: true, count: false }) };
}

/** What Nomi adds when the student's own questions are kept: that they are, and anything written on top. */
function keptLine(action: { count: number; kept?: number }): string {
  const own = action.kept ?? 0;
  const { extra } = keptTarget(action.count, own);
  return (
    ` I'll keep your ${questions(own)} exactly as you wrote them.` +
    (extra > 0 ? ` And I'll write ${extra} more of my own.` : '')
  );
}

/** Nomi asking whether to go ahead. */
export function askLine(action: NomiAction): string {
  switch (action.kind) {
    case 'make_set':
      if ((action.kept ?? 0) > 0) return `Want me to make a new set, "${action.title}", from your notes?${keptLine(action)}`;
      return (
        `Want me to make a new set, "${action.title}", with ${plural(action.count, 'card')}?` +
        (action.countPicked ? ` I picked ${action.count} for notes this long.` : '')
      );
    case 'add_notes':
      if ((action.kept ?? 0) > 0) return `Want me to add these notes to "${action.setTitle}"?${keptLine(action)}`;
      return (
        `Want me to add these notes to "${action.setTitle}" and make ${plural(action.count, 'card')} from them?` +
        (action.countPicked ? ` I picked ${action.count} for notes this long.` : '')
      );
    case 'write_reviewer':
      return (
        `Want me to write a reviewer on ${action.topic}, save it in Notes as "${action.title}", and make ${plural(action.count, 'card')} from it?` +
        (action.countPicked ? ` I picked ${action.count} to start.` : '')
      );
    case 'rename_set':
      return `Rename "${action.from}" to "${action.to}"?`;
    case 'save_note':
      return `Want me to save this in Notes as "${action.title}"?`;
    case 'set_name':
      return `Call you ${action.name} from now on?`;
    case 'set_pet':
      return `Switch your study pet to the ${action.pet}?`;
    case 'set_face':
      return `Use face ${action.index + 1} as your picture?`;
  }
}

/** Nomi saying it is done. */
export function doneLine(action: NomiAction): string {
  switch (action.kind) {
    case 'make_set':
      return `Done. I'm making ${plural(cardsOf(action), 'card')} for "${action.title}" now.`;
    case 'add_notes':
      return `Done. I'm adding ${plural(cardsOf(action), 'card')} to "${action.setTitle}" now.`;
    case 'write_reviewer':
      return `Done. Your reviewer is in Notes as "${action.title}", and I'm making ${plural(action.count, 'card')} from it now.`;
    case 'rename_set':
      return `Done. It's called "${action.to}" now.`;
    case 'save_note':
      return `Saved. "${action.title}" is in Notes.`;
    case 'set_name':
      return `Done. Hi, ${action.name}!`;
    case 'set_pet':
      return `Done. Say hi to your ${action.pet}.`;
    case 'set_face':
      return "Done. That's your picture now.";
  }
}

/**
 * The card Nomi shows under its question: what it is, the gist, and the button —
 * and, when the student's own questions are kept, a line saying so (NOTES §49).
 */
export function actionCard(action: NomiAction): { heading: string; detail: string; confirm: string; note?: string } {
  const kept = 'kept' in action && (action.kept ?? 0) > 0 ? { note: `Your ${questions(action.kept!)}, as you wrote them` } : {};
  switch (action.kind) {
    case 'make_set':
      return { heading: 'New set', detail: `${action.title} · ${plural(cardsOf(action), 'card')}`, confirm: 'Make it', ...kept };
    case 'add_notes':
      return {
        heading: 'Add to a set',
        detail: `${action.setTitle} · ${plural(cardsOf(action), 'card')}`,
        confirm: 'Add them',
        ...kept,
      };
    case 'write_reviewer':
      return { heading: 'New reviewer', detail: `${action.title} · ${plural(action.count, 'card')}`, confirm: 'Write it' };
    case 'rename_set':
      return { heading: 'Rename a set', detail: `${action.from} to ${action.to}`, confirm: 'Rename it' };
    case 'save_note':
      return { heading: 'Save a note', detail: action.title, confirm: 'Save it' };
    case 'set_name':
      return { heading: 'Your name', detail: action.name, confirm: 'Yes' };
    case 'set_pet':
      return { heading: 'Your study pet', detail: action.pet.charAt(0).toUpperCase() + action.pet.slice(1), confirm: 'Switch' };
    case 'set_face':
      return { heading: 'Your picture', detail: `Face ${action.index + 1}`, confirm: 'Use it' };
  }
}

/**
 * How a pasted page of notes appears in the conversation.
 *
 * The instruction, and how much was pasted with a glimpse of it — not the whole
 * page as a chat bubble, which would bury everything around it.
 *
 * Only a paste: a message that fits a chat message is shown as typed, however
 * many words it has. From 50 words it used to become "Pasted notes, 71 words:
 * …" too, cut mid-sentence, and the owner could not read back what they had
 * said to Nomi (NOTES §45). What the conversation KEEPS is the whole message
 * (`messageToKeep`); this is only what it shows.
 */
export function compactForChat(message: string): string {
  const text = message.trim();
  if (text.length <= MAX_QUESTION_CHARS) return text;
  const { instruction, notes } = splitMessage(text);
  const preview = notes.replace(/\s+/g, ' ').slice(0, 140).replace(/\s+\S*$/, '');
  return `${instruction ? `${instruction}\n` : ''}Pasted notes, ${wordCount(notes)} words: "${preview}…"`;
}

/**
 * The conversation as Gemini is sent it (NOTES §45).
 *
 * Everything that fits a chat message goes as it was typed. The latest paste
 * goes as a page of its notes, so Nomi can say what they are about — it was
 * sent only the 140-character preview, and could not. Older pastes go as their
 * preview, so a conversation with three songs pasted into it does not send all
 * three with every message.
 */
export function turnsForModel(turns: readonly ChatTurn[]): ChatTurn[] {
  let latestPaste = -1;
  turns.forEach((turn, i) => {
    if (turn.role === 'user' && turn.text.length > MAX_QUESTION_CHARS) latestPaste = i;
  });
  return turns.map((turn, i) => {
    if (turn.role !== 'user' || turn.text.length <= MAX_QUESTION_CHARS) return turn;
    if (i !== latestPaste) return { ...turn, text: compactForChat(turn.text) };
    const { instruction, notes } = splitMessage(turn.text);
    const page = trimNotes(notes, MAX_NOTES_CHARS);
    const part = page.length < notes.trim().length ? ', the first part of them' : '';
    return {
      ...turn,
      text: `${instruction ? `${instruction}\n` : ''}Pasted notes, ${wordCount(notes)} words${part}:\n${page}`,
    };
  });
}
