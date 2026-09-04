import { describe, expect, it } from 'vitest';
import {
  cleanCandidate,
  describeDrops,
  detectLeak,
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

  it('detects an off-by-one citation via the support check', () => {
    // Sentence 1 is "It fires 60-100 times per minute" — it does not support a
    // question about the AV node, even though it is a real sentence.
    const right = resolveSource(PAGE_TEXT, 2, 'The atrioventricular node delays conduction');
    const offByOne = resolveSource(PAGE_TEXT, 1, 'The atrioventricular node delays conduction');
    expect(right!.score).toBeGreaterThan(SOURCE_SUPPORT_THRESHOLD);
    expect(offByOne!.score).toBeLessThan(SOURCE_SUPPORT_THRESHOLD);
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

describe('describeDrops — explains "19 of 20"', () => {
  it('names a single reason in plain language', () => {
    expect(describeDrops({ duplicate: 1 })).toBe(
      'We left out 1 card because it repeated another card.',
    );
  });

  it('pluralises the subject as well as the noun', () => {
    // "3 cards because it repeated" is the bug this pins.
    expect(describeDrops({ duplicate: 3 })).toBe(
      'We left out 3 cards because they repeated other cards.',
    );
  });

  it('lists multiple reasons, commonest first', () => {
    expect(describeDrops({ leak: 1, duplicate: 2 })).toBe(
      'We left out 3 cards: 2 repeated another card, 1 gave away the answer.',
    );
  });

  it('returns null when nothing was dropped, so no line is shown', () => {
    expect(describeDrops({})).toBeNull();
    expect(describeDrops({ duplicate: 0 })).toBeNull();
  });

  it('uses no technical vocabulary on any reason', () => {
    const all = describeDrops({
      schema: 1, excerpt_unmatched: 1, mc_invalid: 1, leak: 1, duplicate: 1, over_budget: 1,
    })!;
    expect(all).not.toMatch(/schema|excerpt|validator|token|index|JSON|budget|tier/i);
  });

  it('summariseDrops counts by reason', () => {
    expect(
      summariseDrops([
        { reason: 'duplicate', detail: '', prompt: '', excerpt: '', page_index: 0 },
        { reason: 'duplicate', detail: '', prompt: '', excerpt: '', page_index: 0 },
        { reason: 'leak', detail: '', prompt: '', excerpt: '', page_index: 0 },
      ]),
    ).toEqual({ duplicate: 2, leak: 1 });
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
    const candidates = [
      item({ prompt: 'Question one about the pacemaker?' }),
      item({ prompt: 'Roughly how many times a minute does it fire?' }),
      item({ level: 'understand', prompt: 'Why does conduction slow at the AV node?' }),
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
