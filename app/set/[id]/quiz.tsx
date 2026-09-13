import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { emptyLevelCopy, LevelSegment } from '../../../src/ui/segment';
import { useQuery } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  Field,
  LoadingState,
  Notice,
  ProgressBar,
  Screen,
  Title,
} from '../../../src/ui/components';
import { StatePanel } from '../../../src/ui/states';
import { GLYPH } from '../../../src/ui/glyphs';
import { radius, space, type, useTheme } from '../../../src/ui/theme';
import { SourcePanel } from '../../../src/ui/source';
import { listDocuments, signedUrlFor } from '../../../src/data/documents';
import { listItems, promptFor, type StudyItem } from '../../../src/data/items';
import { fetchProfile } from '../../../src/data/profile';
import { missedItemIds } from '../../../src/data/attempts';
import { useStudySession } from '../../../src/data/study-session';
import { addQuizChoices } from '../../../src/data/quiz-options';
import { deal, startingLevel } from '../../../src/core/deck';
import { choicesFor, isWritten, needsChoices, type Option } from '../../../src/core/quiz';
import { GeminiBrowserProvider } from '../../../src/ai/gemini';
import { reasonToMessage } from '../../../src/core/ai-errors';
import { GeminiCallError } from '../../../src/ai/gemini';
import {
  gradeMultipleChoice,
  gradeWritten,
  isAnswerSubstantive,
  shuffleOptions,
  shuffleSeeded,
  type GradedAnswer,
} from '../../../src/core/grade';
import type { Level } from '../../../src/core/planner';

interface Answered {
  item: StudyItem;
  graded: GradedAnswer;
  typed: string;
}

const ITEM = { id: (i: StudyItem) => i.id, level: (i: StudyItem) => i.level };

/**
 * How long the quiz waits for Gemini to write answer choices before asking
 * with choices from the set instead. The writing carries on either way, and a
 * later round uses what it wrote.
 */
const CHOICES_WAIT_MS = 25_000;

export default function Quiz() {
  const { id, retry, level: levelParam } = useLocalSearchParams<{
    id: string;
    retry?: string;
    level?: string;
  }>();
  const setId = String(id);
  const retryOnly = retry === '1';
  const router = useRouter();
  const t = useTheme();
  const record = useStudySession(setId);

  // The starting level from the link, if it names one — see flashcards.tsx.
  const [level, setLevel] = useState<Level>(() => startingLevel(levelParam));
  const [index, setIndex] = useState(0);

  /**
   * Which round of questions this is — and the seed its order is drawn from.
   *
   * The owner: *"the quiz isn't generating a new one after i finish answering
   * … make it randomized everytime i opened the quiz."* Questions used to come
   * back in `listItems` order, so the same set asked the same questions in the
   * same sequence forever, and finishing left no way to go round again.
   *
   * A timestamp taken once, when the screen opens, rather than `Math.random()`
   * on every render: the order has to hold still while you are answering, and
   * only change when you ask for another round.
   */
  const [round, setRound] = useState(() => String(Date.now()));
  const [typed, setTyped] = useState('');
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState<Answered[]>([]);
  const [current, setCurrent] = useState<GradedAnswer | null>(null);

  const { data: profile, isSuccess: profileLoaded } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });
  const {
    data: allItems = [],
    isLoading,
    refetch: refetchItems,
  } = useQuery({
    // Every level in one query, filtered below. Switching levels is then
    // instant, and the per-level counts the buttons show come for free
    // instead of costing three more round trips.
    queryKey: ['items', setId],
    queryFn: () => listItems(setId),
  });
  const { data: missed } = useQuery({
    queryKey: ['missed', setId],
    queryFn: () => missedItemIds(setId),
  });
  const { data: docs = [] } = useQuery({
    queryKey: ['docs', setId],
    queryFn: () => listDocuments(setId),
  });

  /**
   * Answer choices for cards that have none, written once when the quiz opens.
   *
   * Every card is a question now (NOTES §38). A flashcard is asked as a choice
   * between its answer and three wrong ones; a set made before this, or one
   * whose choices were not written when it finished, gets them here. The quiz
   * waits for them — so the choices do not change under a question already on
   * screen — but not for ever, and a card still without them is asked with
   * choices from the other cards.
   */
  const [choices, setChoices] = useState<'checking' | 'writing' | 'ready'>('checking');
  const choicesStarted = useRef(false);
  useEffect(() => {
    if (choicesStarted.current || isLoading || !profileLoaded) return;
    choicesStarted.current = true;
    const apiKey = profile?.gemini_api_key ?? '';
    if (!apiKey || !allItems.some(needsChoices)) {
      setChoices('ready');
      return;
    }
    setChoices('writing');
    const writing = addQuizChoices({ setId, apiKey })
      .then(async (result) => {
        if (result.notWritten > 0) console.warn(`[quiz] ${result.notWritten} card(s) asked with choices from the set`);
        await refetchItems();
      })
      .catch((err) => {
        console.warn(`[quiz] answer choices not written: ${err instanceof Error ? err.message : String(err)}`);
      });
    const giveUp = new Promise((resolve) => setTimeout(resolve, CHOICES_WAIT_MS));
    void Promise.race([writing, giveUp]).then(() => setChoices('ready'));
  }, [isLoading, profileLoaded, profile, allItems, setId, refetchItems]);

  // The choices for every card, worked out once per change to the cards: the
  // card's own, or the set's (`choicesFor`). A card that can be asked neither
  // way — a set too small to take choices from — is left out.
  const choicesById = useMemo(
    () => new Map(allItems.map((i) => [i.id, isWritten(i) ? null : choicesFor(i, allItems)])),
    [allItems],
  );
  const quizzable = useMemo(
    () => allItems.filter((i) => isWritten(i) || choicesById.get(i.id) !== null),
    [allItems, choicesById],
  );

  /**
   * Counts for the level buttons, over the cards the quiz can ask.
   *
   * Every card, now, bar a set too small for choices — so these match the
   * Flashcards counts, which is what a student expects of the same set.
   */
  const countByLevel = useMemo(() => {
    const counts: Partial<Record<Level, number>> = {};
    for (const i of quizzable) counts[i.level] = (counts[i.level] ?? 0) + 1;
    return counts;
  }, [quizzable]);

  // Levels are exclusive now (see listItems): Understand means understand, not
  // "understand and everything easier".
  const items = useMemo(() => {
    // A retry round asks every missed question in the set, whatever the level
    // (NOTES §36); an ordinary round asks one level.
    const pool = deal(quizzable, { level, retryOnly, missed }, ITEM);
    // Seeded by round AND level, so switching level does not reshuffle the
    // level you were part-way through.
    return shuffleSeeded(pool, `${round}:${level}`);
  }, [quizzable, level, retryOnly, missed, round]);

  /** Back to question one, with everything from the last run cleared. */
  function restart() {
    setIndex(0);
    setAnswered([]);
    setCurrent(null);
    setTyped('');
    setChosen(null);
    submitting.current = false;
  }

  // Deliberately not depending on `restart` itself: it is redefined every
  // render, and listing it would clear the quiz on every keystroke.
  useEffect(() => {
    restart();
  }, [level, retryOnly]);

  const item = items[index];
  const options: Option[] = useMemo(
    () => (item && !isWritten(item) ? shuffleOptions(choicesById.get(item.id) ?? [], item.id) : []),
    [item, choicesById],
  );

  /**
   * One in-flight submission at a time.
   *
   * A ref rather than state, and checked before anything else: grading a written
   * answer awaits a model call and even a multiple-choice answer awaits
   * recordAttempt, so several hundred milliseconds pass between the tap and
   * `current` being set. Two taps in that window both saw `current === null`,
   * and each appended to `answered` and wrote an attempts row — which is why a
   * two-question quiz could finish claiming three or four, with the same
   * question listed twice in the results.
   *
   * State would not fix it: a setState in the same tick is not visible to the
   * second call. The ref is set synchronously, so the second tap returns.
   */
  const submitting = useRef(false);

  async function submit() {
    if (!item) return;
    if (submitting.current || current) return;
    submitting.current = true;
    setError(null);

    let graded: GradedAnswer;

    if (!isWritten(item)) {
      if (chosen === null) {
        setError('Choose an answer first.');
        submitting.current = false;
        return;
      }
      graded = gradeMultipleChoice(options, chosen);
    } else {
      if (!isAnswerSubstantive(typed)) {
        setError('Write your answer first.');
        submitting.current = false;
        return;
      }
      const rubric = item.rubric!;

      setBusy(true);
      try {
        const provider = new GeminiBrowserProvider(profile?.gemini_api_key ?? '');
        const result = await provider.gradeAnswer({
          // What the student was SHOWN, which is the variant when there is one.
          // Marking a rewritten question against its original wording would
          // grade them on a question they never read.
          prompt: promptFor(item),
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
        submitting.current = false;
        return;
      }
      setBusy(false);
    }

    // One attempts row per answer, always.
    try {
      await record({
        studyItemId: item.id,
        studySetId: setId,
        mode: 'quiz',
        result: graded.result,
        apiKey: profile?.gemini_api_key ?? undefined,
        score: graded.maxScore > 0 ? graded.score : null,
        maxScore: graded.maxScore > 0 ? graded.maxScore : null,
        answerText: !isWritten(item) ? (options[chosen ?? 0]?.text ?? null) : typed,
        feedback: graded.feedback || null,
      });
    } catch {
      // A logging failure must not lose the user's answer on screen.
    }

    setCurrent(graded);
    setAnswered((prev) => [...prev, { item, graded, typed }]);
  }

  async function openPage(forItem: StudyItem) {
    if (!forItem.document_id) return;
    const doc = docs.find((d) => d.id === forItem.document_id);
    if (!doc?.storage_path) return;
    const url = await signedUrlFor(doc.storage_path, forItem.page_index ?? 0);
    if (url) void Linking.openURL(url);
  }

  function next() {
    submitting.current = false;
    setCurrent(null);
    setTyped('');
    setChosen(null);
    setIndex((i) => i + 1);
  }

  if (isLoading || choices === 'checking') {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  if (choices === 'writing') {
    return (
      <Screen>
        <Title>Quiz</Title>
        <StatePanel kind="working"
          title="Making your quiz"
          detail="Writing answer choices from your notes. This only happens once for this set."
        />
      </Screen>
    );
  }

  // Finished means questions were asked and all answered. A level with nothing
  // to ask is NOT finished: it opened straight onto "0 of 0 right" with no way
  // to choose another level, which is where the owner found an empty quiz
  // (NOTES §38). It shows the level picker and says so instead.
  const finished = items.length > 0 && index >= items.length;

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
        </Card>

        {/* Keyed by position, not item id: a retry round can legitimately show
            the same question twice, and duplicate React keys silently drop a
            card from the list. */}
        {answered.map((a, i) => (
          <Card key={`${a.item.id}-${i}`}>
            <Body>{promptFor(a.item)}</Body>
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
            <SourcePanel
              excerpt={a.item.source_excerpt}
              answer={a.item.answer}
              pageIndex={a.item.page_index}
              checkFlag={a.item.check_flag}
              onOpenPage={a.item.document_id ? () => void openPage(a.item) : undefined}
            />
          </Card>
        ))}

        {missedNow.length > 0 && !retryOnly ? (
          <Button
            label={`Retry what I missed (${missedNow.length})`}
            onPress={() => router.replace(`/set/${setId}/quiz?retry=1`)}
          />
        ) : null}

        {/* A fresh round, in a new order. Finishing used to be a dead end: the
            only ways on were the missed pile or leaving, so a set you had
            answered once could not simply be asked again.

            The questions are the same ones — a set holds what it holds — but
            the sequence is redrawn, which is what the owner asked for and is
            also the part that matters: answering in a memorised order tests
            the order as much as the material. */}
        {answered.length > 0 ? (
          <Button
            label="Ask me again"
            variant={missedNow.length > 0 && !retryOnly ? 'secondary' : 'primary'}
            onPress={() => {
              setRound(String(Date.now()));
              restart();
            }}
          />
        ) : null}
        {/* back(), not replace(): replace destroys the history entry, which is
            what left the installed PWA with no way back — it has no edge-swipe
            gesture, so the header chevron is the only route out. */}
        <Button label="Back to set" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  // ------------------------------------------------------------ question --
  return (
    <Screen>
      <Title>{retryOnly ? 'Retry' : 'Quiz'}</Title>

      {!retryOnly ? (
        <LevelSegment value={level} counts={countByLevel} onChange={setLevel} />
      ) : null}

      {items.length === 0 ? (
        <Card>
          <Body muted>
            {retryOnly
              ? emptyLevelCopy('questions', true)
              : emptyLevelCopy('questions', false)}
          </Body>
          {/* back(), not replace(): replace destroys the history entry, which is
            what left the installed PWA with no way back — it has no edge-swipe
            gesture, so the header chevron is the only route out. */}
          <Button label="Back to set" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : item ? (
        <>
          <ProgressBar value={index} total={items.length} />

          <Card>
            <Body>{promptFor(item)}</Body>

            {!isWritten(item) ? (
              <View style={{ gap: space.sm }}>
                {options.map((o, i) => {
                  // Before answering, the only state is "picked". After, the
                  // marking is on the options themselves: the right one is
                  // always shown as right, so a student who guessed wrong sees
                  // which one it was without reading the source to work it out.
                  const answeredNow = current !== null;
                  const isChosen = chosen === i;
                  const showRight = answeredNow && o.correct;
                  const showWrong = answeredNow && isChosen && !o.correct;

                  const borderColor = showRight
                    ? t.ok
                    : showWrong
                      ? t.danger
                      : isChosen
                        ? t.accent
                        : t.border;

                  return (
                    <Pressable key={o.text} onPress={() => !current && setChosen(i)}>
                      <View
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: space.sm,
                          borderWidth: showRight || showWrong || isChosen ? 2 : 1,
                          borderRadius: radius.sm,
                          padding: space.md,
                          minHeight: 44,
                          borderColor,
                          backgroundColor: isChosen ? t.bg : 'transparent',
                        }}
                      >
                        <Text style={[type.body, { color: t.text, flex: 1 }]}>{o.text}</Text>
                        {/* A mark as well as a colour: roughly one man in twelve
                            cannot separate the green from the red, and the
                            verdict must not live in hue alone. */}
                        {showRight || showWrong ? (
                          <Text
                            accessibilityLabel={showRight ? 'Correct answer' : 'Your answer, wrong'}
                            style={[type.bodyStrong, { color: showRight ? t.ok : t.danger }]}
                          >
                            {showRight ? GLYPH.right : GLYPH.wrong}
                          </Text>
                        ) : null}
                      </View>
                    </Pressable>
                  );
                })}
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
              <Button label={index + 1 >= items.length ? 'See results' : 'Next question'} onPress={next} />
            </Card>
          ) : null}

          {/* Collapsed behind the chip, exactly as in Flashcards. Shown only
              once the question has been answered — before that it would be the
              answer sitting under the question. */}
          {current ? (
            <SourcePanel
              excerpt={item.source_excerpt}
              answer={item.answer}
              pageIndex={item.page_index}
              checkFlag={item.check_flag}
              onOpenPage={item.document_id ? () => void openPage(item) : undefined}
            />
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
      <RubricCaution item={item} />
    </View>
  );
}

/**
 * A quiet caution when the second pass could not trace this question's marking
 * back to the notes (D7, `rubric_verified = false`).
 *
 * Shown only on a false, never on a true or an unchecked null — a badge saying
 * "we checked this" on most cards would train the eye to ignore the one that
 * matters. It sits with the marking rather than the question because that is
 * what it is about: the points being demanded, not whether the fact is right.
 *
 * Deliberately worded as a nudge, not a verdict, and with no jargon. It appears
 * after a student has been told what they "still need to mention", which is
 * exactly the moment an unfair checklist stings.
 */
function RubricCaution({ item }: { item: StudyItem }) {
  if (item.rubric_verified !== false) return null;
  return (
    <Body muted>
      We're not sure every point above is really in your notes — trust your notes over this one.
    </Body>
  );
}
