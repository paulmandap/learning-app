import { describe, expect, it } from 'vitest';
import { formatSetTitle } from '../src/core/title';

describe('formatSetTitle', () => {
  it('turns a filename-derived title into something readable', () => {
    expect(formatSetTitle('animal_biology_study_reviewer')).toBe('Animal biology study reviewer');
  });

  it('drops a file extension', () => {
    expect(formatSetTitle('animal_biology_study_reviewer.pdf')).toBe(
      'Animal biology study reviewer',
    );
    expect(formatSetTitle('notes.PDF')).toBe('Notes');
    expect(formatSetTitle('scan.jpeg')).toBe('Scan');
  });

  it('handles hyphen separators too', () => {
    expect(formatSetTitle('cardiac-conduction-system')).toBe('Cardiac conduction system');
  });

  it('collapses runs of separators and whitespace', () => {
    expect(formatSetTitle('week__3   notes')).toBe('Week 3 notes');
  });

  it('leaves acronyms and proper nouns alone', () => {
    // Title Case would produce "Atp And The Krebs Cycle", which is worse than
    // doing nothing. Only the first character is ever changed.
    expect(formatSetTitle('ATP and the Krebs cycle')).toBe('ATP and the Krebs cycle');
    expect(formatSetTitle('DNA_replication')).toBe('DNA replication');
  });

  it('capitalises only the first letter, never the rest', () => {
    expect(formatSetTitle('the mitochondria')).toBe('The mitochondria');
  });

  it('leaves an already-clean title untouched', () => {
    expect(formatSetTitle('Cardiac Conduction')).toBe('Cardiac Conduction');
  });

  it('preserves a user-typed name with meaningful punctuation', () => {
    expect(formatSetTitle('Chapter 4: the heart')).toBe('Chapter 4: the heart');
  });

  it('does not strip a leading or trailing underscore, which is likely deliberate', () => {
    expect(formatSetTitle('_draft')).toBe('_draft');
  });

  it('trims surrounding whitespace', () => {
    expect(formatSetTitle('   spaced out   ')).toBe('Spaced out');
  });

  it('falls back to the raw value rather than returning nothing', () => {
    expect(formatSetTitle('')).toBe('');
    expect(formatSetTitle('   ')).toBe('');
    // An extension with no stem: stripping would leave an empty title, so the
    // original is kept rather than showing a blank row.
    expect(formatSetTitle('.pdf')).toBe('.pdf');
  });

  it('never returns leading or trailing whitespace', () => {
    for (const s of ['a_b', ' x ', 'notes.pdf', 'ATP', '_draft']) {
      expect(formatSetTitle(s)).toBe(formatSetTitle(s).trim());
    }
  });
});
