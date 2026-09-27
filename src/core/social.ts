/**
 * Usernames, friends, blocking and reporting — the parts that are decidable
 * without a database or a screen (NOTES §51).
 *
 * The owner: *"i think this app can have it's own social. sort of add friends,
 * there is a leaderboard among friends or ranking. being able to DM to a
 * friend."* And, asked whether it was for the five people using it now: *"it
 * must be able to scale just in case a friend shares this to another friend."*
 *
 * This is step one of five: who somebody is (a username), who their friends are,
 * and the two things that have to exist BEFORE a stranger can reach anyone —
 * blocking and reporting. Posts, messages between friends and the friends'
 * leaderboard come after, and each of them leans on what is here.
 *
 * Pure, like everything in `src/core/**`: no react-native, no expo-*, no
 * supabase. Every number and list below that the database also enforces is a
 * COPY of migration 0026, held to it by `tests/social.test.ts` — the database is
 * the authority, and these exist so a screen can say "that is taken" or "that is
 * too short" before a round trip rather than after one.
 */

// -------------------------------------------------------------- usernames --

/** Shortest username. Mirrors `profiles_username_check` (0026). */
export const USERNAME_MIN = 3;
/** Longest username. Mirrors `profiles_username_check` (0026). */
export const USERNAME_MAX = 20;

/**
 * Names nobody may take, because they would read as the app or its operator.
 *
 * Mirrors the `not in (…)` list in `profiles_username_check` (0026), in the same
 * order, so `tests/social.test.ts` can compare the two. A username of `nomi` or
 * `admin` beside a message saying "your account will be closed unless…" is the
 * shape of a scam, and on an app anyone can join it is only a matter of time.
 */
export const RESERVED_USERNAMES: readonly string[] = [
  'nomi',
  'admin',
  'administrator',
  'moderator',
  'mod',
  'staff',
  'support',
  'help',
  'official',
  'system',
  'root',
  'owner',
  'team',
  'everyone',
  'null',
  'undefined',
];

/**
 * What somebody typed, as it would be stored.
 *
 * People type the @ because that is how a username is written everywhere else,
 * and they type capitals because their phone does. Neither is a mistake worth
 * refusing: the stored form is lowercase with no @, so "@Paul_M" and "paul_m"
 * are one username and can never be two people.
 */
export function normalizeUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export type UsernameCheck = { ok: true; username: string } | { ok: false; reason: string };

/**
 * Is this a username the database will take?
 *
 * The same rule as `profiles_username_check`: 3 to 20 characters, lowercase
 * letters, numbers and _, starting with a letter. Starting with a letter is what
 * stops `_` and `2026` being usernames, and it keeps every one of them readable
 * as a name rather than a code.
 *
 * Whether it is TAKEN cannot be decided here — that is the unique index, and the
 * data layer turns its refusal into a sentence.
 */
export function validateUsername(raw: string): UsernameCheck {
  const username = normalizeUsername(raw);
  if (username.length === 0) return { ok: false, reason: 'Type a username first.' };
  if (username.length < USERNAME_MIN) {
    return { ok: false, reason: `A username needs at least ${USERNAME_MIN} letters or numbers.` };
  }
  if (username.length > USERNAME_MAX) {
    return { ok: false, reason: `Keep it to ${USERNAME_MAX} letters or numbers.` };
  }
  if (!/^[a-z]/.test(username)) return { ok: false, reason: 'Start it with a letter.' };
  if (!/^[a-z][a-z0-9_]*$/.test(username)) {
    return { ok: false, reason: 'Use only letters, numbers and _ — no spaces.' };
  }
  if (RESERVED_USERNAMES.includes(username)) {
    return { ok: false, reason: 'That one is kept for Nomi itself. Try another.' };
  }
  return { ok: true, username };
}

/**
 * A username to offer somebody who has not chosen one, made from their name.
 *
 * Only a suggestion in a placeholder — nothing is ever saved on anyone's behalf.
 * "Paul Christian Mandap" offers `paul_christian_manda`: accents are dropped rather
 * than refused (ñ becomes n), spaces become _, and anything that still would not
 * pass `validateUsername` is dropped, or the placeholder would suggest a name the
 * Save button then refuses.
 */
export function suggestUsername(name: string | null | undefined): string | null {
  const base = (name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^[^a-z]+/, '')
    .replace(/_+/g, '_')
    .slice(0, USERNAME_MAX)
    .replace(/_+$/, '');
  const check = validateUsername(base);
  return check.ok ? check.username : null;
}

/** "@paul_m", or null for somebody who has not chosen one. */
export function atUsername(username: string | null | undefined): string | null {
  return username ? `@${username}` : null;
}

// ----------------------------------------------------------------- search --

/** Fewest characters worth searching for. Mirrors `search_people` (0026). */
export const SEARCH_MIN = 2;

/**
 * What to search for, or null when there is not enough to search on yet.
 *
 * The @ is dropped for the same reason as in `normalizeUsername`: somebody
 * searching "@paul" means the person whose username starts with paul. One
 * letter is not searched at all — it matches most of the app, and on a list of
 * strangers that is a directory rather than a search.
 */
export function searchTerm(raw: string): string | null {
  const term = raw.trim().replace(/^@+/, '').toLowerCase();
  return term.length >= SEARCH_MIN ? term : null;
}

// ---------------------------------------------------------------- friends --

/** One row of `my_friends` (0026): a friendship or a request, seen from my side. */
export interface FriendLink {
  /** The friendship row's id — what "cancel", "decline" and "unfriend" delete. */
  id: string;
  /** The OTHER person. Never me. */
  person_id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  status: 'pending' | 'accepted';
  /** True when I sent the request; false when they did. */
  sent_by_me: boolean;
  created_at: string;
  accepted_at: string | null;
}

/**
 * Where I stand with one person.
 *
 * `self` exists because a person's page can be mine — tapping my own name in
 * the chat must not offer "Add friend". `blocked` is only ever MY block: whether
 * they blocked me is not something the app tells anybody, and the views simply
 * stop showing them.
 */
export type FriendState = 'self' | 'none' | 'sent' | 'received' | 'friends' | 'blocked';

export function friendState(
  me: string,
  them: string,
  links: readonly FriendLink[],
  blocked: ReadonlySet<string>,
): FriendState {
  if (me === them) return 'self';
  if (blocked.has(them)) return 'blocked';
  const link = links.find((l) => l.person_id === them);
  if (!link) return 'none';
  if (link.status === 'accepted') return 'friends';
  return link.sent_by_me ? 'sent' : 'received';
}

/** The name to sort and show by: their name, then their username, then "Someone". */
export function personName(p: { name: string | null; username: string | null }): string {
  const name = (p.name ?? '').trim();
  if (name.length > 0) return name;
  return p.username ? `@${p.username}` : 'Someone';
}

/**
 * My friends, the requests waiting for me, and the ones I sent — in the order
 * each is read.
 *
 * Friends alphabetically, because that list is looked things up in. Requests
 * newest first, because the one that arrived a minute ago is the one somebody
 * is looking for. Plain `<` rather than localeCompare, which sorts differently
 * depending on where it runs and would make this untestable (the same rule as
 * `rankSets`).
 */
export function splitFriends(links: readonly FriendLink[]): {
  friends: FriendLink[];
  received: FriendLink[];
  sent: FriendLink[];
} {
  const byName = (a: FriendLink, b: FriendLink) => {
    const an = personName(a).toLowerCase();
    const bn = personName(b).toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.person_id < b.person_id ? -1 : a.person_id > b.person_id ? 1 : 0;
  };
  const newest = (a: FriendLink, b: FriendLink) =>
    a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : a.id < b.id ? -1 : 1;

  return {
    friends: links.filter((l) => l.status === 'accepted').sort(byName),
    received: links.filter((l) => l.status === 'pending' && !l.sent_by_me).sort(newest),
    sent: links.filter((l) => l.status === 'pending' && l.sent_by_me).sort(newest),
  };
}

/** "1 friend" / "12 friends" / "No friends yet". */
export function friendCountLabel(count: number): string {
  if (count <= 0) return 'No friends yet';
  return `${count} friend${count === 1 ? '' : 's'}`;
}

/**
 * How many friend requests one person may send in a day. Mirrors
 * `send_friend_request` (0026).
 *
 * Generous for a person and useless for a script: fifty is more new friends
 * than anybody makes in a day, and far too few to request the whole app.
 */
export const FRIEND_REQUESTS_PER_DAY = 50;

// --------------------------------------------------------------- blocking --

/**
 * What blocking does, told BEFORE it is done — in the same spirit as
 * `SHARING_FACTS`, and held to migration 0026 the same way.
 *
 * The last line is the one people get wrong in both directions: they are not
 * told, and they may still work it out. Promising a block is invisible would be
 * a promise the app cannot keep — the person you blocked will notice you have
 * vanished from search.
 */
export function blockFacts(name: string): string[] {
  return [
    `${name} won't be able to find you, see your profile or your shared sets, or send you a friend request.`,
    `You won't see each other's messages in the chat.`,
    `If you're friends, you won't be any more.`,
    `They aren't told, but they may notice. You can unblock them from your Profile.`,
  ];
}

// -------------------------------------------------------------- reporting --

/**
 * What can be reported. Mirrors `reports_kind_check` — 0026's three, and the
 * post and comment 0027 added (NOTES §52).
 */
export const REPORT_KINDS = ['person', 'message', 'set', 'post', 'comment'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/**
 * Why, in the reporter's words. The keys mirror `reports_reason_check` (0026).
 *
 * `wrong` is for a shared set only. It is the one reason that is about
 * accuracy rather than behaviour, and it closes the gap NOTES §46.5 named:
 * "Report this card" could not be offered on a shared set, and D7 says a report
 * IS the second check on a card. A wrong set now has somewhere to go.
 */
export const REPORT_REASONS = [
  { key: 'spam', label: 'Spam' },
  { key: 'harassment', label: 'Bullying or harassment' },
  { key: 'hate', label: 'Hate or threats' },
  { key: 'sexual', label: 'Sexual or violent content' },
  { key: 'personal_info', label: "Someone's private information" },
  { key: 'impersonation', label: 'Pretending to be someone else' },
  { key: 'wrong', label: 'Wrong or misleading cards' },
  { key: 'other', label: 'Something else' },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]['key'];

/** The reasons worth offering for this kind of thing. */
export function reasonsFor(kind: ReportKind): (typeof REPORT_REASONS)[number][] {
  return REPORT_REASONS.filter((r) => {
    if (r.key === 'wrong') return kind === 'set';
    if (r.key === 'impersonation') return kind === 'person';
    return true;
  });
}

/** Longest "anything else to add?". Mirrors `reports_details_check` (0026). */
export const REPORT_DETAILS_MAX = 500;

/** How many reports one person may send in a day. Mirrors `report_content` (0026). */
export const REPORTS_PER_DAY = 20;

/** "Report Paul", "Report this message", "Report this set", "Report this post". */
export function reportTitle(kind: ReportKind, name?: string): string {
  if (kind === 'person') return name ? `Report ${name}` : 'Report this person';
  return `Report this ${kind}`;
}

/**
 * What the reporter is told once it has gone.
 *
 * Says who reads it, because "we'll look into it" from an app with no visible
 * people behind it reads as "nobody will". And says what they are not told,
 * which is the question every reporter has and never asks.
 */
export const REPORT_SENT =
  "Thanks for telling us. The person who runs Nomi reads every report. They won't be told it was you.";
