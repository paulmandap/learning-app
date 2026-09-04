import { describe, expect, it } from 'vitest';
import {
  allocateTiers,
  buildPlan,
  countAtomicUnits,
  estimateSupported,
  splitIntoSections,
  supportedFor,
  WORDS_PER_ITEM,
  type PageInput,
} from '../src/core/planner';
import { wordCount } from '../src/core/text';

/** n words of filler, so budget arithmetic is exact and readable. */
function words(n: number): string {
  return Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
}

/** The real notes that exposed the undercount: 11 Q&A pairs in ~160 words. */
const QA_NOTES = [
  '2. What is the biggest species of primate?',
  'Answer: Gorilla',
  '',
  '3. What land mammal has the most teeth?',
  'Answer: The Giant Armadillo! It can grow up to 100 teeth!',
  '',
  '4. What is the only marsupial living in North America?',
  'Answer: Opossum!',
  '',
  '5. What is the only mammal that can fly?',
  'Answer: Bats! But they glide rather than actually fly',
  '',
  '6. What animal is immune to cancer?',
  'Answer: Naked Mole Rats!',
  '',
  '7. What animal is famous for carrying its young in a pouch?',
  'Answer: Kangaroo!',
  '',
  '8. What animal in baby form is known as a puggle?',
  'Answer: Echidnas!',
  '',
  '9. What is the biggest land living weasel?',
  'Answer: The Wolverine!',
  '',
  '10. What are the only cats that live together in groups?',
  'Answer: Lions!',
  '',
  '11. What is the largest rodent in the world?',
  'Answer: Capybara!',
  '',
  '12. What animal uses its tough scales as armour when threatened?',
  'Answer: A Pangolin!',
].join('\n');

function page(index: number, wordN: number, opts: Partial<PageInput> = {}): PageInput {
  return {
    page_index: index,
    text: words(wordN),
    readability: 0.9,
    headings: [],
    ...opts,
  };
}

describe('allocateTiers', () => {
  it('splits 10 into the 50/30/20 mix', () => {
    expect(allocateTiers(10)).toEqual({ remember: 5, understand: 3, apply: 2 });
  });

  it('always sums to the total, whatever the rounding', () => {
    for (let total = 0; total <= 60; total++) {
      const b = allocateTiers(total);
      expect(b.remember + b.understand + b.apply).toBe(total);
    }
  });

  it('keeps Remember the largest tier', () => {
    for (const total of [3, 7, 11, 19, 25, 41]) {
      const b = allocateTiers(total);
      expect(b.remember).toBeGreaterThanOrEqual(b.understand);
      expect(b.understand).toBeGreaterThanOrEqual(b.apply);
    }
  });

  it('handles 0 and 1', () => {
    expect(allocateTiers(0)).toEqual({ remember: 0, understand: 0, apply: 0 });
    expect(allocateTiers(1)).toEqual({ remember: 1, understand: 0, apply: 0 });
  });
});

describe('estimateSupported', () => {
  it('is one item per 70 words for plain prose', () => {
    expect(estimateSupported([page(0, 700)])).toBe(10);
    expect(estimateSupported([page(0, 69)])).toBe(0);
  });

  it('excludes unreadable pages from the estimate', () => {
    const pages = [page(0, 700), page(1, 700, { readability: 0.3 })];
    expect(estimateSupported(pages)).toBe(10);
  });

  it('counts structure in already-formatted Q&A notes', () => {
    // The real failure this fixes: 11 questions in 160 words scored 2 by the
    // word rule alone, because 70-words-per-card assumes prose.
    const qa = QA_NOTES;
    expect(countAtomicUnits(qa)).toBe(11);
    const estimate = estimateSupported([
      { page_index: 0, text: qa, readability: 1, headings: [] },
    ]);
    expect(estimate).toBeGreaterThanOrEqual(10);
    expect(estimate).toBeLessThanOrEqual(11);
  });

  it('counts bullets as units too', () => {
    const bullets = [
      '- The mitochondrion is the powerhouse of the cell',
      '- Chloroplasts carry out photosynthesis in plant cells',
      '- Ribosomes assemble proteins from amino acid chains',
    ].join('\n');
    expect(countAtomicUnits(bullets)).toBe(3);
  });

  it('refuses to manufacture cards from tiny fragments', () => {
    // 40 two-word bullets must not claim 40 cards.
    const fragments = Array.from({ length: 40 }, (_, i) => `- item ${i}`).join('\n');
    expect(estimateSupported([{ page_index: 0, text: fragments, readability: 1, headings: [] }]))
      .toBeLessThanOrEqual(Math.floor(wordCount(fragments) / 10));
  });

  it('never claims more than one card per 10 words, however dense', () => {
    for (const text of [QA_NOTES, 'a b c', words(50)]) {
      const est = supportedFor(text);
      const w = wordCount(text);
      expect(est).toBeLessThanOrEqual(Math.max(Math.floor(w / 10), Math.floor(w / 70)));
    }
  });

  it('leaves prose estimates unchanged — no padding regression', () => {
    // D3's whole point. Prose has no list markers, so structure adds nothing.
    expect(supportedFor(words(700))).toBe(10);
    expect(supportedFor(words(140))).toBe(2);
  });
});

describe('splitIntoSections', () => {
  it('starts a new section at each heading', () => {
    const pages = [
      page(0, 100, { headings: ['Conduction'] }),
      page(1, 100),
      page(2, 100, { headings: ['Valves'] }),
    ];
    const sections = splitIntoSections(pages);
    expect(sections.map((s) => s.title)).toEqual(['Conduction', 'Valves']);
    expect(sections[0]!.pages).toEqual([0, 1]);
    expect(sections[1]!.pages).toEqual([2]);
  });

  it('falls back to ~400-word windows with no headings', () => {
    const pages = Array.from({ length: 6 }, (_, i) => page(i, 200));
    const sections = splitIntoSections(pages);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.every((s) => s.words > 0)).toBe(true);
  });

  it('never includes an unreadable page in a section', () => {
    const pages = [page(0, 100), page(1, 100, { readability: 0.1 }), page(2, 100)];
    const covered = splitIntoSections(pages).flatMap((s) => s.pages);
    expect(covered).not.toContain(1);
  });

  it('returns nothing when every page is unreadable', () => {
    expect(splitIntoSections([page(0, 100, { readability: 0.2 })])).toEqual([]);
  });
});

describe('buildPlan', () => {
  it('HONOURS the number the user asked for', () => {
    // Previously this capped at floor(words/70), so 700 words gave 10 cards no
    // matter what was requested and the picker was decoration. The user's
    // choice is now the target; padding is prevented by the prompt and the
    // validators, which judge what was actually written.
    const plan = buildPlan([page(0, 700, { headings: ['A'] })], 60);
    expect(plan.maxTotal).toBe(60);
    expect(sum(plan)).toBe(60);
  });

  it('honours a smaller request on long notes too', () => {
    const plan = buildPlan([page(0, 7000, { headings: ['A'] })], 20);
    expect(plan.maxTotal).toBe(20);
    expect(sum(plan)).toBe(20);
  });

  it('never exceeds what was requested, for any note length', () => {
    for (const requested of [10, 20, 40, 60]) {
      for (const wordN of [50, 200, 1000, 5000, 12345]) {
        const plan = buildPlan([page(0, wordN, { headings: ['A'] })], requested);
        expect(sum(plan)).toBeLessThanOrEqual(requested);
        expect(sum(plan)).toBe(plan.maxTotal);
      }
    }
  });

  it('a short reviewer-style page is no longer throttled to 3', () => {
    // The exact complaint: 251 words of prose produced 3 cards whether you
    // asked for 10 or 60.
    const plan = buildPlan([page(0, 251, { headings: ['Cellular Respiration'] })], 20);
    expect(plan.maxTotal).toBe(20);
    expect(sum(plan)).toBeGreaterThan(3);
  });

  it('shares items across sections roughly in proportion to words', () => {
    const plan = buildPlan(
      [
        page(0, 2100, { headings: ['Big'] }),
        page(1, 700, { headings: ['Small'] }),
      ],
      40,
    );
    const big = plan.sections.find((s) => s.title === 'Big')!;
    const small = plan.sections.find((s) => s.title === 'Small')!;
    expect(big.total).toBeGreaterThan(small.total);
    expect(sum(plan)).toBe(plan.maxTotal);
  });

  it('records unreadable pages instead of silently skipping them', () => {
    const plan = buildPlan(
      [page(0, 700, { headings: ['A'] }), page(1, 500, { readability: 0.4 })],
      20,
    );
    expect(plan.unreadablePages).toEqual([1]);
  });

  it('still plans something for very short notes — the model returns fewer', () => {
    // No longer zeroed out by a word-count rule. The generation prompt is what
    // declines to pad, based on the actual text.
    const plan = buildPlan([page(0, 30)], 20);
    expect(plan.maxTotal).toBe(20);
    expect(plan.sections.length).toBeGreaterThan(0);
  });

  it('produces an empty plan when everything is unreadable', () => {
    const plan = buildPlan([page(0, 900, { readability: 0.2 })], 20);
    expect(plan.sections).toEqual([]);
    expect(plan.unreadablePages).toEqual([0]);
  });

  it('gives every section a per-tier budget that sums to its total', () => {
    const plan = buildPlan(
      [page(0, 3000, { headings: ['A'] }), page(1, 1500, { headings: ['B'] })],
      40,
    );
    for (const s of plan.sections) {
      expect(s.budget.remember + s.budget.understand + s.budget.apply).toBe(s.total);
    }
  });

  it('gives sections stable ids so a resumed run matches them up', () => {
    const pages = [page(0, 1000, { headings: ['A'] }), page(1, 1000, { headings: ['B'] })];
    const a = buildPlan(pages, 20);
    const b = buildPlan(pages, 20);
    expect(a.sections.map((s) => s.id)).toEqual(b.sections.map((s) => s.id));
  });
});

function sum(plan: { sections: { total: number }[] }): number {
  return plan.sections.reduce((acc, s) => acc + s.total, 0);
}
