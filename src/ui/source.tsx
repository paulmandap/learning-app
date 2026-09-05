import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Body, Button, Card, Notice } from './components';
import { space, useTheme } from './theme';
import { excerptMatches } from '../core/excerpt';

/**
 * "Source · p.14", with the excerpt collapsed behind it.
 *
 * Shared by Flashcards and Quiz. It began as a private component in
 * flashcards.tsx and was lifted here when Quiz needed the same thing — the quiz
 * was printing the excerpt inline and unconditionally, which put a paragraph of
 * prose under every answered question and read as a different app.
 *
 * The chip stays visible on every card, because "shows me where every answer
 * came from" is the product's promise and it has to be legible without hunting.
 * What is hidden is the answer to a question the user has not asked yet: most of
 * the time you see the verdict, agree with it, and move on.
 *
 * `checkFlag` deliberately stays OUTSIDE the collapse. It is a warning that the
 * notes may contradict standard knowledge, and a warning nobody opened is not a
 * warning.
 */
export function SourcePanel({
  excerpt,
  answer,
  pageIndex,
  checkFlag,
  onOpenPage,
  onReport,
}: {
  excerpt: string;
  /** Highlighted inside the excerpt when it can be located there. */
  answer: string;
  pageIndex: number | null;
  checkFlag?: string | null;
  onOpenPage?: () => void;
  onReport?: () => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);

  // The matched phrase is highlighted using the span the validator already
  // computed against the stored page text — this is why excerpt verification
  // returns a span rather than just a boolean.
  const highlighted = useMemo(() => {
    const match = excerptMatches(answer, excerpt);
    if (!match.matched || !match.span) return null;
    return {
      before: excerpt.slice(0, match.span.start),
      hit: excerpt.slice(match.span.start, match.span.end),
      after: excerpt.slice(match.span.end),
    };
  }, [excerpt, answer]);

  const pageLabel = pageIndex !== null ? `p.${pageIndex + 1}` : null;

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
        {onReport ? (
          <Pressable accessibilityRole="button" onPress={onReport} hitSlop={8}>
            <Text style={{ color: t.textMuted, fontSize: 13, textDecorationLine: 'underline' }}>
              Report
            </Text>
          </Pressable>
        ) : null}
      </View>

      {/* A warning is never collapsed — see the note above. */}
      {checkFlag ? (
        <Notice tone="warn">Worth double-checking against your course material: {checkFlag}</Notice>
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
            <Body>{excerpt}</Body>
          )}

          {onOpenPage ? (
            <>
              <Button label="Open page" variant="secondary" onPress={onOpenPage} />
              {pageLabel ? (
                // Stated in text because iOS Safari ignores #page= and opens at
                // page 1 — the number has to be readable even when the jump fails.
                <Body muted>Opens your file. Look for page {(pageIndex ?? 0) + 1}.</Body>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}
