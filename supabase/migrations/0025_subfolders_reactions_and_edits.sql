-- Subfolders, message reactions, and editing a message you just sent (NOTES §48).
--
-- Additive apart from recreating `global_chat`, which is recreated in the same
-- file. Safe to apply before or after its deploy: an older build does not know
-- `parent_id`, `message_reactions` or `edited_at` exist and simply carries on.

-- ---------------------------------------------------------------------------
-- 1. A folder inside a folder
-- ---------------------------------------------------------------------------
-- The owner: *"could you add a feature for adding subfolder inside the folder?"*
--
-- ## `set null`, not cascade — the same rule as study_sets.folder_id
--
-- Deleting a folder must not delete what is inside it. A subfolder whose parent
-- goes away becomes a top-level folder, keeping its own sets; 0024 already puts
-- the parent's sets back on the top level the same way. Somebody tidying up
-- their groupings must never lose a set, with its cards, answers and review
-- dates, and find out afterwards.
alter table public.folders
  add column if not exists parent_id uuid references public.folders (id) on delete set null;

create index if not exists folders_parent_idx on public.folders (parent_id)
  where parent_id is not null;

-- ############################################################################
-- # TWO LEVELS, AND NO LOOPS. Both are enforced here rather than in the app.  #
-- #                                                                          #
-- # Depth: a folder may hold subfolders; a subfolder may not. Deeper trees    #
-- # need a navigator, a breadcrumb and a move-to-parent gesture before they   #
-- # are usable, which is a file manager rather than a study app — and the     #
-- # focused view this is built for shows ONE folder's contents, which is only #
-- # coherent while "contents" cannot itself be a tree.                        #
-- #                                                                          #
-- # Loops: A inside B inside A is not reachable from anywhere. At two levels  #
-- # the depth rule already forbids it, but the check is written for what it   #
-- # means rather than relying on that, so raising the depth later cannot      #
-- # silently allow a folder to contain itself.                                #
-- ############################################################################
create or replace function public.folders_shape_guard()
returns trigger
language plpgsql
as $$
declare
  parent_of_parent uuid;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception 'A folder cannot be inside itself.' using errcode = '23514';
  end if;

  select f.parent_id into parent_of_parent
  from public.folders f
  where f.id = new.parent_id;

  if not found then
    raise exception 'That folder does not exist.' using errcode = '23503';
  end if;

  if parent_of_parent is not null then
    raise exception 'Folders only go two deep.' using errcode = '23514';
  end if;

  -- A folder that already holds subfolders cannot itself be moved inside one,
  -- or its children would end up three deep.
  if exists (select 1 from public.folders c where c.parent_id = new.id) then
    raise exception 'That folder holds other folders, so it cannot go inside one.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists folders_shape on public.folders;
create trigger folders_shape
  before insert or update of parent_id on public.folders
  for each row execute function public.folders_shape_guard();

-- ---------------------------------------------------------------------------
-- 2. Reactions
-- ---------------------------------------------------------------------------
-- The owner: *"add a react message in the chat like in messenger, heart, haha,
-- wow, sad, angry, like, '+' for custom reaction."*
--
-- The emoji is stored as text rather than as one of six named kinds, because
-- "+" means any emoji at all. Capped at 16 characters: an emoji with a skin
-- tone and a variation selector is several code points, and a column that took
-- a paragraph would be a second message field nobody asked for.
create table if not exists public.message_reactions (
  message_id uuid not null references public.global_messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  emoji      text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  -- One of each emoji per person per message: tapping ❤️ twice is one heart,
  -- and tapping ❤️ then 😂 is two different reactions from one person.
  primary key (message_id, user_id, emoji)
);

create index if not exists message_reactions_message_idx
  on public.message_reactions (message_id);

alter table public.message_reactions enable row level security;
alter table public.message_reactions force row level security;

-- Readable by anyone signed in, WHO reacted included — unlike stars on a set,
-- which are deliberately counted and not named (0021). A reaction is a reply:
-- it is addressed to the person who wrote the message, in a room where
-- everything else is attributed, and an anonymous 😠 on somebody's message
-- would be worse than a named one.
drop policy if exists message_reactions_select_signed_in on public.message_reactions;
create policy message_reactions_select_signed_in on public.message_reactions
  for select using ((select auth.uid()) is not null);

drop policy if exists message_reactions_insert_own on public.message_reactions;
create policy message_reactions_insert_own on public.message_reactions
  for insert with check (user_id = (select auth.uid()));

-- No update policy: a reaction has nothing to change. Changing your mind is a
-- delete and an insert.
drop policy if exists message_reactions_delete_own on public.message_reactions;
create policy message_reactions_delete_own on public.message_reactions
  for delete using (user_id = (select auth.uid()));

-- Reactions with the name to put beside them, minus anything the caller hid.
--
-- A view for the same reason `global_chat` is one: the client cannot read
-- `profiles` across accounts, so without this every reaction would be
-- attributed to nobody. Same face-or-photo column as everywhere else (0023).
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
left join public.profiles p on p.id = r.user_id;

revoke all on public.message_reaction_people from anon, public;
grant select on public.message_reaction_people to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Editing a message, for twenty minutes
-- ---------------------------------------------------------------------------
-- The owner: *"we should implement that 'Edit' message too, but only within 20
-- minutes of sending."*
--
-- 0021 said, about unsending: *"Delete, never edit: a message somebody has
-- already read, silently changed afterwards, is worse than one that visibly
-- went away."* That still holds, and this does not break it — because the edit
-- is NOT silent. `edited_at` is set, the chat shows "edited" beside the time,
-- and the window is short enough that an edit lands before most people have
-- read it. Editing without that mark is the thing that stays refused.
alter table public.global_messages
  add column if not exists edited_at timestamptz;

/** How long after sending a message may still be edited. */
create or replace function public.message_edit_window()
returns interval language sql immutable as $$ select interval '20 minutes' $$;

-- Through a function rather than an update policy, and that is the whole point.
--
-- A policy could express "your own, inside twenty minutes" — but an UPDATE
-- reaching the table can set any column the grant allows, including
-- `created_at`. Somebody could move their own message's timestamp forward and
-- edit it for ever. A security definer function writes exactly two columns and
-- there is no other way in, because no update policy exists at all.
create or replace function public.edit_global_message(p_id uuid, p_body text)
returns public.global_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  msg public.global_messages;
  -- NOT called `body`. plpgsql refuses an ambiguous reference by default, and
  -- `set body = body` is exactly that — the column on the left, and either the
  -- column or the variable on the right. It would have failed at run time, on
  -- the first edit anybody tried, with every test still passing.
  new_body text := btrim(p_body);
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

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

revoke execute on function public.edit_global_message(uuid, text) from anon;
grant execute on function public.edit_global_message(uuid, text) to authenticated;

-- `edited_at` added to the chat. Column for column identical to 0024 otherwise,
-- including the hidden-messages filter — spelled out in full rather than
-- patched, so a `create or replace` that disagreed about any other column
-- cannot quietly change what is published.
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
);

revoke all on public.global_chat from anon, public;
grant select on public.global_chat to authenticated;
