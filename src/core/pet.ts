/**
 * The streak, as something that grows.
 *
 * The owner: *"for the progress, it would be great if there's a 'pet' similar
 * to tiktok streak. instead of '1 day in a row' plain text, let's make it fun.
 * the pet should grow larger every 1 (baby), 10, 20, 50, 100."*
 *
 * ## Why the thresholds are exactly his
 *
 * 1, 10, 20, 50, 100 — not a curve fitted to something. They are far apart
 * enough that a stage means something, and the first one arrives on day one so
 * nobody meets an empty pen. The gaps widen (9, 10, 30, 50), so the later
 * stages are genuinely rare, which is the whole appeal of a streak badge.
 *
 * ## Pure, so it can be tested and so the screen cannot get it wrong
 *
 * No react-native import, no dates, no clock: a streak count in, a stage out.
 * `studyStreak` in `src/core/progress.ts` already owns what a streak IS —
 * including that it survives a day you have not studied yet — and this must not
 * quietly reinterpret that.
 */

/**
 * Which animal, chosen by the student.
 *
 * The owner generated two sheets on purpose: *"the reason why i put two jpeg
 * images is that the user may choose which pet they would want."* A pet you
 * were assigned is a mascot; a pet you picked is yours, and the whole point of
 * the thing is that you want to keep it alive.
 *
 * The list lives here rather than in the database. `0011_pet_choice.sql` has a
 * matching check constraint, but this is the definition — adding a third pet
 * means dropping a sheet into `assets/`, running the slicing script, and adding
 * one line here and one to the constraint.
 */
export const PET_SPECIES = ['potato', 'cat'] as const;

export type PetSpecies = (typeof PET_SPECIES)[number];

/**
 * What someone gets before they have chosen.
 *
 * Defaulted in the app rather than in the database, so a stored NULL still
 * means "has not chosen" and changing this later cannot silently reassign the
 * pet of everyone who never picked one.
 */
export const DEFAULT_PET: PetSpecies = 'potato';

/**
 * Read a stored value back as a species.
 *
 * The column is text with a check constraint, so this should never see
 * anything else — but a value written before the constraint existed, or by
 * hand in the dashboard, must not leave the screen with no pet to draw.
 */
export function toPetSpecies(value: unknown): PetSpecies {
  return PET_SPECIES.includes(value as PetSpecies) ? (value as PetSpecies) : DEFAULT_PET;
}

export type PetStageName = 'baby' | 'small' | 'medium' | 'large' | 'giant';

export interface PetStage {
  /** 0-4, and the index of the artwork to show. */
  index: number;
  name: PetStageName;
  /** The streak this stage begins at. */
  from: number;
  /**
   * The streak the next stage begins at, or null at the top.
   *
   * The screen needs this to say "3 days to go", which is the part that makes
   * a badge motivating rather than decorative.
   */
  nextAt: number | null;
  /** 0..1 towards the next stage. 1 at the top stage, which is complete. */
  progress: number;
}

/**
 * The thresholds, lowest first.
 *
 * Stage 0 starts at 1 rather than 0: a streak of zero has no pet, and the
 * screen says so instead of showing a stage nobody has earned.
 */
export const PET_THRESHOLDS: { at: number; name: PetStageName }[] = [
  { at: 1, name: 'baby' },
  { at: 10, name: 'small' },
  { at: 20, name: 'medium' },
  { at: 50, name: 'large' },
  { at: 100, name: 'giant' },
];

/**
 * Which stage a streak has reached, or null below the first threshold.
 *
 * Null rather than a "stage zero", because the two states read completely
 * differently on screen — one is a pet you have, the other is an invitation to
 * start — and collapsing them would make the empty case the pet's problem.
 */
export function petStage(streak: number): PetStage | null {
  if (!Number.isFinite(streak) || streak < PET_THRESHOLDS[0]!.at) return null;

  let index = 0;
  for (let i = 0; i < PET_THRESHOLDS.length; i++) {
    if (streak >= PET_THRESHOLDS[i]!.at) index = i;
  }

  const current = PET_THRESHOLDS[index]!;
  const next = PET_THRESHOLDS[index + 1];
  const nextAt = next ? next.at : null;

  // Progress across THIS band, not across the whole scale — otherwise a bar at
  // day 60 would sit near the end of the road to 100 and barely move for a
  // month. Within a band it advances visibly every day.
  const span = nextAt === null ? 0 : nextAt - current.at;
  const progress = span === 0 ? 1 : Math.min(1, (streak - current.at) / span);

  return { index, name: current.name, from: current.at, nextAt, progress };
}

/**
 * How many days until the pet grows again, or null at the top.
 *
 * Separate from `petStage` because it is the one number worth putting into a
 * sentence, and computing it at the call site is how it ends up off by one.
 */
export function daysToNextStage(streak: number): number | null {
  const stage = petStage(streak);
  if (!stage || stage.nextAt === null) return null;
  return Math.max(1, stage.nextAt - streak);
}
