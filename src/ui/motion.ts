import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The system's reduce-motion setting, live; `null` until it has been read.
 *
 * Shared by everything that moves — Nomi, the line Nomi types on Home, the
 * spinner while cards are made, the Progress bars growing in — so one setting
 * means the same thing everywhere (NOTES §37). It was written first inside
 * `nomi-character.tsx` (§35), when the owl was the only thing that moved.
 *
 * Callers start nothing while it is `null`, so someone who asked for less
 * motion never sees the first frames of an animation before the answer lands.
 */
export function useReducedMotion(): boolean | null {
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
