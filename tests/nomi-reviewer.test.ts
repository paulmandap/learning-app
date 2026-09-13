import { describe, expect, it } from 'vitest';
import {
  amendProposal,
  cleanTopic,
  proposeAction,
  proposeReviewer,
  readTitle,
  retitle,
  topicOf,
  type NomiAction,
} from '../src/core/nomi-actions';
import { EMPTY_SNAPSHOT, type AppSnapshot } from '../src/core/nomi-brain';

/**
 * Round five from daily use (NOTES §39): a title typed in Taglish, a title sent
 * as a message of its own, and a reviewer Nomi writes itself.
 */

const snapshot: AppSnapshot = {
  ...EMPTY_SNAPSHOT,
  name: 'Paul',
  sets: [{ id: 'bio', title: 'Biology Chapter 3', cards: 20, due: 0, missed: 0, known: 0 }],
};

// §37's stand-in ballad, not the real lyrics.
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

describe('a title typed into a Taglish paste', () => {
  // The owner's words, as the chat kept them.
  const REQUEST = 'nomi gawan mo nga ako reviewer, yung title ay "All Too Well by Taylor Swift" tapos ito yung contents:';

  for (const [shape, message] of [
    ['with the notes starting on the same line', `${REQUEST} ${SONG}`],
    ['with the notes on the next line', `${REQUEST}\n${SONG}`],
    ['with the curly quotes an iPhone types', `${REQUEST.replace('"All', '“All').replace('Swift"', 'Swift”')}\n${SONG}`],
  ] as const) {
    it(`takes the quoted title and leaves the request out of the notes, ${shape}`, () => {
      const action = proposeAction(message, snapshot)!.action as Extract<NomiAction, { kind: 'make_set' }>;
      expect(action.kind).toBe('make_set');
      expect(action.title).toBe('All Too Well by Taylor Swift');
      expect(action.notes.startsWith('I drove up north')).toBe(true);
      expect(action.notes).not.toMatch(/gawan|title ay|contents/);
    });
  }

  it('reads a title however it is given', () => {
    const cases: [string, string][] = [
      ['title is All Too Well.', 'All Too Well'],
      ['yung title ay "All Too Well by Taylor Swift" tapos ito yung contents', 'All Too Well by Taylor Swift'],
      ['ang title ay “Bio 3.1”', 'Bio 3.1'],
      ["call it 'Taylor's Version' please", "Taylor's Version"],
      ['make the title "All Too Well by Taylor Swift"', 'All Too Well by Taylor Swift'],
      ['palitan ang title ng Computer Hardware', 'Computer Hardware'],
      ['change the title to Bio 101 please', 'Bio 101'],
      ['rename it to Cells and Tissues', 'Cells and Tissues'],
      ['call it Bio 101 with 20 cards', 'Bio 101'],
    ];
    for (const [text, title] of cases) expect(readTitle(text), text).toBe(title);
  });

  it('is not fooled by a name that is not a title', () => {
    for (const text of ['my name is Sam', 'call me Paul', 'what is the title of this song?', "let's call it a day"]) {
      expect(readTitle(text), text).toBeNull();
    }
  });
});

describe('changing the offer on screen with a message', () => {
  // What Nomi offered the owner: a set named after the first words of his paste.
  const offer: NomiAction = { kind: 'make_set', title: 'nomi gawan mo nga ako reviewer,', notes: SONG, count: 10, countPicked: true };

  it("the owner's follow-up renames the offer and keeps its notes and count", () => {
    const p = amendProposal('make the title "All Too Well by Taylor Swift"', offer)!;
    expect(p.action).toEqual({ ...offer, title: 'All Too Well by Taylor Swift' });
    expect(p.say).toBe(`Okay, I'll call it "All Too Well by Taylor Swift".`);
  });

  it('reads the other ways of saying it, English and Filipino', () => {
    for (const message of [
      'call it Bio 101',
      'change the title to Bio 101',
      'the title should be "Bio 101"',
      'title: Bio 101',
      'palitan ang title ng Bio 101',
      'ang title ay Bio 101',
      'rename it to Bio 101 please',
    ]) {
      expect(amendProposal(message, offer)?.action, message).toMatchObject({ kind: 'make_set', title: 'Bio 101', notes: SONG });
    }
  });

  it('changes the count, alone or with the title — and a number in a title is not a count', () => {
    expect(amendProposal('make it 20 cards', offer)!.action).toMatchObject({ title: offer.title, count: 20, countPicked: false });
    expect(amendProposal('40', offer)!.action).toMatchObject({ count: 40 });
    expect(amendProposal('call it Bio 101 with 40 cards', offer)!.action).toMatchObject({ title: 'Bio 101', count: 40 });
    expect(amendProposal('call it "20 Questions"', offer)!.action).toMatchObject({ title: '20 Questions', count: 10 });
  });

  it('leaves everything else to the conversation', () => {
    for (const message of ["what's due", 'my name is Sam', 'call me Paul', 'what are 20 questions I could ask?', 'thanks nomi', 'hello musta k']) {
      expect(amendProposal(message, offer), message).toBeNull();
    }
  });

  it('an offer to add to a set has no title to change, but its count can change', () => {
    const adding: NomiAction = { kind: 'add_notes', setId: 'bio', setTitle: 'Biology Chapter 3', notes: SONG, count: 10, countPicked: true };
    expect(amendProposal('call it Bio 101', adding)).toBeNull();
    expect(amendProposal('20 cards', adding)!.action).toMatchObject({ kind: 'add_notes', count: 20 });
    expect(amendProposal('call it Bio 101', { kind: 'set_pet', pet: 'cat' })).toBeNull();
  });

  it('a reviewer offer can be renamed too', () => {
    const reviewer: NomiAction = { kind: 'write_reviewer', topic: 'computer parts', title: 'Computer Parts', count: 20, countPicked: true };
    expect(amendProposal('call it PC Hardware', reviewer)!.action).toEqual({ ...reviewer, title: 'PC Hardware' });
  });

  it("a title Gemini read is tidied the same way, and only lands on an offer that has one", () => {
    expect(retitle(offer, '  “All Too Well by Taylor Swift” ')!.action).toMatchObject({ title: 'All Too Well by Taylor Swift' });
    expect(retitle(offer, '   ')).toBeNull();
    expect(retitle({ kind: 'set_face', index: 2 }, 'Bio')).toBeNull();
  });
});

describe('a reviewer on a topic, written by Nomi', () => {
  it("the owner's request, word for word, is an offer to write one — not a request to paste notes", () => {
    const p = proposeAction('pwede mo ba ako gawan ng reviewer about computer parts?', snapshot)!;
    expect(p.action).toEqual({
      kind: 'write_reviewer',
      topic: 'computer parts',
      title: 'Computer Parts',
      count: 20,
      countPicked: true,
    });
    expect(p.say).toBe(
      'Want me to write a reviewer on computer parts, save it in Notes as "Computer Parts", and make 20 cards from it? I picked 20 to start.',
    );
  });

  it('reads the other ways of asking, with the count and title when given', () => {
    const cases: [string, Partial<Extract<NomiAction, { kind: 'write_reviewer' }>>][] = [
      ['make me a reviewer about the solar system', { topic: 'the solar system', title: 'Solar System', count: 20 }],
      ['can you create 40 flashcards on photosynthesis please', { topic: 'photosynthesis', title: 'Photosynthesis', count: 40, countPicked: false }],
      ['gawan ako ng reviewer tungkol sa mga bahagi ng halaman', { topic: 'mga bahagi ng halaman' }],
      ['gawan ako ng computer parts reviewer', { topic: 'computer parts', title: 'Computer Parts' }],
      ['write me study notes on the French Revolution, call it History Quiz 2', { topic: 'the French Revolution', title: 'History Quiz 2' }],
      ['make a set of flashcards about the heart', { topic: 'the heart', title: 'Heart' }],
      ['give me a quiz on DNA replication for my exam', { topic: 'DNA replication', title: 'DNA replication' }],
      ['make flashcards about cells, tissues and organs', { topic: 'cells, tissues and organs', title: 'Cells, Tissues and Organs' }],
      ['make me a reviewer about computer parts, thanks', { topic: 'computer parts' }],
    ];
    for (const [message, expected] of cases) {
      expect(proposeAction(message, snapshot)?.action, message).toMatchObject({ kind: 'write_reviewer', ...expected });
    }
  });

  it('does not take these for a request to write one', () => {
    for (const text of [
      'Quiz me on something',
      'quiz me on photosynthesis',
      'can you explain the notes on mitosis',
      'make flashcards from this',
      'make 20 flashcards about this',
      'how do I make flashcards about history?',
      'i need help with my notes on cells',
      'make me a new reviewer',
      'give me a set of 20 cards',
      'write a note about my day',
      'what are computer parts?',
      'gawan ng flashcards ang notes ko',
    ]) {
      expect(topicOf(text), text).toBeNull();
    }
  });

  it('pasted notes are still notes, whatever their first line says', () => {
    const p = proposeAction(`Make flashcards about this song:\n${SONG}`, snapshot)!;
    expect(p.action?.kind).toBe('make_set');
  });

  it('checks a topic Gemini named the same way as a typed one', () => {
    expect(cleanTopic('computer parts')).toBe('computer parts');
    expect(cleanTopic('  IT fundamentals ')).toBe('IT fundamentals');
    for (const bad of ['this', 'the notes', 'it', '', 'these notes', 'a new reviewer', '20 cards', 'one two three four five six seven eight nine']) {
      expect(cleanTopic(bad), bad).toBeNull();
    }
  });

  it("a topic from a follow-up becomes the same offer, with the count from the student's own words", () => {
    expect(proposeReviewer('computer parts', 'ikaw na bahala sa notes pls')!.action).toEqual({
      kind: 'write_reviewer',
      topic: 'computer parts',
      title: 'Computer Parts',
      count: 20,
      countPicked: true,
    });
    expect(proposeReviewer('computer parts', 'ikaw na bahala, 40 cards')!.action).toMatchObject({ count: 40, countPicked: false });
    expect(proposeReviewer('these notes', 'ikaw na bahala')).toBeNull();
  });
});
