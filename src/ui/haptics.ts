/**
 * Haptic feedback, such as the web allows.
 *
 * This app ships as an iPhone PWA, and iOS Safari has never implemented the
 * Vibration API — which is why the card's feedback was built out of motion and
 * colour in the first place. Two platform paths exist, and neither is a real API:
 *
 *  - **Android (Chrome):** `navigator.vibrate()` works properly. Used when present.
 *  - **iOS Safari 17.4+:** the HTML switch control (`<input type="checkbox" switch>`)
 *    emits a haptic tap when toggled, and toggling it from script via a `<label>`
 *    click produces that tap on demand. It is an implementation quirk, not a
 *    feature, and **Apple patched it in iOS 26.5** — so on a current iPhone this
 *    is expected to do nothing.
 *
 * Both paths are best-effort and silent on failure. Nothing in the app may
 * depend on a buzz actually happening: the flip animation, the drag, the colour
 * wash and the fly-off remain the real feedback, exactly as before. This is a
 * bonus on devices that allow it, never a replacement.
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
 * Fire the shortest feedback the device supports.
 *
 * @param ms Vibration length where a real API exists. iOS ignores it — the
 *           switch tap is a fixed system haptic with no duration control.
 */
function pulse(ms: number): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(ms);
      return;
    }
    // No Vibration API: try the iOS switch. Toggling it either way taps.
    ensureSwitch()?.click();
  } catch {
    // A device that will not buzz is not an error worth surfacing.
  }
}

/** Turning a card over. Deliberately the lighter of the two. */
export function hapticFlip(): void {
  pulse(8);
}

/** Committing an answer — Missed, Got it, or a completed swipe. */
export function hapticCommit(): void {
  pulse(16);
}
