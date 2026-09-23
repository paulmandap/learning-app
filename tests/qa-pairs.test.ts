import { describe, expect, it } from 'vitest';
import {
  countChoices,
  countLine,
  findQaPairs,
  keepDetail,
  keepHeading,
  keptOnPages,
  keptPairsOf,
  keptTarget,
  levelFor,
  mergeKept,
  lineSentences,
  locatePointed,
  looksLikeQa,
  MIN_REPEATS,
  newCards,
  pairFromSpan,
  pairSentences,
  pairToItem,
  type QaPair,
} from '../src/core/qa-pairs';
import { lineKey, locateExcerpt } from '../src/core/coverage';
import { normalize, splitSentences } from '../src/core/text';
import { parsePointedPairs } from '../src/ai/schemas';

/**
 * The Q:A keeper (NOTES §49).
 *
 * The owner: *"i already have the format in my notes for the Question:Answer
 * yet it's still getting reworded"*, and *"nomi must be able to identify it
 * whichever format it may serve."* Three things are held here: every format he
 * writes is read; what is read is his text to the character; and the things that
 * only look like Q:A — a paragraph, a quiz with options, `Note:` — are left alone.
 */

const qa = (text: string, headings: string[] = []) =>
  findQaPairs(text, headings).map((p) => [p.question, p.answer]);

describe('Q: / A: on two lines', () => {
  it('reads each pair, exactly as written', () => {
    const text = [
      'Q: What is osmosis?',
      'A: Water moving across a membrane.',
      '',
      'Q: Whats the powerhouse of teh cell?',
      'A: Mitochondria (the "powerhouse")',
    ].join('\n');
    expect(qa(text)).toEqual([
      ['What is osmosis?', 'Water moving across a membrane.'],
      // Typos stay. It is his card.
      ['Whats the powerhouse of teh cell?', 'Mitochondria (the "powerhouse")'],
    ]);
  });

  it('takes the other labels, numbering and Taglish', () => {
    const text = [
      '1. Question: Ano ang photosynthesis?',
      'Answer: Paggawa ng pagkain gamit ang araw.',
      '2) Q1. Who wrote Noli Me Tangere?',
      'Ans: Jose Rizal',
      'Tanong: Saan matatagpuan ang Mayon?',
      'Sagot - Albay',
    ].join('\n');
    expect(qa(text)).toEqual([
      ['Ano ang photosynthesis?', 'Paggawa ng pagkain gamit ang araw.'],
      ['Who wrote Noli Me Tangere?', 'Jose Rizal'],
      ['Saan matatagpuan ang Mayon?', 'Albay'],
    ]);
  });

  it('counts a single labelled pair — the label says it is a card', () => {
    const text = 'Some notes about cells.\n\nQ: What is a cell?\nA: The smallest unit of life.\n\nMore notes.';
    expect(qa(text)).toEqual([['What is a cell?', 'The smallest unit of life.']]);
  });

  it('keeps an answer that runs over several lines, lines and all', () => {
    const text = [
      'Q: What are the parts of a cell?',
      'A:',
      '- nucleus',
      '- membrane',
      '- cytoplasm',
      '',
      'Q: Why do cells divide?',
      'A: To grow.',
      'And to repair damage.',
    ].join('\n');
    expect(qa(text)).toEqual([
      ['What are the parts of a cell?', '- nucleus\n- membrane\n- cytoplasm'],
      ['Why do cells divide?', 'To grow.\nAnd to repair damage.'],
    ]);
  });

  it('allows one blank line between a question and its answer', () => {
    expect(qa('Q: What is DNA?\n\nA: Genetic material.')).toEqual([['What is DNA?', 'Genetic material.']]);
  });

  it('reads a question answered on its own line', () => {
    expect(qa('Q: What is the capital of Japan? A: Tokyo')).toEqual([['What is the capital of Japan?', 'Tokyo']]);
  });

  it('reads a labelled question whose answer has no label', () => {
    expect(qa('Q: What is H2O?\nWater')).toEqual([['What is H2O?', 'Water']]);
  });

  it('reads an unlabelled question whose answer is labelled', () => {
    expect(qa('What gas do plants take in?\nAnswer: Carbon dioxide')).toEqual([
      ['What gas do plants take in?', 'Carbon dioxide'],
    ]);
  });

  it('takes "A." as an answer when it is not the first of some options', () => {
    expect(qa('Q: Largest planet?\nA. Jupiter\n\nQ: Smallest planet?\nA. Mercury')).toEqual([
      ['Largest planet?', 'Jupiter'],
      ['Smallest planet?', 'Mercury'],
    ]);
  });
});

describe('Question? : Answer on one line', () => {
  it('reads the separators', () => {
    const text = [
      'What is osmosis? : Water moving across a membrane',
      'What is diffusion?- Particles spreading out',
      'What is ATP? = The cell’s energy',
      '4. What is a gene? -> A unit of heredity',
      'What is RNA? — A copy of DNA',
    ].join('\n');
    expect(qa(text)).toEqual([
      ['What is osmosis?', 'Water moving across a membrane'],
      ['What is diffusion?', 'Particles spreading out'],
      ['What is ATP?', 'The cell’s energy'],
      ['What is a gene?', 'A unit of heredity'],
      ['What is RNA?', 'A copy of DNA'],
    ]);
  });

  it(`needs ${MIN_REPEATS} on the page — one is just a sentence`, () => {
    expect(qa('So what happened next? - nobody knew.\nThe story goes on from there.')).toEqual([]);
  });
});

describe('a question, then its answer on the next line', () => {
  it('reads the pairs when that is what the page is', () => {
    const text = [
      'What is osmosis?',
      'Water moving across a membrane.',
      '',
      'What is diffusion?',
      'Particles spreading from high to low concentration.',
      '',
      'Why do cells need ATP?',
      'It is their energy.',
      'Without it nothing moves.',
    ].join('\n');
    expect(qa(text)).toEqual([
      ['What is osmosis?', 'Water moving across a membrane.'],
      ['What is diffusion?', 'Particles spreading from high to low concentration.'],
      ['Why do cells need ATP?', 'It is their energy.\nWithout it nothing moves.'],
    ]);
  });

  it('keeps answers of two lines when nothing separates the pairs', () => {
    const text = 'What is A?\nFirst.\nSecond.\nWhat is B?\nThird.\nFourth.\nWhat is C?\nFifth.\nSixth.';
    expect(qa(text)).toEqual([
      ['What is A?', 'First.\nSecond.'],
      ['What is B?', 'Third.\nFourth.'],
      ['What is C?', 'Fifth.\nSixth.'],
    ]);
  });

  it('leaves prose with a few questions in it alone', () => {
    const text = [
      'The heart has four chambers.',
      'Why does this matter?',
      'Because blood must not mix.',
      'The left side pumps to the body and the right side to the lungs.',
      'What happens when a valve fails?',
      'Blood flows backwards.',
      'Doctors can often repair a valve.',
      'Valves open and close with every beat.',
      'How many times a day?',
      'About a hundred thousand.',
      'The sinoatrial node sets the pace.',
      'It sits in the right atrium.',
      'Signals spread through both atria first.',
      'Then they reach the ventricles.',
    ].join('\n');
    // Three question-and-answer pairs, but most of the page is prose.
    expect(qa(text)).toEqual([]);
  });
});

describe('Term: definition', () => {
  it('reads a glossary, the card asking the term', () => {
    const text = [
      '# Cell words',
      'Osmosis: water moving across a membrane',
      'Diffusion - particles spreading out',
      '• Mitochondria: makes the cell’s energy',
      'Ribosome: builds proteins',
    ].join('\n');
    expect(qa(text)).toEqual([
      ['Osmosis', 'water moving across a membrane'],
      ['Diffusion', 'particles spreading out'],
      ['Mitochondria', 'makes the cell’s energy'],
      ['Ribosome', 'builds proteins'],
    ]);
  });

  it('reads a term whose meaning is on the lines under it', () => {
    const text = 'Osmosis:\nwater moving across\na membrane\n\nDiffusion: spreading out\nCatalyst: speeds a reaction';
    expect(qa(text)).toEqual([
      ['Osmosis', 'water moving across\na membrane'],
      ['Diffusion', 'spreading out'],
      ['Catalyst', 'speeds a reaction'],
    ]);
  });

  it('is not fooled by housekeeping, times or links', () => {
    const text = [
      'Note: exam on Friday',
      'Date: March 3',
      'Room: 204',
      'Meeting at 10:30 in the lab',
      'See https://example.com/notes for more',
      'Remember: bring a calculator',
    ].join('\n');
    expect(qa(text)).toEqual([]);
  });

  it('needs to be most of the page', () => {
    const text = [
      'The cell membrane controls what goes in and out of the cell, and it is made of a double layer of lipids.',
      'Proteins in the membrane act as channels and pumps, and some of them carry signals.',
      'Cholesterol keeps the membrane fluid at body temperature, which matters for its function.',
      'Transport can be passive or active depending on whether energy is used.',
      'Osmosis: water moving across a membrane',
      'Diffusion: particles spreading out',
      'Endocytosis: taking things in by folding the membrane',
      'The nucleus holds the genetic material.',
      'Ribosomes make proteins from instructions.',
    ].join('\n');
    expect(qa(text)).toEqual([]);
  });

  it('is not fooled by a script, where the "term" repeats', () => {
    const text = 'JOHN: Hello there\nMARY: Good morning\nJOHN: How are you\nMARY: Fine, thanks\nJOHN: Good';
    expect(qa(text)).toEqual([]);
  });
});

describe('tables, as the reader returns a PDF or a photo', () => {
  it('reads a table headed as questions and answers', () => {
    const text = '| Question | Answer |\n|---|---|\n| What is osmosis? | Water moving |\n| What is ATP? | Energy |';
    expect(qa(text)).toEqual([
      ['What is osmosis?', 'Water moving'],
      ['What is ATP?', 'Energy'],
    ]);
  });

  it('reads a term table', () => {
    expect(qa('| Term | Definition |\n| --- | --- |\n| Osmosis | Water moving |')).toEqual([['Osmosis', 'Water moving']]);
  });

  it('reads questions down the first column with no header', () => {
    const text = '| What is A? | One |\n| What is B? | Two |\n| What is C? | Three |';
    expect(qa(text)).toEqual([
      ['What is A?', 'One'],
      ['What is B?', 'Two'],
      ['What is C?', 'Three'],
    ]);
  });

  it('leaves any other table alone', () => {
    expect(qa('| Name | Score |\n|---|---|\n| Ana | 9 |\n| Ben | 7 |')).toEqual([]);
    expect(qa('| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |')).toEqual([]);
  });
});

describe('labels it has never seen, alternating', () => {
  it('reads them when the first label asks the questions', () => {
    const text = 'Frage: Was ist Osmose?\nAntwort: Wasserbewegung\nFrage: Was ist ATP?\nAntwort: Energie\nFrage: Was ist DNA?\nAntwort: Erbgut';
    expect(qa(text)).toEqual([
      ['Was ist Osmose?', 'Wasserbewegung'],
      ['Was ist ATP?', 'Energie'],
      ['Was ist DNA?', 'Erbgut'],
    ]);
  });

  it('finds them below a stray label', () => {
    const text = 'Note: for Friday\nP: Que es la osmosis?\nR: Movimiento del agua\nP: Que es el ATP?\nR: Energia\nP: Que es el ADN?\nR: Material genetico';
    expect(qa(text)).toHaveLength(3);
  });
});

describe('fast enough to count as he types', () => {
  it('reads twenty thousand lines of any shape in well under a second', () => {
    // Add notes counts his questions on every change. A page read once per
    // pair, or a run re-read from every line, would freeze the box on a long
    // paste; each of these shapes is one of those worst cases.
    const script = Array.from({ length: 20_000 }, (_, i) => (i % 2 ? 'MARY: Fine, thanks' : 'JOHN: Hello there'));
    const pairs = Array.from({ length: 10_000 }, (_, i) => `Q: Question ${i}?\nA: Answer ${i}`);
    const labels = Array.from({ length: 20_000 }, (_, i) => `Label ${i % 7}: value ${i}`);
    for (const text of [script.join('\n'), pairs.join('\n'), labels.join('\n')]) {
      const t0 = performance.now();
      findQaPairs(`# Heading\n${text}`);
      expect(performance.now() - t0).toBeLessThan(1500);
    }
    expect(findQaPairs(pairs.join('\n'))).toHaveLength(10_000);
  });
});

describe('a quiz with options is never a pair', () => {
  it('leaves lettered multiple choice to the card-writer', () => {
    const text = [
      '1. What is the capital of France?',
      'A. Paris',
      'B. Rome',
      'C. Madrid',
      'Answer: A',
      '',
      'Q: Which is a mammal?',
      'A) Shark',
      'B) Whale',
      'Answer: B',
    ].join('\n');
    expect(qa(text)).toEqual([]);
  });

  it('leaves options on one line alone', () => {
    expect(qa('Q: Which is a planet? A) Moon B) Mars C) Sun')).toEqual([]);
  });
});

describe('what a card needs', () => {
  it('names the heading above each pair', () => {
    const pairs = findQaPairs('# Cells\nQ: What is a cell?\nA: A unit of life.\n# Genes\nQ: What is a gene?\nA: A unit of heredity.');
    expect(pairs.map((p) => p.heading)).toEqual(['Cells', 'Genes']);
  });

  it("treats the reader's headings as headings, not as questions", () => {
    const pairs = findQaPairs('Chapter Review\nQ: What is a cell?\nA: A unit of life.', ['Chapter Review']);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.heading).toBe('Chapter Review');
  });

  it('files each question under the level it asks for', () => {
    expect(levelFor('What is osmosis?')).toBe('remember');
    expect(levelFor('How many chambers does the heart have?')).toBe('remember');
    expect(levelFor('Why do cells divide?')).toBe('understand');
    expect(levelFor('How does osmosis work?')).toBe('understand');
    expect(levelFor('Compare mitosis and meiosis.')).toBe('understand');
    expect(levelFor('Bakit mahalaga ang tubig?')).toBe('understand');
    expect(levelFor('What would happen if the valve failed?')).toBe('apply');
    expect(levelFor('Calculate the speed of the car.')).toBe('apply');
  });

  it('cites his own lines, so the card shows where it came from', () => {
    const text = '# Cells\nIntro line. Another sentence.\nQ: What is osmosis?\nA: Water moving. Across a membrane.';
    const [pair] = findQaPairs(text);
    const item = pairToItem(text, 3, pair!)!;
    expect(item).toMatchObject({
      kind: 'flashcard',
      prompt: 'What is osmosis?',
      answer: 'Water moving. Across a membrane.',
      page_index: 3,
      topic: 'Cells',
      excerpt_verified: true,
    });
    const sentences = splitSentences(text);
    expect(sentences[item.source_sentence]).toBe('Q: What is osmosis?');
    expect(item.source_excerpt).toBe('Q: What is osmosis? A: Water moving. Across a membrane.');
    // The rest of the app finds the quote where the card says it is.
    expect(locateExcerpt(text, item.source_excerpt)).toBe(item.source_sentence);
  });

  it('knows every sentence a pair covers, so the card-writer leaves them alone', () => {
    const text = 'First line.\nQ: What is it? Really?\nA: This. And that.\n\nLast.';
    const [pair] = findQaPairs(text);
    expect(pairSentences(lineSentences(text), pair!)).toEqual({ from: 1, to: 5 });
  });

  it('drops a card already in the set, but keeps one answer given to two questions', () => {
    const cards = [
      { prompt: 'Is the sun a star?', answer: 'True' },
      { prompt: 'Is water wet?', answer: 'True' },
      { prompt: 'Is the sun a star?', answer: 'True' },
      { prompt: 'What is ATP?', answer: 'Energy' },
    ];
    expect(newCards(cards, [{ prompt: 'what is  ATP?', answer: 'energy' }])).toEqual([
      { prompt: 'Is the sun a star?', answer: 'True' },
      { prompt: 'Is water wet?', answer: 'True' },
    ]);
  });

  it('makes all of his pairs, and Nomi writes the rest of the count', () => {
    expect(keptTarget(40, 25)).toEqual({ target: 40, extra: 15 });
    expect(keptTarget(10, 25)).toEqual({ target: 25, extra: 0 });
    expect(keptTarget(20, 0)).toEqual({ target: 20, extra: 20 });
  });
});

describe('asking Gemini to point, only when it looks like Q:A the keeper cannot read', () => {
  it('asks when many lines ask something and little was found', () => {
    const odd = 'What is osmosis? >> water moving\nWhat is ATP? >> energy\nWhat is DNA? >> genes\nWhat is RNA? >> a copy';
    const found = findQaPairs(odd);
    expect(found).toEqual([]);
    expect(looksLikeQa(odd, found)).toBe(true);
  });

  it('does not ask for prose, or for notes it already read', () => {
    const prose = 'Cells divide. Why? To grow.\nThey also repair.\nTissues form.\nOrgans form.\nSystems form.';
    expect(looksLikeQa(prose, findQaPairs(prose))).toBe(false);
    const read = 'Q: A?\nA: a\nQ: B?\nA: b\nQ: C?\nA: c';
    expect(looksLikeQa(read, findQaPairs(read))).toBe(false);
  });
});

describe('what Gemini points at is kept only if it is really in the notes', () => {
  const text = 'Review\nWhat is osmosis? >> Water moving across a membrane\nWhat is ATP?   >>   The energy of the cell\nwhat is DNA, and why does it matter? >> genes';

  it('keeps a pair found word for word, in the notes’ own characters', () => {
    const kept = locatePointed(text, [
      // Gemini "tidied" the spacing and the case: the card still says what he wrote.
      { question: 'what is ATP?', answer: 'the energy of the cell' },
    ]);
    expect(kept.map((k) => [k.pair.question, k.pair.answer])).toEqual([['What is ATP?', 'The energy of the cell']]);
    expect(kept[0]!.pair.shape).toBe('pointed');
  });

  it('drops a reworded half', () => {
    expect(locatePointed(text, [{ question: 'What is osmosis?', answer: 'Movement of water through a membrane' }])).toEqual([]);
    expect(locatePointed(text, [{ question: 'Define osmosis.', answer: 'Water moving across a membrane' }])).toEqual([]);
  });

  it('drops half a question', () => {
    expect(locatePointed(text, [{ question: 'what is DNA', answer: 'genes' }])).toEqual([]);
  });

  it('runs a pointed answer to the end of its line', () => {
    const [kept] = locatePointed(text, [{ question: 'What is osmosis?', answer: 'Water moving' }]);
    expect(kept!.pair.answer).toBe('Water moving across a membrane');
  });

  it('takes off a label Gemini carried along', () => {
    const labelled = 'Q) What is a cell?\nAns) A unit of life\nQ) What is a gene?\nAns) A unit of heredity';
    const kept = locatePointed(labelled, [{ question: 'Q) What is a cell?', answer: 'Ans) A unit of life' }]);
    expect(kept.map((k) => [k.pair.question, k.pair.answer])).toEqual([['What is a cell?', 'A unit of life']]);
  });

  it('drops an answer found far from its question, and anything overlapping a pair already found', () => {
    const far = 'What is osmosis?\nOne.\nTwo.\nThree.\nFour.\nWater moving';
    expect(locatePointed(far, [{ question: 'What is osmosis?', answer: 'Water moving' }])).toEqual([]);

    const taken: QaPair[] = [{ question: 'x', answer: 'y', shape: 'labelled', fromLine: 1, toLine: 1, heading: null }];
    expect(locatePointed(text, [{ question: 'What is osmosis?', answer: 'Water moving across a membrane' }], taken)).toEqual([]);
  });

  it('rebuilds a pointed pair from where it is, the same every time', () => {
    const [kept] = locatePointed(text, [{ question: 'What is ATP?', answer: 'The energy of the cell' }]);
    expect(pairFromSpan(text, kept!.span)).toEqual(kept!.pair);
    expect(pairFromSpan(text, { q: [5, 2], a: [9, 12] })).toBeNull();
  });

  it('reads the reply one entry at a time, dropping what does not parse', () => {
    expect(
      parsePointedPairs({
        pairs: [
          { page_index: 0, question: 'What is ATP?', answer: 'Energy' },
          { page_index: 'one', question: 'x', answer: 'y' },
          { page_index: 1, question: '  ', answer: 'y' },
        ],
      }),
    ).toEqual([{ page_index: 0, question: 'What is ATP?', answer: 'Energy' }]);
    expect(parsePointedPairs(null)).toEqual([]);
  });
});

describe('what a plan keeps, across a set’s pages', () => {
  const qaText = 'Q: What is osmosis?\nA: Water moving.\n\nA paragraph of notes about cells.';
  const odd = 'What is ATP? >> The energy of the cell';
  const pages = [
    { document_id: 'd1', page_index: 0, set_page: 0, text: qaText, headings: [], readability: 1 },
    { document_id: 'd1', page_index: 1, set_page: 1, text: odd, headings: [], readability: 1 },
    { document_id: 'd2', page_index: 0, set_page: 2, text: 'Q: Not kept?\nA: Other document.', headings: [], readability: 1 },
    { document_id: 'd1', page_index: 2, set_page: 3, text: 'Q: Blurry?\nA: Unreadable page.', headings: [], readability: 0.2 },
  ];
  const [pointed] = locatePointed(odd, [{ question: 'What is ATP?', answer: 'The energy of the cell' }]);
  const keep = { documentIds: ['d1'], pointed: [{ documentId: 'd1', pageIndex: 1, span: pointed!.span }], pairs: 2 };

  it('finds the keeper’s pairs and the pointed ones, and only in kept documents', () => {
    expect(keptPairsOf(pages[0]!, keep).map((p) => p.question)).toEqual(['What is osmosis?']);
    expect(keptPairsOf(pages[1]!, keep).map((p) => p.question)).toEqual(['What is ATP?']);
    expect(keptPairsOf(pages[2]!, keep)).toEqual([]);
  });

  it('marks every line of every kept pair — question and answer — and skips an unreadable page', () => {
    const where = keptOnPages(pages, keep, 0.6);
    expect([...where.byPage.keys()]).toEqual([0, 1]);
    // Page 1's one line is two sentences — "What is ATP?" and ">> The energy…" — and both are its card's.
    const expected = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([page, sentence]) => lineKey({ page: page!, sentence: sentence! }));
    expect([...where.lines].sort()).toEqual(expected.sort());
    expect(where.texts.has(normalize('A: Water moving.'))).toBe(true);
    expect(where.texts.has(normalize('A paragraph of notes about cells.'))).toBe(false);
  });

  it('adds what notes added to a set keep to what the set kept before', () => {
    const later = { documentIds: ['d3'], pointed: [], pairs: 4 };
    expect(mergeKept(keep, later)).toEqual({ documentIds: ['d1', 'd3'], pointed: keep.pointed, pairs: 6 });
    expect(mergeKept(undefined, later)).toBe(later);
    expect(mergeKept(keep, { documentIds: ['d4'], pointed: [], pairs: 0 })).toBe(keep);
    expect(mergeKept(undefined, null)).toBeUndefined();
  });
});

describe('what Add notes says', () => {
  it('counts his questions as he pastes, and asks ahead for a file', () => {
    expect(keepHeading(25)).toBe('Found 25 questions in your notes');
    expect(keepHeading(1)).toBe('Found 1 question in your notes');
    expect(keepHeading(0)).toBe('If your notes are already questions and answers');
    expect(keepDetail(true)).toBe("They'll be kept exactly as you wrote them.");
    expect(keepDetail(false)).toBe('Nomi will write its own questions from your notes.');
  });

  it('offers exactly his questions, and picks that until he taps another count', () => {
    expect(countChoices([10, 20, 40, 60], 3, null)).toEqual({ counts: [3, 10, 20, 40, 60], count: 3 });
    expect(countChoices([10, 20, 40, 60], 25, null)).toEqual({ counts: [10, 20, 25, 40, 60], count: 25 });
    expect(countChoices([10, 20, 40, 60], 20, null)).toEqual({ counts: [10, 20, 40, 60], count: 20 });
    expect(countChoices([10, 20, 40, 60], 3, 40)).toEqual({ counts: [3, 10, 20, 40, 60], count: 40 });
    expect(countChoices([10, 20, 40, 60], 0, null)).toEqual({ counts: [10, 20, 40, 60], count: 20 });
  });

  it('says how many cards, and whose', () => {
    expect(countLine(40, 25, true)).toBe("You'll get your 25 questions, and Nomi adds 15 more.");
    expect(countLine(10, 25, true)).toBe("You'll get all 25 of your questions.");
    expect(countLine(25, 25, true)).toBe("You'll get your 25 questions, nothing added.");
    expect(countLine(1, 1, true)).toBe("You'll get your 1 question, nothing added.");
    expect(countLine(10, 1, true)).toBe("You'll get your 1 question, and Nomi adds 9 more.");
    expect(countLine(40, 25, false)).toBe("We'll make this many, from all through your notes.");
    expect(countLine(20, 0, true)).toBe("We'll make this many, from all through your notes.");
  });
});
