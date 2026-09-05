import { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import {
  Body,
  Button,
  Card,
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
import { missedItemIds, recordAttempt } from '../../../src/data/attempts';
import { fetchProfile } from '../../../src/data/profile';
import { reviewStatesForSet } from '../../../src/data/review';
import { isDue, reviewOrder } from '../../../src/core/schedule';
import { listDocuments, signedUrlFor } from '../../../src/data/documents';
import type { Level } from '../../../src/core/planner';

const LEVELS: { key: Level; label: string }[] = [
  { key: 'remember', label: 'Remember' },
  { key: 'understand', label: 'Understand' },
  { key: 'apply', label: 'Apply' },
];

export default function Flashcards() {
  const { id, retry } = useLocalSearchParams<{ id: string; retry?: string }>();
  const setId = String(id);
  const retryOnly = retry === '1';
  const router = useRouter();

  // Default Understand, per the spec's level segment.
  const [level, setLevel] = useState<Level>('understand');
  const [index, setIndex] = useState(0);
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
    if (retryOnly) return atLevel.filter((i) => missedSet?.has(i.id));
    return reviewOrder(atLevel, (i) => schedules?.get(i.id), Date.now());
  }, [atLevel, retryOnly, missedSet, schedules]);

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
  const { data: docs = [] } = useQuery({
    queryKey: ['docs', setId],
    queryFn: () => listDocuments(setId),
  });

  useEffect(() => {
    setIndex(0);
    setRevealed(false);
    setReported(null);
  }, [level, retryOnly]);

  // Build the hidden haptic switch before it is needed. Created on demand, the
  // very first tap was lost to a DOM race — which read as "swipes do not buzz"
  // if a swipe happened to be the first thing you did.
  useEffect(() => {
    primeFeedback();
  }, []);

  const card: StudyItem | undefined = items[index];

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
    void recordAttempt({
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
        <Body muted>Loading…</Body>
      </Screen>
    );
  }

  const finished = index >= items.length;

  return (
    <Screen>
      <Title>{retryOnly ? 'Retry what you missed' : 'Flashcards'}</Title>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        {LEVELS.map((l) => (
          <View key={l.key} style={{ flex: 1 }}>
            <Button
              label={`${l.label} ${countByLevel[l.key] ?? 0}`}
              variant={level === l.key ? 'primary' : 'secondary'}
              onPress={() => setLevel(l.key)}
            />
          </View>
        ))}
      </View>

      {items.length === 0 ? (
        <Card>
          <Body muted>
            {retryOnly
              ? 'Nothing to retry here — you have not missed anything at this level yet.'
              : 'No cards at this level yet.'}
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
          <Button
            label="Start again"
            onPress={() => {
              setIndex(0);
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
