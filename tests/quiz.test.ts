import { describe, expect, it } from 'vitest';
import { choicesFor, choicesFrom, choicesFromSet, isWritten, needsChoices, type QuizCard } from '../src/core/quiz';

function card(over: Partial<QuizCard> & { id: string; answer: string }): QuizCard {
  return {
    kind: 'flashcard',
    level: 'remember',
    prompt: `Question for ${over.id}?`,
    options: null,
    rubric: null,
    ...over,
  };
}

/** The reproduction's shape (NOTES §38): a set of flashcards and nothing else. */
const flashcards: QuizCard[] = [
  card({ id: 'a', answer: 'Cider' }),
  card({ id: 'b', answer: 'Dean' }),
  card({ id: 'c', answer: 'A jar of honey' }),
  card({ id: 'd', answer: 'The farmers market' }),
  card({ id: 'e', answer: 'Late October' }),
  card({ id: 'f', answer: 'Twenty minutes fast', level: 'understand' }),
];

describe('which cards the quiz asks, and how', () => {
  it('asks a marked written question as written, and everything else as a choice', () => {
    const written = card({
      id: 'w',
      answer: 'Because…',
      kind: 'short_answer',
      rubric: { expected_concepts: [{ id: 'c1', text: 'A point' }] },
    });
    expect(isWritten(written)).toBe(true);
    expect(isWritten(card({ id: 'x', answer: 'y' }))).toBe(false);
    // A written answer with nothing to mark it against is asked as a choice.
    expect(isWritten({ kind: 'short_answer', rubric: { expected_concepts: [] } })).toBe(false);
  });

  it('knows which cards still need choices written', () => {
    expect(needsChoices(card({ id: 'a', answer: 'Cider' }))).toBe(true);
    expect(
      needsChoices(
        card({
          id: 'm',
          answer: 'Cider',
          kind: 'mcq',
          options: [
            { text: 'Cider', correct: true },
            { text: 'Tea', correct: false },
            { text: 'Milk', correct: false },
          ],
        }),
      ),
    ).toBe(false);
  });

  it('the reproduction: a set of only flashcards gets a question for every card', () => {
    for (const c of flashcards) {
      const choices = choicesFor(c, flashcards);
      expect(choices, c.id).not.toBeNull();
      expect(choices!.filter((o) => o.correct)).toEqual([{ text: c.answer, correct: true }]);
    }
  });
});

describe('choicesFrom — wrong answers Gemini wrote, checked', () => {
  const peaches = { prompt: 'What did the owner give them?', answer: 'Two free peaches and a warning about the rain' };

  it('makes four choices, the right one marked', () => {
    const options = choicesFrom(peaches, ['A jar of honey', 'A map of the lake', 'Two paper lanterns'])!;
    expect(options).toHaveLength(4);
    expect(options[0]).toEqual({ text: peaches.answer, correct: true });
    expect(options.slice(1).every((o) => !o.correct)).toBe(true);
  });

  it('refuses a "wrong" answer that is the right one reworded', () => {
    expect(choicesFrom(peaches, ['Two peaches and a warning about the rain', 'A jar of honey', 'A map'])).toBeNull();
  });

  it('refuses duplicates, blanks and paragraphs, and needs three that survive', () => {
    expect(choicesFrom(peaches, ['A jar of honey', 'a jar of honey', 'A map'])).toBeNull();
    expect(choicesFrom(peaches, ['', 'A jar of honey', 'A map'])).toBeNull();
    expect(choicesFrom(peaches, ['x'.repeat(200), 'A jar of honey', 'A map'])).toBeNull();
    expect(choicesFrom(peaches, ['A jar of honey', 'A map', 'A coat', 'A key'])).toHaveLength(4);
  });
});

describe('choicesFromSet — the fallback that keeps the quiz from ever being empty', () => {
  it('takes wrong answers from the other cards, never the card itself or its twin', () => {
    const twin = card({ id: 'g', answer: 'cider' });
    const options = choicesFromSet(flashcards[0]!, [...flashcards, twin])!;
    const wrong = options.filter((o) => !o.correct).map((o) => o.text);
    expect(wrong).toHaveLength(3);
    expect(wrong).not.toContain('Cider');
    expect(wrong).not.toContain('cider');
  });

  it('prefers the same level, then answers of a similar length', () => {
    const wrong = choicesFromSet(flashcards[1]!, flashcards)!
      .filter((o) => !o.correct)
      .map((o) => o.text);
    // "Dean" is short: "Cider" and "Late October" are nearer than the rest, and
    // "Twenty minutes fast" is at another level.
    expect(wrong).toContain('Cider');
    expect(wrong).not.toContain('Twenty minutes fast');
  });

  it('gives up only when the set has too few different answers', () => {
    const tiny = [card({ id: 'a', answer: 'Cider' }), card({ id: 'b', answer: 'Dean' })];
    expect(choicesFromSet(tiny[0]!, tiny)).toBeNull();
  });

  it('uses the card’s own choices when it has them', () => {
    const own = [
      { text: 'Cider', correct: true },
      { text: 'Tea', correct: false },
      { text: 'Milk', correct: false },
      { text: 'Water', correct: false },
    ];
    expect(choicesFor({ ...flashcards[0]!, options: own }, flashcards)).toBe(own);
  });
});
