import { Pressable, Text, View } from 'react-native';
import { Button } from './components';
import { Avatar } from './avatar';
import { radius, space, type, useTheme } from './theme';

/**
 * The top of Home, from the owner's reference (NOTES §36).
 *
 * *"on the leftmost side, there is 'Welcome back, Sarah' and on the top right
 * is sarah's profile picture. i want that too."* The picture opens Settings,
 * where it is chosen.
 *
 * With no name given, "Welcome back" alone — never a name guessed from an
 * email address, which is how "Welcome back, paulmandap16" happens.
 */
export function GreetingHeader({
  name,
  avatar,
  userId,
  onAvatar,
}: {
  name: string | null;
  avatar: string | null | undefined;
  userId: string;
  onAvatar: () => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md }}>
      <View style={{ flex: 1 }} accessibilityRole="header">
        <Text style={[type.display, { color: t.text }]}>{name ? 'Welcome back,' : 'Welcome back'}</Text>
        {name ? (
          <Text style={[type.display, { color: t.text }]} numberOfLines={1}>
            {name}
          </Text>
        ) : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Your profile" onPress={onAvatar} hitSlop={8}>
        <Avatar value={avatar} userId={userId} size={52} />
      </Pressable>
    </View>
  );
}

/**
 * The one thing to do next, shaded so it reads that way.
 *
 * The owner: *"the continue card is darker or somewhat shaded? it lets the user
 * think 'oh i should prioritize this'"*. So it is the only surface on Home with
 * a tint and no border, it carries the set's progress, and it holds the screen's
 * one filled button. Its heading sits ABOVE it, as in the reference, so the
 * card itself is all about the set.
 */
export function ContinueCard({
  title,
  meta,
  known,
  cards,
  actionLabel,
  onPress,
}: {
  title: string;
  meta: string;
  known: number;
  cards: number;
  actionLabel: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const share = cards > 0 ? Math.min(1, known / cards) : 0;
  return (
    <View style={{ backgroundColor: t.feature, borderRadius: radius.lg, padding: space.lg, gap: space.md }}>
      <View style={{ gap: space.xs }}>
        <Text style={[type.title, { color: t.featureText }]} numberOfLines={2}>
          {title}
        </Text>
        <Text style={[type.body, { color: t.featureMuted }]}>{meta}</Text>
      </View>
      {cards > 0 ? (
        <View style={{ gap: space.xs }}>
          <View style={{ height: 6, borderRadius: radius.pill, backgroundColor: t.bg, overflow: 'hidden' }}>
            <View
              style={{
                width: `${Math.round(share * 100)}%`,
                height: '100%',
                borderRadius: radius.pill,
                backgroundColor: t.accent,
              }}
            />
          </View>
          <Text style={[type.caption, { color: t.featureMuted }]}>
            {known} of {cards} card{cards === 1 ? '' : 's'} known
          </Text>
        </View>
      ) : null}
      <Button label={actionLabel} onPress={onPress} />
    </View>
  );
}
