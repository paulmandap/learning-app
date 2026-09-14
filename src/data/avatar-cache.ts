import {
  avatarCacheKey,
  MAX_CACHED_PHOTO_CHARS,
  readCachedAvatar,
  withAvatarValue,
  type CachedAvatar,
} from '../core/avatar';

/**
 * The profile picture, kept on this device (NOTES §40).
 *
 * The owner: *"everytime i load the app, my dp loads after the study tab finish
 * rendering … i think of something like cache?"* A photo took three round
 * trips before it appeared — the profile, a signed link, the picture itself —
 * and the default face stood in for about a second on every launch.
 *
 * So the last picture shown is kept in this browser's storage, as the value
 * the profile holds and, for a photo, the image itself as a data URL. A launch
 * draws that at once; the profile then confirms it or replaces it. Per person,
 * and removed on signing out and on Delete my data, so a shared phone does not
 * keep someone's photo after they have left.
 *
 * Best effort throughout: storage that is full, private or missing costs the
 * speed-up, never the picture.
 */

function storage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** What this device last showed for this person, or null. */
export function cachedAvatar(userId: string): CachedAvatar | null {
  if (!userId) return null;
  try {
    return readCachedAvatar(storage()?.getItem(avatarCacheKey(userId)) ?? null);
  } catch {
    return null;
  }
}

function keep(userId: string, entry: CachedAvatar): void {
  try {
    storage()?.setItem(avatarCacheKey(userId), JSON.stringify(entry));
  } catch (err) {
    console.warn(`[avatar] could not keep the picture on this device: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Record what the profile says the picture is. Drops a kept photo that is no longer the picture. */
export function rememberAvatarValue(userId: string, value: string | null): void {
  if (!userId) return;
  const current = cachedAvatar(userId);
  const next = withAvatarValue(current, value);
  if (current && current.value === next.value && current.photo === next.photo) return;
  keep(userId, next);
}

/**
 * Keep a photo's pixels, fetched once from its signed link.
 *
 * Returns the data URL, or null when it could not be kept — too large, not an
 * image, or the fetch failed. Nothing is shown from here; the next launch is
 * what uses it.
 */
export async function rememberAvatarPhoto(userId: string, path: string, url: string): Promise<string | null> {
  if (!userId || typeof FileReader === 'undefined') return null;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error ?? new Error('Could not read the picture.'));
      reader.readAsDataURL(blob);
    });
    if (!dataUrl.startsWith('data:image/') || dataUrl.length > MAX_CACHED_PHOTO_CHARS) return null;
    keep(userId, { value: `photo:${path}`, photo: { path, dataUrl } });
    return dataUrl;
  } catch (err) {
    console.warn(`[avatar] could not keep the photo on this device: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Remove this person's picture from the device — on signing out, and on Delete my data. */
export function forgetAvatar(userId: string): void {
  if (!userId) return;
  try {
    storage()?.removeItem(avatarCacheKey(userId));
  } catch {
    // Nothing kept, or nowhere to keep it: nothing to remove.
  }
}
