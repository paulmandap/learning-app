import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Image, PanResponder, Platform, Pressable, Text, View } from 'react-native';
import {
  shouldCaptureGesture,
  swipeProgress,
  swipeVerdict,
  type SwipeVerdict,
} from '../core/gesture';
import { alignmentFor } from '../core/layout';
import { gradeFeedback } from './feedback';
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

/**
 * Ceiling on a card's source picture.
 *
 * The picture keeps its own aspect ratio and is capped here, rather than being
 * forced into a fixed height. A fixed box cropped a wide diagram to its top
 * band — the title and two labels visible, the other four cut off — which
 * removes exactly what the card is asking about. The cap still guarantees the
 * question is never pushed off the card.
 */
const FIGURE_MAX_HEIGHT = 220;

/** Fallback shape until the real one is known, so the layout does not jump far. */
const FIGURE_FALLBACK_RATIO = 4 / 3;

export interface FlipCardProps {
  question: string;
  answer: string;
  /**
   * The source picture, for cards made from an uploaded image (Phase 7a).
   *
   * Shown on the QUESTION face only. A card asking "which organ is the primary
   * photosynthetic organ?" is far easier to answer with the drawing in front of
   * you; the answer face is a few words and gains nothing from it.
   *
   * This is the whole diagram, not a highlighted part — label-position
   * questions are the postponed §6 feature and are gated separately.
   */
  imageUri?: string;
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
  imageUri,
}: FlipCardProps) {
  const t = useTheme();
  const [width, setWidth] = useState(0);

  /**
   * The picture's true aspect ratio, so the whole of it is shown.
   *
   * Measured with Image.getSize rather than assumed: a diagram is whatever
   * shape the student photographed, and guessing crops it.
   */
  const [figureRatio, setFigureRatio] = useState(FIGURE_FALLBACK_RATIO);
  useEffect(() => {
    if (!imageUri) return;
    let live = true;
    Image.getSize(
      imageUri,
      (w, h) => {
        if (live && h > 0) setFigureRatio(w / h);
      },
      () => {
        // Unreachable image: keep the fallback shape rather than collapsing the
        // card. The <Image> below will simply render nothing.
      },
    );
    return () => {
      live = false;
    };
  }, [imageUri]);

  const flip = useRef(new Animated.Value(0)).current;
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  const entry = useRef(new Animated.Value(0)).current;

  // Refs mirror state the pan responder needs: the responder is created once,
  // so reading state directly inside it would capture the first render's values.
  const widthRef = useRef(0);
  const gradingRef = useRef(false);
  /** One buzz per gesture, whichever path gets there first. */
  const buzzedRef = useRef(false);
  /** Latest drag offsets, for the native touchend listener. */
  const lastDragRef = useRef({ dx: 0, dy: 0 });
  /** The card's DOM node on web, so a real touchend listener can be attached. */
  const cardRef = useRef<View | null>(null);
  widthRef.current = width;

  /**
   * Fire grade feedback at most once per gesture.
   *
   * Two paths race to do this — the native touchend listener and finish() — and
   * which one wins depends on event ordering we do not control. Both call this.
   */
  const buzzOnce = (gotIt: boolean) => {
    if (buzzedRef.current) return;
    buzzedRef.current = true;
    gradeFeedback(gotIt);
  };

  /**
   * Grade feedback fired from a REAL touchend listener rather than PanResponder.
   *
   * Built as the third attempt at making swipes buzz on iOS, on the theory that
   * the call needed to sit inside the touchend dispatch to be granted transient
   * user activation. **It did not work** — see the note in ./feedback.ts. On a
   * swipe the sound plays from the very same call and the haptic does not, so
   * the ceiling is Safari's, not this code's.
   *
   * Kept because it is correct on Android, where navigator.vibrate works during
   * a drag, and because it is where the sound is triggered from on a swipe.
   * Web-only by construction; a native build has a real haptics API instead.
   */
  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = cardRef.current as unknown as HTMLElement | null;
    if (!node || typeof node.addEventListener !== 'function') return;

    const onTouchEnd = () => {
      const { dx, dy } = lastDragRef.current;
      // Distance only: velocity is not available here, and a flick too short to
      // qualify on distance is handled by finish() instead.
      const verdict = swipeVerdict({ dx, dy, vx: 0, width: widthRef.current });
      if (verdict !== 'none') buzzOnce(verdict === 'gotIt');
      lastDragRef.current = { dx: 0, dy: 0 };
    };

    node.addEventListener('touchend', onTouchEnd);
    return () => node.removeEventListener('touchend', onTouchEnd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    buzzedRef.current = false;
    lastDragRef.current = { dx: 0, dy: 0 };
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

    // Covers a fast flick that never travelled far enough for the touchend
    // listener to call it, and mouse or keyboard input where there is no touch
    // event at all. Guarded so a normal swipe still feeds back exactly once.
    buzzOnce(verdict === 'gotIt');

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

          // Remembered for the native touchend listener below, which is where
          // the haptic actually fires and which is not given the gesture state.
          lastDragRef.current = { dx: g.dx, dy: g.dy };
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
          lastDragRef.current = { dx: 0, dy: 0 };
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

  // The card face's usable width, inside its padding.
  const figureWidth = Math.max(0, width - space.xl * 2);
  // Fit to width, then cap: a tall picture is limited by FIGURE_MAX_HEIGHT, a
  // wide one by the card itself. Either way the whole picture is visible.
  const figureHeight = Math.min(FIGURE_MAX_HEIGHT, Math.round(figureWidth / figureRatio));

  /**
   * The card grows to fit a picture.
   *
   * Both faces are absolutely positioned so they can flip against each other,
   * which means they take their height from THIS container — a fixed 260 left a
   * tall diagram spilling over the progress bar above and clipped at the bottom.
   * The container has to account for the picture the face is going to draw.
   */
  const cardHeight =
    imageUri && figureWidth > 0
      ? CARD_MIN_HEIGHT + figureHeight + space.md
      : CARD_MIN_HEIGHT;

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
        ref={cardRef}
        {...responder.panHandlers}
        style={{
          minHeight: cardHeight,
          opacity: entry,
          transform: [
            { translateX: pan.x },
            { translateY: Animated.add(pan.y, entry.interpolate({ inputRange: [0, 1], outputRange: [16, 0] })) },
            { rotate: tilt },
          ],
        }}
      >
        <Pressable onPress={onFlip} style={{ minHeight: cardHeight }}>
          {/* Front — the question, and nothing else.
              The level badge lived here and has been removed: the level segment
              at the top of the screen already says which level you are in, and
              a card should ask one thing without a caption arguing with it.

              Bold, per the type scale: weight is what marks this as the side
              being asked, so a card caught mid-flip is never ambiguous. */}
          <Animated.View style={[faceBase, { transform: [{ perspective: 1200 }, { rotateY: frontRotate }] }]}>
            {imageUri && figureWidth > 0 ? (
              // contain, not cover: a diagram cropped to fill the box loses the
              // labels round its edge, which are the entire point of showing it.
              <Image
                source={{ uri: imageUri }}
                resizeMode="contain"
                accessibilityLabel="The picture these notes came from"
                style={{
                  // EXPLICIT pixel width and height, computed from the card's
                  // measured width and the picture's real shape.
                  //
                  // Two earlier attempts failed on react-native-web: a fixed
                  // height cropped a wide diagram to its top band (title and two
                  // labels visible, four cut off), and width:'100%' with
                  // aspectRatio + maxHeight collapsed the element to nothing.
                  // Numbers cannot do either.
                  width: figureWidth,
                  height: figureHeight,
                  marginBottom: space.md,
                  borderRadius: radius.sm,
                  backgroundColor: t.bg,
                }}
              />
            ) : null}
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
