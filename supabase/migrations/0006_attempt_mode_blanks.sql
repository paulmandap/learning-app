-- Phase 8 — fill-in-the-blank becomes a third way to answer a card.
--
-- attempts.mode records HOW a card was answered, and 0001 constrained it to
-- ('flashcards', 'quiz'). Blanks are a third: the same study_items rows, shown
-- as a sentence from the notes with a gap in it and answered by typing.
--
-- Recording them as 'flashcards' would have avoided this file and been a lie in
-- the data — the two are graded differently (self-report on a flip, typed and
-- string-compared here), and a later question about how well typed recall works
-- would have no way to separate them.
--
-- Nothing reads mode today except as a record, so this is additive and safe to
-- apply at any time. Until it IS applied, src/data/attempts.ts falls back to
-- writing 'flashcards' rather than losing the answer; see the note there, which
-- names this migration as the condition for deleting that fallback.

-- A check constraint cannot be extended in place, so it is dropped and rebuilt.
--
-- The old one is found by what it CHECKS rather than by name. 0001 wrote it
-- inline, so Postgres named it, and `drop constraint if exists <guess>` would
-- be a silent no-op if the guess were wrong — leaving the old constraint in
-- place, still rejecting 'blanks', while this migration reported success. That
-- failure mode is invisible from the dashboard, which is where this gets run.
do $$
declare
  c record;
begin
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.attempts'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%mode%'
  loop
    execute format('alter table public.attempts drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.attempts
  add constraint attempts_mode_check
  check (mode in ('flashcards', 'quiz', 'blanks'));
