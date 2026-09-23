import { useEffect, useRef } from 'react';
import { Animated, Platform, type View } from 'react-native';
import { GAZE_RETURN_MS, lookToward } from '../core/nomi-motion';

const NATIVE = Platform.OS !== 'web';

/**
 * Nomi's eyes following a finger or the mouse (NOTES §49).
 *
 * The owner chose "eyes follow you" among the kinds of life offered. This is a
 * PWA, so the pointer is the web's: the mouse on a computer, and on an iPhone a
 * finger — where it touches, and where it drags while scrolling. Each event
 * moves two values `NomiCharacter` adds to its own look, so nothing re-renders;
 * the eyes come back to the middle once the pointer has been still for
 * `GAZE_RETURN_MS`.
 *
 * Off when `enabled` is false — a state whose look is its own, such as thinking
 * or studying, or reduce motion — and off everywhere but the web, where there
 * is no pointer to follow. Where the owl is comes from the element itself at
 * the moment of each event, so scrolling never leaves the eyes looking at where
 * Nomi used to be.
 */
export function useNomiGaze(enabled: boolean): {
  gaze: { x: Animated.Value; y: Animated.Value };
  anchor: React.RefObject<View | null>;
} {
  const gaze = useRef({ x: new Animated.Value(0), y: new Animated.Value(0) }).current;
  const anchor = useRef<View | null>(null);

  useEffect(() => {
    const toward = (x: number, y: number, duration: number) =>
      Animated.parallel([
        Animated.timing(gaze.x, { toValue: x, duration, useNativeDriver: NATIVE }),
        Animated.timing(gaze.y, { toValue: y, duration, useNativeDriver: NATIVE }),
      ]).start();

    if (!enabled || Platform.OS !== 'web' || typeof window === 'undefined') {
      toward(0, 0, 200);
      return;
    }

    let back: ReturnType<typeof setTimeout> | undefined;
    const follow = (event: PointerEvent) => {
      // react-native-web hands a View's ref over as its element.
      const el = anchor.current as unknown as HTMLElement | null;
      if (!el || typeof el.getBoundingClientRect !== 'function') return;
      const box = el.getBoundingClientRect();
      const look = lookToward(
        { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        { x: event.clientX, y: event.clientY },
      );
      toward(look.x, look.y, 120);
      if (back) clearTimeout(back);
      back = setTimeout(() => toward(0, 0, 400), GAZE_RETURN_MS);
    };

    window.addEventListener('pointermove', follow, { passive: true });
    window.addEventListener('pointerdown', follow, { passive: true });
    return () => {
      window.removeEventListener('pointermove', follow);
      window.removeEventListener('pointerdown', follow);
      if (back) clearTimeout(back);
      toward(0, 0, 200);
    };
  }, [enabled, gaze]);

  return { gaze, anchor };
}
