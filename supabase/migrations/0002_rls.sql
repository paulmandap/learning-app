-- Phase 1 — Row Level Security (spec §4).
--
-- RLS on EVERY table. No client-side filtering is trusted for authorisation:
-- the client may ask for anything; the database decides what it gets.
--
-- Every user-scoped policy is the same shape — user_id = auth.uid() — applied
-- to select, insert, update and delete separately. `with check` is set on
-- insert/update so a user cannot write a row belonging to someone else.

-- ---------------------------------------------------------------- profiles --
alter table public.profiles enable row level security;
alter table public.profiles force row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = (select auth.uid()));

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert with check (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists profiles_delete_own on public.profiles;
create policy profiles_delete_own on public.profiles
  for delete using (id = (select auth.uid()));

-- ------------------------------------------------------------- study_sets --
alter table public.study_sets enable row level security;
alter table public.study_sets force row level security;

drop policy if exists study_sets_select_own on public.study_sets;
create policy study_sets_select_own on public.study_sets
  for select using (user_id = (select auth.uid()));

drop policy if exists study_sets_insert_own on public.study_sets;
create policy study_sets_insert_own on public.study_sets
  for insert with check (user_id = (select auth.uid()));

drop policy if exists study_sets_update_own on public.study_sets;
create policy study_sets_update_own on public.study_sets
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists study_sets_delete_own on public.study_sets;
create policy study_sets_delete_own on public.study_sets
  for delete using (user_id = (select auth.uid()));

-- --------------------------------------------------------------- documents --
alter table public.documents enable row level security;
alter table public.documents force row level security;

drop policy if exists documents_select_own on public.documents;
create policy documents_select_own on public.documents
  for select using (user_id = (select auth.uid()));

drop policy if exists documents_insert_own on public.documents;
create policy documents_insert_own on public.documents
  for insert with check (user_id = (select auth.uid()));

drop policy if exists documents_update_own on public.documents;
create policy documents_update_own on public.documents
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists documents_delete_own on public.documents;
create policy documents_delete_own on public.documents
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------- document_pages --
alter table public.document_pages enable row level security;
alter table public.document_pages force row level security;

drop policy if exists document_pages_select_own on public.document_pages;
create policy document_pages_select_own on public.document_pages
  for select using (user_id = (select auth.uid()));

drop policy if exists document_pages_insert_own on public.document_pages;
create policy document_pages_insert_own on public.document_pages
  for insert with check (user_id = (select auth.uid()));

drop policy if exists document_pages_update_own on public.document_pages;
create policy document_pages_update_own on public.document_pages
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists document_pages_delete_own on public.document_pages;
create policy document_pages_delete_own on public.document_pages
  for delete using (user_id = (select auth.uid()));

-- ------------------------------------------------------------- study_items --
alter table public.study_items enable row level security;
alter table public.study_items force row level security;

drop policy if exists study_items_select_own on public.study_items;
create policy study_items_select_own on public.study_items
  for select using (user_id = (select auth.uid()));

drop policy if exists study_items_insert_own on public.study_items;
create policy study_items_insert_own on public.study_items
  for insert with check (user_id = (select auth.uid()));

drop policy if exists study_items_update_own on public.study_items;
create policy study_items_update_own on public.study_items
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists study_items_delete_own on public.study_items;
create policy study_items_delete_own on public.study_items
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------- attempts --
alter table public.attempts enable row level security;
alter table public.attempts force row level security;

drop policy if exists attempts_select_own on public.attempts;
create policy attempts_select_own on public.attempts
  for select using (user_id = (select auth.uid()));

drop policy if exists attempts_insert_own on public.attempts;
create policy attempts_insert_own on public.attempts
  for insert with check (user_id = (select auth.uid()));

drop policy if exists attempts_update_own on public.attempts;
create policy attempts_update_own on public.attempts
  for update using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

drop policy if exists attempts_delete_own on public.attempts;
create policy attempts_delete_own on public.attempts
  for delete using (user_id = (select auth.uid()));

-- --------------------------------------------------------------- heartbeat --
-- RLS on with NO policies: every direct client operation is denied. The only
-- way in is the security-definer RPC in 0004, which is the point — a keepalive
-- must not double as an open write endpoint.
alter table public.heartbeat enable row level security;
