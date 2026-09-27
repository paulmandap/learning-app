-- Usernames, friends, blocking and reporting (NOTES §51).
--
-- The owner: *"i think this app can have it's own social. sort of add friends,
-- there is a leaderboard among friends or ranking. being able to DM to a
-- friend."* — and, asked whether it was for the five people using it now:
-- *"it must be able to scale just in case a friend shares this to another
-- friend."*
--
-- Step one of five. What is here is what has to exist BEFORE anybody can be
-- reached by a stranger: a name people can find you by, friends, and the two
-- ways to stop somebody — blocking them and reporting them. Posts, messages
-- between friends and the friends' leaderboard come later and build on it.
--
-- ############################################################################
-- # APPLY 0025 FIRST. This file recreates `global_chat` with 0025's           #
-- # `edited_at` and `message_reaction_people`, which 0025 creates. Section 0  #
-- # refuses to run without them and says so, before anything is changed.    #
-- ############################################################################
--
-- ############################################################################
-- # THE RULES FROM 0021 STILL HOLD. READ ITS HEADER BEFORE CHANGING ANYTHING. #
-- #                                                                          #
-- # 1. NO POLICY ON AN EXISTING BASE TABLE IS RELAXED. `profiles` gains a    #
-- #    column and keeps select-own exactly as 0002 wrote it.                  #
-- #                                                                          #
-- # 2. CROSS-USER READS HAPPEN THROUGH VIEWS THAT RUN AS THEIR OWNER. Two    #
-- #    new ones (`my_friends`, `my_blocks`), each filtered to the caller's    #
-- #    own rows, and six recreated with one change: a block hides both       #
-- #    people from each other in every one of them.                          #
-- #                                                                          #
-- # 3. WRITES THAT NEED A RULE GO THROUGH A FUNCTION, NOT A POLICY. A friend  #
-- #    request, accepting one, blocking and reporting are all functions,     #
-- #    because each has to check something a policy cannot express safely —  #
-- #    a block in EITHER direction, a limit per day, a copy of what was       #
-- #    reported that the reporter must not be able to write themselves.      #
-- #    None of the three new tables has an insert or update policy at all.   #
-- #    The functions write as `postgres`, which holds BYPASSRLS (measured,    #
-- #    NOTES §46.7) — the same thing every view here already relies on, and   #
-- #    the same way 0025's `edit_global_message` updates a table with no      #
-- #    update policy. scripts/isolation-test.ts asserts both halves: the      #
-- #    function works, and the direct write is refused.                       #
-- ############################################################################
--
-- Additive in effect: the six views are dropped and recreated in this same
-- file, every column they had before kept in the same order. Safe to apply
-- before or after the code deploys — an older build names only columns that
-- still exist, and simply never offers a friend.
--
-- CREATE THIS AS `postgres`. Pasting it into the dashboard SQL editor does that.
-- Creating the views as any other role silently changes who they run as.

-- ---------------------------------------------------------------------------
-- 0. Is 0025 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'global_messages' and column_name = 'edited_at'
  ) or to_regclass('public.message_reactions') is null
    or to_regclass('public.hidden_messages') is null then
    raise exception 'Apply 0024 and 0025 first — this migration builds on both. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. A username
-- ---------------------------------------------------------------------------
-- How people find each other. A display name is not enough for that on an app
-- anybody can join: two people called Maria are two people, and "add Maria" has
-- to mean one of them.
--
-- Stored lowercase with no @, so "@Paul_M" and "paul_m" are one username and can
-- never be two people. NULL means "has not chosen one" — deliberately NOT
-- backfilled from display names, because a username is how somebody is found
-- and nobody should be findable by a name they did not pick. The app offers a
-- suggestion; it never saves one on anybody's behalf.
alter table public.profiles
  add column if not exists username text;

-- 3 to 20 characters, lowercase letters, numbers and _, starting with a letter,
-- and not one of the names that would read as the app itself.
-- src/core/social.ts mirrors all of it (USERNAME_MIN, USERNAME_MAX,
-- RESERVED_USERNAMES), and tests/social.test.ts holds the two together.
--
-- Named, so a later migration can find it by name rather than guessing one
-- (HANDOFF: a `drop constraint if exists <guessed name>` is a silent no-op).
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_username_check'
  ) then
    alter table public.profiles
      add constraint profiles_username_check
      check (
        username ~ '^[a-z][a-z0-9_]{2,19}$'
        and username not in (
          'nomi', 'admin', 'administrator', 'moderator', 'mod', 'staff', 'support', 'help',
          'official', 'system', 'root', 'owner', 'team', 'everyone', 'null', 'undefined'
        )
      );
  end if;
end $$;

-- One person per username. An INDEX rather than a table constraint so it can be
-- partial; the column is already lowercase by the check above, so no expression
-- is needed (and HANDOFF records that an expression needs an index anyway).
-- Taken answers 23505, which the data layer turns into "That username is taken."
create unique index if not exists profiles_username_key
  on public.profiles (username)
  where username is not null;

-- For "starts with", which is how a username is searched. `text_pattern_ops`
-- because the database's collation is not C, and without it a LIKE 'abc%' cannot
-- use the unique index above.
create index if not exists profiles_username_prefix_idx
  on public.profiles (username text_pattern_ops)
  where username is not null;

-- ---------------------------------------------------------------------------
-- 2. Blocks
-- ---------------------------------------------------------------------------
-- Created before friendships, because everything after this reads it.
--
-- One direction per row: I blocked you. The EFFECT is both ways — every view in
-- section 5 hides the two people from each other whichever of them did it — but
-- the row is the blocker's, and only they can see it or take it back.
create table if not exists public.blocks (
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint blocks_not_self check (blocker_id <> blocked_id)
);

-- The primary key serves "did I block them"; this serves "did they block me",
-- which is the other half of every filter in section 5.
create index if not exists blocks_blocked_idx on public.blocks (blocked_id, blocker_id);

alter table public.blocks enable row level security;
alter table public.blocks force row level security;

-- Your own blocks and nobody else's. The person you blocked cannot list who
-- blocked them — the views stop showing you, and that is all they learn.
drop policy if exists blocks_select_own on public.blocks;
create policy blocks_select_own on public.blocks
  for select using (blocker_id = (select auth.uid()));

-- Unblocking is a plain delete of your own row. Blocking is NOT a plain insert:
-- it has to end a friendship in the same breath, which is `block_person` below,
-- and there is no insert policy so there is no other way in.
drop policy if exists blocks_delete_own on public.blocks;
create policy blocks_delete_own on public.blocks
  for delete using (blocker_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Friends
-- ---------------------------------------------------------------------------
-- The owner chose MUTUAL friends over following (2026-09-27): a request, and a
-- yes. It is what makes "friends only" mean something — nobody can make
-- themselves your friend — and it is what the next steps rest on: messages
-- between friends only, and a leaderboard among them.
--
-- One row per PAIR, whichever of them asked. 'pending' is a request; 'accepted'
-- is a friendship. Declining, cancelling and unfriending are all a delete — a
-- declined request leaves no trace for either person, which is the kind thing.
create table if not exists public.friendships (
  id           uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users (id) on delete cascade,
  addressee_id uuid not null references auth.users (id) on delete cascade,
  status       text not null default 'pending',
  created_at   timestamptz not null default now(),
  accepted_at  timestamptz,
  constraint friendships_not_self check (requester_id <> addressee_id),
  constraint friendships_status_check check (status in ('pending', 'accepted'))
);

-- One row per pair, IN EITHER ORDER. Without this, A asking B and B asking A
-- would be two rows and two half-friendships. An expression, so an index
-- (HANDOFF: inside `create table` it is a syntax error).
create unique index if not exists friendships_pair_key
  on public.friendships (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create index if not exists friendships_addressee_idx on public.friendships (addressee_id);
create index if not exists friendships_requester_idx on public.friendships (requester_id, created_at desc);

alter table public.friendships enable row level security;
alter table public.friendships force row level security;

-- Both people can see the row that is about both of them. There is nothing
-- private in it — two ids, a status, two dates — and a DELETE needs it visible
-- to find the row at all. Names and pictures come through `my_friends` below.
drop policy if exists friendships_select_party on public.friendships;
create policy friendships_select_party on public.friendships
  for select using ((select auth.uid()) in (requester_id, addressee_id));

-- Either of them can end it: cancel a request you sent, decline one you got,
-- or unfriend. No insert and no update policy: asking and accepting are the
-- two functions below.
drop policy if exists friendships_delete_party on public.friendships;
create policy friendships_delete_party on public.friendships
  for delete using ((select auth.uid()) in (requester_id, addressee_id));

-- Ask to be friends. Returns 'requested', or 'friends' when they had already
-- asked you — asking back IS saying yes, and making somebody accept a request
-- from a person who has just sent them one would be a chore with no purpose.
--
-- Refused when either of you has blocked the other, and after fifty requests in
-- a day (FRIEND_REQUESTS_PER_DAY in src/core/social.ts): more new friends than
-- anybody makes in a day, and far too few to request the whole app.
create or replace function public.send_friend_request(p_to uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me   uuid := (select auth.uid());
  link public.friendships;
  sent integer;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if p_to is null or p_to = me then
    raise exception 'You cannot add yourself.' using errcode = '22023';
  end if;

  if exists (
    select 1 from public.blocks b
    where (b.blocker_id = me and b.blocked_id = p_to)
       or (b.blocker_id = p_to and b.blocked_id = me)
  ) then
    raise exception 'You cannot add this person.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p where p.id = p_to) then
    raise exception 'That person is not here.' using errcode = 'P0002';
  end if;

  select * into link
  from public.friendships f
  where least(f.requester_id, f.addressee_id) = least(me, p_to)
    and greatest(f.requester_id, f.addressee_id) = greatest(me, p_to);

  if found then
    if link.status = 'accepted' then
      return 'friends';
    end if;
    if link.requester_id = me then
      return 'requested';
    end if;
    update public.friendships
      set status = 'accepted', accepted_at = now()
      where id = link.id;
    return 'friends';
  end if;

  select count(*) into sent
  from public.friendships f
  where f.requester_id = me
    and f.created_at > now() - interval '1 day';

  if sent >= 50 then
    raise exception 'Too many friend requests today.' using errcode = 'P0001';
  end if;

  insert into public.friendships (requester_id, addressee_id) values (me, p_to);
  return 'requested';
exception
  -- Both asked in the same instant: the pair index let one row in and refused
  -- the other. Asking again finds that row and says yes to it.
  when unique_violation then
    return public.send_friend_request(p_to);
end;
$$;

-- Say yes to a request somebody sent you. Only the person it was sent to can.
create or replace function public.accept_friend_request(p_from uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  update public.friendships
    set status = 'accepted', accepted_at = now()
    where requester_id = p_from
      and addressee_id = me
      and status = 'pending';

  if not found then
    raise exception 'That request is gone.' using errcode = 'P0002';
  end if;
end;
$$;

-- Block somebody, and end any friendship or request between you in the same
-- statement. Two separate writes from the app would leave a window — and a run
-- that failed half way — where you had blocked a person who was still your
-- friend.
create or replace function public.block_person(p_other uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if p_other is null or p_other = me then
    raise exception 'You cannot block yourself.' using errcode = '22023';
  end if;

  delete from public.friendships f
  where (f.requester_id = me and f.addressee_id = p_other)
     or (f.requester_id = p_other and f.addressee_id = me);

  insert into public.blocks (blocker_id, blocked_id)
  values (me, p_other)
  on conflict do nothing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reports
-- ---------------------------------------------------------------------------
-- Somewhere for "this is not OK" to go, and somebody to read it: the operator,
-- in the dashboard for now, and in the app in step five.
--
-- It also closes the gap NOTES §46.5 left open: a wrong card in a shared set
-- had no way to be flagged, and D7 says a report IS the second check on a card.
-- A shared set can now be reported as "Wrong or misleading cards".
--
-- ## Why a copy of what was reported is kept
--
-- A message can be unsent and a set unshared in seconds. A report that points
-- at something already gone is a report nobody can act on, which is exactly the
-- report a person who harasses somebody and then deletes it would want. So
-- `report_content` keeps a copy — the message, the set's title, the person's
-- name and username — taken by the function as it was at that moment, never
-- written by the reporter, who could otherwise put anything in somebody else's
-- mouth. The Privacy Policy says so.
--
-- ## Who a report belongs to after an account goes
--
-- `on delete set null` on both people: a report outlives the account of the
-- person who made it and of the person it is about, with the name taken off.
-- Deleting your account must not be a way to make the reports about you vanish,
-- and a victim leaving must not take the evidence with them.
create table if not exists public.reports (
  id               uuid primary key default gen_random_uuid(),
  reporter_id      uuid references auth.users (id) on delete set null,
  target_kind      text not null,
  target_id        uuid not null,
  reported_user_id uuid references auth.users (id) on delete set null,
  reason           text not null,
  details          text,
  snapshot         text,
  status           text not null default 'open',
  created_at       timestamptz not null default now(),
  constraint reports_kind_check check (target_kind in ('person', 'message', 'set')),
  constraint reports_reason_check check (
    reason in ('spam', 'harassment', 'hate', 'sexual', 'personal_info', 'impersonation', 'wrong', 'other')
  ),
  constraint reports_details_check check (details is null or length(details) <= 500),
  constraint reports_status_check check (status in ('open', 'dismissed', 'actioned'))
);

create index if not exists reports_open_idx on public.reports (created_at desc) where status = 'open';
create index if not exists reports_reporter_idx on public.reports (reporter_id, created_at desc);

alter table public.reports enable row level security;
alter table public.reports force row level security;

-- You can see what you reported. Nobody can see what anybody else reported, and
-- in particular the person reported cannot find out who did it.
--
-- No insert policy: reporting is `report_content`, which takes the copy. No
-- delete policy: a report is kept until it has been dealt with, and "Delete my
-- data" says so rather than promising otherwise.
drop policy if exists reports_select_own on public.reports;
create policy reports_select_own on public.reports
  for select using (reporter_id = (select auth.uid()));

-- Report a person, a message or a shared set. Returns the report's id.
--
-- Only what the reporter could see: a PRIVATE set answers "That is gone", the
-- same as one that does not exist, so this cannot be used to find out which set
-- ids are real (the same rule as `readableSet`). Your own things are refused.
-- Reporting the same thing twice while the first is still open returns the
-- first rather than making a second. Twenty a day (REPORTS_PER_DAY).
create or replace function public.report_content(
  p_kind    text,
  p_target  uuid,
  p_reason  text,
  p_details text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  owner_id uuid;
  snapshot_text text;
  existing uuid;
  sent     integer;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if p_kind = 'person' then
    select p.id, concat_ws(' ', p.display_name, '@' || p.username)
      into owner_id, snapshot_text
      from public.profiles p
      where p.id = p_target;
  elsif p_kind = 'message' then
    select m.user_id, m.body
      into owner_id, snapshot_text
      from public.global_messages m
      where m.id = p_target;
  elsif p_kind = 'set' then
    select s.user_id, s.title
      into owner_id, snapshot_text
      from public.study_sets s
      where s.id = p_target
        and s.visibility = 'public';
  else
    raise exception 'That cannot be reported.' using errcode = '22023';
  end if;

  if owner_id is null then
    raise exception 'That is gone.' using errcode = 'P0002';
  end if;

  if owner_id = me then
    raise exception 'That is yours.' using errcode = '22023';
  end if;

  select r.id into existing
  from public.reports r
  where r.reporter_id = me
    and r.target_kind = p_kind
    and r.target_id = p_target
    and r.status = 'open'
  limit 1;

  if existing is not null then
    return existing;
  end if;

  select count(*) into sent
  from public.reports r
  where r.reporter_id = me
    and r.created_at > now() - interval '1 day';

  if sent >= 20 then
    raise exception 'Too many reports today.' using errcode = 'P0001';
  end if;

  insert into public.reports (reporter_id, target_kind, target_id, reported_user_id, reason, details, snapshot)
  values (
    me,
    p_kind,
    p_target,
    owner_id,
    p_reason,
    nullif(btrim(coalesce(p_details, '')), ''),
    left(snapshot_text, 2000)
  )
  returning id into existing;

  return existing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Every view that shows one person to another, now minus anybody blocked
-- ---------------------------------------------------------------------------
-- A block has to hide the two people from each other EVERYWHERE, or it is a
-- block with holes in it — and each hole is somewhere a person who was blocked
-- for harassing somebody can still reach them. So all six views that show one
-- account to another gain the same clause, for the person each row is about:
--
--     and not exists (
--       select 1 from public.blocks b
--       where (b.blocker_id = (select auth.uid()) and b.blocked_id = <them>)
--          or (b.blocker_id = <them> and b.blocked_id = (select auth.uid()))
--     )
--
-- Written out in each view rather than called as a function: a SECURITY DEFINER
-- function cannot be inlined, so it would run once per row, and these views run
-- as their owner already and can read `blocks` directly.
--
-- Otherwise every view is column for column what it was — 0023 for the first
-- two, 0021 for the cards and the schedule, 0025 for the chat and reactions —
-- spelled out in full rather than patched, so a `create or replace` that
-- disagreed about any other column cannot quietly change what is published.
-- `public_profiles` also gains `username`, at the end. tests/social.test.ts
-- holds every one of them to the guarantees tests/community.test.ts holds 0021 to.

-- --------------------------------------------------------- public_profiles --
drop view if exists public.public_profiles;
create view public.public_profiles
  with (security_barrier = true)
as
select
  p.id,
  p.display_name,
  p.avatar,
  p.username
from public.profiles p
where not exists (
  select 1 from public.blocks b
  where (b.blocker_id = (select auth.uid()) and b.blocked_id = p.id)
     or (b.blocker_id = p.id and b.blocked_id = (select auth.uid()))
);

-- ------------------------------------------------------------- public_sets --
drop view if exists public.public_sets;
create view public.public_sets
  with (security_barrier = true)
as
select
  s.id,
  s.user_id            as owner_id,
  p.display_name       as owner_name,
  p.avatar             as owner_avatar,
  s.title,
  s.published_at,
  s.updated_at,
  (select count(*) from public.set_stars st where st.study_set_id = s.id)      as stars,
  (select count(*) from public.study_items i
     where i.study_set_id = s.id and i.hidden = false)                          as cards
from public.study_sets s
left join public.profiles p on p.id = s.user_id
where s.visibility = 'public'
  and s.status = 'ready'
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = s.user_id)
       or (b.blocker_id = s.user_id and b.blocked_id = (select auth.uid()))
  );

-- -------------------------------------------------------- public_set_items --
drop view if exists public.public_set_items;
create view public.public_set_items
  with (security_barrier = true)
as
select
  i.id,
  i.study_set_id,
  i.page_index,
  i.section_title,
  i.kind,
  i.level,
  i.prompt,
  i.answer,
  i.options,
  i.rubric,
  i.source_excerpt,
  i.check_flag,
  i.topic,
  i.created_at
from public.study_items i
join public.study_sets s on s.id = i.study_set_id
where s.visibility = 'public'
  and i.hidden = false
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = s.user_id)
       or (b.blocker_id = s.user_id and b.blocked_id = (select auth.uid()))
  );

-- -------------------------------------------------------------- global_chat --
drop view if exists public.global_chat;
create view public.global_chat
  with (security_barrier = true)
as
select
  m.id,
  m.user_id            as author_id,
  p.display_name       as author_name,
  p.avatar             as author_avatar,
  m.body,
  m.created_at,
  m.edited_at
from public.global_messages m
left join public.profiles p on p.id = m.user_id
where not exists (
  select 1 from public.hidden_messages h
  where h.message_id = m.id and h.user_id = (select auth.uid())
)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = m.user_id)
       or (b.blocker_id = m.user_id and b.blocked_id = (select auth.uid()))
  );

-- ------------------------------------------------- message_reaction_people --
drop view if exists public.message_reaction_people;
create view public.message_reaction_people
  with (security_barrier = true)
as
select
  r.message_id,
  r.user_id,
  p.display_name as name,
  p.avatar,
  r.emoji,
  r.created_at
from public.message_reactions r
left join public.profiles p on p.id = r.user_id
where not exists (
  select 1 from public.blocks b
  where (b.blocker_id = (select auth.uid()) and b.blocked_id = r.user_id)
     or (b.blocker_id = r.user_id and b.blocked_id = (select auth.uid()))
);

-- ------------------------------------------------------------ my_schedule --
-- Still only ever MY schedule. What changes is the same thing as everywhere
-- else: a shared card from somebody on either side of a block drops out, because
-- `public_sets` no longer lets you open that set. Leaving it here would be the
-- due badge promising cards the deck then refuses — NOTES §21 and §36, again.
drop view if exists public.my_schedule;
create view public.my_schedule
  with (security_barrier = true)
as
select
  r.study_item_id,
  r.study_set_id,
  r.due_at,
  i.level,
  (i.user_id = r.user_id) as owned
from public.review_state r
join public.study_items i on i.id = r.study_item_id
join public.study_sets s on s.id = i.study_set_id
where r.user_id = (select auth.uid())
  and i.hidden = false
  and (
    i.user_id = (select auth.uid())
    or (
      s.visibility = 'public'
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = (select auth.uid()) and b.blocked_id = i.user_id)
           or (b.blocker_id = i.user_id and b.blocked_id = (select auth.uid()))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 6. Two new views: my friends, and the people I blocked
-- ---------------------------------------------------------------------------
-- Both exist for the reason `global_chat` does: the app cannot read `profiles`
-- across accounts, so without a view every friend would be a bare id.

-- --------------------------------------------------------------- my_friends --
-- My friendships and requests, each with the OTHER person's name, username and
-- picture. `where` keeps it to rows I am part of, so the view's privilege is only
-- ever used to look up the name beside my own rows — the same shape as
-- `my_schedule`. A block deletes the friendship (`block_person`), so a blocked
-- person is never here.
drop view if exists public.my_friends;
create view public.my_friends
  with (security_barrier = true)
as
select
  f.id,
  o.other_id                                as person_id,
  p.display_name                            as name,
  p.username,
  p.avatar,
  f.status,
  (f.requester_id = (select auth.uid()))   as sent_by_me,
  f.created_at,
  f.accepted_at
from public.friendships f
cross join lateral (
  select case
    when f.requester_id = (select auth.uid()) then f.addressee_id
    else f.requester_id
  end as other_id
) o
left join public.profiles p on p.id = o.other_id
where (select auth.uid()) in (f.requester_id, f.addressee_id);

-- ---------------------------------------------------------------- my_blocks --
-- The people I blocked, by name, so I can recognise them to unblock. They are
-- gone from `public_profiles` for me — that is what blocking does — so without
-- this the list would be ids nobody could put a face to.
drop view if exists public.my_blocks;
create view public.my_blocks
  with (security_barrier = true)
as
select
  b.blocked_id   as person_id,
  p.display_name as name,
  p.username,
  p.avatar,
  b.created_at
from public.blocks b
left join public.profiles p on p.id = b.blocked_id
where b.blocker_id = (select auth.uid());

-- ---------------------------------------------------------------------------
-- 7. Finding people
-- ---------------------------------------------------------------------------
-- By username (starts with) or by name (contains), for the Profile tab's search.
--
-- A function rather than a PostgREST filter built in the app: a name can hold
-- commas, brackets and quotes, which are the characters PostgREST's `or=(…)`
-- syntax is made of, and escaping them in a URL is how a search box becomes a
-- way to write filters. Here the term is a parameter, and the LIKE wildcards in
-- it are escaped so "a_b" means "a_b".
--
-- SECURITY INVOKER (the default): it reads `public_profiles` as the caller, so
-- the block filter above applies and a person who blocked you is not found.
-- Two characters at least (SEARCH_MIN); twenty results at most.
create or replace function public.search_people(p_query text)
returns table (id uuid, display_name text, username text, avatar text)
language sql
stable
set search_path = public, pg_temp
as $$
  with q as (
    select lower(btrim(regexp_replace(coalesce(p_query, ''), '^\s*@+', ''))) as term
  ),
  pattern as (
    select
      q.term,
      replace(replace(replace(q.term, '\', '\\'), '%', '\%'), '_', '\_') as escaped
    from q
  )
  select p.id, p.display_name, p.username, p.avatar
  from public.public_profiles p
  cross join pattern
  where length(pattern.term) >= 2
    and p.id <> (select auth.uid())
    and (
      p.username like pattern.escaped || '%'
      or lower(coalesce(p.display_name, '')) like '%' || pattern.escaped || '%'
    )
  order by
    coalesce(p.username = pattern.term, false) desc,
    coalesce(p.username like pattern.escaped || '%', false) desc,
    lower(coalesce(p.display_name, p.username, '')),
    p.id
  limit 20;
$$;

-- ---------------------------------------------------------------------------
-- 8. Who may use any of it: signed-in accounts only
-- ---------------------------------------------------------------------------
-- `public` as well as `anon` for the functions: Postgres grants EXECUTE on a new
-- function to PUBLIC by default, and anon is a member of PUBLIC, so revoking
-- from anon alone leaves the door open.
revoke all on function public.send_friend_request(uuid) from public, anon;
revoke all on function public.accept_friend_request(uuid) from public, anon;
revoke all on function public.block_person(uuid) from public, anon;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;
revoke all on function public.search_people(text) from public, anon;

grant execute on function public.send_friend_request(uuid) to authenticated;
grant execute on function public.accept_friend_request(uuid) to authenticated;
grant execute on function public.block_person(uuid) to authenticated;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;
grant execute on function public.search_people(text) to authenticated;

revoke all on public.public_profiles         from anon, public;
revoke all on public.public_sets             from anon, public;
revoke all on public.public_set_items        from anon, public;
revoke all on public.global_chat             from anon, public;
revoke all on public.message_reaction_people from anon, public;
revoke all on public.my_schedule             from anon, public;
revoke all on public.my_friends              from anon, public;
revoke all on public.my_blocks               from anon, public;

grant select on public.public_profiles         to authenticated;
grant select on public.public_sets             to authenticated;
grant select on public.public_set_items        to authenticated;
grant select on public.global_chat             to authenticated;
grant select on public.message_reaction_people to authenticated;
grant select on public.my_schedule             to authenticated;
grant select on public.my_friends              to authenticated;
grant select on public.my_blocks               to authenticated;
