import { Platform } from 'react-native';

/**
 * Hand a link to the phone's own share menu, or copy it where there is none
 * (NOTES §57) — a post now, a profile in step four.
 *
 * The link is to a page inside Nomi, so whoever opens it signs in first, and
 * then sees it only if the rules let them: a friends-only post shared with a
 * stranger opens as "This post isn't here". Sharing a link grants nothing.
 *
 * Web only, like the app: `navigator.share` is the iPhone's share sheet in
 * Safari and an installed PWA. A desktop browser without it copies instead.
 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

export async function shareLink(title: string, path: string): Promise<ShareOutcome> {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return 'failed';
  const url = `${window.location.origin}${path}`;
  const nav = window.navigator as Navigator & { share?: (data: ShareData) => Promise<void> };

  if (typeof nav.share === 'function') {
    try {
      await nav.share({ title, url });
      return 'shared';
    } catch (err) {
      // Closing the share sheet rejects with AbortError: a choice, not a fault.
      if (err instanceof Error && err.name === 'AbortError') return 'cancelled';
      // Anything else (no user gesture, a browser that refuses) falls through
      // to copying, which still gets the link to them.
    }
  }

  try {
    await nav.clipboard.writeText(url);
    return 'copied';
  } catch (err) {
    console.warn(`[share] could not share or copy ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return 'failed';
  }
}

/**
 * Put words on the clipboard — a message's Copy (NOTES §72), now that holding a
 * bubble opens its menu instead of selecting its words. Whether it worked.
 */
export async function copyText(text: string): Promise<boolean> {
  if (Platform.OS !== 'web' || typeof window === 'undefined' || !window.navigator.clipboard) return false;
  try {
    await window.navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    console.warn(`[share] could not copy: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
