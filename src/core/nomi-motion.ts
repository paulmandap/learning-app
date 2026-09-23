/**
 * How Nomi moves: the states, and what each one does.
 *
 * Pure data and pure functions. No react-native, no clock, no timers — the same
 * rule the rest of `src/core/**` keeps. `src/ui/nomi-character.tsx` is the only
 * thing that turns this into `Animated` values, and screens only ever ask for a
 * state by name. Visual state and animation state stay separate: a screen says
 * "thinking", and never sees a rotation.
 *
 * ## Nomi celebrates a finished round; the pet keeps the streak
 *
 * `encouraging` and `success` were built and deliberately unused, with the
 * streak pet (`src/ui/pet.tsx`) owning encouragement (NOTES §35.5). The owner
 * reversed that on 2026-09-14 — *"i never see nomi doing the interactions like
 * explaining, encouraging, success, studying/focused"* — for the END of a
 * flashcard deck, a quiz or a round of blanks, and no further: `src/core/
 * celebrate.ts` picks which, `src/ui/nomi-finish.tsx` is the only surface that
 * may ask for either, and `tests/screens.test.ts` holds every other file to it.
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
 * was rebuilt by `scripts/make-nomi-assets.ts`. Pointing is what `explaining`
 * now does on purpose, at under 60°.
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
  // More life (NOTES §49): the owner, *"maybe it's time too to add more 'life'
  // to nomi. more animations, interactions"*, choosing all four offered — tap to
  // react, eyes that follow, new faces, and reacting during study.
  'hop',
  'stretch',
  'lookAround',
  'nod',
  'shy',
  'sleepy',
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
  | 'lookY'
  /**
   * Faces, drawn in code over the pictures at the eyes the rig measured (NOTES
   * §49), 0 to 1. `happy` closes the eyes into the reference sheet's "^ ^";
   * `blush` is pink in the cheeks; `lid` lowers a sleepy eyelid.
   */
  | 'happy'
  | 'blush'
  | 'lid';

export const CHANNELS: readonly Channel[] = [
  'lift',
  'tilt',
  'scale',
  'opacity',
  'wingLeft',
  'wingRight',
  'lookX',
  'lookY',
  'happy',
  'blush',
  'lid',
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
  happy: 0,
  blush: 0,
  lid: 0,
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

/** Eyes closed happy — "^ ^" — quickly, until `until`, then open again by the end. */
function happyFace(duration: number, until: number, closeBy = 200): Track {
  return {
    channel: 'happy',
    frames: [
      { at: 0, value: 0 },
      { at: closeBy, value: 1, easing: 'out' },
      { at: until, value: 1 },
      { at: duration, value: 0, easing: 'inOut' },
    ],
  };
}

/** Both wings out to `degrees` and back, the same way. */
function bothWings(frames: Keyframe[]): Track[] {
  return (['wingLeft', 'wingRight'] as const).map((channel) => ({ channel, frames }));
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
 * Exists so a calmer state can be idle at a smaller amplitude, literally,
 * rather than a second set of numbers that says so in a comment and drifts.
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

  /**
   * Reading, for a deck screen: eyes down on the page and moving along a line,
   * a slow nod, the breathing of idle at half its size.
   *
   * It was only that last part, with the eyes a seventh of a radius lower, and
   * the owner never once noticed it (NOTES §43). Now it reads.
   */
  studying: {
    state: 'studying',
    duration: IDLE.duration,
    loop: true,
    tracks: [
      ...scaleAmplitude(IDLE, 0.5).tracks,
      {
        channel: 'tilt',
        frames: [
          { at: 0, value: 0 },
          { at: 1200, value: 1.5, easing: 'inOut' },
          { at: 2400, value: -1, easing: 'inOut' },
          { at: 3600, value: 0, easing: 'inOut' },
        ],
      },
      {
        channel: 'lookX',
        frames: [
          { at: 0, value: -0.2 },
          { at: 2600, value: 0.25, easing: 'inOut' },
          { at: 3000, value: 0.25 },
          { at: 3600, value: -0.2, easing: 'inOut' },
        ],
      },
      hold('lookY', 0.3, IDLE.duration),
    ],
    next: null,
    blink: EVERYDAY_BLINK,
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

  /**
   * A wing raised to make a point, twice, and a small lean in as the answer
   * lands. It was a 5% bounce lasting 0.7s, which the owner never saw (NOTES §43).
   */
  explaining: {
    state: 'explaining',
    duration: 1400,
    loop: false,
    tracks: [
      {
        channel: 'scale',
        frames: [
          { at: 0, value: 1 },
          { at: 260, value: 1.05, easing: 'out' },
          { at: 700, value: 1, easing: 'inOut' },
          { at: 1400, value: 1 },
        ],
      },
      {
        channel: 'wingRight',
        frames: [
          { at: 0, value: 0 },
          { at: 120, value: 0 },
          { at: 420, value: 58, easing: 'out' },
          { at: 620, value: 42, easing: 'inOut' },
          { at: 820, value: 58, easing: 'inOut' },
          { at: 1200, value: 0, easing: 'inOut' },
          { at: 1400, value: 0 },
        ],
      },
    ],
    next: 'idle',
    blink: EVERYDAY_BLINK,
  },

  /** Two nods and a pat of the wing: "keep going". A rough round's end. */
  encouraging: {
    state: 'encouraging',
    duration: 1400,
    loop: false,
    tracks: [
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 200, value: 0.025, easing: 'out' },
          { at: 420, value: 0, easing: 'inOut' },
          { at: 640, value: 0.025, easing: 'out' },
          { at: 860, value: 0, easing: 'inOut' },
          { at: 1400, value: 0 },
        ],
      },
      {
        channel: 'wingLeft',
        frames: [
          { at: 0, value: 0 },
          { at: 860, value: 0 },
          { at: 1060, value: 28, easing: 'out' },
          { at: 1400, value: 0, easing: 'inOut' },
        ],
      },
      // The reference sheet's "^ ^", which the pictures alone could never show (§49).
      happyFace(1400, 1150),
    ],
    next: 'idle',
    // Eyes closed happy: nothing to blink.
    blink: null,
  },

  /** Two hops with both wings out. A round that went well. */
  success: {
    state: 'success',
    duration: 1400,
    loop: false,
    tracks: [
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 260, value: -0.07, easing: 'out' },
          { at: 520, value: 0, easing: 'in' },
          { at: 760, value: -0.05, easing: 'out' },
          { at: 1000, value: 0, easing: 'in' },
          { at: 1400, value: 0 },
        ],
      },
      ...(['wingLeft', 'wingRight'] as const).map(
        (channel): Track => ({
          channel,
          frames: [
            { at: 0, value: 0 },
            { at: 260, value: 40, easing: 'out' },
            { at: 520, value: 12, easing: 'inOut' },
            { at: 760, value: 36, easing: 'out' },
            { at: 1100, value: 0, easing: 'inOut' },
            { at: 1400, value: 0 },
          ],
        }),
      ),
      happyFace(1400, 1100),
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

  /**
   * A tap on Nomi (NOTES §49): a crouch, one hop with the eyes closed happy and
   * the wings a little out, and a small landing.
   */
  hop: {
    state: 'hop',
    duration: 1000,
    loop: false,
    tracks: [
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 120, value: 0.015, easing: 'out' },
          { at: 320, value: -0.07, easing: 'out' },
          { at: 560, value: 0, easing: 'in' },
          { at: 700, value: 0.01, easing: 'out' },
          { at: 1000, value: 0, easing: 'inOut' },
        ],
      },
      {
        channel: 'scale',
        frames: [
          { at: 0, value: 1 },
          { at: 120, value: 0.96, easing: 'out' },
          { at: 320, value: 1.04, easing: 'out' },
          { at: 560, value: 0.98, easing: 'inOut' },
          { at: 1000, value: 1, easing: 'inOut' },
        ],
      },
      ...bothWings([
        { at: 0, value: 0 },
        { at: 320, value: 28, easing: 'out' },
        { at: 700, value: 0, easing: 'inOut' },
        { at: 1000, value: 0 },
      ]),
      happyFace(1000, 780, 120),
    ],
    next: 'idle',
    blink: null,
  },

  /** Both wings out, up on its toes, eyes closed contentedly. Idle, now and then, and a tap. */
  stretch: {
    state: 'stretch',
    duration: 1600,
    loop: false,
    tracks: [
      ...bothWings([
        { at: 0, value: 0 },
        { at: 600, value: 70, easing: 'inOut' },
        { at: 1000, value: 70 },
        { at: 1500, value: 0, easing: 'inOut' },
        { at: 1600, value: 0 },
      ]),
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 600, value: -0.02, easing: 'inOut' },
          { at: 1000, value: -0.02 },
          { at: 1500, value: 0, easing: 'inOut' },
          { at: 1600, value: 0 },
        ],
      },
      happyFace(1600, 1100, 500),
    ],
    next: 'idle',
    blink: null,
  },

  /** A glance one way, then the other, the head following a little. Idle, now and then, and a tap. */
  lookAround: {
    state: 'lookAround',
    duration: 2000,
    loop: false,
    tracks: [
      {
        channel: 'lookX',
        frames: [
          { at: 0, value: 0 },
          { at: 350, value: -0.3, easing: 'inOut' },
          { at: 800, value: -0.3 },
          { at: 1200, value: 0.3, easing: 'inOut' },
          { at: 1600, value: 0.3 },
          { at: 2000, value: 0, easing: 'inOut' },
        ],
      },
      {
        channel: 'tilt',
        frames: [
          { at: 0, value: 0 },
          { at: 400, value: -2, easing: 'inOut' },
          { at: 800, value: -2 },
          { at: 1200, value: 2, easing: 'inOut' },
          { at: 1600, value: 2 },
          { at: 2000, value: 0, easing: 'inOut' },
        ],
      },
    ],
    next: 'idle',
    blink: null,
  },

  /**
   * A card answered right, beside the count (NOTES §49): two small bobs and the
   * eyes closed happy — then back to reading, which `StudyProgress` asks for.
   * Quick, so the next card is never waiting on it. The owner chose this over
   * §43's "never after a single answer"; the end-of-round celebration is still
   * `success` and `encouraging`, and only `NomiFinish` may ask for those.
   */
  nod: {
    state: 'nod',
    duration: 700,
    loop: false,
    tracks: [
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 150, value: 0.02, easing: 'out' },
          { at: 300, value: 0, easing: 'inOut' },
          { at: 450, value: 0.015, easing: 'out' },
          { at: 700, value: 0, easing: 'inOut' },
        ],
      },
      happyFace(700, 500, 120),
    ],
    next: 'idle',
    blink: null,
  },

  /** Held: a shy lean, pink in the cheeks, eyes closed happy. */
  shy: {
    state: 'shy',
    duration: 1600,
    loop: false,
    tracks: [
      {
        channel: 'blush',
        frames: [
          { at: 0, value: 0 },
          { at: 300, value: 1, easing: 'out' },
          { at: 1300, value: 1 },
          { at: 1600, value: 0, easing: 'inOut' },
        ],
      },
      {
        channel: 'tilt',
        frames: [
          { at: 0, value: 0 },
          { at: 350, value: 3, easing: 'inOut' },
          { at: 1250, value: 3 },
          { at: 1600, value: 0, easing: 'inOut' },
        ],
      },
      happyFace(1600, 1300, 250),
    ],
    next: 'idle',
    blink: null,
  },

  /**
   * Late at night, on Home (NOTES §49): lids half down, slow deep breathing,
   * the head lolling a little, and heavy blinks. The floating "z"s are drawn by
   * `nomi-character.tsx`, which asks `zzz(state)`.
   */
  sleepy: {
    state: 'sleepy',
    duration: 5200,
    loop: true,
    tracks: [
      {
        channel: 'lift',
        frames: [
          { at: 0, value: 0 },
          { at: 2600, value: -0.015, easing: 'inOut' },
          { at: 5200, value: 0, easing: 'inOut' },
        ],
      },
      {
        channel: 'tilt',
        frames: [
          { at: 0, value: 0 },
          { at: 2600, value: 2, easing: 'inOut' },
          { at: 5200, value: 0, easing: 'inOut' },
        ],
      },
      hold('lid', 0.55, 5200),
    ],
    next: null,
    blink: { minGapMs: 2500, maxGapMs: 5000, closedMs: 450 },
  },
};

/** Whether a state has floating "z"s beside Nomi. */
export function zzz(state: NomiState): boolean {
  return state === 'sleepy';
}

/**
 * One of `options`, at random, and never the one before — so a wave is not
 * followed by a wave, nor a hop by a hop. `random` is injected, as everywhere
 * here, so this stays pure.
 */
export function pickAgain<T>(options: readonly T[], random: () => number, last: T | null): T {
  const pool = options.length > 1 && last !== null ? options.filter((o) => o !== last) : options;
  const r = Math.min(0.999999, Math.max(0, random()));
  return pool[Math.floor(r * pool.length)]!;
}

/** What Nomi on Home does now and then while idle — a wave, and more than a wave (§49). */
export const IDLE_GESTURES = ['greeting', 'lookAround', 'stretch'] as const satisfies readonly NomiState[];
export function nextIdleGesture(random: () => number, last: NomiState | null): NomiState {
  return pickAgain<NomiState>(IDLE_GESTURES, random, last);
}

/** What a tap on Nomi does (§49). Holding is `shy`. */
export const TAP_REACTIONS = ['hop', 'stretch', 'lookAround'] as const satisfies readonly NomiState[];
export function tapReaction(random: () => number, last: NomiState | null): NomiState {
  return pickAgain<NomiState>(TAP_REACTIONS, random, last);
}

/**
 * The most the eyes turn to follow a finger or the mouse, as a fraction of an
 * eye's radius — the same limit every state keeps to.
 */
export const GAZE_MAX = 0.3;
/** How far away the pointer must be for a full glance, in points. Nearer, less. */
export const GAZE_REACH = 240;
/** How long a glance holds after the pointer stops, before the eyes come back. */
export const GAZE_RETURN_MS = 2000;

/**
 * Where the eyes look to follow a point (NOTES §49): toward it, further the
 * further away it is, up to `GAZE_MAX`. From Nomi's own centre, in screen
 * points; y down, as the screen has it.
 */
export function lookToward(from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1) return { x: 0, y: 0 };
  const reach = Math.min(1, distance / GAZE_REACH) * GAZE_MAX;
  return { x: (dx / distance) * reach, y: (dy / distance) * reach };
}

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

/**
 * When Nomi on Home waves again, standing idle beside its line (NOTES §45).
 *
 * The owner: *"for the nomi tab, could you make nomi idle, and doing greeting
 * from time-to-time?"* The first wave comes a few seconds after the line is
 * said, so a visit of any length sees one; after that roughly every half
 * minute, at a random gap so it never looks like clockwork.
 */
export const IDLE_GREETING = {
  firstMs: [5000, 9000],
  gapMs: [20000, 35000],
} as const;

export function nextGreetingDelay(first: boolean, random: () => number): number {
  const [min, max] = first ? IDLE_GREETING.firstMs : IDLE_GREETING.gapMs;
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(min + (max - min) * r);
}
