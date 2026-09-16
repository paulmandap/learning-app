import { completeRows, supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import type { ChatMessage, PublicSet, Visibility } from '../core/community';
import { validateMessage } from '../core/community';
import type { StudySet } from './sets';

/**
 * Sets shared with everyone, stars, the ranking, and the global chat.
 *
 * ## The one thing to understand before changing anything here
 *
 * Every other module in `src/data/**` says the same thing at the top: *"RLS
 * scopes every query to the signed-in user, so nothing here filters by user_id
 * — the database decides."* That is still true, and this module is not an
 * exception to it. It is the module where the database decides something
 * different.
 *
 * Migration 0021 did NOT relax a single policy on a single base table. Instead
 * it added four views that run as their owner and therefore see across
 * accounts, each filtered to exactly what is shared:
 *
 *   public_sets       sets whose owner set them to 'public', with star and card
 *                     counts computed where set_stars' own policy cannot reach
 *   public_set_items  the cards of those sets, minus anything pointing at the
 *                     owner's files. Read from `src/data/items.ts`, not here,
 *                     so that every screen deals a card through one function
 *   public_profiles   a name and a drawn face, never an uploaded photo
 *   global_chat       messages with the name to put beside them
 *
 * So: **reads of other people's things come from a view; writes always go to a
 * base table under ordinary own-row RLS.** Star, unstar, send, delete and
 * publish below are all writes to a table the caller owns a row in. If you ever
 * find yourself wanting to write through a view, that is the signal to stop —
 * it means the change needs a policy nobody has thought about yet.
 *
 * The reason it was built this way rather than with an "or the set is public"
 * policy on study_items is recorded in 0021's header: such a policy would have
 * silently widened every query in the app that trusts RLS as its only filter,
 * starting with the unfiltered `from('study_items')` read on the Progress
 * screen, which would have begun counting other people's cards as yours.
 */

/** Columns of `public_sets`, in the order the view declares them. */
const PUBLIC_SET_COLUMNS =
  'id, owner_id, owner_name, owner_avatar, title, published_at, updated_at, stars, cards';

/** Columns of `global_chat`. */
const CHAT_COLUMNS = 'id, author_id, author_name, author_avatar, body, created_at';

/**
 * Thrown when the database has not got 0021 yet.
 *
 * Same shape as `RemindersUnavailableError` in reminders.ts, and for the same
 * reason: a screen has to tell the difference between "nobody has shared
 * anything" and "this part of the app is not switched on yet", and a missing
 * table reports PGRST205 rather than anything a person could read.
 */
export class CommunityUnavailableError extends Error {
  constructor() {
    super('Sharing is not switched on yet.');
    this.name = 'CommunityUnavailableError';
  }
}

async function currentUserId(db: Db = supabase): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

// ------------------------------------------------------------ shared sets --

/**
 * Every set anyone has shared.
 *
 * Unordered here on purpose: `browseOrder` and `rankSets` in
 * `src/core/community.ts` decide the two orders this list is shown in, and they
 * are testable without a database. Asking PostgREST to sort would put one of
 * those two orders in SQL and the other in TypeScript, which is how they drift.
 */
export async function listPublicSets(db: Db = supabase): Promise<PublicSet[]> {
  const result = await db.from('public_sets').select(PUBLIC_SET_COLUMNS, { count: 'exact' });

  if (isMissingTable(result.error) || isMissingColumn(result.error)) {
    throw new CommunityUnavailableError();
  }
  if (result.error) throw new Error(result.error.message);
  // A truncated read here is a set missing from the list and from the ranking,
  // with nothing to say so — the same silent shortfall completeRows exists for.
  return completeRows('listPublicSets', result) as unknown as PublicSet[];
}

export async function getPublicSet(setId: string, db: Db = supabase): Promise<PublicSet | null> {
  const { data, error } = await db
    .from('public_sets')
    .select(PUBLIC_SET_COLUMNS)
    .eq('id', setId)
    .maybeSingle();

  if (isMissingTable(error) || isMissingColumn(error)) throw new CommunityUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? null) as unknown as PublicSet | null;
}

/**
 * A set the caller may open, and whether it is theirs.
 *
 * The three study screens need this before anything else: a set you own is
 * editable, reportable and can have notes added to it; a set someone shared is
 * none of those. Asking `study_sets` first and `public_sets` second is also the
 * cheapest way to answer it — your own set is one indexed primary-key read, and
 * the view is only consulted when that comes back empty.
 *
 * Returns null when the set is neither yours nor shared, which is the same
 * answer for "it does not exist" and "it exists and is private". That is
 * deliberate: distinguishing them would tell a stranger which set ids are real.
 */
export async function readableSet(
  setId: string,
  db: Db = supabase,
): Promise<{ set: StudySet; owned: boolean; owner: PublicSet | null } | null> {
  const mine = await db
    .from('study_sets')
    .select('id, title, status, plan, created_at, updated_at')
    .eq('id', setId)
    .maybeSingle();

  if (mine.error) throw new Error(mine.error.message);
  if (mine.data) return { set: mine.data as unknown as StudySet, owned: true, owner: null };

  const shared = await getPublicSet(setId, db);
  if (!shared) return null;

  return {
    // Shaped as a StudySet so every screen below this point is unchanged. There
    // is no plan to show for a set you do not own — `plan` quotes the owner's
    // notes and public_sets does not carry it.
    set: {
      id: shared.id,
      title: shared.title,
      status: 'ready',
      plan: null,
      created_at: shared.published_at ?? shared.updated_at,
      updated_at: shared.updated_at,
    },
    owned: false,
    owner: shared,
  };
}

// --------------------------------------------------------------- sharing --

/**
 * Share a set with everyone, or stop.
 *
 * `published_at` records when it was FIRST shared and is never moved
 * afterwards, so unsharing and resharing does not send a six-month-old set back
 * to the top of the list — and does not reorder the ranking's ties either. That
 * is what the read before the write is for; PostgREST has no `coalesce` on an
 * update.
 *
 * Refuses a set that has no cards yet. `public_sets` filters on
 * `status = 'ready'`, so sharing one that is still being made would appear to
 * work and then show nothing to anybody, which is the worst of both.
 */
export async function setVisibility(
  setId: string,
  visibility: Visibility,
  db: Db = supabase,
): Promise<void> {
  const current = await db
    .from('study_sets')
    .select('status, published_at')
    .eq('id', setId)
    .maybeSingle();

  if (isMissingColumn(current.error)) throw new CommunityUnavailableError();
  if (current.error) throw new Error(current.error.message);
  if (!current.data) throw new Error('That set is not yours to share.');

  const row = current.data as { status: string; published_at: string | null };
  if (visibility === 'public' && row.status !== 'ready') {
    throw new Error('Wait until the cards are made, then share it.');
  }

  const patch: { visibility: Visibility; published_at?: string } = { visibility };
  if (visibility === 'public' && row.published_at === null) {
    patch.published_at = new Date().toISOString();
  }

  const { error } = await db.from('study_sets').update(patch).eq('id', setId);
  if (isMissingColumn(error)) throw new CommunityUnavailableError();
  if (error) throw new Error(error.message);
}

/** Is this set of mine shared? Reads the owner's own row, so RLS is enough. */
export async function visibilityOf(setId: string, db: Db = supabase): Promise<Visibility> {
  const { data, error } = await db
    .from('study_sets')
    .select('visibility')
    .eq('id', setId)
    .maybeSingle();

  // Before 0021 there is no column, and everything is private. Not an error:
  // the set screen still has to render.
  if (isMissingColumn(error)) return 'private';
  if (error) throw new Error(error.message);
  return ((data as { visibility?: Visibility } | null)?.visibility ?? 'private') as Visibility;
}

// ----------------------------------------------------------------- stars --

/**
 * Which sets I have starred.
 *
 * Own rows only, which is all `set_stars` will ever show anybody — the counts
 * come from `public_sets`, computed as its owner. Nobody can list who starred
 * what, deliberately (0021, section 3).
 */
export async function myStars(db: Db = supabase): Promise<Set<string>> {
  const result = await db.from('set_stars').select('study_set_id', { count: 'exact' });

  if (isMissingTable(result.error)) throw new CommunityUnavailableError();
  if (result.error) throw new Error(result.error.message);

  const rows = completeRows('myStars', result) as unknown as { study_set_id: string }[];
  return new Set(rows.map((r) => r.study_set_id));
}

/**
 * Star a set, or take the star back.
 *
 * The insert can be refused by `set_stars_insert_own`, which calls
 * `can_star_set` — public, and not your own. The screen already hides the
 * control in both cases (`canStar` in src/core/community.ts), so a refusal here
 * means the set was unshared between the list loading and the tap, and the
 * message says that rather than repeating a rule the person cannot have broken
 * on purpose.
 */
export async function star(setId: string, db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);
  const { error } = await db.from('set_stars').insert({ user_id, study_set_id: setId });

  if (isMissingTable(error)) throw new CommunityUnavailableError();
  // 23505: already starred. Starring twice is what a double tap looks like, and
  // it is not a failure — the wanted state is the state.
  if (error && error.code !== '23505') {
    if (error.code === '42501') throw new Error('That set is not shared any more.');
    throw new Error(error.message);
  }
}

export async function unstar(setId: string, db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);
  const { error } = await db
    .from('set_stars')
    .delete()
    .eq('user_id', user_id)
    .eq('study_set_id', setId);

  if (isMissingTable(error)) throw new CommunityUnavailableError();
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------------ chat --

/**
 * The most recent messages, oldest last.
 *
 * Asked for newest-first so the cap keeps the NEWEST messages rather than an
 * arbitrary slice of old ones, then reversed here so the screen can render top
 * to bottom. Same reasoning as the bounded `attempts` read on the Progress
 * screen: a room with a year of history should not download all of it to show
 * the last page.
 */
export async function listMessages(limit = 100, db: Db = supabase): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('global_chat')
    .select(CHAT_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (isMissingTable(error)) throw new CommunityUnavailableError();
  if (error) throw new Error(error.message);
  // No completeRows: this read is deliberately capped, so short IS the answer.
  return ((data ?? []) as unknown as ChatMessage[]).slice().reverse();
}

/**
 * Say something.
 *
 * Goes through the `send_global_message` function rather than an insert,
 * because the per-minute limit and the write have to be one statement — two
 * tabs checking and then inserting would both pass the check. The same
 * reasoning as `claim_chat_message` in 0010.
 *
 * Validated here first so an empty or over-long message costs no round trip,
 * and so the person is told in words rather than shown a constraint name. The
 * database still checks; this only saves the trip.
 */
export async function sendMessage(raw: string, db: Db = supabase): Promise<void> {
  const check = validateMessage(raw);
  if (!check.ok) throw new Error(check.reason);

  const { error } = await db.rpc('send_global_message', { message: check.body });

  if (isMissingTable(error) || error?.code === 'PGRST202') {
    throw new CommunityUnavailableError();
  }
  if (error) {
    // P0001 is the rate limit raising. Its own message names a minute, which is
    // not what someone wants to read when they are typing fast.
    if (error.code === 'P0001') throw new Error('That is a lot of messages at once — give it a moment.');
    throw new Error(error.message);
  }
}

/**
 * Take back something you said.
 *
 * Delete, never edit: a message somebody has already read, silently changed
 * afterwards, is worse than one that visibly went away. RLS allows only your
 * own, so this needs no owner check of its own.
 */
export async function deleteMessage(id: string, db: Db = supabase): Promise<void> {
  const { error } = await db.from('global_messages').delete().eq('id', id);
  if (isMissingTable(error)) throw new CommunityUnavailableError();
  if (error) throw new Error(error.message);
}

/**
 * Everything this feature holds for one person, removed.
 *
 * Called by `deleteAllMyData`. Stars and messages are separate from sets and do
 * not cascade from one — a star is a row about somebody ELSE's set, so deleting
 * every set of mine leaves all of mine behind. Unsharing is last and matters
 * most: it is the difference between "delete my data" and "delete my data
 * except the part four other people can still read".
 */
export async function removeMyCommunityData(db: Db = supabase): Promise<void> {
  const user_id = await currentUserId(db);

  for (const table of ['set_stars', 'global_messages'] as const) {
    const { error } = await db.from(table).delete().eq('user_id', user_id);
    if (error && !isMissingTable(error)) throw new Error(error.message);
  }

  // Unshare everything, before the sets themselves are deleted. Doing it the
  // other way round would be harmless today, because deleting a set removes it
  // from public_sets too — but "delete my data" has a partial-failure path
  // (storage removals are best effort), and a run that stopped half way must
  // not leave a shared set behind.
  const { error } = await db
    .from('study_sets')
    .update({ visibility: 'private' })
    .eq('user_id', user_id);
  if (error && !isMissingColumn(error)) throw new Error(error.message);
}
