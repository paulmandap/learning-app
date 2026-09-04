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
 *    is how MANY taps fire. Apple patched this in iOS 26.5, so on a current
 *    iPhone it is expected to do nothing.
 *
 * ## Why success gets a sound and failure does not
 *
 * A deliberate asymmetry, not an oversight. A "wrong" noise fires on the exact
 * cards a student is already struggling with, and turns a study session into a
 * series of small public failures — the sound arrives precisely when they feel
 * worst. Getting it wrong is the normal, useful half of studying; the missed
 * pile exists because those cards are the valuable ones. So success is
 * celebrated audibly, and a miss is acknowledged quietly, by touch alone.
 *
 * On iOS this also respects the hardware silent switch for free: Safari mutes
 * page audio when the ringer switch is off, and a web page cannot override
 * that. Somebody studying in a lecture will not chirp.
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

/** Two short ascending notes: A5 then E6, a rising fifth. */
const CHIME_HZ = [880, 1318.5] as const;
const NOTE_GAP_S = 0.075;
const NOTE_LEN_S = 0.16;
/** Deliberately quiet. This fires hundreds of times a session. */
const PEAK_GAIN = 0.07;

/**
 * A brief, quiet major-fifth chime.
 *
 * Synthesised rather than shipped as an audio file: no asset to load, no bytes
 * added to the bundle, and no dependency — about thirty lines of Web Audio.
 */
function chime(): void {
  try {
    const ctx = ensureAudio();
    if (!ctx) return;

    const now = ctx.currentTime;
    CHIME_HZ.forEach((hz, i) => {
      const at = now + i * NOTE_GAP_S;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.value = hz;

      // Fast attack, exponential decay — a blip, not a beep. A square edge here
      // clicks audibly, which is why the ramp exists.
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, at + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LEN_S);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(at);
      osc.stop(at + NOTE_LEN_S + 0.02);
    });
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
