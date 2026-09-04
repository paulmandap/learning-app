import { useEffect, useMemo, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
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
import { gradeFeedback, hapticFlip } from '../../../src/ui/feedback';
import { radius, space, useTheme } from '../../../src/ui/theme';
import { listItems, reportItem, type StudyItem } from '../../../src/data/items';
import { missedItemIds, recordAttempt } from '../../../src/data/attempts';
import { listDocuments, signedUrlFor } from '../../../src/data/documents';
import { excerptMatches } from '../../../src/core/excerpt';
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
  const t = useTheme();

  // Default Understand, per the spec's level segment.
  const [level, setLevel] = useState<Level>('understand');
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [missed, setMissed] = useState<Set<string>>(new Set());
  const [reported, setReported] = useState<string | null>(null);

  const { data: allItems = [], isLoading } = useQuery({
    queryKey: ['items', setId, level],
    queryFn: () => listItems(setId, { level }),
  });
  const { data: missedSet } = useQuery({
    queryKey: ['missed', setId],
    queryFn: () => missedItemIds(setId),
  });

  // The missed pile (D8). Retention comes from coming back to what you got
  // wrong, so this is a first-class mode rather than a filter buried in a menu.
  const items = useMemo(
    () => (retryOnly ? allItems.filter((i) => missedSet?.has(i.id)) : allItems),
    [allItems, retryOnly, missedSet],
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
              label={l.label}
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
          <Button label="Back to set" variant="secondary" onPress={() => router.replace(`/set/${setId}`)} />
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

          <FlipCard
            key={card.id}
            question={card.prompt}
            answer={card.answer}
            revealed={revealed}
            onFlip={toggleReveal}
            onGrade={grade}
            // Only the first card teaches the controls; after that the hints
            // are noise competing with the question.
            showHints={index === 0}
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

              {/* key: collapse state resets per card, so opening the source on
                  one card does not leave it open for the rest of the deck. */}
              <SourceCard key={card.id} card={card} onOpenPage={openPage} onReport={report} />
              {reported ? <Notice tone="ok">Thanks — you won't see that one again.</Notice> : null}
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

/**
 * The source chip, with the excerpt COLLAPSED behind it.
 *
 * The chip stays visible on every card, because "shows me where every answer
 * came from" is the product's promise and it has to be legible without
 * hunting. What is hidden is the answer to a question the user has not asked
 * yet: most of the time you flip a card, agree with the answer, and move on.
 * Showing a paragraph of source text unbidden on every card competes with the
 * answer you just turned over, and two blocks of prose saying nearly the same
 * thing is worse than one.
 *
 * `check_flag` deliberately stays OUTSIDE the collapse. It is a warning that
 * the notes may contradict standard knowledge, and a warning nobody opened is
 * not a warning.
 *
 * The matched phrase is highlighted using the span the validator already
 * computed against the stored page text — this is why excerpt verification
 * returns a span rather than just a boolean.
 */
function SourceCard({
  card,
  onOpenPage,
  onReport,
}: {
  card: StudyItem;
  onOpenPage: () => void;
  onReport: () => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);

  const highlighted = useMemo(() => {
    const excerpt = card.source_excerpt;
    const answer = card.answer;
    const match = excerptMatches(answer, excerpt);
    if (!match.matched || !match.span) return null;
    return {
      before: excerpt.slice(0, match.span.start),
      hit: excerpt.slice(match.span.start, match.span.end),
      after: excerpt.slice(match.span.end),
    };
  }, [card.source_excerpt, card.answer]);

  const pageLabel = card.page_index !== null ? `p.${card.page_index + 1}` : null;

  return (
    <Card>
      {/* The chip IS the control. One tap, no separate "show more" link to
          explain — the thing you would tap to see the source is the thing
          that names it. */}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => setOpen((o) => !o)}
          style={{
            backgroundColor: t.bg,
            borderColor: t.border,
            borderWidth: 1,
            borderRadius: 999,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}
        >
          <Text style={{ color: t.textMuted, fontSize: 13 }}>
            Source{pageLabel ? ` · ${pageLabel}` : ''} {open ? '▴' : '▾'}
          </Text>
        </Pressable>

        <View style={{ flex: 1 }} />

        {/* Demoted from a full-width button to a quiet link. "Report this card"
            IS the second verification pass at this scale (D7), so it must stay
            reachable — but it is used on perhaps one card in fifty, and giving
            it the same visual weight as "Got it" was overstating it. */}
        <Pressable accessibilityRole="button" onPress={onReport} hitSlop={8}>
          <Text style={{ color: t.textMuted, fontSize: 13, textDecorationLine: 'underline' }}>
            Report
          </Text>
        </Pressable>
      </View>

      {/* A warning is never collapsed — see the note above. */}
      {card.check_flag ? (
        <Notice tone="warn">
          Worth double-checking against your course material: {card.check_flag}
        </Notice>
      ) : null}

      {open ? (
        <>
          {highlighted ? (
            <Text style={{ color: t.text, fontSize: 15, lineHeight: 22 }}>
              {highlighted.before}
              <Text style={{ backgroundColor: t.warnBg, color: t.warnText }}>{highlighted.hit}</Text>
              {highlighted.after}
            </Text>
          ) : (
            <Body>{card.source_excerpt}</Body>
          )}

          {card.document_id ? (
            <>
              <Button label="Open page" variant="secondary" onPress={onOpenPage} />
              {pageLabel ? (
                // Stated in text because iOS Safari ignores #page= and opens at
                // page 1 — the number has to be readable even when the jump fails.
                <Body muted>Opens your file. Look for page {(card.page_index ?? 0) + 1}.</Body>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
