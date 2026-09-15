import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  avatarCacheKey,
  defaultFaceIndex,
  FACE_COUNT,
  FACE_PATTERN,
  faceValue,
  greetingName,
  isValidAvatarValue,
  MAX_CACHED_PHOTO_CHARS,
  MAX_KEPT_PHOTOS,
  parseAvatar,
  PHOTO_PATTERN,
  photoChoices,
  photoPath,
  photoValue,
  readCachedAvatar,
  withAvatarValue,
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

describe('uploaded photos stay as choices (NOTES §45)', () => {
  const uploads = (n: number) => Array.from({ length: n }, (_, i) => photoPath(USER, 1757750400000 + i * 1000).split('/')[1]!);
  const path = (i: number) => `${USER}/avatar-${1757750400000 + i * 1000}.jpg`;

  it('offers every upload, newest first, and removes none', () => {
    expect(photoChoices(USER, uploads(3), null)).toEqual({ keep: [path(2), path(1), path(0)], remove: [] });
  });

  it(`keeps ${MAX_KEPT_PHOTOS}, and removes the oldest past that`, () => {
    const { keep, remove } = photoChoices(USER, uploads(MAX_KEPT_PHOTOS + 2), null);
    expect(keep).toHaveLength(MAX_KEPT_PHOTOS);
    expect(keep[0]).toBe(path(MAX_KEPT_PHOTOS + 1));
    expect(remove).toEqual([path(1), path(0)]);
  });

  it('never removes the picture in use, however old', () => {
    const { keep, remove } = photoChoices(USER, uploads(MAX_KEPT_PHOTOS + 2), photoValue(path(0)));
    expect(keep).toHaveLength(MAX_KEPT_PHOTOS);
    expect(keep).toContain(path(0));
    expect(remove).toEqual([path(2), path(1)]);
  });

  it('leaves alone anything in the folder the app did not upload', () => {
    expect(photoChoices(USER, ['avatar-probe.jpg', '.emptyFolderPlaceholder', ...uploads(1)], null)).toEqual({
      keep: [path(0)],
      remove: [],
    });
  });

  it('every photo it offers is a value the database accepts', () => {
    for (const kept of photoChoices(USER, uploads(3), null).keep) expect(isValidAvatarValue(photoValue(kept))).toBe(true);
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
  it('greets by the whole name they gave, as they wrote it (NOTES §40)', () => {
    // Renamed from "Paul" to "Paul Christian", Home still said "Welcome back, Paul".
    expect(greetingName('Paul Christian')).toBe('Paul Christian');
    expect(greetingName('  Paul   Christian  ')).toBe('Paul Christian');
    expect(greetingName('  Paul  ')).toBe('Paul');
  });

  it('has no name to offer rather than inventing one', () => {
    expect(greetingName(null)).toBeNull();
    expect(greetingName('   ')).toBeNull();
  });
});

describe('the picture kept on this device (NOTES §40)', () => {
  const path = `${USER}/avatar-1757750400000.jpg`;
  const photo = `photo:${path}`;
  const dataUrl = 'data:image/jpeg;base64,/9j/4AAQSkZJRg';

  it('reads back what was kept', () => {
    expect(readCachedAvatar(JSON.stringify({ value: photo, photo: { path, dataUrl } }))).toEqual({
      value: photo,
      photo: { path, dataUrl },
    });
    expect(readCachedAvatar(JSON.stringify({ value: 'face:3', photo: null }))).toEqual({ value: 'face:3', photo: null });
    expect(readCachedAvatar(JSON.stringify({ value: null, photo: null }))).toEqual({ value: null, photo: null });
  });

  it('trusts nothing it cannot check — it decides what is drawn before the profile can say otherwise', () => {
    for (const raw of [null, '', 'not json', 'null', '42', JSON.stringify({ value: 'face:99' }), JSON.stringify({ value: 7 })]) {
      expect(readCachedAvatar(raw), String(raw)).toBeNull();
    }
    // Pixels for another photo, not an image, or too large: dropped. The value stays.
    expect(readCachedAvatar(JSON.stringify({ value: 'face:2', photo: { path, dataUrl } }))).toEqual({
      value: 'face:2',
      photo: null,
    });
    expect(readCachedAvatar(JSON.stringify({ value: photo, photo: { path, dataUrl: 'javascript:alert(1)' } }))?.photo).toBeNull();
    const huge = `data:image/jpeg;base64,${'A'.repeat(MAX_CACHED_PHOTO_CHARS)}`;
    expect(readCachedAvatar(JSON.stringify({ value: photo, photo: { path, dataUrl: huge } }))?.photo).toBeNull();
  });

  it('keeps pixels only while their photo is still the picture', () => {
    const kept = { value: photo, photo: { path, dataUrl } };
    expect(withAvatarValue(kept, photo)).toEqual(kept);
    expect(withAvatarValue(kept, 'face:1')).toEqual({ value: 'face:1', photo: null });
    expect(withAvatarValue(kept, `photo:${USER}/avatar-2.jpg`)).toEqual({ value: `photo:${USER}/avatar-2.jpg`, photo: null });
    expect(withAvatarValue(null, null)).toEqual({ value: null, photo: null });
  });

  it('is kept per person', () => {
    expect(avatarCacheKey(USER)).not.toBe(avatarCacheKey('9e8d7c6b-5a4f-4e3d-2c1b-0a9f8e7d6c5b'));
  });
});
