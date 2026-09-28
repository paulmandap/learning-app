import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Icon, type IconName } from './glyphs';
import { radius, space, TOUCH_TARGET, type, useTheme } from './theme';
import { starLabel } from '../core/community';

/**
 * The top of a profile — yours on the Profile tab, somebody's on their page
 * (NOTES §59, the owner's picture): a large picture, then the name, the
 * @username and the bio beside it. One component, so the two pages cannot
 * drift into two ideas of what a profile is.
 */
export function ProfileHeader({
  picture,
  name,
  handle,
  bio,
}: {
  picture: ReactNode;
  name: string;
  handle: string | null;
  bio: string | null | undefined;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
      {picture}
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.title, { color: t.text }]} numberOfLines={2} accessibilityRole="header">
          {name}
        </Text>
        {handle && handle !== name ? <Text style={[type.body, { color: t.textMuted }]}>{handle}</Text> : null}
        {bio ? (
          <Text style={[type.body, { color: t.text, marginTop: space.xs }]} selectable>
            {bio}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/**
 * A shared set as a row: its icon on a tile, the title, cards and stars, and
 * a chevron — a profile's Sets tab and search's Sets (the owner's picture).
 */
export function SetRow({
  title,
  cards,
  stars,
  byline,
  onPress,
}: {
  title: string;
  cards: number;
  stars?: number;
  /** Whose it is, where that is not obvious — in search. */
  byline?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const meta = [byline, `${cards} card${cards === 1 ? '' : 's'}`, stars !== undefined ? starLabel(stars) : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${meta}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: TOUCH_TARGET + space.sm,
        paddingVertical: space.sm,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.sm,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: t.card,
        }}
      >
        <Icon name="set" color={t.accent} size={20} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[type.caption, { color: t.textMuted }]}>{meta}</Text>
      </View>
      <Icon name="forward" color={t.textMuted} size={20} />
    </Pressable>
  );
}

export interface Stat {
  value: number;
  label: string;
  /** Drawn before the number — the streak's flame. */
  icon?: IconName;
  iconColor?: string;
}

/**
 * Numbers in a row, evenly spaced, with a hairline between them — "24 Friends
 * · 12 Posts · 30 Streak" in the owner's picture. Each is read as one phrase
 * ("12 Posts"), not as a number and then a word.
 */
export function StatsRow({ stats }: { stats: readonly Stat[] }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'stretch' }}>
      {stats.map((s, i) => (
        <View
          key={s.label}
          accessible
          accessibilityLabel={`${s.value} ${s.label}`}
          style={{
            flex: 1,
            alignItems: 'center',
            gap: 2,
            paddingVertical: space.xs,
            borderLeftWidth: i === 0 ? 0 : 1,
            borderLeftColor: t.border,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
            {/* Drawn, not filled: a filled flame at this size read as a
                thumb (measured on the first photograph). */}
            {s.icon ? <Icon name={s.icon} color={s.iconColor ?? t.text} size={20} /> : null}
            <Text style={[type.title, { color: t.text }]}>{s.value}</Text>
          </View>
          <Text style={[type.caption, { color: t.textMuted }]}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}
