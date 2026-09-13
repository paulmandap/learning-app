import { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { emptyLevelCopy, LevelSegment, LEVELS } from '../../../src/ui/segment';
import { useQuery } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
  LoadingState,
  Notice,
  ProgressBar,
  Screen,
  Title,
} from '../../../src/ui/components';
import { FlipCard } from '../../../src/ui/flashcard';
import { gradeFeedback, hapticFlip, primeFeedback } from '../../../src/ui/feedback';
import { space } from '../../../src/ui/theme';
import { SourcePanel } from '../../../src/ui/source';
import { listItems, promptFor, reportItem, type StudyItem } from '../../../src/data/items';
import { missedItemIds } from '../../../src/data/attempts';
import { useStudySession } from '../../../src/data/study-session';
import { busiestLevel, countByLevel as countAtLevels, deal, startingLevel } from '../../../src/core/deck';
import { fetchProfile } from '../../../src/data/profile';
import { useAssistantContext } from '../../../src/data/assistant-context';
import { reviewStatesForSet } from '../../../src/data/review';
import { isDue, studyOrder } from '../../../src/core/schedule';
import { listDocuments, signedUrlFor } from '../../../src/data/documents';
import type { Level } from '../../../src/core/planner';

const ITEM = { id: (i: StudyItem) => i.id, level: (i: StudyItem) => i.level };

export default function Flashcards() {
  const { id, retry, level: levelParam } = useLocalSearchParams<{
    id: string;
    retry?: string;
    level?: string;
  }>();
  const setId = String(id);
  const retryOnly = retry === '1';
  const router = useRouter();
  const record = useStudySession(setId);

  // Understand by default, per the spec's level segment — unless the link says
  // where the work is. "Study what's due" and the set screen's due chip pass
  // `?level=`, read ONCE as the starting level. The student still decides every
  // change after that (NOTES §36).
  const [level, setLevel] = useState<Level>(() => startingLevel(levelParam));

  /**
   * How far through each level you are — one position per level, not one
   * shared position.
   *
   * The owner: *"let's say i'm 5 of 9 progress in 'remember'. when i suddenly
   * switched to 'apply' then went back to 'remember' i lost my progress."* It
   * was a single `index` reset to 0 whenever the level changed, so the three
   * levels shared one counter and looking at another deck threw yours away.
   *
   * A level is a different deck, so it keeps its own place. Levels are
   * exclusive (deliberate deviation 7), which is what makes that the right
   * model rather than merely a convenient one.
   */
  const [indexByLevel, setIndexByLevel] = useState<Record<Level, number>>({
    remember: 0,
    understand: 0,
    apply: 0,
  });
  const index = indexByLevel[level];
  const setIndex = (next: (previous: number) => number) =>
    setIndexByLevel((prev) => ({ ...prev, [level]: next(prev[level]) }));

  const [revealed, setRevealed] = useState(false);
  const [missed, setMissed] = useState<Set<string>>(new Set());
  const [reported, setReported] = useState<string | null>(null);

  const { data: allItems = [], isLoading } = useQuery({
    // Every level in one query, filtered below. Switching levels is then
    // instant, and the per-level counts the buttons show come for free
    // instead of costing three more round trips.
    queryKey: ['items', setId],
    queryFn: () => listItems(setId),
  });
  const { data: missedSet } = useQuery({
    queryKey: ['missed', setId],
    queryFn: () => missedItemIds(setId),
  });

  const { data: schedules } = useQuery({
    queryKey: ['schedules', setId],
    queryFn: () => reviewStatesForSet(setId),
  });

  // Only so a card failed three times can have its question rewritten
  // (Phase 8). Shared query key with Settings and Quiz, so this is a cache read
  // rather than another round trip, and studying works fine without it.
  const { data: profile } = useQuery({ queryKey: ['profile'], queryFn: fetchProfile });

  // The missed pile (D8). Retention comes from coming back to what you got
  // wrong, so this is a first-class mode rather than a filter buried in a menu.
  //
  // Outside retry mode the deck is ORDERED by the schedule (Phase 6) rather
  // than filtered: due cards first, longest overdue leading, then cards never
  // seen, then the rest. Ordering rather than filtering is deliberate — a deck
  // that hides everything not due would show "nothing to study" to someone who
  // sat down wanting to study, which is the wrong answer to give them.
  /** How many cards sit at each level, for the segment buttons. */
  const countByLevel = useMemo(() => {
    const counts: Partial<Record<Level, number>> = {};
    for (const i of allItems) counts[i.level] = (counts[i.level] ?? 0) + 1;
    return counts;
  }, [allItems]);

  const atLevel = useMemo(() => allItems.filter((i) => i.level === level), [allItems, level]);

  const items = useMemo(() => {
    // Every missed card in the set, whatever the level. It was filtered to the
    // level on screen, so the retry deck opened empty on Understand while the
    // missed Remember cards stayed on the button that sent you here (§36).
    if (retryOnly) return deal(allItems, { level, retryOnly, missed: missedSet }, ITEM);
    // studyOrder, not reviewOrder: same three bands (due, never-seen, future),
    // but within each one the cards that keep beating you come first and a
    // section's cards are dealt together, so a miss is followed by a sibling
    // rather than a jump elsewhere in the notes. The lapse and streak counts it
    // reads have been arriving in `schedules` since Phase 6 and were unused.
    return studyOrder(
      atLevel,
      (i) => schedules?.get(i.id),
      (i) => i.section_title,
      Date.now(),
    );
  }, [allItems, atLevel, level, retryOnly, missedSet, schedules]);

  const dueNow = useMemo(
    () =>
      retryOnly
        ? 0
        : atLevel.filter((i) => {
            const s = schedules?.get(i.id);
            // Only cards with a schedule that has come up. A card never
            // reviewed is not "due" — it is simply new, and saying otherwise
            // would make every fresh set claim its whole deck was overdue.
            return s !== undefined && isDue(s, Date.now());
          }).length,
    [atLevel, retryOnly, schedules],
  );

  /**
   * The next level with cards due, not counting this one.
   *
   * A set's "7 due today" spans every level and a deck deals one, so finishing
   * a level can leave due cards elsewhere. The Done card offers that level
   * rather than letting the count on Home look like it ignored the work.
   * The schedules are the ones loaded when the deck opened, which is why the
   * current level is excluded: its cards were just answered.
   */
  const nextDueLevel = useMemo(() => {
    if (retryOnly) return null;
    const due = countAtLevels(
      allItems,
      (i) => i.level,
      (i) => {
        const s = schedules?.get(i.id);
        return s !== undefined && isDue(s, Date.now());
      },
    );
    const nextLevel = busiestLevel({ ...due, [level]: 0 });
    return nextLevel ? { level: nextLevel, count: due[nextLevel] ?? 0 } : null;
  }, [allItems, schedules, level, retryOnly]);
  const { data: docs = [] } = useQuery({
    queryKey: ['docs', setId],
    queryFn: () => listDocuments(setId),
  });

  // Switching level no longer touches any position — that was the bug. Only
  // the per-card state resets, because a card turned over at one level must
  // not appear already turned over at another.
  useEffect(() => {
    setRevealed(false);
    setReported(null);
  }, [level]);

  // Entering or leaving "retry what you missed" IS a different deck at every
  // level, so all three positions start again.
  useEffect(() => {
    setIndexByLevel({ remember: 0, understand: 0, apply: 0 });
    setRevealed(false);
    setReported(null);
  }, [retryOnly]);

  // Build the hidden haptic switch before it is needed. Created on demand, the
  // very first tap was lost to a DOM race — which read as "swipes do not buzz"
  // if a swipe happened to be the first thing you did.
  useEffect(() => {
    primeFeedback();
  }, []);

  const card: StudyItem | undefined = items[index];

  // Tell the assistant which card is open, so "why is this the answer?" is
  // answerable without sending a page of notes. Cleared on unmount, because a
  // stale card is worse than none — it would answer confidently about a card
  // the student left two screens ago.
  const setAssistantContext = useAssistantContext((s) => s.setContext);
  const clearAssistantContext = useAssistantContext((s) => s.clearContext);
  useEffect(() => {
    if (!card) return;
    setAssistantContext({
      kind: 'card',
      prompt: promptFor(card),
      answer: card.answer,
      source: card.source_excerpt,
    });
  }, [card, setAssistantContext]);
  useEffect(() => clearAssistantContext, [clearAssistantContext]);

  /** One place to turn a card over, so tap and keyboard behave identically. */
  function toggleReveal() {
    hapticFlip();
    setRevealed((r) => !r);
  }

  // Keyboard on desktop: space = flip, left = missed, right = got it.
  useEffect(() => {
    if (Platform.OS !== 'web' || !card) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        e.preventDefault();
        toggleReveal();
      } else if (e.code === 'ArrowLeft') {
        gradeWithFeedback(false);
      } else if (e.code === 'ArrowRight') {
        gradeWithFeedback(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /**
   * Grade from a button or the keyboard.
   *
   * A swipe does NOT come through here for its feedback — FlipCard fires it the
   * moment the gesture commits, rather than after the 220ms fly-off, so the
   * buzz lands when your thumb lets go instead of a beat later.
   */
  function gradeWithFeedback(gotIt: boolean) {
    gradeFeedback(gotIt);
    grade(gotIt);
  }

  function grade(gotIt: boolean) {
    if (!card) return;
    if (!gotIt) {
      setMissed((prev) => new Set(prev).add(card.id));
    }
    // Every answer is logged (D8) — the missed pile and Home's "Continue" are
    // both built from attempts, so a flashcard that is never recorded is a
    // flashcard that can never come back.
    void record({
      studyItemId: card.id,
      studySetId: setId,
      mode: 'flashcards',
      result: gotIt ? 'correct' : 'incorrect',
      apiKey: profile?.gemini_api_key ?? undefined,
    }).catch(() => {
      // Losing a log entry must not interrupt studying.
    });
    setRevealed(false);
    setIndex((i) => i + 1);
  }

  async function report() {
    if (!card) return;
    try {
      await reportItem(card.id);
      setReported(card.id);
      grade(true); // move on; it will not appear again
    } catch {
      setReported(null);
    }
  }

  /**
   * The picture this card came from, for image uploads (Phase 7a).
   *
   * Only for `kind === 'image'`: the original is already in Storage and
   * signedUrlFor already exists, so showing it costs no new storage. A PDF page
   * cannot be shown the same way — that needs pdf.js or stored page images, and
   * spec §4 rules the latter out for the MVP.
   *
   * Keyed by document so one signed URL serves every card from that upload
   * rather than one request per card.
   */
  const cardDoc = card?.document_id ? docs.find((d) => d.id === card.document_id) : undefined;
  const figureDoc = cardDoc?.kind === 'image' && cardDoc.storage_path ? cardDoc : undefined;

  const { data: figureUri } = useQuery({
    queryKey: ['figure', figureDoc?.id],
    queryFn: () => signedUrlFor(figureDoc!.storage_path!),
    enabled: !!figureDoc,
    // Signed URLs last 10 minutes; refetch before they lapse mid-session.
    staleTime: 8 * 60 * 1000,
  });

  async function openPage() {
    if (!card?.document_id) return;
    const doc = docs.find((d) => d.id === card.document_id);
    if (!doc?.storage_path) return;
    const url = await signedUrlFor(doc.storage_path, card.page_index ?? 0);
    if (url) void Linking.openURL(url);
  }

  if (isLoading) {
    return (
      <Screen>
        <LoadingState />
      </Screen>
    );
  }

  const finished = index >= items.length;

  return (
    <Screen>
      <Title>{retryOnly ? 'Retry what you missed' : 'Flashcards'}</Title>

      {/* No level picker on a retry deck: it deals every missed card at once. */}
      {!retryOnly ? (
        <LevelSegment value={level} counts={countByLevel} onChange={setLevel} />
      ) : null}

      {items.length === 0 ? (
        <Card>
          <Body muted>
            {retryOnly
              ? emptyLevelCopy('cards', true)
              : emptyLevelCopy('cards', false)}
          </Body>
          <Button label="Back to set" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : finished ? (
        <Card>
          <Body>
            Done — {items.length - missed.size} of {items.length} got right.
          </Body>
          {missed.size > 0 ? (
            <Body muted>
              {missed.size} to retry. Coming back to those is where the learning happens.
            </Body>
          ) : null}
          {nextDueLevel ? (
            <Button
              label={`${LEVELS.find((l) => l.key === nextDueLevel.level)?.label}: ${nextDueLevel.count} due`}
              onPress={() => setLevel(nextDueLevel.level)}
            />
          ) : null}
          <Button
            label="Start again"
            variant={nextDueLevel ? 'secondary' : 'primary'}
            onPress={() => {
              // This level only. The other two keep their places.
              setIndex(() => 0);
              setRevealed(false);
              setMissed(new Set());
            }}
          />
          <Button label="Back to set" variant="secondary" onPress={() => router.back()} />
        </Card>
      ) : card ? (
        <>
          <ProgressBar value={index} total={items.length} />
          {dueNow > 0 ? (
            <Body muted>
              {dueNow} due for review today — those come first.
            </Body>
          ) : null}

          <FlipCard
            key={card.id}
            // The rewritten question when this card has beaten the student
            // three times, otherwise the original (Phase 8).
            question={promptFor(card)}
            answer={card.answer}
            revealed={revealed}
            onFlip={toggleReveal}
            onGrade={grade}
            // Only the first card teaches the controls; after that the hints
            // are noise competing with the question.
            showHints={index === 0}
            imageUri={figureUri ?? undefined}
          />

          {/* Buttons stay alongside the swipe: swiping is faster once learned,
              but a first-time user needs a visible way to answer, and desktop
              users are reaching for a mouse rather than dragging. */}
          {revealed ? (
            <>
              <View style={{ flexDirection: 'row', gap: space.sm }}>
                <View style={{ flex: 1 }}>
                  <Button
                    label="Missed"
                    variant="secondary"
                    onPress={() => gradeWithFeedback(false)}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label="Got it" onPress={() => gradeWithFeedback(true)} />
                </View>
              </View>

              {/* key: collapse state resets per card, so opening the source
                  on one card does not leave it open for the rest of the deck. */}
              <SourcePanel
                key={card.id}
                excerpt={card.source_excerpt}
                answer={card.answer}
                pageIndex={card.page_index}
                checkFlag={card.check_flag}
                onOpenPage={card.document_id ? openPage : undefined}
                onReport={report}
              />
              {reported ? <Notice tone="ok">Thanks — you won't see that one again.</Notice> : null}
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
