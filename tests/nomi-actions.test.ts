import { describe, expect, it } from 'vitest';
import {
  actionCard,
  askLine,
  CARD_COUNTS,
  chooseCardCount,
  compactForChat,
  doneLine,
  findSet,
  proposeAction,
  splitMessage,
  statedCount,
  suggestTitle,
  type NomiAction,
} from '../src/core/nomi-actions';
import { EMPTY_SNAPSHOT, type AppSnapshot } from '../src/core/nomi-brain';

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

const NOTES = `Photosynthesis\n${prose(120)}`;

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
  it('pasted notes alone: a new set, titled from the notes, count picked', () => {
    const p = proposeAction(NOTES, snapshot)!;
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
    const action = proposeAction(`I said your name once like a word from another language\n${SONG}`, snapshot)!.action;
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
    const shown = compactForChat(`Make flashcards from this:\n${NOTES}`);
    expect(shown).toMatch(/^Make flashcards from this:\nPasted notes, 121 words: "Photosynthesis word0/);
    expect(shown.length).toBeLessThan(260);
  });

  it('leaves an ordinary message exactly as typed', () => {
    expect(compactForChat('what does xylem do?')).toBe('what does xylem do?');
  });
});
