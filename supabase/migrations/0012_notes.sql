-- The notebook: notes written IN the app, during class.
--
-- ---------------------------------------------------------------------------
-- WHY THESE ARE NOT DOCUMENTS
--
-- `documents` is for things you UPLOAD: a PDF, a photo, a paste. Each one is
-- attached to a study set, is read once by Gemini, and is finished with. A note
-- is the opposite on every count — it is written a line at a time over an hour,
-- it belongs to the person rather than to a set, and it goes on being edited
-- after cards have been made from it.
--
-- Putting notes in `documents` would mean a row whose extracted text goes stale
-- the moment the student types another sentence, attached to a set that may not
-- exist yet.
-- ---------------------------------------------------------------------------

create table if not exists public.notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null default '',
  body       text not null default '',
  -- The set this note's cards went into, if any.
  --
  -- ON DELETE SET NULL, deliberately. Deleting the study set must never take
  -- the note with it: the cards were generated and can be generated again, but
  -- the note is the student's own writing and is the one thing here that cannot
  -- be reproduced. Same reasoning as "Free up space" keeping every card while
  -- dropping the file it came from.
  study_set_id uuid references public.study_sets (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Newest first is the only order the list is ever read in.
create index if not exists notes_user_updated_idx
  on public.notes (user_id, updated_at desc);

alter table public.notes enable row level security;

drop policy if exists "notes select own" on public.notes;
create policy "notes select own" on public.notes
  for select using (user_id = auth.uid());

drop policy if exists "notes insert own" on public.notes;
create policy "notes insert own" on public.notes
  for insert with check (user_id = auth.uid());

drop policy if exists "notes update own" on public.notes;
create policy "notes update own" on public.notes
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "notes delete own" on public.notes;
create policy "notes delete own" on public.notes
  for delete using (user_id = auth.uid());

-- `updated_at` is what the list sorts by, so it cannot be left to the client:
-- a device with a wrong clock, or a save that forgets to set it, would push a
-- note to the wrong end of the list. A trigger makes it a property of the row
-- rather than a promise from the caller.
create or replace function public.touch_note_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists notes_touch_updated_at on public.notes;
create trigger notes_touch_updated_at
  before update on public.notes
  for each row execute function public.touch_note_updated_at();
