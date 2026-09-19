import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  Display,
  Field,
  Label,
  LoadingState,
  Notice,
  OptionList,
  Screen,
} from '../../../src/ui/components';
import { StatePanel } from '../../../src/ui/states';
import { OverflowMenu } from '../../../src/ui/menu';
import { space } from '../../../src/ui/theme';
import { formatSetTitle } from '../../../src/core/title';
import { fetchProfile } from '../../../src/data/profile';
import { deleteSet, updateSet } from '../../../src/data/sets';
import {
  myStars,
  readableSet,
  setVisibility,
  star,
  unstar,
  visibilityOf,
} from '../../../src/data/community';
import { folderOfSet, listFolders, moveSetToFolder } from '../../../src/data/folders';
import { folderOrder } from '../../../src/core/folders';
import {
  authorName,
  SHARING_FACTS,
  SHARING_TITLE,
  starLabel,
  UNSHARING_NOTE,
} from '../../../src/core/community';
import { freeUpSpace, listDocuments, pagesForSet } from '../../../src/data/documents';
import { formatBytes } from '../../../src/core/storage';
import { useAssistantContext } from '../../../src/data/assistant-context';
import { trimNotes } from '../../../src/core/chat';
import { countItems } from '../../../src/data/items';
import { dueCountForSet, dueLevelsForSet } from '../../../src/data/review';
import { busiestLevel } from '../../../src/core/deck';
import { generateSet, type Progress } from '../../../src/data/pipeline';

/** Said when a run ended badly and did not say why. */
const GENERIC_FAILURE = 'Something went wrong making cards. Your finished cards are saved.';

/**
 * One screen for both "Preparing" and "Set ready" — which one you see depends
 * on the set's status, not on how you got here.
 *
 * Landing here with status 'generating' RESUMES generation rather than starting
 * over, because completed sections are recorded on the plan. That is what makes
 * a refresh mid-generation cost nothing.
 */
export default function SetScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const setId = String(id);

  const [progress, setProgress] = useState<Progress | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmFree, setConfirmFree] = useState(false);
  const [freeing, setFreeing] = useState(false);
  const [freed, setFreed] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Why making cards stopped, kept apart from rename/free/delete errors. */
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // null = not renaming. Holds the RAW stored title while editing, not the
  // formatted one, so opening and saving without typing is a no-op rather than
  // quietly overwriting the original with its prettified version.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  /** null = not asking. 'public' = about to share; 'private' = about to stop. */
  const [confirmShare, setConfirmShare] = useState<'public' | 'private' | null>(null);
  const [sharing, setSharing] = useState(false);
  const [starring, setStarring] = useState(false);
  /** Choosing a folder for this set (NOTES §47). */
  const [moving, setMoving] = useState(false);
  const [movingTo, setMovingTo] = useState(false);
  /**
   * Has this mount already kicked generation off?
   *
   * Two copies of one fact, and both are load-bearing:
   *
   *  - **The ref is the guard.** It is set synchronously, so an effect that runs
   *    twice before React commits anything still starts one run. A state flag
   *    cannot do that job — the setter is asynchronous, so the second pass would
   *    read the old value and start a second `generateSet` over the same set.
   *  - **The state is what renders.** "Keep going" used to test `started.current`
   *    during render, and mutating a ref schedules nothing, so the button's
   *    visibility depended on whether some unrelated state happened to re-render
   *    the screen afterwards. It could sit there through a run that had already
   *    begun, or vanish correctly, with nothing in the code deciding which.
   */
  const started = useRef(false);
  const [hasStarted, setHasStarted] = useState(false);

  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  /**
   * The set, and whether it is the caller's.
   *
   * `readableSet` asks study_sets first and the public_sets view second, so this
   * one query opens both your own set and one somebody shared — and `owned` is
   * the single fact every conditional below reads. Deriving "is it mine?" more
   * than once is how a screen ends up offering Delete on a stranger's set.
   */
  const { data: readable, isLoading: setLoading, refetch: refetchSet } = useQuery({
    queryKey: ['set', setId],
    queryFn: () => readableSet(setId),
  });
  const set = readable?.set ?? null;
  const owned = readable?.owned ?? true;

  /** Folders to move this set into, and which one it is in now (NOTES §47). */
  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: () => listFolders(),
    enabled: owned,
  });
  const { data: currentFolderId = null } = useQuery({
    queryKey: ['set-folder', setId],
    queryFn: () => folderOfSet(setId),
    enabled: owned,
  });

  /** Is this set of mine shared? Only asked about a set that is mine. */
  const { data: visibility = 'private' } = useQuery({
    queryKey: ['visibility', setId],
    queryFn: () => visibilityOf(setId),
    enabled: owned,
  });

  // On a set somebody shared: have I starred it? One row, and it also tells the
  // star control what to draw before anything is tapped.
  const { data: starred } = useQuery({
    queryKey: ['my-stars'],
    queryFn: () => myStars(),
    enabled: !owned,
  });
  const { data: ownCount = 0, refetch: refetchCount } = useQuery({
    queryKey: ['itemCount', setId],
    queryFn: () => countItems(setId),
    // Only for a set of your own: countItems reads study_items, which is
    // select-own, so on a shared set it would answer 0 — and 0 is the number
    // that hides every "Study this set" row on the screen below. The shared
    // set's own count comes from the public_sets view instead, which counts as
    // its owner and already excludes reported cards.
    enabled: owned,
    // Poll while cards are still arriving so they appear as sections finish.
    refetchInterval: set?.status === 'generating' ? 3000 : false,
  });
  const itemCount = owned ? ownCount : (readable?.owner?.cards ?? 0);
  const { data: docs = [] } = useQuery({
    queryKey: ['docs', setId],
    queryFn: () => listDocuments(setId),
  });
  const { data: dueCount = 0 } = useQuery({
    queryKey: ['due', setId],
    queryFn: () => dueCountForSet(setId),
  });
  // Which level those due cards are at, so the Flashcards row opens a deck that
  // has them in it. Under ['due'], so leaving a deck refreshes it with the rest.
  const { data: dueLevels = {} } = useQuery({
    queryKey: ['due', setId, 'levels'],
    queryFn: () => dueLevelsForSet(setId),
  });

  const apiKey = profile?.gemini_api_key ?? '';

  // The assistant answers from this set's notes while you are on its screen.
  // Fetched lazily and trimmed to a budget — the whole point of the cap is that
  // one question must not carry a whole document (src/core/chat.ts).
  const { data: pages = [] } = useQuery({
    queryKey: ['pages', setId],
    queryFn: () => pagesForSet(setId),
  });
  const setAssistantContext = useAssistantContext((s) => s.setContext);
  const clearAssistantContext = useAssistantContext((s) => s.clearContext);
  useEffect(() => {
    if (!set) return;
    // Only for a set of your own. `pagesForSet` reads document_pages, which is
    // select-own and always will be — a shared set publishes its cards, not the
    // notes behind them. Setting a set context with no notes in it would have
    // Nomi answering "about this set" from nothing, confidently, which NOTES
    // §36 records costing an afternoon the last time it happened.
    if (!owned) return;
    setAssistantContext({
      kind: 'set',
      title: formatSetTitle(set.title),
      notes: trimNotes(pages.map((p) => p.text).join('\n\n')),
    });
  }, [set, owned, pages, setAssistantContext]);
  useEffect(() => clearAssistantContext, [clearAssistantContext]);

  async function saveName() {
    const next = (renaming ?? '').trim();
    if (!next) {
      setRenaming(null);
      return;
    }
    setSavingName(true);
    try {
      await updateSet(setId, { title: next });
      await refetchSet();
      // The home list shows titles too, so it has to be told.
      await queryClient.invalidateQueries({ queryKey: ['sets'] });
      setRenaming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename that set.");
    } finally {
      setSavingName(false);
    }
  }

  /**
   * Give back the storage without giving up the studying.
   *
   * What fills a 1 GB bucket is the PDF; the cards, answers and schedules made
   * from it are kilobytes in a different quota. So "I need space" never has to
   * mean "delete my set" — see freeUpSpace in src/data/documents.ts.
   */
  async function free() {
    setFreeing(true);
    try {
      const bytes = await freeUpSpace(setId);
      setFreed(bytes);
      setConfirmFree(false);
      await queryClient.invalidateQueries({ queryKey: ['docs', setId] });
      await queryClient.invalidateQueries({ queryKey: ['storageUsed'] });
      await queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't free up space just now.");
    } finally {
      setFreeing(false);
    }
  }

  /**
   * Share this set with everyone, or stop.
   *
   * Never from the menu directly: the menu opens the card that says what
   * sharing exposes, and this runs only after that is confirmed. `SHARING_FACTS`
   * is the list, and `tests/community.test.ts` holds every claim in it to what
   * migration 0021's views actually do.
   */
  async function applyVisibility(next: 'public' | 'private') {
    setSharing(true);
    try {
      await setVisibility(setId, next);
      await queryClient.invalidateQueries({ queryKey: ['visibility', setId] });
      // The Community tab lists and ranks from this, so it has to be told.
      await queryClient.invalidateQueries({ queryKey: ['public-sets'] });
      setConfirmShare(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't change who can see this set.");
    } finally {
      setSharing(false);
    }
  }

  /**
   * Put this set in a folder, or take it out of one.
   *
   * By tapping, not dragging — `src/core/folders.ts` records why. Choosing
   * again is how it is undone, so nothing here needs a confirmation: the
   * action is reversible and destroys nothing.
   */
  async function moveTo(folderId: string | null) {
    setMovingTo(true);
    try {
      await moveSetToFolder(setId, folderId);
      // Home groups from these two.
      await queryClient.invalidateQueries({ queryKey: ['sets'] });
      await queryClient.invalidateQueries({ queryKey: ['folders'] });
      setMoving(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't move that set.");
    } finally {
      setMovingTo(false);
    }
  }

  /** Star a set somebody shared, or take the star back. */
  async function toggleStar() {
    const on = starred?.has(setId) ?? false;
    setStarring(true);
    try {
      await (on ? unstar(setId) : star(setId));
      await queryClient.invalidateQueries({ queryKey: ['my-stars'] });
      await queryClient.invalidateQueries({ queryKey: ['set', setId] });
      await queryClient.invalidateQueries({ queryKey: ['public-sets'] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't do that just now.");
    } finally {
      setStarring(false);
    }
  }

  async function removeSet() {
    setDeleting(true);
    try {
      await deleteSet(setId);
      await queryClient.invalidateQueries();
      router.replace('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't delete that set.");
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const run = useCallback(async () => {
    if (!apiKey) return;
    setRunError(null);
    setProgress(null);
    setRunning(true);
    try {
      await generateSet({ setId, apiKey, onProgress: setProgress });
    } catch (err) {
      setRunError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setRunning(false);
      await refetchSet();
      await refetchCount();
      await queryClient.invalidateQueries({ queryKey: ['items', setId] });
      await queryClient.invalidateQueries({ queryKey: ['sets'] });
    }
  }, [apiKey, setId, refetchSet, refetchCount, queryClient]);

  useEffect(() => {
    if (started.current) return;
    if (!set || !apiKey) return;
    // Never on somebody else's set. `readableSet` reports a shared set as
    // 'ready' so this could not fire anyway, but making cards for a set you do
    // not own would spend YOUR Gemini quota writing rows RLS would then refuse,
    // and that is worth refusing here rather than relying on a status.
    if (!owned) return;
    if (set.status !== 'generating') return;
    started.current = true;
    setHasStarted(true);
    void run();
  }, [set, owned, apiKey, run]);

  if (!set) {
    // Neither yours nor shared. The same answer for "no such set" and "it
    // exists and is private" — telling them apart would tell a stranger which
    // set ids are real.
    return (
      <Screen>
        {setLoading ? (
          <LoadingState />
        ) : (
          <StatePanel
            kind="problem"
            title="This set isn't here"
            detail="It may have been deleted, or the person who made it stopped sharing it."
            action={{ label: 'Back to Community', onPress: () => router.replace('/community') }}
          />
        )}
      </Screen>
    );
  }

  const plan = set.plan;
  const unreadable = plan?.unreadablePages ?? [];
  const isGenerating = set.status === 'generating';
  const requested = plan?.requestedCount ?? 0;
  // A run that ended badly carries its reason on its last event.
  const problem = runError ?? (!running && progress?.phase === 'failed' ? (progress.message ?? GENERIC_FAILURE) : null);

  const displayTitle = formatSetTitle(set.title);
  // "Free up space" only appears while there is space to free — once the
  // originals are gone, offering it again would be an action that does nothing.
  const hasFiles = docs.some((d) => d.storage_path);
  // Where "7 due" actually is. Null opens the deck on its usual default.
  const dueLevel = dueCount > 0 ? busiestLevel(dueLevels) : null;
  const studyNow = () =>
    router.push(dueLevel ? `/set/${setId}/flashcards?level=${dueLevel}` : `/set/${setId}/flashcards`);

  return (
    <Screen>
      {/* The header carries the set's name and the ••• menu, so neither the
          title nor the set-level actions take up content space. */}
      <Stack.Screen
        options={{
          // Empty on purpose. Set names are long ("Animal biology study
          // reviewer") and a centred header title collided with the back
          // control and the ••• on the same line. The title moves into the body
          // as a large heading, iOS-style, where it can wrap freely.
          title: '',
          // Every item here writes to the set, so on a set somebody shared
          // there is nothing to put in the menu and it is left off entirely. An
          // empty ••• that opens onto nothing is worse than no •••; and RLS
          // would refuse each of these silently — `reportItem` in particular
          // updates no rows and returns no error.
          headerRight: owned
            ? () => (
                <OverflowMenu
                  items={[
                    { label: 'Add notes', onPress: () => router.push(`/new?setId=${setId}`) },
                    { label: 'Rename set', onPress: () => setRenaming(set.title) },
                    // Only once there is somewhere to move it to. A menu item
                    // that opens a list of no folders is a dead end; the way to
                    // make one is on Home, beside the list it groups.
                    ...(folders.length > 0
                      ? [{ label: 'Move to folder', onPress: () => setMoving(true) }]
                      : []),
                    // Only once there are cards to share. `public_sets` filters
                    // on status = 'ready', so sharing a set still being made
                    // would appear to work and then show nothing to anybody.
                    ...(set.status === 'ready'
                      ? [
                          visibility === 'public'
                            ? { label: 'Stop sharing', onPress: () => setConfirmShare('private') }
                            : { label: 'Share with everyone', onPress: () => setConfirmShare('public') },
                        ]
                      : []),
                    ...(hasFiles
                      ? [{ label: 'Free up space', onPress: () => setConfirmFree(true) }]
                      : []),
                    { label: 'Delete set', destructive: true, onPress: () => setConfirmDelete(true) },
                  ]}
                />
              )
            : undefined,
        }}
      />

      <Display>{displayTitle}</Display>

      {/* A set somebody shared: who made it, and the star. Above everything
          else, because "whose is this?" is the first question about a set that
          is not yours, and studying it without knowing is how a stranger's
          mistake becomes something you learned. */}
      {!owned && readable?.owner ? (
        <Card>
          <Body>
            Shared by {authorName(readable.owner.owner_name)} · {starLabel(readable.owner.stars)}
          </Body>
          <Body muted>
            These are their cards, made from their notes. You study them here and your answers,
            streak and review dates are your own.
          </Body>
          <Button
            label={starred?.has(setId) ? 'Remove your star' : 'Star this set'}
            variant="secondary"
            onPress={toggleStar}
            busy={starring}
          />
        </Card>
      ) : null}

      {/* What sharing exposes, before it is shared — not after.
          Every line is checked against migration 0021's views in
          tests/community.test.ts; a privacy promise with no check behind it is
          a wish, the same rule as "the prompt asks; the validator checks". */}
      {confirmShare === 'public' ? (
        <Card>
          <Label>{SHARING_TITLE}</Label>
          {SHARING_FACTS.map((fact) => (
            <Body key={fact}>• {fact}</Body>
          ))}
          <Button label="Share it" onPress={() => applyVisibility('public')} busy={sharing} />
          <Button label="Keep it to myself" variant="secondary" onPress={() => setConfirmShare(null)} />
        </Card>
      ) : null}

      {confirmShare === 'private' ? (
        <Card>
          <Notice tone="warn">
            Stop sharing "{displayTitle}"? {UNSHARING_NOTE}
          </Notice>
          <Button label="Stop sharing" onPress={() => applyVisibility('private')} busy={sharing} />
          <Button label="Keep sharing" variant="secondary" onPress={() => setConfirmShare(null)} />
        </Card>
      ) : null}

      {moving ? (
        <Card>
          <Label>Move this set</Label>
          <OptionList
            options={[
              ...folderOrder(folders).map((f) => ({
                key: f.id,
                title: f.name,
                detail: f.id === currentFolderId ? "It's already in here" : 'Move it into this folder',
                onPress: () => void moveTo(f.id),
              })),
              {
                key: 'none',
                title: 'No folder',
                detail: 'Show it on its own under Your sets',
                onPress: () => void moveTo(null),
              },
            ]}
          />
          <Button
            label="Cancel"
            variant="secondary"
            onPress={() => setMoving(false)}
            disabled={movingTo}
          />
        </Card>
      ) : null}

      {renaming !== null ? (
        <Card>
          <Field
            label="Set name"
            value={renaming}
            onChangeText={setRenaming}
            placeholder="Cardiac Conduction"
            autoCapitalize="sentences"
          />
          <Button label="Save name" onPress={saveName} busy={savingName} />
          <Button label="Cancel" variant="secondary" onPress={() => setRenaming(null)} />
        </Card>
      ) : null}

      {/* Delete asks before acting, as it always did — the menu changed WHERE
          it lives, not how much friction it carries. */}
      {confirmFree ? (
        <Card>
          <Notice tone="warn">
            Remove the original file for "{displayTitle}"? Every card, answer and review date is
            kept — you just won't be able to open the file it came from.
          </Notice>
          <Button label="Yes, free up the space" onPress={free} busy={freeing} />
          <Button label="Keep the file" variant="secondary" onPress={() => setConfirmFree(false)} />
        </Card>
      ) : null}

      {freed !== null ? (
        <Notice tone="ok">
          Freed {formatBytes(freed)}. Your cards and progress are untouched.
        </Notice>
      ) : null}

      {confirmDelete ? (
        <Card>
          <Notice tone="error">
            Delete "{displayTitle}" and everything in it? This cannot be undone.
          </Notice>
          <Button label="Yes, delete this set" onPress={removeSet} busy={deleting} />
          <Button label="Keep it" variant="secondary" onPress={() => setConfirmDelete(false)} />
        </Card>
      ) : null}

      {/* Making cards, and what went wrong if it stopped — from the owner's
          reference (NOTES §37). The failure used to be an amber strip inside
          the same "Making cards…" card, so the screen said two opposite things
          at once. Now it is one or the other.

          "We left out 12 cards: …" and "Your notes supported N good ones" are
          gone at the owner's request: the pipeline makes the count asked for. */}
      {isGenerating ? (
        !apiKey ? (
          <StatePanel kind="problem"
            title="Add your Gemini key first"
            detail="Your cards are made with your own free key. Add it in Settings, then come back to this set."
            action={{ label: 'Open Settings', onPress: () => router.push('/settings') }}
          />
        ) : problem ? (
          <StatePanel kind="problem"
            title="Couldn't make your cards"
            detail={problem}
            action={{ label: 'Retry', onPress: () => void run(), busy: running }}
            secondary={itemCount > 0 ? { label: `Study the ${itemCount} ready`, onPress: studyNow } : undefined}
          />
        ) : (
          <StatePanel kind="working"
            title={progress?.phase === 'reading' ? 'Reading your notes' : 'Making your flashcards'}
            detail={
              itemCount > 0
                ? `${itemCount}${requested > itemCount ? ` of ${requested}` : ''} ready. You can start on these while the rest are made.`
                : 'Your first cards will appear here shortly.'
            }
            action={itemCount > 0 ? { label: 'Start studying', onPress: studyNow } : undefined}
          />
        )
      ) : (
        // Metadata, not a container. A muted line under the title says how many
        // and gets out of the way of the actions below it.
        <Body muted>
          {itemCount} card{itemCount === 1 ? '' : 's'}
          {dueCount > 0 ? ` · ${dueCount} due today` : ' · Ready'}
          {/* Standing state, on the set itself rather than only behind the •••.
              Somebody has to be able to tell at a glance that four other people
              can read this, without opening a menu to find out. */}
          {owned && visibility === 'public' ? ' · Shared with everyone' : ''}
        </Body>
      )}

      {/* Three ways to study the same cards, as a choice between peers.

          They were three stacked buttons, one filled and two outlined, which
          ranked them — "Flashcards, and two lesser things" — and gave none of
          them room to say what it is like. As rows, each one says it, and the
          due count sits on Flashcards because that deck deals due cards first
          (NOTES §35). "Add notes" moved into the ••• menu.

          "Fill in the blanks" is listed unconditionally alongside them. Knowing
          whether a set HAS any blanks means reading every item and running the
          cloze rules over it, which is a query and a pass this screen does not
          otherwise need — and the screen it opens explains an empty level
          better than a missing row would. */}
      {itemCount > 0 ? (
        <View style={{ gap: space.sm }}>
          <Label>Study this set</Label>
          <OptionList
            options={[
              {
                key: 'flashcards',
                title: 'Flashcards',
                detail: 'Turn each card over and say whether you knew it.',
                badge: dueCount > 0 ? `${dueCount} due` : undefined,
                onPress: () =>
                  router.push(
                    dueLevel
                      ? `/set/${setId}/flashcards?level=${dueLevel}`
                      : `/set/${setId}/flashcards`,
                  ),
              },
              {
                key: 'quiz',
                title: 'Quiz',
                detail: 'Choose or write the answer, and it gets marked.',
                onPress: () => router.push(`/set/${setId}/quiz`),
              },
              {
                key: 'blanks',
                title: 'Fill in the blanks',
                detail: 'Type the missing words back into a line of your notes.',
                onPress: () => router.push(`/set/${setId}/blanks`),
              },
            ]}
          />
        </View>
      ) : null}

      {unreadable.length > 0 ? (
        <Notice tone="warn">
          We couldn't read {unreadable.length === 1 ? 'page' : 'pages'}{' '}
          {unreadable.map((p) => p + 1).join(', ')}. {unreadable.length === 1 ? 'It was' : 'They were'}{' '}
          too blurry or dark, so we left {unreadable.length === 1 ? 'it' : 'them'} out rather than
          guessing.
        </Notice>
      ) : null}

      {docs.some((d) => d.status === 'failed') ? (
        <Notice tone="error">One of your files couldn't be read. You can try adding it again.</Notice>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}

      {/* Only on a set of your own. You never make cards for somebody else's
          set — the pipeline is gated on `owned` too — so telling a visitor to
          go and add a key is an instruction they cannot act on and would not
          benefit from if they did. Found by photographing the shared set
          screen; nothing else would have caught it. */}
      {owned && !apiKey && !isGenerating ? (
        <Notice tone="error">Add your Gemini key in Settings before making cards.</Notice>
      ) : null}

      {/* Reads the state, never the ref — see the note on `started`. This is
          the manual way in when the automatic one could not take it: coming
          back to a set left half-made, with a key, before the run began. */}
      {isGenerating && apiKey && !hasStarted ? <Button label="Keep going" onPress={run} /> : null}

      {/* The Home button is gone, and Delete no longer sits underneath where it
          was — the header back chevron handles navigation, and Delete lives in
          the ••• menu. That pairing was the accidental-deletion risk. */}
    </Screen>
  );
}
