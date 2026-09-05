/**
 * Feedback for the study loop: haptics, and a sound on success only.
 *
 * Replaces the earlier haptics-only module. Everything here is BEST EFFORT and
 * silent on failure — nothing in the app may depend on a buzz or a beep
 * actually happening. The flip animation, the drag, the colour wash and the
 * fly-off remain the real feedback, exactly as before.
 *
 * ## Haptics
 *
 * This ships as an iPhone PWA and iOS Safari has never implemented the
 * Vibration API. Two non-API paths exist:
 *
 *  - **Android (Chrome):** `navigator.vibrate()`, which takes a real pattern,
 *    so success and failure can genuinely feel different.
 *  - **iOS Safari 17.4+:** the HTML switch control emits a system haptic when
 *    toggled, and a scripted `<label>` click triggers it. There is NO duration
 *    or intensity control — every tap is identical — so the only way to vary it
 *    is how MANY taps fire.
 *
 * ## iOS: taps buzz, swipes do not. This is settled — stop trying.
 *
 * Confirmed on a real iPhone across three attempts. Buttons and the keyboard
 * produce a haptic; a swipe never does, from any call site:
 *
 *  1. Firing at release, inside PanResponder — no buzz.
 *  2. Firing at the drag's commit threshold — no buzz. (`touchmove` is not an
 *     activation-triggering event, so this one could never have worked.)
 *  3. Firing from a real `touchend` listener on the card's DOM node — no buzz.
 *
 * The decisive evidence: `gradeFeedback` calls `chime()` and then `haptic()`
 * on the same line of execution. On a swipe the SOUND plays and the haptic does
 * not. So the code path runs and the call is made — the tap is simply refused.
 *
 * The likely reason, and why there is no fourth attempt: a button press ends in
 * a `click`, while a swipe ends in `touchend` with the synthetic click
 * suppressed because the finger moved. Safari appears to grant the switch
 * haptic to discrete taps, not drags, and a page cannot manufacture a trusted
 * click. Real per-gesture haptics need a native build (`expo-haptics`).
 *
 * The listener stays: it is harmless, it is correct on Android where
 * `navigator.vibrate` works during a drag, and swipe feedback on iOS is carried
 * by the colour wash, the fly-off and — for a correct answer — the sound.
 *
 * ## Why success gets a sound and failure does not
 *
 * A deliberate asymmetry. A "wrong" noise would fire on exactly the cards a
 * student is already struggling with, arriving at the moment they feel worst,
 * and getting cards wrong is the normal and useful half of studying — the
 * missed pile exists because those cards are the valuable ones. Success is
 * marked audibly; a miss is acknowledged by touch alone.
 *
 * The success note has been through one revision: the first attempt was two
 * ascending sine tones and was reported as cheap and distracting. See chime()
 * for what replaced it and why.
 *
 * On iOS this respects the hardware silent switch for free — Safari mutes page
 * audio when the ringer switch is off and a page cannot override that — so
 * nobody chirps in a lecture.
 */

const SWITCH_ID = 'haptic-switch';

/** The hidden label whose click Safari turns into a tap. Created once, lazily. */
let hiddenLabel: HTMLLabelElement | null = null;

function offscreen(el: HTMLElement) {
  el.setAttribute('aria-hidden', 'true');
  // Not display:none — a hidden control cannot be clicked, and the click is the
  // whole mechanism. Zero-sized and transparent keeps it clickable but unseen.
  el.style.cssText =
    'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;top:0';
}

function ensureSwitch(): HTMLLabelElement | null {
  if (hiddenLabel) return hiddenLabel;
  if (typeof document === 'undefined' || !document.body) return null;

  const input = document.createElement('input');
  input.type = 'checkbox';
  // The attribute Safari 17.4+ reads to render a switch rather than a checkbox.
  // Unknown attributes are ignored everywhere else, so this is inert off iOS.
  input.setAttribute('switch', '');
  input.id = SWITCH_ID;
  input.tabIndex = -1;
  offscreen(input);

  const label = document.createElement('label');
  label.htmlFor = SWITCH_ID;
  offscreen(label);

  document.body.appendChild(input);
  document.body.appendChild(label);

  hiddenLabel = label;
  return label;
}

/**
 * Create the hidden switch ahead of time.
 *
 * Called once when a study screen mounts. Doing this lazily at the moment of
 * the first buzz meant the element was appended to the DOM and clicked in the
 * same instant, and that first tap was silently lost — which showed up as
 * "swipes do not buzz" for anyone whose first action was a swipe rather than a
 * button. Creating it early costs two invisible nodes and removes the race.
 */
export function primeFeedback(): void {
  ensureSwitch();
}

/**
 * Fire haptic feedback.
 *
 * @param pattern    Vibration pattern where a real API exists (ms on/off/on…).
 * @param iosTapsAtMs When each tap fires on the iOS switch path, in ms from now.
 *
 * The iOS path has NO intensity or duration control — every tap is the same
 * system tick — so the only expressive dimensions are how many taps fire and
 * with what rhythm. That is why these are schedules rather than durations, and
 * why the gaps are as wide as they are: below roughly 100ms two taps are felt
 * as one, which made a "correct" double tap indistinguishable from a flip.
 */
function haptic(pattern: number | number[], iosTapsAtMs: number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
      return;
    }

    const label = ensureSwitch();
    if (!label) return;
    for (const at of iosTapsAtMs) {
      if (at <= 0) label.click();
      else setTimeout(() => label.click(), at);
    }
  } catch {
    // A device that will not buzz is not an error worth surfacing.
  }
}

// ------------------------------------------------------------------ sound ---

let audioCtx: AudioContext | null = null;

/**
 * The shared AudioContext, created lazily.
 *
 * Created on first use rather than at import, because browsers refuse to start
 * one outside a user gesture — and first use is always inside a tap or key
 * press, which is exactly the gesture they want.
 */
function ensureAudio(): AudioContext | null {
  if (typeof window === 'undefined') return null;

  // Cast rather than augment Window: this project's ambient DOM types come from
  // Expo's base config and do not carry AudioContext, and webkit-prefixed
  // constructors never appear in any lib at all.
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;

  // Held in a local so narrowing survives — a module-level `let` is widened
  // back to nullable after the assignment.
  const ctx = audioCtx ?? new Ctor();
  audioCtx = ctx;

  // A context can be suspended by the browser between sessions; resuming inside
  // the gesture is what makes the next sound audible.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** Fundamental, G5. Low enough to feel warm rather than shrill. */
const FUNDAMENTAL_HZ = 784;

/**
 * Partials, as [frequency multiple, relative gain, decay seconds].
 *
 * This is what makes it a note rather than a beep. A struck wooden bar has
 * energy above the fundamental that dies away FASTER than the fundamental
 * does — that decay difference is most of what the ear reads as "wood" instead
 * of "electronics". The 3.01 rather than a clean 3.0 is slight inharmonicity;
 * exact integer multiples sound synthetic.
 */
const PARTIALS: readonly (readonly [number, number, number])[] = [
  [1, 1.0, 0.42],
  [2, 0.28, 0.22],
  [3.01, 0.1, 0.13],
];

const ATTACK_S = 0.006;
/** Deliberately quiet. This fires on most of a hundred cards a session. */
const PEAK_GAIN = 0.075;

/**
 * A short, warm success note.
 *
 * Replaces a two-note sine chime that was reported as sounding cheap and
 * becoming distracting — a fair verdict. Two bare sine tones in sequence read
 * as an electronic beep, and a rising interval makes it read as an alert.
 *
 * This is one note instead of two, with harmonics that decay faster than the
 * fundamental, a gentle attack, a long-ish tail, and a lowpass to take the edge
 * off. Closer to a struck marimba bar than a notification, which is what a
 * sound repeated this often needs to be.
 *
 * Still synthesised rather than a shipped audio file: no asset, no bundle
 * bytes, no dependency, no licence.
 */
function chime(): void {
  try {
    const ctx = ensureAudio();
    if (!ctx) return;

    const now = ctx.currentTime;

    // One shared lowpass so the upper partials cannot get glassy, plus a master
    // gain to set the level in a single place.
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 2600;
    tone.Q.value = 0.7;

    const master = ctx.createGain();
    master.gain.value = PEAK_GAIN;

    tone.connect(master);
    master.connect(ctx.destination);

    for (const [multiple, level, decay] of PARTIALS) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = FUNDAMENTAL_HZ * multiple;

      // Ramp rather than a step: an instantaneous start is an audible click.
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level, now + ATTACK_S);
      // exponentialRamp cannot reach zero, hence the small floor.
      gain.gain.exponentialRampToValueAtTime(0.0001, now + decay);

      osc.connect(gain);
      gain.connect(tone);
      osc.start(now);
      osc.stop(now + decay + 0.05);
    }
  } catch {
    // Blocked autoplay, no Web Audio, a suspended context — all fine, stay quiet.
  }
}

// ------------------------------------------------------------------ public --

/**
 * Turning a card over. A single tap — the lightest thing here, and the only
 * one-tap event, so grading never feels like flipping.
 */
export function hapticFlip(): void {
  haptic(8, [0]);
}

/**
 * Committing an answer, from either the buttons or a completed swipe.
 *
 * All three events are told apart by RHYTHM, because on iOS every tap is
 * identical and rhythm is all that is left:
 *
 *   flip     ·           one tap
 *   correct  · ·         two quick taps (110ms) + the chime
 *   missed   ·   ·       two slow taps (240ms), no sound
 *
 * Correct reads as an upbeat "ta-dum"; missed as a slower, flatter "uh-uh".
 * Neither is harsh — a miss is acknowledged, not scolded, per the note at the
 * top of this file. On Android the same shapes are expressed as real vibration
 * patterns, where duration is available as well.
 */
const CORRECT_TAP_MS = 110;
const MISSED_TAP_MS = 240;

export function gradeFeedback(gotIt: boolean): void {
  if (gotIt) {
    haptic([12, 90, 12], [0, CORRECT_TAP_MS]);
    chime();
    return;
  }
  haptic([25, 200, 25], [0, MISSED_TAP_MS]);
}
