import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_DAYS,
  CONTACT_EMAIL,
  MINIMUM_AGE,
  PRIVACY_POLICY,
  TERMS_OF_USE,
  type LegalDocument,
} from '../src/core/legal';

/**
 * The Terms of Use and the Privacy Policy (NOTES §40).
 *
 * A policy that says the app does something it does not is worse than no
 * policy, so what can be checked against the app is checked here: what Delete
 * my data removes, how long backups are kept, and the age Google requires.
 */

const text = (doc: LegalDocument) =>
  [doc.title, doc.intro, ...doc.sections.flatMap((s) => [s.heading, ...s.body.flat()])].join('\n');

describe('the Terms of Use and the Privacy Policy', () => {
  it('are two documents, each dated, in sections, with a way to reach us', () => {
    for (const doc of [TERMS_OF_USE, PRIVACY_POLICY]) {
      expect(doc.sections.length, doc.title).toBeGreaterThan(8);
      expect(doc.effective).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
      expect(text(doc)).toContain(CONTACT_EMAIL);
      for (const section of doc.sections) expect(section.body.length, section.heading).toBeGreaterThan(0);
    }
    expect(TERMS_OF_USE.title).not.toBe(PRIVACY_POLICY.title);
  });

  it("set the age at 18 in both, because Google's Gemini terms require it", () => {
    expect(MINIMUM_AGE).toBe(18);
    for (const doc of [TERMS_OF_USE, PRIVACY_POLICY]) expect(text(doc)).toMatch(/18 or older/);
  });

  it('say plainly that a person at Google may read what is sent — the sentence D13 exists for', () => {
    expect(text(PRIVACY_POLICY)).toMatch(/human reviewers at Google may read/);
  });

  it('name the law, the regulator and the courts', () => {
    expect(text(PRIVACY_POLICY)).toMatch(/Data Privacy Act of 2012/);
    expect(text(PRIVACY_POLICY)).toMatch(/National Privacy Commission/);
    expect(text(TERMS_OF_USE)).toMatch(/laws of the Republic of the Philippines/);
  });

  it('describe Delete my data the way the code does it', () => {
    const sets = readFileSync('src/data/sets.ts', 'utf8');
    for (const table of ['nomi_conversations', 'notes', 'study_days', 'chat_usage']) {
      expect(sets, table).toContain(`'${table}'`);
    }
    expect(sets).toContain('removeAvatarPhotos(');
    expect(text(PRIVACY_POLICY)).toMatch(/does not remove your account itself/);
  });

  it('give the backup the days the backup workflow keeps it', () => {
    const workflow = readFileSync('.github/workflows/backup.yml', 'utf8');
    expect(workflow).toContain(`retention-days: ${BACKUP_DAYS}`);
    expect(text(PRIVACY_POLICY)).toContain(`${BACKUP_DAYS} days`);
    expect(text(TERMS_OF_USE)).toContain(`${BACKUP_DAYS} days`);
  });

  it('use none of the words a student should never have to read', () => {
    for (const doc of [TERMS_OF_USE, PRIVACY_POLICY]) {
      expect(text(doc)).not.toMatch(/\b(OCR|pipeline|chunks?|tokens?|embeddings?|bytes|cloze|prompts?|model)\b/i);
    }
  });
});
