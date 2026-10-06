import { useEffect, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import { type, useTheme } from './theme';

/**
 * Keys for a study screen, on a PC (NOTES §74). `onKey` gets
 * `KeyboardEvent.key` and says whether it used it; a used key does nothing
 * else.
 *
 * Left alone: a key held with Ctrl, Alt or the Windows key (the browser's
 * own), a held-down repeat, any key while a sheet is open (react-native-web
 * marks it `aria-modal`; the screen behind it is not what the person is
 * looking at), and a key on a focused button or link, which presses that
 * button itself. Without the last, Enter on a focused "Check my answer" would
 * check and then go straight on.
 */
export function useStudyKeys(onKey: (key: string) => boolean) {
  const latest = useRef(onKey);
  latest.current = onKey;

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const listener = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.altKey || event.metaKey || event.repeat || event.isComposing) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"], [role="link"]')) {
        return;
      }
      if (latest.current(event.key)) event.preventDefault();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}

/** Whether this device has a mouse and so, almost always, a keyboard. */
export function useHasKeyboard(): boolean {
  const [has] = useState(
    () =>
      Platform.OS === 'web' &&
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(hover: hover) and (pointer: fine)').matches,
  );
  return has;
}

/** One quiet line saying which keys work here. Only where there is a keyboard. */
export function KeyHint({ children }: { children: string }) {
  const t = useTheme();
  if (!useHasKeyboard()) return null;
  return <Text style={[type.caption, { color: t.textMuted, textAlign: 'center' }]}>{children}</Text>;
}
