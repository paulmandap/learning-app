-- Community — sets shared with everyone, stars, a ranking, and a global chat.
--
-- ############################################################################
-- # THIS IS THE FIRST MIGRATION THAT LETS ONE ACCOUNT READ ANOTHER'S DATA.   #
-- #                                                                          #
-- # Every table in this app has been `user_id = auth.uid()` since 0002, and  #
-- # scripts/isolation-test.ts exists to prove nothing crosses between        #
-- # accounts. That guarantee is not being weakened here — it is being made   #
-- # NARROWER AND EXPLICIT. Read the two rules before changing anything:      #
-- #                                                                          #
-- # 1. NO POLICY ON A BASE TABLE IS RELAXED. Not one. study_sets,            #
-- #    study_items, profiles and the rest keep select-own exactly as 0002    #
-- #    wrote them. This is deliberate and it is load-bearing: a permissive    #
-- #    "or the set is public" policy on study_items would have silently       #
-- #    widened every query in the app that trusts RLS as its only filter.     #
-- #    src/data/dashboard.ts reads `study_items` with NO user filter, so      #
-- #    Progress would have begun counting other people's cards as yours, with #
-- #    nothing anywhere to say so.                                            #
-- #                                                                          #
-- # 2. CROSS-USER READS HAPPEN ONLY THROUGH THE FOUR VIEWS BELOW, each of    #
-- #    which runs as its OWNER (no security_invoker) and therefore bypasses   #
-- #    RLS entirely. That is the point of them and it is also the danger: a   #
-- #    wrong WHERE clause here leaks everything, and it looks like working    #
-- #    code. Each view states exactly what it exposes and what it must never  #
-- #    expose, and scripts/isolation-test.ts asserts BOTH halves — that B     #
-- #    sees A's public set, and that B still cannot see A's private one, A's  #
-- #    Gemini key, or A's uploaded photo.                                     #
-- #                                                                          #
-- # 0003 has the opposite warning on item_stats and topic_stats, where        #
-- # security_invoker IS the safety. Both warnings are correct. The difference #
-- # is that those views serve you your own history, and these four serve you  #
-- # other people's on purpose.                                                #
-- ############################################################################
--
-- Additive only: no column, constraint, view or policy is dropped. It is
-- therefore safe to apply BEFORE the code that uses it is deployed, which is
-- the order NOTES §31 exists to enforce. The one drop this feature needs —
-- review_state's old single-column unique — is held back to 0022, to be applied
-- only once the code below is live. See the note at the bottom.

-- ---------------------------------------------------------------------------
-- 1. A set can be shared with everyone
-- ---------------------------------------------------------------------------
-- 'private' is the default and every existing row gets it, so applying this
-- migration publishes nothing. Sharing is only ever an explicit act.
--
-- Sharing is per SET, not per card. A card's excerpt only means anything beside
-- the rest of the set it was made from, and "where every answer came from" is
-- the product's promise — a card shared alone would arrive with a source chip
-- pointing at notes nobody can see.
alter table public.study_sets
  add column if not exists visibility text not null default 'private';

-- Named, so 0022 and any future migration can find it by name rather than
-- guessing one. A `drop constraint if exists <guessed name>` is a silent no-op
-- that leaves the old constraint in force.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.study_sets'::regclass
      and conname = 'study_sets_visibility_check'
  ) then
    alter table public.study_sets
      add constraint study_sets_visibility_check
      check (visibility in ('private', 'public'));
  end if;
end $$;

-- When it was FIRST shared. Used to break ties in the ranking, so that two sets
-- on the same number of stars are ordered by which earned them first rather
-- than by whatever order the planner happened to return.
alter table public.study_sets
  add column if not exists published_at timestamptz;

-- The ranking and the browse list both read "every public set". With five users
-- this is a sequential scan either way; the index is here so it stays cheap if
-- that ever stops being true.
create index if not exists study_sets_public_idx
  on public.study_sets (visibility, published_at desc)
  where visibility = 'public';

-- ---------------------------------------------------------------------------
-- 2. Helpers — the only places that are allowed to see across accounts
-- ---------------------------------------------------------------------------
-- A policy's subquery runs as the QUERYING user, so `exists (select 1 from
-- study_sets where id = … and visibility = 'public')` inside a policy would be
-- filtered by study_sets' own select-own policy and could never be true for
-- someone else's set. Measured the hard way in every project that has tried it.
-- These two functions are security definer precisely so a policy can ask a
-- question about a row the asker cannot read.
--
-- They return a boolean or a uuid and nothing else. Neither returns set
-- contents, so neither is a way to read a row through the back door.

create or replace function public.is_public_set(set_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.study_sets s
    where s.id = set_id and s.visibility = 'public'
  );
$$;

-- Can the caller star this set? Public, and not their own.
--
-- Self-starring is refused rather than merely discouraged. With five users a
-- ranking where everyone starts on one star of their own says nothing, and a
-- rule enforced by the database cannot be forgotten by a screen.
create or replace function public.can_star_set(set_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.study_sets s
    where s.id = set_id
      and s.visibility = 'public'
      and s.user_id <> (select auth.uid())
  );
$$;

revoke execute on function public.is_public_set(uuid) from anon;
revoke execute on function public.can_star_set(uuid) from anon;
grant execute on function public.is_public_set(uuid) to authenticated;
grant execute on function public.can_star_set(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Stars
-- ---------------------------------------------------------------------------
-- One star per person per set — the unique constraint is what makes a count of
-- this table a count of PEOPLE rather than a count of taps.
create table if not exists public.set_stars (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  study_set_id uuid not null references public.study_sets (id) on delete cascade,
  created_at   timestamptz not null default now(),
  unique (user_id, study_set_id)
);

create index if not exists set_stars_set_idx on public.set_stars (study_set_id);

alter table public.set_stars enable row level security;
alter table public.set_stars force row level security;

-- SELECT IS OWN-ONLY, AND THAT IS NOT AN OVERSIGHT.
--
-- A screen needs two things: how many stars a set has, and whether I starred it.
-- The first comes from public_sets below, which counts as its owner. The second
-- is this policy. Nobody can list WHO starred what — a five-person app where
-- everyone can see who did and did not star their set is a worse place to
-- share anything.
drop policy if exists set_stars_select_own on public.set_stars;
create policy set_stars_select_own on public.set_stars
  for select using (user_id = (select auth.uid()));

drop policy if exists set_stars_insert_own on public.set_stars;
create policy set_stars_insert_own on public.set_stars
  for insert with check (
    user_id = (select auth.uid()) and public.can_star_set(study_set_id)
  );

-- No update policy, deliberately: a star has nothing to change. Unstarring is a
-- delete.
drop policy if exists set_stars_delete_own on public.set_stars;
create policy set_stars_delete_own on public.set_stars
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 4. The global chat
-- ---------------------------------------------------------------------------
-- Human to human. No model is called and no Gemini quota is spent here, which
-- is why it has its own table and its own limit rather than sharing chat_usage
-- with Nomi — that cap exists to stop an afternoon of chatting costing someone
-- their cards, and this cannot.
create table if not exists public.global_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists global_messages_recent_idx
  on public.global_messages (created_at desc);
-- For the rate limit below, which counts one person's last minute.
create index if not exists global_messages_user_recent_idx
  on public.global_messages (user_id, created_at desc);

alter table public.global_messages enable row level security;
alter table public.global_messages force row level security;

-- The one place in this schema where a signed-in user reads rows that are not
-- theirs, on a base table. It is safe because the table holds nothing but what
-- people deliberately said to each other in a room they knew was shared — there
-- is no private column here to leak.
--
-- Signed in only. `auth.uid() is not null` rather than granting to anon: the app
-- has no signed-out screens, and a chat readable by the open internet is a
-- different product with different obligations.
drop policy if exists global_messages_select_signed_in on public.global_messages;
create policy global_messages_select_signed_in on public.global_messages
  for select using ((select auth.uid()) is not null);

-- Inserts go through send_global_message below, which is where the rate limit
-- lives. This policy still exists because a direct insert must not be a way
-- around the length check, and because RLS with no insert policy would refuse
-- the definer function's write as well.
drop policy if exists global_messages_insert_own on public.global_messages;
create policy global_messages_insert_own on public.global_messages
  for insert with check (user_id = (select auth.uid()));

-- You can take back what you said. You cannot edit it: a message someone has
-- already read, silently changed afterwards, is worse than one deleted in view.
drop policy if exists global_messages_delete_own on public.global_messages;
create policy global_messages_delete_own on public.global_messages
  for delete using (user_id = (select auth.uid()));

-- Send one message, with the limit enforced in the same statement that writes.
--
-- Same reasoning as claim_chat_message in 0010: check-then-write from the client
-- is two round trips with a race in the middle, and two tabs both pass the check.
-- Here the count and the insert are one statement, so the eleventh message in a
-- minute is refused exactly once.
--
-- Raises rather than returning a code, because unlike the Gemini cap there is no
-- number for a screen to show — "slow down a moment" is the whole message.
create or replace function public.send_global_message(message text)
returns public.global_messages
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  sent integer;
  row  public.global_messages;
begin
  if (select auth.uid()) is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select count(*) into sent
  from public.global_messages m
  where m.user_id = (select auth.uid())
    and m.created_at > now() - interval '1 minute';

  if sent >= 10 then
    raise exception 'Too many messages in a minute.' using errcode = 'P0001';
  end if;

  insert into public.global_messages (user_id, body)
  values ((select auth.uid()), btrim(message))
  returning * into row;

  return row;
end;
$$;

revoke execute on function public.send_global_message(text) from anon;
grant execute on function public.send_global_message(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. The four cross-user views
-- ---------------------------------------------------------------------------
-- Each one runs as its owner and bypasses RLS. Read the header of this file
-- before touching any of them. `security_barrier` stops a cheap user-supplied
-- function being evaluated before the view's own WHERE clause, which is how a
-- filtered view is normally tricked into showing rows it filtered out.
--
-- ## The assumption underneath all four, and how it is checked
--
-- Every base table here carries `force row level security`, which makes RLS
-- apply to the table's owner as well. These views therefore only see across
-- accounts because the role that owns them — `postgres`, the role the dashboard
-- SQL editor runs as — holds BYPASSRLS. The evidence that it does is already in
-- this project: HANDOFF records that `auth.uid()` is NULL in the dashboard SQL
-- editor, and the owner reads every user's rows there daily. Were postgres
-- subject to these policies with a NULL uid, every table would look empty to
-- him and no migration could ever have been verified.
--
-- It is still an assumption, so it is not left to reasoning:
-- scripts/isolation-test.ts asserts the POSITIVE direction — that B genuinely
-- does see A's shared set through public_sets, and its cards through
-- public_set_items. If BYPASSRLS were ever not true, these views would return
-- nothing at all and that assertion fails loudly, rather than the feature
-- quietly showing an empty Community tab that looks like "nobody has shared
-- anything yet".
--
-- CREATE THESE AS `postgres`. Pasting this file into the dashboard SQL editor
-- does that. Creating them as any other role silently changes who they run as.

-- --------------------------------------------------------- public_profiles --
-- Who somebody is, to everybody else: their chosen name and their drawn face.
--
-- MUST NEVER EXPOSE: gemini_api_key (a credential), privacy_accepted_at, or an
-- uploaded photo's path. The photo is the subtle one. `profiles.avatar` holds
-- either 'face:N' or 'photo:<user id>/<file>' (src/core/avatar.ts), and the
-- photo lives in the PRIVATE avatars bucket. Passing the raw column through
-- would publish the storage path of every uploaded picture in the app, so the
-- CASE below lets only a face through and turns everything else into null.
-- Null is not a failure: src/core/avatar.ts draws a default face derived from
-- the user id, stable for that person, which is exactly what is wanted here.
--
-- So: you can see the name someone chose and a face. You cannot see the photo
-- they uploaded of themselves, and nothing in this app will show it to anyone.
drop view if exists public.public_profiles;
create view public.public_profiles
  with (security_barrier = true)
as
select
  p.id,
  p.display_name,
  case when p.avatar like 'face:%' then p.avatar else null end as avatar
from public.profiles p;

-- ------------------------------------------------------------- public_sets --
-- The browse list and the ranking, in one relation.
--
-- Star and card counts are computed HERE, as the view's owner, for two reasons.
-- Counting stars needs to see rows set_stars' own policy hides (that policy is
-- own-only on purpose, section 3), and PostgREST cannot ORDER BY an embedded
-- aggregate — so a ranking by stars has to have the number in a column it can
-- sort on. Denormalising a star_count onto study_sets with a trigger would do
-- the same job and would eventually drift from the rows it counts; this cannot.
--
-- MUST NEVER EXPOSE: `plan` (the generation plan, which quotes the owner's
-- notes) or anything from documents. The column list is explicit rather than
-- `s.*` for exactly that reason — a later `alter table study_sets add column`
-- must not silently join the public part of this app.
drop view if exists public.public_sets;
create view public.public_sets
  with (security_barrier = true)
as
select
  s.id,
  s.user_id            as owner_id,
  p.display_name       as owner_name,
  case when p.avatar like 'face:%' then p.avatar else null end as owner_avatar,
  s.title,
  s.published_at,
  s.updated_at,
  (select count(*) from public.set_stars st where st.study_set_id = s.id)      as stars,
  (select count(*) from public.study_items i
     where i.study_set_id = s.id and i.hidden = false)                          as cards
from public.study_sets s
-- LEFT join, so a shared set never disappears because its owner's profile row
-- is missing — which is a real state: HANDOFF records that on_auth_user_created
-- is absent from the backup dump, so anyone who signed up after a restore would
-- have no profiles row. A set with no name beside it is a small problem; a set
-- that silently vanishes from the list is the kind that costs an afternoon.
-- src/core/community.ts supplies the name to show when this is null.
left join public.profiles p on p.id = s.user_id
-- The whole guarantee of this view is on this line.
where s.visibility = 'public'
  and s.status = 'ready';

-- -------------------------------------------------------- public_set_items --
-- The cards of a shared set, for someone who does not own it.
--
-- Sharing a set shares the sentences its cards were grounded in: source_excerpt
-- is part of the card, and a card without it breaks "shows me where every answer
-- came from". The screen that publishes a set says this in as many words before
-- anything is shared.
--
-- MUST NEVER EXPOSE: documents or document_pages. Those hold the FULL text of
-- everything the owner uploaded, and their storage paths point at files in the
-- private documents bucket. An excerpt is a sentence the owner chose to publish
-- with a card; the document is their whole PDF. This view names study_items
-- columns only and joins documents not at all, so there is no path from here to
-- either. `document_id` is deliberately NOT selected: it is of no use to someone
-- who cannot read documents, and "Open page" must not be offered for a file the
-- viewer has no right to open.
--
-- hidden = false, because a reported card must not reappear to anyone. It is the
-- same filter listItems already applies for the owner.
drop view if exists public.public_set_items;
create view public.public_set_items
  with (security_barrier = true)
as
select
  i.id,
  i.study_set_id,
  i.page_index,
  i.section_title,
  i.kind,
  i.level,
  i.prompt,
  i.answer,
  i.options,
  i.rubric,
  i.source_excerpt,
  i.check_flag,
  i.topic,
  i.created_at
from public.study_items i
join public.study_sets s on s.id = i.study_set_id
where s.visibility = 'public'
  and i.hidden = false;

-- -------------------------------------------------------------- global_chat --
-- Messages with the name and face to put beside them.
--
-- A view rather than two queries and a join in the client: the client cannot
-- read profiles across accounts at all, so without this the chat would show
-- every message attributed to nobody. The same CASE keeps uploaded photos out.
drop view if exists public.global_chat;
create view public.global_chat
  with (security_barrier = true)
as
select
  m.id,
  m.user_id            as author_id,
  p.display_name       as author_name,
  case when p.avatar like 'face:%' then p.avatar else null end as author_avatar,
  m.body,
  m.created_at
from public.global_messages m
left join public.profiles p on p.id = m.user_id;

-- ------------------------------------------------------------ my_schedule --
-- MY due cards, whoever owns them.
--
-- ## The hole this fills
--
-- dueCountsBySet and dueLevelsForSet ask review_state for the card alongside
-- the schedule, with an embedded inner join on study_items — the fix for a real
-- defect, since a reported card keeps its schedule and would otherwise be
-- promised and then not dealt. But study_items stays select-own (section 1's
-- first rule), so for a set somebody else shared that join matches nothing and
-- every one of your due cards in it silently disappears from the count. You
-- would study a shared set and the app would never once tell you it was due.
--
-- ## Why a view rather than a wider policy
--
-- The same reason as every other view here — and one more. NOTES §21.1 records
-- that a PostgREST embedded filter which fails to resolve returns rows instead
-- of an error, a silent wrong answer, and §21/§36 are both due badges
-- disagreeing with the deck they open. This replaces the two embedded filters
-- with a plain select on a relation that has already done the join, so that
-- whole class of failure goes away rather than being extended to shared sets.
--
-- ## What it does NOT do
--
-- It is not a way to read anyone else's schedule. `r.user_id = auth.uid()` on
-- the last-but-two line means the rows are always the caller's own; the view's
-- privilege is used only to look up the CARD beside them. And a card whose set
-- has been unshared drops out, so somebody who stops sharing stops appearing in
-- other people's due counts — which is the honest answer, since those cards can
-- no longer be opened either.
drop view if exists public.my_schedule;
create view public.my_schedule
  with (security_barrier = true)
as
select
  r.study_item_id,
  r.study_set_id,
  r.due_at,
  i.level,
  (i.user_id = r.user_id) as owned
from public.review_state r
join public.study_items i on i.id = r.study_item_id
join public.study_sets s on s.id = i.study_set_id
where r.user_id = (select auth.uid())
  and i.hidden = false
  and (i.user_id = (select auth.uid()) or s.visibility = 'public');

-- Signed-in accounts only, on every one of them. `anon` is revoked explicitly
-- rather than left to the default, because the default for a new view in this
-- project's schema has been "whatever PUBLIC already had" more than once.
revoke all on public.public_profiles   from anon, public;
revoke all on public.public_sets       from anon, public;
revoke all on public.public_set_items  from anon, public;
revoke all on public.global_chat       from anon, public;
revoke all on public.my_schedule       from anon, public;

grant select on public.public_profiles   to authenticated;
grant select on public.public_sets       to authenticated;
grant select on public.public_set_items  to authenticated;
grant select on public.global_chat       to authenticated;
grant select on public.my_schedule       to authenticated;

-- ---------------------------------------------------------------------------
-- 6. One card, one schedule PER PERSON
-- ---------------------------------------------------------------------------
-- ############################################################################
-- # THE PART OF THIS MIGRATION MOST LIKELY TO BREAK SOMETHING. READ IT ALL.  #
-- #                                                                          #
-- # 0005 wrote `study_item_id uuid not null unique`, commented "a card has    #
-- # exactly one schedule". That was true while every card belonged to exactly #
-- # one person. Studying a shared set in place makes it false: two people     #
-- # answering the same card each need their own due date, and a globally      #
-- # unique study_item_id lets only the first of them have one. The second's   #
-- # upsert conflicts with a row RLS hides from them, so their schedule is     #
-- # either refused outright or written nowhere at all — and src/data/review.ts #
-- # does not read the result of that upsert, so nothing would have said so.   #
-- #                                                                          #
-- # THIS MIGRATION ONLY ADDS the correct constraint. It does NOT drop the old #
-- # one, and until 0022 does, two people still cannot schedule one card.      #
-- #                                                                          #
-- # THE ORDER IS NOT OPTIONAL:                                                #
-- #   1. apply THIS migration            (additive; old code keeps working)   #
-- #   2. deploy the code that upserts on (user_id, study_item_id)             #
-- #   3. confirm it is live: scripts/deploy-status.ts                          #
-- #   4. apply 0022, which drops the old constraint                           #
-- #                                                                          #
-- # Applying 0022 early is the 2026-09-12 outage again (NOTES §31), with a    #
-- # sharper edge: the moment the single-column unique index is gone, the      #
-- # deployed code's `on_conflict=study_item_id` has no matching constraint    #
-- # and Postgres answers 42P10. Every answer in the app would stop saving its #
-- # schedule, on every set, shared or not.                                    #
-- ############################################################################
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.review_state'::regclass
      and contype = 'u'
      -- Found by WHAT IT CHECKS, not by a guessed name (HANDOFF). Both sides
      -- are sorted before comparing, because conkey is in the order the columns
      -- were written in the constraint and an equally correct
      -- `unique (study_item_id, user_id)` would otherwise read as absent — and
      -- this block would then try to add a duplicate and fail the migration.
      and (select array_agg(k order by k) from unnest(conkey) as k)
        = (select array_agg(attnum order by attnum) from pg_attribute
           where attrelid = 'public.review_state'::regclass
             and attname in ('user_id', 'study_item_id'))
  ) then
    alter table public.review_state
      add constraint review_state_user_item_key unique (user_id, study_item_id);
  end if;
end $$;
