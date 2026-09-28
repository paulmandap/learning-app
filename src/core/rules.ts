import { MINIMUM_AGE } from './legal';

/**
 * The community rules, and what a moderator can do about a broken one
 * (NOTES §55, migration 0030).
 *
 * Seven rules in plain words, agreed to once before somebody's first post,
 * message, friend request or shared set — and the database checks that they
 * were (`assert_can_socialize`), so it is not a screen that can be stepped
 * around. The keys are what a warning names: `warnings_rule_check` in 0030
 * lists the same seven, and `tests/moderation.test.ts` holds the two together.
 */

export interface CommunityRule {
  key: string;
  title: string;
  detail: string;
}

export const COMMUNITY_RULES: readonly CommunityRule[] = [
  {
    key: 'kind',
    title: 'Be kind',
    detail: 'No bullying, harassment, threats or hate — in posts, comments, messages or the chat.',
  },
  {
    key: 'clean',
    title: 'Keep it clean',
    detail: 'No sexual or violent content, in words or pictures.',
  },
  {
    key: 'private',
    title: "Keep other people's things private",
    detail: "Don't share anyone's personal information, or a photo of them, without their OK.",
  },
  {
    key: 'yourself',
    title: 'Be yourself',
    detail: "Don't pretend to be someone else, or make another account to reach someone who blocked you.",
  },
  {
    key: 'spam',
    title: 'No spam',
    detail: "Don't flood people with friend requests, messages, posts or ads.",
  },
  {
    key: 'yours',
    title: 'Share what is yours to share',
    detail: "Only share notes, sets and photos you have the right to — and don't use Nomi to cheat.",
  },
  {
    key: 'honest',
    title: 'Report honestly',
    detail: 'Report real problems, not people you disagree with.',
  },
];

/** The rule keys, in the order 0030's `warnings_rule_check` lists them. */
export const RULE_KEYS: readonly string[] = COMMUNITY_RULES.map((r) => r.key);

/** Said under the rules, before "I agree". */
export const RULES_CONSEQUENCES =
  `Nomi is for people ${MINIMUM_AGE} and older. If you break these rules, what you shared can be removed, you can be warned, or your account can be stopped from posting, messaging and adding friends for a while or for good.`;

export function ruleTitle(key: string): string {
  return COMMUNITY_RULES.find((r) => r.key === key)?.title ?? 'The community rules';
}

// -------------------------------------------------------- restrictions --

/** What a moderator can restrict an account for. `null` is for good. */
export const RESTRICT_OPTIONS: readonly { days: number | null; label: string }[] = [
  { days: 7, label: 'for 7 days' },
  { days: 30, label: 'for 30 days' },
  { days: null, label: 'for good' },
];

/**
 * What a restricted person is told when an action is refused: what they cannot
 * do, and until when, in their own time.
 */
export function restrictionLine(until: string | null, locale?: string): string {
  const what = "Your account can't post, comment, message, add friends or share sets";
  if (!until) return `${what}. You can still study as normal.`;
  const when = new Date(until).toLocaleDateString(locale, { month: 'long', day: 'numeric' });
  return `${what} until ${when}. You can still study as normal.`;
}

/** Is this restriction still in force? `until` null is for good. */
export function isRestricted(restriction: { until: string | null } | null, now: number): boolean {
  if (!restriction) return false;
  return restriction.until === null || Date.parse(restriction.until) > now;
}
