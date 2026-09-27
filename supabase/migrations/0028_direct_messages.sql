-- Messages between friends (NOTES §53).
--
-- Step three of five (§51). Decided with the owner before anything was written
-- (2026-09-28):
--
--   - one-to-one, between FRIENDS: only a friend can start a conversation or
--     send in one;
--   - unfriending leaves the conversation readable and closes it — neither of
--     you can send until you are friends again;
--   - "Seen" under your last message once they have read it;
--   - an unread count on the Community tab and beside each conversation;
--   - Community's Chat becomes an inbox: the Everyone room at the top, then
--     your conversations.
--
-- And, as everywhere since §51, a block hides the two people from each other:
-- here that means the whole conversation, for both of them.
--
-- ############################################################################
-- # APPLY 0027 FIRST. This recreates 0027's `report_content` and widens its   #
-- # `reports_kind_check`. Section 0 refuses to run without it.               #
-- ############################################################################
--
-- ############################################################################
-- # NOT END-TO-END ENCRYPTED, AND THE PRIVACY POLICY SAYS SO.                #
-- #                                                                          #
-- # A message is readable by its two people through RLS, and by the database #
-- # owner the way every row here is. Messenger-style encryption would need    #
-- # keys on each device and a way to move them to a new phone; that is a      #
-- # different project. What this must not do is let anybody believe it is   #
-- # sealed — so the policy names who can reach it, in the same sentence that  #
-- # says the messages are private between the two of you.                     #
-- ############################################################################
--
-- The 0021/0026/0027 rules hold: no policy on an existing base table relaxed;
-- reads across accounts through views or policies that name exactly the two
-- people; writes that carry a rule are functions, and `conversations` and
-- `direct_messages` have no insert or update policy.
--
-- Additive, apart from `reports_kind_check`, dropped and added back by name as a
-- superset (§52.4). Safe before or after the code deploys.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Is 0027 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.posts') is null
    or to_regclass('public.friendships') is null
    or to_regprocedure('public.message_edit_window()') is null then
    raise exception 'Apply 0025, 0026 and 0027 first — this migration builds on them. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Conversations
-- ---------------------------------------------------------------------------
-- One per pair, the two ids in order, so A-and-B and B-and-A are one row and a
-- plain unique constraint can say so.
create table if not exists public.conversations (
  id              uuid primary key default gen_random_uuid(),
  user_low        uuid not null references auth.users (id) on delete cascade,
  user_high       uuid not null references auth.users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  constraint conversations_order check (user_low < user_high),
  constraint conversations_pair_key unique (user_low, user_high)
);

create index if not exists conversations_high_idx on public.conversations (user_high);

alter table public.conversations enable row level security;
alter table public.conversations force row level security;

-- The two people, and nobody else. Started by `start_conversation`; never
-- deleted from the app — a conversation outlives unfriending on purpose, and
-- deleting it would delete the OTHER person's messages with it.
drop policy if exists conversations_select_party on public.conversations;
create policy conversations_select_party on public.conversations
  for select using ((select auth.uid()) in (user_low, user_high));

-- Can the caller read this conversation? One of its two people, with no block
-- between them either way. SECURITY DEFINER because `blocks` shows each person
-- only their own rows. About the caller only.
create or replace function public.dm_readable(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.conversations c
    where c.id = p_conversation
      and (select auth.uid()) in (c.user_low, c.user_high)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = c.user_low and b.blocked_id = c.user_high)
           or (b.blocker_id = c.user_high and b.blocked_id = c.user_low)
      )
  );
$$;

-- Are these two friends right now? For sending: a conversation stays readable
-- after unfriending, and closes.
create or replace function public.dm_can_send(p_conversation uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.dm_readable(p_conversation)
    and exists (
      select 1
      from public.conversations c
      join public.friendships f
        on least(f.requester_id, f.addressee_id) = c.user_low
       and greatest(f.requester_id, f.addressee_id) = c.user_high
      where c.id = p_conversation
        and f.status = 'accepted'
    );
$$;

-- ---------------------------------------------------------------------------
-- 2. Messages
-- ---------------------------------------------------------------------------
create table if not exists public.direct_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  body            text not null check (length(btrim(body)) between 1 and 1000),
  created_at      timestamptz not null default now(),
  edited_at       timestamptz
);

create index if not exists direct_messages_conversation_idx
  on public.direct_messages (conversation_id, created_at desc);
create index if not exists direct_messages_user_recent_idx
  on public.direct_messages (user_id, created_at desc);

alter table public.direct_messages enable row level security;
alter table public.direct_messages force row level security;

-- Both people read them — while no block stands between them.
drop policy if exists direct_messages_select_party on public.direct_messages;
create policy direct_messages_select_party on public.direct_messages
  for select using (public.dm_readable(conversation_id));

-- Unsend for everyone: your own, and nothing else. No insert or update policy:
-- `send_direct_message` and `edit_direct_message`.
drop policy if exists direct_messages_delete_own on public.direct_messages;
create policy direct_messages_delete_own on public.direct_messages
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 3. Read markers — "Seen", and what is unread
-- ---------------------------------------------------------------------------
-- One row per person per conversation: when they last had it open. Both
-- people can read both rows — "Seen" is the other person's row — which is what
-- the owner chose. Written only by `mark_conversation_read`, with the time
-- taken from the database, so nobody can mark a conversation read in the future.
create table if not exists public.conversation_reads (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  read_at         timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

alter table public.conversation_reads enable row level security;
alter table public.conversation_reads force row level security;

drop policy if exists conversation_reads_select_party on public.conversation_reads;
create policy conversation_reads_select_party on public.conversation_reads
  for select using (public.dm_readable(conversation_id));

-- Your own marker is yours to delete — Delete my data does.
drop policy if exists conversation_reads_delete_own on public.conversation_reads;
create policy conversation_reads_delete_own on public.conversation_reads
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. Reactions, and hiding a message from your own screen
-- ---------------------------------------------------------------------------
-- The same shapes as the Everyone room's (0024, 0025).
create table if not exists public.direct_message_reactions (
  message_id uuid not null references public.direct_messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  emoji      text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

alter table public.direct_message_reactions enable row level security;
alter table public.direct_message_reactions force row level security;

-- The subquery reads `direct_messages` as the caller, so its own policy — the
-- two people, no block — is the whole check. A reaction is visible to exactly
-- who can see the message it is on.
drop policy if exists dm_reactions_select_party on public.direct_message_reactions;
create policy dm_reactions_select_party on public.direct_message_reactions
  for select using (exists (select 1 from public.direct_messages m where m.id = message_id));

drop policy if exists dm_reactions_insert_own on public.direct_message_reactions;
create policy dm_reactions_insert_own on public.direct_message_reactions
  for insert with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.direct_messages m where m.id = message_id)
  );

drop policy if exists dm_reactions_delete_own on public.direct_message_reactions;
create policy dm_reactions_delete_own on public.direct_message_reactions
  for delete using (user_id = (select auth.uid()));

create table if not exists public.direct_message_hidden (
  user_id    uuid not null references auth.users (id) on delete cascade,
  message_id uuid not null references public.direct_messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table public.direct_message_hidden enable row level security;
alter table public.direct_message_hidden force row level security;

drop policy if exists dm_hidden_select_own on public.direct_message_hidden;
create policy dm_hidden_select_own on public.direct_message_hidden
  for select using (user_id = (select auth.uid()));

drop policy if exists dm_hidden_insert_own on public.direct_message_hidden;
create policy dm_hidden_insert_own on public.direct_message_hidden
  for insert with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.direct_messages m where m.id = message_id)
  );

drop policy if exists dm_hidden_delete_own on public.direct_message_hidden;
create policy dm_hidden_delete_own on public.direct_message_hidden
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 5. The functions
-- ---------------------------------------------------------------------------
-- Open a conversation with a friend, or find the one there is. Returns its id.
-- Friends only, and never across a block.
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

  select c.id into found_id from public.conversations c where c.user_low = low and c.user_high = high;
  if found_id is not null and public.dm_readable(found_id) then
    return found_id;
  end if;

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

-- Send a message. Friends only — a conversation left over from before an
-- unfriending is read-only — and twenty a minute, the count and the write in
-- one statement (DM_PER_MINUTE in src/core/messages.ts). Sending also marks the
-- conversation read for the sender: you have seen everything up to your own
-- message.
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

-- Change a message you sent, inside the Everyone room's window (0025's
-- `message_edit_window`, twenty minutes), and never silently: `edited_at`.
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

-- "I have read this far." The time is the database's.
create or replace function public.mark_conversation_read(p_conversation uuid)
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
  if not public.dm_readable(p_conversation) then
    raise exception 'That conversation is gone.' using errcode = 'P0002';
  end if;

  insert into public.conversation_reads (conversation_id, user_id, read_at)
  values (p_conversation, me, now())
  on conflict (conversation_id, user_id) do update set read_at = excluded.read_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The views
-- ---------------------------------------------------------------------------
-- -------------------------------------------------------------- my_conversations --
-- The inbox: each of the caller's conversations, with the other person's name,
-- the last message the caller has not hidden, how many are unread, when the
-- other person last read it (for "Seen"), and whether the caller can still
-- send. A conversation across a block is not here at all.
drop view if exists public.my_conversations;
create view public.my_conversations
  with (security_barrier = true)
as
select
  c.id,
  o.other_id                        as person_id,
  p.display_name                    as name,
  p.username,
  p.avatar,
  c.created_at,
  c.last_message_at,
  lm.body                           as last_body,
  lm.user_id                        as last_sender,
  lm.created_at                     as last_at,
  (select count(*) from public.direct_messages m
     where m.conversation_id = c.id
       and m.user_id <> (select auth.uid())
       and m.created_at > coalesce(mine.read_at, '-infinity'::timestamptz)
       and not exists (
         select 1 from public.direct_message_hidden h
         where h.message_id = m.id and h.user_id = (select auth.uid())
       ))                           as unread,
  theirs.read_at                    as their_read_at,
  exists (
    select 1 from public.friendships f
    where f.status = 'accepted'
      and least(f.requester_id, f.addressee_id) = c.user_low
      and greatest(f.requester_id, f.addressee_id) = c.user_high
  )                                 as can_send
from public.conversations c
cross join lateral (
  select case when c.user_low = (select auth.uid()) then c.user_high else c.user_low end as other_id
) o
left join public.profiles p on p.id = o.other_id
left join public.conversation_reads mine
  on mine.conversation_id = c.id and mine.user_id = (select auth.uid())
left join public.conversation_reads theirs
  on theirs.conversation_id = c.id and theirs.user_id = o.other_id
left join lateral (
  select m.body, m.user_id, m.created_at
  from public.direct_messages m
  where m.conversation_id = c.id
    and not exists (
      select 1 from public.direct_message_hidden h
      where h.message_id = m.id and h.user_id = (select auth.uid())
    )
  order by m.created_at desc
  limit 1
) lm on true
where (select auth.uid()) in (c.user_low, c.user_high)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = c.user_low and b.blocked_id = c.user_high)
       or (b.blocker_id = c.user_high and b.blocked_id = c.user_low)
  );

-- --------------------------------------------------------- conversation_messages --
-- One conversation's messages, minus the ones the caller hid. The same rule as
-- the table's own policy (`dm_readable`), because a view that runs as its owner
-- does not get the policy for free.
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
  m.edited_at
from public.direct_messages m
where public.dm_readable(m.conversation_id)
  and not exists (
    select 1 from public.direct_message_hidden h
    where h.message_id = m.id and h.user_id = (select auth.uid())
  );

-- ---------------------------------------------------------------------------
-- 7. Reports gain a message between friends
-- ---------------------------------------------------------------------------
-- The person a message was sent to is the one who can report it, and that is
-- the point: a message nobody else can see is exactly where harassment hides.
-- Only somebody who can read the message can report it.
alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports
  add constraint reports_kind_check
  check (target_kind in ('person', 'message', 'set', 'post', 'comment', 'direct_message'));

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
-- 8. Signed-in accounts only
-- ---------------------------------------------------------------------------
revoke all on function public.dm_readable(uuid) from public, anon;
revoke all on function public.dm_can_send(uuid) from public, anon;
revoke all on function public.start_conversation(uuid) from public, anon;
revoke all on function public.send_direct_message(uuid, text) from public, anon;
revoke all on function public.edit_direct_message(uuid, text) from public, anon;
revoke all on function public.mark_conversation_read(uuid) from public, anon;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;

grant execute on function public.dm_readable(uuid) to authenticated;
grant execute on function public.dm_can_send(uuid) to authenticated;
grant execute on function public.start_conversation(uuid) to authenticated;
grant execute on function public.send_direct_message(uuid, text) to authenticated;
grant execute on function public.edit_direct_message(uuid, text) to authenticated;
grant execute on function public.mark_conversation_read(uuid) to authenticated;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;

revoke all on public.my_conversations      from anon, public;
revoke all on public.conversation_messages from anon, public;

grant select on public.my_conversations      to authenticated;
grant select on public.conversation_messages to authenticated;
