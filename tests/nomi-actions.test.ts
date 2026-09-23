import { describe, expect, it } from 'vitest';
import {
  actionCard,
  amendProposal,
  askLine,
  CARD_COUNTS,
  chooseCardCount,
  compactForChat,
  doneLine,
  findSet,
  proposeAction,
  proposeNotesSet,
  splitMessage,
  statedCount,
  suggestTitle,
  turnsForModel,
  type NomiAction,
} from '../src/core/nomi-actions';
import { EMPTY_SNAPSHOT, type AppSnapshot } from '../src/core/nomi-brain';
import { MAX_NOTES_CHARS, type ChatTurn } from '../src/core/chat';

const snapshot: AppSnapshot = {
  ...EMPTY_SNAPSHOT,
  name: 'Paul',
  sets: [
    { id: 'bio', title: 'Biology Chapter 3', cards: 20, due: 0, missed: 0, known: 0 },
    { id: 'hist', title: 'World History', cards: 10, due: 0, missed: 0, known: 0 },
    { id: 'hist2', title: 'History of Art', cards: 12, due: 0, missed: 0, known: 0 },
  ],
};

/** n words of prose, in sentences, so every count below is exact. */
function prose(n: number): string {
  const words = Array.from({ length: n }, (_, i) => `word${i}`);
  const sentences: string[] = [];
  for (let i = 0; i < words.length; i += 10) sentences.push(`${words.slice(i, i + 10).join(' ')}.`);
  return sentences.join(' ');
}

/** Short enough to be a chat message, about 860 characters. */
const NOTES = `Photosynthesis\n${prose(120)}`;

/** Too long to be a chat message — a paste, about 1,500 characters. */
const LONG_NOTES = `Photosynthesis\n${prose(200)}`;

/** The owner's kind of message (NOTES §45): 71 words about their day, and not notes. */
const ABOUT_MY_DAY =
  "hi nomi, so today was really tiring. our teacher in computer programming gave us a surprise quiz and i think i did badly because i didn't review last night. i'm kinda stressed because midterms are next week and i still have so many topics to cover, like loops, arrays and functions. can you give me some tips on how to manage my time so i can study everything before the exam?";

describe('chooseCardCount — the largest count the notes hold (NOTES §37)', () => {
  it('picks from the four counts the app offers', () => {
    expect(CARD_COUNTS).toEqual([10, 20, 40, 60]);
  });

  it('the owner’s song, 965 words, supports 13, so 10', () => {
    expect(chooseCardCount(prose(965))).toBe(10);
  });

  it('grows with the notes, and stops at 60', () => {
    expect(chooseCardCount(prose(1500))).toBe(20);
    expect(chooseCardCount(prose(3000))).toBe(40);
    expect(chooseCardCount(prose(5000))).toBe(60);
    expect(chooseCardCount(prose(20000))).toBe(60);
  });

  it('never below 10, however short', () => {
    expect(chooseCardCount(prose(80))).toBe(10);
  });

  it('counts structured notes by what is in them, not by words', () => {
    // 40 bulleted items of 7 words: 280 words would say 4 cards by prose, but
    // the items say 28 (capped at one per 10 words), so 20.
    const list = Array.from({ length: 40 }, (_, i) => `- Item ${i} has five whole words`).join('\n');
    expect(chooseCardCount(list)).toBe(20);
  });
});

describe('statedCount', () => {
  it('reads a number the student typed, in figures or in words', () => {
    expect(statedCount('make 20 flashcards from this')).toBe(20);
    expect(statedCount('twenty cards please')).toBe(20);
    expect(statedCount('make 15 questions')).toBe(15);
  });

  it('never goes past the most one request can make', () => {
    expect(statedCount('make 100 cards')).toBe(60);
  });

  it('is null when no count was given, and not fooled by other numbers', () => {
    expect(statedCount('make flashcards from this')).toBeNull();
    expect(statedCount('chapter 3 notes')).toBeNull();
  });
});

describe('splitMessage', () => {
  it('takes an instruction on its own first line', () => {
    expect(splitMessage(`Make 20 flashcards from this:\n${NOTES}`)).toEqual({
      instruction: 'Make 20 flashcards from this:',
      notes: NOTES,
    });
  });

  it('takes an instruction before a colon on the same line', () => {
    const { instruction, notes } = splitMessage('Turn this into a set: The heart has four chambers.');
    expect(instruction).toBe('Turn this into a set');
    expect(notes).toBe('The heart has four chambers.');
  });

  it('does not mistake a heading for an instruction', () => {
    expect(splitMessage(`Set theory basics\n${prose(60)}`).instruction).toBe('');
  });
});

describe('proposeAction — pasted notes become a set', () => {
  it('a long paste alone: a new set, titled from the notes, count picked', () => {
    const p = proposeAction(LONG_NOTES, snapshot)!;
    expect(p.action).toMatchObject({ kind: 'make_set', title: 'Photosynthesis', count: 10, countPicked: true });
    expect(p.say).toContain('I picked 10');
  });

  it('uses the count and the name the student gave', () => {
    const p = proposeAction(`Make 40 flashcards from this, call it Cell Biology:\n${NOTES}`, snapshot)!;
    expect(p.action).toMatchObject({ kind: 'make_set', title: 'Cell Biology', count: 40, countPicked: false });
    expect(p.say).not.toContain('I picked');
  });

  it('keeps the notes whole, without the instruction in them', () => {
    const p = proposeAction(`Make flashcards from these:\n${NOTES}`, snapshot)!;
    expect((p.action as Extract<NomiAction, { kind: 'make_set' }>).notes).toBe(NOTES);
  });

  it('adds notes to a set it can find', () => {
    const p = proposeAction(`add these to my biology set:\n${NOTES}`, snapshot)!;
    expect(p.action).toMatchObject({ kind: 'add_notes', setId: 'bio', setTitle: 'Biology Chapter 3' });
  });

  it('says so, and does nothing, when it cannot find the set', () => {
    const p = proposeAction(`add these to my chemistry set:\n${NOTES}`, snapshot)!;
    expect(p.action).toBeNull();
    expect(p.say).toMatch(/couldn't find a set called "chemistry"/);
  });

  it('treats a very long paste as notes even without an instruction', () => {
    const p = proposeAction(prose(400), snapshot)!;
    expect(p.action?.kind).toBe('make_set');
  });

  it('leaves a question about pasted notes to the conversation', () => {
    expect(proposeAction(`Explain this to me:\n${prose(80)}`, snapshot)).toBeNull();
    expect(proposeAction(`Can you summarize this ${prose(80)}`, snapshot)).toBeNull();
  });

  it('leaves short messages alone', () => {
    for (const text of ['hi', 'what should I study?', "what's due", 'thanks nomi', 'make it quick']) {
      expect(proposeAction(text, snapshot), text).toBeNull();
    }
  });
});

describe('a message that asks for nothing is not notes for being long (NOTES §45)', () => {
  it("leaves the owner's kind of message — 71 words about their day — to the conversation", () => {
    // It was offered as a set called "hi nomi, so today was really".
    expect(proposeAction(ABOUT_MY_DAY, snapshot)).toBeNull();
  });

  it("leaves the owner's own message alone — about getting up, typed on an iPhone", () => {
    // Its start is the owner's, as the saved preview kept it: "Pasted notes, 80
    // words". Offered as a set "hey i did got up and", then cut, so Nomi said
    // "the rest of the text was cut off". The rest here is in the same voice.
    const rant =
      "hey i did got up and it’s been 2 hrs. i took a bath, ate breakfast, started doing my pre-interview task. but i feel so much heavy in my chest and i don’t know why. i keep checking my phone and i can’t focus on anything for more than a few minutes. i still have so many things to finish today and it feels like i’m already behind before the day even started.";
    expect(proposeAction(rant, snapshot)).toBeNull();
    expect(compactForChat(rant)).toBe(rant);
  });

  it('leaves a paste that fits a chat message to Gemini, which can tell notes from a message', () => {
    expect(proposeAction(NOTES, snapshot)).toBeNull();
  });

  it('offers the set once Gemini says it is notes, with the title and count a request would get', () => {
    const p = proposeNotesSet(NOTES, snapshot)!;
    expect(p.action).toMatchObject({ kind: 'make_set', title: 'Photosynthesis', notes: NOTES, count: 10, countPicked: true });
    expect(p.say).toContain('I picked 10');
  });

  it('offers nothing when there is too little to make cards from, whatever Gemini says', () => {
    expect(proposeNotesSet('The heart has four chambers.', snapshot)).toBeNull();
  });
});

describe("proposeAction — the owner's own request (NOTES §38)", () => {
  // The shape of what the owner sent: an instruction typed straight into the
  // paste, on the same line as the first line of the song. The lines here are
  // from the stand-in ballad of §37, not the real lyrics.
  const INSTRUCTION = 'can you make me a notes of this? make 10 flash cards. title is All Too Well.';
  const SONG = [
    'I drove up north with the windows down in late October',
    'You had a thermos full of cider and a map you never read',
    'The radio kept cutting out between the pines and the water',
    "And you sang the parts you didn't know in your own words instead",
    'We stopped at a gas station where the owner knew your grandpa',
    'He gave us two free peaches and a warning about the rain',
    'You laughed and said the sky was only practicing its thunder',
    "And I believed you like I'd believe you over and over again",
  ].join('\n');

  for (const [shape, message] of [
    ['on the same line as the notes', `${INSTRUCTION} ${SONG}`],
    ['on a line of its own', `${INSTRUCTION}\n${SONG}`],
  ] as const) {
    it(`takes the title, the count and the notes from an instruction ${shape}`, () => {
      const action = proposeAction(message, snapshot)!.action as Extract<NomiAction, { kind: 'make_set' }>;
      expect(action.kind).toBe('make_set');
      expect(action.title).toBe('All Too Well');
      expect(action.count).toBe(10);
      expect(action.countPicked).toBe(false);
      // The request itself is not study material.
      expect(action.notes).not.toMatch(/flash cards|title is/i);
      expect(action.notes.startsWith('I drove up north')).toBe(true);
    });
  }

  it('reads the other ways a title is given', () => {
    for (const phrase of ['titled Bio 3.1', 'call it Bio 3.1', 'name it Bio 3.1', 'title: Bio 3.1', 'the title should be Bio 3.1']) {
      const action = proposeAction(`Make flashcards from this, ${phrase}.\n${SONG}`, snapshot)!.action;
      expect(action, phrase).toMatchObject({ kind: 'make_set', title: 'Bio 3.1' });
    }
  });

  it('does not take a first line of notes for an instruction because it names something', () => {
    // Short enough to be a message, so it reaches an offer through Gemini saying it is notes (§45).
    const action = proposeNotesSet(`I said your name once like a word from another language\n${SONG}`, snapshot)!.action;
    expect(action).toMatchObject({ kind: 'make_set', title: 'I said your name once like' });
  });
});

describe('proposeAction — the small writes', () => {
  it('renames a set it can find', () => {
    expect(proposeAction('rename world history to History 101', snapshot)!.action).toEqual({
      kind: 'rename_set',
      setId: 'hist',
      from: 'World History',
      to: 'History 101',
    });
    expect(proposeAction('Please rename my "Biology Chapter 3" set to "Bio 3"', snapshot)!.action).toMatchObject({
      setId: 'bio',
      to: 'Bio 3',
    });
  });

  it('will not guess between two sets that both fit — it asks which', () => {
    const p = proposeAction('rename history to Past', snapshot)!;
    expect(p.action).toBeNull();
    expect(p.say).toBe('Which set do you mean: "World History" or "History of Art"?');
  });

  it('saves text as a note, however short', () => {
    expect(proposeAction('save this as a note:\nBring the lab coat on Friday', snapshot)!.action).toEqual({
      kind: 'save_note',
      title: 'Bring the lab coat on Friday',
      body: 'Bring the lab coat on Friday',
    });
  });

  it('sets a name, and ignores what only looks like one', () => {
    expect(proposeAction('call me Paul', snapshot)!.action).toEqual({ kind: 'set_name', name: 'Paul' });
    expect(proposeAction('My name is Sam.', snapshot)!.action).toEqual({ kind: 'set_name', name: 'Sam' });
    for (const text of ['call me later', "what's my name", 'my name is what?', 'do you know my name']) {
      expect(proposeAction(text, snapshot), text).toBeNull();
    }
  });

  it('switches the pet, and ignores a question about pets', () => {
    expect(proposeAction('switch my pet to the cat', snapshot)!.action).toEqual({ kind: 'set_pet', pet: 'cat' });
    expect(proposeAction('I want the dog', snapshot)!.action).toEqual({ kind: 'set_pet', pet: 'dog' });
    expect(proposeAction('is a cat a good pet?', snapshot)).toBeNull();
  });

  it('picks a face by the number the student sees, and refuses one that does not exist', () => {
    expect(proposeAction('use face 3', snapshot)!.action).toEqual({ kind: 'set_face', index: 2 });
    const p = proposeAction('use face 13', snapshot)!;
    expect(p.action).toBeNull();
    expect(p.say).toMatch(/1 to 12/);
  });
});

describe('the allow-list', () => {
  it('holds exactly the writes the owner approved, and nothing destructive', () => {
    const kinds: NomiAction['kind'][] = [
      'make_set',
      'add_notes',
      'write_reviewer',
      'rename_set',
      'save_note',
      'set_name',
      'set_pet',
      'set_face',
    ];
    // A compile-time list checked at run time: every kind has words for all
    // three places Nomi speaks about it.
    const samples: NomiAction[] = [
      { kind: 'make_set', title: 'T', notes: 'n', count: 10, countPicked: true },
      { kind: 'add_notes', setId: 's', setTitle: 'T', notes: 'n', count: 10, countPicked: false },
      { kind: 'write_reviewer', topic: 'computer parts', title: 'Computer Parts', count: 20, countPicked: true },
      { kind: 'rename_set', setId: 's', from: 'A', to: 'B' },
      { kind: 'save_note', title: 'T', body: 'b' },
      { kind: 'set_name', name: 'Sam' },
      { kind: 'set_pet', pet: 'cat' },
      { kind: 'set_face', index: 0 },
    ];
    expect(samples.map((s) => s.kind)).toEqual(kinds);
    for (const kind of kinds) expect(kind).not.toMatch(/delete|remove|sign|key|clear/);
    for (const action of samples) {
      const words = [askLine(action), doneLine(action), ...Object.values(actionCard(action))].join(' ');
      expect(words.length).toBeGreaterThan(0);
      expect(words).not.toMatch(/\bmodel\b|\btoken\b|\bAPI\b|\bprompt\b|pipeline|undefined|null/i);
    }
  });
});

describe('findSet and suggestTitle', () => {
  it('matches a set by part of its name when only one fits', () => {
    expect(findSet('biology', snapshot.sets)?.id).toBe('bio');
    expect(findSet('art', snapshot.sets)?.id).toBe('hist2');
    expect(findSet('chemistry', snapshot.sets)).toBeNull();
  });

  it('names notes from their first line, kept short', () => {
    expect(suggestTitle('# Cell Biology\nThe cell is…')).toBe('Cell Biology');
    expect(suggestTitle('The mitochondria is the powerhouse of the whole living cell and more')).toBe(
      'The mitochondria is the powerhouse of',
    );
    expect(suggestTitle('   ')).toBe('My notes');
  });
});

describe('compactForChat', () => {
  it('shows a paste as how much was pasted, not the whole page', () => {
    const shown = compactForChat(`Make flashcards from this:\n${LONG_NOTES}`);
    expect(shown).toMatch(/^Make flashcards from this:\nPasted notes, 201 words: "Photosynthesis word0/);
    expect(shown.length).toBeLessThan(260);
  });

  it('leaves an ordinary message exactly as typed', () => {
    expect(compactForChat('what does xylem do?')).toBe('what does xylem do?');
  });

  it('shows anything that fits a chat message whole, however many words (NOTES §45)', () => {
    // The owner's 71 words came back as "Pasted notes, 71 words: …", cut mid-sentence.
    expect(compactForChat(ABOUT_MY_DAY)).toBe(ABOUT_MY_DAY);
    expect(compactForChat(`Make flashcards from this:\n${NOTES}`)).toBe(`Make flashcards from this:\n${NOTES}`);
  });
});

describe('turnsForModel — what Gemini is sent (NOTES §45)', () => {
  it('sends a message that fits a chat message as it was typed', () => {
    const turns: ChatTurn[] = [
      { role: 'user', text: ABOUT_MY_DAY },
      { role: 'nomi', text: 'That sounds like a lot.' },
    ];
    expect(turnsForModel(turns)).toEqual(turns);
  });

  it('sends the latest paste as its notes, so Nomi can say what they hold', () => {
    const [sent] = turnsForModel([{ role: 'user', text: `Make flashcards from this:\n${LONG_NOTES}` }]);
    expect(sent!.text).toMatch(/^Make flashcards from this:\nPasted notes, 201 words:\nPhotosynthesis/);
    expect(sent!.text).toContain('word199.');
  });

  it('sends a page of a very long paste, and says it is the first part', () => {
    const [sent] = turnsForModel([{ role: 'user', text: prose(2000) }]);
    expect(sent!.text).toMatch(/^Pasted notes, 2000 words, the first part of them:\n/);
    expect(sent!.text.length).toBeLessThan(MAX_NOTES_CHARS + 100);
  });

  it('sends an older paste as its preview only', () => {
    const sent = turnsForModel([
      { role: 'user', text: LONG_NOTES },
      { role: 'nomi', text: 'Want me to make a set?' },
      { role: 'user', text: prose(300) },
    ]);
    expect(sent[0]!.text).toMatch(/^Pasted notes, 201 words: "/);
    expect(sent[2]!.text).toMatch(/^Pasted notes, 300 words:\n/);
  });
});

describe('his own questions, kept as he wrote them (NOTES §49)', () => {
  /** Five Q:A pairs: 40-odd words, under the 50 a paste of prose needs. */
  const QA = [
    'Q: What is osmosis?',
    'A: Water moving across a membrane.',
    'Q: What is diffusion?',
    'A: Particles spreading out.',
    'Q: What is ATP?',
    'A: The energy of the cell.',
    'Q: Why do cells divide?',
    'A: To grow and to repair.',
    'Q: What is a gene?',
    'A: A unit of heredity.',
  ].join('\n');

  const offerFor = (message: string) => proposeAction(message, snapshot)?.action as Extract<
    NomiAction,
    { kind: 'make_set' }
  >;

  it('offers a set for Q:A notes too short to count as a paste of prose', () => {
    const action = offerFor(`make flashcards from these\n${QA}`);
    expect(action).toMatchObject({ kind: 'make_set', kept: 5, count: 5 });
  });

  it('names the set without his "Q:" label', () => {
    expect(offerFor(`make flashcards from these\n${QA}`).title).toBe('What is osmosis?');
    expect(suggestTitle('1. Question: Ano ang photosynthesis?\nAnswer: …')).toBe('Ano ang photosynthesis?');
  });

  it('says it will keep them, and picks exactly as many as he wrote', () => {
    const action = offerFor(`make flashcards from these\n${QA}`);
    expect(askLine(action)).toBe(
      `Want me to make a new set, "${action.title}", from your notes? I'll keep your 5 questions exactly as you wrote them.`,
    );
    expect(actionCard(action)).toEqual({
      heading: 'New set',
      detail: `${action.title} · 5 cards`,
      confirm: 'Make it',
      note: 'Your 5 questions, as you wrote them',
    });
    expect(doneLine(action)).toBe(`Done. I'm making 5 cards for "${action.title}" now.`);
  });

  it('writes the rest of a bigger count, and says so', () => {
    const action = { ...offerFor(`make 20 flashcards from these\n${QA}`) };
    expect(action).toMatchObject({ kept: 5, count: 20 });
    expect(askLine(action)).toMatch(/I'll keep your 5 questions exactly as you wrote them\. And I'll write 15 more of my own\.$/);
    expect(actionCard(action).detail).toMatch(/· 20 cards$/);
  });

  it('never makes fewer than his questions, whatever count is tapped', () => {
    const action = { ...offerFor(`make flashcards from these\n${QA}`), count: 2 };
    expect(doneLine(action)).toMatch(/making 5 cards/);
  });

  it('lets Nomi reword them when he says so, and keeps them again when he says that', () => {
    const offered = offerFor(`make flashcards from these\n${QA}`);

    const reworded = amendProposal('reword them please', offered)!;
    expect(reworded.say).toBe("Okay, I'll write new questions from your notes.");
    expect(reworded.action).not.toHaveProperty('kept');
    expect(askLine(reworded.action!)).toMatch(/^Want me to make a new set, ".+", with 5 cards\?/);

    const keptAgain = amendProposal("keep them as is, don't reword", reworded.action!)!;
    expect(keptAgain.say).toBe("Okay, I'll keep your 5 questions exactly as you wrote them.");
    expect(keptAgain.action).toMatchObject({ kept: 5 });
  });

  it('says so when there is nothing of his to keep', () => {
    const prosey = proposeAction(`make flashcards from these\n${NOTES}`, snapshot)!.action!;
    expect(prosey).not.toHaveProperty('kept');
    expect(amendProposal('keep them word for word', prosey)!.say).toMatch(/couldn't find questions/);
  });

  it('keeps his questions when Gemini is the one who saw they were notes', () => {
    expect(proposeNotesSet(QA, snapshot)!.action).toMatchObject({ kind: 'make_set', kept: 5 });
  });

  it('leaves prose offers exactly as they were', () => {
    const action = proposeAction(`make flashcards from these\n${NOTES}`, snapshot)!.action!;
    expect(askLine(action)).toMatch(/with 10 cards\? I picked 10 for notes this long\.$/);
    expect(actionCard(action)).not.toHaveProperty('note');
  });
});
