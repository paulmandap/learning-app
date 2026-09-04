import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, PanResponder, Platform, Pressable, Text, View } from 'react-native';
import {
  shouldCaptureGesture,
  swipeProgress,
  swipeVerdict,
  type SwipeVerdict,
} from '../core/gesture';
import { alignmentFor } from '../core/layout';
import { radius, space, swipeTint, type, useTheme } from './theme';

/**
 * The flashcard: a real card that flips and can be swiped away.
 *
 * Built on react-native's own Animated and PanResponder rather than an
 * animation library — both work through react-native-web, and one screen does
 * not justify a new dependency.
 *
 * Motion here is doing a job, not decorating. iOS Safari has no Vibration API,
 * so a PWA on iPhone cannot buzz; the flip, the drag, the colour wash and the
 * fly-off are what tell the user their input registered.
 */

const FLIP_MS = 320;
const CARD_MIN_HEIGHT = 260;

export interface FlipCardProps {
  question: string;
  answer: string;
  revealed: boolean;
  onFlip: () => void;
  /** Called once the card has animated away. */
  onGrade: (gotIt: boolean) => void;
  /**
   * Show the "tap to flip" / "swipe to grade" hints.
   *
   * Only the FIRST card of a session passes this. The hints teach a control
   * that is learned in one use, and after that they are two lines of text
   * competing with the question for attention on every single card. A card
   * face should carry the question or the answer, and nothing else.
   */
  showHints?: boolean;
}

export function FlipCard({
  question,
  answer,
  revealed,
  onFlip,
  onGrade,
  showHints = false,
}: FlipCardProps) {
  const t = useTheme();
  const [width, setWidth] = useState(0);

  const flip = useRef(new Animated.Value(0)).current;
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const entry = useRef(new Animated.Value(0)).current;

  // Refs mirror state the pan responder needs: the responder is created once,
  // so reading state directly inside it would capture the first render's values.
  const widthRef = useRef(0);
  const gradingRef = useRef(false);
  widthRef.current = width;

  // Flip whenever `revealed` changes, from a tap or from the keyboard.
  useEffect(() => {
    Animated.timing(flip, {
      toValue: revealed ? 1 : 0,
      duration: FLIP_MS,
      useNativeDriver: Platform.OS !== 'web',
    }).start();
  }, [revealed, flip]);

  // Each new card slides up and fades in, so the deck feels like it advances
  // rather than the text simply being replaced.
  useEffect(() => {
    entry.setValue(0);
    pan.setValue({ x: 0, y: 0 });
    gradingRef.current = false;
    Animated.spring(entry, {
      toValue: 1,
      useNativeDriver: Platform.OS !== 'web',
      friction: 9,
      tension: 60,
    }).start();
  }, [question, entry, pan]);

  const finish = (verdict: Exclude<SwipeVerdict, 'none'>) => {
    if (gradingRef.current) return;
    gradingRef.current = true;
    const w = widthRef.current || 350;

    Animated.timing(pan, {
      toValue: { x: verdict === 'gotIt' ? w * 1.4 : -w * 1.4, y: 0 },
      duration: 220,
      useNativeDriver: Platform.OS !== 'web',
    }).start(() => onGrade(verdict === 'gotIt'));
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        // Claim the gesture only once it is clearly horizontal, so the page
        // still scrolls normally under the card.
        onMoveShouldSetPanResponder: (_e, g) => shouldCaptureGesture(g.dx, g.dy),
        onPanResponderMove: (_e, g) => {
          if (gradingRef.current) return;
          pan.setValue({ x: g.dx, y: g.dy * 0.15 });
        },
        onPanResponderRelease: (_e, g) => {
          if (gradingRef.current) return;
          const verdict = swipeVerdict({
            dx: g.dx,
            dy: g.dy,
            vx: g.vx,
            width: widthRef.current,
          });

          if (verdict === 'none') {
            // Spring back: the card refusing to leave is the feedback that the
            // swipe was not decisive enough.
            Animated.spring(pan, {
              toValue: { x: 0, y: 0 },
              useNativeDriver: Platform.OS !== 'web',
              friction: 6,
              tension: 80,
            }).start();
            return;
          }
          finish(verdict);
        },
        onPanResponderTerminate: () => {
          Animated.spring(pan, {
            toValue: { x: 0, y: 0 },
            useNativeDriver: Platform.OS !== 'web',
            friction: 6,
          }).start();
        },
      }),
    // Created once; everything it needs is behind a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const frontRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const backRotate = flip.interpolate({ inputRange: [0, 1], outputRange: ['180deg', '360deg'] });

  const w = width || 350;
  const tilt = pan.x.interpolate({
    inputRange: [-w, 0, w],
    outputRange: ['-9deg', '0deg', '9deg'],
    extrapolate: 'clamp',
  });
  const gotItOpacity = pan.x.interpolate({
    inputRange: [0, w * 0.28],
    outputRange: [0, 0.85],
    extrapolate: 'clamp',
  });
  const missedOpacity = pan.x.interpolate({
    inputRange: [-w * 0.28, 0],
    outputRange: [0.85, 0],
    extrapolate: 'clamp',
  });

  // Each face is aligned on its OWN content: a one-word answer stays centred
  // behind a question that had to wrap. See src/core/layout.ts for the rule.
  const questionAlign = alignmentFor(question);
  const answerAlign = alignmentFor(answer);

  const faceBase = {
    position: 'absolute' as const,
    inset: 0 as never,
    backfaceVisibility: 'hidden' as const,
    backgroundColor: t.card,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.xl,
    justifyContent: 'center' as const,
  };

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View
        {...responder.panHandlers}
        style={{
          minHeight: CARD_MIN_HEIGHT,
          opacity: entry,
          transform: [
            { translateX: pan.x },
            { translateY: Animated.add(pan.y, entry.interpolate({ inputRange: [0, 1], outputRange: [16, 0] })) },
            { rotate: tilt },
          ],
        }}
      >
        <Pressable onPress={onFlip} style={{ minHeight: CARD_MIN_HEIGHT }}>
          {/* Front — the question, and nothing else.
              The level badge lived here and has been removed: the level segment
              at the top of the screen already says which level you are in, and
              a card should ask one thing without a caption arguing with it.

              Bold, per the type scale: weight is what marks this as the side
              being asked, so a card caught mid-flip is never ambiguous. */}
          <Animated.View style={[faceBase, { transform: [{ perspective: 1200 }, { rotateY: frontRotate }] }]}>
            <Text style={[type.cardPrompt, { color: t.text, textAlign: questionAlign }]}>
              {question}
            </Text>
            {showHints ? (
              <Text
                style={[
                  type.caption,
                  { color: t.textMuted, marginTop: space.lg, textAlign: questionAlign },
                ]}
              >
                {Platform.OS === 'web' ? 'Tap or press space to flip' : 'Tap to flip'}
              </Text>
            ) : null}
          </Animated.View>

          {/* Back — the answer, and nothing else. The "Answer" label is gone:
              the flip itself already said that. */}
          <Animated.View style={[faceBase, { transform: [{ perspective: 1200 }, { rotateY: backRotate }] }]}>
            <Text style={[type.card, { color: t.text, textAlign: answerAlign }]}>{answer}</Text>
            {showHints ? (
              <Text
                style={[
                  type.caption,
                  { color: t.textMuted, marginTop: space.lg, textAlign: answerAlign },
                ]}
              >
                Swipe right if you got it, left if you missed it
              </Text>
            ) : null}
          </Animated.View>

          {/* Colour wash — reaches full strength exactly where release commits,
              so the colour tells you what will happen before you let go. */}
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              inset: 0 as never,
              borderRadius: radius.lg,
              backgroundColor: swipeTint.gotIt,
              opacity: gotItOpacity,
            }}
          />
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              inset: 0 as never,
              borderRadius: radius.lg,
              backgroundColor: swipeTint.missed,
              opacity: missedOpacity,
            }}
          />
        </Pressable>
      </Animated.View>
    </View>
  );
}
