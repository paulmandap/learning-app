-- Community rules, and somebody to enforce them (NOTES §55).
--
-- Step five of five (§51). Decided with the owner before anything was written
-- (2026-09-28):
--
--   - a report queue in the app, for him alone, where he can REMOVE what was
--     reported (a set is unshared, never deleted), DISMISS a report, RESTRICT an
--     account (7 days, 30 days or for good: it can still study, and cannot post,
--     comment, message, add friends, share a set or chat), or WARN it (a notice
--     the next time they open the app, naming the rule);
--   - community rules everybody agrees to once, before their first social act —
--     and the database checks it, so it cannot be skipped.
--
-- ############################################################################
-- # EVERY WAY TO REACH ANOTHER PERSON NOW ASKS ONE QUESTION FIRST.           #
-- #                                                                          #
-- # `assert_can_socialize()`: has this person agreed to the rules, and are   #
-- # they not restricted? Ten functions are recreated below with that one line #
-- # added and NOTHING else changed — sending in the chat, editing there, a    #
-- # friend request and accepting one, a post, editing it, a comment, opening  #
-- # a conversation, sending in it, editing there — and a trigger asks it      #
-- # before a set is shared. Each copy is its latest version (0021, 0025,      #
-- # 0026, 0027, 0028), and tests/moderation.test.ts holds every one of them   #
-- # to containing the line.                                                   #
-- #                                                                          #
-- # Reactions do not ask. The owner's list of what a restriction stops did    #
-- # not include them, and a rules screen before your first ❤️ is the wrong    #
-- # moment to meet it.                                                        #
-- ############################################################################
--
-- The moderator is whoever is in `app_admins`. This file puts the owner there by
-- his sign-in email; anybody else is added by hand in this editor, and nothing
-- in the app can add anyone.
--
-- Additive: new tables, a new column, functions recreated in place, one new
-- trigger. Safe before or after the code deploys — though until the code is
-- live, the old build's first post or message after this is applied is refused
-- with "Agree to the community rules first" and no way to agree. Deploy first.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Is 0028 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.direct_messages') is null
    or to_regclass('public.posts') is null
    or to_regclass('public.reports') is null then
    raise exception 'Apply 0026, 0027 and 0028 first — this migration builds on them. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Who moderates
-- ---------------------------------------------------------------------------
create table if not exists public.app_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.app_admins enable row level security;
alter table public.app_admins force row level security;

-- You can ask whether YOU are one — that is how the app knows to show the
-- queue. Nobody can list the others, and nobody can add anybody: no insert,
-- update or delete policy at all.
drop policy if exists app_admins_select_own on public.app_admins;
create policy app_admins_select_own on public.app_admins
  for select using (user_id = (select auth.uid()));

-- The owner, by the address he signs in with (src/core/legal.ts CONTACT_EMAIL).
insert into public.app_admins (user_id)
select u.id from auth.users u where lower(u.email) = 'paulmandap16@gmail.com'
on conflict (user_id) do nothing;

do $$
begin
  if not exists (select 1 from public.app_admins) then
    raise notice 'No moderator was added: no account signs in as paulmandap16@gmail.com. Add one by hand.';
  end if;
end $$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from public.app_admins a where a.user_id = (select auth.uid()));
$$;

create or replace function public.assert_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null or not exists (select 1 from public.app_admins a where a.user_id = me) then
    raise exception 'Only a moderator can do that.' using errcode = '42501';
  end if;
  return me;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. The rules, agreed to once
-- ---------------------------------------------------------------------------
-- When this person agreed to the community rules (src/core/rules.ts). NULL:
-- not yet — which is everybody when this is applied, including the five people
-- already here. Their next social act shows them the rules first.
alter table public.profiles
  add column if not exists rules_accepted_at timestamptz;

create or replace function public.accept_community_rules()
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  accepted timestamptz;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  insert into public.profiles (id, rules_accepted_at)
  values (me, now())
  on conflict (id) do update
    set rules_accepted_at = coalesce(public.profiles.rules_accepted_at, excluded.rules_accepted_at)
  returning rules_accepted_at into accepted;
  return accepted;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Restrictions and warnings
-- ---------------------------------------------------------------------------
-- One restriction per person at most; `until` NULL is for good. The person can
-- read their own — the app tells them why an action was refused, and until
-- when — and nobody can write one but a moderator, through `restrict_account`.
--
-- NOT removed by Delete my data, and the Privacy Policy says so: deleting your
-- data must not be a way out of a restriction.
create table if not exists public.restrictions (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  until      timestamptz,
  reason     text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null
);

alter table public.restrictions enable row level security;
alter table public.restrictions force row level security;

drop policy if exists restrictions_select_own on public.restrictions;
create policy restrictions_select_own on public.restrictions
  for select using (user_id = (select auth.uid()));

-- A warning names a rule (src/core/rules.ts RULE_KEYS) and may carry a note.
-- Shown once, the next time the app opens; `seen_at` records that it was.
create table if not exists public.warnings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  rule       text not null,
  note       text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  seen_at    timestamptz,
  constraint warnings_rule_check check (rule in ('kind', 'clean', 'private', 'yourself', 'spam', 'yours', 'honest')),
  constraint warnings_note_check check (note is null or length(note) <= 500)
);

create index if not exists warnings_user_idx on public.warnings (user_id, created_at desc);

alter table public.warnings enable row level security;
alter table public.warnings force row level security;

drop policy if exists warnings_select_own on public.warnings;
create policy warnings_select_own on public.warnings
  for select using (user_id = (select auth.uid()));

create or replace function public.acknowledge_warning(p_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.warnings
    set seen_at = coalesce(seen_at, now())
    where id = p_id and user_id = (select auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- 4. The one question every social act asks
-- ---------------------------------------------------------------------------
-- Raises, rather than answering, so a function can ask it in one line and the
-- app can tell the two refusals apart by their codes: 'RULES' (show the rules)
-- and 'RSTRC' (say until when). Five-character SQLSTATEs of our own; PostgREST
-- passes them through as the error's code.
create or replace function public.assert_can_socialize()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid := (select auth.uid());
  r  public.restrictions;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p where p.id = me and p.rules_accepted_at is not null) then
    raise exception 'Agree to the community rules first.' using errcode = 'RULES';
  end if;

  select * into r from public.restrictions x where x.user_id = me;
  if found and (r.until is null or r.until > now()) then
    raise exception 'Your account is restricted.' using errcode = 'RSTRC';
  end if;
end;
$$;

-- Sharing a set is a plain update (or insert) of your own row, so it is asked
-- by a trigger. Not when nobody is signed in: that is the owner in this editor,
-- whose own changes must not be refused by a rule written for the app.
create or replace function public.study_sets_share_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if new.visibility = 'public'
     and (tg_op = 'INSERT' or old.visibility is distinct from 'public') then
    perform public.assert_can_socialize();
  end if;
  return new;
end;
$$;

drop trigger if exists study_sets_share_guard on public.study_sets;
create trigger study_sets_share_guard
  before insert or update of visibility on public.study_sets
  for each row execute function public.study_sets_share_guard();

-- ---------------------------------------------------------------------------
-- 5. The ten functions, each with the one line added
-- ---------------------------------------------------------------------------
-- ------------------------------------------------ 0021 send_global_message --
create or replace function public.send_global_message(message text)
returns public.global_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sent integer;
  row  public.global_messages;
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  select count(*) into sent
  from public.global_messages m
  where m.user_id = (select auth.uid())
    and m.created_at > now() - interval '1 minute';

  if sent >= 10 then
    raise exception 'Too many messages in a minute.' using errcode = 'P0001';
  end if;

  insert into public.global_messages (user_id, body)
  values ((select auth.uid()), btrim(message))
  returning * into row;

  return row;
end;
$$;

-- ------------------------------------------------ 0025 edit_global_message --
create or replace function public.edit_global_message(p_id uuid, p_body text)
returns public.global_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  msg public.global_messages;
  new_body text := btrim(p_body);
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if length(new_body) < 1 or length(new_body) > 1000 then
    raise exception 'A message is between 1 and 1000 characters.' using errcode = '23514';
  end if;

  select * into msg from public.global_messages m where m.id = p_id;

  if not found then
    raise exception 'That message is gone.' using errcode = 'P0002';
  end if;

  if msg.user_id <> (select auth.uid()) then
    raise exception 'That message is not yours.' using errcode = '42501';
  end if;

  if msg.created_at < now() - public.message_edit_window() then
    raise exception 'Too late to edit that one.' using errcode = 'P0001';
  end if;

  update public.global_messages
    set body = new_body, edited_at = now()
    where id = p_id
    returning * into msg;

  return msg;
end;
$$;

-- ------------------------------------------------ 0026 send_friend_request --
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

  perform public.assert_can_socialize();

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
  when unique_violation then
    return public.send_friend_request(p_to);
end;
$$;

-- ---------------------------------------------- 0026 accept_friend_request --
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

  perform public.assert_can_socialize();

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

-- -------------------------------------------------------- 0027 create_post --
create or replace function public.create_post(
  p_body         text,
  p_audience     text,
  p_image_path   text default null,
  p_image_width  integer default null,
  p_image_height integer default null,
  p_set_id       uuid default null,
  p_streak       boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  posted   integer;
  days     integer;
  my_pet   text;
  new_id   uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if p_image_path is not null then
    if (storage.foldername(p_image_path))[1] is distinct from me::text
       or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'post-images' and o.name = p_image_path
       ) then
      raise exception 'That photo is not yours to post.' using errcode = '42501';
    end if;
  end if;

  if p_set_id is not null and not exists (
    select 1 from public.study_sets s
    where s.id = p_set_id and s.visibility = 'public' and s.status = 'ready'
  ) then
    raise exception 'That set is not shared.' using errcode = 'P0002';
  end if;

  if p_streak then
    days := public.streak_of(me);
    if days < 1 then
      raise exception 'No streak to share yet.' using errcode = '22023';
    end if;
    select coalesce(p.pet, 'potato') into my_pet from public.profiles p where p.id = me;
  end if;

  select count(*) into posted
  from public.posts p
  where p.user_id = me
    and p.created_at > now() - interval '1 day';

  if posted >= 20 then
    raise exception 'Too many posts today.' using errcode = 'P0001';
  end if;

  insert into public.posts (
    user_id, body, audience, image_path, image_width, image_height, set_id, streak_days, pet
  )
  values (
    me,
    btrim(coalesce(p_body, '')),
    coalesce(p_audience, 'friends'),
    p_image_path,
    case when p_image_path is null then null else p_image_width end,
    case when p_image_path is null then null else p_image_height end,
    p_set_id,
    case when p_streak then days else null end,
    case when p_streak then coalesce(my_pet, 'potato') else null end
  )
  returning id into new_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------- 0027 edit_post --
create or replace function public.edit_post(p_id uuid, p_body text, p_audience text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  old_post public.posts;
  new_body text := btrim(coalesce(p_body, ''));
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  select * into old_post from public.posts p where p.id = p_id;
  if not found then
    raise exception 'That post is gone.' using errcode = 'P0002';
  end if;
  if old_post.user_id <> me then
    raise exception 'That post is not yours.' using errcode = '42501';
  end if;

  update public.posts
    set body = new_body,
        audience = coalesce(p_audience, old_post.audience),
        edited_at = case when new_body is distinct from old_post.body then now() else old_post.edited_at end
    where id = p_id;
end;
$$;

-- -------------------------------------------------------- 0027 add_comment --
create or replace function public.add_comment(p_post uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := (select auth.uid());
  sent   integer;
  new_id uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if not public.can_see_post(p_post) then
    raise exception 'That post is gone.' using errcode = 'P0002';
  end if;

  select count(*) into sent
  from public.post_comments c
  where c.user_id = me
    and c.created_at > now() - interval '1 minute';

  if sent >= 10 then
    raise exception 'Too many comments in a minute.' using errcode = 'P0001';
  end if;

  insert into public.post_comments (post_id, user_id, body)
  values (p_post, me, btrim(coalesce(p_body, '')))
  returning id into new_id;

  return new_id;
end;
$$;

-- ------------------------------------------------- 0028 start_conversation --
create or replace function public.start_conversation(p_other uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := (select auth.uid());
  low    uuid;
  high   uuid;
  found_id uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_other is null or p_other = me then
    raise exception 'You cannot message yourself.' using errcode = '22023';
  end if;

  low := least(me, p_other);
  high := greatest(me, p_other);

  -- Reading an old conversation is not a social act — a restricted person can
  -- still open one they already have. Opening a NEW one is.
  select c.id into found_id from public.conversations c where c.user_low = low and c.user_high = high;
  if found_id is not null and public.dm_readable(found_id) then
    return found_id;
  end if;

  perform public.assert_can_socialize();

  if exists (
    select 1 from public.blocks b
    where (b.blocker_id = me and b.blocked_id = p_other)
       or (b.blocker_id = p_other and b.blocked_id = me)
  ) or not exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and least(f.requester_id, f.addressee_id) = low
      and greatest(f.requester_id, f.addressee_id) = high
  ) then
    raise exception 'You can only message friends.' using errcode = '42501';
  end if;

  insert into public.conversations (user_low, user_high)
  values (low, high)
  on conflict (user_low, user_high) do nothing;

  select c.id into found_id from public.conversations c where c.user_low = low and c.user_high = high;
  return found_id;
end;
$$;

-- ------------------------------------------------ 0028 send_direct_message --
create or replace function public.send_direct_message(p_conversation uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := (select auth.uid());
  sent   integer;
  new_id uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if not public.dm_readable(p_conversation) then
    raise exception 'That conversation is gone.' using errcode = 'P0002';
  end if;
  if not public.dm_can_send(p_conversation) then
    raise exception 'You can only message friends.' using errcode = '42501';
  end if;

  select count(*) into sent
  from public.direct_messages m
  where m.user_id = me
    and m.created_at > now() - interval '1 minute';

  if sent >= 20 then
    raise exception 'Too many messages in a minute.' using errcode = 'P0001';
  end if;

  insert into public.direct_messages (conversation_id, user_id, body)
  values (p_conversation, me, btrim(coalesce(p_body, '')))
  returning id into new_id;

  update public.conversations set last_message_at = now() where id = p_conversation;

  insert into public.conversation_reads (conversation_id, user_id, read_at)
  values (p_conversation, me, now())
  on conflict (conversation_id, user_id) do update set read_at = excluded.read_at;

  return new_id;
end;
$$;

-- ------------------------------------------------ 0028 edit_direct_message --
create or replace function public.edit_direct_message(p_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  msg      public.direct_messages;
  new_body text := btrim(coalesce(p_body, ''));
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if length(new_body) < 1 or length(new_body) > 1000 then
    raise exception 'A message is between 1 and 1000 characters.' using errcode = '23514';
  end if;

  select * into msg from public.direct_messages m where m.id = p_id;
  if not found or not public.dm_readable(msg.conversation_id) then
    raise exception 'That message is gone.' using errcode = 'P0002';
  end if;
  if msg.user_id <> me then
    raise exception 'That message is not yours.' using errcode = '42501';
  end if;
  if msg.created_at < now() - public.message_edit_window() then
    raise exception 'Too late to edit that one.' using errcode = 'P0001';
  end if;

  update public.direct_messages
    set body = new_body, edited_at = now()
    where id = p_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The queue, and what a moderator can do about it
-- ---------------------------------------------------------------------------
-- Open reports, newest first is the app's to ask for, each with who reported
-- it, who it is about, how many open reports there are on the same thing, and
-- whether that person is restricted now. Filtered by `is_admin()` INSIDE the
-- view, so anybody else who reads it gets nothing at all.
drop view if exists public.report_queue;
create view public.report_queue
  with (security_barrier = true)
as
select
  r.id,
  r.target_kind,
  r.target_id,
  r.reason,
  r.details,
  r.snapshot,
  r.created_at,
  r.reporter_id,
  rp.display_name  as reporter_name,
  rp.username      as reporter_username,
  r.reported_user_id,
  tp.display_name  as reported_name,
  tp.username      as reported_username,
  tp.avatar        as reported_avatar,
  (select count(*) from public.reports o
     where o.target_kind = r.target_kind and o.target_id = r.target_id and o.status = 'open') as same_target,
  x.until          as restricted_until,
  (x.user_id is not null and x.until is null) as restricted_for_good
from public.reports r
left join public.profiles rp on rp.id = r.reporter_id
left join public.profiles tp on tp.id = r.reported_user_id
left join public.restrictions x on x.user_id = r.reported_user_id
where r.status = 'open'
  and public.is_admin();

-- Close every open report on one thing, as dismissed or dealt with.
create or replace function public.resolve_reports(p_kind text, p_target uuid, p_status text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  perform public.assert_admin();
  if p_status not in ('dismissed', 'actioned') then
    raise exception 'A report is dismissed or actioned.' using errcode = '22023';
  end if;
  update public.reports
    set status = p_status
    where target_kind = p_kind and target_id = p_target and status = 'open';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Take down what was reported, and close its reports as dealt with. A set is
-- UNSHARED, never deleted — its owner's cards, answers and schedule are theirs
-- to keep; what they lose is sharing it. A person has nothing to take down:
-- warn or restrict them instead.
create or replace function public.moderate_remove(p_kind text, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_admin();

  if p_kind = 'message' then
    delete from public.global_messages where id = p_target;
  elsif p_kind = 'direct_message' then
    delete from public.direct_messages where id = p_target;
  elsif p_kind = 'post' then
    delete from public.posts where id = p_target;
  elsif p_kind = 'comment' then
    delete from public.post_comments where id = p_target;
  elsif p_kind = 'set' then
    update public.study_sets set visibility = 'private' where id = p_target;
  else
    raise exception 'There is nothing to remove for a person — warn or restrict them.' using errcode = '22023';
  end if;

  update public.reports
    set status = 'actioned'
    where target_kind = p_kind and target_id = p_target and status = 'open';
end;
$$;

-- Restrict somebody for some days, or for good (p_days NULL). Replaces any
-- restriction already there. Never yourself.
create or replace function public.restrict_account(p_user uuid, p_days integer, p_reason text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me uuid;
begin
  me := public.assert_admin();
  if p_user is null or p_user = me then
    raise exception 'Not yourself.' using errcode = '22023';
  end if;
  if p_days is not null and p_days < 1 then
    raise exception 'At least a day.' using errcode = '22023';
  end if;

  insert into public.restrictions (user_id, until, reason, created_by)
  values (
    p_user,
    case when p_days is null then null else now() + make_interval(days => p_days) end,
    nullif(btrim(coalesce(p_reason, '')), ''),
    me
  )
  on conflict (user_id) do update
    set until = excluded.until,
        reason = excluded.reason,
        created_at = now(),
        created_by = excluded.created_by;
end;
$$;

create or replace function public.lift_restriction(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_admin();
  delete from public.restrictions where user_id = p_user;
end;
$$;

create or replace function public.warn_account(p_user uuid, p_rule text, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid;
  new_id uuid;
begin
  me := public.assert_admin();
  if p_user is null or p_user = me then
    raise exception 'Not yourself.' using errcode = '22023';
  end if;
  insert into public.warnings (user_id, rule, note, created_by)
  values (p_user, p_rule, nullif(btrim(coalesce(p_note, '')), ''), me)
  returning id into new_id;
  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Who may call what
-- ---------------------------------------------------------------------------
revoke all on function public.is_admin() from public, anon;
revoke all on function public.assert_admin() from public, anon, authenticated;
revoke all on function public.assert_can_socialize() from public, anon, authenticated;
revoke all on function public.accept_community_rules() from public, anon;
revoke all on function public.acknowledge_warning(uuid) from public, anon;
revoke all on function public.resolve_reports(text, uuid, text) from public, anon;
revoke all on function public.moderate_remove(text, uuid) from public, anon;
revoke all on function public.restrict_account(uuid, integer, text) from public, anon;
revoke all on function public.lift_restriction(uuid) from public, anon;
revoke all on function public.warn_account(uuid, text, text) from public, anon;

grant execute on function public.is_admin() to authenticated;
grant execute on function public.accept_community_rules() to authenticated;
grant execute on function public.acknowledge_warning(uuid) to authenticated;
grant execute on function public.resolve_reports(text, uuid, text) to authenticated;
grant execute on function public.moderate_remove(text, uuid) to authenticated;
grant execute on function public.restrict_account(uuid, integer, text) to authenticated;
grant execute on function public.lift_restriction(uuid) to authenticated;
grant execute on function public.warn_account(uuid, text, text) to authenticated;

revoke all on public.report_queue from anon, public;
grant select on public.report_queue to authenticated;
