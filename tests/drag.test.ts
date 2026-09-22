import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Holding a set and dragging it into a folder (NOTES §48).
 *
 * The behaviour is proven end to end by `scripts/drag-probe.ts`, with a real
 * mouse and a real finger through Chrome's input API. These hold the source to
 * the three mistakes that probe and a re-read found, because each of them
 * typechecks, passes every other test, and breaks the feature completely.
 *
 * Read as text: the file imports react-native, which Vitest does not load.
 */

const source = readFileSync('src/ui/drag-to-folder.tsx', 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the hold before a set lifts', () => {
  it('is a full second for a finger and a quarter for a mouse, as asked', () => {
    // "for mobile, add a 1 second delay in order to prevent accidental moving."
    expect(code).toMatch(/HOLD_MS = \{ mouse: 250, touch: 1000, pen: 1000 \}/);
  });

  it('is chosen by the POINTER, never by the platform', () => {
    // The first version used `Platform.OS === 'web'` — and this app ships as a
    // PWA, so on the owner's iPhone that is 'web' too, and a finger would have
    // got the mouse's quarter-second.
    expect(code).toContain('ev.pointerType');
    expect(code).toContain('HOLD_MS[kind]');
    expect(code).not.toMatch(/Platform\.OS === 'web' \? HOLD_MS/);
  });

  it('is armed by a pointer event, which a mouse also fires', () => {
    // The first version armed it in onTouchStart. A mouse fires no touch
    // events, so a mouse drag could never have started.
    expect(code).toContain('onPointerDown');
    expect(code).not.toMatch(/onTouchStart/);
  });
});

describe('a drag in progress', () => {
  it('is not ended by its own context changing', () => {
    // The lift changes the drag context on purpose. With `finish` depending on
    // it and an unmount effect keyed on `finish`, React ran the cleanup on that
    // change — and every set was dropped one frame after it was picked up.
    // Measured: held 700ms, never lifted. The context is read through a ref.
    expect(code).toContain('dragRef.current = drag');
    expect(code).toMatch(/const finish = useCallback\([\s\S]*?\[offset\],\s*\)/);
  });

  it('never changes identity because Home re-rendered', () => {
    // Home passes onDrop inline. Through a ref, `end` is stable for ever.
    expect(code).toContain('onDropRef.current = onDrop');
    expect(code).toMatch(/const end = useCallback\([\s\S]*?\}, \[\]\)/);
  });

  it('stops the page scrolling only while a set is lifted, and lets go after', () => {
    // A non-passive touchmove is the only thing that stops a phone scrolling
    // under a finger that is carrying something. Added at the lift and removed
    // at the drop — never on the row itself, or the list could not be scrolled
    // by a finger that started on a set.
    expect(code).toContain("document.addEventListener('touchmove', noScroll, { passive: false })");
    expect(code).toContain("document.removeEventListener('touchmove', noScroll)");
  });

  it('does not open the set when you let go of it', () => {
    // Letting go often lands on the row the drag started from.
    expect(code).toContain('CLICK_GUARD_MS');
    expect(readFileSync('app/(tabs)/index.tsx', 'utf8')).toContain('onPress={guard(');
  });
});
