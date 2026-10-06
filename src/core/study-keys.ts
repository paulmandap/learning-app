/**
 * Keys on the study screens, on a PC (NOTES §74).
 *
 * Flashcards have had Space and the arrows from the start (left: missed,
 * right: got it). The quiz and the blanks follow the same idea, so the hand on
 * the keyboard never has to reach for the mouse: number keys choose, Enter
 * checks and then goes on, and the arrows answer "did you have it?" as they
 * do on a flashcard.
 *
 * Pure: `src/ui/study-keys.tsx` listens to the page and decides here. Keys
 * typed into a field never get here: react-native-web's TextInput stops them
 * at the field (measured, NOTES §74), so a field's own Enter does the checking.
 */

export type QuizKeyAction = { kind: 'choose'; index: number } | { kind: 'check' } | { kind: 'next' };

/**
 * `key` as `KeyboardEvent.key` names it. `choices` is how many there are to
 * choose from, 0 for a question answered in words.
 */
export function quizKey(key: string, state: { answered: boolean; choices: number }): QuizKeyAction | null {
  if (key === 'Enter') return state.answered ? { kind: 'next' } : { kind: 'check' };
  if (!state.answered && /^[1-9]$/.test(key)) {
    const index = Number(key) - 1;
    if (index < state.choices) return { kind: 'choose', index };
  }
  return null;
}

export type BlanksPhase = 'asking' | 'near' | 'right' | 'wrong';
export type BlanksKeyAction = 'had-it' | 'missed-it' | 'next';

export function blanksKey(key: string, phase: BlanksPhase): BlanksKeyAction | null {
  if (phase === 'near') {
    if (key === 'ArrowRight') return 'had-it';
    if (key === 'ArrowLeft') return 'missed-it';
    return null;
  }
  if (phase === 'right' || phase === 'wrong') return key === 'Enter' ? 'next' : null;
  // Asking: the field's own Enter checks.
  return null;
}
