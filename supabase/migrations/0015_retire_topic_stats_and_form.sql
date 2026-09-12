-- Phase C — retire two things that were built for a grouping that does not exist.
--
-- ---------------------------------------------------------------------------
-- WHY, MEASURED 2026-09-12 AGAINST THE LIVE DATABASE
--
-- `topic_stats` rolls per-card `topic` labels up into per-topic statistics. It
-- has never had a consumer in the app, and the measurement says it never can:
--
--     cards                        28
--     distinct topic labels        26      <- 1.08 cards per label
--     after normalising            24      <- case, punctuation, articles,
--                                             plurals, word order all folded
--     labels reaching 3 cards       1 of 24
--
--     distinct section_title        3      <- 9.33 cards each
--
-- The model writes a fresh two-to-four word label per card ("Leaf anatomy",
-- "Leaf Function", "Root Absorption"), so every per-topic rate would be
-- computed over a single answer. Normalisation barely helps: 26 -> 24, and only
-- one group clears the three-answer bar the dashboard already requires before
-- it will judge anything. `section_title` is the grouping that works, comes
-- from the document's own headings, and is what the Progress screen uses.
--
-- This confirms the earlier reading recorded in src/core/progress.ts ("17
-- distinct labels for 17 cards") with more cards and with normalisation
-- actually attempted rather than assumed.
--
-- The `topic` COLUMN stays. It costs one text field, it is the raw material if
-- a later phase asks the model to choose from a fixed vocabulary instead of
-- inventing a label, and dropping it would throw away that history for nothing.
-- What goes is the view that pretends the labels can be grouped today.
--
-- `study_items.form` goes for a simpler reason: it is null on every card in the
-- database. It was written on every insert and read by no screen or validator,
-- and the generation schema stopped returning it, so it has been writing null
-- for its whole life.
-- ---------------------------------------------------------------------------
--
-- SAFE TO RUN IN EITHER ORDER with the code change that accompanies it:
--   * src/data/items.ts stopped selecting and writing `form` first, and
--     selecting fewer columns is valid whether or not this has run.
--   * scripts/isolation-test.ts treats a missing `topic_stats` as retired
--     rather than as a failure, so it passes before and after.
--
-- Idempotent: both statements are `if exists`, so running it twice is a no-op.

drop view if exists public.topic_stats;

alter table public.study_items
  drop column if exists form;
