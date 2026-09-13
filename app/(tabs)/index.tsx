import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { ListRow, LoadingState, Notice, PillButton, Screen, SectionRow } from '../../src/ui/components';
import { StatePanel } from '../../src/ui/states';
import { NomiCard } from '../../src/ui/nomi';
import { ContinueCard, GreetingHeader } from '../../src/ui/home';
import { fetchProfile } from '../../src/data/profile';
import { listSets, type StudySet } from '../../src/data/sets';
import { continueTarget } from '../../src/data/attempts';
import { getAppSnapshot } from '../../src/data/nomi';
import { useSessionStore } from '../../src/data/session';
import { formatSetTitle } from '../../src/core/title';
import { greetingName } from '../../src/core/avatar';
import { homeLine } from '../../src/core/nomi-brain';
import { dueFirst } from '../../src/core/set-order';

/**
 * Study — the tab you open to study.
 *
 * ## Laid out from the owner's reference (NOTES §36, §37)
 *
 *  - **"Welcome back, <name>" and their picture**, top left and top right.
 *  - **Nomi with a speech bubble**, thinking for a moment and then typing the
 *    most useful true thing it knows — like the companion in the owner's
 *    second reference, whose line sits in a chat bubble beside it.
 *  - **Continue, shaded**, with its heading above it and the set's progress in
 *    it, holding the screen's one filled button.
 *  - **Your sets**, each with how much of it is known — the ones with cards due
 *    today first, back in their place once those are answered.
 *
 * ## Continuing outranks creating
 *
 * Continue carries the one primary button; "+ New set" is a compact control
 * beside the list it adds to. With nothing to continue, a new account gets the
 * primary "+ New set" back, in the drawn empty state. What Continue points at
 * did not change: `continueTarget` is still "where you left off" (§23.1, §34).
 */
export default function Home() {
  const router = useRouter();
  const session = useSessionStore((s) => s.session);
  const userId = session?.user.id ?? '';

  const { data: profile, isLoading: profileLoading } = useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
    enabled: !!session,
  });
  const { data: sets = [], isLoading: setsLoading } = useQuery({
    queryKey: ['sets'],
    // Wrapped, not passed by reference: TanStack Query would hand its own
    // context object to listSets' optional client parameter.
    queryFn: () => listSets(),
    enabled: !!session,
  });

  // Both refetch when the app comes back to the front. An installed app is
  // reopened rather than relaunched, and "due today" is a statement about a day
  // — without this the morning's Home still said last night's number. Finishing
  // a deck refreshes them too, through useStudySession (NOTES §36).
  const { data: continueTo } = useQuery({
    queryKey: ['continue'],
    queryFn: continueTarget,
    enabled: !!session,
    refetchOnWindowFocus: true,
  });

  // What Nomi knows — and, from the same round of queries, each set's due,
  // missed and known counts. One source for Nomi's line, the Continue card's
  // progress, every row's bar and the order of the list, so none can disagree.
  const { data: snapshot, isSuccess: knowsStudent } = useQuery({
    queryKey: ['nomi-brain'],
    queryFn: () => getAppSnapshot(),
    enabled: !!session,
    refetchOnWindowFocus: true,
  });

  const statsBySet = new Map((snapshot?.sets ?? []).map((s) => [s.id, s]));
  const hasKey = !!profile?.gemini_api_key;
  const continueSet = continueTo ? sets.find((s) => s.id === continueTo.studySetId) : undefined;
  const continueStats = continueSet ? statsBySet.get(continueSet.id) : undefined;
  const newSet = () => router.push('/new');

  // "the ones that are due today sits at the top, then after answering, it will
  // go back to its original position" — the owner (NOTES §37). A stable move,
  // not a sort: nothing else in the list changes place.
  const ordered = dueFirst(sets, new Map((snapshot?.sets ?? []).map((s) => [s.id, s.due])));

  return (
    <Screen>
      <GreetingHeader
        name={greetingName(profile?.display_name)}
        avatar={profile?.avatar}
        userId={userId}
        onAvatar={() => router.push('/settings')}
      />

      {/* Only once Nomi actually knows something: a line computed from an
          empty snapshot would say "add some notes" to someone with nine sets
          for the second it took to load. */}
      {knowsStudent && snapshot ? (
        <NomiCard line={homeLine(snapshot)} onPress={() => router.push('/nomi')} />
      ) : null}

      {!profileLoading && !hasKey ? (
        <Notice tone="warn">Add your Gemini key in Settings before making study sets.</Notice>
      ) : null}

      {/* Continue where you left off — one tap, no digging (D8). When there
          is a missed pile the button says so and goes straight to it. */}
      {continueSet && continueTo ? (
        <>
          <SectionRow title="Continue where you left off" />
          <ContinueCard
            title={formatSetTitle(continueSet.title)}
            meta={describeContinue(continueTo, continueStats?.due ?? 0)}
            known={continueStats?.known ?? 0}
            cards={continueSet.cardCount ?? 0}
            actionLabel={continueTo.missed > 0 ? 'Retry what you missed' : 'Continue studying'}
            onPress={() =>
              router.push(
                continueTo.missed > 0
                  ? `/set/${continueTo.studySetId}/flashcards?retry=1`
                  : `/set/${continueTo.studySetId}`,
              )
            }
          />
        </>
      ) : null}

      {setsLoading ? (
        <LoadingState />
      ) : sets.length === 0 ? (
        <StatePanel kind="empty"
          title="Add your first notes to begin"
          detail="Paste your notes or choose a file, and they become flashcards."
          action={{ label: '+ New set', onPress: newSet }}
        />
      ) : (
        <>
          <SectionRow title="Your sets" action={<PillButton label="+ New set" onPress={newSet} />} />
          {ordered.map((set) => {
            const stats = statsBySet.get(set.id);
            const cards = set.cardCount ?? 0;
            return (
              <ListRow
                key={set.id}
                title={formatSetTitle(set.title)}
                meta={describeSet(set, stats?.due ?? 0)}
                progress={cards > 0 && stats ? stats.known / cards : undefined}
                onPress={() => router.push(`/set/${set.id}`)}
              />
            );
          })}
        </>
      )}
    </Screen>
  );
}

/**
 * What to say under the set's name in the Continue card.
 *
 * Due and missed are different things and both matter: due is the schedule
 * saying it is time, missed is the pile of things you got wrong.
 */
function describeContinue(target: { missed: number }, due: number): string {
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
  return due > 0 ? `${cards} · ${due} due today` : `${cards} · ${status}`;
}
