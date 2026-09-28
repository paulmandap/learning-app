-- Reply to a message, and group chats (NOTES §58).
--
-- Step three of the social redesign (§56). The owner asked for everything the
-- redesign pictures show that the app did not have, and took these defaults
-- when they were put to him (2026-09-28):
--
--   - REPLY: a message can answer another in the same room — the Everyone
--     room, a conversation with a friend, a group — and shows the one it
--     answers above it, or that it was removed;
--   - GROUPS: you can only add your friends; thirty people at most; whoever
--     made it can rename it and remove people; anyone can leave; if you block
--     somebody, you stop seeing their messages in groups; a group message can
--     be reported like any other.
--
-- Chosen here and named to the owner: anyone in a group can add their own
-- friends; somebody added sees the messages from when they joined, not before
-- (what was said to a smaller group is not handed to whoever joins later);
-- when the maker leaves, whoever has been in it longest takes over, and a group
-- everybody leaves is gone.
--
-- ############################################################################
-- # APPLY 0028 AND 0030 FIRST. Section 0 refuses to run without them.        #
-- ############################################################################
--
-- ############################################################################
-- # NOT END-TO-END ENCRYPTED, like 0028's messages, and the Privacy Policy    #
-- # says so for groups in the same words.                                   #
-- ############################################################################
--
-- The same rules as ever: no policy on an existing base table is relaxed;
-- reads across accounts come through views that run as their owner, each with
-- the block filter; writes that carry a rule are functions, and the tables
-- they write have no insert or update policy. Every new way to reach somebody
-- asks `assert_can_socialize()` first (0030).
--
-- Additive, apart from things dropped and recreated IN THIS FILE:
--   - `send_global_message(text)` and `send_direct_message(uuid, text)` become
--     the same functions with one more argument, `p_reply_to`, which defaults
--     to null. The old signatures are dropped first: two versions side by side
--     would make PostgREST refuse to choose between them. A call without the
--     new argument — the live app's — lands on the new function unchanged.
--   - `global_chat` and `conversation_messages` gain the reply columns, every
--     existing column as it was.
--   - `reports_kind_check` gains 'group_message', by name, as a superset.
--   - `report_content` and `moderate_remove` each gain one branch.
-- Safe before or after the code deploys.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Are 0028 and 0030 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.direct_messages') is null
    or to_regclass('public.global_messages') is null
    or to_regprocedure('public.assert_can_socialize()') is null
    or to_regprocedure('public.moderate_remove(text, uuid)') is null then
    raise exception 'Apply 0028 and 0030 first — this migration builds on them. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Replies in the Everyone room and between friends
-- ---------------------------------------------------------------------------
-- The message answered. NOT a foreign key: the one answered can be unsent,
-- and the reply must survive it and say so ("Message removed") — a key would
-- either block the unsend or erase the fact that this was a reply. It is only
-- ever written by the send functions below, which check it is a message in
-- the same room.
alter table public.global_messages add column if not exists reply_to uuid;
alter table public.direct_messages add column if not exists reply_to uuid;

-- 0030's `send_global_message`, with the reply: checked to be a message in
-- this room, and written. Nothing else differs (tests/replies.test.ts).
drop function if exists public.send_global_message(text);
create or replace function public.send_global_message(message text, p_reply_to uuid default null)
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

  if p_reply_to is not null and not exists (select 1 from public.global_messages r where r.id = p_reply_to) then
    raise exception 'That message is gone.' using errcode = 'P0002';
  end if;

  insert into public.global_messages (user_id, body, reply_to)
  values ((select auth.uid()), btrim(message), p_reply_to)
  returning * into row;

  return row;
end;
$$;

-- 0030's `send_direct_message`, with the reply: a message in THIS
-- conversation. Nothing else differs.
drop function if exists public.send_direct_message(uuid, text);
create or replace function public.send_direct_message(p_conversation uuid, p_body text, p_reply_to uuid default null)
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

  if p_reply_to is not null and not exists (
    select 1 from public.direct_messages r where r.id = p_reply_to and r.conversation_id = p_conversation
  ) then
    raise exception 'That message is gone.' using errcode = 'P0002';
  end if;

  insert into public.direct_messages (conversation_id, user_id, body, reply_to)
  values (p_conversation, me, btrim(coalesce(p_body, '')), p_reply_to)
  returning id into new_id;

  update public.conversations set last_message_at = now() where id = p_conversation;

  insert into public.conversation_reads (conversation_id, user_id, read_at)
  values (p_conversation, me, now())
  on conflict (conversation_id, user_id) do update set read_at = excluded.read_at;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------- global_chat --
-- 0026's view, every column as it was, and the reply at the end: which message
-- it answers, and that message's author and words — null when it was unsent,
-- or its author is across a block from the reader.
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
  m.edited_at,
  m.reply_to,
  r.user_id            as reply_author_id,
  rp.display_name      as reply_name,
  r.body               as reply_body
from public.global_messages m
left join public.profiles p on p.id = m.user_id
left join public.global_messages r
  on r.id = m.reply_to
 and not exists (
   select 1 from public.blocks b
   where (b.blocker_id = (select auth.uid()) and b.blocked_id = r.user_id)
      or (b.blocker_id = r.user_id and b.blocked_id = (select auth.uid()))
 )
left join public.profiles rp on rp.id = r.user_id
where not exists (
  select 1 from public.hidden_messages h
  where h.message_id = m.id and h.user_id = (select auth.uid())
)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = m.user_id)
       or (b.blocker_id = m.user_id and b.blocked_id = (select auth.uid()))
  );

-- ------------------------------------------------------ conversation_messages --
-- 0028's view, every column as it was, and the reply at the end — the message
-- answered, only ever one in the same conversation.
drop view if exists public.conversation_messages;
create view public.conversation_messages
  with (security_barrier = true)
as
select
  m.id,
  m.conversation_id,
  m.user_id   as author_id,
  m.body,
  m.created_at,
  m.edited_at,
  m.reply_to,
  r.user_id   as reply_author_id,
  r.body      as reply_body
from public.direct_messages m
left join public.direct_messages r
  on r.id = m.reply_to and r.conversation_id = m.conversation_id
where public.dm_readable(m.conversation_id)
  and not exists (
    select 1 from public.direct_message_hidden h
    where h.message_id = m.id and h.user_id = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 2. Groups
-- ---------------------------------------------------------------------------
-- `owner_id` is whoever can rename the group and remove people: its maker,
-- until they leave. Nobody is its owner after an account is deleted, and the
-- next to leave or be asked hands it on (`leave_group`).
create table if not exists public.group_chats (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (length(btrim(title)) between 1 and 60),
  created_by      uuid references auth.users (id) on delete set null,
  owner_id        uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz
);

create index if not exists group_chats_created_by_idx on public.group_chats (created_by, created_at desc);

alter table public.group_chats enable row level security;
alter table public.group_chats force row level security;

-- Who is in which group, since when, and how far they have read. `joined_at`
-- is what a member can see back to: rejoining starts it again.
create table if not exists public.group_members (
  group_id  uuid not null references public.group_chats (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  added_by  uuid references auth.users (id) on delete set null,
  joined_at timestamptz not null default now(),
  read_at   timestamptz,
  primary key (group_id, user_id)
);

create index if not exists group_members_user_idx on public.group_members (user_id);

alter table public.group_members enable row level security;
alter table public.group_members force row level security;

create table if not exists public.group_messages (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.group_chats (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now(),
  edited_at  timestamptz,
  -- As in section 1: not a key, so a reply outlives the message it answers.
  reply_to   uuid
);

create index if not exists group_messages_group_idx on public.group_messages (group_id, created_at desc);
create index if not exists group_messages_user_recent_idx on public.group_messages (user_id, created_at desc);

alter table public.group_messages enable row level security;
alter table public.group_messages force row level security;

create table if not exists public.group_message_reactions (
  message_id uuid not null references public.group_messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  emoji      text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

alter table public.group_message_reactions enable row level security;
alter table public.group_message_reactions force row level security;

create table if not exists public.group_message_hidden (
  user_id    uuid not null references auth.users (id) on delete cascade,
  message_id uuid not null references public.group_messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table public.group_message_hidden enable row level security;
alter table public.group_message_hidden force row level security;

-- ---------------------------------------------------------------------------
-- 3. Who can see what in a group
-- ---------------------------------------------------------------------------
-- When the caller joined this group — null if they are not in it. What a
-- member can see goes back to here. About the caller only. SECURITY DEFINER
-- because `group_members` shows each person only their own rows.
create or replace function public.group_member_since(p_group uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select x.joined_at
  from public.group_members x
  where x.group_id = p_group and x.user_id = (select auth.uid());
$$;

-- Can the caller see this message? In the group, sent since they joined, and
-- no block between them and whoever sent it, either way. The one rule for a
-- group message — the policies, the views and reporting all ask it.
create or replace function public.group_message_visible(p_group uuid, p_author uuid, p_created timestamptz)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(p_created >= public.group_member_since(p_group), false)
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = (select auth.uid()) and b.blocked_id = p_author)
         or (b.blocker_id = p_author and b.blocked_id = (select auth.uid()))
    );
$$;

-- A group: to its members. Its members' rows: your own only — everybody else
-- in it comes through `group_member_people`, with the block filter.
drop policy if exists group_chats_select_member on public.group_chats;
create policy group_chats_select_member on public.group_chats
  for select using (public.group_member_since(id) is not null);

drop policy if exists group_members_select_own on public.group_members;
create policy group_members_select_own on public.group_members
  for select using (user_id = (select auth.uid()));

-- Messages: what `group_message_visible` allows. Unsend your own. No insert or
-- update policy: `send_group_message` and `edit_group_message`.
drop policy if exists group_messages_select_visible on public.group_messages;
create policy group_messages_select_visible on public.group_messages
  for select using (public.group_message_visible(group_id, user_id, created_at));

drop policy if exists group_messages_delete_own on public.group_messages;
create policy group_messages_delete_own on public.group_messages
  for delete using (user_id = (select auth.uid()));

-- Reactions and hiding: the shapes 0028 gave messages between friends. The
-- subqueries read `group_messages` as the caller, so its policy is the check.
drop policy if exists group_reactions_select_visible on public.group_message_reactions;
create policy group_reactions_select_visible on public.group_message_reactions
  for select using (exists (select 1 from public.group_messages m where m.id = message_id));

drop policy if exists group_reactions_insert_own on public.group_message_reactions;
create policy group_reactions_insert_own on public.group_message_reactions
  for insert with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.group_messages m where m.id = message_id)
  );

drop policy if exists group_reactions_delete_own on public.group_message_reactions;
create policy group_reactions_delete_own on public.group_message_reactions
  for delete using (user_id = (select auth.uid()));

drop policy if exists group_hidden_select_own on public.group_message_hidden;
create policy group_hidden_select_own on public.group_message_hidden
  for select using (user_id = (select auth.uid()));

drop policy if exists group_hidden_insert_own on public.group_message_hidden;
create policy group_hidden_insert_own on public.group_message_hidden
  for insert with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.group_messages m where m.id = message_id)
  );

drop policy if exists group_hidden_delete_own on public.group_message_hidden;
create policy group_hidden_delete_own on public.group_message_hidden
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. Making a group, and who may change it
-- ---------------------------------------------------------------------------
-- Make a group with some of your friends. Returns its id. Everybody added
-- must be a friend, with no block either way; one friend at least, thirty
-- people at most with you; ten new groups a day (src/core/groups.ts).
create or replace function public.create_group(p_title text, p_members uuid[])
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := (select auth.uid());
  others uuid[];
  bad    integer;
  made   integer;
  new_id uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if length(btrim(coalesce(p_title, ''))) not between 1 and 60 then
    raise exception 'A group needs a name, up to 60 characters.' using errcode = '23514';
  end if;

  select coalesce(array_agg(distinct x.id), '{}') into others
  from unnest(coalesce(p_members, '{}'::uuid[])) as x(id)
  where x.id is not null and x.id <> me;

  if cardinality(others) < 1 then
    raise exception 'Add at least one friend.' using errcode = '22023';
  end if;
  if cardinality(others) + 1 > 30 then
    raise exception 'A group is thirty people at most.' using errcode = '22023';
  end if;

  select count(*) into bad
  from unnest(others) as o(id)
  where not exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester_id, f.addressee_id) = least(me, o.id)
        and greatest(f.requester_id, f.addressee_id) = greatest(me, o.id)
    )
    or exists (
      select 1 from public.blocks b
      where (b.blocker_id = me and b.blocked_id = o.id)
         or (b.blocker_id = o.id and b.blocked_id = me)
    );

  if bad > 0 then
    raise exception 'You can only add friends.' using errcode = '42501';
  end if;

  select count(*) into made
  from public.group_chats g
  where g.created_by = me
    and g.created_at > now() - interval '1 day';

  if made >= 10 then
    raise exception 'Too many new groups today.' using errcode = 'P0001';
  end if;

  insert into public.group_chats (title, created_by, owner_id)
  values (btrim(p_title), me, me)
  returning id into new_id;

  insert into public.group_members (group_id, user_id, added_by)
  select new_id, me, me
  union all
  select new_id, o.id, me from unnest(others) as o(id);

  return new_id;
end;
$$;

-- Add some of your friends to a group you are in — anybody in it can. The
-- same checks as making one; those already in it are skipped. Returns how
-- many joined.
create or replace function public.add_group_members(p_group uuid, p_members uuid[])
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := (select auth.uid());
  others uuid[];
  bad    integer;
  inside integer;
  n      integer;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if public.group_member_since(p_group) is null then
    raise exception 'That group is gone.' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct x.id), '{}') into others
  from unnest(coalesce(p_members, '{}'::uuid[])) as x(id)
  where x.id is not null
    and x.id <> me
    and not exists (select 1 from public.group_members g where g.group_id = p_group and g.user_id = x.id);

  if cardinality(others) = 0 then
    return 0;
  end if;

  select count(*) into bad
  from unnest(others) as o(id)
  where not exists (
      select 1 from public.friendships f
      where f.status = 'accepted'
        and least(f.requester_id, f.addressee_id) = least(me, o.id)
        and greatest(f.requester_id, f.addressee_id) = greatest(me, o.id)
    )
    or exists (
      select 1 from public.blocks b
      where (b.blocker_id = me and b.blocked_id = o.id)
         or (b.blocker_id = o.id and b.blocked_id = me)
    );

  if bad > 0 then
    raise exception 'You can only add friends.' using errcode = '42501';
  end if;

  select count(*) into inside from public.group_members g where g.group_id = p_group;
  if inside + cardinality(others) > 30 then
    raise exception 'A group is thirty people at most.' using errcode = '22023';
  end if;

  insert into public.group_members (group_id, user_id, added_by)
  select p_group, o.id, me from unnest(others) as o(id)
  on conflict (group_id, user_id) do nothing;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- Rename a group. Its owner only.
create or replace function public.rename_group(p_group uuid, p_title text)
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

  if public.group_member_since(p_group) is null then
    raise exception 'That group is gone.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.group_chats g where g.id = p_group and g.owner_id = me) then
    raise exception 'Only whoever made the group can rename it.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_title, ''))) not between 1 and 60 then
    raise exception 'A group needs a name, up to 60 characters.' using errcode = '23514';
  end if;

  update public.group_chats set title = btrim(p_title) where id = p_group;
end;
$$;

-- Take somebody out of a group. Its owner only, and never themselves — that
-- is leaving. Not gated by the rules: taking somebody out reaches nobody.
create or replace function public.remove_group_member(p_group uuid, p_user uuid)
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
  if public.group_member_since(p_group) is null then
    raise exception 'That group is gone.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.group_chats g where g.id = p_group and g.owner_id = me) then
    raise exception 'Only whoever made the group can remove people.' using errcode = '42501';
  end if;
  if p_user is null or p_user = me then
    raise exception 'To go yourself, leave the group.' using errcode = '22023';
  end if;

  delete from public.group_members where group_id = p_group and user_id = p_user;
end;
$$;

-- Leave a group. Always allowed, restricted or not. If you were its owner,
-- whoever has been in it longest takes over; if nobody is left, the group and
-- everything in it goes.
create or replace function public.leave_group(p_group uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me   uuid := (select auth.uid());
  heir uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if public.group_member_since(p_group) is null then
    raise exception 'That group is gone.' using errcode = 'P0002';
  end if;

  delete from public.group_members where group_id = p_group and user_id = me;

  select g.user_id into heir
  from public.group_members g
  where g.group_id = p_group
  order by g.joined_at, g.user_id
  limit 1;

  if heir is null then
    delete from public.group_chats where id = p_group;
  else
    update public.group_chats
      set owner_id = heir
      where id = p_group and (owner_id = me or owner_id is null);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Talking in a group
-- ---------------------------------------------------------------------------
-- Send to a group you are in: twenty a minute, like a conversation; a reply
-- only to a message in the same group; sending marks it read for you.
create or replace function public.send_group_message(p_group uuid, p_body text, p_reply_to uuid default null)
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

  if public.group_member_since(p_group) is null then
    raise exception 'That group is gone.' using errcode = 'P0002';
  end if;

  select count(*) into sent
  from public.group_messages m
  where m.user_id = me
    and m.created_at > now() - interval '1 minute';

  if sent >= 20 then
    raise exception 'Too many messages in a minute.' using errcode = 'P0001';
  end if;

  if p_reply_to is not null and not exists (
    select 1 from public.group_messages r where r.id = p_reply_to and r.group_id = p_group
  ) then
    raise exception 'That message is gone.' using errcode = 'P0002';
  end if;

  insert into public.group_messages (group_id, user_id, body, reply_to)
  values (p_group, me, btrim(coalesce(p_body, '')), p_reply_to)
  returning id into new_id;

  update public.group_chats set last_message_at = now() where id = p_group;
  update public.group_members set read_at = now() where group_id = p_group and user_id = me;

  return new_id;
end;
$$;

-- Change a message you sent to a group, within 0025's window, marked edited.
create or replace function public.edit_group_message(p_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  msg      public.group_messages;
  new_body text := btrim(coalesce(p_body, ''));
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if length(new_body) < 1 or length(new_body) > 1000 then
    raise exception 'A message is between 1 and 1000 characters.' using errcode = '23514';
  end if;

  select * into msg from public.group_messages m where m.id = p_id;
  if not found or not public.group_message_visible(msg.group_id, msg.user_id, msg.created_at) then
    raise exception 'That message is gone.' using errcode = 'P0002';
  end if;
  if msg.user_id <> me then
    raise exception 'That message is not yours.' using errcode = '42501';
  end if;
  if msg.created_at < now() - public.message_edit_window() then
    raise exception 'Too late to edit that one.' using errcode = 'P0001';
  end if;

  update public.group_messages
    set body = new_body, edited_at = now()
    where id = p_id;
end;
$$;

-- "I have read this far." The time is the database's.
create or replace function public.mark_group_read(p_group uuid)
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
  if public.group_member_since(p_group) is null then
    raise exception 'That group is gone.' using errcode = 'P0002';
  end if;

  update public.group_members set read_at = now() where group_id = p_group and user_id = me;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The views
-- ---------------------------------------------------------------------------
-- ------------------------------------------------------------------ my_groups --
-- The inbox's groups: each group the caller is in, its name, who can change
-- it, how many are in it, the last message the caller can see, and how many
-- they have not read.
drop view if exists public.my_groups;
create view public.my_groups
  with (security_barrier = true)
as
select
  g.id,
  g.title,
  g.owner_id,
  (g.owner_id = (select auth.uid()))   as i_own,
  g.created_at,
  g.last_message_at,
  mine.joined_at,
  (select count(*) from public.group_members x where x.group_id = g.id) as member_count,
  lm.body                              as last_body,
  lm.user_id                           as last_sender,
  lp.display_name                      as last_sender_name,
  lm.created_at                        as last_at,
  (select count(*) from public.group_messages m
     where m.group_id = g.id
       and m.user_id <> (select auth.uid())
       and m.created_at > coalesce(mine.read_at, mine.joined_at)
       and m.created_at >= mine.joined_at
       and not exists (
         select 1 from public.group_message_hidden h
         where h.message_id = m.id and h.user_id = (select auth.uid())
       )
       and not exists (
         select 1 from public.blocks b
         where (b.blocker_id = (select auth.uid()) and b.blocked_id = m.user_id)
            or (b.blocker_id = m.user_id and b.blocked_id = (select auth.uid()))
       ))                              as unread
from public.group_members mine
join public.group_chats g on g.id = mine.group_id
left join lateral (
  select m.body, m.user_id, m.created_at
  from public.group_messages m
  where m.group_id = g.id
    and m.created_at >= mine.joined_at
    and not exists (
      select 1 from public.group_message_hidden h
      where h.message_id = m.id and h.user_id = (select auth.uid())
    )
    and not exists (
      select 1 from public.blocks b
      where (b.blocker_id = (select auth.uid()) and b.blocked_id = m.user_id)
         or (b.blocker_id = m.user_id and b.blocked_id = (select auth.uid()))
    )
  order by m.created_at desc
  limit 1
) lm on true
left join public.profiles lp on lp.id = lm.user_id
where mine.user_id = (select auth.uid());

-- ------------------------------------------------------- group_member_people --
-- Who is in the caller's groups, named — minus anybody across a block from
-- the caller, who is hidden here as everywhere else.
drop view if exists public.group_member_people;
create view public.group_member_people
  with (security_barrier = true)
as
select
  x.group_id,
  x.user_id,
  p.display_name        as name,
  p.username,
  p.avatar,
  x.joined_at,
  (g.owner_id = x.user_id) as is_owner
from public.group_members x
join public.group_chats g on g.id = x.group_id
left join public.profiles p on p.id = x.user_id
where public.group_member_since(x.group_id) is not null
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = x.user_id)
       or (b.blocker_id = x.user_id and b.blocked_id = (select auth.uid()))
  );

-- ------------------------------------------------------- group_chat_messages --
-- A group's messages as the caller may see them (`group_message_visible`),
-- minus the ones they hid, each with its author and the message it answers —
-- null when that one is gone, from before the caller joined, or across a block.
drop view if exists public.group_chat_messages;
create view public.group_chat_messages
  with (security_barrier = true)
as
select
  m.id,
  m.group_id,
  m.user_id            as author_id,
  p.display_name       as author_name,
  p.avatar             as author_avatar,
  m.body,
  m.created_at,
  m.edited_at,
  m.reply_to,
  r.user_id            as reply_author_id,
  rp.display_name      as reply_name,
  r.body               as reply_body
from public.group_messages m
left join public.profiles p on p.id = m.user_id
left join public.group_messages r
  on r.id = m.reply_to
 and r.group_id = m.group_id
 and public.group_message_visible(r.group_id, r.user_id, r.created_at)
left join public.profiles rp on rp.id = r.user_id
where public.group_message_visible(m.group_id, m.user_id, m.created_at)
  and not exists (
    select 1 from public.group_message_hidden h
    where h.message_id = m.id and h.user_id = (select auth.uid())
  );

-- ---------------------------------------------------- group_reaction_people --
drop view if exists public.group_reaction_people;
create view public.group_reaction_people
  with (security_barrier = true)
as
select
  r.message_id,
  r.user_id,
  p.display_name as name,
  r.emoji,
  r.created_at
from public.group_message_reactions r
join public.group_messages m on m.id = r.message_id
left join public.profiles p on p.id = r.user_id
where public.group_message_visible(m.group_id, m.user_id, m.created_at)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = r.user_id)
       or (b.blocker_id = r.user_id and b.blocked_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 7. Reports and moderation gain a group message
-- ---------------------------------------------------------------------------
alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports
  add constraint reports_kind_check
  check (target_kind in ('person', 'message', 'set', 'post', 'comment', 'direct_message', 'group_message'));

-- 0028's function with one more branch: a group message, reportable by
-- whoever can see it — a member, since it was sent after they joined.
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
  me            uuid := (select auth.uid());
  owner_id      uuid;
  snapshot_text text;
  existing      uuid;
  sent          integer;
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
  elsif p_kind = 'post' then
    select p.user_id,
           concat_ws(' ', nullif(p.body, ''),
             case when p.image_path is not null then '[photo]' end,
             case when p.set_id is not null then '[set]' end,
             case when p.streak_days is not null then '[streak ' || p.streak_days || ']' end)
      into owner_id, snapshot_text
      from public.posts p
      where p.id = p_target
        and public.post_visible(p.user_id, p.audience);
  elsif p_kind = 'comment' then
    select c.user_id, c.body
      into owner_id, snapshot_text
      from public.post_comments c
      join public.posts p on p.id = c.post_id
      where c.id = p_target
        and public.post_visible(p.user_id, p.audience);
  elsif p_kind = 'direct_message' then
    select m.user_id, m.body
      into owner_id, snapshot_text
      from public.direct_messages m
      where m.id = p_target
        and public.dm_readable(m.conversation_id);
  elsif p_kind = 'group_message' then
    select m.user_id, m.body
      into owner_id, snapshot_text
      from public.group_messages m
      where m.id = p_target
        and public.group_message_visible(m.group_id, m.user_id, m.created_at);
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

-- 0030's function with one more branch.
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
  elsif p_kind = 'group_message' then
    delete from public.group_messages where id = p_target;
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

-- ---------------------------------------------------------------------------
-- 8. Signed-in accounts only
-- ---------------------------------------------------------------------------
revoke all on function public.send_global_message(text, uuid) from public, anon;
revoke all on function public.send_direct_message(uuid, text, uuid) from public, anon;
revoke all on function public.group_member_since(uuid) from public, anon;
revoke all on function public.group_message_visible(uuid, uuid, timestamptz) from public, anon;
revoke all on function public.create_group(text, uuid[]) from public, anon;
revoke all on function public.add_group_members(uuid, uuid[]) from public, anon;
revoke all on function public.rename_group(uuid, text) from public, anon;
revoke all on function public.remove_group_member(uuid, uuid) from public, anon;
revoke all on function public.leave_group(uuid) from public, anon;
revoke all on function public.send_group_message(uuid, text, uuid) from public, anon;
revoke all on function public.edit_group_message(uuid, text) from public, anon;
revoke all on function public.mark_group_read(uuid) from public, anon;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;
revoke all on function public.moderate_remove(text, uuid) from public, anon;

grant execute on function public.send_global_message(text, uuid) to authenticated;
grant execute on function public.send_direct_message(uuid, text, uuid) to authenticated;
grant execute on function public.group_member_since(uuid) to authenticated;
grant execute on function public.group_message_visible(uuid, uuid, timestamptz) to authenticated;
grant execute on function public.create_group(text, uuid[]) to authenticated;
grant execute on function public.add_group_members(uuid, uuid[]) to authenticated;
grant execute on function public.rename_group(uuid, text) to authenticated;
grant execute on function public.remove_group_member(uuid, uuid) to authenticated;
grant execute on function public.leave_group(uuid) to authenticated;
grant execute on function public.send_group_message(uuid, text, uuid) to authenticated;
grant execute on function public.edit_group_message(uuid, text) to authenticated;
grant execute on function public.mark_group_read(uuid) to authenticated;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;
grant execute on function public.moderate_remove(text, uuid) to authenticated;

revoke all on public.global_chat           from anon, public;
revoke all on public.conversation_messages from anon, public;
revoke all on public.my_groups             from anon, public;
revoke all on public.group_member_people   from anon, public;
revoke all on public.group_chat_messages   from anon, public;
revoke all on public.group_reaction_people from anon, public;

grant select on public.global_chat           to authenticated;
grant select on public.conversation_messages to authenticated;
grant select on public.my_groups             to authenticated;
grant select on public.group_member_people   to authenticated;
grant select on public.group_chat_messages   to authenticated;
grant select on public.group_reaction_people to authenticated;
