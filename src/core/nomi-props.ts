/**
 * Nomi's props: what they are, where each sits on the owl, and when (NOTES §50).
 *
 * Pure. The pictures are cut by `scripts/make-nomi-props.ts` from the sheet the
 * owner made with Gemini; `src/ui/nomi-character.tsx` draws them. Nothing here
 * knows a pixel: a place is a fraction of the owl's own box, like everything in
 * `nomi-motion.ts`, so a prop sits in the same spot at 36px and at 112px.
 *
 * Two kinds. A HELD prop — a book, a mug, a cap — is the screen's to choose,
 * because only the screen knows what Nomi is doing there: reading your notes,
 * studying beside the count, a perfect round. It stays through a tap's hop. A
 * FLOATING prop belongs to a moment — a heart on a tap, a lightbulb while Nomi
 * says its line, sparkles on a round that went well — pops up with it, and is
 * gone when it ends.
 */
import type { Channel, Motion, NomiState } from './nomi-motion';

export const NOMI_PROPS = [
  'book',
  'lightbulb',
  'magnifier',
  'pencil',
  'cap',
  'nightcap',
  'heart',
  'mug',
  'sparkles',
] as const;

export type NomiProp = (typeof NOMI_PROPS)[number];

/**
 * Where a prop sits: its centre and width as fractions of the owl's box (x and
 * width of its width, y of its height), and a turn in degrees. Tuned by
 * photographing them on Nomi.
 *
 * `hand` is what holds it: `both` wings in front (a book, a mug), or the
 * `right` wing. A wing holding something stays still (`holding`) — a mug held
 * in front while both wings stretched out floated in the air (NOTES §68).
 */
export interface PropPlace {
  cx: number;
  cy: number;
  width: number;
  rotate: number;
  hand?: 'both' | 'right';
}

/**
 * Nomi's head leans about 10° to its left — the right ear tuft sits lower than
 * the left. Measured from `assets/nomi-body.webp`: the tufts' tips at (68, 2)
 * and (356, 56) of 367 × 493, and the brow over the eyes at 13°. A hat is worn
 * at the head's angle; turned the other way it reads as a sticker on top.
 */
export const HEAD_TILT_DEG = 10;

export const PROP_PLACES: Readonly<Record<NomiProp, PropPlace>> = {
  // Held up in front, as the reference sheet's studying Nomi holds it.
  book: { cx: 0.5, cy: 0.74, width: 0.7, rotate: 0, hand: 'both' },
  // In the right wing, the lens up beside the head.
  magnifier: { cx: 0.86, cy: 0.62, width: 0.52, rotate: 0, hand: 'right' },
  pencil: { cx: 0.86, cy: 0.66, width: 0.44, rotate: 0, hand: 'right' },
  mug: { cx: 0.46, cy: 0.76, width: 0.36, rotate: 0, hand: 'both' },
  // Worn, at the head's tilt (NOTES §68). The owner: *"the hat is on nomi it
  // looks awkward. nomi isn't wearing it."* The cap was turned 6° the wrong
  // way — against the head's 10° — and perched on the crown.
  cap: { cx: 0.5, cy: 0.08, width: 0.76, rotate: HEAD_TILT_DEG },
  // The starry nightcap (NOTES §72.5), cut from a picture of an owl wearing it,
  // so its cuff wraps a head instead of resting on one. Down over the crown,
  // both ear tufts inside, the cuff along the brow: the picture's cuff slopes
  // about 14°, and −4° meets the head's 10°. Chosen by counting the owl's
  // pixels that show through the hat at each place — none here; 128 at the
  // first try, where the owner saw the right tuft (scripts/try-nightcap.ts).
  // Wider than the head, because the pompom hangs past the right cheek.
  nightcap: { cx: 0.66, cy: 0.2, width: 1.22, rotate: -4 },
  // Floating, beside the head.
  lightbulb: { cx: 0.9, cy: 0.06, width: 0.3, rotate: 8 },
  heart: { cx: 0.9, cy: 0.08, width: 0.32, rotate: 6 },
  sparkles: { cx: 0.9, cy: 0.14, width: 0.42, rotate: 0 },
};

/** What is worn on the head rather than held. */
export const WORN: ReadonlySet<NomiProp> = new Set<NomiProp>(['cap', 'nightcap']);

/**
 * Where a moment's prop floats while a hat is on, clear of it. Without a hat
 * they stay close to the head, where a small Nomi in a heading has room.
 *
 * - **The cap** (NOTES §68): higher and further out to the right, clear of its
 *   tassel. In their usual places the sparkles sat on the tassel.
 * - **The starry nightcap** (§72.5): on the left. Its tip and pompom fill the
 *   right side, out to 1.29 of the owl's width, which is also where Home's
 *   speech bubble starts.
 */
const CLEAR_OF_A_HAT: Readonly<Record<'cap' | 'nightcap', Partial<Record<NomiProp, PropPlace>>>> = {
  cap: {
    lightbulb: { cx: 1.06, cy: -0.1, width: 0.28, rotate: 8 },
    heart: { cx: 1.06, cy: -0.08, width: 0.3, rotate: 6 },
    sparkles: { cx: 1.02, cy: -0.04, width: 0.4, rotate: 0 },
  },
  nightcap: {
    lightbulb: { cx: -0.17, cy: 0.04, width: 0.28, rotate: -8 },
    heart: { cx: -0.17, cy: 0.06, width: 0.3, rotate: -6 },
    sparkles: { cx: -0.2, cy: 0.08, width: 0.38, rotate: 0 },
  },
};

/** Where a prop goes, given what else Nomi has on. */
export function placeOf(prop: NomiProp, held: NomiProp | null): PropPlace {
  const hat = held === 'cap' || held === 'nightcap' ? CLEAR_OF_A_HAT[held] : null;
  return hat?.[prop] ?? PROP_PLACES[prop];
}

/** The wing channels a held prop keeps still. */
export function stillWings(prop: NomiProp | null): Channel[] {
  const hand = prop ? PROP_PLACES[prop].hand : undefined;
  if (hand === 'both') return ['wingLeft', 'wingRight'];
  if (hand === 'right') return ['wingRight'];
  return [];
}

/**
 * A motion with the wings that are holding something left at rest (NOTES §68):
 * a hop or a stretch holding a mug is a hop or a stretch without the wings,
 * and a wave holding a book does not wave the book away. Everything else in
 * the motion — the lift, the face, the tilt — plays as it was.
 */
export function holding(motion: Motion, prop: NomiProp | null): Motion {
  const still = stillWings(prop);
  if (still.length === 0) return motion;
  return { ...motion, tracks: motion.tracks.filter((t) => !still.includes(t.channel)) };
}

/** A moment's own prop, whatever the screen holds. */
const MOMENT: Partial<Record<NomiState, NomiProp>> = {
  hop: 'heart',
  success: 'sparkles',
  explaining: 'lightbulb',
};

export const FLOATING: ReadonlySet<NomiProp> = new Set(Object.values(MOMENT));

/**
 * What Nomi holds or wears, and what floats beside it, in a state.
 *
 * `held` is the screen's choice. A sleepy Nomi wears its nightcap even when the
 * screen chose nothing, so the state alone is enough to put it on.
 */
export function propsFor(state: NomiState, held: NomiProp | null | undefined): { held: NomiProp | null; floating: NomiProp | null } {
  return {
    held: held ?? (state === 'sleepy' ? 'nightcap' : null),
    floating: MOMENT[state] ?? null,
  };
}
