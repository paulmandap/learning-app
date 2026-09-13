/**
 * Profile pictures: what `profiles.avatar` holds, and what to show for it.
 *
 * Pure. The column is one text value with three meanings, and every reader has
 * to agree on them — Home's corner, Settings' picker, Delete my data — so they
 * are decided once, here, and the database's own check constraint is tested
 * against this file so the two cannot drift (tests/avatar.test.ts reads the
 * migration).
 *
 *   NULL                        no choice yet: a default face, stable per person
 *   'face:7'                    one of the built-in faces
 *   'photo:<user id>/<file>'    an uploaded picture in the private avatars bucket
 */
import { AVATAR_FACES } from './palette';

export const FACE_COUNT = AVATAR_FACES.length;

export type AvatarChoice =
  | { kind: 'face'; index: number; chosen: boolean }
  | { kind: 'photo'; path: string };

/** The same patterns as `profiles_avatar_check` in migration 0016. */
export const FACE_PATTERN = /^face:[0-9]{1,2}$/;
export const PHOTO_PATTERN = /^photo:[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,80}$/;

export function isValidAvatarValue(value: string | null): boolean {
  if (value === null) return true;
  if (FACE_PATTERN.test(value)) return Number(value.slice(5)) < FACE_COUNT;
  return PHOTO_PATTERN.test(value);
}

/**
 * A default face that stays the same for a person without storing anything.
 *
 * A small string hash of the user id, so the face someone sees on their first
 * day is the face they see on their tenth, on every device, until they choose.
 * Random-per-load would give them a different stranger every morning.
 */
export function defaultFaceIndex(userId: string): number {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return hash % FACE_COUNT;
}

/** What to draw for a stored value. Anything unreadable falls back to the default face. */
export function parseAvatar(value: string | null | undefined, userId: string): AvatarChoice {
  if (value && isValidAvatarValue(value)) {
    if (value.startsWith('face:')) return { kind: 'face', index: Number(value.slice(5)), chosen: true };
    return { kind: 'photo', path: value.slice('photo:'.length) };
  }
  return { kind: 'face', index: defaultFaceIndex(userId), chosen: false };
}

export function faceValue(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= FACE_COUNT) {
    throw new Error(`No face ${index}; there are ${FACE_COUNT}.`);
  }
  return `face:${index}`;
}

/**
 * Where an uploaded picture goes, and the value that points at it.
 *
 * A new name per upload, not one fixed name: a signed URL for the old picture
 * can still be cached by the browser, and overwriting the same path would show
 * the previous photo for as long as that cache lives.
 */
export function photoPath(userId: string, now: number): string {
  return `${userId}/avatar-${now}.jpg`;
}

export function photoValue(path: string): string {
  const value = `photo:${path}`;
  if (!PHOTO_PATTERN.test(value)) throw new Error(`Not a valid picture path: ${path}`);
  return value;
}

/**
 * The name to greet someone by — "Welcome back, Sarah".
 *
 * The first word of the name they gave, because a full name in a greeting reads
 * like a letter from a bank. Null when there is no name, and the caller says
 * "Welcome back" alone rather than inventing one from an email address.
 */
export function greetingName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? '').trim().split(/\s+/)[0] ?? '';
  return first.length > 0 ? first.slice(0, 40) : null;
}
