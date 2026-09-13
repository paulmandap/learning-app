import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  Label,
  ListRow,
  LoadingState,
  Notice,
  PillButton,
  Screen,
  SectionRow,
  TitleRow,
} from '../../src/ui/components';
import { NomiButton } from '../../src/ui/nomi';
import { fetchProfile } from '../../src/data/profile';
import { listSets, type StudySet } from '../../src/data/sets';
import { continueTarget } from '../../src/data/attempts';
import { dueCountsBySet } from '../../src/data/review';
import { useSessionStore } from '../../src/data/session';
import { formatSetTitle } from '../../src/core/title';

/**
 * Study — the tab you open to study.
 *
 * ## Continuing outranks creating
 *
 * This screen used to give its one filled button to "+ New set", with
 * "Continue" above it as a bordered card that was tappable but did not look it
 * — no chevron, no button, while every set row beneath it had a ›. So the
 * loudest thing on the screen you open every day was the thing you do once a
 * week, and the thing you came to do was the quietest (NOTES §35).
 *
 * Now Continue carries the one primary button, and "+ New set" is a compact
 * control beside the list it adds to. With nothing to continue — a new account
 * — making a set IS the thing to do, and it gets the primary button back.
 *
 * What Continue points at did not change: `continueTarget` is still "where you
 * left off", which §23.1 separated from Progress's "where the work is", and
 * §34 declined to replace with a recommendation.
 */
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
    // Wrapped, not passed by reference. listSets now takes an optional client
    // as its last argument (the Phase B seam, extended for Nomi), and TanStack
    // Query calls a bare queryFn with its own context object — which would
    // arrive as that argument and be used as a database client.
    queryFn: () => listSets(),
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
  const newSet = () => router.push('/new');

  return (
    <Screen>
      {/* The heading moved into the body when this became a tab. The stack
          header used to carry it, but a tab root has no back control and no
          header of its own, so the screen has to name itself.

          Nomi rides on that same row: with no navigator header there is nowhere
          else at the top of a tab for it to go, and the bottom corner is
          already the floating ✦ — which is the same companion, asked about
          whatever card is in front of you. */}
      <TitleRow title="Study" action={<NomiButton />} />

      {!profileLoading && !hasKey ? (
        <Notice tone="warn">Add your Gemini key in Settings before making study sets.</Notice>
      ) : null}

      {/* Continue where you left off — one tap, no digging (D8). The retry
          count is what makes coming back feel worth it, so when there IS a
          missed pile the button says so and goes straight to it. */}
      {continueSet && continueTo ? (
        <Card>
          <Label>Continue where you left off</Label>
          <Body strong>{formatSetTitle(continueSet.title)}</Body>
          <Body muted>{describeContinue(continueTo, dueBySet)}</Body>
          <Button
            label={continueTo.missed > 0 ? 'Retry what you missed' : 'Continue'}
            onPress={() =>
              router.push(
                continueTo.missed > 0
                  ? `/set/${continueTo.studySetId}/flashcards?retry=1`
                  : `/set/${continueTo.studySetId}`,
              )
            }
          />
        </Card>
      ) : null}

      {setsLoading ? (
        <LoadingState />
      ) : sets.length === 0 ? (
        <Card>
          <Body muted>No sets yet. Add some notes and we'll make cards from them.</Body>
          <Button label="+ New set" onPress={newSet} />
        </Card>
      ) : (
        <>
          <SectionRow title="Your sets" action={<PillButton label="+ New set" onPress={newSet} />} />
          {sets.map((set) => (
            <ListRow
              key={set.id}
              title={formatSetTitle(set.title)}
              meta={describeSet(set, dueBySet?.get(set.id) ?? 0)}
              onPress={() => router.push(`/set/${set.id}`)}
            />
          ))}
        </>
      )}
      {/* Settings and Sign out used to sit here as full-width buttons, then as
          a header gear. Both are now the Settings tab. Sign out stays inside
          Settings, where it already was. View-level navigation does not belong
          in the content. */}
    </Screen>
  );
}

/**
 * What to say under the set's name in the Continue card.
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
