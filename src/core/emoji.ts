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
