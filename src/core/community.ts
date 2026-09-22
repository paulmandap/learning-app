/**
 * Sets shared with everyone, stars, the ranking, and the global chat — the
 * parts that are decidable without a database or a screen.
 *
 * Pure, like everything in `src/core/**`: no react-native, no expo-*, no
 * supabase. That is what lets `scripts/community-probe.ts` drive the real rules
 * from Node and what lets every line below be tested without a network.
 *
 * ## The one rule worth stating twice
 *
 * The numbers in here — how long a message may be, how many may be sent in a
 * minute — are DUPLICATES of constraints the database enforces in migration
 * 0021. That duplication is deliberate and it is one-directional: the database
 * is the authority and these exist only so a screen can say "that is too long"
 * before a round trip rather than after one. `tests/community.test.ts` reads the
 * migration and fails if the two ever disagree, the same way `tests/avatar.test.ts`
 * holds `profiles_avatar_check` to `src/core/avatar.ts`.
 */

/** Longest message the chat accepts. Mirrors `global_messages_body_check` (0021). */
export const MESSAGE_MAX_LENGTH = 1000;

/** How many messages one person may send in a minute. Mirrors `send_global_message` (0021). */
export const MESSAGE_RATE_PER_MINUTE = 10;

/** What a set's visibility can be. Mirrors `study_sets_visibility_check` (0021). */
export type Visibility = 'private' | 'public';

/** A row of `public_sets` (0021). Shared, so nothing here is the owner's alone. */
export interface PublicSet {
  id: string;
  owner_id: string;
  /** Null when the owner has never chosen a name, or has no profile row at all. */
  owner_name: string | null;
  /** 'face:N' or 'photo:<user id>/<file>' — the picture they are using (0023). */
  owner_avatar: string | null;
  title: string;
  published_at: string | null;
  updated_at: string;
  stars: number;
  cards: number;
}

/** A row of `global_chat` (0021, plus `edited_at` in 0025). */
export interface ChatMessage {
  id: string;
  author_id: string;
  author_name: string | null;
  author_avatar: string | null;
  body: string;
  created_at: string;
  /** When it was last edited, or null. Null before 0025, which reads the same. */
  edited_at?: string | null;
}

/**
 * How long after sending a message may still be edited (NOTES §48).
 *
 * The owner: *"we should implement that 'Edit' message too, but only within 20
 * minutes of sending."* Mirrors `message_edit_window()` in migration 0025,
 * which is the authority — this only decides whether to OFFER the option, so a
 * screen never shows a control the database is about to refuse.
 */
export const EDIT_WINDOW_MINUTES = 20;

/**
 * Can this message still be edited?
 *
 * Yours, and inside the window. Both are checked again by
 * `edit_global_message`, which is where it actually matters; this exists so the
 * menu does not offer Edit on a message that is twenty-one minutes old.
 */
export function canEdit(
  message: Pick<ChatMessage, 'author_id' | 'created_at'>,
  myUserId: string,
  now: number,
): boolean {
  if (message.author_id !== myUserId) return false;
  const age = now - Date.parse(message.created_at);
  return age >= 0 && age < EDIT_WINDOW_MINUTES * 60 * 1000;
}

/** "edited" beside the time, or nothing. The mark is what makes editing honest. */
export function editedLabel(message: Pick<ChatMessage, 'edited_at'>): string | null {
  return message.edited_at ? 'edited' : null;
}

/** A public set with its place in the ranking. */
export interface RankedSet extends PublicSet {
  /** 1-based. Sets on equal stars share a rank, and the next one skips. */
  rank: number;
}

// ---------------------------------------------------------------- identity --

/**
 * What to call somebody who has not chosen a name.
 *
 * "Someone" rather than an email address or a shortened user id. The address is
 * personal information the app has no business showing to four other people,
 * and an id is not a name. Home greets by the whole name (NOTES §40); this is
 * the same name, seen from the outside.
 */
export function authorName(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'Someone';
}

// ----------------------------------------------------------------- messages --

export type MessageCheck =
  | { ok: true; body: string }
  | { ok: false; reason: string };

/**
 * Is this sendable, and what exactly gets sent?
 *
 * Trims first and measures the trimmed text, which is what the database's own
 * check does (`length(btrim(body))`). Measuring the raw string instead would
 * accept a message of a thousand spaces and refuse one of a thousand characters
 * with a newline on the end — and the database would then disagree with the
 * screen about which.
 *
 * The reason is the sentence shown to the person. No jargon, no character
 * counts they did not ask for.
 */
export function validateMessage(raw: string): MessageCheck {
  const body = raw.trim();
  if (body.length === 0) return { ok: false, reason: 'Type something first.' };
  if (body.length > MESSAGE_MAX_LENGTH) {
    return {
      ok: false,
      reason: `That is a bit long for a message. Keep it under ${MESSAGE_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, body };
}

/**
 * When a message was sent is NOT defined here.
 *
 * `describeWhen` in `src/core/chat.ts` already answers it — a time today,
 * "Yesterday", a weekday within the week, a date before that — for Nomi's
 * conversations, and it is the app's existing answer to "when, for somebody
 * reading a chat". A second one here would be two functions of the same name in
 * two core modules, drifting the way `src/ui/segment.tsx` records three copies
 * of a level picker drifting until one of them shipped without its counts.
 *
 * The chat screen imports it from there.
 */

// ------------------------------------------------------------------- stars --

/**
 * Can this person star this set?
 *
 * Refuses your own, matching `can_star_set` in 0021. Five people where everyone
 * starts on a star of their own is a ranking that says nothing — and a screen
 * that offers a control the database will refuse is a screen that produces an
 * error message for a rule nobody was told about.
 */
export function canStar(set: Pick<PublicSet, 'owner_id'>, myUserId: string): boolean {
  return set.owner_id !== myUserId;
}

/** "1 star" / "4 stars" / "No stars yet". */
export function starLabel(stars: number): string {
  if (stars <= 0) return 'No stars yet';
  return `${stars} star${stars === 1 ? '' : 's'}`;
}

// ----------------------------------------------------------------- ranking --

/**
 * The ranking: most-starred shared sets first.
 *
 * ## Only sets somebody has starred
 *
 * A set on nothing is not in last place, it is unrated — and with five users
 * most sets will be unrated for a while. Listing forty of them under a heading
 * that says "Top sets" would make the ranking read as a list of failures. They
 * are all still browsable; they are just not ranked.
 *
 * ## Ties share a rank
 *
 * Two sets on three stars are both second, and the next is fourth. The
 * alternative — breaking the tie silently for display — would print one of them
 * as third and invite the question of why, when the honest answer is "nothing;
 * they are equal".
 *
 * ## The tie-break is for ORDER only, never for rank
 *
 * Equal sets still have to be printed in some order, and it must be the same
 * order every time or the list would shuffle on every refresh. Earliest shared
 * first, then by title. Plain `<`/`>` rather than localeCompare, which sorts
 * differently depending on where it runs and would make this untestable.
 */
export function rankSets(sets: readonly PublicSet[], minStars = 1): RankedSet[] {
  const ranked = sets
    .filter((s) => s.stars >= minStars)
    .slice()
    .sort((a, b) => {
      if (a.stars !== b.stars) return b.stars - a.stars;
      const at = a.published_at ?? '';
      const bt = b.published_at ?? '';
      if (at !== bt) return at < bt ? -1 : 1;
      if (a.title !== b.title) return a.title < b.title ? -1 : 1;
      // Last resort, so the order is total and a refresh never reshuffles.
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const out: RankedSet[] = [];
  let lastStars = Number.NaN;
  let lastRank = 0;
  ranked.forEach((set, i) => {
    if (set.stars !== lastStars) {
      lastRank = i + 1;
      lastStars = set.stars;
    }
    out.push({ ...set, rank: lastRank });
  });
  return out;
}

/**
 * Newest shared sets first, for browsing.
 *
 * `published_at` and not `updated_at`: a set the owner edited this morning has
 * not just been shared, and ordering by the edit would put five-month-old sets
 * at the top of "new" every time their owner fixed a typo. A set with no
 * published_at was shared before 0021 recorded one — impossible today, kept
 * because a null sorting to the top would be wrong in the other direction.
 */
export function browseOrder(sets: readonly PublicSet[]): PublicSet[] {
  return sets.slice().sort((a, b) => {
    const at = a.published_at ?? '';
    const bt = b.published_at ?? '';
    if (at !== bt) return at < bt ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ---------------------------------------------------------------- sharing --

/**
 * What a person is told BEFORE a set is shared, in their words.
 *
 * ## Why this is a list of facts and not a sentence about privacy
 *
 * D13's privacy notice is shown once, after signing in, and says where notes go.
 * This is different: it is the moment one specific set stops being private, and
 * the only thing that makes it a decision rather than a switch is knowing
 * exactly what leaves. So each line names one thing, and the last two name what
 * does NOT leave — which is the half people assume wrongly.
 *
 * "The bit of your notes each card came from" is the one that surprises people.
 * A card carries the sentence it was grounded in; that is the whole promise of
 * the app and it cannot be shared without it.
 *
 * Checked against the app in `tests/community.test.ts`: every claim here is
 * either true of migration 0021's views or the test fails. A privacy promise
 * with no check behind it is a wish — the same rule as "the prompt asks; the
 * validator checks".
 */
export const SHARING_FACTS: readonly string[] = [
  'Anyone signed in to Nomi can find this set and study its cards.',
  'They see the questions, the answers, and the bit of your notes each card came from.',
  'They see the name you chose and the picture you are using.',
  'They cannot see your files, your notes, your other sets, or how you are doing.',
  'You can stop sharing at any time, and it disappears from the list.',
];

/** The heading above those facts. */
export const SHARING_TITLE = 'Share this set with everyone?';

/**
 * What the owner is told when they stop sharing.
 *
 * Honest about the one consequence that is not obvious: people who were part way
 * through it keep their answers but lose the cards. Saying nothing here would
 * make "stop sharing" feel free, and it is not quite.
 */
export const UNSHARING_NOTE =
  'Anyone studying it keeps their answers, but will not be able to open the cards again.';

/** The word for a set's state, where one is shown. */
export function visibilityLabel(visibility: Visibility): string {
  return visibility === 'public' ? 'Shared with everyone' : 'Only you';
}
