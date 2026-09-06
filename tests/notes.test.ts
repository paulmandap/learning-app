import { describe, expect, it } from 'vitest';
import {
  canMakeCards,
  describeSaved,
  MIN_WORDS_FOR_CARDS,
  noteTitle,
  notePreview,
  noteWordCount,
} from '../src/core/notes';

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('noteWordCount', () => {
  it('counts words the way a person would', () => {
    expect(noteWordCount('the mitochondrion is the powerhouse')).toBe(5);
  });

  it('is not fooled by whitespace', () => {
    expect(noteWordCount('   ')).toBe(0);
    expect(noteWordCount('')).toBe(0);
    expect(noteWordCount('one\n\n  two \t three  ')).toBe(3);
  });
});

describe('canMakeCards', () => {
  it('refuses a note too short to support a set', () => {
    // The failure this prevents arrives AFTER a model call, as an empty set,
    // with nothing on screen explaining why.
    expect(canMakeCards('')).toBe(false);
    expect(canMakeCards(words(MIN_WORDS_FOR_CARDS - 1))).toBe(false);
  });

  it('allows one at the threshold', () => {
    expect(canMakeCards(words(MIN_WORDS_FOR_CARDS))).toBe(true);
  });
});

describe('noteTitle', () => {
  it('uses the title when there is one', () => {
    expect(noteTitle({ title: 'Cardiac conduction', body: 'anything' })).toBe(
      'Cardiac conduction',
    );
  });

  it('falls back to the first line of the note', () => {
    // People write a heading as the first line and never touch the title
    // field. Without this the notebook fills up with "Untitled note".
    expect(noteTitle({ title: '', body: 'Photosynthesis\nlight reactions…' })).toBe(
      'Photosynthesis',
    );
  });

  it('skips blank lines at the top', () => {
    expect(noteTitle({ title: '   ', body: '\n\n  Krebs cycle\nmore' })).toBe('Krebs cycle');
  });

  it('shortens a first line that is really a paragraph', () => {
    const long = 'a'.repeat(200);
    const out = noteTitle({ title: '', body: long });
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith('…')).toBe(true);
  });

  it('has something to say about an empty note', () => {
    expect(noteTitle({ title: '', body: '' })).toBe('Untitled note');
    expect(noteTitle({ title: '', body: '\n  \n' })).toBe('Untitled note');
  });
});

describe('notePreview', () => {
  it('does not repeat the line already used as the title', () => {
    expect(notePreview({ title: '', body: 'Photosynthesis\nHappens in the chloroplast.' })).toBe(
      'Happens in the chloroplast.',
    );
  });

  it('shows the whole note when the title was typed separately', () => {
    expect(notePreview({ title: 'Bio', body: 'Photosynthesis\nIn the chloroplast.' })).toBe(
      'Photosynthesis In the chloroplast.',
    );
  });

  it('says so when there is nothing else', () => {
    expect(notePreview({ title: 'Bio', body: '' })).toBe('Empty');
    expect(notePreview({ title: '', body: 'Only a heading' })).toBe('Empty');
  });

  it('truncates long notes', () => {
    const out = notePreview({ title: 'x', body: 'y'.repeat(500) });
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('describeSaved', () => {
  const now = Date.UTC(2026, 8, 6, 12, 0, 0);

  it('says nothing before the first save', () => {
    expect(describeSaved(null, now)).toBeNull();
  });

  it('reassures immediately after a save', () => {
    expect(describeSaved(now, now)).toBe('Saved just now');
    expect(describeSaved(now - 30_000, now)).toBe('Saved just now');
  });

  it('counts minutes, then hours', () => {
    expect(describeSaved(now - 5 * 60_000, now)).toBe('Saved 5 minutes ago');
    expect(describeSaved(now - 60_000, now)).toBe('Saved 1 minute ago');
    expect(describeSaved(now - 2 * 3600_000, now)).toBe('Saved 2 hours ago');
  });

  it('never reports a negative age from a clock that drifted', () => {
    expect(describeSaved(now + 10_000, now)).toBe('Saved just now');
  });
});
