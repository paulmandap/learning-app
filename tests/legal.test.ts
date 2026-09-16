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
    for (const table of ['nomi_conversations', 'notes', 'study_days', 'chat_usage', 'push_subscriptions', 'reminder_settings']) {
      expect(sets, table).toContain(`'${table}'`);
    }
    expect(sets).toContain('removeAvatarPhotos(');
    expect(text(PRIVACY_POLICY)).toMatch(/does not remove your account itself/);
    expect(text(PRIVACY_POLICY)).toMatch(/Delete my data removes[^.]*your reminders/);

    // And the part four other people can still read. Promising to remove the
    // stars, the messages and the sharing is only true if something does it —
    // deleting every set of mine leaves all three behind, because a star is a
    // row about somebody ELSE's set and a message belongs to no set at all.
    expect(sets).toContain('removeMyCommunityData(');
    const community = readFileSync('src/data/community.ts', 'utf8');
    for (const table of ['set_stars', 'global_messages']) {
      expect(community, table).toContain(`'${table}'`);
    }
    expect(community).toMatch(/update\(\{ visibility: 'private' \}\)/);
    expect(text(PRIVACY_POLICY)).toMatch(/Delete my data removes[^.]*the stars you gave/);
    expect(text(PRIVACY_POLICY)).toMatch(/stops sharing every set you shared/);
  });

  it('tell people what the others can see, and it matches what the app shows them', () => {
    const privacy = text(PRIVACY_POLICY);
    const migration = readFileSync('supabase/migrations/0021_community.sql', 'utf8');

    // The three things that leave the account, each named.
    expect(privacy).toMatch(/What other people can see/);
    expect(privacy).toMatch(/Sets are private until you share one/);
    expect(privacy).toMatch(/one room that everyone signed in shares/);

    // The excerpt. It is the half people assume wrongly, and the set screen says
    // it too — src/core/community.ts SHARING_FACTS, held to the views there.
    expect(privacy).toMatch(/the bit of your notes each card came from/);

    // The picture. 0021 hid uploaded photos from everyone; 0023 shows them, at
    // the owner's request, but only the one that person is USING — the bucket
    // keeps their last few uploads as choices and those stay private. The
    // policy is what makes that true, so the policy is what is checked.
    const pictures = readFileSync(
      'supabase/migrations/0023_shared_profile_pictures.sql',
      'utf8',
    );
    expect(privacy).toMatch(/the picture you are using/);
    expect(privacy).toMatch(/the ones you are not using stay private/);
    expect(pictures).toContain("where p.avatar = 'photo:' || object_name");
    // And nothing about it reaches the open internet, as the policy says.
    expect(privacy).toMatch(/never on the open internet/);
    expect(pictures).not.toMatch(/public\s*=\s*true/);

    // Stars counted, never named: set_stars is select-own and the count is
    // computed inside the view.
    expect(privacy).toMatch(/nobody can see who gave one/);
    expect(migration).toContain('create policy set_stars_select_own');

    // What is NOT published. public_set_items names study_items columns only.
    expect(privacy).toMatch(/do not see the files you uploaded, your notes, your other sets/);
  });

  it('say in the Terms what may not be shared or sent', () => {
    const terms = text(TERMS_OF_USE);
    expect(terms).toMatch(/Sharing sets, and the chat/);
    expect(terms).toMatch(/harasses, bullies, threatens or impersonates/);
    expect(terms).toMatch(/share other people's personal information/);
    // A rule nobody can enforce is a wish. Both documents say we can remove it.
    expect(terms).toMatch(/We can remove a shared set or a message/);
    expect(text(PRIVACY_POLICY)).toMatch(/We can remove a shared set or a message/);
  });

  it('say who delivers reminders, and what a reminder tells them (NOTES §45)', () => {
    expect(text(PRIVACY_POLICY)).toMatch(/Apple or Google[^.]*reminders/);
    expect(text(PRIVACY_POLICY)).toMatch(/how many cards are due/);
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
