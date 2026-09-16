import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authorName,
  browseOrder,
  canStar,
  MESSAGE_MAX_LENGTH,
  MESSAGE_RATE_PER_MINUTE,
  rankSets,
  SHARING_FACTS,
  starLabel,
  validateMessage,
  visibilityLabel,
  type PublicSet,
} from '../src/core/community';

const MIGRATION = readFileSync('supabase/migrations/0021_community.sql', 'utf8');

/**
 * The migration with its comments removed.
 *
 * Every assertion about what a view exposes has to read the SQL and not the
 * prose around it, in both directions: a comment saying "MUST NEVER EXPOSE
 * gemini_api_key" would fail a test looking for that column, and a comment
 * containing a semicolon would truncate a view body and pass a test that then
 * checked nothing. The second is not hypothetical — it is how this helper was
 * written the first time, and the view's `where` clause fell outside the slice.
 */
const SQL_ONLY = MIGRATION.replace(/--[^\n]*/g, '');

/**
 * The body of one `create view` statement, so a test can assert on what a
 * single view exposes rather than on the whole file.
 */
function view(name: string): string {
  const start = SQL_ONLY.indexOf(`create view public.${name}`);
  expect(start, `no view named ${name} in 0021`).toBeGreaterThan(-1);
  const end = SQL_ONLY.indexOf(';', start);
  expect(end, `view ${name} is never terminated`).toBeGreaterThan(start);
  return SQL_ONLY.slice(start, end);
}

const ALL_VIEWS = [
  'public_profiles',
  'public_sets',
  'public_set_items',
  'global_chat',
  'my_schedule',
] as const;

function set(over: Partial<PublicSet> = {}): PublicSet {
  return {
    id: 'set-1',
    owner_id: 'user-a',
    owner_name: 'Paul',
    owner_avatar: 'face:2',
    title: 'Biology',
    published_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    stars: 0,
    cards: 10,
    ...over,
  };
}

describe('what a message may be', () => {
  it('sends the trimmed text, not what was typed around it', () => {
    expect(validateMessage('  hello  ')).toEqual({ ok: true, body: 'hello' });
  });

  it('refuses nothing at all, however it was typed', () => {
    for (const blank of ['', '   ', '\n\n', '\t ']) {
      expect(validateMessage(blank).ok).toBe(false);
    }
  });

  it('measures the trimmed text, so it agrees with the database rather than the field', () => {
    // A thousand spaces is empty to Postgres (`length(btrim(body))`) and would
    // be a full message to anything measuring the raw string. The two must not
    // disagree about which messages exist.
    expect(validateMessage(' '.repeat(MESSAGE_MAX_LENGTH)).ok).toBe(false);
    expect(validateMessage('x'.repeat(MESSAGE_MAX_LENGTH)).ok).toBe(true);
    expect(validateMessage('x'.repeat(MESSAGE_MAX_LENGTH + 1)).ok).toBe(false);
    // Trailing whitespace past the cap is trimmed away, not counted.
    expect(validateMessage(`${'x'.repeat(MESSAGE_MAX_LENGTH)}   `).ok).toBe(true);
  });

  it('says why in words, with no jargon and no character count nobody asked for', () => {
    const empty = validateMessage('');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe('Type something first.');
  });
});

describe('the limits are the database’s, copied', () => {
  it('the length cap matches global_messages’ own check', () => {
    expect(MIGRATION).toContain(`length(btrim(body)) between 1 and ${MESSAGE_MAX_LENGTH}`);
  });

  it('the per-minute limit matches send_global_message', () => {
    expect(MIGRATION).toContain(`if sent >= ${MESSAGE_RATE_PER_MINUTE} then`);
  });

  it('the two visibilities are the two the database allows', () => {
    expect(MIGRATION).toContain("check (visibility in ('private', 'public'))");
    expect(visibilityLabel('public')).toBe('Shared with everyone');
    expect(visibilityLabel('private')).toBe('Only you');
  });
});

describe('what the shared views may never expose', () => {
  it('no view hands out a Gemini key', () => {
    for (const name of ALL_VIEWS) {
      expect(view(name)).not.toContain('gemini_api_key');
    }
  });

  it('a picture is served only while it is the one that person is using', () => {
    // 0021 turned an uploaded photo into null in every view; 0023 reverses that
    // at the owner's request and the views now pass `p.avatar` through whole.
    //
    // The limit moved rather than disappearing, and this is where it lives now:
    // the avatars bucket keeps up to six photos per person as choices (NOTES
    // §45), and only the CURRENT one may be served. `is_chosen_avatar` asks
    // exactly that. Granting the bucket wholesale would be one line shorter and
    // would publish every photo anyone had ever uploaded, including the ones
    // they replaced because they did not like them.
    const later = readFileSync('supabase/migrations/0023_shared_profile_pictures.sql', 'utf8');
    const sql = later.replace(/--[^\n]*/g, '');

    expect(sql).toContain("where p.avatar = 'photo:' || object_name");
    expect(sql).toContain('security definer');
    expect(sql).toContain('public.is_chosen_avatar(name)');

    // Read only, signed in only. The four own-row policies from 0016 are not
    // touched, so writing into somebody else's folder is refused exactly as
    // before — and nothing here makes the bucket public.
    expect(sql).toContain('for select using');
    expect(sql).not.toMatch(/for\s+(insert|update|delete)/i);
    expect(sql).not.toMatch(/public\s*=\s*true/);
    expect(sql).toContain('(select auth.uid()) is not null');
  });

  it('the cards of a shared set carry nothing that points at the owner’s files', () => {
    const body = view('public_set_items');
    // documents and document_pages hold the FULL text of everything uploaded,
    // and storage paths into the private documents bucket. An excerpt is a
    // sentence the owner published with a card; the document is their whole PDF.
    expect(body).not.toContain('document_id');
    expect(body).not.toContain('storage_path');
    expect(body).not.toContain('document_pages');
    expect(body).not.toMatch(/join\s+public\.documents/);
  });

  it('a shared set is only ever one that was actually shared', () => {
    expect(view('public_sets')).toContain("where s.visibility = 'public'");
    expect(view('public_set_items')).toContain("where s.visibility = 'public'");
  });

  it('a reported card stays gone for everybody, not just its owner', () => {
    expect(view('public_set_items')).toContain('i.hidden = false');
  });

  it('my_schedule is only ever MY schedule, however it looks up the card', () => {
    const body = view('my_schedule');
    // The view's privilege exists to read the CARD beside a schedule row, never
    // to read somebody else's schedule. Without this line it would hand every
    // user's due dates to everyone, and it would look like a working due badge.
    expect(body).toContain('where r.user_id = (select auth.uid())');
    // And a card whose set stopped being shared drops out, because it can no
    // longer be opened either.
    expect(body).toContain("i.user_id = (select auth.uid()) or s.visibility = 'public'");
    // Same hidden-card rule as the query it replaces, or a reported card would
    // be promised by the badge and then refused by the deck (NOTES §21, §36).
    expect(body).toContain('i.hidden = false');
  });

  it('the generation plan stays private — it quotes the notes', () => {
    expect(view('public_sets')).not.toContain('s.plan');
    // And the column list is explicit, so a later `add column` cannot join the
    // public part of the app by accident.
    expect(view('public_sets')).not.toContain('s.*');
    expect(view('public_set_items')).not.toContain('i.*');
  });

  it('signed-out visitors reach none of them', () => {
    for (const name of ALL_VIEWS) {
      expect(MIGRATION).toMatch(new RegExp(`revoke all on public\\.${name}\\s+from anon, public`));
      expect(MIGRATION).toMatch(new RegExp(`grant select on public\\.${name}\\s+to authenticated`));
    }
  });
});

describe('what people are told before they share', () => {
  it('names the excerpt, because that is the half people assume wrongly', () => {
    expect(SHARING_FACTS.join(' ')).toContain('the bit of your notes each card came from');
  });

  it('promises only what the views actually do', () => {
    const facts = SHARING_FACTS.join(' ');
    // "the picture you are using" — and 0023 serves only that one.
    expect(facts).toContain('the picture you are using');
    expect(
      readFileSync('supabase/migrations/0023_shared_profile_pictures.sql', 'utf8'),
    ).toContain("p.avatar = 'photo:' || object_name");
    // "cannot see your files, your notes, your other sets"
    expect(facts).toContain('cannot see your files, your notes, your other sets');
    expect(MIGRATION).not.toMatch(/create view public\.\w+[\s\S]*?from public\.notes\b/);
    expect(MIGRATION).not.toMatch(/create view public\.\w+[\s\S]*?from public\.documents\b/);
  });

  it('uses no technical word', () => {
    const banned = /\b(RLS|policy|policies|row|column|table|database|bucket|storage|query|API)\b/i;
    for (const fact of SHARING_FACTS) expect(fact).not.toMatch(banned);
  });
});

describe('who somebody is, to everybody else', () => {
  it('calls a person without a name Someone, never an address or an id', () => {
    expect(authorName(null)).toBe('Someone');
    expect(authorName('   ')).toBe('Someone');
    expect(authorName(' Paul ')).toBe('Paul');
  });
});

describe('stars', () => {
  it('will not let you star your own set', () => {
    expect(canStar(set({ owner_id: 'me' }), 'me')).toBe(false);
    expect(canStar(set({ owner_id: 'someone-else' }), 'me')).toBe(true);
  });

  it('agrees with can_star_set, which is what would actually refuse it', () => {
    expect(MIGRATION).toContain('s.user_id <> (select auth.uid())');
  });

  it('counts in words', () => {
    expect(starLabel(0)).toBe('No stars yet');
    expect(starLabel(1)).toBe('1 star');
    expect(starLabel(4)).toBe('4 stars');
  });
});

describe('the ranking', () => {
  it('puts the most-starred first', () => {
    const ranked = rankSets([
      set({ id: 'a', stars: 1 }),
      set({ id: 'b', stars: 5 }),
      set({ id: 'c', stars: 3 }),
    ]);
    expect(ranked.map((s) => s.id)).toEqual(['b', 'c', 'a']);
    expect(ranked.map((s) => s.rank)).toEqual([1, 2, 3]);
  });

  it('leaves out sets nobody has starred rather than printing them last', () => {
    const ranked = rankSets([set({ id: 'a', stars: 0 }), set({ id: 'b', stars: 2 })]);
    expect(ranked.map((s) => s.id)).toEqual(['b']);
  });

  it('gives equal sets an equal rank, and skips the next', () => {
    const ranked = rankSets([
      set({ id: 'a', stars: 5 }),
      set({ id: 'b', stars: 3, published_at: '2026-09-01T00:00:00Z' }),
      set({ id: 'c', stars: 3, published_at: '2026-09-02T00:00:00Z' }),
      set({ id: 'd', stars: 1 }),
    ]);
    expect(ranked.map((s) => s.rank)).toEqual([1, 2, 2, 4]);
    // The tie-break decides ORDER, never rank: shared first is printed first.
    expect(ranked.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not reshuffle when nothing changed', () => {
    const sets = [
      set({ id: 'c', stars: 2, published_at: null, title: 'Zebra' }),
      set({ id: 'a', stars: 2, published_at: null, title: 'Apple' }),
      set({ id: 'b', stars: 2, published_at: null, title: 'Apple' }),
    ];
    const once = rankSets(sets).map((s) => s.id);
    const again = rankSets(sets.slice().reverse()).map((s) => s.id);
    expect(once).toEqual(again);
    expect(once).toEqual(['a', 'b', 'c']);
  });
});

describe('browsing', () => {
  it('shows what was shared most recently first', () => {
    const ordered = browseOrder([
      set({ id: 'old', published_at: '2026-08-01T00:00:00Z' }),
      set({ id: 'new', published_at: '2026-09-10T00:00:00Z' }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('orders by when it was shared, not when it was last edited', () => {
    // Otherwise fixing a typo in a five-month-old set puts it at the top of
    // "new" every time.
    const ordered = browseOrder([
      set({ id: 'edited-today', published_at: '2026-04-01T00:00:00Z', updated_at: '2026-09-16T00:00:00Z' }),
      set({ id: 'shared-yesterday', published_at: '2026-09-15T00:00:00Z', updated_at: '2026-09-15T00:00:00Z' }),
    ]);
    expect(ordered.map((s) => s.id)).toEqual(['shared-yesterday', 'edited-today']);
  });
});

describe('when something was said', () => {
  it('is answered by the chat module, not by a second copy here', () => {
    // `describeWhen` in src/core/chat.ts already says when, for somebody
    // reading a chat — a time today, "Yesterday", a weekday, then a date — and
    // it is tested there. Two functions of that name in two core modules is how
    // the three copies of the level picker in src/ui/segment.tsx drifted until
    // one of them shipped without its counts.
    const src = readFileSync('src/core/community.ts', 'utf8');
    expect(src).not.toMatch(/export function describeWhen/);
    expect(readFileSync('src/core/chat.ts', 'utf8')).toMatch(/export function describeWhen/);
  });
});
