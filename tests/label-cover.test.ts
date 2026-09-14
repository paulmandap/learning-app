import { describe, expect, it } from 'vitest';
import {
  coverRects,
  isStoredLabels,
  parseLabelBoxes,
  placePicture,
  type LabelBox,
} from '../src/core/label-cover';

/**
 * Covering the answer on a card's picture (NOTES §44). The owner's report: the
 * picture on a card showed its answer, "it's not censored".
 */

const label = (text: string, box: [number, number, number, number] = [100, 100, 150, 300]): LabelBox => ({ text, box });

/** The owner's figure: the arithmetic logic unit, as Gemini returned it in the measurement. */
const ALU: LabelBox[] = [
  label('Status Register', [150, 320, 210, 470]),
  label('Binary Adder', [600, 330, 650, 450]),
  label('Shifter', [620, 70, 670, 140]),
  label('Temporary', [540, 630, 590, 740]),
  label('Accumulator', [710, 620, 760, 750]),
  label('Internal\nCPU\nBus', [360, 900, 540, 960]),
];

describe('placePicture — a picture never shows its answer', () => {
  it("covers exactly the answer on the owner's two cards", () => {
    const bus = placePicture({
      question:
        'When designing an internal processor pathway to connect registers like the Shifter and Status Register, what component should be utilized?',
      answer: 'An Internal CPU Bus should be used to connect the related registers.',
      labels: ALU,
    });
    expect(bus.side).toBe('question');
    expect(bus.covers.map((c) => c.text)).toEqual(['Internal\nCPU\nBus']);

    const accumulator = placePicture({
      question:
        'Which register related to the internal CPU bus is explicitly listed alongside the Status Register and Temporary register?',
      answer: 'Accumulator',
      labels: ALU,
    });
    expect(accumulator.side).toBe('question');
    expect(accumulator.covers.map((c) => c.text)).toEqual(['Accumulator']);
  });

  it('puts the picture with the answer when no one has said where its labels are', () => {
    expect(placePicture({ question: 'Which register holds the result?', answer: 'Accumulator', labels: null })).toEqual({
      side: 'answer',
      covers: [],
    });
  });

  it('leaves the picture with the question, uncovered, when the answer is not on it', () => {
    expect(
      placePicture({
        question: 'Why does a processor need an arithmetic logic unit?',
        answer: 'To do calculations and comparisons',
        labels: ALU,
      }),
    ).toEqual({ side: 'question', covers: [] });
  });

  it('covers a label that holds the answer inside it', () => {
    const cell = [label('Mitochondrion: releases energy as ATP'), label('Nucleus: holds the DNA')];
    const placed = placePicture({ question: 'What form does the mitochondrion release energy in?', answer: 'ATP', labels: cell });
    expect(placed.covers.map((c) => c.text)).toEqual(['Mitochondrion: releases energy as ATP']);
  });

  it('finds a label written in a different form of the answer word', () => {
    const placed = placePicture({ question: 'Which register holds data for a short while?', answer: 'The register used temporarily', labels: ALU });
    expect(placed.covers.map((c) => c.text)).toEqual(['Temporary']);
  });

  it('keeps visible a label the question names', () => {
    const placed = placePicture({ question: 'What does the Binary Adder send its result to?', answer: 'The Status Register', labels: ALU });
    expect(placed.covers.map((c) => c.text)).toEqual(['Status Register']);
  });

  it('puts the picture with the answer when covering would blank out most of it', () => {
    const placed = placePicture({
      question: 'Name the parts shown in the figure.',
      answer: 'Status Register, Binary Adder, Shifter, Temporary, Accumulator and the Internal CPU Bus',
      labels: ALU,
    });
    expect(placed).toEqual({ side: 'answer', covers: [] });
  });
});

describe('parseLabelBoxes — positions checked before they are trusted', () => {
  it('reads the labels Gemini returns', () => {
    expect(parseLabelBoxes({ labels: [{ text: ' Nucleus ', box_2d: [10, 20, 30, 40] }] })).toEqual([
      { text: 'Nucleus', box: [10, 20, 30, 40] },
    ]);
  });

  it('drops a malformed entry and keeps the rest', () => {
    expect(
      parseLabelBoxes({
        labels: [
          { text: 'Good', box_2d: [100, 100, 200, 300] },
          { text: '', box_2d: [100, 100, 200, 300] },
          { text: 'Three numbers', box_2d: [1, 2, 3] },
          { text: 'Upside down', box_2d: [300, 100, 200, 300] },
          { text: 'A hair over', box_2d: [990, 900, 1003, 1000] },
        ],
      }),
    ).toEqual([
      { text: 'Good', box: [100, 100, 200, 300] },
      { text: 'A hair over', box: [990, 900, 1000, 1000] },
    ]);
  });

  it('refuses a reply in fractions or in pixels rather than guessing its units', () => {
    expect(parseLabelBoxes({ labels: [{ text: 'A', box_2d: [0.1, 0.2, 0.3, 0.4] }] })).toBeNull();
    expect(parseLabelBoxes({ labels: [{ text: 'A', box_2d: [120, 300, 1500, 2400] }] })).toBeNull();
    expect(parseLabelBoxes('nonsense')).toBeNull();
  });

  it('accepts a picture with no labels at all', () => {
    expect(parseLabelBoxes({ labels: [] })).toEqual([]);
  });

  it('recognises what is stored on a document', () => {
    expect(isStoredLabels({ model: 'gemini-3.6-flash', labels: [{ text: 'Bus', box: [1, 2, 3, 4] }] })).toBe(true);
    expect(isStoredLabels({ labels: [] })).toBe(false);
    expect(isStoredLabels(null)).toBe(false);
  });
});

describe('coverRects — where a cover is drawn', () => {
  const area = { left: 10, top: 20, width: 500, height: 300 };

  it('covers the whole label with room to spare', () => {
    const [rect] = coverRects([label('Bus', [100, 200, 150, 400])], area);
    // The label itself: x 110..210, y 50..65.
    expect(rect!.left).toBeLessThan(110);
    expect(rect!.top).toBeLessThan(50);
    expect(rect!.left + rect!.width).toBeGreaterThan(210);
    expect(rect!.top + rect!.height).toBeGreaterThan(65);
  });

  it('stays inside the picture at its edges', () => {
    const [rect] = coverRects([label('Corner', [0, 0, 50, 100])], area);
    expect(rect!.left).toBe(area.left);
    expect(rect!.top).toBe(area.top);
  });
});
