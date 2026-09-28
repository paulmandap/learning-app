-- A leaderboard among friends, by streak (NOTES §54).
--
-- Step four of five (§51). The owner chose the measure (2026-09-27): **longest
-- streak** — shown as the streak running now, with each person's best ever
-- beside it, so the list can still change and the person who started first is
-- not on top for ever.
--
-- ############################################################################
-- # THIS IS THE FIRST TIME ANYBODY ELSE SEES A STREAK.                       #
-- #                                                                          #
-- # §51's Privacy Policy promised a profile does not show your streak, and    #
-- # it still does not. This is somewhere else — your friends' Progress — and  #
-- # it is said so in the policy, with the way out: "Show my streak to         #
-- # friends" in Settings, on unless you turn it off. Off, you vanish from     #
-- # every friend's board and still see your own.                             #
-- #                                                                          #
-- # Friends only. Not everyone, not friends of friends — the same accepted    #
-- # friendship that lets you message somebody, and nothing across a block.   #
-- ############################################################################
--
-- Needs 0027 (`streak_of`). Additive: one column, two functions. Safe before or
-- after the code deploys.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Is 0027 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('public.streak_of(uuid)') is null
    or to_regclass('public.friendships') is null then
    raise exception 'Apply 0026 and 0027 first — this migration builds on them. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. "Show my streak to friends"
-- ---------------------------------------------------------------------------
-- On by default — a leaderboard nobody is on is not one — and a single tap off
-- in Settings. Every existing row gets the default; that is a real choice made
-- for them, and the Home card and the Privacy Policy both say where to change it.
alter table public.profiles
  add column if not exists show_streak boolean not null default true;

-- ---------------------------------------------------------------------------
-- 2. The best streak somebody has ever had
-- ---------------------------------------------------------------------------
-- The longest run of consecutive UTC days studied or forgiven — `studyStreak`'s
-- rule (src/core/progress.ts), over all of time rather than up to today. A run
-- made only of restores does not count: a restore forgives a missed day inside a
-- streak, it is not a streak by itself.
--
-- Gaps and islands: number the days in order; within an unbroken run, the day
-- minus its number is constant, so grouping by that is grouping by run.
--
-- Granted to nobody, like `streak_of`: it answers for any account. Only
-- `friends_leaderboard`, running as its owner, calls it.
create or replace function public.best_streak_of(p_user uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with days as (
    select d.day, true as studied from public.study_days d where d.user_id = p_user
    union all
    select r.restored_day, false from public.streak_restores r where r.user_id = p_user
  ),
  distinct_days as (
    select day, bool_or(studied) as studied from days group by day
  ),
  islands as (
    select studied, day - (row_number() over (order by day))::integer as run
    from distinct_days
  )
  select coalesce(max(n), 0)::integer
  from (
    select count(*) as n from islands group by run having bool_or(studied)
  ) runs;
$$;

-- ---------------------------------------------------------------------------
-- 3. The leaderboard
-- ---------------------------------------------------------------------------
-- The caller, and each accepted friend who shows their streak, with the streak
-- running now and the best ever. The caller is always on their own board,
-- whatever they chose — hiding yourself from your friends is not hiding yourself
-- from yourself.
--
-- A function rather than a view: it has to call `streak_of` and
-- `best_streak_of`, which nobody may call directly, and a view's functions are
-- checked against whoever reads the view. A SECURITY DEFINER function runs as
-- its owner all the way down.
--
-- Unordered: `rankLeaderboard` in src/core/leaderboard.ts decides the order and
-- the ranks, where they can be tested.
create or replace function public.friends_leaderboard()
returns table (
  person_id      uuid,
  name           text,
  username       text,
  avatar         text,
  current_streak integer,
  best_streak    integer,
  is_me          boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  return query
  select
    p.id,
    p.display_name,
    p.username,
    p.avatar,
    public.streak_of(p.id),
    public.best_streak_of(p.id),
    p.id = me
  from public.profiles p
  where p.id = me
     or (
       p.show_streak
       and exists (
         select 1 from public.friendships f
         where f.status = 'accepted'
           and least(f.requester_id, f.addressee_id) = least(me, p.id)
           and greatest(f.requester_id, f.addressee_id) = greatest(me, p.id)
       )
       and not exists (
         select 1 from public.blocks b
         where (b.blocker_id = me and b.blocked_id = p.id)
            or (b.blocker_id = p.id and b.blocked_id = me)
       )
     );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Who may call what
-- ---------------------------------------------------------------------------
revoke all on function public.best_streak_of(uuid) from public, anon, authenticated;
revoke all on function public.friends_leaderboard() from public, anon;
grant execute on function public.friends_leaderboard() to authenticated;
