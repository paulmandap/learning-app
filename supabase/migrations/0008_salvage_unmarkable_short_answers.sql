-- Phase 9a — salvage written answers that can never be marked.
--
-- A DATA fix, not a schema change. It is here rather than in a script because
-- migrations are how SQL reaches this project's database, and because it should
-- run exactly once against each environment.
--
-- ---------------------------------------------------------------------------
-- WHY
--
-- buildGeneratePrompt rule 7 requires a rubric on every "short_answer", and
-- validateItems never checked it. Measured on real stored cards: 2 of 9 written
-- answers (22%) arrived with the rubric missing entirely.
--
-- Those items reach the quiz and dead-end it. gradeAnswer has no checklist to
-- mark against, so app/set/[id]/quiz.tsx shows "This question can't be marked.
-- Skip it for now." — a card that occupies a slot in the deck and gives nothing
-- back, and that would also pollute the Phase 9b progress counts.
--
-- src/core/validate.ts now downgrades these to flashcards at generation time,
-- exactly as it already does for an MCQ that arrives with no options. This
-- statement applies the same salvage to the rows that were stored before that
-- check existed.
--
-- SALVAGED, NOT DELETED: the prompt and answer are a perfectly good pair. Only
-- the marking apparatus is missing, and a flashcard needs none.
-- ---------------------------------------------------------------------------

update public.study_items
set
  kind = 'flashcard',
  -- Nothing reads a rubric on a flashcard, and leaving an empty one behind
  -- would let this statement's own WHERE clause match the row again.
  rubric = null
where
  kind = 'short_answer'
  and (
    rubric is null
    -- The key is absent entirely.
    or rubric -> 'expected_concepts' is null
    -- Present but not a list, so nothing can be counted from it.
    or jsonb_typeof(rubric -> 'expected_concepts') <> 'array'
    -- Present, a list, and empty — as unmarkable as having no rubric at all.
    or jsonb_array_length(rubric -> 'expected_concepts') = 0
  );

-- Re-running this is a no-op: every row it touches stops being a short_answer.
--
-- To see what it changed, run this afterwards — it should return 0:
--
--   select count(*) from public.study_items
--   where kind = 'short_answer'
--     and coalesce(jsonb_array_length(rubric -> 'expected_concepts'), 0) = 0;
