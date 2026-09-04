import { describe, expect, it } from 'vitest';
import { GENERATE_RESPONSE_SCHEMA, parseItemsLoose, parseReadResult } from '../src/ai/schemas';
import { validateItems, type CandidateItem } from '../src/core/validate';
import type { TierBudget } from '../src/core/planner';

const PAGE =
  'Glycolysis takes place in the cytoplasm and does not require oxygen. ' +
  'The Krebs cycle occurs in the mitochondrial matrix. ' +
  'Oxygen acts as the final electron acceptor, forming water.';

const pageTexts = new Map([[0, PAGE]]);
const budget: TierBudget = { remember: 5, understand: 3, apply: 2 };

function good(over: Record<string, unknown> = {}) {
  return {
    kind: 'flashcard',
    level: 'remember',
    prompt: 'Where does glycolysis take place?',
    answer: 'In the cytoplasm, without requiring oxygen',
    page_index: 0,
    source_sentence: 0,
    topic: 'glycolysis',
    ...over,
  };
}

describe('response schema is lean', () => {
  it('no longer asks the model to reproduce source text', () => {
    // source_excerpt was the largest field in the response and pure duplication
    // of text the app already stores. Asking for it cost wall-clock directly.
    const json = JSON.stringify(GENERATE_RESPONSE_SCHEMA);
    expect(json).not.toContain('source_excerpt');
    expect(json).toContain('source_sentence');
  });

  it('requires only the fields an item genuinely needs', () => {
    const required = GENERATE_RESPONSE_SCHEMA.properties.items.items.required as readonly string[];
    expect([...required].sort()).toEqual(
      ['answer', 'kind', 'level', 'page_index', 'prompt', 'source_sentence'].sort(),
    );
    // rubric and options stay optional — they only apply to some item kinds.
    expect(required).not.toContain('rubric');
    expect(required).not.toContain('options');
    expect(required).not.toContain('form');
  });
});

describe('parseItemsLoose — malformed output must not lose the batch', () => {
  it('keeps well-formed items and counts the rest', () => {
    const { items, malformed } = parseItemsLoose({
      items: [
        good(),
        { kind: 'flashcard' }, // missing nearly everything
        good({ prompt: 'Where does the Krebs cycle occur?', source_sentence: 1 }),
        { kind: 'nonsense', level: 'remember', prompt: 'x', answer: 'y', page_index: 0, source_sentence: 0 },
      ],
    });
    expect(items).toHaveLength(2);
    expect(malformed).toBe(2);
  });

  it('survives junk payloads without throwing', () => {
    expect(parseItemsLoose(null).items).toEqual([]);
    expect(parseItemsLoose({}).items).toEqual([]);
    expect(parseItemsLoose({ items: 'not an array' }).items).toEqual([]);
    expect(parseItemsLoose('<html>500</html>').items).toEqual([]);
  });

  it('rejects a non-integer sentence index at parse time', () => {
    const { items, malformed } = parseItemsLoose({ items: [good({ source_sentence: 1.5 })] });
    expect(items).toHaveLength(0);
    expect(malformed).toBe(1);
  });

  it('a whole malformed batch degrades to zero items, not an exception', () => {
    const { items } = parseItemsLoose({ items: [{}, {}, {}] });
    expect(items).toEqual([]);
  });
});

describe('parseReadResult salvages partial pages', () => {
  it('keeps the pages that parse when one is broken', () => {
    const r = parseReadResult({
      pages: [
        { page_index: 0, headings: [], blocks: [], readability: 1 },
        { page_index: 'nope' },
      ],
    });
    expect(r?.pages).toHaveLength(1);
  });

  it('returns null when nothing is usable', () => {
    expect(parseReadResult({ pages: [{ bad: true }] })).toBeNull();
    expect(parseReadResult(null)).toBeNull();
  });
});

describe('dedup across concurrently-finishing sections', () => {
  it('a shared accumulator stops two sections writing the same card', () => {
    // Sections now run concurrently through the queue, so each validation pass
    // must see the prompts its siblings already kept. Without the shared list,
    // two sections covering overlapping notes both write the same card.
    const seen: string[] = [];

    const first = validateItems([good() as CandidateItem], pageTexts, budget, seen);
    for (const k of first.kept) seen.push(k.prompt);

    const second = validateItems(
      [good({ prompt: 'Where does glycolysis take place?' }) as CandidateItem],
      pageTexts,
      budget,
      seen,
    );

    expect(first.kept).toHaveLength(1);
    expect(second.kept).toHaveLength(0);
    expect(second.dropped[0]!.reason).toBe('duplicate');
  });

  it('one section failing does not invalidate another section results', () => {
    // Mirrors Promise.allSettled in the pipeline: a rejected section leaves the
    // items other sections already stored untouched.
    const seen: string[] = [];
    const ok = validateItems([good() as CandidateItem], pageTexts, budget, seen);
    for (const k of ok.kept) seen.push(k.prompt);

    const broken = validateItems(
      [good({ source_sentence: 999 }) as CandidateItem],
      pageTexts,
      budget,
      seen,
    );

    expect(ok.kept).toHaveLength(1);
    expect(broken.kept).toHaveLength(0);
    expect(broken.dropped[0]!.reason).toBe('excerpt_unmatched');
  });
});
