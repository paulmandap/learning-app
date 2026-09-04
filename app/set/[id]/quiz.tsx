import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  Field,
  Notice,
  ProgressBar,
  Screen,
  Title,
} from '../../../src/ui/components';
import { radius, space, useTheme } from '../../../src/ui/theme';
import { listItems, type StudyItem } from '../../../src/data/items';
import { fetchProfile } from '../../../src/data/profile';
import { missedItemIds, recordAttempt } from '../../../src/data/attempts';
import { GeminiBrowserProvider } from '../../../src/ai/gemini';
import { reasonToMessage } from '../../../src/core/ai-errors';
import { GeminiCallError } from '../../../src/ai/gemini';
import {
  gradeMultipleChoice,
  gradeWritten,
  isAnswerSubstantive,
  shuffleOptions,
  type GradedAnswer,
} from '../../../src/core/grade';
import type { Level } from '../../../src/core/planner';

const LEVELS: { key: Level; label: string }[] = [
  { key: 'remember', label: 'Remember' },
  { key: 'understand', label: 'Understand' },
  { key: 'apply', label: 'Apply' },
];

interface Answered {
  item: StudyItem;
  graded: GradedAnswer;
  typed: string;
}

export default function Quiz() {
  const { id, retry } = useLocalSearchParams<{ id: string; retry?: string }>();
  const setId = String(id);
  const retryOnly = retry === '1';
  const router = useRouter();
  const t = useTheme();

  const [level, setLevel] = useState<Level>('understand');
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState('');
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Answered[]>([]);
  const [current, setCurrent] = useState<GradedAnswer | null>(null);

  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const { data: allItems = [], isLoading } = useQuery({
    queryKey: ['items', setId, level],
    queryFn: () => listItems(setId, { level }),
  });
  const { data: missed } = useQuery({
    queryKey: ['missed', setId],
    queryFn: () => missedItemIds(setId),
  });

  // Quiz uses MC and short written answers only — flashcards have no way to be
  // marked. "Retry what I missed" narrows to the items last answered wrongly.
  const items = useMemo(() => {
    const quizzable = allItems.filter((i) => i.kind === 'mcq' || i.kind === 'short_answer');
    if (!retryOnly) return quizzable;
    return quizzable.filter((i) => missed?.has(i.id));
  }, [allItems, retryOnly, missed]);

  useEffect(() => {
    setIndex(0);
    setAnswered([]);
    setCurrent(null);
    setTyped('');
    setChosen(null);
  }, [level, retryOnly]);

  const item = items[index];
  const options = useMemo(
    () => (item?.options ? shuffleOptions(item.options, item.id) : []),
    [item],
  );

  async function submit() {
    if (!item) return;
    setError(null);

    let graded: GradedAnswer;

    if (item.kind === 'mcq') {
      if (chosen === null) {
        setError('Choose an answer first.');
        return;
      }
      graded = gradeMultipleChoice(options, chosen);
    } else {
      if (!isAnswerSubstantive(typed)) {
        setError('Write your answer first.');
        return;
      }
      const rubric = item.rubric;
      if (!rubric || rubric.expected_concepts.length === 0) {
        setError("This question can't be marked. Skip it for now.");
        return;
      }

      setBusy(true);
      try {
        const provider = new GeminiBrowserProvider(profile?.gemini_api_key ?? '');
        const result = await provider.gradeAnswer({
          prompt: item.prompt,
          rubric,
          answer: typed,
        });
        // The model says WHICH concepts it found; the score is computed here.
        graded = gradeWritten({
          expected: rubric.expected_concepts,
          conceptsHit: result.concepts_hit,
          feedback: result.feedback,
        });
      } catch (err) {
        setBusy(false);
        setError(
          err instanceof GeminiCallError
            ? reasonToMessage(err.reason)
            : 'Gemini is busy right now — try again in a minute.',
        );
        return;
      }
      setBusy(false);
    }

    // One attempts row per answer, always.
    try {
      await recordAttempt({
        studyItemId: item.id,
        studySetId: setId,
        mode: 'quiz',
        result: graded.result,
        score: graded.maxScore > 0 ? graded.score : null,
        maxScore: graded.maxScore > 0 ? graded.maxScore : null,
        answerText: item.kind === 'mcq' ? (options[chosen ?? 0]?.text ?? null) : typed,
        feedback: graded.feedback || null,
      });
    } catch {
      // A logging failure must not lose the user's answer on screen.
    }

    setCurrent(graded);
    setAnswered((prev) => [...prev, { item, graded, typed }]);
  }

  function next() {
    setCurrent(null);
    setTyped('');
    setChosen(null);
    setIndex((i) => i + 1);
  }

  if (isLoading) {
    return (
      <Screen>
        <Body muted>Loading…</Body>
      </Screen>
    );
  }

  const finished = index >= items.length;

  // ------------------------------------------------------------- results --
  if (finished) {
    const correct = answered.filter((a) => a.graded.result === 'correct').length;
    const partial = answered.filter((a) => a.graded.result === 'partial').length;
    const missedNow = answered.filter((a) => a.graded.result !== 'correct');

    return (
      <Screen>
        <Title>Results</Title>
        <Card>
          <Body>
            {correct} of {answered.length} right
            {partial > 0 ? `, ${partial} partly right` : ''}.
          </Body>
          {answered.length === 0 ? (
            <Body muted>
              {retryOnly
                ? 'Nothing to retry — you have not missed anything here yet.'
                : 'No questions at this level yet.'}
            </Body>
          ) : null}
        </Card>

        {answered.map((a) => (
          <Card key={a.item.id}>
            <Body>{a.item.prompt}</Body>
            <Notice tone={a.graded.result === 'correct' ? 'ok' : a.graded.result === 'partial' ? 'warn' : 'error'}>
              {a.graded.result === 'correct'
                ? 'Right'
                : a.graded.result === 'partial'
                  ? 'Partly right'
                  : 'Not quite'}
              {a.graded.maxScore > 1 ? ` · ${a.graded.score} of ${a.graded.maxScore}` : ''}
            </Notice>
            {a.graded.feedback ? <Body muted>{a.graded.feedback}</Body> : null}
            <ConceptList item={a.item} graded={a.graded} />
            <Body muted>
              Source{a.item.page_index !== null ? ` · p.${a.item.page_index + 1}` : ''}:{' '}
              {a.item.source_excerpt}
            </Body>
          </Card>
        ))}

        {missedNow.length > 0 && !retryOnly ? (
          <Button
            label={`Retry what I missed (${missedNow.length})`}
            onPress={() => router.replace(`/set/${setId}/quiz?retry=1`)}
          />
        ) : null}
        <Button label="Back to set" variant="secondary" onPress={() => router.replace(`/set/${setId}`)} />
      </Screen>
    );
  }

  // ------------------------------------------------------------ question --
  return (
    <Screen>
      <Title>{retryOnly ? 'Retry' : 'Quiz'}</Title>

      {!retryOnly ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {LEVELS.map((l) => (
            <View key={l.key} style={{ flex: 1 }}>
              <Button
                label={l.label}
                variant={level === l.key ? 'primary' : 'secondary'}
                onPress={() => setLevel(l.key)}
              />
            </View>
          ))}
        </View>
      ) : null}

      {items.length === 0 ? (
        <Card>
          <Body muted>
            {retryOnly
              ? 'Nothing to retry here — you have not missed anything yet.'
              : 'No quiz questions at this level yet.'}
          </Body>
          <Button label="Back to set" variant="secondary" onPress={() => router.replace(`/set/${setId}`)} />
        </Card>
      ) : item ? (
        <>
          <ProgressBar value={index} total={items.length} />

          <Card>
            <Body>{item.prompt}</Body>

            {item.kind === 'mcq' ? (
              <View style={{ gap: space.sm }}>
                {options.map((o, i) => (
                  <Pressable key={o.text} onPress={() => !current && setChosen(i)}>
                    <View
                      style={{
                        borderWidth: chosen === i ? 2 : 1,
                        borderRadius: radius.sm,
                        padding: space.md,
                        minHeight: 44,
                        justifyContent: 'center',
                        borderColor: chosen === i ? t.accent : t.border,
                        backgroundColor: chosen === i ? t.bg : 'transparent',
                      }}
                    >
                      <Text style={{ color: t.text, fontSize: 15 }}>{o.text}</Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Field
                label="Your answer"
                value={typed}
                onChangeText={setTyped}
                placeholder="Answer in a sentence or two…"
                autoCapitalize="sentences"
              />
            )}
          </Card>

          {current ? (
            <Card>
              <Notice tone={current.result === 'correct' ? 'ok' : current.result === 'partial' ? 'warn' : 'error'}>
                {current.result === 'correct'
                  ? 'Right'
                  : current.result === 'partial'
                    ? 'Partly right'
                    : 'Not quite'}
                {current.maxScore > 1 ? ` · ${current.score} of ${current.maxScore}` : ''}
              </Notice>
              {current.feedback ? <Body muted>{current.feedback}</Body> : null}
              <ConceptList item={item} graded={current} />
              <Body muted>
                Source{item.page_index !== null ? ` · p.${item.page_index + 1}` : ''}:{' '}
                {item.source_excerpt}
              </Body>
              <Button label={index + 1 >= items.length ? 'See results' : 'Next question'} onPress={next} />
            </Card>
          ) : (
            <Button label="Check my answer" onPress={submit} busy={busy} />
          )}

          {error ? <Notice tone="error">{error}</Notice> : null}
        </>
      ) : null}
    </Screen>
  );
}

/** Which points the answer covered and which it missed (spec §2, Quiz results). */
function ConceptList({ item, graded }: { item: StudyItem; graded: GradedAnswer }) {
  if (!item.rubric || item.rubric.expected_concepts.length === 0) return null;

  const textFor = (conceptId: string) =>
    item.rubric?.expected_concepts.find((c) => c.id === conceptId)?.text ?? conceptId;

  return (
    <View style={{ gap: 4 }}>
      {graded.hit.length > 0 ? (
        <Body muted>You covered: {graded.hit.map(textFor).join('; ')}.</Body>
      ) : null}
      {graded.missed.length > 0 ? (
        <Body muted>Still to mention: {graded.missed.map(textFor).join('; ')}.</Body>
      ) : null}
    </View>
  );
}
