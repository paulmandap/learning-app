import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  Field,
  ListRow,
  LoadingState,
  Notice,
  PillButton,
  Screen,
  SectionRow,
} from '../../src/ui/components';
import { GLYPH } from '../../src/ui/glyphs';
import { radius, space, type, useTheme } from '../../src/ui/theme';
import {
  folderMeta,
  folderOrder,
  groupSets,
  MAX_FOLDER_NAME,
  type Folder,
} from '../../src/core/folders';
import { createFolder, listFolders, moveSetToFolder } from '../../src/data/folders';
import { FolderSheet } from '../../src/ui/folder-sheet';
import { DraggableSet, DragToFolderProvider, DropFolder } from '../../src/ui/drag-to-folder';
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
 * Nomi — the tab you open to study. It was called Study until the owner renamed
 * it after the app (NOTES §40); the route and its icon are unchanged.
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
  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: () => listFolders(),
    enabled: !!session,
  });

  /**
   * The folder being looked at, on its own (NOTES §48).
   *
   * This replaced a set of open ids remembered in localStorage: folders used to
   * expand inline, and the owner asked for a focused view instead — *"instead
   * of drop down, it will be focused there like some sort of pop out ... then
   * the background is blurred so my focus is only at that folder."* One at a
   * time, so there is nothing to remember between visits.
   */
  const [openFolder, setOpenFolder] = useState<Folder | null>(null);
  /** The name being typed for a new folder, or null when not making one. */
  const [makingFolder, setMakingFolder] = useState<string | null>(null);
  const queryClient = useQueryClient();

  /** Dropping a set on a folder row. The undo is dragging it back out. */
  async function moveSet(setId: string, folderId: string) {
    try {
      await moveSetToFolder(setId, folderId);
      await queryClient.invalidateQueries({ queryKey: ['sets'] });
    } catch {
      // Best effort: a move that did not take leaves the set where it was, and
      // the list refreshes to show that. An error card over a drag would land
      // after the finger had already gone.
    }
  }

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

  // Into folders, keeping that order inside each one (NOTES §47). After
  // `ordered`, because `groupSets` distributes rather than sorts — deciding the
  // order here would quietly override `dueFirst`.
  const grouped = useMemo(() => groupSets(ordered, folderOrder(folders)), [ordered, folders]);

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
          {/* Both controls on the heading (NOTES §48). "+ New folder" was under
              the list, which is where you end up looking for it last — the
              owner: *"i don't like that new folder sits at the very bottom.
              move it beside the `new set`."* */}
          <SectionRow
            title="Your sets"
            action={
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <PillButton label="+ Folder" onPress={() => setMakingFolder('')} />
                <PillButton label="+ New set" onPress={newSet} />
              </View>
            }
          />

          {makingFolder !== null ? (
            <NewFolder
              value={makingFolder}
              onChange={setMakingFolder}
              onDone={() => setMakingFolder(null)}
            />
          ) : null}

          {/* Folders first, then everything in none. `groupSets` keeps the
              order it is given, so `dueFirst` still decides what leads.

              Wrapped in the drag provider: a drag starts on a set row and ends
              on a folder row, and neither can see the other. */}
          <DragToFolderProvider onDrop={(setId, folderId) => void moveSet(setId, folderId)}>
            {grouped.folders.map(({ folder, sets: inside }) => (
              <DropFolder key={folder.id} folderId={folder.id}>
                {(isOver) => (
                  <FolderRow
                    folder={folder}
                    sets={inside}
                    statsBySet={statsBySet}
                    isOver={isOver}
                    onPress={() => setOpenFolder(folder)}
                  />
                )}
              </DropFolder>
            ))}

            {grouped.loose.map((set) => {
              const stats = statsBySet.get(set.id);
              const cards = set.cardCount ?? 0;
              return (
                <DraggableSet key={set.id} setId={set.id} disabled={folders.length === 0}>
                  {(lifted, guard, overFolder) => (
                    <ListRow
                      title={formatSetTitle(set.title)}
                      meta={
                        lifted
                          ? overFolder
                            ? `Let go to put it in ${folders.find((f) => f.id === overFolder)?.name ?? 'this folder'}`
                            : 'Drop it on a folder'
                          : describeSet(set, stats?.due ?? 0)
                      }
                      progress={cards > 0 && stats ? stats.known / cards : undefined}
                      // Guarded: letting go of a drag often lands on the row it
                      // started from, and that must not open the set.
                      onPress={guard(() => router.push(`/set/${set.id}`))}
                    />
                  )}
                </DraggableSet>
              );
            })}
          </DragToFolderProvider>
        </>
      )}

      {/* The folder, with everything else out of the way. One sheet at a time:
          opening a subfolder replaces this one rather than stacking, which is
          what keeps two levels feeling like two levels. */}
      {openFolder ? (
        <FolderSheet
          folder={openFolder}
          folders={folders}
          sets={sets}
          statsBySet={statsBySet}
          onClose={() => setOpenFolder(null)}
          onOpenSet={(id) => {
            setOpenFolder(null);
            router.push(`/set/${id}`);
          }}
          onOpenFolder={setOpenFolder}
        />
      ) : null}
    </Screen>
  );
}

/**
 * A folder on the home list: a row that opens it, and a target to drop on.
 *
 * Counts its WHOLE tree — `groupSets` buckets a subfolder's sets onto their
 * top-level ancestor — so collapsing a folder hides the list and never the fact
 * that there is work inside it.
 */
function FolderRow({
  folder,
  sets,
  statsBySet,
  isOver,
  onPress,
}: {
  folder: Folder;
  sets: StudySet[];
  statsBySet: Map<string, { due: number; known: number }>;
  isOver: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  const due = sets.reduce((n, s) => n + (statsBySet.get(s.id)?.due ?? 0), 0);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${folder.name}, ${folderMeta(sets.length, due)}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.md,
        // Lit up while a set is held over it, which is the only thing telling
        // somebody mid-drag that letting go will do what they want.
        borderWidth: isOver ? 2 : 1,
        borderColor: isOver ? t.accent : t.border,
        backgroundColor: isOver ? t.card : t.card,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 18 }}>📁</Text>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
          {folder.name}
        </Text>
        <Text style={[type.caption, { color: isOver ? t.accent : t.textMuted }]}>
          {isOver ? 'Drop it in here' : folderMeta(sets.length, due)}
        </Text>
      </View>
      <Text style={{ color: t.textMuted, fontSize: 22 }}>{GLYPH.forward}</Text>
    </Pressable>
  );
}

/**
 * One folder, and the sets inside it.
 *
 * Collapsed by default, which is the "cleaner look" that was asked for — but
 * the row itself carries how many sets are in there and how many are due, so
 * collapsing hides the list and never the fact that there is work in it. A
 * folder that could silently hide five due cards would make the count on Home
 * wrong in the only way that matters.
 */
function FolderGroup({
  folder,
  open,
  onToggle,
  sets,
  statsBySet,
  onOpenSet,
}: {
  folder: Folder;
  open: boolean;
  onToggle: () => void;
  sets: StudySet[];
  statsBySet: Map<string, { due: number; known: number }>;
  onOpenSet: (id: string) => void;
}) {
  const t = useTheme();
  const due = sets.reduce((n, s) => n + (statsBySet.get(s.id)?.due ?? 0), 0);

  return (
    <View style={{ gap: space.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${folder.name}, ${folderMeta(sets.length, due)}`}
        onPress={onToggle}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          padding: space.md,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: t.border,
          backgroundColor: t.card,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        {/* The chevron turns rather than swapping character, so open and shut
            are the same shape in two positions — one glyph, no icon set. */}
        <Text
          style={{
            color: t.textMuted,
            fontSize: 20,
            transform: [{ rotate: open ? '90deg' : '0deg' }],
          }}
        >
          {GLYPH.forward}
        </Text>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[type.bodyStrong, { color: t.text }]} numberOfLines={1}>
            {folder.name}
          </Text>
          <Text style={[type.caption, { color: t.textMuted }]}>
            {folderMeta(sets.length, due)}
          </Text>
        </View>
      </Pressable>

      {open ? (
        // Indented, so a set inside a folder is visibly inside it rather than
        // merely after it.
        <View style={{ paddingLeft: space.lg, gap: space.sm }}>
          {sets.length === 0 ? (
            <Body muted>Nothing in here yet — move a set in from its ••• menu.</Body>
          ) : (
            sets.map((set) => {
              const stats = statsBySet.get(set.id);
              const cards = set.cardCount ?? 0;
              return (
                <ListRow
                  key={set.id}
                  title={formatSetTitle(set.title)}
                  meta={describeSet(set, stats?.due ?? 0)}
                  progress={cards > 0 && stats ? stats.known / cards : undefined}
                  onPress={() => onOpenSet(set.id)}
                />
              );
            })
          )}
        </View>
      ) : null}
    </View>
  );
}

/** Making one. Opened from the heading, so Home is not a form until asked. */
function NewFolder({
  value,
  onChange,
  onDone,
}: {
  value: string;
  onChange: (v: string) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await createFolder(value);
      await queryClient.invalidateQueries({ queryKey: ['folders'] });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't make that folder.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <Field
        label="Folder name"
        value={value}
        onChangeText={onChange}
        placeholder="Anatomy"
        autoCapitalize="sentences"
        maxLength={MAX_FOLDER_NAME}
      />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button label="Make the folder" onPress={save} busy={saving} />
      <Button label="Cancel" variant="secondary" onPress={onDone} disabled={saving} />
      <Body muted>Then hold a set and drag it in, or use "Move to folder" on the set.</Body>
    </Card>
  );
}

/**
 * Which folders this device had open.
 *
 * Wrapped in try/catch because localStorage is not always there — a private
 * window, cleared site data, a browser that refuses it — and a folder list that
 * will not render because it could not remember a chevron would be a poor
 * trade. Failing means "all shut", which is the default anyway.
 */
const OPEN_FOLDERS_KEY = 'nomi.openFolders';

function readOpenFolders(): Set<string> {
  try {
    const raw = globalThis.localStorage?.getItem(OPEN_FOLDERS_KEY);
    if (!raw) return new Set();
    const ids = JSON.parse(raw) as unknown;
    return Array.isArray(ids) ? new Set(ids.filter((i): i is string => typeof i === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeOpenFolders(open: Set<string>): void {
  try {
    globalThis.localStorage?.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...open]));
  } catch {
    // A preference that could not be saved is not worth an error on screen.
  }
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
