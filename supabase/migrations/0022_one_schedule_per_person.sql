-- Retire "one schedule per card" in favour of "one schedule per card PER PERSON".
--
-- ############################################################################
-- # DO NOT APPLY THIS UNTIL THE CODE FROM 0021 IS LIVE IN PRODUCTION.        #
-- #                                                                          #
-- # Check first, and the script says so in as many words:                    #
-- #   npx tsx --env-file=.env scripts/deploy-status.ts                        #
-- #                                                                          #
-- # What it needs to be true: the deployed bundle upserts review_state on     #
-- # (user_id, study_item_id). Until it does, the deployed bundle is asking    #
-- # PostgREST for `on_conflict=study_item_id`, and the single-column unique   #
-- # constraint dropped below is the only thing that can satisfy it. Drop it   #
-- # early and Postgres answers 42P10 — "no unique or exclusion constraint     #
-- # matching the ON CONFLICT specification" — for EVERY answer in the app, on #
-- # every set, shared or not. Nothing would be scheduled again until either   #
-- # the deploy caught up or this was reversed.                                #
-- #                                                                          #
-- # This is the 2026-09-12 shape exactly (NOTES §31): 0015 dropped            #
-- # study_items.form, the code that stopped selecting it was committed six    #
-- # days before it was deployed, and production answered 42703 for every deck #
-- # in the gap. "Safe to run in either order" means DEPLOY order, not commit  #
-- # order. The gap here is smaller and sharper, not absent.                   #
-- #                                                                          #
-- # If it is applied early: redeploy the current build, or re-add the old     #
-- # constraint. Re-adding it succeeds only while no two accounts have         #
-- # scheduled the same card, so do it promptly.                               #
-- ############################################################################
--
-- Why the change at all: 0005 made study_item_id globally unique, on the then
-- true premise that every card belonged to exactly one person. Sets shared with
-- everyone (0021) are studied in place, so two people answer one card and each
-- needs their own due date, interval, ease and lapse count. Under the old
-- constraint the second person's upsert targets a row RLS hides from them: it
-- is refused or it writes nothing, and src/data/review.ts never reads the result
-- of that upsert, so the app would have carried on cheerfully scheduling nothing.
--
-- 0021 already added `unique (user_id, study_item_id)`. This file removes only
-- what it replaces. The wider constraint covers every lookup the old one served:
-- currentState() filters by study_item_id under RLS, which also constrains
-- user_id, so the planner has a leading column and the dropped implicit index is
-- not missed.

do $$
declare
  old_name text;
begin
  -- Found by WHAT IT CHECKS, not by a guessed name. `drop constraint if exists
  -- review_state_study_item_id_key` would be a silent no-op against a
  -- differently named constraint and would leave it in force — the app would
  -- then still refuse a second person's schedule and this migration would
  -- report success (HANDOFF, "Postgres, PostgREST and migrations").
  select conname into old_name
  from pg_constraint
  where conrelid = 'public.review_state'::regclass
    and contype = 'u'
    and conkey = array[
      (select attnum from pg_attribute
        where attrelid = 'public.review_state'::regclass and attname = 'study_item_id')
    ]::smallint[];

  if old_name is null then
    raise notice 'No single-column unique on review_state.study_item_id; nothing to drop.';
  else
    -- Refuse to leave the table with no unique at all. If 0021 was skipped,
    -- dropping this would let one person accumulate several schedules for one
    -- card, and reviewStatesForSet builds a Map keyed by study_item_id — the
    -- duplicates would not error, they would just silently pick one.
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.review_state'::regclass
        and contype = 'u'
        and (select array_agg(k order by k) from unnest(conkey) as k)
          = (select array_agg(attnum order by attnum) from pg_attribute
             where attrelid = 'public.review_state'::regclass
               and attname in ('user_id', 'study_item_id'))
    ) then
      raise exception 'Apply 0021 first: review_state has no unique on (user_id, study_item_id), so dropping % would leave one person able to hold several schedules for one card.', old_name;
    end if;

    execute format('alter table public.review_state drop constraint %I', old_name);
    raise notice 'Dropped %; (user_id, study_item_id) is now the schedule key.', old_name;
  end if;
end $$;
