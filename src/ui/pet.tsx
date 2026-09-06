import { Image, Pressable, Text, View, type ImageSourcePropType } from 'react-native';
import { radius, space, useTheme } from './theme';
import { daysToNextStage, petStage, PET_SPECIES, type PetSpecies } from '../core/pet';

import potato1 from '../../assets/potato-1.webp';
import potato2 from '../../assets/potato-2.webp';
import potato3 from '../../assets/potato-3.webp';
import potato4 from '../../assets/potato-4.webp';
import potato5 from '../../assets/potato-5.webp';
import cat1 from '../../assets/cat-1.webp';
import cat2 from '../../assets/cat-2.webp';
import cat3 from '../../assets/cat-3.webp';
import cat4 from '../../assets/cat-4.webp';
import cat5 from '../../assets/cat-5.webp';

/**
 * The streak, as a pet that grows.
 *
 * The owner asked for this by name: *"similar to tiktok streak … instead of '1
 * day in a row' plain text, let's make it fun."* The number is still there and
 * still exact — a streak that cannot be read precisely stops being trusted —
 * but it is no longer the only thing on the card.
 *
 * ## The art is one image cut into five, not five images
 *
 * Five separate generations drift: the colour shifts, the outline thickens, the
 * face changes. A pet that becomes a different animal when it grows is worse
 * than no pet, so the five stages are generated as a single row and sliced by
 * `scripts/make-pet-assets.ts`, which also keys out the flat background and
 * trims each frame to its ink.
 *
 * ## Sizes are explicit pixels
 *
 * §8.1 records three attempts at fitting a picture into a card on
 * react-native-web: a fixed height cropped it, width plus aspectRatio collapsed
 * it to nothing, and explicit width and height worked. This uses the third,
 * with `contain` so the differing frame shapes all sit correctly in their box.
 */

/**
 * Both pets, five stages each, imported statically.
 *
 * Metro resolves `import` paths at build time, so these cannot be assembled
 * from a name at runtime — a lookup table is the way to have a choice at all.
 *
 * Ten frames come to about **127 KB** as WebP, which is why both pets ship
 * rather than one being fetched on demand: a pet that has to load is a pet
 * that is briefly missing from the screen it is supposed to make welcoming.
 *
 * They were PNGs first, and that cost **1.15 MB — a third of the entire web
 * build** for a decoration. Flat-colour cartoons are the case WebP wins by an
 * order of magnitude, and `scripts/make-pet-assets.ts` carries the measurement.
 */
const ART: Record<PetSpecies, ImageSourcePropType[]> = {
  potato: [potato1, potato2, potato3, potato4, potato5],
  cat: [cat1, cat2, cat3, cat4, cat5],
};

/** What each one is called, for the chooser and for screen readers. */
export const PET_LABELS: Record<PetSpecies, string> = {
  potato: 'Potato',
  cat: 'Cat',
};

/** One frame, for the chooser to show what it is offering. */
export function petFrame(species: PetSpecies, stageIndex: number): ImageSourcePropType {
  return ART[species][stageIndex] ?? ART[species][0]!;
}

/**
 * How big each stage draws, in pixels.
 *
 * Growth has to be VISIBLE at a glance or the whole idea fails, so the steps
 * are large. It stops at 132 because the card also has to hold the number and a
 * line of text on a 393px phone, and a pet that pushes those off the screen is
 * a worse card than a slightly smaller pet.
 */
const SIZES = [76, 92, 108, 120, 132];

/**
 * Pick your pet.
 *
 * Shows each one rather than naming it — the choice is about which you'd
 * rather look at every day, and a radio button labelled "Cat" does not answer
 * that. The third stage is the frame on offer: the baby is too small to read
 * at tile size, and the giant carries a crown that belongs to a hundred-day
 * streak nobody has yet.
 *
 * A tap saves. There is no confirm step because there is nothing to lose —
 * changing your mind costs another tap, and the streak, which is the part that
 * matters, is untouched by which animal is standing next to it.
 */
export function PetChooser({
  value,
  onChange,
  disabled,
}: {
  value: PetSpecies;
  onChange: (species: PetSpecies) => void;
  disabled?: boolean;
}) {
  const t = useTheme();

  return (
    <View style={{ flexDirection: 'row', gap: space.sm }}>
      {PET_SPECIES.map((species) => {
        const selected = species === value;
        return (
          <Pressable
            key={species}
            accessibilityRole="button"
            accessibilityState={{ selected, disabled: !!disabled }}
            accessibilityLabel={`${PET_LABELS[species]}${selected ? ', chosen' : ''}`}
            onPress={() => !disabled && onChange(species)}
            style={{
              flex: 1,
              alignItems: 'center',
              gap: 4,
              paddingVertical: space.md,
              borderWidth: selected ? 2 : 1,
              borderColor: selected ? t.accent : t.border,
              borderRadius: radius.md,
              backgroundColor: selected ? t.bg : 'transparent',
              opacity: disabled ? 0.6 : 1,
            }}
          >
            <Image
              source={petFrame(species, 2)}
              style={{ width: 84, height: 84 }}
              resizeMode="contain"
            />
            {/* A mark as well as a border, for the same reason the quiz marks
                its options with ✓ and ✗ rather than colour alone. */}
            <Text style={{ color: t.text, fontSize: 15, fontWeight: selected ? '700' : '400' }}>
              {selected ? `✓ ${PET_LABELS[species]}` : PET_LABELS[species]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function PetStreak({ streak, species }: { streak: number; species: PetSpecies }) {
  const t = useTheme();
  const stage = petStage(streak);
  const toGo = daysToNextStage(streak);

  // No streak yet: show the baby it would hatch into, faded, so there is
  // something to aim at rather than an empty box. An invitation, not a badge.
  const frames = ART[species];
  const art = frames[stage ? stage.index : 0];
  const size = stage ? SIZES[stage.index]! : SIZES[0]!;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
      <Image
        source={art}
        // Numbers, not percentages: measured, not guessed — see §8.1.
        style={{ width: size, height: size, opacity: stage ? 1 : 0.35 }}
        resizeMode="contain"
        accessibilityLabel={
          stage
            ? `Your ${PET_LABELS[species].toLowerCase()}, ${stage.name} size, at ${streak} days in a row`
            : `Your ${PET_LABELS[species].toLowerCase()}, not hatched yet`
        }
      />

      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ fontSize: 28, fontWeight: '700', color: t.text }}>
          {streak > 0 ? `${streak} day${streak === 1 ? '' : 's'} in a row` : 'Not hatched yet'}
        </Text>

        {stage === null ? (
          <Text style={{ fontSize: 14, color: t.textMuted }}>
            Answer a card today and it hatches.
          </Text>
        ) : toGo === null ? (
          <Text style={{ fontSize: 14, color: t.textMuted }}>
            Fully grown. Keep going and it stays that way.
          </Text>
        ) : (
          <>
            <Text style={{ fontSize: 14, color: t.textMuted }}>
              {toGo} more day{toGo === 1 ? '' : 's'} and it grows again.
            </Text>
            {/* Progress across THIS stage, not the whole road to 100 — see the
                note in core/pet.ts. A bar that barely moves for a month is
                worse than no bar. */}
            <View
              style={{
                height: 6,
                borderRadius: radius.sm,
                overflow: 'hidden',
                backgroundColor: t.chart.neutral,
                marginTop: 2,
              }}
            >
              <View
                style={{
                  width: `${Math.max(2, stage.progress * 100)}%`,
                  height: '100%',
                  backgroundColor: t.chart.known,
                }}
              />
            </View>
          </>
        )}
      </View>
    </View>
  );
}
