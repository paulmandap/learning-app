/**
 * Which cards a study deck deals, and at which level it should open.
 *
 * Pure: no react-native, no clock, no database. The three study screens used
 * to each decide this inline, and two defects the owner found from daily use
 * lived in exactly that decision (NOTES §36):
 *
 *  - **"Retry what you missed (1)" stayed after the retry was done.** The retry
 *    deck was filtered to the level on screen, and a deck opens on Understand.
 *    On the test account every missed card was a Remember card, so the retry
 *    deck opened EMPTY — and a card the student did retry, at Understand, left
 *    the Remember card still counted on the button that sent them there.
 *  - **"8 due today" stayed after studying.** The same shape: due cards are a
 *    set-wide count, the deck deals one level, and it opened on a level with no
 *    due cards at all.
 *
 * The rule both break is §21's: **count what you would deal.** A number on a
 * button is a promise about the deck it opens.
 */
import type { Level } from './planner';

/** The levels in their natural order, easiest first. Ties resolve to the earlier. */
export const LEVEL_ORDER: readonly Level[] = ['remember', 'understand', 'apply'];

export function isLevel(value: unknown): value is Level {
  return typeof value === 'string' && (LEVEL_ORDER as readonly string[]).includes(value);
}

/**
 * The cards a deck deals, before it is ordered.
 *
 * ## A retry deck ignores the level
 *
 * Levels are exclusive at the owner's request (deliberate deviation 7), and for
 * ordinary studying that stays true. The missed pile is a different thing: it is
 * "the cards you got wrong", counted across the whole set on Home and on
 * Progress. Filtering it by whichever level the screen happened to open on made
 * the deck and the count disagree — so a retry deck deals every missed card in
 * the set, and the level picker is hidden while it does.
 */
export function deal<T>(
  items: readonly T[],
  pick: { level: Level; retryOnly: boolean; missed?: ReadonlySet<string> },
  of: { id: (item: T) => string; level: (item: T) => Level },
): T[] {
  if (pick.retryOnly) return items.filter((item) => pick.missed?.has(of.id(item)) ?? false);
  return items.filter((item) => of.level(item) === pick.level);
}

/** How many of something sit at each level. */
export function countByLevel<T>(
  items: readonly T[],
  levelOf: (item: T) => Level,
  include: (item: T) => boolean = () => true,
): Partial<Record<Level, number>> {
  const counts: Partial<Record<Level, number>> = {};
  for (const item of items) {
    if (!include(item)) continue;
    const level = levelOf(item);
    counts[level] = (counts[level] ?? 0) + 1;
  }
  return counts;
}

/**
 * The level holding the most — where a deck about due cards should open.
 *
 * Null when every count is zero, which the caller must treat as "no opinion"
 * and keep its own default rather than opening on an arbitrary level.
 */
export function busiestLevel(counts: Partial<Record<Level, number>>): Level | null {
  let best: Level | null = null;
  let bestCount = 0;
  for (const level of LEVEL_ORDER) {
    const n = counts[level] ?? 0;
    if (n > bestCount) {
      best = level;
      bestCount = n;
    }
  }
  return best;
}

/**
 * The level a deck opens on, from its link.
 *
 * A link that knows where the work is — "Study what's due", the set screen's
 * due chip — passes `?level=`. This reads it as the deck's STARTING level, in
 * the screen's initial state, and never changes it afterwards. That is the
 * difference from what Phase D was told not to build: the app is not moving the
 * student between levels mid-session, the link the student chose says where to
 * begin (NOTES §36).
 */
export function startingLevel(param: unknown, fallback: Level = 'understand'): Level {
  return isLevel(param) ? param : fallback;
}
