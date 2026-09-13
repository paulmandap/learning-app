-- 0016 — profile pictures, and Nomi's saved conversations (NOTES §36).
--
-- Both at the owner's request, 2026-09-13: "Welcome back, <name>" with a
-- profile picture, a default like Netflix's until one is uploaded; and Nomi as
-- a chat with a history "just like what Claude website does", rather than one
-- question and one answer that are forgotten (which reverses D14 — decided by
-- the owner, recorded in §36).
--
-- SAFE TO APPLY BEFORE OR AFTER THE BUILD THAT USES IT. Nothing is dropped or
-- renamed (§31). The app reads `profiles.avatar` with the same "no such column"
-- fallback it used for `pet`, and treats a missing chat table as "history is not
-- switched on yet" rather than an error.

-- ---------------------------------------------------------------- avatars --

-- NULL: no choice yet; the app shows a default face picked from the user id.
-- 'face:N': one of the built-in faces.
-- 'photo:<user id>/<file>': an uploaded picture in the private `avatars` bucket.
alter table public.profiles
  add column if not exists avatar text;

-- Find any earlier check by what it checks, not by a guessed name (§ HANDOFF:
-- "drop constraint if exists <guessed name>" is a silent no-op).
do $$
declare
  existing text;
begin
  select conname into existing
  from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%avatar%';
  if existing is not null then
    execute format('alter table public.profiles drop constraint %I', existing);
  end if;
end $$;

alter table public.profiles
  add constraint profiles_avatar_check
  check (
    avatar is null
    or avatar ~ '^face:[0-9]{1,2}$'
    or avatar ~ '^photo:[0-9a-f-]{36}/[A-Za-z0-9._-]{1,80}$'
  );

-- PRIVATE, like `documents`: shown through short-lived signed URLs, never a
-- public link. One small picture per person — the app resizes to 256px before
-- uploading, so 1 MB is a ceiling for a mistake, not a budget.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', false, 1048576, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Ownership is the first path segment, exactly as for documents.
drop policy if exists avatars_read_own on storage.objects;
create policy avatars_read_own on storage.objects
  for select using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_insert_own on storage.objects;
create policy avatars_insert_own on storage.objects
  for insert with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_update_own on storage.objects;
create policy avatars_update_own on storage.objects
  for update using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists avatars_delete_own on storage.objects;
create policy avatars_delete_own on storage.objects
  for delete using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ------------------------------------------------------ Nomi conversations --

create table if not exists public.nomi_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  -- Set from the first message, so the history list reads like Claude's.
  title      text not null default '' check (char_length(title) <= 120),
  created_at timestamptz not null default now(),
  -- Bumped by the trigger below whenever a message arrives, so the list can
  -- sort by latest activity without trusting a client clock.
  updated_at timestamptz not null default now()
);

create index if not exists nomi_conversations_user_updated_idx
  on public.nomi_conversations (user_id, updated_at desc);

create table if not exists public.nomi_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.nomi_conversations (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade,
  role            text not null check (role in ('user', 'nomi')),
  content         text not null check (char_length(content) between 1 and 8000),
  created_at      timestamptz not null default now()
);

create index if not exists nomi_messages_conversation_created_idx
  on public.nomi_messages (conversation_id, created_at);

alter table public.nomi_conversations enable row level security;
alter table public.nomi_messages enable row level security;

drop policy if exists "nomi_conversations select own" on public.nomi_conversations;
create policy "nomi_conversations select own" on public.nomi_conversations
  for select using (user_id = auth.uid());

drop policy if exists "nomi_conversations insert own" on public.nomi_conversations;
create policy "nomi_conversations insert own" on public.nomi_conversations
  for insert with check (user_id = auth.uid());

drop policy if exists "nomi_conversations update own" on public.nomi_conversations;
create policy "nomi_conversations update own" on public.nomi_conversations
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "nomi_conversations delete own" on public.nomi_conversations;
create policy "nomi_conversations delete own" on public.nomi_conversations
  for delete using (user_id = auth.uid());

drop policy if exists "nomi_messages select own" on public.nomi_messages;
create policy "nomi_messages select own" on public.nomi_messages
  for select using (user_id = auth.uid());

-- A message may only be written into a conversation its author owns. Checking
-- user_id alone would let someone who learned another person's conversation id
-- write into it under their own name.
drop policy if exists "nomi_messages insert own" on public.nomi_messages;
create policy "nomi_messages insert own" on public.nomi_messages
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.nomi_conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

drop policy if exists "nomi_messages delete own" on public.nomi_messages;
create policy "nomi_messages delete own" on public.nomi_messages
  for delete using (user_id = auth.uid());

-- No update policy on messages, deliberately: a conversation is a record of
-- what was said. Editing is not a feature, and an absent policy is a refusal.

create or replace function public.touch_nomi_conversation()
returns trigger
language plpgsql
as $$
begin
  update public.nomi_conversations
     set updated_at = now()
   where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists nomi_messages_touch_conversation on public.nomi_messages;
create trigger nomi_messages_touch_conversation
  after insert on public.nomi_messages
  for each row execute function public.touch_nomi_conversation();
