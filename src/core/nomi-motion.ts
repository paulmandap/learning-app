/**
 * How Nomi moves: the states, and what each one does.
 *
 * Pure data and pure functions. No react-native, no clock, no timers — the same
 * rule the rest of `src/core/**` keeps. `src/ui/nomi-character.tsx` is the only
 * thing that turns this into `Animated` values, and screens only ever ask for a
 * state by name. Visual state and animation state stay separate: a screen says
 * "thinking", and never sees a rotation.
 *
 * ## Nomi guides, the pet celebrates
 *
 * `encouraging` and `success` are built and deliberately UNUSED by any screen.
 * The streak pet (`src/ui/pet.tsx`) already owns encouragement, by the owner's
 * own request, and two animals cheering the same answer would make them the
 * same thing. The capability exists so that decision can change without a
 * rebuild; `tests/screens.test.ts` keeps it from changing by accident.
 *
 * ## Units that do not know the size
 *
 * The character is drawn at 26px in a heading and at 150px on its own screen,
 * so nothing here is in pixels. Offsets are fractions of the character's height
 * (or of an eye's radius), and a 2px bob at 150px is a third of a pixel in the
 * heading — which is the right amount of motion for something that small.
 *
 * ## Why the wave raises the wing to 135°, not the 12° first planned
 *
 * Twelve degrees of a wing is about four pixels at the size Nomi's screen draws
 * it, which reads as a twitch rather than a hello. Rendered from the cut layers
 * at 60°, the wing stuck straight out sideways and read as POINTING at
 * something. At 140° it sits up beside the head, feather tips high, which is
 * what the reference sheet's own greeting draws — and it still reads as
 * attached, because the pivot is at the shoulder and the body behind the wing
 * was rebuilt by `scripts/make-nomi-assets.ts`.
 */

export const NOMI_STATES = [
  'idle',
  'greeting',
  'thinking',
  'explaining',
  'encouraging',
  'success',
  'studying',
  'goodbye',
] as const;

export type NomiState = (typeof NOMI_STATES)[number];

/** One thing that moves. */
export type Channel =
  /** Vertical offset, as a fraction of height. Negative is up. */
  | 'lift'
  /** Whole-figure rotation in degrees, about the feet. */
  | 'tilt'
  /** Whole-figure scale. */
  | 'scale'
  | 'opacity'
  /** Degrees about the shoulder. Positive is OUTWARD for both wings. */
  | 'wingLeft'
  | 'wingRight'
  /** Where the eyes look, as a fraction of an eye's radius. */
  | 'lookX'
  | 'lookY';

export const CHANNELS: readonly Channel[] = [
  'lift',
  'tilt',
  'scale',
  'opacity',
  'wingLeft',
  'wingRight',
  'lookX',
  'lookY',
];

/** Every channel at rest: the canonical pose, fully visible. */
export const REST: Readonly<Record<Channel, number>> = {
  lift: 0,
  tilt: 0,
  scale: 1,
  opacity: 1,
  wingLeft: 0,
  wingRight: 0,
  lookX: 0,
  lookY: 0,
};

export type Easing = 'inOut' | 'out' | 'in' | 'linear';

export interface Keyframe {
  /** Milliseconds from the start of the motion. */
  at: number;
  value: number;
  /** How the value travels INTO this frame from the one before. */
  easing?: Easing;
}

export interface Track {
  channel: Channel;
  frames: Keyframe[];
}

export interface Blink {
  minGapMs: number;
  maxGapMs: number;
  /** How long the eyes stay shut. */
  closedMs: number;
}

export interface Motion {
  state: NomiState;
  duration: number;
  loop: boolean;
  tracks: Track[];
  /**
   * What this becomes once it finishes. `null` for a loop, which never does,
   * and for `goodbye`, which ends with Nomi gone.
   */
  next: NomiState | null;
  blink: Blink | null;
}

/**
 * How long a channel takes to reach a new state's first frame.
 *
 * States are not defined pairwise — eight states would need fifty-six
 * transitions. Instead every change eases each channel from wherever it is to
 * where the new motion starts, and channels the new motion does not use go
 * back to rest.
 */
export const SETTLE_MS = 220;

const EVERYDAY_BLINK: Blink = { minGapMs: 4000, maxGapMs: 8000, closedMs: 110 };

function hold(channel: Channel, value: number, duration: number): Track {
  return { channel, frames: [{ at: 0, value }, { at: duration, value }] };
}

const IDLE: Motion = {
  state: 'idle',
  duration: 3600,
  loop: true,
  tracks: [
    {
      channel: 'lift',
      frames: [
        { at: 0, value: 0 },
        { at: 1800, value: -0.012, easing: 'inOut' },
        { at: 3600, value: 0, easing: 'inOut' },
      ],
    },
  ],
  next: null,
  blink: EVERYDAY_BLINK,
};

/**
 * Move every value in a motion toward rest by `factor`.
 *
 * Exists so `studying` can BE idle at half amplitude, literally, rather than a
 * second set of numbers that says so in a comment and drifts.
 */
export function scaleAmplitude(motion: Motion, factor: number): Motion {
  return {
    ...motion,
    tracks: motion.tracks.map((track) => ({
      ...track,
      frames: track.frames.map((f) => ({
        ...f,
        value: REST[track.channel] + (f.value - REST[track.channel]) * factor,
      })),
    })),
  };
}

const MOTIONS: Record<NomiState, Motion> = {
  idle: IDLE,

  /** Calmer than idle, eyes down on the page. For a deck screen. */
  studying: {
    ...scaleAmplitude(IDLE, 0.5),
    state: 'studying',
    tracks: [...scaleAmplitude(IDLE, 0.5).tracks, hold('lookY', 0.14, IDLE.duration)],
  },

  /** A slow head tilt, eyes up and away. While a question is being answered. */
  thinking: {
    state: 'thinking',
    duration: 2800,
    loop: true,
    tracks: [
      {
        channel: 'tilt',
        frames: [
          { at: 0, value: 0 },
          { at: 700, value: -3, easing: 'inOut' },
          { at: 2100, value: 3, easing: 'inOut' },
          { at: 2800, value: 0, easing: 'inOut' },
        ],
      },
      hold('lookX', 0.16, 2800),
      hold('lookY', -0.16, 2800),
    ],
    next: null,
    blink: { minGapMs: 6000, maxGapMs: 10000, closedMs: 160 },
  },

  /** Appear, then one wave. */
  greeting: {
    state: 'greeting',
    duration: 1400,
    loop: false,
    tracks: [
      {
        channel: 'opacity',
        frames: [
          { at: 0, value: 0 },
          { at: 240, value: 1, easing: 'out' },
          { at: 1400, value: 1 },
        ],
      },
      {
        channel: 'scale',
        frames: [
          { at: 0, value: 0.92 },
          { at: 320, value: 1.03, easing: 'out' },
          { at: 520, value: 1, easing: 'inOut' },
          { at: 1400, value: 1 },
        ],
      },
      {
        channel: 'wingRight',
        frames: [
          { at: 0, value: 0 },
          { at: 280, value: 0 },
          { at: 540, value: 135, easing: 'out' },
          { at: 720, value: 112, easing: 'inOut' },
          { at: 900, value: 135, easing: 'inOut' },
          { at: 1160, value: 0, easing: 'inOut' },
          { at: 1400, value: 0 },
        ],
      },
    ],
    next: 'idle',
    blink: null,
  },

  /** A small settle as an answer lands — "here it is", once. */
  explaining: {
    state: 'explaining',
    duration: 700,
    loop: false,
    tracks: [
      {
        channel: 'scale',
        frames: [
          { at: 0, value: 1 },
          { at: 180, value: 1.05, easing: 'out' },
          { at: 700, value: 1, easing: 'inOut' },
        ],
      },
    ],
    next: 'idle',
    blink: EVERYDAY_BLINK,
  },

  /** Two small nods. Built, deliberately unused — see the file note. */
  encouraging: {
    state: 'encouraging',
    duration: 1000,
    loop: false,
    tracks: [
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 180, value: 0.02, easing: 'out' },
          { at: 380, value: 0, easing: 'inOut' },
          { at: 560, value: 0.02, easing: 'out' },
          { at: 760, value: 0, easing: 'inOut' },
          { at: 1000, value: 0 },
        ],
      },
    ],
    next: 'idle',
    blink: EVERYDAY_BLINK,
  },

  /** A lift with both wings out. Built, deliberately unused — see the file note. */
  success: {
    state: 'success',
    duration: 1100,
    loop: false,
    tracks: [
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 300, value: -0.05, easing: 'out' },
          { at: 700, value: 0, easing: 'inOut' },
          { at: 1100, value: 0 },
        ],
      },
      ...(['wingLeft', 'wingRight'] as const).map(
        (channel): Track => ({
          channel,
          frames: [
            { at: 0, value: 0 },
            { at: 300, value: 35, easing: 'out' },
            { at: 700, value: 0, easing: 'inOut' },
            { at: 1100, value: 0 },
          ],
        }),
      ),
    ],
    next: 'idle',
    blink: null,
  },

  /**
   * One quick wave, then gone.
   *
   * SHORT, because leaving Nomi's screen waits for it: a goodbye that holds up
   * the back button is the animation getting in the way of the student.
   */
  goodbye: {
    state: 'goodbye',
    duration: 520,
    loop: false,
    tracks: [
      {
        channel: 'wingRight',
        frames: [
          { at: 0, value: 0 },
          { at: 170, value: 125, easing: 'out' },
          { at: 290, value: 105, easing: 'inOut' },
          { at: 410, value: 125, easing: 'inOut' },
          { at: 520, value: 125 },
        ],
      },
      {
        channel: 'opacity',
        frames: [
          { at: 0, value: 1 },
          { at: 300, value: 1 },
          { at: 520, value: 0, easing: 'in' },
        ],
      },
    ],
    next: null,
    blink: null,
  },
};

/**
 * The motion for a state.
 *
 * With `reduceMotion`, only opacity survives: the canonical pose holds still,
 * appearing and leaving still fade, and nothing blinks. A reduced one-shot
 * lasts as long as its fade and no longer, so a state with no fade at all
 * finishes at once rather than making anyone wait for movement they asked not
 * to see.
 */
export function motionFor(state: NomiState, options: { reduceMotion?: boolean } = {}): Motion {
  const motion = MOTIONS[state];
  if (!options.reduceMotion) return motion;

  const tracks = motion.tracks.filter((t) => t.channel === 'opacity');
  const duration = tracks.reduce((end, t) => Math.max(end, t.frames[t.frames.length - 1]!.at), 0);
  return { ...motion, tracks, duration: motion.loop ? motion.duration : duration, blink: null };
}

/**
 * Where each channel should be when a motion starts: its first frame, or rest
 * for channels the motion leaves alone.
 */
export function entryPose(motion: Motion): Record<Channel, number> {
  const pose = { ...REST };
  for (const track of motion.tracks) pose[track.channel] = track.frames[0]!.value;
  return pose;
}

export interface Segment {
  toValue: number;
  duration: number;
  easing: Easing;
}

/** A track as consecutive timed moves, which is what `Animated.sequence` wants. */
export function segments(track: Track): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < track.frames.length; i++) {
    const from = track.frames[i - 1]!;
    const to = track.frames[i]!;
    out.push({ toValue: to.value, duration: to.at - from.at, easing: to.easing ?? 'linear' });
  }
  return out;
}

/**
 * Milliseconds until the next blink. `random` is injected so this stays pure —
 * `Math.random` in production, a fixed number in a test.
 */
export function nextBlinkDelay(blink: Blink, random: () => number): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(blink.minGapMs + (blink.maxGapMs - blink.minGapMs) * r);
}
