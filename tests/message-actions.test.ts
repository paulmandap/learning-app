import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { canEdit, EDIT_WINDOW_MINUTES, editedLabel } from '../src/core/community';
import { REACTIONS, tallyReactions, type Reaction } from '../src/core/emoji';

/**
 * Reacting to a message, and editing one you just sent (NOTES §48).
 */

const MIGRATION = readFileSync(
  'supabase/migrations/0025_subfolders_reactions_and_edits.sql',
  'utf8',
);

const MINUTE = 60 * 1000;
const NOW = Date.parse('2026-09-19T12:00:00Z');
const sentAgo = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();

const msg = (over: Partial<{ author_id: string; created_at: string }> = {}) => ({
  author_id: 'me',
  created_at: sentAgo(1),
  ...over,
});

describe('editing a message', () => {
  it('is offered on your own, inside the window', () => {
    expect(canEdit(msg(), 'me', NOW)).toBe(true);
    expect(canEdit(msg({ created_at: sentAgo(EDIT_WINDOW_MINUTES - 1) }), 'me', NOW)).toBe(true);
  });

  it('stops being offered once the window closes', () => {
    expect(canEdit(msg({ created_at: sentAgo(EDIT_WINDOW_MINUTES) }), 'me', NOW)).toBe(false);
    expect(canEdit(msg({ created_at: sentAgo(EDIT_WINDOW_MINUTES + 1) }), 'me', NOW)).toBe(false);
  });

  it('is never offered on somebody else’s', () => {
    expect(canEdit(msg({ author_id: 'someone-else' }), 'me', NOW)).toBe(false);
  });

  it('is not offered on a message from the future, whatever a clock says', () => {
    // created_at comes from the database's clock and `now` from the device's.
    expect(canEdit(msg({ created_at: sentAgo(-5) }), 'me', NOW)).toBe(false);
  });

  it('agrees with the window the database will actually enforce', () => {
    expect(MIGRATION).toContain(`select interval '${EDIT_WINDOW_MINUTES} minutes'`);
  });

  it('is never silent — an edit is always marked', () => {
    // 0021 refused editing outright: "a message somebody has already read,
    // silently changed afterwards, is worse than one that visibly went away."
    // This is what makes editing not silent, so the rule still holds.
    expect(editedLabel({ edited_at: null })).toBeNull();
    expect(editedLabel({ edited_at: '2026-09-19T12:00:00Z' })).toBe('edited');
    expect(MIGRATION).toContain('edited_at = now()');
  });

  it('writes only the two columns it should', () => {
    // An UPDATE reaching the table could move created_at forward and make the
    // window last for ever. There is no update policy at all, and the function
    // sets exactly body and edited_at.
    expect(MIGRATION).toMatch(/set body = new_body, edited_at = now\(\)/);
    expect(MIGRATION).not.toMatch(/create policy .*global_messages.*for update/i);
  });

  it('does not shadow the column it writes', () => {
    // `body text := btrim(p_body)` plus `set body = body` is an ambiguous
    // reference, which plpgsql refuses by default — it would have failed at run
    // time on the first edit anybody tried, with every test still passing.
    expect(MIGRATION).toContain('new_body text := btrim(p_body)');
    expect(MIGRATION).not.toMatch(/^\s*body text := /m);
  });
});

describe('reactions', () => {
  const react = (emoji: string, user_id: string, name?: string): Reaction => ({
    message_id: 'm1',
    emoji,
    user_id,
    name,
  });

  it('offers the six the owner named, in Messenger’s order', () => {
    expect(REACTIONS.map((r) => r.emoji)).toEqual(['❤️', '😂', '😮', '😢', '😠', '👍']);
    // Each carries a word, or a screen reader announces six things as "emoji".
    for (const r of REACTIONS) expect(r.label).toMatch(/^[A-Z]/);
  });

  it('counts people, not taps', () => {
    const tallies = tallyReactions(
      [react('❤️', 'a', 'Ann'), react('❤️', 'b', 'Ben'), react('😂', 'c', 'Cal')],
      'me',
    );
    expect(tallies.map((t) => [t.emoji, t.count])).toEqual([
      ['❤️', 2],
      ['😂', 1],
    ]);
  });

  it('knows which one is yours', () => {
    const tallies = tallyReactions([react('❤️', 'me'), react('😂', 'other')], 'me');
    expect(tallies.find((t) => t.emoji === '❤️')!.mine).toBe(true);
    expect(tallies.find((t) => t.emoji === '😂')!.mine).toBe(false);
  });

  it('names you as "You" and a nameless person as "Someone"', () => {
    const tallies = tallyReactions([react('❤️', 'me'), react('❤️', 'x', '  ')], 'me');
    expect(tallies[0]!.names).toEqual(['You', 'Someone']);
  });

  it('puts the busiest first and does not reshuffle a tie', () => {
    const once = tallyReactions([react('😂', 'a'), react('❤️', 'b')], 'me');
    const again = tallyReactions([react('❤️', 'b'), react('😂', 'a')], 'me');
    expect(once.map((t) => t.emoji)).toEqual(again.map((t) => t.emoji));
  });

  it('lets one person leave several different reactions, but not the same one twice', () => {
    expect(MIGRATION).toContain('primary key (message_id, user_id, emoji)');
  });

  it('names who reacted, unlike a star on a set', () => {
    // Stars are counted and never named (0021) because a five-person ranking
    // showing who withheld one is a worse place to share. A reaction is the
    // opposite: it is a reply, in a room where everything else is attributed,
    // and an anonymous 😠 on somebody's message would be worse than a named one.
    expect(MIGRATION).toContain('create policy message_reactions_select_signed_in');
    expect(MIGRATION).toContain('create view public.message_reaction_people');
  });
});

describe('the actions on a message', () => {
  const source = readFileSync('src/ui/message-actions.tsx', 'utf8');

  it('appear on hover on a pointer, and on a long press on a touch screen', () => {
    // The hover lives on the message ROW, not on the buttons — controls that
    // appeared only while the mouse was on the controls could never be reached.
    expect(readFileSync('app/(tabs)/community.tsx', 'utf8')).toContain('onPointerEnter');
    expect(source).toContain('export function useLongPress');
  });

  it('never change the layout when they appear', () => {
    // A row that appears on hover must not push the bubble sideways, or every
    // message shifts as the mouse travels down the page.
    expect(source).toMatch(/opacity: visible \? 1 : 0/);
    expect(source).toMatch(/pointerEvents: visible \? 'auto' : 'none'/);
  });

  it('do not make unsending a single tap', () => {
    // The owner unsent something by accident when the bubble itself deleted on
    // one tap (NOTES §47). Nothing destructive may be reachable without the
    // sheet, which is where the choice lives.
    const chat = readFileSync('app/(tabs)/community.tsx', 'utf8');
    expect(chat).not.toMatch(/onPress=\{[^}]*deleteMessageForEveryone/);
    expect(chat).toContain('onLongPress={onAct}');
  });
});
