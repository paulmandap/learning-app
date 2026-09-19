-- Three things the owner asked for after a week of using it (NOTES §47):
-- folders for sets, "unsend for you" in the chat, and restoring a broken streak.
--
-- One migration rather than three, because migrations are applied by hand and
-- three pastes is three chances to apply two of them. Nothing here drops or
-- renames anything except the `global_chat` view, which is recreated in the
-- same file — so `scripts/deploy-status.ts` will correctly call this additive
-- and it is safe to apply before or after its deploy. An older build simply
-- does not know the new tables exist.

-- ---------------------------------------------------------------------------
-- 1. Folders, for grouping sets
-- ---------------------------------------------------------------------------
-- The owner: *"it would be cool if the users can add folders and put the
-- flashcards inside the folder for easier groupings and cleaner look."*
--
-- A set belongs to at most ONE folder, and folders do not nest. Both are
-- deliberate: a set in two places is a set you have to look for twice, and a
-- tree needs a navigator, a breadcrumb and a move-to-parent gesture to be
-- usable — which is a file manager, not a study app. Five users with a few
-- dozen sets need one level.
create table if not exists public.folders (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null check (length(btrim(name)) between 1 and 60),
  created_at timestamptz not null default now(),
  -- Two folders called "Anatomy" on one account is a naming mistake, not a
  -- feature. Case-insensitive, so "anatomy" is the same mistake.
  unique (user_id, lower(name))
);

create index if not exists folders_user_idx on public.folders (user_id, created_at);

alter table public.folders enable row level security;
alter table public.folders force row level security;

drop policy if exists folders_select_own on public.folders;
create policy folders_select_own on public.folders
  for select using (user_id = (select auth.uid()));

drop policy if exists folders_insert_own on public.folders;
create policy folders_insert_own on public.folders
  for insert with check (user_id = (select auth.uid()));

drop policy if exists folders_update_own on public.folders;
create policy folders_update_own on public.folders
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists folders_delete_own on public.folders;
create policy folders_delete_own on public.folders
  for delete using (user_id = (select auth.uid()));

-- ############################################################################
-- # `on delete set null`, NOT cascade. A folder is a label, not a container.  #
-- # Deleting a folder must put its sets back on the top level, never delete   #
-- # them — somebody tidying up their groupings would otherwise lose every set #
-- # in the folder, with all its cards, answers and review dates, and find out #
-- # afterwards. This is the single most destructive thing in this file if it  #
-- # is written the other way.                                                 #
-- ############################################################################
alter table public.study_sets
  add column if not exists folder_id uuid references public.folders (id) on delete set null;

create index if not exists study_sets_folder_idx on public.study_sets (folder_id)
  where folder_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Unsend for you
-- ---------------------------------------------------------------------------
-- The owner: *"delete button is just one click, what if i accidentally clicked
-- it? already happened and i got sad"* — so Delete becomes a choice between
-- taking a message off your own screen and taking it back from everyone, and
-- the choice IS the confirmation.
--
-- "For everyone" is the delete that already exists (global_messages_delete_own,
-- 0021) and stays own-messages-only. This table is the other half: a message
-- somebody wants out of their own view, including one SOMEBODY ELSE sent.
create table if not exists public.hidden_messages (
  user_id    uuid not null references auth.users (id) on delete cascade,
  message_id uuid not null references public.global_messages (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, message_id)
);

alter table public.hidden_messages enable row level security;
alter table public.hidden_messages force row level security;

drop policy if exists hidden_messages_select_own on public.hidden_messages;
create policy hidden_messages_select_own on public.hidden_messages
  for select using (user_id = (select auth.uid()));

drop policy if exists hidden_messages_insert_own on public.hidden_messages;
create policy hidden_messages_insert_own on public.hidden_messages
  for insert with check (user_id = (select auth.uid()));

-- Deletable, so hiding something can be undone if that is ever offered. No
-- update policy: there is nothing about a hidden message to change.
drop policy if exists hidden_messages_delete_own on public.hidden_messages;
create policy hidden_messages_delete_own on public.hidden_messages
  for delete using (user_id = (select auth.uid()));

-- The chat, minus what the caller has hidden.
--
-- Filtered HERE rather than in the client for the reason every other filter in
-- this app is: a screen that fetches a message and then decides not to draw it
-- has still fetched it, and the next screen to read this view would have to
-- remember the rule. `auth.uid()` works inside a view that runs as its owner —
-- it reads the request's JWT, not the view owner's identity — which is the same
-- thing `my_schedule` relies on (0021).
--
-- Column for column identical to 0023 apart from the added NOT EXISTS.
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
  m.created_at
from public.global_messages m
left join public.profiles p on p.id = m.user_id
where not exists (
  select 1 from public.hidden_messages h
  where h.message_id = m.id and h.user_id = (select auth.uid())
);

revoke all on public.global_chat from anon, public;
grant select on public.global_chat to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Restoring a broken streak
-- ---------------------------------------------------------------------------
-- The owner: *"i just broke my streak. implement just like tiktok, having the
-- restore streak button. maximum of 5 restore every month, 48 hours between
-- each restore before it expires to start from 0 again."*
--
-- ## Why this is its own table and not a row in study_days
--
-- The tempting version writes a `study_days` row for the missed day so the
-- existing streak sum just works. It would also be a lie: Progress counts days
-- studied and total answers from that table, so a restored day would appear as
-- a day of studying that never happened, and the number people are proudest of
-- would be the one that was not true. `study_days` stays a record of what
-- happened; this records what was forgiven, and `studyStreak` reads both.
create table if not exists public.streak_restores (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- The UTC day that was missed, matching study_days and startOfUtcDay. Three
  -- definitions of "today" in one app would eventually disagree in front of
  -- somebody (0010).
  restored_day date not null,
  created_at   timestamptz not null default now(),
  -- One restore per day, so a double tap forgives one day rather than spending
  -- two of the five.
  unique (user_id, restored_day)
);

create index if not exists streak_restores_user_idx
  on public.streak_restores (user_id, restored_day desc);

alter table public.streak_restores enable row level security;
alter table public.streak_restores force row level security;

drop policy if exists streak_restores_select_own on public.streak_restores;
create policy streak_restores_select_own on public.streak_restores
  for select using (user_id = (select auth.uid()));

-- NO insert policy, deliberately. Every restore goes through the function
-- below, which is the only thing that counts the month's allowance — an insert
-- policy beside it would be a way to have six.
drop policy if exists streak_restores_delete_own on public.streak_restores;
create policy streak_restores_delete_own on public.streak_restores
  for delete using (user_id = (select auth.uid()));

/** How many restores one account gets per calendar month. */
create or replace function public.streak_restore_limit()
returns integer language sql immutable as $$ select 5 $$;

-- Claim one restore, atomically, and say how many are left.
--
-- The same shape and the same reason as `claim_chat_message` (0010): checking
-- the month's count and then inserting is two round trips with a race in the
-- middle, and two taps both read "4 used" and both proceed. Here the count and
-- the insert are one statement.
--
-- Returns how many REMAIN after the claim, or -1 when the month's five are
-- already spent and nothing was written. One integer carries both the verdict
-- and the number the screen wants to show — and the screen must show it, since
-- "restore" that silently did nothing is the worst possible answer to somebody
-- who just lost a streak.
--
-- The 48-hour window is NOT checked here. It is decided by `restorableStreak`
-- in src/core/progress.ts from the days themselves, because the window depends
-- on when the break was, which this function would have to recompute from
-- study_days to know. The database's job is the allowance; the app's job is
-- whether there is anything to restore. A claim for a day that was not missed
-- simply forgives a day that needed no forgiving.
create or replace function public.claim_streak_restore(p_day date)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  used integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  -- Already restored: give back the remaining count rather than an error, so a
  -- double tap is the same as one tap.
  if exists (
    select 1 from public.streak_restores r
    where r.user_id = (select auth.uid()) and r.restored_day = p_day
  ) then
    select count(*) into used
    from public.streak_restores r
    where r.user_id = (select auth.uid())
      and date_trunc('month', r.restored_day) = date_trunc('month', p_day);
    return greatest(public.streak_restore_limit() - used, 0);
  end if;

  select count(*) into used
  from public.streak_restores r
  where r.user_id = (select auth.uid())
    and date_trunc('month', r.restored_day) = date_trunc('month', p_day);

  if used >= public.streak_restore_limit() then
    return -1;
  end if;

  insert into public.streak_restores (user_id, restored_day)
  values ((select auth.uid()), p_day);

  return public.streak_restore_limit() - used - 1;
end;
$$;

revoke execute on function public.claim_streak_restore(date) from anon;
grant execute on function public.claim_streak_restore(date) to authenticated;
