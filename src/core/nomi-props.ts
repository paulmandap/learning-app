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
import type { NomiState } from './nomi-motion';

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
 */
export interface PropPlace {
  cx: number;
  cy: number;
  width: number;
  rotate: number;
}

export const PROP_PLACES: Readonly<Record<NomiProp, PropPlace>> = {
  // Held up in front, as the reference sheet's studying Nomi holds it.
  book: { cx: 0.5, cy: 0.74, width: 0.7, rotate: 0 },
  // In the right wing, the lens up beside the head.
  magnifier: { cx: 0.86, cy: 0.62, width: 0.52, rotate: 0 },
  pencil: { cx: 0.86, cy: 0.66, width: 0.44, rotate: 0 },
  mug: { cx: 0.46, cy: 0.76, width: 0.36, rotate: 0 },
  // Worn.
  cap: { cx: 0.52, cy: 0.05, width: 0.74, rotate: -6 },
  // Low enough that the brim sits on the brow; the first place, higher and
  // wider, perched on top and hid the "z"s under its tip.
  nightcap: { cx: 0.48, cy: 0.1, width: 0.8, rotate: -4 },
  // Floating, beside the head.
  lightbulb: { cx: 0.9, cy: 0.06, width: 0.3, rotate: 8 },
  heart: { cx: 0.9, cy: 0.08, width: 0.32, rotate: 6 },
  sparkles: { cx: 0.9, cy: 0.14, width: 0.42, rotate: 0 },
};

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
