-- The space figure was under-reporting, and this is why.
--
-- ---------------------------------------------------------------------------
-- 0009 ADDED THE COLUMN AND NEVER FILLED IT IN
--
-- `documents.byte_size` is written by `uploadOriginal` and nowhere else, so
-- every file uploaded BEFORE 0009 landed (2026-09-05) has it null. The usage
-- total sums the column and treats null as zero, which means months of real
-- uploads count for nothing: the owner's dashboard could say "Nothing stored
-- yet" while the bucket held a stack of PDFs.
--
-- The comment on `storageUsedBytes` claimed the sizes "are not recoverable",
-- and that is true from the browser: PostgREST does not expose the storage
-- schema. It is NOT true from here. Supabase records the real byte count on
-- every object it stores, in `storage.objects.metadata->>'size'`, and
-- `documents.storage_path` is exactly that object's name inside the bucket.
--
-- So this is a recovery, not an estimate.
-- ---------------------------------------------------------------------------

update public.documents d
   set byte_size = (o.metadata ->> 'size')::bigint
  from storage.objects o
 where o.bucket_id = 'documents'
   and o.name = d.storage_path
   and d.storage_path is not null
   -- Only the gaps. Anything uploaded since 0009 already carries the size the
   -- browser measured, and re-writing it from storage would be a second source
   -- of truth for no gain. Also what makes this safe to run twice.
   and d.byte_size is null
   and (o.metadata ->> 'size') is not null;

-- ---------------------------------------------------------------------------
-- WHAT SHOULD BE LEFT AFTER THIS
--
-- Rows still null are documents whose file is genuinely gone from the bucket —
-- "Free up space" nulls both `storage_path` and `byte_size` together, so those
-- are correct at null and correct at zero. Anything with a storage_path but no
-- byte_size after this ran would be a real orphan and worth looking at.
--
--   select count(*) filter (where storage_path is not null and byte_size is null)
--            as orphans,
--          count(*) filter (where byte_size is not null) as sized,
--          pg_size_pretty(sum(byte_size)) as total
--     from public.documents;
-- ---------------------------------------------------------------------------
