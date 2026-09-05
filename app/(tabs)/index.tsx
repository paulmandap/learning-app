import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, ListRow, Notice, Screen, Title } from '../../src/ui/components';
import { fetchProfile } from '../../src/data/profile';
import { listSets, type StudySet } from '../../src/data/sets';
import { continueTarget } from '../../src/data/attempts';
import { dueCountsBySet } from '../../src/data/review';
import { useSessionStore } from '../../src/data/session';
import { formatSetTitle } from '../../src/core/title';

export default function Home() {
  const router = useRouter();
  const session = useSessionStore((s) => s.session);

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
    enabled: !!session,
  });
  const { data: sets = [], isLoading: setsLoading } = useQuery({
    queryKey: ['sets'],
    queryFn: listSets,
    enabled: !!session,
  });

  const { data: continueTo } = useQuery({
    queryKey: ['continue'],
    queryFn: continueTarget,
    enabled: !!session,
  });

  // One query for the whole screen, not one per set.
  const { data: dueBySet } = useQuery({
    queryKey: ['due'],
    queryFn: () => dueCountsBySet(),
    enabled: !!session,
  });

  const hasKey = !!profile?.gemini_api_key;
  const continueSet = continueTo ? sets.find((s) => s.id === continueTo.studySetId) : undefined;

  return (
    <Screen>
      {/* The heading moved into the body when this became a tab. The stack
          header used to carry it, but a tab root has no back control and no
          header of its own, so the screen has to name itself. */}
      <Title>Study</Title>

      {!profileLoading && !hasKey ? (
        <Notice tone="warn">Add your Gemini key in Settings before making study sets.</Notice>
      ) : null}

      {/* Continue where you left off — one tap, no digging (D8). The retry
          count is what makes coming back feel worth it. */}
      {continueSet ? (
        <Pressable
          onPress={() =>
            router.push(
              continueTo!.missed > 0
                ? `/set/${continueTo!.studySetId}/flashcards?retry=1`
                : `/set/${continueTo!.studySetId}`,
            )
          }
        >
          <Card>
            <Body>Continue: {formatSetTitle(continueSet.title)}</Body>
            <Body muted>{describeContinue(continueTo!, dueBySet)}</Body>
          </Card>
        </Pressable>
      ) : null}

      <Button label="+ New set" onPress={() => router.push('/new')} />

      {setsLoading ? (
        <Body muted>Loading…</Body>
      ) : sets.length === 0 ? (
        <Card>
          <Body muted>No sets yet. Add some notes and we'll make cards from them.</Body>
        </Card>
      ) : (
        sets.map((set) => (
          <ListRow
            key={set.id}
            title={formatSetTitle(set.title)}
            meta={describeSet(set, dueBySet?.get(set.id) ?? 0)}
            onPress={() => router.push(`/set/${set.id}`)}
          />
        ))
      )}
      {/* Settings and Sign out used to sit here as full-width buttons, then as
          a header gear. Both are now the Settings tab. Sign out stays inside
          Settings, where it already was. View-level navigation does not belong
          in the content. */}
    </Screen>
  );
}

/**
 * What to say under "Continue: <set>".
 *
 * Due and missed are different things and both matter: due is the schedule
 * saying it is time, missed is the pile of things you got wrong. They are shown
 * together when both apply, and the fallback stays encouraging rather than
 * empty.
 */
function describeContinue(
  target: { studySetId: string; missed: number },
  dueBySet: Map<string, number> | undefined,
): string {
  const due = dueBySet?.get(target.studySetId) ?? 0;
  const parts: string[] = [];
  if (due > 0) parts.push(`${due} due today`);
  if (target.missed > 0) {
    parts.push(`${target.missed} card${target.missed === 1 ? '' : 's'} to retry`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'Nothing waiting — you are on top of this one';
}

/** "12 cards · Ready" — status alone did not say how much was in a set. */
function describeSet(set: StudySet, due: number): string {
  const status =
    set.status === 'generating'
      ? 'Still making cards…'
      : set.status === 'failed'
        ? "Didn't finish — open to try again"
        : set.status === 'empty'
          ? 'No cards yet'
          : 'Ready';

  if (set.cardCount === undefined || set.cardCount === 0) return status;
  const cards = `${set.cardCount} card${set.cardCount === 1 ? '' : 's'}`;
  // The due count replaces "Ready" when there is one: "12 due today" is the
  // more useful half of that line, and both together is more than a list row
  // should carry.
  return due > 0 ? `${cards} · ${due} due today` : `${cards} · ${status}`;
}
