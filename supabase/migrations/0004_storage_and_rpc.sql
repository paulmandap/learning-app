-- Phase 1 — private storage bucket, its policies, and the keepalive RPC.

-- ------------------------------------------------------- documents bucket --
-- PRIVATE. Originals are served through short-lived signed URLs, never public
-- links. Path convention: {user_id}/{document_id}/{filename}
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do update set public = false;

-- Ownership is the first path segment. (storage.foldername(name))[1] is the
-- user id, so a user can only touch objects under their own prefix.
drop policy if exists documents_read_own on storage.objects;
create policy documents_read_own on storage.objects
  for select using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists documents_insert_own on storage.objects;
create policy documents_insert_own on storage.objects
  for insert with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists documents_update_own on storage.objects;
create policy documents_update_own on storage.objects
  for update using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists documents_delete_own on storage.objects;
create policy documents_delete_own on storage.objects
  for delete using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ------------------------------------------------------------ keepalive RPC --
-- Supabase Free pauses a project after ~7 days of low DATABASE activity, and
-- restoring is manual. A URL ping does not count — this must be a real write.
--
-- SECURITY DEFINER so the caller needs no direct write grant on heartbeat
-- (which has RLS on and no policies). search_path is pinned to defeat
-- search-path hijacking, which is the standard footgun with definer functions.
--
-- It writes a timestamp and nothing else: no user data, no arguments, nothing
-- an attacker could use it to reach.
create or replace function public.touch_heartbeat()
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  written timestamptz;
begin
  insert into public.heartbeat (ts) values (now())
  returning ts into written;

  -- Keep the table from growing without bound; this runs every 3 days.
  delete from public.heartbeat
  where id < (select max(id) - 50 from public.heartbeat);

  return written;
end;
$$;

revoke all on function public.touch_heartbeat() from public;
grant execute on function public.touch_heartbeat() to anon, authenticated;

-- ----------------------------------------------- profile bootstrap trigger --
-- Create the profiles row when a user signs up, so the app never has to guess
-- whether one exists before saving a Gemini key.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
