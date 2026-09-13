import { describe, expect, it } from 'vitest';
import {
  cleanCandidate,
  detectLeak,
  sameAnswer,
  resolveSource,
  SOURCE_SUPPORT_THRESHOLD,
  sourceSupportScore,
  summariseDrops,
  validateItems,
  validateMultipleChoice,
  type CandidateItem,
} from '../src/core/validate';
import { stripEnumeration } from '../src/core/text';
import type { TierBudget } from '../src/core/planner';

const PAGE_TEXT =
  'The sinoatrial node is the natural pacemaker of the heart. It fires 60-100 times per minute. ' +
  'The atrioventricular node delays conduction so the ventricles can fill with blood.';

const pageTexts = new Map<number, string>([[0, PAGE_TEXT]]);
const budget: TierBudget = { remember: 5, understand: 3, apply: 2 };

function item(over: Partial<CandidateItem> = {}): CandidateItem {
  return {
    kind: 'flashcard',
    level: 'remember',
    prompt: 'Which structure is the natural pacemaker?',
    answer: 'The sinoatrial node',
    page_index: 0,
    source_sentence: 0,
    topic: 'conduction',
    ...over,
  };
}

describe('validateMultipleChoice', () => {
  const base = item({
    kind: 'mcq',
    prompt: 'Which structure sets the heart rate?',
    answer: 'SA node',
    options: [
      { text: 'SA node', correct: true },
      { text: 'AV node', correct: false },
      { text: 'Bundle of His', correct: false },
    ],
  });

  it('accepts a well-formed question', () => {
    expect(validateMultipleChoice(base)).toBeNull();
  });

  it('rejects too few or too many options', () => {
    expect(validateMultipleChoice({ ...base, options: base.options!.slice(0, 2) })).toMatch(/3-4/);
    expect(
      validateMultipleChoice({
        ...base,
        options: [...base.options!, { text: 'X', correct: false }, { text: 'Y', correct: false }],
      }),
    ).toMatch(/3-4/);
  });

  it('rejects zero or multiple correct answers', () => {
    expect(
      validateMultipleChoice({
        ...base,
        options: base.options!.map((o) => ({ ...o, correct: false })),
      }),
    ).toMatch(/exactly 1 correct/);
    expect(
      validateMultipleChoice({
        ...base,
        options: base.options!.map((o) => ({ ...o, correct: true })),
      }),
    ).toMatch(/exactly 1 correct/);
  });

  it('rejects options that are duplicates after normalisation', () => {
    expect(
      validateMultipleChoice({
        ...base,
        options: [
          { text: 'SA node', correct: true },
          { text: '  sa   NODE ', correct: false },
          { text: 'AV node', correct: false },
        ],
      }),
    ).toMatch(/unique/);
  });

  it('rejects a question that contains its own answer verbatim', () => {
    expect(
      validateMultipleChoice({
        ...base,
        prompt: 'Is the SA node the pacemaker?',
      }),
    ).toMatch(/verbatim/);
  });
});

describe('stripEnumeration / cleanCandidate', () => {
  it('strips the option letter a quiz-shaped source drags in', () => {
    // The exact bug seen on a lettered MCQ PDF: the card's answer read
    // "A. To unify different forms of words" instead of the answer itself.
    expect(stripEnumeration('A. To unify different forms of words')).toBe(
      'To unify different forms of words',
    );
    expect(stripEnumeration('b) It does not preserve word order')).toBe(
      'It does not preserve word order',
    );
    expect(stripEnumeration('12. Stratified sampling')).toBe('Stratified sampling');
    expect(stripEnumeration('- Ribosomes build proteins')).toBe('Ribosomes build proteins');
  });

  it('does NOT eat a leading article — the trap in this rule', () => {
    // "A Pangolin" must survive; only "A." with a separator is a marker.
    expect(stripEnumeration('A Pangolin!')).toBe('A Pangolin!');
    expect(stripEnumeration('A cell wall made of cellulose')).toBe(
      'A cell wall made of cellulose',
    );
    expect(stripEnumeration('An enzyme that breaks down starch')).toBe(
      'An enzyme that breaks down starch',
    );
    expect(stripEnumeration('I think therefore I am')).toBe('I think therefore I am');
  });

  it('cleans prompt, answer and options but never the source excerpt', () => {
    const cleaned = cleanCandidate(
      item({
        kind: 'mcq',
        prompt: '1. Which structure is the pacemaker?',
        answer: 'A. The sinoatrial node',
        options: [
          { text: 'A. The sinoatrial node', correct: true },
          { text: 'B. The AV node', correct: false },
          { text: 'C. The bundle of His', correct: false },
        ],
      }),
    );

    expect(cleaned.prompt).toBe('Which structure is the pacemaker?');
    expect(cleaned.answer).toBe('The sinoatrial node');
    expect(cleaned.options!.map((o) => o.text)).toEqual([
      'The sinoatrial node',
      'The AV node',
      'The bundle of His',
    ]);
  });

  it('stored items come out clean end to end', () => {
    const { kept } = validateItems(
      [item({ answer: 'A. The sinoatrial node' })],
      pageTexts,
      budget,
    );
    expect(kept[0]!.answer).toBe('The sinoatrial node');
  });
});

describe('source grounding by sentence index', () => {
  // PAGE_TEXT sentences:
  //   [0] The sinoatrial node is the natural pacemaker of the heart.
  //   [1] It fires 60-100 times per minute.
  //   [2] The atrioventricular node delays conduction so the ventricles can fill with blood.

  it('resolves a valid index to the real sentence from stored notes', () => {
    const r = resolveSource(PAGE_TEXT, 2, 'The AV node delays conduction so ventricles fill');
    expect(r).not.toBeNull();
    expect(r!.text).toBe(
      'The atrioventricular node delays conduction so the ventricles can fill with blood.',
    );
  });

  it('rejects an out-of-range index — a fabricated citation', () => {
    expect(resolveSource(PAGE_TEXT, 99, 'anything')).toBeNull();
    expect(resolveSource(PAGE_TEXT, 3, 'anything')).toBeNull(); // exactly one past the end
  });

  it('tolerates an off-by-one citation when a neighbour supports the answer', () => {
    // CHANGED DELIBERATELY. This test previously asserted the opposite — that
    // citing sentence 1 for an AV-node answer must FAIL — and that strictness
    // turned out to cost real cards.
    //
    // splitSentences treats a line break as a sentence boundary, so notes shaped
    // as a label above its meaning ("LEAF" / "primary photosynthetic organ")
    // split in two. A card answering "the leaf" and citing the function line
    // shares no words with it, scores exactly 0, and was dropped. Measured on a
    // labelled diagram: 2 of 6 organs lost. Glossaries and vocabulary lists have
    // the same shape.
    //
    // The trade-off accepted: a citation one sentence off now passes when the
    // neighbourhood supports the answer. The grounding guarantee is intact — the
    // text is still resolved from the user's own notes and cannot be fabricated,
    // and the excerpt SHOWN is the widened text, so what the user reads does
    // support the answer. The window is bounded at one sentence, and the test
    // below pins that bound.
    const right = resolveSource(PAGE_TEXT, 2, 'The atrioventricular node delays conduction');
    const offByOne = resolveSource(PAGE_TEXT, 1, 'The atrioventricular node delays conduction');
    expect(right!.score).toBeGreaterThan(SOURCE_SUPPORT_THRESHOLD);
    expect(offByOne!.score).toBeGreaterThanOrEqual(SOURCE_SUPPORT_THRESHOLD);
    // What the user is shown includes the sentence that actually supports it.
    expect(offByOne!.text).toContain('atrioventricular node delays conduction');
  });

  it('still rejects a citation two sentences away from any support', () => {
    // Sentence 0's window reaches sentence 1 only, never sentence 2. This is the
    // bound that stops widening from becoming "anything on the page counts".
    //
    // The answer is deliberately chosen to share NO words with sentences 0-1.
    // A first attempt used "the atrioventricular node delays conduction" and
    // scored 0.25 — one hit out of four, because both it and sentence 0 contain
    // the generic word "node". That citation passed before this change too, so
    // it was never testing the bound. Worth knowing on its own: at a 0.22
    // threshold a single shared common word can carry a short answer.
    const tooFar = resolveSource(PAGE_TEXT, 0, 'The ventricles fill with blood.');
    expect(tooFar!.score).toBeLessThan(SOURCE_SUPPORT_THRESHOLD);
  });

  it('accepts an answer genuinely supported by its cited sentence', () => {
    const { kept, dropped } = validateItems(
      [item({ answer: 'The sinoatrial node', source_sentence: 0 })],
      pageTexts,
      budget,
    );
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
  });

  it('REJECTS a real sentence that does not support the answer', () => {
    // The failure an index alone cannot catch: the citation resolves to genuine
    // text, but has nothing to do with the answer. Without the support check
    // the source chip would become decorative.
    const { kept, dropped } = validateItems(
      [
        item({
          prompt: 'What produces lactic acid during exercise?',
          answer: 'Fermentation in muscle tissue produces lactic acid',
          source_sentence: 1, // "It fires 60-100 times per minute."
        }),
      ],
      pageTexts,
      budget,
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toBe('excerpt_unmatched');
    expect(dropped[0]!.detail).toMatch(/does not support/);
  });

  it('rejects a negative or non-integer index', () => {
    const bad = validateItems([item({ source_sentence: -1 })], pageTexts, budget);
    expect(bad.kept).toHaveLength(0);
    expect(bad.dropped[0]!.reason).toBe('schema');
  });

  it('never stores model-authored source text', () => {
    // Whatever the model claims, the stored excerpt is looked up from the page.
    const { kept } = validateItems([item({ source_sentence: 1 , answer: 'It fires 60-100 times per minute' })], pageTexts, budget);
    expect(kept[0]!.source_excerpt).toBe('It fires 60-100 times per minute.');
  });
});

describe('sourceSupportScore', () => {
  it('scores full coverage when every meaningful word appears', () => {
    expect(sourceSupportScore('sinoatrial node pacemaker', PAGE_TEXT)).toBe(1);
  });

  it('ignores stopwords, so short answers are not unfairly penalised', () => {
    // "The", "is" and "a" carry no evidence; only "gorilla" should matter, so a
    // one-word answer still scores full marks against its source sentence.
    expect(sourceSupportScore('The gorilla', 'A gorilla is the largest primate.')).toBe(1);
  });

  it('scores near zero for an unrelated sentence', () => {
    expect(
      sourceSupportScore('Photosynthesis occurs in the chloroplast', PAGE_TEXT),
    ).toBeLessThan(0.2);
  });

  it('returns 1 when the answer has no substantive words to check', () => {
    expect(sourceSupportScore('the and of', PAGE_TEXT)).toBe(1);
  });
});

describe('rubric is only kept where it is used', () => {
  const rubric = {
    expected_concepts: [{ id: 'c1', text: 'pacemaker' }],
    model_answer: 'The sinoatrial node sets the rhythm.',
  };

  it('keeps a rubric on a short_answer item', () => {
    const { kept } = validateItems(
      [item({ kind: 'short_answer', level: 'understand', rubric })],
      pageTexts,
      budget,
    );
    expect(kept[0]!.rubric).toEqual(rubric);
  });

  it('discards a rubric volunteered on a flashcard', () => {
    // Nothing reads it for flashcards, and asking for it was a large share of
    // the model's output.
    const { kept } = validateItems([item({ kind: 'flashcard', rubric })], pageTexts, budget);
    expect(kept[0]!.rubric).toBeUndefined();
  });
});

// "We left out 12 cards: …" (describeDrops) was removed at the owner's request
// (NOTES §37) — the pipeline now makes the count asked for, so there is no
// shortfall to explain on screen. The reasons are still counted, for the log.
describe('summariseDrops', () => {
  it('counts by reason', () => {
    expect(
      summariseDrops([
        { reason: 'duplicate', detail: '', prompt: '', excerpt: '', page_index: 0 },
        { reason: 'duplicate', detail: '', prompt: '', excerpt: '', page_index: 0 },
        { reason: 'leak', detail: '', prompt: '', excerpt: '', page_index: 0 },
      ]),
    ).toEqual({ duplicate: 2, leak: 1 });
  });
});

describe('sameAnswer — one fact asked twice (NOTES §37)', () => {
  it('catches the pairs the 60-card reproduction kept', () => {
    expect(
      sameAnswer('Two free peaches and a warning about the rain', 'Two peaches and a warning about the rain.'),
    ).toBe(true);
    expect(sameAnswer('Plates saved for Easter', 'The plates she had saved for Easter.')).toBe(true);
    expect(sameAnswer('It was twenty minutes fast.', 'It was twenty minutes fast.')).toBe(true);
  });

  it('catches one phrase given as the answer again and again', () => {
    // The owner's report: three quiz questions, every correct answer the same.
    expect(sameAnswer('Tee-ball team', 'the tee-ball team')).toBe(true);
  });

  it('keeps different answers apart, even when they share a word', () => {
    expect(sameAnswer('The sinoatrial node', 'The atrioventricular node')).toBe(false);
    expect(sameAnswer('Water and minerals', 'Water and sugars')).toBe(false);
    expect(sameAnswer('Cider', 'Late October')).toBe(false);
  });

  it('judges long answers on a stricter overlap', () => {
    expect(
      sameAnswer(
        'The xylem carries water and dissolved minerals upward from the roots to the leaves',
        'The phloem carries sugars made in the leaves downward to the roots and fruits',
      ),
    ).toBe(false);
  });
});

describe('validateItems — no repeated answer, and every part of the notes (NOTES §37)', () => {
  it('drops a card whose answer repeats one already stored', () => {
    const { kept, dropped } = validateItems(
      [item({ prompt: 'What sets the pace of the heartbeat?' })],
      pageTexts,
      budget,
      [{ prompt: 'Which structure is the natural pacemaker?', answer: 'The sinoatrial node' }],
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toBe('duplicate');
    expect(dropped[0]!.detail).toMatch(/answer repeats/);
  });

  it('drops the second of two cards in one batch with the same answer', () => {
    const { kept, dropped } = validateItems(
      [item(), item({ prompt: 'What is the heart pacemaker called in these notes?' })],
      pageTexts,
      budget,
    );
    expect(kept).toHaveLength(1);
    expect(dropped.map((d) => d.reason)).toEqual(['duplicate']);
  });

  it('holds each part of the notes to its share', () => {
    const bands = [
      { from: { page: 0, sentence: 0 }, to: { page: 0, sentence: 0 }, quota: 1 },
      { from: { page: 0, sentence: 1 }, to: { page: 0, sentence: 2 }, quota: 1 },
    ];
    const { kept, dropped } = validateItems(
      [
        item(),
        item({ prompt: 'What is the resting rhythm set by?', answer: 'The natural pacemaker of the heart' }),
        item({ prompt: 'How often does the SA node fire?', answer: '60-100 times a minute', source_sentence: 1 }),
      ],
      pageTexts,
      budget,
      [],
      { bands },
    );
    expect(kept.map((k) => k.source_sentence)).toEqual([0, 1]);
    expect(dropped.map((d) => d.reason)).toEqual(['over_budget']);
    expect(dropped[0]!.detail).toMatch(/already has its 1/);
  });

  it('drops a card from outside the parts asked for', () => {
    const bands = [{ from: { page: 0, sentence: 1 }, to: { page: 0, sentence: 2 }, quota: 5 }];
    const { kept, dropped } = validateItems([item()], pageTexts, budget, [], { bands });
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.detail).toMatch(/outside the part/);
  });

  it('keeps no more than the number asked for', () => {
    const { kept, dropped } = validateItems(
      [item(), item({ prompt: 'How often does the SA node fire?', answer: '60-100 times a minute', source_sentence: 1 })],
      pageTexts,
      budget,
      [],
      { maxTotal: 1 },
    );
    expect(kept).toHaveLength(1);
    expect(dropped[0]!.detail).toMatch(/already have the 1/);
  });
});

describe('validateItems — two faults the first 60-card run found (NOTES §37)', () => {
  it('drops a card that points at a line number the student never sees', () => {
    for (const prompt of [
      'What characteristic defined the promises referenced in line 93?',
      'What does sentence two state the process needs?',
      'According to page 3, which structure fires first?',
    ]) {
      const { kept, dropped } = validateItems([item({ prompt })], pageTexts, budget);
      expect(kept, prompt).toHaveLength(0);
      expect(dropped[0]!.reason, prompt).toBe('self_reference');
    }
  });

  it('keeps a card that merely contains a number', () => {
    const { kept } = validateItems(
      [item({ prompt: 'How often does the SA node fire each minute?', answer: '60-100 times a minute', source_sentence: 1 })],
      pageTexts,
      budget,
    );
    expect(kept).toHaveLength(1);
  });

  it('drops a second card about the same line whose answer is only reworded', () => {
    const existing = [
      { prompt: 'How often does the SA node fire?', answer: '60-100 times per minute', excerpt: 'It fires 60-100 times per minute.' },
    ];
    const { kept, dropped } = validateItems(
      [
        item({
          prompt: 'What is the resting rate of the natural pacemaker?',
          answer: 'It fires about 60-100 times each minute',
          source_sentence: 1,
        }),
      ],
      pageTexts,
      budget,
      existing,
    );
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.detail).toMatch(/same line/);
  });

  it('holds a fill request to the lines it named', () => {
    const lines = new Set(['0:1', '0:2']);
    const { kept, dropped } = validateItems(
      [item(), item({ prompt: 'How often does the SA node fire?', answer: '60-100 times a minute', source_sentence: 1 })],
      pageTexts,
      budget,
      [],
      { lines },
    );
    expect(kept.map((k) => k.source_sentence)).toEqual([1]);
    expect(dropped[0]!.detail).toMatch(/already has a card/);
  });

  it('keeps two different facts from one line', () => {
    const existing = [
      {
        prompt: 'Which structure is the natural pacemaker?',
        answer: 'The sinoatrial node',
        excerpt: 'The sinoatrial node is the natural pacemaker of the heart.',
      },
    ];
    const { kept } = validateItems(
      [item({ prompt: 'What role does the sinoatrial node play?', answer: 'The natural pacemaker of the heart' })],
      pageTexts,
      budget,
      existing,
    );
    expect(kept).toHaveLength(1);
  });
});

describe('detectLeak', () => {
  it('flags an answer sitting in its own prompt', () => {
    expect(detectLeak('The sinoatrial node is which structure?', 'sinoatrial node')).toBe(true);
  });

  it('ignores very short answers, which legitimately recur', () => {
    expect(detectLeak('Does the SA node fire faster than the AV node?', 'Yes')).toBe(false);
  });

  it('passes a normal question', () => {
    expect(detectLeak('Which structure is the pacemaker?', 'The sinoatrial node')).toBe(false);
  });
});

describe('validateItems', () => {
  it('keeps a good item and marks it verified', () => {
    const { kept, dropped } = validateItems([item()], pageTexts, budget);
    expect(dropped).toEqual([]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.excerpt_verified).toBe(true);
    // Filled in by the APP from stored page text, not by the model.
    expect(kept[0]!.source_excerpt).toBe(
      'The sinoatrial node is the natural pacemaker of the heart.',
    );
  });

  it('drops an item whose excerpt is not in the notes, keeping the rest', () => {
    // The batch must survive one bad item — that is the point of D7.
    const good = item();
    const invented = item({
      prompt: 'What carries the impulse to the ventricles?',
      answer: 'The bundle of His branches through the ventricular septum',
      source_sentence: 99, // no such sentence — a fabricated citation
    });

    const { kept, dropped } = validateItems([good, invented], pageTexts, budget);
    expect(kept).toHaveLength(1);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toBe('excerpt_unmatched');
  });

  it('records a typed drop reason for every rejection', () => {
    const candidates = [
      item({ prompt: '  ', answer: '' }), // schema
      item({ source_sentence: 42 }), // excerpt_unmatched (index does not exist)
      item({
        kind: 'mcq',
        options: [
          { text: 'A', correct: true },
          { text: 'A', correct: false },
          { text: 'B', correct: false },
        ],
      }), // mc_invalid
      item({
        prompt: 'The sinoatrial node is the what of the heart?',
        answer: 'the sinoatrial node',
      }), // leak
    ];

    const { kept, dropped } = validateItems(candidates, pageTexts, budget);
    expect(kept).toHaveLength(0);
    expect(dropped.map((d) => d.reason)).toEqual([
      'schema',
      'excerpt_unmatched',
      'mc_invalid',
      'leak',
    ]);
    for (const d of dropped) expect(d.detail.length).toBeGreaterThan(0);
  });

  it('drops near-duplicate prompts, keeping the first', () => {
    const first = item({ prompt: 'Which structure is the natural pacemaker of the heart?' });
    const second = item({ prompt: 'Which structure is the heart natural pacemaker?' });

    const { kept, dropped } = validateItems([first, second], pageTexts, budget);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.prompt).toBe(first.prompt);
    expect(dropped[0]!.reason).toBe('duplicate');
  });

  it('dedups against items already stored, so a resumed run does not repeat cards', () => {
    const { kept, dropped } = validateItems([item()], pageTexts, budget, [
      'Which structure is the natural pacemaker?',
    ]);
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.reason).toBe('duplicate');
  });

  it('enforces the per-tier budget', () => {
    const tight: TierBudget = { remember: 1, understand: 0, apply: 0 };
    // Different answers on purpose: three cards with one answer are now the
    // same card, and would be dropped as duplicates before the budget is asked.
    const candidates = [
      item({ prompt: 'Question one about the pacemaker?' }),
      item({
        prompt: 'Roughly how many times a minute does it fire?',
        answer: '60-100 times a minute',
        source_sentence: 1,
      }),
      item({
        level: 'understand',
        prompt: 'Why does conduction slow at the AV node?',
        answer: 'So the ventricles can fill with blood',
        source_sentence: 2,
      }),
    ];

    const { kept, dropped } = validateItems(candidates, pageTexts, tight);
    expect(kept).toHaveLength(1);
    expect(dropped.map((d) => d.reason)).toEqual(['over_budget', 'over_budget']);
  });

  it('drops an item referencing a page we never stored', () => {
    const { kept, dropped } = validateItems([item({ page_index: 99 })], pageTexts, budget);
    expect(kept).toHaveLength(0);
    expect(dropped[0]!.detail).toMatch(/page 99/);
  });

  it('every kept item has excerpt_verified true — the Phase 2 criterion', () => {
    const candidates = [
      item(),
      item({ prompt: 'How often does the SA node fire?', answer: '60-100 times a minute' }),
      item({ source_sentence: 77 }),
    ];
    const { kept } = validateItems(candidates, pageTexts, budget);
    expect(kept.length).toBeGreaterThan(0);
    for (const k of kept) expect(k.excerpt_verified).toBe(true);
  });
});

describe('resolveSource — label and annotation on separate lines', () => {
  // Exactly the shape a labelled diagram produces: the READ stage returns each
  // label and each function as its own block, and splitSentences treats a line
  // break as a boundary, so they land in separate sentences.
  const diagram = [
    'FIGURE 2.1 — PLANT ORGANS AND THEIR FUNCTIONS',
    'FLOWER',
    'reproductive organ',
    'LEAF',
    'primary photosynthetic organ',
    'STEM',
    'support & transport',
  ].join('\n');

  it('rescues a card whose answer is the label and whose citation is the function', () => {
    // sentence 4 is "primary photosynthetic organ"; the answer is "The leaf".
    // Those share no words, so the direct score is 0 and the card used to die.
    const direct = sourceSupportScore('The leaf.', 'primary photosynthetic organ');
    expect(direct).toBe(0);

    const resolved = resolveSource(diagram, 4, 'The leaf.');
    expect(resolved).not.toBeNull();
    expect(resolved!.score).toBeGreaterThanOrEqual(SOURCE_SUPPORT_THRESHOLD);
    // The excerpt now carries the label WITH its meaning, which is the more
    // useful quote to show the user.
    expect(resolved!.text).toContain('LEAF');
    expect(resolved!.text).toContain('primary photosynthetic organ');
  });

  it('works in the other direction too — citing the label for a function answer', () => {
    const resolved = resolveSource(diagram, 3, 'It is the primary photosynthetic organ.');
    expect(resolved!.score).toBeGreaterThanOrEqual(SOURCE_SUPPORT_THRESHOLD);
  });

  it('does not widen when the cited sentence already supports the answer', () => {
    const prose = 'The stem provides support and transport. Roots absorb water.';
    const resolved = resolveSource(prose, 0, 'Support and transport.');
    // Untouched: the direct sentence stands on its own.
    expect(resolved!.text).toBe('The stem provides support and transport.');
  });

  it('still rejects a citation that no neighbourhood supports', () => {
    // Nothing near sentence 1 mentions mitochondria, so widening must not save it.
    const resolved = resolveSource(diagram, 1, 'The mitochondria produces ATP energy.');
    expect(resolved!.score).toBeLessThan(SOURCE_SUPPORT_THRESHOLD);
  });

  it('never widens beyond one sentence either side', () => {
    // "STEM" sits 2 sentences from "LEAF", so a leaf answer citing STEM stays a
    // miss — the window is deliberately narrow enough to stop a citation
    // drifting into a neighbouring topic.
    const resolved = resolveSource(diagram, 6, 'The leaf.');
    expect(resolved!.score).toBeLessThan(SOURCE_SUPPORT_THRESHOLD);
  });

  it('handles the window clamping at both ends of the page', () => {
    expect(resolveSource(diagram, 0, 'Plant organs and their functions.')).not.toBeNull();
    expect(resolveSource(diagram, 6, 'Support and transport.')).not.toBeNull();
    // Out of range is still null — a fabricated index must not resolve.
    expect(resolveSource(diagram, 99, 'anything')).toBeNull();
  });
});

describe('an mcq with no options becomes a flashcard', () => {
  // Observed live, twice: the model labels an item "mcq" and sends no options.
  // The prompt/answer pair is still good — only the option list is missing —
  // so it is salvaged as a flashcard rather than dropped as mc_invalid.
  it('keeps the item, downgraded to flashcard', () => {
    const { kept, dropped } = validateItems(
      [item({ kind: 'mcq', options: undefined, answer: 'The sinoatrial node', source_sentence: 0 })],
      pageTexts,
      budget,
    );
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.kind).toBe('flashcard');
    expect(kept[0]!.options).toBeUndefined();
  });

  it('treats an empty option list the same as a missing one', () => {
    const { kept, dropped } = validateItems(
      [item({ kind: 'mcq', options: [], answer: 'The sinoatrial node', source_sentence: 0 })],
      pageTexts,
      budget,
    );
    expect(dropped).toHaveLength(0);
    expect(kept[0]!.kind).toBe('flashcard');
  });

  it('still drops a genuinely broken option list', () => {
    // Two options with no correct one is not "missing options", it is wrong,
    // and the salvage must not paper over it.
    const { kept, dropped } = validateItems(
      [item({
        kind: 'mcq',
        options: [{ text: 'A', correct: false }, { text: 'B', correct: false }],
        answer: 'The sinoatrial node',
        source_sentence: 0,
      })],
      pageTexts,
      budget,
    );
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]!.reason).toBe('mc_invalid');
  });

  it('counts the salvaged card against the flashcard budget, not the mcq one', () => {
    // Budget is per LEVEL, not per kind, so this just confirms the downgraded
    // item is still subject to the same cap as any other item.
    const tight: TierBudget = { remember: 1, understand: 0, apply: 0 };
    const { kept, dropped } = validateItems(
      [
        item({ kind: 'mcq', options: undefined, answer: 'The sinoatrial node', source_sentence: 0 }),
        // A different answer, or it would be dropped as a duplicate first (§37).
        item({
          prompt: 'Second question about the pacemaker?',
          answer: 'The natural pacemaker of the heart',
          source_sentence: 0,
        }),
      ],
      pageTexts,
      tight,
    );
    expect(kept).toHaveLength(1);
    expect(dropped.some((d) => d.reason === 'over_budget')).toBe(true);
  });
});

describe('a written answer with no rubric becomes a flashcard', () => {
  // Measured on real stored cards: 2 of 9 short_answer items (22%) had no
  // usable rubric. buildGeneratePrompt rule 7 requires one and nothing checked
  // it, so those reached the quiz and dead-ended it — "This question can't be
  // marked. Skip it for now." Same salvage as an option-less MCQ above.
  const withRubric = {
    expected_concepts: [{ id: 'c1', text: 'It sets the rhythm' }],
    model_answer: 'The sinoatrial node sets the rhythm.',
  };

  it('keeps the item, downgraded to flashcard, when the rubric is absent', () => {
    const { kept, dropped } = validateItems(
      [item({ kind: 'short_answer', rubric: undefined, source_sentence: 0 })],
      pageTexts,
      budget,
    );
    expect(dropped).toHaveLength(0);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.kind).toBe('flashcard');
    expect(kept[0]!.rubric).toBeUndefined();
  });

  it('treats an empty concept list the same as a missing rubric', () => {
    // A rubric object with nothing in it is exactly as unmarkable as no rubric,
    // and gradeWritten would score it 0 of 0.
    const { kept } = validateItems(
      [
        item({
          kind: 'short_answer',
          rubric: { expected_concepts: [], model_answer: 'Anything.' },
          source_sentence: 0,
        }),
      ],
      pageTexts,
      budget,
    );
    expect(kept[0]!.kind).toBe('flashcard');
    expect(kept[0]!.rubric).toBeUndefined();
  });

  it('leaves a properly marked written answer alone', () => {
    const { kept } = validateItems(
      [item({ kind: 'short_answer', rubric: withRubric, source_sentence: 0 })],
      pageTexts,
      budget,
    );
    expect(kept[0]!.kind).toBe('short_answer');
    expect(kept[0]!.rubric).toEqual(withRubric);
  });

  it('salvages rather than drops, so the card count does not fall', () => {
    // The point of the salvage: the student keeps the card. Dropping would have
    // cost 22% of written answers outright.
    const { kept, dropped } = validateItems(
      [
        item({ kind: 'short_answer', rubric: undefined, source_sentence: 0 }),
        item({
          prompt: 'Second question about the pacemaker?',
          // A different answer, or it would be dropped as a duplicate (§37).
          answer: 'The natural pacemaker of the heart',
          kind: 'short_answer',
          rubric: withRubric,
          source_sentence: 0,
        }),
      ],
      pageTexts,
      budget,
    );
    expect(kept).toHaveLength(2);
    expect(dropped).toHaveLength(0);
    expect(kept.map((k) => k.kind)).toEqual(['flashcard', 'short_answer']);
  });
});
