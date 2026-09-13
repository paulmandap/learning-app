import { useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { emptyLevelCopy, LevelSegment, LEVELS } from '../../../src/ui/segment';
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
import { gradeFeedback, primeFeedback } from '../../../src/ui/feedback';
import { space, type, useTheme } from '../../../src/ui/theme';
import { listItems, type StudyItem } from '../../../src/data/items';
import { missedItemIds, recordAttempt } from '../../../src/data/attempts';
import { fetchProfile } from '../../../src/data/profile';
import { reviewStatesForSet } from '../../../src/data/review';
import { studyOrder } from '../../../src/core/schedule';
import { gradeTypedAnswer, makeCloze, type Cloze } from '../../../src/core/cloze';
import type { Level } from '../../../src/core/planner';

/**
 * Fill in the blanks.
 *
 * A card's own answer is cut out of the sentence it came from, and the student
 * types it back. Two things make this different from the flashcard deck, and
 * both are the reason D5 postponed it until it could be built properly:
 *
 *  - **The gap is the student's own notes**, not text a model wrote. So the word
 *    being asked for is the word they read, which is most of what made "ATP" vs
 *    "adenosine triphosphate" a problem.
 *  - **Nothing is auto-marked wrong on a near miss.** A typed answer that is
 *    close but not identical is shown the expected word and asked, because no
 *    string comparison can tell a typo from a genuinely different answer. See
 *    the measurement in src/core/cloze.ts.
 *
 * Not every card can become a blank — the answer has to be a short phrase that
 * actually appears in the cited sentence. Roughly a third of flashcards
 * qualified when measured, so the empty state has to explain itself rather than
 * look broken.
 */

interface Blank {
  item: StudyItem;
  cloze: Cloze;
}

type Phase =
  | { state: 'asking' }
  | { state: 'right' }
  /** Close enough that the student decides, not us. */
  | { state: 'near' }
  | { state: 'wrong' };

export default function Blanks() {
  /**
   * `?retry=1` means the same here as it does in Flashcards and Quiz: deal only
   * the cards whose LAST answer was wrong or partly right, taken from the same
   * `missedItemIds` pile, under the same query key. One retry pile, three ways
   * of being asked about it — a second definition would drift from the first
   * the moment either changed.
   */
  const { id, retry } = useLocalSearchParams<{ id: string; retry?: string }>();
  const setId = String(id);
  const retryOnly = retry === '1';
  const router = useRouter();
  const t = useTheme();

  /**
   * Starts on Understand like the other two modes, but moves itself once the
   * cards are known — see the effect below.
   */
  const [level, setLevel] = useState<Level>('understand');
  /** Set as soon as the student picks a level, so the effect stops interfering. */
  const [levelChosen, setLevelChosen] = useState(false);
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>({ state: 'asking' });
  const [got, setGot] = useState(0);
  const [answered, setAnswered] = useState(0);

  const { data: allItems = [], isLoading } = useQuery({
    queryKey: ['items', setId],
    queryFn: () => listItems(setId),
  });
  const { data: schedules } = useQuery({
    queryKey: ['schedules', setId],
    queryFn: () => reviewStatesForSet(setId),
  });

  // Shared query key with Flashcards and Quiz, so opening retry from either of
  // those and landing here is a cache read rather than another round trip.
  const { data: missedSet } = useQuery({
    queryKey: ['missed', setId],
    queryFn: () => missedItemIds(setId),
  });

  // Only so a card missed three times can be rephrased (Phase 8). Shared query
  // key, so this is a cache read rather than another round trip.
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });

  /**
   * Which cards can be blanks at all.
   *
   * Computed here rather than stored: makeCloze is pure and cheap, and a stored
   * flag would need a migration and would go stale the moment the rules change.
   */
  const blanks = useMemo(() => {
    const out: Blank[] = [];
    for (const item of allItems) {
      const r = makeCloze({
        kind: item.kind,
        answer: item.answer,
        sourceExcerpt: item.source_excerpt,
      });
      if (r.ok) out.push({ item, cloze: r.cloze });
    }
    return out;
  }, [allItems]);

  /**
   * What this screen can deal at all, before a level is chosen.
   *
   * In retry mode that is the blankable cards you got wrong last time. Counting
   * and queueing both read from here rather than from `blanks`, so the numbers
   * on the level buttons describe the deck the tap actually produces — which is
   * the whole reason `countByLevel` counts blankable cards and not every card.
   */
  const dealable = useMemo(
    () => (retryOnly ? blanks.filter((b) => missedSet?.has(b.item.id)) : blanks),
    [blanks, retryOnly, missedSet],
  );

  /** Counts over BLANKABLE items only — a button promising 12 that then shows 3 is a lie. */
  const countByLevel = useMemo(() => {
    const counts: Partial<Record<Level, number>> = {};
    for (const b of dealable) counts[b.item.level] = (counts[b.item.level] ?? 0) + 1;
    return counts;
  }, [dealable]);

  // Due first, then never seen, then the rest — the same order the flashcard
  // deck uses, so a card's turn does not depend on which mode you opened.
  //
  // Retry mode is filtered and left in its natural order, matching Flashcards:
  // the missed pile is already the answer to "what next", so re-sorting it by a
  // schedule that says "tomorrow" for every card it just reset achieves nothing.
  const queue = useMemo(() => {
    const atLevel = dealable.filter((b) => b.item.level === level);
    if (retryOnly) return atLevel;
    // The same order Flashcards deals — one function, so a card's turn does not
    // depend on which mode you opened.
    return studyOrder(
      atLevel,
      (b) => schedules?.get(b.item.id),
      (b) => b.item.section_title,
      Date.now(),
    );
  }, [dealable, level, schedules, retryOnly]);

  /**
   * Open on a level that actually has blanks.
   *
   * The other two modes default to Understand, per the spec's level segment.
   * Blanks cannot: asking for a term IS a Remember-tier task, so with the
   * 50/30/20 mix and the short-answer rule they land almost entirely in
   * Remember — measured 5 in Remember and 0 elsewhere on a real set. Keeping
   * the shared default would open this screen empty nearly every time, and an
   * empty screen reads as broken however well it explains itself.
   *
   * Runs once, and never again after the student picks a level themselves.
   */
  useEffect(() => {
    if (levelChosen || dealable.length === 0) return;
    if ((countByLevel[level] ?? 0) > 0) return;
    const best = LEVELS.map((l) => l.key).reduce((a, b) =>
      (countByLevel[b] ?? 0) > (countByLevel[a] ?? 0) ? b : a,
    );
    if ((countByLevel[best] ?? 0) > 0) setLevel(best);
  }, [dealable, countByLevel, level, levelChosen]);

  // Entering or leaving retry changes what every level contains, so the run
  // starts over — the same rule Flashcards applies for the same reason.
  useEffect(() => {
    setIndex(0);
    setTyped('');
    setPhase({ state: 'asking' });
    setGot(0);
    setAnswered(0);
  }, [level, retryOnly]);

  useEffect(() => {
    primeFeedback();
  }, []);

  const current = queue[index];

  function log(result: 'correct' | 'incorrect') {
    if (!current) return;
    gradeFeedback(result === 'correct');
    setAnswered((n) => n + 1);
    if (result === 'correct') setGot((n) => n + 1);
    void recordAttempt({
      studyItemId: current.item.id,
      studySetId: setId,
      mode: 'blanks',
      result,
      answerText: typed,
      apiKey: profile?.gemini_api_key ?? undefined,
    }).catch(() => {
      // Losing a log entry must not interrupt studying.
    });
  }

  function check() {
    if (!current || phase.state !== 'asking') return;
    if (typed.trim().length === 0) return;

    const { verdict } = gradeTypedAnswer(typed, current.cloze.answer);
    if (verdict === 'correct') {
      setPhase({ state: 'right' });
      log('correct');
    } else if (verdict === 'near') {
      // Deliberately not logged yet: the student's tap decides this one, and
      // recording a guess first would put a wrong row in the record of truth.
      setPhase({ state: 'near' });
    } else {
      setPhase({ state: 'wrong' });
      log('incorrect');
    }
  }

  /** The near-miss resolution: one tap, and the same self-report flashcards run on. */
  function resolveNear(hadIt: boolean) {
    log(hadIt ? 'correct' : 'incorrect');
    setPhase({ state: hadIt ? 'right' : 'wrong' });
  }

  function next() {
    setTyped('');
    setPhase({ state: 'asking' });
    setIndex((i) => i + 1);
  }

  if (isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const finished = index >= queue.length;

  return (
    <Screen>
      <Title>{retryOnly ? 'Retry what you missed' : 'Fill in the blanks'}</Title>

      <LevelSegment value={level} counts={countByLevel} onChange={setLevel} />

      {queue.length === 0 ? (
        <Card>
          <Body muted>
            {retryOnly
              ? emptyLevelCopy('blanks', true)
              : emptyLevelCopy('blanks', false)}
          </Body>
          {/* Explains itself rather than looking broken. Only cards whose answer
              is a short phrase written in the notes can have that phrase taken
              out, and that is a minority of them — which is also why a retry
              deck can come up empty while you have plenty to retry elsewhere. */}
          <Body muted>
            Blanks only work when a card's answer is a short phrase your notes actually use, so
            they come from some cards and not others. Try another level, or use Flashcards.
          </Body>
          <Button label="Back to set" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : finished ? (
        <Card>
          <Body>
            Done — {got} of {answered} filled in correctly.
          </Body>
          <Button
            label="Start again"
            onPress={() => {
              setIndex(0);
              setTyped('');
              setPhase({ state: 'asking' });
              setGot(0);
              setAnswered(0);
            }}
          />
          <Button label="Back to set" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : current ? (
        <>
          <ProgressBar value={index} total={queue.length} />

          <Card>
            {/* The sentence, from the notes, with the gap in it. This IS the
                question — there is no separate prompt to read, which is the
                point of a blank. */}
            <Text style={[type.card, { color: t.text }]}>
              {phase.state === 'asking' ? (
                current.cloze.text
              ) : (
                <Filled cloze={current.cloze} />
              )}
            </Text>

            {phase.state === 'asking' ? (
              <Field
                label="The missing words"
                value={typed}
                onChangeText={setTyped}
                placeholder="Type what goes in the gap…"
                autoCapitalize="none"
                onSubmitEditing={check}
              />
            ) : null}

            <Body muted>
              From your notes{current.item.page_index !== null ? ` · p.${current.item.page_index + 1}` : ''}
            </Body>
          </Card>

          {phase.state === 'asking' ? (
            <Button label="Check" onPress={check} />
          ) : phase.state === 'near' ? (
            <Card>
              {/* Never "wrong". No string comparison can tell a typo from a
                  different answer, so the app says what it was looking for and
                  lets the student say whether they had it. */}
              <Notice tone="warn">
                Close. We were looking for “{current.cloze.answer}”.
              </Notice>
              <Body muted>Did you have it?</Body>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="No, I missed it"
                    variant="secondary"
                    onPress={() => resolveNear(false)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label="Yes, I had it" onPress={() => resolveNear(true)} />
                </View>
              </View>
            </Card>
          ) : (
            <Card>
              <Notice tone={phase.state === 'right' ? 'ok' : 'error'}>
                {phase.state === 'right'
                  ? 'Right'
                  : `Not quite — it was “${current.cloze.answer}”.`}
              </Notice>
              <Button
                label={index + 1 >= queue.length ? 'See how you did' : 'Next'}
                onPress={next}
              />
            </Card>
          )}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * The sentence with the answer put back, highlighted where the gaps were.
 *
 * Showing the whole sentence again rather than just the missing word is the
 * cheap half of the product's promise — the student sees the answer sitting in
 * their own notes, in context, which is where they will meet it again.
 */
function Filled({ cloze }: { cloze: Cloze }) {
  const t = useTheme();
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const span of cloze.spans) {
    if (span.start > cursor) {
      parts.push({ text: cloze.source.slice(cursor, span.start), hit: false });
    }
    parts.push({ text: cloze.source.slice(span.start, span.end), hit: true });
    cursor = span.end;
  }
  if (cursor < cloze.source.length) {
    parts.push({ text: cloze.source.slice(cursor), hit: false });
  }

  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <Text key={i} style={{ backgroundColor: t.warnBg, color: t.warnText }}>
            {p.text}
          </Text>
        ) : (
          <Text key={i}>{p.text}</Text>
        ),
      )}
    </>
  );
}
