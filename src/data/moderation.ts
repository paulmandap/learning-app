import { create } from 'zustand';
import { supabase, type Db } from './supabase';
import { isMissingColumn, isMissingTable } from '../core/db-errors';
import { restrictionLine } from '../core/rules';

/**
 * The community rules and moderation (NOTES §55, migration 0030).
 *
 * Two halves. Everybody: agreeing to the rules, and being told — when a social
 * act is refused — whether it was the rules or a restriction. The moderator
 * alone: the report queue, and removing, dismissing, warning and restricting.
 * Both halves are enforced in the database; nothing here decides who may.
 */

function missingFunction(error: { code?: string | null } | null | undefined): boolean {
  return !!error && (error.code === 'PGRST202' || error.code === '42883');
}

function unavailable(error: { code?: string | null } | null | undefined): boolean {
  return isMissingTable(error) || isMissingColumn(error) || missingFunction(error);
}

async function currentUserId(db: Db = supabase): Promise<string> {
  const { data, error } = await db.auth.getUser();
  if (error) throw new Error(error.message);
  const id = data.user?.id;
  if (!id) throw new Error('Not signed in.');
  return id;
}

// ------------------------------------------------------------ the gate --

/**
 * Whether the rules sheet is open. One flag for the whole app: any social act
 * the database refuses with 'RULES' opens the same sheet, from the root layout,
 * wherever the act was — a post, a message, a friend request, a shared set.
 */
export const useRulesPrompt = create<{ open: boolean; show: () => void; hide: () => void }>((set) => ({
  open: false,
  show: () => set({ open: true }),
  hide: () => set({ open: false }),
}));

/** The rules have not been agreed to. The sheet is already on its way. */
export class RulesRequiredError extends Error {
  constructor() {
    super('Agree to the community rules first, then try again.');
    this.name = 'RulesRequiredError';
  }
}

/** This account is restricted. The message says until when. */
export class RestrictedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestrictedError';
  }
}

/**
 * Turn the two refusals every social act can meet into words — and, for the
 * rules, into the sheet that fixes it. Called first in each data function's
 * error handling (src/data/community.ts, social.ts, posts.ts, messages.ts), so
 * one refusal reads the same everywhere. Returns quietly for anything else.
 */
export async function throwIfGated(error: { code?: string | null } | null | undefined, db: Db = supabase): Promise<void> {
  if (!error) return;
  if (error.code === 'RULES') {
    useRulesPrompt.getState().show();
    throw new RulesRequiredError();
  }
  if (error.code === 'RSTRC') {
    const standing = await myStanding(db).catch(() => null);
    throw new RestrictedError(restrictionLine(standing?.restriction?.until ?? null));
  }
}

export async function acceptCommunityRules(db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('accept_community_rules');
  if (error) throw new Error(error.message);
}

// ------------------------------------------------------------ standing --

export interface Warning {
  id: string;
  rule: string;
  note: string | null;
  created_at: string;
  seen_at: string | null;
}

/**
 * My restriction, if any, and the warnings I have not seen. Null before 0030 —
 * there is nothing to stand on yet.
 */
export async function myStanding(
  db: Db = supabase,
): Promise<{ restriction: { until: string | null; reason: string | null } | null; warnings: Warning[] } | null> {
  const restriction = await db.from('restrictions').select('until, reason').maybeSingle();
  if (unavailable(restriction.error)) return null;
  if (restriction.error) throw new Error(restriction.error.message);
  const warnings = await db
    .from('warnings')
    .select('id, rule, note, created_at, seen_at')
    .is('seen_at', null)
    .order('created_at', { ascending: true });
  if (warnings.error) throw new Error(warnings.error.message);
  return {
    restriction: (restriction.data as { until: string | null; reason: string | null } | null) ?? null,
    warnings: (warnings.data ?? []) as Warning[],
  };
}

export async function acknowledgeWarning(id: string, db: Db = supabase): Promise<void> {
  const { error } = await db.rpc('acknowledge_warning', { p_id: id });
  if (error && !unavailable(error)) throw new Error(error.message);
}

// ----------------------------------------------------------- moderator --

/** Am I a moderator? False before 0030, and for everybody but the owner. */
export async function isModerator(db: Db = supabase): Promise<boolean> {
  const me = await currentUserId(db).catch(() => null);
  if (!me) return false;
  const { data, error } = await db.from('app_admins').select('user_id').eq('user_id', me).maybeSingle();
  if (error) return false;
  return !!data;
}

/** A row of `report_queue` (0030). */
export interface QueuedReport {
  id: string;
  target_kind: 'person' | 'message' | 'set' | 'post' | 'comment' | 'direct_message' | 'group_message';
  target_id: string;
  reason: string;
  details: string | null;
  snapshot: string | null;
  created_at: string;
  reporter_id: string | null;
  reporter_name: string | null;
  reporter_username: string | null;
  reported_user_id: string | null;
  reported_name: string | null;
  reported_username: string | null;
  reported_avatar: string | null;
  same_target: number;
  restricted_until: string | null;
  restricted_for_good: boolean;
}

/** Every open report — empty for anybody who is not a moderator, by the view's own filter. */
export async function listReportQueue(db: Db = supabase): Promise<QueuedReport[]> {
  const { data, error } = await db
    .from('report_queue')
    .select(
      'id, target_kind, target_id, reason, details, snapshot, created_at, reporter_id, reporter_name, reporter_username, reported_user_id, reported_name, reported_username, reported_avatar, same_target, restricted_until, restricted_for_good',
    )
    .order('created_at', { ascending: false });
  if (unavailable(error)) return [];
  if (error) throw new Error(error.message);
  return (data ?? []) as QueuedReport[];
}

async function call(fn: string, args: Record<string, unknown>, db: Db): Promise<void> {
  const { error } = await db.rpc(fn, args);
  if (error?.code === '42501') throw new Error('Only a moderator can do that.');
  if (error) throw new Error(error.message);
}

export const dismissReports = (kind: string, target: string, db: Db = supabase) =>
  call('resolve_reports', { p_kind: kind, p_target: target, p_status: 'dismissed' }, db);

export const markReportsActioned = (kind: string, target: string, db: Db = supabase) =>
  call('resolve_reports', { p_kind: kind, p_target: target, p_status: 'actioned' }, db);

export const removeReported = (kind: string, target: string, db: Db = supabase) =>
  call('moderate_remove', { p_kind: kind, p_target: target }, db);

export const restrictAccount = (user: string, days: number | null, reason: string, db: Db = supabase) =>
  call('restrict_account', { p_user: user, p_days: days, p_reason: reason }, db);

export const liftRestriction = (user: string, db: Db = supabase) => call('lift_restriction', { p_user: user }, db);

export const warnAccount = (user: string, rule: string, note: string, db: Db = supabase) =>
  call('warn_account', { p_user: user, p_rule: rule, p_note: note }, db);
