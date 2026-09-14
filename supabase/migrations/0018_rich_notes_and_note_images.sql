-- Rich notes and pictures in notes (NOTES §43).
--
-- The owner: *"in the notes, i think it will be good as well if it can handle
-- more than just a plain text, like bullet, bold … just like notion's features
-- in notes. adding image is good too."* They chose a Notion-style editor, and
-- pictures in notes together with cards made from them.
--
-- ADDITIVE ONLY: one new column, one new bucket, four policies. Safe to apply
-- before or after the code that uses them is deployed — the app reads the
-- column only when it exists and says pictures are not switched on until the
-- bucket does. (Contrast 0015, which dropped a column and took production down;
-- NOTES §31.)
--
-- ---------------------------------------------------------------------------
-- 1. A note's formatted content, as the editor's own document (JSON).
--
-- `body` STAYS, and stays the plain text of the note. It is what cards are made
-- from, what the Notes list previews, and what a word count counts, so every
-- one of those keeps working unchanged. The app writes both on every save,
-- deriving `body` from `content`. A note saved before this migration has no
-- `content` and opens from its `body`.
-- ---------------------------------------------------------------------------

alter table public.notes add column if not exists content jsonb;

-- ---------------------------------------------------------------------------
-- 2. Pictures in notes: a private bucket, one folder per person.
--
-- Private, like `documents` and `avatars`: a picture is shown through a
-- short-lived signed link, never a public one. The app shrinks a picture on the
-- phone before uploading it, so 5 MB is a ceiling for a mistake, not a budget.
-- Paths are `<user id>/<note id>/<file>`; ownership is the first segment,
-- exactly as for the other two buckets.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', false, 5242880, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists note_images_read_own on storage.objects;
create policy note_images_read_own on storage.objects
  for select using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists note_images_insert_own on storage.objects;
create policy note_images_insert_own on storage.objects
  for insert with check (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists note_images_update_own on storage.objects;
create policy note_images_update_own on storage.objects
  for update using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists note_images_delete_own on storage.objects;
create policy note_images_delete_own on storage.objects
  for delete using (
    bucket_id = 'note-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );
