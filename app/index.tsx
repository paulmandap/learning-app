import { useRouter } from 'expo-router';
import { Pressable } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { Body, Button, Card, ListRow, Notice, Screen } from '../src/ui/components';
import { fetchProfile } from '../src/data/profile';
import { listSets, type StudySet } from '../src/data/sets';
import { continueTarget } from '../src/data/attempts';
import { useSessionStore } from '../src/data/session';
import { formatSetTitle } from '../src/core/title';

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

  const hasKey = !!profile?.gemini_api_key;
  const continueSet = continueTo ? sets.find((s) => s.id === continueTo.studySetId) : undefined;

  return (
    <Screen>
      {/* No <Title> here: the navigation header already says "Study", and
          printing it twice wasted the first screenful. */}
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
            <Body muted>
              {continueTo!.missed > 0
                ? `${continueTo!.missed} card${continueTo!.missed === 1 ? '' : 's'} to retry`
                : 'Nothing to retry — you are on top of this one'}
            </Body>
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
            meta={describeSet(set)}
            onPress={() => router.push(`/set/${set.id}`)}
          />
        ))
      )}
      {/* Settings and Sign out used to sit here as full-width buttons. Settings
          is now the header gear; Sign out lives inside Settings, where it
          already was. View-level navigation does not belong in the content. */}
    </Screen>
  );
}

/** "12 cards · Ready" — status alone did not say how much was in a set. */
function describeSet(set: StudySet): string {
  const status =
    set.status === 'generating'
      ? 'Still making cards…'
      : set.status === 'failed'
        ? "Didn't finish — open to try again"
        : set.status === 'empty'
          ? 'No cards yet'
          : 'Ready';

  if (set.cardCount === undefined || set.cardCount === 0) return status;
  return `${set.cardCount} card${set.cardCount === 1 ? '' : 's'} · ${status}`;
}
