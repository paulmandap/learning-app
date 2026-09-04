import { describe, expect, it, vi } from 'vitest';
import { GeminiBrowserProvider } from '../src/ai/gemini';
import { buildGradePrompt } from '../src/ai/prompts';
import { GRADE_RESPONSE_SCHEMA, parseGradeResult } from '../src/ai/schemas';
import { gradeWritten } from '../src/core/grade';

/** No network: the provider is driven with an injected fetch. */
function stubFetch(status: number, modelText: unknown) {
  const body =
    status === 200
      ? { candidates: [{ content: { parts: [{ text: JSON.stringify(modelText) }] } }] }
      : modelText;
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

const rubric = {
  expected_concepts: [
    { id: 'c1', text: 'occurs in the cytoplasm' },
    { id: 'c2', text: 'requires no oxygen' },
    { id: 'c3', text: 'yields two ATP' },
  ],
  model_answer: 'Glycolysis happens in the cytoplasm without oxygen and nets two ATP.',
};

describe('gradeAnswer', () => {
  it('returns the concepts the model found', async () => {
    const provider = new GeminiBrowserProvider('k', {
      fetchImpl: stubFetch(200, { concepts_hit: ['c1', 'c2'], feedback: 'Good start.' }),
    });
    const result = await provider.gradeAnswer({
      prompt: 'Describe glycolysis.',
      rubric,
      answer: 'It happens in the cytoplasm and needs no oxygen.',
    });
    expect(result.concepts_hit).toEqual(['c1', 'c2']);
    expect(result.feedback).toBe('Good start.');
  });

  it('degrades to "nothing found" on junk rather than throwing', async () => {
    const provider = new GeminiBrowserProvider('k', {
      fetchImpl: stubFetch(200, { unexpected: true }),
    });
    const result = await provider.gradeAnswer({ prompt: 'q', rubric, answer: 'a' });
    expect(result.concepts_hit).toEqual([]);
    expect(result.feedback).toBe('');
  });

  it('grades at temperature 0 so the same answer scores the same twice', async () => {
    const spy = stubFetch(200, { concepts_hit: [], feedback: '' });
    const provider = new GeminiBrowserProvider('k', { fetchImpl: spy });
    await provider.gradeAnswer({ prompt: 'q', rubric, answer: 'a' });

    const call = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call![1] as RequestInit).body as string);
    expect(body.generationConfig.temperature).toBe(0);
    expect(body.generationConfig.responseSchema).toEqual(GRADE_RESPONSE_SCHEMA);
  });

  it('never lets the model set the score — that is computed from its concept list', async () => {
    // Even if the model claims everything, only ids present in the rubric count,
    // and the arithmetic happens in core/grade.ts.
    const provider = new GeminiBrowserProvider('k', {
      fetchImpl: stubFetch(200, {
        concepts_hit: ['c1', 'c1', 'invented', 'c9'],
        feedback: 'Nice.',
      }),
    });
    const result = await provider.gradeAnswer({ prompt: 'q', rubric, answer: 'a' });
    const graded = gradeWritten({
      expected: rubric.expected_concepts,
      conceptsHit: result.concepts_hit,
      feedback: result.feedback,
    });
    expect(graded.score).toBe(1);
    expect(graded.maxScore).toBe(3);
    expect(graded.result).toBe('incorrect');
  });
});

describe('parseGradeResult', () => {
  it('accepts a well-formed payload', () => {
    expect(parseGradeResult({ concepts_hit: ['c1'], feedback: 'ok' })).toEqual({
      concepts_hit: ['c1'],
      feedback: 'ok',
    });
  });

  it('falls back to empty rather than throwing', () => {
    expect(parseGradeResult(null)).toEqual({ concepts_hit: [], feedback: '' });
    expect(parseGradeResult({ concepts_hit: 'nope' })).toEqual({ concepts_hit: [], feedback: '' });
  });
});

describe('buildGradePrompt', () => {
  const prompt = buildGradePrompt({
    question: 'Describe glycolysis.',
    expectedConcepts: rubric.expected_concepts,
    studentAnswer: 'In the cytoplasm, no oxygen needed.',
  });

  it('puts the rubric in the prompt, which is what makes a small model reliable', () => {
    for (const c of rubric.expected_concepts) {
      expect(prompt).toContain(c.id);
      expect(prompt).toContain(c.text);
    }
    expect(prompt).toContain('In the cytoplasm, no oxygen needed.');
  });

  it('asks for meaning over wording, so a synonym still earns credit', () => {
    expect(prompt).toMatch(/meaning, not the wording/i);
  });

  it('forbids reasoning in the output — none is stored or shown', () => {
    expect(prompt).toMatch(/do not\s+explain your reasoning/i);
  });
});
