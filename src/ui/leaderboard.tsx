import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, LoadingState } from './components';
import { PersonAvatar } from './avatar';
import { TextLink } from './legal';
import { radius, space, type, useTheme } from './theme';
import { aloneOnBoard, bestLabel, rankLeaderboard, streakDays, type RankedRow } from '../core/leaderboard';
import { personName } from '../core/social';
import { friendsLeaderboard, LeaderboardUnavailableError } from '../data/leaderboard';

/**
 * Friends' streaks, on Progress (NOTES §54).
 *
 * Below your own pet and streak, not above them: Progress is how YOU are going
 * first, and the board is the company you keep while you do it.
 *
 * The number, not a medal. `SharedSetRow` explains why for Top sets — three
 * medals and a run of grey numbers says "you lost" to everybody below third —
 * and a board of friends is the last place for that.
 *
 * It says, every time, that friends see your streak here and where to stop
 * that. A leaderboard you are on without knowing is the kind of surprise the
 * Privacy Policy exists to prevent.
 */
export function FriendsBoard() {
  const t = useTheme();
  const router = useRouter();
  const { data, isLoading, error } = useQuery({
    queryKey: ['leaderboard'],
    queryFn: () => friendsLeaderboard(),
    retry: (count, err) => !(err instanceof LeaderboardUnavailableError) && count < 1,
  });

  // Not switched on yet: nothing to show, and nothing wrong with the rest of Progress.
  if (error instanceof LeaderboardUnavailableError) return null;

  const ranked = rankLeaderboard(data ?? []);

  return (
    <Card>
      <Body>Friends&apos; streaks</Body>

      {isLoading ? <LoadingState /> : null}
      {error && !(error instanceof LeaderboardUnavailableError) ? (
        <Body muted>Couldn&apos;t load your friends&apos; streaks just now.</Body>
      ) : null}

      {data && aloneOnBoard(data) ? (
        <>
          <Body muted>Add friends to see how your streaks compare.</Body>
          <Button label="Find friends" variant="secondary" onPress={() => router.push('/profile')} />
        </>
      ) : (
        <View style={{ gap: space.xs }}>
          {ranked.map((row) => (
            <BoardRow
              key={row.person_id}
              row={row}
              onPress={row.is_me ? undefined : () => router.push(`/person/${row.person_id}`)}
            />
          ))}
        </View>
      )}

      <Text style={[type.caption, { color: t.textMuted }]}>
        Your friends see your streak here.
      </Text>
      <TextLink label="Change that in Settings" onPress={() => router.push('/settings')} />
    </Card>
  );
}

function BoardRow({ row, onPress }: { row: RankedRow; onPress?: () => void }) {
  const t = useTheme();
  const name = row.is_me ? 'You' : personName({ name: row.name, username: row.username });
  const best = bestLabel(row);

  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${row.rank === null ? '' : `${row.rank}. `}${name}, ${streakDays(row.current_streak)}${best ? `, ${best.toLowerCase()}` : ''}`}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.sm,
        paddingHorizontal: space.sm,
        borderRadius: radius.sm,
        // Where you are, at a glance — outlined as well as shaded, never colour alone.
        backgroundColor: row.is_me ? t.bg : 'transparent',
        borderWidth: row.is_me ? 1 : 0,
        borderColor: t.accent,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={[type.bodyStrong, { color: t.textMuted, minWidth: 22, textAlign: 'right' }]}>
        {row.rank ?? '–'}
      </Text>
      <PersonAvatar avatar={row.avatar} userId={row.person_id} name={name} size={32} />
      <Text style={[row.is_me ? type.bodyStrong : type.body, { color: t.text, flex: 1 }]} numberOfLines={1}>
        {name}
      </Text>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={[type.bodyStrong, { color: t.text }]}>{streakDays(row.current_streak)}</Text>
        {best ? <Text style={[type.caption, { color: t.textMuted }]}>{best}</Text> : null}
      </View>
    </Pressable>
  );
}
