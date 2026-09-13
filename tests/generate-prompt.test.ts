import { describe, expect, it } from 'vitest';
import { buildGeneratePrompt, renderPagesForPrompt } from '../src/ai/prompts';
import { flattenLines, planBands } from '../src/core/coverage';

const base = {
  sectionTitle: 'Your notes',
  budget: { remember: 5, understand: 3, apply: 2 },
  pagesText: '[PAGE 0]\n[0] A line.',
};

describe('buildGeneratePrompt — the count asked for is the count wanted (NOTES §37)', () => {
  it('asks for exactly the total, never "at most"', () => {
    const prompt = buildGeneratePrompt(base);
    expect(prompt).toContain('Write exactly 10 items');
    expect(prompt).not.toMatch(/at most/i);
  });

  it('no longer tells the model it may return fewer', () => {
    // "If the notes do not support the number of items asked for, return FEWER"
    // is the line that turned the owner's request for 10 into 2.
    expect(buildGeneratePrompt(base)).not.toMatch(/return fewer|fewer items|returning nothing/i);
  });

  it('treats any text as study material, a song included', () => {
    expect(buildGeneratePrompt(base)).toMatch(/song lyrics/i);
  });

  it('forbids a repeated answer — which sameAnswer then checks', () => {
    expect(buildGeneratePrompt(base)).toMatch(/NO TWO ITEMS\s+MAY HAVE THE SAME ANSWER/);
  });

  it('says how many to take from each part of the notes', () => {
    const lines = flattenLines([
      { page_index: 0, text: Array.from({ length: 30 }, (_, i) => `line ${i} has words`).join('\n') },
    ]);
    const prompt = buildGeneratePrompt({ ...base, bands: planBands(lines, 10) });
    expect(prompt).toContain('Take this many from each part');
    expect(prompt).toMatch(/\[PAGE 0\] lines 0–9: \d/);
    expect(prompt).toMatch(/\[PAGE 0\] lines 20–29: \d/);
  });

  it('shows what is already written, so a later request does not repeat it', () => {
    const prompt = buildGeneratePrompt({ ...base, avoid: [{ prompt: 'Who gave the peaches?', answer: 'The owner' }] });
    expect(prompt).toContain('ALREADY WRITTEN');
    expect(prompt).toContain('- Who gave the peaches? → The owner');
  });

  it('names the lines still without a card, when a fill request is held to them', () => {
    expect(buildGeneratePrompt(base)).not.toMatch(/already has a card/i);
    const prompt = buildGeneratePrompt({
      ...base,
      onlyLines: [
        { page: 0, sentence: 3 },
        { page: 0, sentence: 9 },
      ],
    });
    expect(prompt).toContain('Every other line of these notes already has a card');
    expect(prompt).toContain('[PAGE 0] lines 3, 9');
  });

  it('asks for new angles only when told to', () => {
    expect(buildGeneratePrompt(base)).not.toMatch(/different angle/i);
    expect(buildGeneratePrompt({ ...base, angles: true })).toMatch(/different angle/i);
  });

  it('calls the levels a guide on a fill pass, and a budget otherwise', () => {
    expect(buildGeneratePrompt(base)).not.toMatch(/levels are a guide/i);
    expect(buildGeneratePrompt({ ...base, flexibleLevels: true })).toMatch(/levels are a guide/i);
  });
});

describe('renderPagesForPrompt with a span', () => {
  const page = { page_index: 0, text: 'Zero.\nOne.\nTwo.\nThree.' };

  it('numbers every line when there is no span, as before', () => {
    expect(renderPagesForPrompt([page])).toBe('[PAGE 0]\n[0] Zero.\n[1] One.\n[2] Two.\n[3] Three.');
  });

  it('shows only the part, keeping the original numbers so citations still resolve', () => {
    const span = { from: { page: 0, sentence: 1 }, to: { page: 0, sentence: 2 } };
    expect(renderPagesForPrompt([page], span)).toBe('[PAGE 0]\n[1] One.\n[2] Two.');
  });

  it('leaves out a page with no lines in the part', () => {
    const span = { from: { page: 1, sentence: 0 }, to: { page: 1, sentence: 0 } };
    expect(renderPagesForPrompt([page, { page_index: 1, text: 'Other.' }], span)).toBe('[PAGE 1]\n[0] Other.');
  });
});
