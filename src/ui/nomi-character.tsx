import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  AppState,
  Easing as RNEasing,
  Image,
  Platform,
  View,
} from 'react-native';
import bodyArt from '../../assets/nomi-body.webp';
import wingLeftArt from '../../assets/nomi-wing-left.webp';
import wingRightArt from '../../assets/nomi-wing-right.webp';
import eyesArt from '../../assets/nomi-eyes.webp';
import {
  CHANNELS,
  entryPose,
  motionFor,
  nextBlinkDelay,
  segments,
  SETTLE_MS,
  type Channel,
  type Easing,
  type NomiState,
} from '../core/nomi-motion';
import { NOMI_RIG } from './nomi-rig';

/**
 * Nomi, drawn and moving.
 *
 * The ONLY file that knows the owl is four stacked pictures. Screens ask for a
 * state by name — `<NomiCharacter state="thinking" />` — and never see an
 * `Animated.Value`. What each state does lives in `src/core/nomi-motion.ts`,
 * where it can be tested; this turns it into motion.
 *
 * ## The parts
 *
 * Cut from the reference sheet's canonical pose by `scripts/make-nomi-assets.ts`:
 * a body, two wings that rotate about their shoulders, and the irises, which
 * squash to blink and shift to look. All four are the same size, so they stack
 * with no layout at all, and `NOMI_RIG` says where the pivots are.
 *
 * ## Performance, and the phone it has to run on
 *
 *  - **Transform and opacity only**, so the native driver runs everything off
 *    the JS thread. Off on the web, where there is no native driver — the same
 *    rule `flashcard.tsx` follows — and react-native-web writes the styles
 *    directly, still without a React render.
 *  - **No per-frame state.** One `Animated.Value` per channel, created once.
 *  - **Nothing runs unseen.** Loops stop on unmount, when `active` is false (a
 *    screen that is not focused), and while the app is in the background, and
 *    no timer outlives the component.
 *
 * ## Reduced motion
 *
 * Honoured from the system setting, live. The canonical pose holds still;
 * appearing and leaving still fade, and nothing blinks. Until the setting is
 * known — one tick — nothing starts, so someone who asked for less motion never
 * sees the first half-second of a wave.
 */

const NATIVE = Platform.OS !== 'web';

const EASINGS: Record<Easing, (t: number) => number> = {
  inOut: RNEasing.inOut(RNEasing.quad),
  out: RNEasing.out(RNEasing.quad),
  in: RNEasing.in(RNEasing.quad),
  linear: RNEasing.linear,
};

/** The system's reduce-motion setting; `null` until it has been read. */
function useReducedMotion(): boolean | null {
  const [reduce, setReduce] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (alive) setReduce(value);
      })
      .catch(() => {
        if (alive) setReduce(false);
      });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', (value) =>
      setReduce(value),
    );
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, []);
  return reduce;
}

/** False while the app is backgrounded — or, on the web, the tab is hidden. */
function useAppVisible(): boolean {
  const [visible, setVisible] = useState(AppState.currentState !== 'background');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => setVisible(next === 'active'));
    return () => subscription.remove();
  }, []);
  return visible;
}

export function NomiCharacter({
  state,
  size,
  settle,
  onDone,
  active = true,
  accessibilityLabel,
}: {
  state: NomiState;
  /** Height in points. The width follows the art. */
  size: number;
  /**
   * What a one-shot settles into instead of idle — `studying` on a deck, so
   * an answer landing does not wake Nomi up out of reading.
   */
  settle?: NomiState;
  /** Called when a one-shot finishes. How a screen waits for `goodbye`. */
  onDone?: (finished: NomiState) => void;
  /** False stops everything — for a screen that is mounted but not showing. */
  active?: boolean;
  /** Omit where Nomi sits inside a control that is already labelled. */
  accessibilityLabel?: string;
}) {
  const reduce = useReducedMotion();
  const visible = useAppVisible();
  const running = active && visible && reduce !== null;

  const H = size;
  const W = (size * NOMI_RIG.width) / NOMI_RIG.height;

  // Created once, in the first state's starting pose — so a greeting begins
  // invisible rather than flashing the resting owl for a frame first.
  const valuesRef = useRef<Record<Channel, Animated.Value> | null>(null);
  if (!valuesRef.current) {
    const pose = entryPose(motionFor(state));
    valuesRef.current = Object.fromEntries(
      CHANNELS.map((c) => [c, new Animated.Value(pose[c])]),
    ) as Record<Channel, Animated.Value>;
  }
  const v = valuesRef.current;
  const blink = useRef(new Animated.Value(1)).current;

  // What is playing can differ from what was asked for: a one-shot hands over
  // to idle (or `settle`) on its own, without the screen having to know.
  const [playing, setPlaying] = useState<NomiState>(state);
  useEffect(() => setPlaying(state), [state]);

  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const settleRef = useRef(settle);
  settleRef.current = settle;
  const firstRun = useRef(true);

  useEffect(() => {
    if (!running) return;
    const motion = motionFor(playing, { reduceMotion: !!reduce });
    const pose = entryPose(motion);
    const settleMs = firstRun.current ? 0 : SETTLE_MS;
    firstRun.current = false;

    // A one-shot starts its tracks at once, from wherever each channel is,
    // and only the channels it leaves alone ease back to rest alongside. So a
    // goodbye is not preceded by a quarter-second of nothing — leaving the
    // screen waits for it. A loop settles first, because Animated.loop
    // restarts each cycle from where the first one began, and that has to be
    // the loop's own first frame or every cycle opens with a jump.
    const tracked = new Set(motion.tracks.map((track) => track.channel));
    const settleChannels = motion.loop ? CHANNELS : CHANNELS.filter((c) => !tracked.has(c));
    const settleAnim = Animated.parallel(
      settleChannels.map((c) =>
        Animated.timing(v[c], {
          toValue: pose[c],
          duration: settleMs,
          easing: EASINGS.inOut,
          useNativeDriver: NATIVE,
        }),
      ),
    );
    const tracks = Animated.parallel(
      motion.tracks.map((track) =>
        Animated.sequence(
          segments(track).map((s) =>
            Animated.timing(v[track.channel], {
              toValue: s.toValue,
              duration: s.duration,
              easing: EASINGS[s.easing],
              useNativeDriver: NATIVE,
            }),
          ),
        ),
      ),
    );

    // An empty loop is never started: Animated.loop over nothing restarts
    // itself synchronously, forever. Reduced-motion idle is exactly that.
    const animation = motion.loop
      ? Animated.sequence(motion.tracks.length > 0 ? [settleAnim, Animated.loop(tracks)] : [settleAnim])
      : Animated.parallel([settleAnim, tracks]);

    animation.start(({ finished }) => {
      if (!finished || motion.loop) return;
      onDoneRef.current?.(motion.state);
      const next = motion.next === 'idle' ? (settleRef.current ?? 'idle') : motion.next;
      if (next) setPlaying(next);
    });
    return () => animation.stop();
  }, [playing, running, reduce, v]);

  useEffect(() => {
    if (!running || reduce) return;
    const spec = motionFor(playing).blink;
    if (!spec) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let animation: Animated.CompositeAnimation | undefined;
    const schedule = () => {
      timer = setTimeout(() => {
        animation = Animated.sequence([
          Animated.timing(blink, { toValue: 0.1, duration: 60, useNativeDriver: NATIVE }),
          Animated.delay(Math.max(0, spec.closedMs - 60)),
          Animated.timing(blink, { toValue: 1, duration: 90, useNativeDriver: NATIVE }),
        ]);
        animation.start(({ finished }) => {
          if (finished) schedule();
        });
      }, nextBlinkDelay(spec, Math.random));
    };
    schedule();

    return () => {
      if (timer) clearTimeout(timer);
      animation?.stop();
      blink.setValue(1);
    };
  }, [playing, running, reduce, blink]);

  const transforms = useMemo(() => {
    const degrees = (value: Animated.Value, sign: 1 | -1) =>
      value.interpolate({
        inputRange: [-360, 360],
        outputRange: [`${-360 * sign}deg`, `${360 * sign}deg`],
      });
    // Rotation about a point that is not the centre: move the point to the
    // centre, rotate, move it back. Portable to every platform, unlike
    // transformOrigin.
    const about = (px: number, py: number, rotate: Animated.AnimatedInterpolation<string>) => [
      { translateX: px - W / 2 },
      { translateY: py - H / 2 },
      { rotate },
      { translateX: W / 2 - px },
      { translateY: H / 2 - py },
    ];
    const eyeRadius = NOMI_RIG.eyeRadius * W;
    const eyeLine = NOMI_RIG.eyeLine * H;

    return {
      figure: [
        { translateY: v.lift.interpolate({ inputRange: [-1, 1], outputRange: [-H, H] }) },
        // Tilt about the feet, so a thinking owl leans rather than spins.
        { translateY: H / 2 },
        { rotate: degrees(v.tilt, 1) },
        { translateY: -H / 2 },
        { scale: v.scale },
      ],
      // Both wings take positive as OUTWARD, so the right one turns the other way.
      wingLeft: about(NOMI_RIG.wingLeftPivot[0] * W, NOMI_RIG.wingLeftPivot[1] * H, degrees(v.wingLeft, 1)),
      wingRight: about(
        NOMI_RIG.wingRightPivot[0] * W,
        NOMI_RIG.wingRightPivot[1] * H,
        degrees(v.wingRight, -1),
      ),
      eyes: [
        { translateX: v.lookX.interpolate({ inputRange: [-1, 1], outputRange: [-eyeRadius, eyeRadius] }) },
        { translateY: v.lookY.interpolate({ inputRange: [-1, 1], outputRange: [-eyeRadius, eyeRadius] }) },
        // Blink squashes toward the line through both eyes, not the picture's middle.
        { translateY: eyeLine - H / 2 },
        { scaleY: blink },
        { translateY: H / 2 - eyeLine },
      ],
    };
  }, [W, H, v, blink]);

  // Explicit pixel sizes on every picture — §8.1's lesson on react-native-web,
  // where the other two ways of sizing an image cropped it or collapsed it.
  const layer = { position: 'absolute' as const, left: 0, top: 0, width: W, height: H };

  return (
    <View
      style={{ width: W, height: H, pointerEvents: 'none' }}
      accessible={!!accessibilityLabel}
      accessibilityRole={accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={accessibilityLabel}
      importantForAccessibility={accessibilityLabel ? 'yes' : 'no-hide-descendants'}
    >
      <Animated.View style={{ width: W, height: H, opacity: v.opacity, transform: transforms.figure }}>
        <Image source={bodyArt} style={layer} />
        <Animated.View style={[layer, { transform: transforms.eyes }]}>
          <Image source={eyesArt} style={layer} />
        </Animated.View>
        <Animated.View style={[layer, { transform: transforms.wingLeft }]}>
          <Image source={wingLeftArt} style={layer} />
        </Animated.View>
        <Animated.View style={[layer, { transform: transforms.wingRight }]}>
          <Image source={wingRightArt} style={layer} />
        </Animated.View>
      </Animated.View>
    </View>
  );
}
