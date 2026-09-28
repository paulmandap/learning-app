import { supabase, type Db } from './supabase';
import { throwIfGated } from './moderation';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import {
  searchTerm,
  validateUsername,
  REPORT_DETAILS_MAX,
  type FriendLink,
  type ReportKind,
  type ReportReason,
} from '../core/social';
import { BIO_MAX, validateBio } from '../core/profile';

/**
 * Usernames, friends, blocking and reporting (NOTES §51, migration 0026).
 *
 * The same shape as `src/data/community.ts`, and for the same reason:
 * **reads of other people come from a view; writes that need a rule go through
 * a function.** `my_friends` and `my_blocks` put a name beside my own rows;
 * `public_profiles` and `search_people` find people, minus anybody on either
 * side of a block. Asking, accepting, blocking and reporting are functions,
 * because none of the three new tables has an insert or update policy — the
 * checks a policy cannot express safely (a block in EITHER direction, a limit
 * per day, a copy of what was reported) live in the function, and there is no
 * other way in.
 *
 * The only direct writes are the ones anyone may do to their own rows: choosing
 * a username (profiles is update-own since 0002), ending a friendship or request
 * (either party, `friendships_delete_party`) and unblocking (`blocks_delete_own`).
 */

/**
 * Thrown when the database has not got 0026 yet.
 *
 * Same idea as `CommunityUnavailableError`: a screen has to tell "you have no
 * friends yet" apart from "this part of the app is not switched on yet", and a
 * missing table or function reports PGRST205 or PGRST202, which nobody could read.
 */
export class SocialUnavailableError extends Error {
  constructor() {
    super('Friends are not switched on yet.');
    this.name = 'SocialUnavailableError';
  }
}

/** A missing function is PGRST202 — PostgREST's answer, before Postgres sees it. */
function isMissingFunction(error: { code?: string | null } | null | undefined): boolean {
  return !!error && (error.code === 'PGRST202' || error.code === '42883');
}

function unavailable(error: { code?: string | null } | null | undefined): boolean {
  return isMissingTable(error) || isMissingColumn(error) || isMissingFunction(error);
}

async function currentUserId(db: Db = supabase): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

/** Somebody, as another person sees them: `public_profiles` (0026). */
export interface Person {
  id: string;
  display_name: string | null;
  username: string | null;
  avatar: string | null;
  /** Since 0033 (NOTES §59). Null when there is none, or before the migration. */
  bio?: string | null;
}

// -------------------------------------------------------------- usernames --

/**
 * My username, or null if I have not chosen one.
 *
 * Its own read rather than a column in `fetchProfile`, on purpose. `fetchProfile`
 * is read by grading, card-making and Nomi, and it steps back one migration at a
 * time when a column is missing (src/data/profile.ts). Adding `username` there
 * would make every one of them pay a retry until 0026 was applied, for a column
 * only the Profile tab needs.
 */
export async function fetchMyUsername(db: Db = supabase): Promise<string | null> {
  const { data, error } = await db.from('profiles').select('username').maybeSingle();
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) throw new Error(error.message);
  return ((data as { username?: string | null } | null)?.username ?? null) || null;
}

/** Bios arrive with 0033 (NOTES §59). */
export class BiosUnavailableError extends Error {
  constructor() {
    super("Bios aren't switched on yet.");
    this.name = 'BiosUnavailableError';
  }
}

/** My own bio, or null. Throws BiosUnavailableError before 0033. */
export async function fetchMyBio(db: Db = supabase): Promise<string | null> {
  const { data, error } = await db.from('profiles').select('bio').maybeSingle();
  if (isMissingColumn(error)) throw new BiosUnavailableError();
  if (error) throw new Error(error.message);
  return ((data as { bio?: string | null } | null)?.bio ?? null) || null;
}

/**
 * Write my bio, or clear it. The database checks the length again and — for a
 * bio that says something — asks the community rules first (0033's trigger),
 * so a refusal opens the rules sheet like any other social act.
 */
export async function saveBio(raw: string, db: Db = supabase): Promise<void> {
  const check = validateBio(raw);
  if (!check.ok) throw new Error(check.reason);
  const id = await currentUserId(db);
  const { error } = await db.from('profiles').update({ bio: check.bio }).eq('id', id);
  await throwIfGated(error, db);
  if (isMissingColumn(error)) throw new BiosUnavailableError();
  if (error?.code === '23514') throw new Error(`Keep your bio under ${BIO_MAX} characters.`);
  if (error) throw new Error(error.message);
}

/**
 * Who has this username — for a shared profile link, /u/<username>. Null for
 * nobody, and for somebody across a block: the same answer, as for their page.
 */
export async function personByUsername(raw: string, db: Db = supabase): Promise<string | null> {
  const username = raw.trim().replace(/^@+/, '').toLowerCase();
  if (!username) return null;
  const { data, error } = await db.from('public_profiles').select('id').eq('username', username).maybeSingle();
  if (unavailable(error)) return null;
  if (error) throw new Error(error.message);
  return ((data as { id?: string } | null)?.id ?? null) || null;
}

/**
 * Choose or change my username.
 *
 * Checked here first so a bad one costs no round trip and is refused in words;
 * the database checks again (`profiles_username_check`), and only it can say
 * whether a name is TAKEN — 23505 from the unique index.
 */
export async function saveUsername(raw: string, db: Db = supabase): Promise<string> {
  const check = validateUsername(raw);
  if (!check.ok) throw new Error(check.reason);

  const id = await currentUserId(db);
  const { error } = await db
    .from('profiles')
    .upsert({ id, username: check.username }, { onConflict: 'id' });

  if (unavailable(error)) throw new SocialUnavailableError();
  if (error?.code === '23505') throw new Error('That username is taken. Try another.');
  if (error?.code === '23514') throw new Error("That username won't work. Use letters, numbers and _.");
  if (error) throw new Error(error.message);
  return check.username;
}

// ----------------------------------------------------------------- people --

/**
 * People whose username starts with, or whose name contains, what was typed.
 *
 * Nothing is asked for under two characters — `searchTerm` returns null and so
 * does this, without a round trip. Anybody on either side of a block with me is
 * not found (0026's `public_profiles`), and neither am I.
 */
export async function searchPeople(raw: string, db: Db = supabase): Promise<Person[]> {
  const term = searchTerm(raw);
  if (term === null) return [];

  const { data, error } = await db.rpc('search_people', { p_query: term });
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? []) as Person[];
}

/**
 * One person, for their page — or null.
 *
 * Null for somebody who does not exist AND for somebody on the other side of a
 * block, deliberately the same answer: the app never tells anybody that they
 * were blocked. The one exception is a person I blocked, who `my_blocks` still
 * names so I can recognise them and unblock — `blocked: true` says which.
 */
export async function getPerson(
  id: string,
  db: Db = supabase,
): Promise<(Person & { blocked: boolean }) | null> {
  const ask = (columns: string) => db.from('public_profiles').select(columns).eq('id', id).maybeSingle();
  let { data, error } = await ask('id, display_name, username, avatar, bio');

  // Before 0033 there is no `bio` on the view (NOTES §59): the page as it was.
  if (isMissingColumn(error)) ({ data, error } = await ask('id, display_name, username, avatar'));

  // Before 0026 there is no `username` on the view. The page still works as a
  // page — a name and a picture — it just cannot offer to be friends.
  if (isMissingColumn(error)) {
    const older = await db.from('public_profiles').select('id, display_name, avatar').eq('id', id).maybeSingle();
    if (older.error) throw new Error(older.error.message);
    return older.data ? { ...(older.data as Omit<Person, 'username'>), username: null, blocked: false } : null;
  }
  if (error) throw new Error(error.message);
  if (data) return { ...(data as unknown as Person), blocked: false };

  const mine = await db
    .from('my_blocks')
    .select('person_id, name, username, avatar')
    .eq('person_id', id)
    .maybeSingle();
  if (mine.error || !mine.data) return null;
  const row = mine.data as { person_id: string; name: string | null; username: string | null; avatar: string | null };
  return { id: row.person_id, display_name: row.name, username: row.username, avatar: row.avatar, blocked: true };
}

// ---------------------------------------------------------------- friends --

/**
 * My friends and requests, both directions, each with the other person's name.
 *
 * Unordered: `splitFriends` in src/core/social.ts decides the three orders it is
 * read in, where they can be tested without a database.
 */
export async function listFriendLinks(db: Db = supabase): Promise<FriendLink[]> {
  const { data, error } = await db
    .from('my_friends')
    .select('id, person_id, name, username, avatar, status, sent_by_me, created_at, accepted_at');
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? []) as FriendLink[];
}

/**
 * Ask to be friends. 'friends' when they had already asked me, which the
 * database turns into a yes rather than a second request.
 */
export async function sendFriendRequest(personId: string, db: Db = supabase): Promise<'requested' | 'friends'> {
  const { data, error } = await db.rpc('send_friend_request', { p_to: personId });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) {
    if (error.code === 'P0001') throw new Error("That's a lot of friend requests for one day. Try again tomorrow.");
    if (error.code === 'P0002') throw new Error("That person isn't on Nomi any more.");
    // 42501 is a block, in either direction. Said without saying which.
    if (error.code === '42501') throw new Error("You can't add this person.");
    throw new Error(error.message);
  }
  return data === 'friends' ? 'friends' : 'requested';
}

export async function acceptFriendRequest(personId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('accept_friend_request', { p_from: personId });
  await throwIfGated(error, db);
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error?.code === 'P0002') throw new Error("That request isn't there any more.");
  if (error) throw new Error(error.message);
}

/**
 * Cancel a request I sent, decline one I got, or unfriend — all one delete of
 * the row that is about both of us. A declined request leaves no trace for
 * either person.
 */
export async function removeFriendLink(linkId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.from('friendships').delete().eq('id', linkId);
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------- blocking --

/** Someone I blocked, named — `my_blocks` (0026). */
export interface BlockedPerson {
  person_id: string;
  name: string | null;
  username: string | null;
  avatar: string | null;
  created_at: string;
}

export async function listBlocked(db: Db = supabase): Promise<BlockedPerson[]> {
  const { data, error } = await db.from('my_blocks').select('person_id, name, username, avatar, created_at');
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) throw new Error(error.message);
  return (data ?? []) as BlockedPerson[];
}

/**
 * Block somebody. Ends any friendship or request between us in the same
 * statement (`block_person`), so there is no moment where I have blocked a
 * person who is still my friend.
 */
export async function blockPerson(personId: string, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('block_person', { p_other: personId });
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) throw new Error(error.message);
}

export async function unblockPerson(personId: string, db: Db = supabase): Promise<void> {
  const me = await currentUserId(db);
  const { error } = await db.from('blocks').delete().eq('blocker_id', me).eq('blocked_id', personId);
  if (unavailable(error)) throw new SocialUnavailableError();
  if (error) throw new Error(error.message);
}

// -------------------------------------------------------------- reporting --

/**
 * Report a person, a message or a shared set.
 *
 * The copy of what was reported is taken by `report_content`, never sent from
 * here — the reporter must not be able to put words in somebody else's mouth.
 * Reporting the same thing twice while the first is open is not an error: the
 * database returns the first, and the person is thanked either way.
 */
export async function reportContent(
  kind: ReportKind,
  targetId: string,
  reason: ReportReason,
  details: string,
  db: Db = supabase,
): Promise<void> {
  const extra = details.trim().slice(0, REPORT_DETAILS_MAX);
  const { error } = await db.rpc('report_content', {
    p_kind: kind,
    p_target: targetId,
    p_reason: reason,
    p_details: extra.length > 0 ? extra : null,
  });
  if (unavailable(error)) throw new Error("Reporting isn't switched on yet.");
  if (error) {
    if (error.code === 'P0001') throw new Error("That's a lot of reports for one day. Try again tomorrow.");
    if (error.code === 'P0002') throw new Error("That isn't there any more.");
    throw new Error(error.message);
  }
}

// ---------------------------------------------------------- delete my data --

/**
 * What "Delete my data" removes of this: every friendship and request I am part
 * of, and my username.
 *
 * What it deliberately KEEPS, and the Privacy Policy says so:
 *
 *  - **The people I blocked.** Delete my data leaves the account, and whoever
 *    comes back to it must not find that everybody they blocked can reach them
 *    again. Unblocking is one tap on the Profile tab.
 *  - **Reports I made.** A report is kept until it has been dealt with; a person
 *    being harassed deleting their data must not take the evidence with them.
 *    `reports` has no delete policy for exactly this reason.
 */
export async function removeMySocialData(db: Db = supabase): Promise<void> {
  const me = await currentUserId(db);

  const { error } = await db.from('friendships').delete().or(`requester_id.eq.${me},addressee_id.eq.${me}`);
  if (error && !unavailable(error)) throw new Error(error.message);

  const cleared = await db.from('profiles').update({ username: null }).eq('id', me);
  if (cleared.error && !unavailable(cleared.error)) throw new Error(cleared.error.message);

  // The bio (0033, NOTES §59) — its own update, so a database without the
  // column still has the username cleared above.
  const bio = await db.from('profiles').update({ bio: null }).eq('id', me);
  if (bio.error && !unavailable(bio.error)) throw new Error(bio.error.message);
}
