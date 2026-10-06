import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rightClickOpensMenu } from '../src/core/app-feel';
import { setShortcuts } from '../src/core/set-menu';
import { blanksKey, quizKey } from '../src/core/study-keys';
import { CHAT_LIST_WIDTH, CHAT_SPLIT_MIN_WIDTH, showChatList } from '../src/core/chat-split';

/**
 * Step 4: Nomi on a PC (NOTES §74). The owner chose all four: right-click
 * menus, keyboard shortcuts, chats side by side, and a window that remembers
 * its size. The last is the Windows app's, held in tests/windows-app.test.ts.
 */

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8').replace(/\r\n/g, '\n');

describe('a right click', () => {
  it("opens the item's own menu with a mouse or a pen", () => {
    expect(rightClickOpensMenu({ pointerType: 'mouse', selected: false })).toBe(true);
    expect(rightClickOpensMenu({ pointerType: 'pen', selected: false })).toBe(true);
    // Safari sends a plain MouseEvent, with no pointerType at all.
    expect(rightClickOpensMenu({ pointerType: undefined, selected: false })).toBe(true);
  });

  it('leaves a finger to the long-press, which opens the menu already', () => {
    // An Android hold arrives as contextmenu too. Opening here as well would
    // race the long-press for the same menu.
    expect(rightClickOpensMenu({ pointerType: 'touch', selected: false })).toBe(false);
  });

  it('leaves the browser its menu over words selected in the item, for Copy', () => {
    expect(rightClickOpensMenu({ pointerType: 'mouse', selected: true })).toBe(false);
  });

  it('is wired where a phone has a hold or a ⋯', () => {
    expect(read('src', 'ui', 'chat-room.tsx')).toContain('{...rightClick(onAct)}');
    expect(read('src', 'ui', 'post.tsx')).toContain('{...rightClick(onMenu)}');
    expect(read('app', 'post', '[id].tsx')).toContain('{...rightClick(onMore)}');
    expect(read('app', '(tabs)', 'index.tsx')).toContain('{...rightClick(() => setMenuFor(set))}');
    // A set inside an open folder too, its menu drawn over the folder's sheet.
    expect(read('src', 'ui', 'folder-sheet.tsx')).toContain('rightClick(() => onSetMenu(set))');
    expect(read('app', '(tabs)', 'index.tsx')).toContain('onSetMenu={setMenuFor}');
  });
});

describe("a set's right-click menu", () => {
  it('offers the three ways to study a set with cards, after opening it', () => {
    expect(setShortcuts({ status: 'ready', cardCount: 12 }).map((s) => s.mode)).toEqual([
      'open',
      'flashcards',
      'quiz',
      'blanks',
    ]);
  });

  it('only opens a set still being made, a failed one, or one with no cards', () => {
    expect(setShortcuts({ status: 'generating', cardCount: 0 }).map((s) => s.mode)).toEqual(['open']);
    expect(setShortcuts({ status: 'failed' }).map((s) => s.mode)).toEqual(['open']);
    expect(setShortcuts({ status: 'ready', cardCount: 0 }).map((s) => s.mode)).toEqual(['open']);
  });
});

describe('keys on the quiz', () => {
  it('number keys choose among the choices there are, until it is marked', () => {
    expect(quizKey('2', { answered: false, choices: 4 })).toEqual({ kind: 'choose', index: 1 });
    expect(quizKey('4', { answered: false, choices: 4 })).toEqual({ kind: 'choose', index: 3 });
    expect(quizKey('5', { answered: false, choices: 4 })).toBeNull();
    expect(quizKey('0', { answered: false, choices: 4 })).toBeNull();
    expect(quizKey('1', { answered: true, choices: 4 })).toBeNull();
    // A question answered in words has nothing to choose.
    expect(quizKey('1', { answered: false, choices: 0 })).toBeNull();
  });

  it('Enter checks, then goes on', () => {
    expect(quizKey('Enter', { answered: false, choices: 4 })).toEqual({ kind: 'check' });
    expect(quizKey('Enter', { answered: true, choices: 4 })).toEqual({ kind: 'next' });
    expect(quizKey(' ', { answered: false, choices: 4 })).toBeNull();
  });
});

describe('keys on the blanks', () => {
  it("leave asking to the field, whose own Enter checks", () => {
    expect(blanksKey('Enter', 'asking')).toBeNull();
    expect(blanksKey('ArrowRight', 'asking')).toBeNull();
  });

  it('answer "did you have it?" with the arrows, as a flashcard is graded', () => {
    expect(blanksKey('ArrowRight', 'near')).toBe('had-it');
    expect(blanksKey('ArrowLeft', 'near')).toBe('missed-it');
    // Not Enter: "yes" and "no" are both one key away, and neither is the default.
    expect(blanksKey('Enter', 'near')).toBeNull();
  });

  it('Enter goes on once it is marked', () => {
    expect(blanksKey('Enter', 'right')).toBe('next');
    expect(blanksKey('Enter', 'wrong')).toBe('next');
  });

  it('are wired, with a hint where there is a keyboard', () => {
    const quiz = read('app', 'set', '[id]', 'quiz.tsx');
    const blanks = read('app', 'set', '[id]', 'blanks.tsx');
    expect(quiz).toContain('useStudyKeys(');
    expect(quiz).toContain('<KeyHint>');
    expect(blanks).toContain('useStudyKeys(');
    expect(blanks).toContain('<KeyHint>');
  });
});

describe('chats side by side', () => {
  it('only where the list fits beside a chat drawn at its usual width', () => {
    // Read from the file: src/ui/theme.ts imports react-native, which no test can.
    const contentMax = Number(/export const CONTENT_MAX_WIDTH = (\d+);/.exec(read('src', 'ui', 'theme.ts'))?.[1]);
    expect(contentMax).toBeGreaterThan(0);
    expect(CHAT_SPLIT_MIN_WIDTH).toBeGreaterThanOrEqual(CHAT_LIST_WIDTH + contentMax);
    expect(showChatList(1100)).toBe(true); // the Windows app's window as it first opens
    expect(showChatList(CHAT_SPLIT_MIN_WIDTH)).toBe(true);
    expect(showChatList(CHAT_SPLIT_MIN_WIDTH - 1)).toBe(false);
    expect(showChatList(430)).toBe(false); // a phone
  });

  it('every chat screen draws the list beside it', () => {
    expect(read('app', 'messages', '[id].tsx')).toContain('<ChatSplit current={conversationId}>');
    expect(read('app', 'messages', 'everyone.tsx')).toContain('<ChatSplit current="everyone">');
    expect(read('app', 'groups', '[id]', 'index.tsx')).toContain('<ChatSplit current={groupId}>');
  });
});
