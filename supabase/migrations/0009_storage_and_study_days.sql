-- Phase 9b — storage accounting, and a study record that outlives the cards.
--
-- Two changes, one file, because they answer the same question: what happens
-- when a student runs out of space and tidies up?

-- ------------------------------------------------------- documents.byte_size --
-- How large the stored original is.
--
-- Supabase Free gives 1 GB of file storage for the WHOLE project, shared by
-- every user (ARCHITECTURE_NOTES.md §2.5), and a scanned PDF is easily 20-50 MB.
-- Without a per-user allowance the bucket fills and the next person to add notes
-- gets an error caused by somebody else's uploads.
--
-- Recorded here rather than counted from storage.objects because a per-user
-- total then costs one `sum` instead of walking every {user}/{document}/ prefix
-- in the bucket. src/core/storage.ts holds the limits and the arithmetic.
--
-- NULL means "uploaded before this column existed", and is treated as 0 rather
-- than backfilled: the sizes are not recoverable through PostgREST, and a wrong
-- number would be worse than a missing one.
alter table public.documents
  add column if not exists byte_size bigint check (byte_size is null or byte_size >= 0);

-- ---------------------------------------------------------------- study_days --
-- One row per user per day they studied. Deliberately holds nothing else.
--
-- WHY THIS EXISTS: `attempts` cascades from study_sets, so deleting a set
-- deletes its answers — and with them the days those answers happened on. A
-- student who tidied up to free space would watch their streak reset for having
-- been tidy, which is both demoralising and untrue.
--
-- So the streak reads from here instead. This table references auth.users and
-- NOTHING ELSE: no set, no item, nothing that can cascade. That is the entire
-- design, and any future column pointing at study material would undo it.
--
-- It is also cheaper than what it replaces: counting distinct days previously
-- meant pulling every attempt row the account had ever recorded.
create table if not exists public.study_days (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- A UTC date, matching startOfUtcDay in src/core/schedule.ts. Local dates
  -- would disagree with the due-date arithmetic sitting beside it on screen.
  day     date not null,
  answers integer not null default 0 check (answers >= 0),
  unique (user_id, day)
);

create index if not exists study_days_user_day_idx
  on public.study_days (user_id, day desc);

alter table public.study_days enable row level security;

-- Same four policies every other table carries. A new table is a new place to
-- leak, so they live in this file rather than a later one.
drop policy if exists "study_days select own" on public.study_days;
create policy "study_days select own" on public.study_days
  for select using (user_id = auth.uid());

drop policy if exists "study_days insert own" on public.study_days;
create policy "study_days insert own" on public.study_days
  for insert with check (user_id = auth.uid());

drop policy if exists "study_days update own" on public.study_days;
create policy "study_days update own" on public.study_days
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "study_days delete own" on public.study_days;
create policy "study_days delete own" on public.study_days
  for delete using (user_id = auth.uid());

-- Increment today's count in one round trip.
--
-- PostgREST cannot express `answers = answers + 1` in an upsert, and a
-- read-then-write from the client would race between two tabs. An RPC keeps it
-- atomic. Follows touch_heartbeat (0004), except that this one is deliberately
-- NOT security definer: a user only ever touches their own row, so ordinary RLS
-- is exactly the right authorisation and there is no reason to step around it.
create or replace function public.touch_study_day()
returns void
language sql
as $$
  insert into public.study_days (user_id, day, answers)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day)
    do update set answers = public.study_days.answers + 1;
$$;

-- Backfill from the answers that still exist, so nobody's existing streak is
-- reset by the migration that was meant to protect it. Runs as the migration
-- executor and therefore sees every user; that is what makes a backfill work,
-- and it is why this statement belongs in a migration rather than in the app.
insert into public.study_days (user_id, day, answers)
select
  user_id,
  (created_at at time zone 'utc')::date as day,
  count(*)
from public.attempts
group by 1, 2
on conflict (user_id, day) do update set answers = excluded.answers;
