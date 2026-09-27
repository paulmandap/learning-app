import { EFFECTIVE_DATE } from './legal';

/**
 * The one-time "what's new" card on Home (NOTES §51).
 *
 * The Privacy Policy promises: *"If a change is significant, we'll let you know
 * in the app."* Friends, blocking and reporting are significant — for the first
 * time anybody signed in can find you by name and open your profile — and until
 * this card nothing in the app said so. A promise with nothing keeping it is a
 * wish (the rule `tests/legal.test.ts` exists for).
 *
 * `tests/social.test.ts` holds `changed` to `EFFECTIVE_DATE`, so the next
 * policy change cannot go out without somebody deciding what this card says.
 */
export const WHATS_NEW = {
  /**
   * Never reused: a new notice gets a new id, or nobody who saw the last one
   * sees it. Was 'friends-2026-09-27' (§51); posts are a second significant
   * change the next day (§52), so everybody who dismissed that one sees this.
   */
  id: 'posts-2026-09-28',
  /** The Privacy Policy and Terms date this card announces. */
  changed: 'September 28, 2026',
  title: 'New: friends and posts',
  body: 'Find friends on your Profile, and share a win, a photo, a set or your streak in Community. Friends see your posts unless you choose everyone. You can block or report anyone.',
  policy:
    'Our Privacy Policy and Terms of Use changed on September 28, 2026 to cover friends, posts, comments, blocking and reporting.',
} as const;

/** Where "seen" is remembered on this device, per person — a shared phone shows it to each. */
export function whatsNewKey(userId: string): string {
  return `nomi.whatsNew.${WHATS_NEW.id}.${userId}`;
}

/** True when the card announces the policy that is actually in force. */
export function whatsNewIsCurrent(): boolean {
  return WHATS_NEW.changed === EFFECTIVE_DATE;
}
