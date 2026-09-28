import { supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import { escapeLike } from '../core/profile';
import { searchTerm } from '../core/social';
import { POST_COLUMNS } from './posts';
import { PUBLIC_SET_COLUMNS } from './community';
import type { FeedPost } from '../core/posts';
import type { PublicSet } from '../core/community';

/**
 * Search, beyond people (NOTES §59): shared sets by their title, and posts by
 * their words — each read through the view that already decides who sees
 * what, so a search can only ever find what the reader could scroll to.
 * `public_sets` hides a set across a block; `feed_posts` is 0027's one rule
 * for who sees a post. Nothing new in the database, and nothing to leak.
 *
 * One filter each, never PostgREST's `or=(…)`: a term with a comma or a
 * bracket would be read as part of that syntax. And the LIKE wildcards in
 * the term are escaped, so "a_b" means a_b (the rule `search_people` keeps).
 */

/** How many of each a search shows. */
export const SEARCH_LIMIT = 10;

export async function searchSets(raw: string, db: Db = supabase): Promise<PublicSet[]> {
  const term = searchTerm(raw);
  if (term === null) return [];
  const { data, error } = await db
    .from('public_sets')
    .select(PUBLIC_SET_COLUMNS)
    .ilike('title', `%${escapeLike(term)}%`)
    .order('published_at', { ascending: false })
    .limit(SEARCH_LIMIT);
  if (isMissingTable(error) || isMissingColumn(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PublicSet[];
}

export async function searchPosts(raw: string, db: Db = supabase): Promise<FeedPost[]> {
  const term = searchTerm(raw);
  if (term === null) return [];
  const { data, error } = await db
    .from('feed_posts')
    .select(POST_COLUMNS)
    .ilike('body', `%${escapeLike(term)}%`)
    .order('created_at', { ascending: false })
    .limit(SEARCH_LIMIT);
  if (isMissingTable(error) || isMissingColumn(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as FeedPost[];
}
