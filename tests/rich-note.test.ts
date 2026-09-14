import { describe, expect, it } from 'vitest';
import {
  docToText,
  emptyDoc,
  forStorage,
  imagePaths,
  isRichDoc,
  noteImagePath,
  textToDoc,
  withImageSources,
  type RichDoc,
  type RichNode,
} from '../src/core/rich-note';
import { notePreview, noteTitle } from '../src/core/notes';

/**
 * Rich notes (NOTES §43): what the editor saves, and the plain text that cards,
 * previews and word counts go on reading.
 */

const text = (t: string, marks?: string[]): RichNode => ({ type: 'text', text: t, ...(marks ? { marks: marks.map((type) => ({ type })) } : {}) });
const p = (...content: RichNode[]): RichNode => ({ type: 'paragraph', content });

const doc: RichDoc = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1 }, content: [text('Cell Biology')] },
    p(text('The cell is the '), text('basic unit', ['bold']), text(' of life.')),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [p(text('Nucleus holds DNA'))] },
        {
          type: 'listItem',
          content: [
            p(text('Organelles')),
            { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('Mitochondria make ATP'))] }] },
          ],
        },
      ],
    },
    { type: 'orderedList', attrs: { start: 1 }, content: [{ type: 'listItem', content: [p(text('Prophase'))] }, { type: 'listItem', content: [p(text('Metaphase'))] }] },
    { type: 'image', attrs: { path: 'u/n/image-1.jpg', src: 'https://signed.example/1' } },
    { type: 'blockquote', content: [p(text('Omnis cellula e cellula'))] },
    p(text('Line one'), { type: 'hardBreak' }, text('line two')),
  ],
};

describe("a note's name and preview leave out the marks the editor writes", () => {
  it('lists a note that starts with a heading by the heading, not "# Heading"', () => {
    // Found in the built app: the Notes list and the set name on Make cards
    // both read "# Photosynthesis NB-6630".
    const body = docToText(textToDoc('# Photosynthesis\n- light\n- water'));
    expect(noteTitle({ title: '', body })).toBe('Photosynthesis');
    expect(notePreview({ title: '', body })).toBe('light water');
  });

  it('reads quotes and numbered lines as their words, and leaves plain lines alone', () => {
    expect(noteTitle({ title: '', body: '> Omnis cellula\nrest' })).toBe('Omnis cellula');
    expect(noteTitle({ title: '', body: '1. Prophase' })).toBe('Prophase');
    expect(noteTitle({ title: '', body: '#\n\nThe real first line' })).toBe('The real first line');
    expect(noteTitle({ title: '', body: '3.14 is roughly pi' })).toBe('3.14 is roughly pi');
    expect(noteTitle({ title: '', body: '*emphasis* first' })).toBe('*emphasis* first');
  });
});

describe('docToText — the note as the card-maker reads it', () => {
  it('writes headings and lists in the shapes the planner already counts', () => {
    expect(docToText(doc)).toBe(
      [
        '# Cell Biology',
        'The cell is the basic unit of life.',
        '- Nucleus holds DNA',
        '- Organelles',
        '  - Mitochondria make ATP',
        '1. Prophase',
        '2. Metaphase',
        '> Omnis cellula e cellula',
        'Line one',
        'line two',
      ].join('\n'),
    );
  });

  it('keeps no trace of a picture — its pixels are read separately, not its link', () => {
    expect(docToText(doc)).not.toMatch(/image-1|signed\.example/);
  });

  it('is empty for an empty note', () => {
    expect(docToText(emptyDoc())).toBe('');
  });
});

describe('textToDoc — a note from before the editor', () => {
  it('opens typed bullets, numbers and headings as the real thing', () => {
    const body = '# Photosynthesis\nPlants make sugar.\n- light\n- water\n1. Absorb\n2. Convert';
    const opened = textToDoc(body);
    expect(opened.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList']);
    expect(docToText(opened)).toBe(body);
  });

  it('loses nothing a person typed', () => {
    const body = 'Plain line\n\nAnother after a gap\n* star bullet\n• dot bullet\n3) third';
    expect(docToText(textToDoc(body))).toBe('Plain line\n\nAnother after a gap\n- star bullet\n- dot bullet\n3. third');
  });

  it('never makes an empty document', () => {
    expect(textToDoc('')).toEqual(emptyDoc());
    expect(textToDoc('\n\n\n')).toEqual(emptyDoc());
  });
});

describe('pictures', () => {
  it('lists each stored picture once', () => {
    const twice: RichDoc = { type: 'doc', content: [...doc.content, { type: 'image', attrs: { path: 'u/n/image-1.jpg' } }] };
    expect(imagePaths(twice)).toEqual(['u/n/image-1.jpg']);
  });

  it('saves a picture by its path, never its expiring link, and drops one never uploaded', () => {
    const withLoose: RichDoc = { type: 'doc', content: [...doc.content, { type: 'image', attrs: { src: 'blob:local' } }] };
    const saved = JSON.stringify(forStorage(withLoose));
    expect(saved).toContain('"path":"u/n/image-1.jpg"');
    expect(saved).not.toMatch(/signed\.example|blob:local/);
  });

  it('shows a picture with a fresh link, and a missing one as empty rather than a stale one', () => {
    const shown = withImageSources(forStorage(doc), { 'u/n/image-1.jpg': 'https://fresh.example/1' });
    expect(JSON.stringify(shown)).toContain('https://fresh.example/1');
    expect(JSON.stringify(withImageSources(forStorage(doc), {}))).toContain('"src":""');
  });

  it("keeps each picture in its owner's folder, as the bucket's policies require", () => {
    expect(noteImagePath('user-1', 'note-2', 1757750400000)).toBe('user-1/note-2/image-1757750400000.jpg');
  });

  it('recognises a stored document, and nothing else', () => {
    expect(isRichDoc(doc)).toBe(true);
    for (const bad of [null, 'doc', { type: 'doc' }, { type: 'paragraph', content: [] }]) expect(isRichDoc(bad)).toBe(false);
  });
});
