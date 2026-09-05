import { describe, expect, it } from 'vitest';
import {
  shouldRephrase,
  validateVariant,
  VARIANT_LAPSE_THRESHOLD,
  VARIANT_MIN_DIFFERENCE,
} from '../src/core/variant';

const EXCERPT =
  'Xylem moves water upward from the roots; phloem moves the sugars produced in the leaves ' +
  'to wherever they are needed or stored.';

const ORIGINAL = 'Which type of vascular tissue carries water upward from the roots?';

function variant(rephrased: string, over: Partial<Parameters<typeof validateVariant>[0]> = {}) {
  return validateVariant({
    original: ORIGINAL,
    rephrased,
    answer: 'Xylem',
    sourceExcerpt: EXCERPT,
    ...over,
  });
}

describe('shouldRephrase', () => {
  it(`fires on the ${VARIANT_LAPSE_THRESHOLD}rd lapse and not before`, () => {
    for (let lapses = 0; lapses < VARIANT_LAPSE_THRESHOLD; lapses++) {
      expect(shouldRephrase({ lapses, alreadyRephrased: false })).toBe(false);
    }
    expect(shouldRephrase({ lapses: VARIANT_LAPSE_THRESHOLD, alreadyRephrased: false })).toBe(true);
  });

  it('does not fire again on later lapses', () => {
    // === not >=. Combined with variant_prompt being set, a card is rephrased
    // once; without this a card failed ten times would spend ten model calls.
    for (const lapses of [4, 5, 9, 40]) {
      expect(shouldRephrase({ lapses, alreadyRephrased: false })).toBe(false);
    }
  });

  it('never fires for a card that already has a variant', () => {
    expect(
      shouldRephrase({ lapses: VARIANT_LAPSE_THRESHOLD, alreadyRephrased: true }),
    ).toBe(false);
  });
});

describe('validateVariant', () => {
  it('accepts a genuine rewrite', () => {
    const r = variant('Water travelling up from the roots is carried by which tissue?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prompt).toBe('Water travelling up from the roots is carried by which tissue?');
  });

  it('trims, and rejects an empty rewrite', () => {
    expect(variant('   ').ok).toBe(false);
    const r = variant('  Which tissue moves water up from a plant’s roots?  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prompt).toBe('Which tissue moves water up from a plant’s roots?');
  });

  it('rejects a rewrite that gives the answer away', () => {
    const r = variant('Xylem carries water upward — what is this tissue called?');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('leak');
  });

  it('rejects a rewrite that points outside the card', () => {
    // Produced verbatim by a weaker rung of the fallback ladder on the first
    // live run, despite the prompt forbidding it. A student sees one card with
    // no notes beside it.
    const r = variant(
      "Based on the student's notes, which tissue carries water up from the roots?",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('refers_to_notes');
  });

  it('rejects the other ways a card can break its own frame', () => {
    for (const bad of [
      'According to the passage, which tissue moves water upward?',
      'As shown above, which tissue moves water upward?',
      'In the text, which tissue carries water from the roots?',
      'Which tissue is named in your notes as carrying water upward?',
    ]) {
      const r = variant(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason, bad).toBe('refers_to_notes');
    }
  });

  it('does not mistake ordinary wording for a reference', () => {
    // Narrow on purpose: a false positive only costs the original wording, but
    // rejecting every question containing "above" would reject good ones.
    for (const fine of [
      'Which tissue sits above the root collar and carries water upward?',
      'A plant needs to move water from soil to leaf — which tissue does it?',
      'Which tissue moves water up, given the roots take it in?',
    ]) {
      expect(variant(fine).ok, fine).toBe(true);
    }
  });

  it('rejects a rewrite that is barely different from the original', () => {
    // A "variant" the student cannot tell from the card that already beat them
    // is a wasted call, not a second chance.
    const r = variant('Which type of vascular tissue carries water upward from roots?');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_different');
  });

  it('rejects the original verbatim', () => {
    const r = variant(ORIGINAL);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_different');
  });

  it('re-checks grounding, so a card whose source no longer supports it is left alone', () => {
    // Should pass by construction — the answer and excerpt are untouched — which
    // is exactly why a failure means something upstream is wrong.
    const r = variant('Which tissue moves water up the plant?', {
      sourceExcerpt: 'Photosynthesis happens in the leaves of the plant.',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ungrounded');
  });

  it('leaves the answer and the citation out of its own remit', () => {
    // The function takes them, checks them, and returns only a prompt. Nothing
    // it returns can change what the card is asking for.
    const r = variant('Moving water up from the roots is the job of which tissue?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r)).toEqual(['ok', 'prompt']);
  });

  it(`uses the same "same question" threshold dedup uses (${VARIANT_MIN_DIFFERENCE})`, () => {
    expect(VARIANT_MIN_DIFFERENCE).toBe(0.8);
  });
});
