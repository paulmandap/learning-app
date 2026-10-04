import { EFFECTIVE_DATE } from './legal';
import type { IconName } from './icon-shapes';

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
export interface WhatsNew {
  /**
   * Never reused: a new notice gets a new id, or nobody who saw the last one
   * sees it. Was 'friends-2026-09-27' (§51), 'posts-2026-09-28' (§52) and
   * 'messages-2026-09-28' (§53), 'leaderboard-2026-09-28' (§54) and
   * 'rules-2026-09-28' (§55), 'groups-2026-09-28' (§58), 'sharing-2026-09-29'
   * (§62); the copy of the main screens kept on the device is the eighth (§71).
   */
  id: string;
  /** The Privacy Policy date this card announces. */
  changed: string;
  /** The picture at the top. */
  icon: IconName;
  title: string;
  body: string;
  policy: string;
}

export const WHATS_NEW: WhatsNew = {
  id: 'faster-2026-10-04',
  changed: 'October 4, 2026',
  icon: 'nomi',
  title: 'Nomi opens faster',
  body: 'Nomi now keeps a copy of your sets, notes and progress on this device, so they are there the moment you open it. Then it checks for anything new.',
  policy: 'Our Privacy Policy changed on October 4, 2026 to say what this copy holds, and that signing out removes it.',
};

/** Where "seen" is remembered on this device, per person — a shared phone shows it to each. */
export function whatsNewKey(userId: string): string {
  return `nomi.whatsNew.${WHATS_NEW.id}.${userId}`;
}

/** True when the card announces the policy that is actually in force. */
export function whatsNewIsCurrent(): boolean {
  return WHATS_NEW.changed === EFFECTIVE_DATE;
}
