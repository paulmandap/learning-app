import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_FORMS,
  classificationSpread,
  classifyForm,
  isApplication,
  isCauseAndEffect,
  isCompare,
  isDefinition,
  isProcess,
  isQuestionAndAnswer,
  PROCESS_MIN_MARKERS,
  QA_MAX_ANSWER_WORDS,
  type FormCandidate,
} from '../src/core/form';
import { buildGeneratePrompt } from '../src/ai/prompts';

/**
 * These test the INSTRUMENT, not the feature.
 *
 * They pin that each rule fires on a clear positive and refuses a clear
 * negative — enough to know the probe is measuring what it claims to. They
 * deliberately do NOT assert an accuracy: that is what `scripts/form-probe.ts`
 * measures against real generated cards, and asserting it here from examples I
 * chose myself would be marking my own homework.
 */

const card = (prompt: string, answer: string): FormCandidate => ({ prompt, answer });

describe('CANDIDATE_FORMS', () => {
  it('is §3.2.3\'s vocabulary, unchanged', () => {
    // The single home for this list since the dead prompt line was removed.
    // Pinned literally so a future edit is a deliberate act, not a drift.
    expect([...CANDIDATE_FORMS]).toEqual([
      'definition',
      'question and answer',
      'compare',
      'process',
      'cause and effect',
      'application',
    ]);
  });

  it('is NOT sent to the model — the dead instruction stays deleted', () => {
    // The line asked for a form the response schema had no field for, so no
    // card ever claimed one (NOTES §28.1). Removing it was checked against a
    // control run rather than argued; this stops it being written back.
    const prompt = buildGeneratePrompt({
      sectionTitle: 'Municipal water treatment',
      budget: { remember: 2, understand: 2, apply: 2 },
      pagesText: '[PAGE 0]\n[0] Alum is added in the coagulation tank.',
    });
    expect(prompt).not.toContain('Allowed forms');
    // The joined LIST, not the individual words: the prompt legitimately says
    // "recall a fact, definition or name" and "explain, compare, or say why"
    // in the level descriptions, and those have nothing to do with forms.
    expect(prompt).not.toContain(CANDIDATE_FORMS.join(', '));
  });
});

describe('isProcess', () => {
  it('accepts a sequence whose markers advance', () => {
    expect(
      isProcess(
        card(
          'How does water reach the leaves?',
          'First the roots absorb water from the soil, then it rises through the xylem, and finally it evaporates from the stomata.',
        ),
      ).ok,
    ).toBe(true);
  });

  it('accepts an explicitly numbered sequence', () => {
    expect(isProcess(card('Steps?', '1. Absorb water. 2. Transport it upward. 3. Release vapour.')).ok).toBe(
      true,
    );
  });

  it(`refuses fewer than ${PROCESS_MIN_MARKERS} markers`, () => {
    const result = isProcess(card('What happens?', 'The stomata then open.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('found 1');
  });

  it('refuses a list that never advances — the point of the tiers', () => {
    // Two markers, same tier. "then … then" enumerates; it does not sequence.
    const result = isProcess(card('What happens?', 'The guard cells then swell and the pore then opens.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('do not advance');
  });
});

describe('isCompare', () => {
  it('accepts two subjects joined by a contrastive connective', () => {
    expect(
      isCompare(
        card(
          'How do xylem and phloem differ?',
          'The xylem carries water upward from the roots whereas the phloem carries sugars in both directions.',
        ),
      ).ok,
    ).toBe(true);
  });

  it('accepts "the difference between X and Y"', () => {
    expect(isCompare(card('What is the difference between xylem and phloem?', 'One carries water, the other sugars.')).ok).toBe(
      true,
    );
  });

  it('refuses a card with no contrast at all', () => {
    const result = isCompare(card('What does the xylem carry?', 'Water.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no contrastive connective');
  });

  it('refuses one subject described twice', () => {
    // Parallel phrasing is normal in a real comparison, so overlap is not the
    // test — each side having something of its own is. Here neither does.
    const result = isCompare(card('Tell me about the xylem', 'The xylem carries water whereas the xylem carries water.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('same thing');
  });
});

describe('isCauseAndEffect', () => {
  it('accepts a causal connective with both sides present', () => {
    expect(
      isCauseAndEffect(
        card('What opens the stomatal pore?', 'The guard cells take up potassium, which causes them to swell and bend apart.'),
      ).ok,
    ).toBe(true);
  });

  it('accepts a why question answered with a mechanism', () => {
    expect(isCauseAndEffect(card('Why do guard cells bend apart?', 'Turgor pressure rises inside them.')).ok).toBe(true);
  });

  it('refuses a why question the answer does not answer', () => {
    const result = isCauseAndEffect(card('Why does it happen?', 'Yes.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no mechanism');
  });

  it('refuses a plain factual card', () => {
    expect(isCauseAndEffect(card('What is the cortex?', 'A storage tissue in the root.')).ok).toBe(false);
  });
});

describe('isDefinition', () => {
  it('accepts a definitional question about one subject', () => {
    expect(isDefinition(card('What is the cortex?', 'The storage tissue lying between the epidermis and the vascular cylinder.')).ok).toBe(
      true,
    );
  });

  it('refuses a comparison that merely opens with "what is"', () => {
    // The coupling is deliberate and documented: in a taxonomy where a card
    // carries ONE form, a human labels this `compare` without hesitating.
    const result = isDefinition(card('What is the difference between xylem and phloem?', 'One carries water, the other sugars.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('contrasts two things');
  });

  it('refuses a question that does not ask what something is', () => {
    expect(isDefinition(card('Name the tissue that carries water.', 'Xylem.')).ok).toBe(false);
  });
});

describe('isApplication', () => {
  it('accepts a scenario the answer resolves', () => {
    expect(
      isApplication(
        card(
          'A gardener finds a plant wilting despite wet soil. What should they check?',
          'Whether the roots are damaged and cannot absorb water.',
        ),
      ).ok,
    ).toBe(true);
  });

  it('refuses a card that sets up no case', () => {
    const result = isApplication(card('What is the cortex?', 'A storage tissue.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('no case');
  });

  it('never reads level — the same text judges the same way', () => {
    // The H2 question ("is this form just level: apply?") must not be answered
    // by construction. The rule takes prompt and answer and nothing else, so
    // there is no level to consult; this pins the signature against a later
    // well-meaning edit that adds one.
    const item = card('Suppose the xylem is blocked. What happens to the leaves?', 'They wilt as water cannot reach them.');
    expect(isApplication(item).ok).toBe(true);
    expect(Object.keys(item)).toEqual(['prompt', 'answer']);
  });
});

describe('isQuestionAndAnswer', () => {
  it('accepts a direct factual question with a short answer', () => {
    expect(isQuestionAndAnswer(card('Which tissue carries water upward?', 'The xylem.')).ok).toBe(true);
  });

  it('refuses a prompt that is not a question', () => {
    const result = isQuestionAndAnswer(card('The xylem.', 'Carries water.'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not a direct question');
  });

  it(`refuses an answer longer than ${QA_MAX_ANSWER_WORDS} content words`, () => {
    // Every token over two letters, so none is filtered as structural: the cap
    // counts CONTENT words and a fixture of short ones would not reach it.
    const long =
      'alpha beta gamma delta epsilon zeta theta iota kappa lambda omicron sigma upsilon omega';
    const result = isQuestionAndAnswer(card('What are they?', long));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('content words');
  });

  it('yields to the structural forms rather than swallowing them', () => {
    // This is what makes H1 ("it is a catch-all") refutable rather than true by
    // construction. If the rule accepted these, its non-form acceptance would
    // be 1.0 no matter what the data said.
    const comparison = card('Which differs, xylem or phloem?', 'Xylem carries water whereas phloem carries sugars.');
    const causal = card('What causes the pore to open?', 'Potassium uptake causes swelling.');
    expect(isQuestionAndAnswer(comparison).ok).toBe(false);
    expect(isQuestionAndAnswer(causal).ok).toBe(false);
  });
});

describe('classifyForm', () => {
  it('reports every accepting label, not a winner', () => {
    const result = classifyForm(
      card(
        'What is the difference between xylem and phloem?',
        'The xylem carries water upward whereas the phloem carries sugars in both directions.',
      ),
    );
    expect(result.accepted).toContain('compare');
    expect(result.accepted).not.toContain('definition');
  });

  it('gives a reason for every label it refuses', () => {
    const result = classifyForm(card('The xylem.', 'Water.'));
    for (const label of CANDIDATE_FORMS) {
      if (!result.accepted.includes(label)) expect(result.reasons[label]).toBeTruthy();
    }
  });

  it('lets an item be claimed by nothing', () => {
    // Zero is a real answer and the measurement depends on it being reportable.
    // A rule set that always fires cannot show a taxonomy failure.
    expect(classifyForm(card('The xylem.', 'Water.')).accepted).toEqual([]);
  });
});

describe('classificationSpread', () => {
  it('counts unclaimed and multiply-claimed items separately', () => {
    const spread = classificationSpread([
      card('What is the cortex?', 'A storage tissue in the root.'),
      card('The xylem.', 'Water.'),
      card('What is the difference between xylem and phloem?', 'One carries water, the other sugars.'),
    ]);

    expect(spread.total).toBe(3);
    expect(spread.unclaimed).toBe(1);
    expect(spread.byLabel.definition).toBe(1);
    expect(spread.byLabel.compare).toBe(1);
  });
});
