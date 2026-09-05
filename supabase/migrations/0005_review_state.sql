-- Phase 6 — spaced repetition schedule.
--
-- D8 chose to "log every attempt + missed pile from day one, scheduling later".
-- attempts already records WHAT happened; this records WHEN each card is next
-- due. One row per study item per user.
--
-- Table, RLS and index together in one file rather than split across three, as
-- 0001-0003 do: a new table with RLS is a new place to leak, and a policy that
-- lands in a later migration is a window in which it does. Nothing here is
-- separable for review anyway.

-- ------------------------------------------------------------ review_state --
create table if not exists public.review_state (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  -- UNIQUE: a card has exactly one schedule. This is also what makes the write
  -- path an upsert with a clean conflict target rather than a read-then-write
  -- race between two tabs.
  study_item_id uuid not null unique references public.study_items (id) on delete cascade,
  study_set_id  uuid not null references public.study_sets (id) on delete cascade,

  -- Epoch-day boundary in UTC (see src/core/schedule.ts). Stored as timestamptz
  -- so Postgres can compare it directly in a due-today query.
  due_at        timestamptz not null,
  interval_days integer     not null default 0 check (interval_days >= 0),
  -- Bounds mirror MIN_EASE/MAX_EASE. A constraint rather than a comment because
  -- an ease outside this range means the scheduler is broken, and a card whose
  -- ease has run away is unreachable forever.
  ease          numeric     not null default 2.5 check (ease >= 1.3 and ease <= 2.8),
  reps          integer     not null default 0 check (reps >= 0),
  lapses        integer     not null default 0 check (lapses >= 0),
  last_result   text        check (last_result in ('correct', 'partial', 'incorrect')),
  updated_at    timestamptz not null default now()
);

-- The query this table exists to serve: "what is due for me, soonest first".
create index if not exists review_state_due_idx
  on public.review_state (user_id, due_at);
-- And the per-set version, for a set's own due count.
create index if not exists review_state_set_due_idx
  on public.review_state (study_set_id, due_at);

-- -------------------------------------------------------------------- RLS --
-- Same shape as every other user-scoped table in 0002: user_id = auth.uid(),
-- applied to each operation separately, with `with check` on the write paths so
-- a user cannot create or move a row onto someone else.
alter table public.review_state enable row level security;
alter table public.review_state force row level security;

drop policy if exists review_state_select_own on public.review_state;
create policy review_state_select_own on public.review_state
  for select using (user_id = (select auth.uid()));

drop policy if exists review_state_insert_own on public.review_state;
create policy review_state_insert_own on public.review_state
  for insert with check (user_id = (select auth.uid()));

drop policy if exists review_state_update_own on public.review_state;
create policy review_state_update_own on public.review_state
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists review_state_delete_own on public.review_state;
create policy review_state_delete_own on public.review_state
  for delete using (user_id = (select auth.uid()));
