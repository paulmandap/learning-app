import { describe, expect, it } from 'vitest';
import {
  CHANNELS,
  entryPose,
  motionFor,
  nextBlinkDelay,
  NOMI_STATES,
  REST,
  scaleAmplitude,
  segments,
  type Channel,
  type Motion,
} from '../src/core/nomi-motion';

/**
 * Nomi's motion descriptors, checked as data.
 *
 * The renderer cannot be run here — it imports react-native — so every rule
 * that can be stated about the motion is stated about the descriptors instead:
 * that loops join up, that one-shots come home, that nothing lasts long enough
 * to get in the way, and that reduced motion really is reduced.
 */

const all = NOMI_STATES.map((s) => motionFor(s));
const lastFrame = (m: Motion, channel: Channel) =>
  m.tracks.find((t) => t.channel === channel)?.frames.at(-1)?.value;

/** How far each channel may ever travel. Past these the owl stops looking like itself. */
const LIMITS: Record<Channel, [number, number]> = {
  lift: [-0.08, 0.08],
  tilt: [-5, 5],
  scale: [0.85, 1.1],
  opacity: [0, 1],
  // Up beside the head and no further. Past about 150° the wing would be
  // pointing back down the far side of the shoulder, which no owl does.
  wingLeft: [0, 150],
  wingRight: [0, 150],
  lookX: [-0.3, 0.3],
  lookY: [-0.3, 0.3],
};

describe('every state is well formed', () => {
  it('has a motion for each state, named for it', () => {
    for (const state of NOMI_STATES) expect(motionFor(state).state).toBe(state);
  });

  it('keeps frames in order, from 0 to the end of the motion', () => {
    for (const m of all) {
      for (const t of m.tracks) {
        expect(t.frames[0]!.at, `${m.state}.${t.channel} starts late`).toBe(0);
        expect(t.frames.at(-1)!.at, `${m.state}.${t.channel} ends off the clock`).toBe(m.duration);
        for (let i = 1; i < t.frames.length; i++) {
          expect(t.frames[i]!.at).toBeGreaterThanOrEqual(t.frames[i - 1]!.at);
        }
      }
    }
  });

  it('never moves a channel further than the owl can take', () => {
    for (const m of all) {
      for (const t of m.tracks) {
        const [lo, hi] = LIMITS[t.channel];
        for (const f of t.frames) {
          expect(f.value, `${m.state}.${t.channel}`).toBeGreaterThanOrEqual(lo);
          expect(f.value, `${m.state}.${t.channel}`).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('uses each channel at most once per state', () => {
    for (const m of all) {
      const channels = m.tracks.map((t) => t.channel);
      expect(new Set(channels).size, m.state).toBe(channels.length);
    }
  });
});

describe('loops', () => {
  const loops = all.filter((m) => m.loop);

  it('are idle, studying and thinking — the states that can last', () => {
    expect(loops.map((m) => m.state).sort()).toEqual(['idle', 'studying', 'thinking']);
  });

  it('join up, so there is no jump at the seam', () => {
    for (const m of loops) {
      for (const t of m.tracks) {
        expect(t.frames.at(-1)!.value, `${m.state}.${t.channel}`).toBe(t.frames[0]!.value);
      }
    }
  });

  it('cycle slowly enough to be calm', () => {
    // A study app, not a game: anything faster than about two seconds a cycle
    // reads as fidgeting in the corner of the eye.
    for (const m of loops) {
      expect(m.duration, m.state).toBeGreaterThanOrEqual(2000);
      expect(m.duration, m.state).toBeLessThanOrEqual(6000);
    }
  });

  it('never finish into anything', () => {
    for (const m of loops) expect(m.next, m.state).toBeNull();
  });
});

describe('one-shots', () => {
  const once = all.filter((m) => !m.loop);

  it('are over in two seconds or less', () => {
    for (const m of once) expect(m.duration, m.state).toBeLessThanOrEqual(2000);
  });

  it('settle into idle, except goodbye', () => {
    for (const m of once.filter((m) => m.state !== 'goodbye')) {
      expect(m.next, m.state).toBe('idle');
    }
  });

  it('come back to rest, so handing over to idle does not jump', () => {
    for (const m of once.filter((m) => m.state !== 'goodbye')) {
      for (const t of m.tracks) {
        expect(t.frames.at(-1)!.value, `${m.state}.${t.channel}`).toBe(REST[t.channel]);
      }
    }
  });

  it('goodbye ends gone, and is quick — leaving the screen waits for it', () => {
    const goodbye = motionFor('goodbye');
    expect(goodbye.next).toBeNull();
    expect(lastFrame(goodbye, 'opacity')).toBe(0);
    expect(goodbye.duration).toBeLessThanOrEqual(600);
  });

  it('greeting appears from nothing and raises a wing above the shoulder to wave', () => {
    // Not a flap: at 60° the rendered wing stuck out sideways and read as
    // pointing. A hello has the wing up beside the head.
    const greeting = motionFor('greeting');
    expect(greeting.tracks.find((t) => t.channel === 'opacity')!.frames[0]!.value).toBe(0);
    const wave = Math.max(...greeting.tracks.find((t) => t.channel === 'wingRight')!.frames.map((f) => f.value));
    expect(wave).toBeGreaterThanOrEqual(100);
  });
});

describe('the states keep their roles', () => {
  it('studying reads — eyes down on the page, moving along a line, with a slow nod (NOTES §43)', () => {
    // It was idle at half amplitude with the eyes a touch lower, and the owner
    // never noticed it. The breathing is still idle's, halved, not a copy.
    const studying = motionFor('studying');
    const values = (channel: string) => studying.tracks.find((t) => t.channel === channel)!.frames.map((f) => f.value);
    expect(Math.min(...values('lookY'))).toBeGreaterThanOrEqual(0.25);
    expect(Math.max(...values('lookX')) - Math.min(...values('lookX'))).toBeGreaterThanOrEqual(0.3);
    expect(Math.max(...values('tilt').map(Math.abs))).toBeGreaterThan(0);
    const idleLift = motionFor('idle').tracks.find((t) => t.channel === 'lift')!.frames;
    values('lift').forEach((v, i) => expect(v).toBeCloseTo(idleLift[i]!.value / 2, 10));
  });

  it('explaining raises a wing to make its point — pointing, not waving (NOTES §43)', () => {
    const wing = motionFor('explaining').tracks.find((t) => t.channel === 'wingRight')!.frames.map((f) => f.value);
    expect(Math.max(...wing)).toBeGreaterThanOrEqual(45);
    expect(Math.max(...wing)).toBeLessThan(motionFor('greeting').tracks.find((t) => t.channel === 'wingRight')!.frames.reduce((m, f) => Math.max(m, f.value), 0));
  });

  it('success hops with both wings out, and encouraging nods — big enough to be seen (NOTES §43)', () => {
    const success = motionFor('success');
    expect(Math.min(...success.tracks.find((t) => t.channel === 'lift')!.frames.map((f) => f.value))).toBeLessThanOrEqual(-0.05);
    for (const wing of ['wingLeft', 'wingRight']) {
      expect(Math.max(...success.tracks.find((t) => t.channel === wing)!.frames.map((f) => f.value))).toBeGreaterThanOrEqual(30);
    }
    expect(motionFor('encouraging').tracks.find((t) => t.channel === 'lift')!.frames.filter((f) => f.value > 0)).toHaveLength(2);
  });

  it('thinking looks up and away, and blinks more slowly than idle', () => {
    const thinking = motionFor('thinking');
    expect(lastFrame(thinking, 'lookY')).toBeLessThan(0);
    expect(thinking.blink!.minGapMs).toBeGreaterThan(motionFor('idle').blink!.minGapMs);
  });
});

describe('reduced motion', () => {
  const reduced = NOMI_STATES.map((s) => motionFor(s, { reduceMotion: true }));

  it('moves nothing but opacity, in any state', () => {
    for (const m of reduced) {
      for (const t of m.tracks) expect(t.channel, m.state).toBe('opacity');
    }
  });

  it('does not blink', () => {
    for (const m of reduced) expect(m.blink, m.state).toBeNull();
  });

  it('still fades in on greeting and out on goodbye', () => {
    expect(motionFor('greeting', { reduceMotion: true }).tracks).toHaveLength(1);
    expect(lastFrame(motionFor('goodbye', { reduceMotion: true }), 'opacity')).toBe(0);
  });

  it('finishes a one-shot with no fade at once, rather than waiting on nothing', () => {
    expect(motionFor('explaining', { reduceMotion: true }).duration).toBe(0);
  });

  it('keeps where each state goes next', () => {
    for (const state of NOMI_STATES) {
      expect(motionFor(state, { reduceMotion: true }).next).toBe(motionFor(state).next);
    }
  });
});

describe('helpers the renderer relies on', () => {
  it('entryPose puts untouched channels at rest', () => {
    const pose = entryPose(motionFor('greeting'));
    expect(pose.opacity).toBe(0);
    expect(pose.tilt).toBe(REST.tilt);
    expect(Object.keys(pose).sort()).toEqual([...CHANNELS].sort());
  });

  it('segments cover a track exactly, one fewer than its frames', () => {
    for (const m of all) {
      for (const t of m.tracks) {
        const segs = segments(t);
        expect(segs).toHaveLength(t.frames.length - 1);
        expect(segs.reduce((sum, s) => sum + s.duration, 0)).toBe(m.duration);
        expect(segs.at(-1)?.toValue).toBe(t.frames.at(-1)!.value);
      }
    }
  });

  it('scaleAmplitude scales toward rest, not toward zero', () => {
    const scaled = scaleAmplitude(motionFor('greeting'), 0.5);
    const scale = scaled.tracks.find((t) => t.channel === 'scale')!;
    // 0.92 is 0.08 below a rest of 1, so half of it is 0.96 — not 0.46.
    expect(scale.frames[0]!.value).toBeCloseTo(0.96, 10);
  });

  it('nextBlinkDelay stays inside the blink range', () => {
    const blink = motionFor('idle').blink!;
    expect(nextBlinkDelay(blink, () => 0)).toBe(blink.minGapMs);
    expect(nextBlinkDelay(blink, () => 1)).toBe(blink.maxGapMs);
    expect(nextBlinkDelay(blink, () => 7)).toBe(blink.maxGapMs);
  });
});
