import { supabase } from './supabase';
import { isValidAvatarValue, photoChoices, photoPath, photoValue } from '../core/avatar';
import { isMissingColumn } from '../core/db-errors';

/**
 * The user's own profile row. RLS restricts every one of these calls to the
 * signed-in user, so no query here filters by id in client code — the database
 * does it. That is deliberate: client-side filtering is not authorisation.
 */

export interface Profile {
  id: string;
  display_name: string | null;
  gemini_api_key: string | null;
  /** Which pet was chosen. NULL means "has not chosen"; the app defaults it. */
  pet: string | null;
  /**
   * The profile picture: NULL (a default face), 'face:N' or 'photo:<path>'.
   * See `src/core/avatar.ts` for what each means (migration 0016).
   */
  avatar: string | null;
  /** When the privacy notice was accepted (migration 0017). NULL: not yet. */
  privacy_accepted_at: string | null;
  created_at: string;
}

/** A profile picture was chosen before the database could store one. */
export class AvatarsUnavailableError extends Error {
  constructor() {
    super('Profile pictures are not switched on yet.');
    this.name = 'AvatarsUnavailableError';
  }
}

/**
 * The columns to ask for, newest migration first, and what it means when a
 * step is the first to work.
 */
const COLUMN_STEPS: readonly { columns: string; missing: string | null }[] = [
  { columns: 'id, display_name, gemini_api_key, pet, avatar, privacy_accepted_at, created_at', missing: null },
  {
    columns: 'id, display_name, gemini_api_key, pet, avatar, created_at',
    missing: '0017_privacy_notice.sql — the privacy notice is remembered on this device instead',
  },
  {
    columns: 'id, display_name, gemini_api_key, pet, created_at',
    missing: '0016_profile_pictures_and_nomi_chats.sql — everyone gets a default face',
  },
  {
    columns: 'id, display_name, gemini_api_key, created_at',
    missing: '0011_pet_choice.sql — everyone gets the default pet',
  },
];

const warnedMissing = new Set<string>();

/**
 * Fetch the signed-in user's profile, creating it if the trigger has not yet.
 *
 * ## Why this retries instead of just selecting the columns
 *
 * `fetchProfile` is not a screen's private query — Settings, the quiz's
 * grading, the assistant and the flashcard variant pass all read the API key
 * through it, and it throws on error. Naming a column that does not exist yet
 * would therefore not "break the avatar": it would break marking written
 * answers and making cards, everywhere, until the migration was applied.
 *
 * That is the failure §12 flagged for 0009 and §10 for 0007 — a build that
 * SELECTs a column the database has not got. So this asks for everything and,
 * on exactly the "no such column" error, steps back one migration at a time.
 * One query in the normal case; more only while a migration is outstanding,
 * and the console says which, once.
 */
export async function fetchProfile(): Promise<Profile | null> {
  let last = 'Could not read your profile.';
  for (const step of COLUMN_STEPS) {
    const { data, error } = await supabase.from('profiles').select(step.columns).maybeSingle();
    if (!error) {
      if (step.missing && !warnedMissing.has(step.missing)) {
        warnedMissing.add(step.missing);
        console.warn(`[profile] a column is missing. Apply supabase/migrations/${step.missing}.`);
      }
      if (!data) return null;
      return { pet: null, avatar: null, privacy_accepted_at: null, ...(data as unknown as object) } as Profile;
    }
    if (!isMissingColumn(error)) throw new Error(error.message);
    last = error.message;
  }
  throw new Error(last);
}

async function currentUserId(): Promise<string> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError) throw new Error(userError.message);
  const id = userData.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/**
 * Remember which pet the student picked.
 *
 * Upserts the same way `saveGeminiKey` does, so it works on the first save for
 * an account whose profile row the trigger has not created yet.
 */
export async function savePetChoice(pet: string): Promise<void> {
  const id = await currentUserId();
  const { error } = await supabase.from('profiles').upsert({ id, pet }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

/** Store or replace the user's Gemini key. Pass null to remove it. */
export async function saveGeminiKey(key: string | null): Promise<void> {
  const id = await currentUserId();
  const { error } = await supabase
    .from('profiles')
    .upsert({ id, gemini_api_key: key }, { onConflict: 'id' });

  if (error) throw new Error(error.message);
}

/**
 * The name Home greets them by. Trimmed; empty clears it.
 *
 * `display_name` has existed since 0001 and nothing ever set it, which is why
 * Home could not say "Welcome back, Sarah" (NOTES §36).
 */
export async function saveDisplayName(name: string): Promise<void> {
  const id = await currentUserId();
  const clean = name.trim().slice(0, 60);
  const { error } = await supabase
    .from('profiles')
    .upsert({ id, display_name: clean.length > 0 ? clean : null }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

/**
 * Choose a built-in face, or clear the choice with null.
 *
 * A missing `avatar` column arrives here as PGRST204, not 42703: an upsert body
 * is checked against PostgREST's schema cache before Postgres sees it. Checking
 * 42703 alone is why the owner was told "Couldn't save that picture just now.
 * Try again in a moment" for as long as migration 0016 was not applied — a
 * wait that could never work (NOTES §37).
 */
export async function saveAvatar(value: string | null): Promise<void> {
  if (!isValidAvatarValue(value)) throw new Error(`Not a profile picture: ${value}`);
  const id = await currentUserId();
  const { error } = await supabase.from('profiles').upsert({ id, avatar: value }, { onConflict: 'id' });
  if (isMissingColumn(error)) throw new AvatarsUnavailableError();
  if (error) throw new Error(error.message);
}

/**
 * Upload a profile photo and make it the picture.
 *
 * The caller hands over an already-resized image (`src/ui/avatar.tsx` draws it
 * to 256px first). Order matters: upload, then point the profile at it — so a
 * failure part-way leaves either the old picture or the new one showing, never
 * a profile pointing at nothing.
 *
 * The photo before it stays, as a choice beside the faces (NOTES §45); only
 * photos past `MAX_KEPT_PHOTOS` are removed, the oldest first.
 */
export async function uploadAvatarPhoto(image: Blob): Promise<string> {
  const id = await currentUserId();
  const path = photoPath(id, Date.now());

  const { error: uploadError } = await supabase.storage
    .from('avatars')
    .upload(path, image, { contentType: 'image/jpeg', upsert: false });
  if (uploadError) {
    if (/bucket not found/i.test(uploadError.message)) throw new AvatarsUnavailableError();
    throw new Error(uploadError.message);
  }

  const value = photoValue(path);
  await saveAvatar(value);

  // Best effort. A 30 KB picture over the limit is not worth failing a save over.
  const { data: files, error: listError } = await supabase.storage.from('avatars').list(id, { limit: 100 });
  const { remove } = photoChoices(id, (files ?? []).map((f) => f.name), value);
  if (listError) {
    console.warn(`[profile] could not list your pictures: ${listError.message}`);
  } else if (remove.length > 0) {
    const { error } = await supabase.storage.from('avatars').remove(remove);
    if (error) console.warn(`[profile] could not remove the oldest pictures: ${error.message}`);
  }
  return value;
}

/**
 * The photos this person has uploaded, newest first — offered beside the faces
 * (NOTES §45). Empty before the avatars bucket exists.
 */
export async function listAvatarPhotos(current: string | null): Promise<string[]> {
  const id = await currentUserId();
  const { data, error } = await supabase.storage.from('avatars').list(id, { limit: 100 });
  if (error) {
    if (/bucket not found/i.test(error.message)) return [];
    throw new Error(error.message);
  }
  return photoChoices(id, (data ?? []).map((f) => f.name), current).keep;
}

/** A short-lived link to a profile photo. The bucket is private. */
export async function avatarPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from('avatars').createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  return data.signedUrl;
}

/** Short-lived links to several photos in one request, by path. A photo with no link is left out. */
export async function avatarPhotoUrls(paths: readonly string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const { data, error } = await supabase.storage.from('avatars').createSignedUrls([...paths], 60 * 60);
  if (error || !data) return {};
  const links: Record<string, string> = {};
  for (const item of data) if (item.path && item.signedUrl && !item.error) links[item.path] = item.signedUrl;
  return links;
}

/** Every photo this user has uploaded — for Delete my data. Best effort. */
export async function removeAvatarPhotos(): Promise<void> {
  const id = await currentUserId();
  const { data, error } = await supabase.storage.from('avatars').list(id);
  if (error || !data || data.length === 0) return;
  await supabase.storage.from('avatars').remove(data.map((f) => `${id}/${f.name}`));
}

// ------------------------------------------------------------ privacy notice --

/**
 * Where the answer is kept on this device, before migration 0017 can keep it on
 * the account. Exported for `scripts/screenshot.ts`, which marks the notice
 * read for the test account so a probe of another screen is not a probe of the
 * notice covering it.
 */
export function privacyDeviceKey(userId: string): string {
  return `privacy-notice-accepted:${userId}`;
}

function deviceStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Has this person accepted the privacy notice — on their account, or on this device? */
export function hasAcceptedPrivacy(
  profile: Pick<Profile, 'privacy_accepted_at'> | null | undefined,
  userId: string,
): boolean {
  if (profile?.privacy_accepted_at) return true;
  return !!deviceStorage()?.getItem(privacyDeviceKey(userId));
}

/**
 * "I understand", recorded.
 *
 * On the account when migration 0017 exists, so the notice shows once across
 * a phone and a laptop. Before it, on this device, and said so — a notice that
 * reappeared on every launch because a column was missing would teach people
 * to tap past it, which is the opposite of what it is for.
 */
export async function acceptPrivacy(): Promise<'account' | 'device'> {
  const id = await currentUserId();
  const at = new Date().toISOString();
  const { error } = await supabase
    .from('profiles')
    .upsert({ id, privacy_accepted_at: at }, { onConflict: 'id' });
  if (!error) return 'account';
  if (!isMissingColumn(error)) throw new Error(error.message);

  console.warn(
    '[profile] no "privacy_accepted_at" column — remembering the privacy notice on this device. ' +
      'Apply supabase/migrations/0017_privacy_notice.sql to remember it on the account.',
  );
  deviceStorage()?.setItem(privacyDeviceKey(id), at);
  return 'device';
}
