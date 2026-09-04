-- Phase 1 — statistics views (spec §4).
--
-- ############################################################################
-- # security_invoker = true IS LOad-BEARING. DO NOT REMOVE IT.               #
-- #                                                                          #
-- # A Postgres view executes with its OWNER's privileges by default, which   #
-- # bypasses RLS on the tables underneath. Without this setting these two     #
-- # views would happily return every user's rows even though RLS is enabled   #
-- # and correct on attempts and study_items — a cross-user data leak that     #
-- # looks exactly like working code.                                          #
-- #                                                                          #
-- # security_invoker makes the view run as the QUERYING user, so the base     #
-- # tables' policies apply. Requires Postgres 15+, which Supabase provides.   #
-- # scripts/isolation-test.ts queries both views as a second user to prove    #
-- # this holds — testing the base tables alone would pass while these leak.   #
-- ############################################################################

-- Per-item history: how often an item was attempted, how often missed, and how
-- it went last time. Drives the missed pile and retry ordering in Phase 4.
drop view if exists public.item_stats;
create view public.item_stats
  with (security_invoker = true)
as
select
  a.study_item_id,
  a.user_id,
  a.study_set_id,
  count(*)                                            as attempts,
  count(*) filter (where a.result = 'incorrect')       as misses,
  count(*) filter (where a.result = 'partial')         as partials,
  max(a.created_at)                                    as last_attempt_at,
  (array_agg(a.result order by a.created_at desc))[1]  as last_result
from public.attempts a
group by a.study_item_id, a.user_id, a.study_set_id;

-- Per-topic rollup within a set. Drives "concepts hit/missed" in Phase 3.
drop view if exists public.topic_stats;
create view public.topic_stats
  with (security_invoker = true)
as
select
  si.user_id,
  si.study_set_id,
  si.topic,
  count(distinct si.id)                                as items,
  count(a.id)                                          as attempts,
  count(a.id) filter (where a.result = 'incorrect')     as misses,
  count(a.id) filter (where a.result = 'correct')       as corrects
from public.study_items si
left join public.attempts a on a.study_item_id = si.id
where si.hidden = false
group by si.user_id, si.study_set_id, si.topic;
