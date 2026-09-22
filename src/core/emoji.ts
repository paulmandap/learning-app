/**
 * The emoji the chat offers (NOTES §47).
 *
 * The owner: *"in the community chat, add emoji."*
 *
 * ## Why a short list and not a picker
 *
 * A full picker means an emoji library — a few thousand entries, keyword search
 * and skin-tone variants — which is a dependency, a download on every start,
 * and this project does not add one without a measured reason. Nothing here
 * needs it: people reaching for an emoji mid-sentence want a face or a hand,
 * and the keyboard on a phone already has every emoji there is. This is the
 * shortcut for a laptop, where the keyboard does not.
 *
 * Grouped, because a flat wall of sixty is harder to use than three short rows
 * with a reason to be together.
 *
 * Nothing here is drawn by the app — they are characters, rendered by whatever
 * font the device has. `src/ui/glyphs.tsx` records why the TAB icons could not
 * be, and the reason does not apply: a gear and a pencil at four unrelated
 * weights look broken, while an emoji looking like the platform's own emoji is
 * exactly right.
 */

export interface EmojiGroup {
  /** Shown above the row. No jargon, no "smileys & people". */
  label: string;
  emoji: readonly string[];
}

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  {
    label: 'Faces',
    emoji: ['😀', '😂', '🥹', '😊', '😎', '🤔', '😅', '😭', '😱', '🥳', '😴', '🤯'],
  },
  {
    label: 'Hands',
    emoji: ['👍', '👏', '🙌', '🙏', '💪', '🤝', '✌️', '🫡'],
  },
  {
    label: 'Studying',
    emoji: ['📚', '📝', '✏️', '💡', '🔥', '⭐', '✅', '❌', '⏰', '🎯', '🧠', '☕'],
  },
  {
    label: 'Feelings',
    emoji: ['❤️', '💀', '🎉', '😤', '🤡', '👀', '🫠', '🥲'],
  },
];

/** Every emoji offered, flat — for tests and for a quick-reaction row. */
export const ALL_EMOJI: readonly string[] = EMOJI_GROUPS.flatMap((g) => g.emoji);

/**
 * The few shown without opening anything.
 *
 * Deliberately the ones people actually send at a study group: agreement,
 * applause, laughing, and the two that carry a whole reply on their own.
 */
export const QUICK_EMOJI: readonly string[] = ['👍', '😂', '🔥', '❤️', '🙏', '😭'];

/**
 * The reaction row on a message (NOTES §48).
 *
 * The owner named these six: *"heart, haha, wow, sad, angry, like, '+' for
 * custom reaction."* In that order, which is Messenger's, so the muscle memory
 * transfers. The "+" is not in this list — it opens the full panel above, and
 * any emoji from there is a valid reaction.
 *
 * Each carries a word, because a row of six faces is six things a screen reader
 * announces as "emoji" otherwise.
 */
export const REACTIONS: readonly { emoji: string; label: string }[] = [
  { emoji: '❤️', label: 'Heart' },
  { emoji: '😂', label: 'Haha' },
  { emoji: '😮', label: 'Wow' },
  { emoji: '😢', label: 'Sad' },
  { emoji: '😠', label: 'Angry' },
  { emoji: '👍', label: 'Like' },
];

/**
 * Reactions on one message, gathered for display.
 *
 * Messenger shows one chip per distinct emoji with a count, not one chip per
 * person — six hearts is "❤️ 6", and it is the count that tells you how a room
 * felt. Ordered by count and then by the emoji itself, so the chips do not
 * reshuffle when two are level.
 */
export interface Reaction {
  /** Which message it is on — a chat fetches them all at once and buckets them. */
  message_id: string;
  emoji: string;
  user_id: string;
  name?: string | null;
}

export interface ReactionTally {
  emoji: string;
  count: number;
  /** Did the person looking at it react this way? Drives the highlighted chip. */
  mine: boolean;
  /** Who, for the label a screen reader reads and the tooltip on a laptop. */
  names: string[];
}

export function tallyReactions(
  reactions: readonly Reaction[],
  myUserId: string,
): ReactionTally[] {
  const byEmoji = new Map<string, ReactionTally>();

  for (const r of reactions) {
    const tally = byEmoji.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false, names: [] };
    tally.count++;
    if (r.user_id === myUserId) tally.mine = true;
    const name = (r.name ?? '').trim();
    tally.names.push(r.user_id === myUserId ? 'You' : name.length > 0 ? name : 'Someone');
    byEmoji.set(r.emoji, tally);
  }

  return [...byEmoji.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    return a.emoji < b.emoji ? -1 : a.emoji > b.emoji ? 1 : 0;
  });
}

/**
 * Append an emoji to what somebody has typed.
 *
 * A space before it when the draft ends in a word, and none when it ends in a
 * space or is empty — so tapping three in a row gives "😀😂🔥" rather than
 * "😀 😂 🔥", which is what people mean when they tap three in a row, and
 * typing "nice" then tapping gives "nice 👍" rather than "nice👍".
 */
export function appendEmoji(draft: string, emoji: string): string {
  if (draft.length === 0) return emoji;
  if (/\s$/.test(draft)) return draft + emoji;
  // After another emoji, no space. After a word, a space.
  if (ALL_EMOJI.some((e) => draft.endsWith(e))) return draft + emoji;
  return `${draft} ${emoji}`;
}
