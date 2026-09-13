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
import { deleteSet, getSet, updateSet } from '../../../src/data/sets';
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
  const { data: set, refetch: refetchSet } = useQuery({
    queryKey: ['set', setId],
    queryFn: () => getSet(setId),
  });
  const { data: itemCount = 0, refetch: refetchCount } = useQuery({
    queryKey: ['itemCount', setId],
    queryFn: () => countItems(setId),
    // Poll while cards are still arriving so they appear as sections finish.
    refetchInterval: set?.status === 'generating' ? 3000 : false,
  });
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
    setAssistantContext({
      kind: 'set',
      title: formatSetTitle(set.title),
      notes: trimNotes(pages.map((p) => p.text).join('\n\n')),
    });
  }, [set, pages, setAssistantContext]);
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
    if (set.status !== 'generating') return;
    started.current = true;
    setHasStarted(true);
    void run();
  }, [set, apiKey, run]);

  if (!set) {
    return (
      <Screen>
        <LoadingState />
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
          headerRight: () => (
            <OverflowMenu
              items={[
                { label: 'Add notes', onPress: () => router.push(`/new?setId=${setId}`) },
                { label: 'Rename set', onPress: () => setRenaming(set.title) },
                ...(hasFiles
                  ? [{ label: 'Free up space', onPress: () => setConfirmFree(true) }]
                  : []),
                { label: 'Delete set', destructive: true, onPress: () => setConfirmDelete(true) },
              ]}
            />
          ),
        }}
      />

      <Display>{displayTitle}</Display>

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

      {!apiKey && !isGenerating ? (
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
