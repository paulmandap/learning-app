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
   * sees it. Was 'friends-2026-09-27' (§51), 'posts-2026-09-28' (§52) and
   * 'messages-2026-09-28' (§53), 'leaderboard-2026-09-28' (§54) and
   * 'rules-2026-09-28' (§55), 'groups-2026-09-28' (§58); sharing posts (§62) and
   * bios — more that other people see of you — are the seventh (§62).
   */
  id: 'sharing-2026-09-29',
  /** The Privacy Policy and Terms date this card announces. */
  changed: 'September 29, 2026',
  title: 'New: share posts, bios and search',
  body: "Share a post to your feed or send it to a friend — tap Share under it. Add a short bio in Edit profile on your Profile, and find people, sets and posts with the search at the top.",
  policy:
    'Our Privacy Policy and Terms of Use changed on September 29, 2026 to cover shared posts and bios, as well as friends, posts, messages, group chats, streaks, the community rules, blocking and reporting.',
} as const;

/** Where "seen" is remembered on this device, per person — a shared phone shows it to each. */
export function whatsNewKey(userId: string): string {
  return `nomi.whatsNew.${WHATS_NEW.id}.${userId}`;
}

/** True when the card announces the policy that is actually in force. */
export function whatsNewIsCurrent(): boolean {
  return WHATS_NEW.changed === EFFECTIVE_DATE;
}
