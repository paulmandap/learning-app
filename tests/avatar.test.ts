import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  defaultFaceIndex,
  FACE_COUNT,
  FACE_PATTERN,
  faceValue,
  greetingName,
  isValidAvatarValue,
  parseAvatar,
  PHOTO_PATTERN,
  photoPath,
  photoValue,
} from '../src/core/avatar';
import { AVATAR_FACES } from '../src/core/palette';
import { contrastHex } from '../src/core/color';

const USER = '4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('what profiles.avatar means', () => {
  it('no choice gives a default face, the same one every time for the same person', () => {
    const a = parseAvatar(null, USER);
    const b = parseAvatar(undefined, USER);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ kind: 'face', chosen: false });
  });

  it('spreads default faces across people rather than giving everyone the first', () => {
    const seen = new Set(
      Array.from({ length: 60 }, (_, i) => defaultFaceIndex(`user-${i}-${i * 7919}`)),
    );
    expect(seen.size).toBeGreaterThan(FACE_COUNT / 2);
  });

  it('reads a chosen face and a photo', () => {
    expect(parseAvatar('face:3', USER)).toEqual({ kind: 'face', index: 3, chosen: true });
    expect(parseAvatar(`photo:${USER}/avatar-1.jpg`, USER)).toEqual({
      kind: 'photo',
      path: `${USER}/avatar-1.jpg`,
    });
  });

  it('falls back to the default face for anything it cannot read, never to nothing', () => {
    for (const bad of ['face:99', 'face:', 'photo:../../etc/passwd', 'emoji:cat', '']) {
      expect(parseAvatar(bad, USER)).toMatchObject({ kind: 'face', chosen: false });
    }
  });

  it('builds only values the database will accept', () => {
    expect(isValidAvatarValue(faceValue(FACE_COUNT - 1))).toBe(true);
    expect(isValidAvatarValue(photoValue(photoPath(USER, 1757750400000)))).toBe(true);
    expect(() => faceValue(FACE_COUNT)).toThrow();
    expect(() => photoValue('not-a-user/../x.jpg')).toThrow();
  });
});

describe('the app and the database agree', () => {
  /**
   * The check constraint in 0016 and the patterns here are two copies of one
   * rule. Reading the migration keeps them one: a pattern changed in either
   * place without the other fails here, instead of as a save the database
   * refuses in front of a student.
   */
  const sql = readFileSync('supabase/migrations/0016_profile_pictures_and_nomi_chats.sql', 'utf8');

  it('the face pattern is the one in the constraint', () => {
    expect(sql).toContain(`avatar ~ '${FACE_PATTERN.source}'`);
  });

  it('the photo pattern is the one in the constraint', () => {
    expect(sql).toContain(`avatar ~ '${PHOTO_PATTERN.source.replace(/\\\//g, '/')}'`);
  });
});

describe('the faces themselves', () => {
  it('has twelve, and every face can be seen — features at the text contrast floor', () => {
    expect(AVATAR_FACES).toHaveLength(12);
    for (const face of AVATAR_FACES) {
      expect(contrastHex(face.ink, face.bg)).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('greetingName', () => {
  it('greets by first name', () => {
    expect(greetingName('Sarah Connor')).toBe('Sarah');
    expect(greetingName('  Paul  ')).toBe('Paul');
  });

  it('has no name to offer rather than inventing one', () => {
    expect(greetingName(null)).toBeNull();
    expect(greetingName('   ')).toBeNull();
  });
});
