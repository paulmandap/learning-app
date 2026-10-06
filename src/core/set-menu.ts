import type { IconName } from './icon-shapes';

/**
 * A set's right-click menu on a PC (NOTES §74): where its row can take you.
 *
 * Only ways in. Renaming, sharing and deleting stay on the set's own page,
 * behind its ⋯ and their confirm steps, so nothing destructive is one click
 * away in a list. The three ways to study appear once there are cards, as on
 * the set's page.
 */
export type SetShortcutMode = 'open' | 'flashcards' | 'quiz' | 'blanks';

export interface SetShortcut {
  mode: SetShortcutMode;
  label: string;
  icon: IconName;
}

export function setShortcuts(set: { status: string; cardCount?: number }): SetShortcut[] {
  const open: SetShortcut = { mode: 'open', label: 'Open set', icon: 'forward' };
  if (set.status !== 'ready' || (set.cardCount ?? 0) === 0) return [open];
  return [
    open,
    { mode: 'flashcards', label: 'Flashcards', icon: 'set' },
    { mode: 'quiz', label: 'Quiz', icon: 'check' },
    { mode: 'blanks', label: 'Fill in the blanks', icon: 'edit' },
  ];
}
