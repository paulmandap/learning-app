import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  AppState,
  Easing as RNEasing,
  Image,
  Platform,
  View,
} from 'react-native';
import { useTheme } from './theme';
import bodyArt from '../../assets/nomi-body.webp';
import wingLeftArt from '../../assets/nomi-wing-left.webp';
import wingRightArt from '../../assets/nomi-wing-right.webp';
import eyeLeftArt from '../../assets/nomi-eye-left.webp';
import eyeRightArt from '../../assets/nomi-eye-right.webp';
import {
  CHANNELS,
  entryPose,
  motionFor,
  nextBlinkDelay,
  segments,
  SETTLE_MS,
  zzz,
  type Channel,
  type Easing,
  type NomiState,
} from '../core/nomi-motion';
import { NOMI_RIG } from './nomi-rig';
import { useReducedMotion } from './motion';

/**
 * Nomi, drawn and moving.
 *
 * The ONLY file that knows the owl is stacked pictures. Screens ask for a
 * state by name — `<NomiCharacter state="thinking" />` — and never see an
 * `Animated.Value`. What each state does lives in `src/core/nomi-motion.ts`,
 * where it can be tested; this turns it into motion.
 *
 * ## The parts
 *
 * Cut from the reference sheet's canonical pose by `scripts/make-nomi-assets.ts`:
 * a body, two wings that rotate about their shoulders, and each iris, which
 * squashes to blink and shifts to look. Each eye blinks toward its own line,
 * because Nomi's head tilts and the two are not level (NOTES §41). All the
 * pictures are the same size, so they stack with no layout at all, and
 * `NOMI_RIG` says where the pivots are.
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
 * ## Faces, drawn in code (NOTES §49)
 *
 * The pictures are one pose with one face. The reference sheet's other faces —
 * "^ ^" when happy, a sleepy lid — are drawn here, over the eyes, at the centres
 * and in the face colour that `scripts/make-nomi-assets.ts` measured into the
 * rig: an arc for each happy eye while the iris squashes away (the face is
 * already painted behind it, for blinking), a face-coloured lid clipped to each
 * eye, and pink in the cheeks. A drawing cut from a new picture could not line
 * up with these layers; a shape drawn at the measured spot always does.
 *
 * ## Reduced motion
 *
 * Honoured from the system setting, live. The canonical pose holds still;
 * appearing and leaving still fade, and nothing blinks. Until the setting is
 * known — one tick — nothing starts, so someone who asked for less motion never
 * sees the first half-second of a wave.
 */

/** The dark of Nomi's eyes, for the happy arcs and the lid's edge. */
const INK = '#3a2519';
const BLUSH = '#f0928f';

const NATIVE = Platform.OS !== 'web';

const EASINGS: Record<Easing, (t: number) => number> = {
  inOut: RNEasing.inOut(RNEasing.quad),
  out: RNEasing.out(RNEasing.quad),
  in: RNEasing.in(RNEasing.quad),
  linear: RNEasing.linear,
};

// The reduce-motion setting is read by `useReducedMotion` in ./motion.ts, shared
// since NOTES §37 with everything else that moves.

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
  gaze,
}: {
  state: NomiState;
  /**
   * Somewhere else to look, on top of the state's own look — a finger or the
   * mouse (NOTES §49). Values the caller moves, so following the pointer
   * never re-renders anything; `lookToward` keeps them inside `GAZE_MAX`.
   */
  gaze?: { x: Animated.Value; y: Animated.Value };
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
    // screen waits for it. A loop settles first, onto its own first frame, and
    // then each cycle runs on from where the last one ended.
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
    const tracks = () =>
      Animated.parallel(
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

    let animation: Animated.CompositeAnimation;
    let stopped = false;
    if (motion.loop) {
      // Each cycle is a new animation, run from where the last one ended — its
      // own first frame, because every loop joins up (tests/nomi-motion.test.ts).
      //
      // Not Animated.loop, which before every cycle resets each value to the
      // one it was CREATED with. That is only right for a channel whose first
      // state began where this loop does, and measured on the sleepy lid (NOTES
      // §49) it was not: Nomi on Home is created thinking, lid open, so the lid
      // closed over each 5.2s cycle and sprang open again at the next.
      //
      // An empty loop never cycles — over nothing it would restart itself at
      // once, forever. Reduced-motion idle is exactly that.
      const cycle = () => {
        if (stopped || motion.tracks.length === 0) return;
        animation = tracks();
        animation.start(({ finished }) => {
          if (finished) cycle();
        });
      };
      animation = settleAnim;
      settleAnim.start(({ finished }) => {
        if (finished) cycle();
      });
    } else {
      animation = Animated.parallel([settleAnim, tracks()]);
      animation.start(({ finished }) => {
        if (!finished) return;
        onDoneRef.current?.(motion.state);
        const next = motion.next === 'idle' ? (settleRef.current ?? 'idle') : motion.next;
        if (next) setPlaying(next);
      });
    }
    return () => {
      stopped = true;
      animation.stop();
    };
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
    // The state's own look, and a pointer's on top of it when one is followed.
    const lookX = gaze ? Animated.add(v.lookX, gaze.x) : v.lookX;
    const lookY = gaze ? Animated.add(v.lookY, gaze.y) : v.lookY;
    // Shut by a blink, and squashed away while the eyes are closed happy — the
    // arcs drawn over them are the eyes then (NOTES §49).
    const open = Animated.multiply(blink, v.happy.interpolate({ inputRange: [0, 1], outputRange: [1, 0.04] }));
    // One eye: looks with the other, and blinks toward its OWN line.
    const eye = (line: number) => [
      { translateX: lookX.interpolate({ inputRange: [-1, 1], outputRange: [-eyeRadius, eyeRadius] }) },
      { translateY: lookY.interpolate({ inputRange: [-1, 1], outputRange: [-eyeRadius, eyeRadius] }) },
      { translateY: line * H - H / 2 },
      { scaleY: open },
      { translateY: H / 2 - line * H },
    ];

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
      eyeLeft: eye(NOMI_RIG.eyeLeftLine),
      eyeRight: eye(NOMI_RIG.eyeRightLine),
      // Gone while closed happy: squashed alone, an iris left a thin dark line
      // through each "^" (§49, seen in the first screenshot).
      eyeOpacity: v.happy.interpolate({ inputRange: [0, 0.6, 1], outputRange: [1, 0, 0] }),
    };
  }, [W, H, v, blink, gaze]);

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
        <Animated.View style={[layer, { opacity: transforms.eyeOpacity, transform: transforms.eyeLeft }]}>
          <Image source={eyeLeftArt} style={layer} />
        </Animated.View>
        <Animated.View style={[layer, { opacity: transforms.eyeOpacity, transform: transforms.eyeRight }]}>
          <Image source={eyeRightArt} style={layer} />
        </Animated.View>
        <Faces W={W} H={H} v={v} />
        <Animated.View style={[layer, { transform: transforms.wingLeft }]}>
          <Image source={wingLeftArt} style={layer} />
        </Animated.View>
        <Animated.View style={[layer, { transform: transforms.wingRight }]}>
          <Image source={wingRightArt} style={layer} />
        </Animated.View>
      </Animated.View>
      {running && !reduce && zzz(playing) ? <Zzz W={W} H={H} /> : null}
    </View>
  );
}

/**
 * The faces the pictures cannot show (NOTES §49), each at an eye the rig
 * measured and all at rest invisible, so the canonical owl is exactly the
 * pictures until a state asks for more.
 */
function Faces({ W, H, v }: { W: number; H: number; v: Record<Channel, Animated.Value> }) {
  const r = NOMI_RIG.eyeRadius * W;
  const eyes = [NOMI_RIG.eyeLeftCenter, NOMI_RIG.eyeRightCenter].map(([fx, fy], i) => ({
    x: fx * W,
    y: fy * H,
    // Outward, for the cheeks: left of the left eye, right of the right.
    side: i === 0 ? -1 : 1,
  }));
  const lid = r * 1.08;

  return (
    <>
      {eyes.map((e, i) => (
        <View key={`face-${i}`} style={{ position: 'absolute', left: 0, top: 0, width: W, height: H }}>
          {/* A sleepy lid: the face's own colour, coming down over the eye, with a dark edge. */}
          <View
            style={{
              position: 'absolute',
              left: e.x - lid,
              top: e.y - lid,
              width: lid * 2,
              height: lid * 2,
              borderRadius: lid,
              overflow: 'hidden',
            }}
          >
            <Animated.View
              style={{
                width: lid * 2,
                height: lid * 2,
                backgroundColor: NOMI_RIG.faceColour,
                borderBottomWidth: Math.max(1, r * 0.18),
                borderBottomColor: INK,
                transform: [{ translateY: v.lid.interpolate({ inputRange: [0, 1], outputRange: [-lid * 2, 0] }) }],
              }}
            />
          </View>
          {/* Closed happy: "^". */}
          <Animated.View
            style={{
              position: 'absolute',
              left: e.x - r * 1.05,
              top: e.y - r * 0.55,
              width: r * 2.1,
              height: r * 1.05,
              borderTopLeftRadius: r * 1.05,
              borderTopRightRadius: r * 1.05,
              borderWidth: Math.max(1, r * 0.22),
              borderBottomWidth: 0,
              borderColor: INK,
              opacity: v.happy,
            }}
          />
          {/* Pink in the cheek, below and a little outside the eye. */}
          <Animated.View
            style={{
              position: 'absolute',
              left: e.x - r * 0.62 + e.side * r * 0.45,
              top: e.y + r * 0.95,
              width: r * 1.24,
              height: r * 0.62,
              borderRadius: r * 0.62,
              backgroundColor: BLUSH,
              opacity: v.blush.interpolate({ inputRange: [0, 1], outputRange: [0, 0.6] }),
            }}
          />
        </View>
      ))}
    </>
  );
}

/**
 * Three "z"s rising from beside the head, one after another, while Nomi is
 * sleepy. Each is seen in its own part of one loop, and all three are gone at
 * the seam, so the loop never jumps.
 */
function Zzz({ W, H }: { W: number; H: number }) {
  const t = useTheme();
  const clock = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(clock, { toValue: 1, duration: 3600, easing: RNEasing.linear, useNativeDriver: NATIVE }),
    );
    loop.start();
    return () => loop.stop();
  }, [clock]);

  return (
    <>
      {[0, 1, 2].map((i) => {
        const from = i * 0.2;
        return (
          <Animated.Text
            key={i}
            accessible={false}
            style={{
              position: 'absolute',
              left: W * (0.8 + i * 0.09),
              top: H * (0.14 - i * 0.07),
              fontSize: Math.max(8, H * (0.13 - i * 0.025)),
              fontWeight: '700',
              color: t.textMuted,
              opacity: clock.interpolate({
                inputRange: [from, from + 0.1, from + 0.5, from + 0.6],
                outputRange: [0, 1, 1, 0],
                extrapolate: 'clamp',
              }),
              transform: [
                {
                  translateY: clock.interpolate({
                    inputRange: [from, from + 0.6],
                    outputRange: [0, -H * 0.1],
                    extrapolate: 'clamp',
                  }),
                },
              ],
            }}
          >
            z
          </Animated.Text>
        );
      })}
    </>
  );
}
