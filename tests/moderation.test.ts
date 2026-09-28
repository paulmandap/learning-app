import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMMUNITY_RULES, isRestricted, restrictionLine, RULE_KEYS, ruleTitle } from '../src/core/rules';
import { PRIVACY_POLICY, TERMS_OF_USE } from '../src/core/legal';

/**
 * The community rules and moderation (NOTES §55, migration 0030).
 *
 * The test that matters most here is the first one: ten functions were
 * recreated with one line added, and a copy that drifted from the version it
 * replaced — a lost block check, a limit off by one — would pass every other
 * test in this file. So each is held to its previous version, line for line,
 * with only that line allowed to differ.
 */

const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const SQL = strip(readFileSync('supabase/migrations/0030_moderation_and_rules.sql', 'utf8'));

function fnIn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  expect(start, `no function named ${name}`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf('$$;', start));
}
const fn = (name: string) => fnIn(SQL, name);
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
const GATE = 'perform public.assert_can_socialize();';

const PREVIOUS: Record<string, string> = {
  send_global_message: '0021_community.sql',
  edit_global_message: '0025_subfolders_reactions_and_edits.sql',
  send_friend_request: '0026_friends_blocks_and_reports.sql',
  accept_friend_request: '0026_friends_blocks_and_reports.sql',
  create_post: '0027_posts_and_feed.sql',
  edit_post: '0027_posts_and_feed.sql',
  add_comment: '0027_posts_and_feed.sql',
  start_conversation: '0028_direct_messages.sql',
  send_direct_message: '0028_direct_messages.sql',
  edit_direct_message: '0028_direct_messages.sql',
};

describe('every way to reach another person asks the one question first', () => {
  for (const [name, file] of Object.entries(PREVIOUS)) {
    it(`${name}: its previous version (${file.slice(0, 4)}) plus the gate, and nothing else`, () => {
      const now = fn(name);
      expect(now, name).toContain(GATE);
      const before = fnIn(strip(readFileSync(`supabase/migrations/${file}`, 'utf8')), name);
      expect(norm(now.replace(GATE, ''))).toBe(norm(before));
    });
  }

  it('a set is asked before it is shared — on insert as well as update — but not for the owner in the editor', () => {
    const guard = fn('study_sets_share_guard');
    expect(guard).toContain("if new.visibility = 'public'");
    expect(guard).toContain("(tg_op = 'INSERT' or old.visibility is distinct from 'public')");
    expect(guard).toContain('perform public.assert_can_socialize();');
    expect(guard.indexOf('if (select auth.uid()) is null then')).toBeLessThan(guard.indexOf('perform'));
    expect(SQL).toContain('before insert or update of visibility on public.study_sets');
  });

  it('the question: the rules agreed to, and no restriction in force — each refused with its own code', () => {
    const gate = fn('assert_can_socialize');
    expect(gate).toContain('p.rules_accepted_at is not null');
    expect(gate).toContain("using errcode = 'RULES'");
    expect(gate).toContain('(r.until is null or r.until > now())');
    expect(gate).toContain("using errcode = 'RSTRC'");
  });

  it('reading an old conversation is not a social act; opening a new one is', () => {
    const start = fn('start_conversation');
    expect(start.indexOf('return found_id;')).toBeLessThan(start.indexOf(GATE));
  });
});

describe('the app hears both refusals from every social write', () => {
  const calls: Record<string, string[]> = {
    'src/data/community.ts': ["rpc('send_global_message'", "rpc('edit_global_message'", "from('study_sets').update(patch)"],
    'src/data/social.ts': ["rpc('send_friend_request'", "rpc('accept_friend_request'"],
    'src/data/posts.ts': ["rpc('create_post'", "rpc('edit_post'", "rpc('add_comment'"],
    'src/data/messages.ts': ["rpc('start_conversation'", "rpc('send_direct_message'", "rpc('edit_direct_message'"],
  };
  for (const [file, rpcs] of Object.entries(calls)) {
    it(file, () => {
      const src = readFileSync(file, 'utf8');
      for (const call of rpcs) {
        const at = src.indexOf(call);
        expect(at, call).toBeGreaterThan(-1);
        const next = src.indexOf('throw new', at);
        expect(src.slice(at, next), `${call} checks the gate before anything else`).toContain('throwIfGated(error, db)');
      }
    });
  }

  it('the rules refusal opens the sheet; the restriction says until when', () => {
    const gate = readFileSync('src/data/moderation.ts', 'utf8');
    expect(gate).toContain("if (error.code === 'RULES') {\n    useRulesPrompt.getState().show();");
    expect(gate).toContain("if (error.code === 'RSTRC') {");
    expect(restrictionLine(null)).toMatch(/can't post, comment, message, add friends or share sets\. You can still study/);
    expect(restrictionLine('2026-10-05T00:00:00Z', 'en-US')).toMatch(/until October [45]/);
  });
});

describe('the rules', () => {
  it('seven, and the keys a warning names are the database’s, in order', () => {
    expect(COMMUNITY_RULES).toHaveLength(7);
    const list = SQL.match(/check \(rule in \(([^)]*)\)\)/)?.[1] ?? '';
    expect([...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1])).toEqual([...RULE_KEYS]);
    expect(new Set(RULE_KEYS).size).toBe(RULE_KEYS.length);
    expect(ruleTitle('kind')).toBe('Be kind');
  });

  it('a restriction is in force until it runs out, and for ever when it has no end', () => {
    const now = Date.parse('2026-09-28T00:00:00Z');
    expect(isRestricted(null, now)).toBe(false);
    expect(isRestricted({ until: null }, now)).toBe(true);
    expect(isRestricted({ until: '2026-10-01T00:00:00Z' }, now)).toBe(true);
    expect(isRestricted({ until: '2026-09-27T00:00:00Z' }, now)).toBe(false);
  });
});

describe('who moderates, and what they can do', () => {
  it('nobody can add a moderator from the app; the owner is added by his sign-in email', () => {
    expect(SQL).not.toMatch(/create policy \w+ on public\.app_admins\s+for (insert|update|delete|all)/);
    expect(SQL).toContain("where lower(u.email) = 'paulmandap16@gmail.com'");
    expect(readFileSync('src/core/legal.ts', 'utf8')).toContain("CONTACT_EMAIL = 'paulmandap16@gmail.com'");
  });

  it('the queue is empty to anybody who is not one — filtered inside the view', () => {
    const start = SQL.indexOf('create view public.report_queue');
    const view = SQL.slice(start, SQL.indexOf(';', start));
    expect(view).toContain("where r.status = 'open'");
    expect(view).toContain('and public.is_admin()');
  });

  it('every moderator action checks first', () => {
    for (const name of ['resolve_reports', 'moderate_remove', 'restrict_account', 'lift_restriction', 'warn_account']) {
      expect(fn(name), name).toMatch(/(perform public\.assert_admin\(\)|me := public\.assert_admin\(\))/);
    }
  });

  it('a reported set is unshared, never deleted; a person has nothing to remove', () => {
    const remove = fn('moderate_remove');
    expect(remove).toContain("update public.study_sets set visibility = 'private' where id = p_target");
    expect(remove).not.toMatch(/delete from public\.study_sets/);
    expect(remove).toContain('There is nothing to remove for a person');
  });

  it('restrictions and warnings are read by their person and written by nobody but a moderator', () => {
    expect(SQL).not.toMatch(/create policy \w+ on public\.(restrictions|warnings)\s+for (insert|update|delete|all)/);
    expect(SQL).toContain('create policy restrictions_select_own on public.restrictions');
    expect(SQL).toContain('create policy warnings_select_own on public.warnings');
    expect(SQL).toContain('revoke all on function public.assert_can_socialize() from public, anon, authenticated');
    expect(SQL).toContain('revoke all on function public.assert_admin() from public, anon, authenticated');
  });
});

const text = (doc: typeof PRIVACY_POLICY) => doc.sections.flatMap((s) => s.body.flat()).join('\n');

describe('what the Privacy Policy and Terms say is what the app does', () => {
  it('warnings and restrictions are recorded, and Delete my data keeps them', () => {
    const privacy = text(PRIVACY_POLICY);
    expect(privacy).toMatch(/When you agreed to the community rules, and any warning or restriction on your account/);
    expect(privacy).toMatch(/any warning or restriction on your account stays, so deleting your data is not a way around one/);
    const deleteMine = readFileSync('src/data/sets.ts', 'utf8');
    expect(deleteMine).not.toMatch(/'(restrictions|warnings)'/);
  });

  it('the Terms bind the rules, agreed to in the app', () => {
    expect(text(TERMS_OF_USE)).toMatch(/you agree to follow the community rules — you agree to them in the app/);
  });
});

describe('on screen', () => {
  it('the rules sheet and a warning are mounted once, in the root, signed in only', () => {
    const layout = readFileSync('app/_layout.tsx', 'utf8');
    expect(layout).toContain('{signedIn ? <RulesSheet /> : null}');
    expect(layout).toContain('{signedIn ? <StandingNotice /> : null}');
    expect(layout).toContain("segment === 'rules'");
  });

  it('the Reports button is the moderator’s alone', () => {
    const profile = readFileSync('app/(tabs)/profile.tsx', 'utf8');
    expect(profile).toMatch(/\{moderator\.data \? \(\s*<Button/);
    expect(readFileSync('app/moderation.tsx', 'utf8')).toContain("This page is for Nomi's moderator.");
  });

  it('a report points at the rules', () => {
    expect(readFileSync('src/ui/people.tsx', 'utf8')).toContain("router.push('/rules')");
  });
});
