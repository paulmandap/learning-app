-- Phase 8b/8c — variants of missed items, and LLM verification of Apply rubrics.
--
-- Both are the spec's own "Later" list (§6): "LLM verification of Apply-tier
-- rubrics, variants of missed items". Two nullable columns, no new table, no
-- policy changes — study_items already carries RLS from 0002 and these ride on
-- it.

-- ------------------------------------------------------------ variant_prompt --
-- A rephrasing of `prompt`, written after the card has been failed three times
-- (src/core/variant.ts). NULL means it has never been rephrased.
--
-- Additive rather than a rewrite of `prompt`, deliberately:
--   * the original survives, so a bad variant is one UPDATE away from undone;
--   * dedup (jaccard over prompts) and the drop log keep comparing the same
--     text they always did, so a variant cannot make a later card look like a
--     duplicate of something the student never saw;
--   * "has this been rephrased?" is the column being NOT NULL, so a card cannot
--     be rephrased again on its fourth, fifth and sixth lapse.
alter table public.study_items
  add column if not exists variant_prompt text;

-- ----------------------------------------------------------- rubric_verified --
-- D7 postponed a second AI pass, "Apply-tier rubrics only". This records it.
--
--   NULL  = not checked (every existing row, and anything not Apply-tier)
--   true  = a second model pass found every checklist point supported by the
--           cited source
--   false = it did not. A SOFT failure: the card is kept and still usable, and
--           the quiz shows a quiet caution. Dropping it would discard a question
--           over a marking checklist that a person may well disagree with.
--
-- Explicitly NOT excerpt_verified, whose meaning §4 fixes exactly: that the
-- deterministic validator matched the stored excerpt against the stored page
-- text, and nothing more. These are different claims and must not be conflated.
alter table public.study_items
  add column if not exists rubric_verified boolean;

-- Only Apply-tier written answers are ever checked, and the pass looks for the
-- ones not yet done. Partial index so that lookup stays cheap as sets grow.
create index if not exists study_items_rubric_pending_idx
  on public.study_items (study_set_id)
  where rubric_verified is null and level = 'apply' and kind = 'short_answer';
