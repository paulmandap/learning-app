/**
 * What Nomi can do in the app, not just say (NOTES §37).
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
 * that were offered.
 *
 * ## The allow-list is the type
 *
 * `NomiAction` is every write Nomi can make. There is no delete in it, no
 * sign-out and no key: an action that is not in the union cannot be proposed,
 * and the executor imports none of the functions that do those things —
 * `tests/screens.test.ts` reads it to make sure.
 *
 * ## Recognised here, not by the model
 *
 * Like the brain's questions, each request is matched by narrow patterns: free,
 * instant and testable, with near-misses in the tests that must NOT become an
 * action ("call me later", "is a cat a pet?", "explain this: …"). Words these
 * miss go to Gemini as ordinary chat, and Nomi's instruction tells it to say the
 * words that work. A write the model proposed would need these same checks,
 * after a call that spends the daily allowance.
 */

import { supportedFor } from './planner';
import { normalize, wordCount } from './text';
import { FACE_COUNT } from './avatar';
import { MAX_QUESTION_CHARS } from './chat';
import type { PetSpecies } from './pet';
import type { AppSnapshot, BrainSet } from './nomi-brain';

/** The counts the app offers — the same four as Add notes. */
export const CARD_COUNTS = [10, 20, 40, 60] as const;

/** The most cards one request can make, whatever number is typed. */
export const MAX_CARDS = 60;

/** Below this many words, a message is a message rather than notes. */
export const NOTES_MIN_WORDS = 50;

export type NomiAction =
  | { kind: 'make_set'; title: string; notes: string; count: number; countPicked: boolean }
  | { kind: 'add_notes'; setId: string; setTitle: string; notes: string; count: number; countPicked: boolean }
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

/** "make 20 flashcards", "twenty cards" — the number they asked for, or null. */
export function statedCount(instruction: string): number | null {
  const match = instruction.match(
    /\b(\d{1,3}|five|ten|fifteen|twenty|thirty|forty|fifty|sixty)\s+(?:flash\s*cards?|cards?|questions?|items?)\b/i,
  );
  if (!match) return null;
  const raw = match[1]!.toLowerCase();
  const n = /^\d+$/.test(raw) ? Number(raw) : NUMBER_WORDS[raw]!;
  return Math.max(1, Math.min(MAX_CARDS, n));
}

/** Asks to make cards: a verb, then something cards come in. */
const MAKE = /\b(?:make|create|turn|generate|build)\b[\s\S]*?\b(?:flash\s*cards?|cards?|quiz(?:zes)?|set|deck)\b/i;
/** "add these to my Biology set". */
const ADD_TO =
  /\badd\s+(?:this|these|them|it|these notes|this note|the notes)\s+(?:to|into)\s+(?:my\s+|the\s+)?["“']?(.+?)["”']?(?:\s+(?:set|deck))?\s*[:.!]*$/i;
/** "save this as a note", "put these in my notes". */
const SAVE = /\b(?:save|keep|put|store)\b[\s\S]*?\bnotes?\b/i;
/** A paste that comes with a question about it, which is Gemini's, not an action. */
const ASK =
  /^(?:(?:can|could) you\s+|please\s+)?(?:explain|summari[sz]e|what does|what do|what is this|tell me about|help me understand|quiz me)\b/i;
/** "…, call it Cell Biology". */
const NAMED = /\b(?:called|named|name it|title it|call it)\s+["“']?([^"”'\n:]{1,60}?)["”']?\s*(?:[:.,!]|$)/i;

const RENAME =
  /^(?:(?:please|pls|can you|could you)[\s,]+)*(?:rename|change the name of)\s+(?:my\s+|the\s+)?["“']?(.+?)["”']?\s+(?:set\s+|deck\s+)?(?:to|as|into)\s+["“']?(.+?)["”']?\s*[.!]*$/i;
const NAME = /^(?:(?:please|pls)[\s,]+)?(?:call me|my name is|i'?m called|you can call me)\s+([\p{L}][\p{L}'’ -]{0,39}?)\s*[.!]*$/iu;
/** Words that follow "call me" without being a name. */
const NOT_A_NAME = /^(?:later|back|maybe|tomorrow|now|when|if|anytime|sometime)\b/i;
const PET =
  /\b(?:change|switch|set|make|swap|turn)\s+(?:my\s+)?(?:study\s+)?pet\s+(?:to|into|for)\s+(?:a\s+|an\s+|the\s+)?(potato|cat|dog)\b|\bi\s*(?:want|'?d like)\s+(?:the\s+|a\s+)?(potato|cat|dog)\b/i;
const FACE =
  /\b(?:use|pick|choose|switch to|change to|set)\s+(?:my\s+)?(?:(?:profile\s+)?(?:picture|avatar|pic|photo)\s+(?:to\s+)?)?face\s*(?:number\s*|#\s*)?(\d{1,2})\b/i;

/**
 * Separate an instruction from the notes it is about.
 *
 * "Make 20 flashcards from this:" on its own first line, or before a colon on
 * the same line. Anything else is all notes — a first line that merely contains
 * "set" ("Set theory basics") is a heading, not a request, because an
 * instruction needs its verb.
 */
export function splitMessage(message: string): { instruction: string; notes: string } {
  const text = message.trim();
  const isInstruction = (line: string) =>
    wordCount(line) <= 25 && (MAKE.test(line) || ADD_TO.test(line) || SAVE.test(line));

  const [first = '', ...rest] = text.split(/\r?\n/);
  if (rest.length > 0 && isInstruction(first.trim())) {
    return { instruction: first.trim(), notes: rest.join('\n').trim() };
  }
  const colon = text.match(/^([^:\n]{3,160}):\s*([\s\S]+)$/);
  if (colon && isInstruction(colon[1]!)) {
    return { instruction: colon[1]!.trim(), notes: colon[2]!.trim() };
  }
  return { instruction: '', notes: text };
}

/** A name for a set or note: the notes' first line, kept short. */
export function suggestTitle(notes: string): string {
  const first =
    notes
      .split(/\r?\n/)
      .map((line) => line.replace(/^#{1,6}\s+/, '').replace(/[:\s]+$/, '').trim())
      .find((line) => line.length > 0) ?? '';
  const words = first.split(/\s+/).filter(Boolean);
  const short = words.length <= 8 ? first : words.slice(0, 6).join(' ');
  const clipped = short.length > 60 ? short.slice(0, 60).replace(/\s+\S*$/, '') : short;
  return clipped || 'My notes';
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
      const to = rename[2]!.trim().slice(0, 80);
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
  if (notes.length === 0) return null;

  if (instruction && SAVE.test(instruction) && !MAKE.test(instruction)) {
    const named = NAMED.exec(instruction)?.[1]?.trim();
    return propose({ kind: 'save_note', title: named || suggestTitle(notes), body: notes });
  }

  const long = text.length > MAX_QUESTION_CHARS;
  if (!long && wordCount(notes) < NOTES_MIN_WORDS) return null;
  if (!instruction && ASK.test(text)) return null;

  const stated = instruction ? statedCount(instruction) : null;
  const count = stated ?? chooseCardCount(notes);

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
    });
  }

  const named = instruction ? NAMED.exec(instruction)?.[1]?.trim() : undefined;
  return propose({
    kind: 'make_set',
    title: named || suggestTitle(notes),
    notes,
    count,
    countPicked: stated === null,
  });
}

/** Nomi asking whether to go ahead. */
export function askLine(action: NomiAction): string {
  switch (action.kind) {
    case 'make_set':
      return (
        `Want me to make a new set, "${action.title}", with ${plural(action.count, 'card')}?` +
        (action.countPicked ? ` I picked ${action.count} for notes this long.` : '')
      );
    case 'add_notes':
      return (
        `Want me to add these notes to "${action.setTitle}" and make ${plural(action.count, 'card')} from them?` +
        (action.countPicked ? ` I picked ${action.count} for notes this long.` : '')
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
      return `Done. I'm making ${plural(action.count, 'card')} for "${action.title}" now.`;
    case 'add_notes':
      return `Done. I'm adding ${plural(action.count, 'card')} to "${action.setTitle}" now.`;
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

/** The card Nomi shows under its question: what it is, the gist, and the button. */
export function actionCard(action: NomiAction): { heading: string; detail: string; confirm: string } {
  switch (action.kind) {
    case 'make_set':
      return { heading: 'New set', detail: `${action.title} · ${plural(action.count, 'card')}`, confirm: 'Make it' };
    case 'add_notes':
      return { heading: 'Add to a set', detail: `${action.setTitle} · ${plural(action.count, 'card')}`, confirm: 'Add them' };
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
 * page as a chat bubble, which would bury everything around it, and not a copy
 * in the saved history, which is for what was SAID.
 */
export function compactForChat(message: string): string {
  const text = message.trim();
  const { instruction, notes } = splitMessage(text);
  const words = wordCount(notes);
  if (text.length <= MAX_QUESTION_CHARS && words < NOTES_MIN_WORDS) return text;
  const preview = notes.replace(/\s+/g, ' ').slice(0, 140).replace(/\s+\S*$/, '');
  return `${instruction ? `${instruction}\n` : ''}Pasted notes, ${words} words: "${preview}…"`;
}
