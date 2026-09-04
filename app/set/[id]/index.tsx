import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Body, Button, Card, Notice, Screen, Title } from '../../../src/ui/components';
import { fetchProfile } from '../../../src/data/profile';
import { deleteSet, getSet } from '../../../src/data/sets';
import { describeDrops } from '../../../src/core/validate';
import { listDocuments } from '../../../src/data/documents';
import { countItems } from '../../../src/data/items';
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

  const apiKey = profile?.gemini_api_key ?? '';

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

  return (
    <Screen>
      <Title>{set.title}</Title>

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
        <Card>
          <Body>
            {itemCount} card{itemCount === 1 ? '' : 's'} ready
            {plan && itemCount < plan.requestedCount
              ? ` — you asked for up to ${plan.requestedCount}. Your notes supported ${itemCount} good ones, and we'd rather stop than pad.`
              : '.'}
          </Body>
          {/* Only rendered when cards were actually left out, so a clean run
              shows nothing extra. This is the "why 19 of 20?" answer. */}
          {droppedLine ? <Body muted>{droppedLine}</Body> : null}
        </Card>
      )}

      {itemCount > 0 ? (
        <View style={{ gap: 8 }}>
          <Button label="Flashcards" onPress={() => router.push(`/set/${setId}/flashcards`)} />
          <Button label="Quiz" onPress={() => router.push(`/set/${setId}/quiz`)} />
          <Button
            label="Add notes to this set"
            variant="secondary"
            onPress={() => router.push(`/new?setId=${setId}`)}
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

      <Button label="Home" variant="secondary" onPress={() => router.replace('/')} />

      {/* Irreversible: removes the notes, the files and every card. Asks once. */}
      <Card>
        {confirmDelete ? (
          <>
            <Notice tone="error">
              Delete "{set.title}" and everything in it? This cannot be undone.
            </Notice>
            <Button label="Yes, delete this set" onPress={removeSet} busy={deleting} />
            <Button label="Keep it" variant="secondary" onPress={() => setConfirmDelete(false)} />
          </>
        ) : (
          <Button
            label="Delete this set"
            variant="secondary"
            onPress={() => setConfirmDelete(true)}
          />
        )}
      </Card>
    </Screen>
  );
}
