import { describe, expect, it } from 'vitest';
import {
  answerLocally,
  EMPTY_SNAPSHOT,
  homeLine,
  modelBrief,
  suggestion,
  type AppSnapshot,
} from '../src/core/nomi-brain';

/**
 * Nomi's instant answers.
 *
 * Two lists matter equally: questions about the student's own app that must be
 * answered here, and near-misses that must NOT be — a wrong instant answer to
 * "what is due process?" is worse than a slower right one from Gemini.
 */

const paul: AppSnapshot = {
  name: 'Paul',
  streak: 3,
  studiedToday: false,
  dueToday: 7,
  toRetry: 5,
  totalAnswers: 312,
  sets: [
    { id: 'a', title: 'Muscular System', cards: 17, due: 5, missed: 4, known: 6 },
    { id: 'b', title: 'Cardiology', cards: 11, due: 2, missed: 1, known: 9 },
  ],
};

const intentOf = (message: string, s: AppSnapshot = paul) => answerLocally(message, s)?.intent ?? null;

describe('questions Nomi answers instantly, from the app', () => {
  it.each([
    ['Hi', 'greeting'],
    ['hi nomi', 'greeting'],
    ['Hello!', 'greeting'],
    ['good morning', 'greeting'],
    ['what is my streak today', 'streak'],
    ["what's my streak?", 'streak'],
    ['how many days in a row have I studied', 'streak'],
    ['what cards are due', 'due'],
    ["what's due today?", 'due'],
    ['how many cards are due', 'due'],
    ['do I have anything to review today', 'due'],
    ['which cards did I miss', 'missed'],
    ['how many to retry', 'missed'],
    ['what should I study?', 'next'],
    ['where should I start', 'next'],
    ['how many sets do I have', 'sets'],
    ['list my decks', 'sets'],
    ['how am I doing', 'progress'],
    ["what's my name", 'name'],
    ['who are you?', 'who'],
    ['thank you', 'thanks'],
  ])('%s → %s', (message, intent) => {
    expect(intentOf(message)).toBe(intent);
  });
});

describe('questions that only LOOK like app questions go to Gemini', () => {
  it.each([
    'what is due process',
    'explain the streak of blood in a clot',
    'hi can you explain how the sinoatrial node sets the heart rate',
    'what is ATP',
    'quiz me on the cardiac cycle',
    'tell me a joke',
    'how do I remember the cranial nerves',
    'what are sets in maths',
    'who discovered penicillin',
  ])('%s → Gemini', (message) => {
    expect(answerLocally(message, paul)).toBeNull();
  });

  it('never answers a long message locally, whatever words it contains', () => {
    expect(
      answerLocally('hi so I was wondering what my streak means for the exam next week and how to plan', paul),
    ).toBeNull();
  });
});

describe('what the instant answers say', () => {
  it('greets by name and says what is waiting', () => {
    expect(answerLocally('hi', paul)!.text).toBe('Hi Paul! You have 5 cards to retry. What can I help with?');
    expect(answerLocally('hey', EMPTY_SNAPSHOT)!.text).toBe("Hi! You're all caught up. What can I help with?");
  });

  it('states the streak exactly, and never threatens to take it away', () => {
    expect(answerLocally("what's my streak", paul)!.text).toBe(
      "You're on a 3-day streak. Study something today to keep it going.",
    );
    expect(answerLocally("what's my streak", { ...paul, studiedToday: true })!.text).toContain('today already counts');
    expect(answerLocally("what's my streak", { ...paul, streak: 0 })!.text).toContain("don't have a streak");
    for (const s of [paul, { ...paul, studiedToday: true }]) {
      expect(answerLocally('my streak', s)!.text).not.toMatch(/lose|break|miss/i);
    }
  });

  it('says where the due cards are, biggest set first', () => {
    expect(answerLocally("what's due", paul)!.text).toBe('7 cards are due today: 5 in Muscular System and 2 in Cardiology.');
    expect(answerLocally("what's due", { ...paul, dueToday: 0 })!.text).toContain('Nothing is due');
  });

  it('suggests the set with missed cards before the set with due cards', () => {
    expect(answerLocally('what should I study', paul)!.text).toBe(
      'Start with Muscular System: it has 4 cards you missed.',
    );
    const noMisses = { ...paul, toRetry: 0, sets: paul.sets.map((s) => ({ ...s, missed: 0 })) };
    expect(suggestion(noMisses)!.set.title).toBe('Muscular System');
    expect(suggestion(noMisses)!.reason).toBe('5 cards are due');
  });

  it("does not know a name it was not given, and says so", () => {
    expect(answerLocally("what's my name", { ...paul, name: null })!.text).toContain("don't know your name");
  });

  it('says one card, not one cards', () => {
    const one = { ...paul, dueToday: 1, toRetry: 1, sets: [{ ...paul.sets[0]!, due: 1, missed: 1 }] };
    expect(answerLocally("what's due", one)!.text).toBe('1 card is due today: 1 in Muscular System.');
    expect(homeLine(one)).toMatch(/^1 card to retry/);
  });
});

describe('homeLine', () => {
  it('leads with what matters most', () => {
    expect(homeLine(paul)).toMatch(/^5 cards to retry/);
    expect(homeLine({ ...paul, toRetry: 0 })).toBe('7 cards due today. Want to start?');
    expect(homeLine({ ...paul, toRetry: 0, dueToday: 0 })).toContain('3-day streak');
    expect(homeLine(EMPTY_SNAPSHOT)).toContain('Add some notes');
  });
});

describe('modelBrief', () => {
  it('hands Gemini the exact numbers, labelled as facts', () => {
    const brief = modelBrief(paul);
    expect(brief).toContain('accurate right now');
    expect(brief).toContain('Name: Paul');
    expect(brief).toContain('Study streak: 3 days (studied today: not yet)');
    expect(brief).toContain('Muscular System: 17, 5, 4, 6');
  });

  it('caps a long list of sets instead of sending all of them', () => {
    const many = { ...paul, sets: Array.from({ length: 20 }, (_, i) => ({ ...paul.sets[0]!, id: `s${i}`, title: `Set ${i}` })) };
    const brief = modelBrief(many);
    expect(brief).toContain('and 5 more sets');
    expect(brief).not.toContain('Set 19:');
  });
});
