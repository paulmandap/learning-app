import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Display, Field, Notice, Screen } from '../../../src/ui/components';
import { OverflowMenu } from '../../../src/ui/menu';
import { space } from '../../../src/ui/theme';
import { formatSetTitle } from '../../../src/core/title';
import { fetchProfile } from '../../../src/data/profile';
import { deleteSet, getSet, updateSet } from '../../../src/data/sets';
import { describeDrops } from '../../../src/core/validate';
import { listDocuments } from '../../../src/data/documents';
import { countItems } from '../../../src/data/items';
import { dueCountForSet } from '../../../src/data/review';
import { generateSet, type Progress } from '../../../src/data/pipeline';

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
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // null = not renaming. Holds the RAW stored title while editing, not the
  // formatted one, so opening and saving without typing is a no-op rather than
  // quietly overwriting the original with its prettified version.
  const [renaming, setRenaming] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const started = useRef(false);

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

  const apiKey = profile?.gemini_api_key ?? '';

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
    setError(null);
    try {
      await generateSet({ setId, apiKey, onProgress: setProgress });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      await refetchSet();
      await refetchCount();
      await queryClient.invalidateQueries({ queryKey: ['items', setId] });
    }
  }, [apiKey, setId, refetchSet, refetchCount, queryClient]);

  useEffect(() => {
    if (started.current) return;
    if (!set || !apiKey) return;
    if (set.status !== 'generating') return;
    started.current = true;
    void run();
  }, [set, apiKey, run]);

  if (!set) {
    return (
      <Screen>
        <Body muted>Loading…</Body>
      </Screen>
    );
  }

  const plan = set.plan;
  const unreadable = plan?.unreadablePages ?? [];
  const droppedLine = plan?.droppedSummary ? describeDrops(plan.droppedSummary) : null;
  const isGenerating = set.status === 'generating';

  const displayTitle = formatSetTitle(set.title);

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
      {confirmDelete ? (
        <Card>
          <Notice tone="error">
            Delete "{displayTitle}" and everything in it? This cannot be undone.
          </Notice>
          <Button label="Yes, delete this set" onPress={removeSet} busy={deleting} />
          <Button label="Keep it" variant="secondary" onPress={() => setConfirmDelete(false)} />
        </Card>
      ) : null}

      {isGenerating ? (
        <Card>
          <Body>
            {progress?.phase === 'reading'
              ? 'Reading your notes…'
              : progress?.sectionsTotal
                ? `Making cards… ${progress.sectionsDone ?? 0} of ${progress.sectionsTotal} parts`
                : 'Getting started…'}
          </Body>
          <Body muted>
            {itemCount > 0
              ? `${itemCount} card${itemCount === 1 ? '' : 's'} ready so far — you can start as soon as the first ones appear.`
              : 'Your first cards will appear here shortly.'}
          </Body>
          {progress?.message ? <Notice tone="warn">{progress.message}</Notice> : null}
        </Card>
      ) : (
        // Metadata, not a container. This was a bordered Card holding one short
        // sentence, which read as a disabled text input and pushed the actual
        // actions down the screen. A muted line under the title says the same
        // thing and gets out of the way.
        <View style={{ gap: space.xs }}>
          <Body muted>
            {itemCount} card{itemCount === 1 ? '' : 's'}
            {dueCount > 0 ? ` · ${dueCount} due today` : ' · Ready'}
          </Body>
          {plan && itemCount < plan.requestedCount ? (
            <Body muted>
              You asked for up to {plan.requestedCount}. Your notes supported {itemCount} good
              ones, and we'd rather stop than pad.
            </Body>
          ) : null}
          {/* Only rendered when cards were actually left out, so a clean run
              shows nothing extra. This is the "why 19 of 20?" answer. */}
          {droppedLine ? <Body muted>{droppedLine}</Body> : null}
        </View>
      )}

      {/* One primary action. Flashcards is the main flow, so Quiz is an
          outlined alternative rather than a second equal-weight blue block.
          "Add notes" moved into the ••• menu. */}
      {itemCount > 0 ? (
        <View style={{ gap: 8 }}>
          <Button label="Flashcards" onPress={() => router.push(`/set/${setId}/flashcards`)} />
          <Button
            label="Quiz"
            variant="outline"
            onPress={() => router.push(`/set/${setId}/quiz`)}
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

      {!apiKey ? (
        <Notice tone="error">Add your Gemini key in Settings before making cards.</Notice>
      ) : null}

      {isGenerating && !started.current ? (
        <Button label="Keep going" onPress={run} />
      ) : null}

      {/* The Home button is gone, and Delete no longer sits underneath where it
          was — the header back chevron handles navigation, and Delete lives in
          the ••• menu. That pairing was the accidental-deletion risk. */}
    </Screen>
  );
}
