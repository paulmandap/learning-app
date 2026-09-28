-- Sharing a post to your feed (NOTES §62).
--
-- The owner (2026-09-28): the share button *"doesn't work. i don't want it to
-- share outside the app. i want to share it inside the app, just like how
-- facebook does it!"* — and, asked what people who may not see the original
-- should see of a repost: *"they should not be able to see it, just like
-- facebook, there's no 'This post isn't available' it will just look messy."*
--
-- So a repost is a post that carries the post it shares, and it is seen by
-- somebody only when they may see BOTH: the repost, by its own audience (the
-- one rule, `post_visible`), and the original, by its. Nobody is ever shown a
-- repost with a hole where the original was — it is simply not there for
-- them, anywhere a post is read: the feed, a person's page, a post's page,
-- Saved, search, comments, hearts, saving, reporting.
--
-- Deleting the original deletes its reposts (CASCADE): a repost is about that
-- post, and with it gone there is nothing to show but a hole.
--
-- A repost of a repost shares the ORIGINAL, as Facebook does — `create_post`
-- follows the chain one step, which is all there ever is.
--
-- ############################################################################
-- # APPLY 0033 FIRST. `report_content` is recreated from 0033's version.      #
-- # Section 0 refuses to run without it.                                      #
-- ############################################################################
--
-- Additive: one column, two constraints widened by name, one helper, and
-- every function and view that reads a post recreated with one more condition
-- (tests/reposts.test.ts holds each to its previous version). `create_post`'s
-- old signature is dropped first — two side by side and PostgREST refuses to
-- choose — and a call without the new argument (the live app's) lands on the
-- new function. Safe before or after the code deploys.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Is 0033 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.posts') is null
    or to_regprocedure('public.assert_can_socialize()') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name = 'bio'
    ) then
    raise exception 'Apply 0033 first — this migration builds on it. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. A post can carry the post it shares
-- ---------------------------------------------------------------------------
alter table public.posts
  add column if not exists shared_post_id uuid references public.posts (id) on delete cascade;

create index if not exists posts_shared_idx on public.posts (shared_post_id) where shared_post_id is not null;

-- 0027's two rules about what a post holds, by name, with the shared post
-- counted as one more thing it can hold: still at most one, never nothing.
alter table public.posts drop constraint if exists posts_one_attachment;
alter table public.posts
  add constraint posts_one_attachment
  check (num_nonnulls(image_path, set_id, streak_days, shared_post_id) <= 1);

alter table public.posts drop constraint if exists posts_not_empty;
alter table public.posts
  add constraint posts_not_empty
  check (length(btrim(body)) > 0 or num_nonnulls(image_path, set_id, streak_days, shared_post_id) = 1);

-- ---------------------------------------------------------------------------
-- 2. The second half of the rule: may the caller see what it shares?
-- ---------------------------------------------------------------------------
-- True for a post that shares nothing. Otherwise the original must exist and
-- pass the one rule for the caller. About the CALLER only, like
-- `post_visible`; granted to signed-in accounts for the same reason (a view
-- calling it is checked against whoever reads the view).
create or replace function public.shared_post_visible(p_shared uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_shared is null
    or exists (
      select 1 from public.posts o
      where o.id = p_shared
        and public.post_visible(o.user_id, o.audience)
    );
$$;

-- 0027's function; a repost whose original the caller may not see is not a
-- post they can see — so it cannot be reacted to, saved or commented on.
create or replace function public.can_see_post(p_post uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.posts p
    where p.id = p_post
      and public.post_visible(p.user_id, p.audience)
      and public.shared_post_visible(p.shared_post_id)
  );
$$;

-- 0031's function; the same, for a comment under such a repost.
create or replace function public.can_see_comment(p_comment uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.post_comments c
    join public.posts p on p.id = c.post_id
    where c.id = p_comment
      and public.post_visible(p.user_id, p.audience)
      and public.shared_post_visible(p.shared_post_id)
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = (select auth.uid()) and b.blocked_id = c.user_id)
           or (b.blocker_id = c.user_id and b.blocked_id = (select auth.uid()))
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Posting one
-- ---------------------------------------------------------------------------
-- 0030's function, and a post to share. Only one the caller may see — so a
-- repost cannot be used to learn which post ids are real — and never with a
-- photo, set or streak of its own (the constraint above says so too).
drop function if exists public.create_post(text, text, text, integer, integer, uuid, boolean);
create or replace function public.create_post(
  p_body         text,
  p_audience     text,
  p_image_path   text default null,
  p_image_width  integer default null,
  p_image_height integer default null,
  p_set_id       uuid default null,
  p_streak       boolean default false,
  p_shared_post  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  posted   integer;
  days     integer;
  my_pet   text;
  new_id   uuid;
  shared   uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  if p_shared_post is not null then
    if p_image_path is not null or p_set_id is not null or coalesce(p_streak, false) then
      raise exception 'One photo, set, streak or shared post per post.' using errcode = '22023';
    end if;
    -- The original, if this is itself a repost; then it must be one the
    -- caller may see, exactly as the feed would show it to them.
    select coalesce(p.shared_post_id, p.id) into shared
      from public.posts p
      where p.id = p_shared_post
        and public.post_visible(p.user_id, p.audience)
        and public.shared_post_visible(p.shared_post_id);
    if shared is null or not exists (
      select 1 from public.posts o
      where o.id = shared and public.post_visible(o.user_id, o.audience)
    ) then
      raise exception 'That post is gone.' using errcode = 'P0002';
    end if;
  end if;

  if p_image_path is not null then
    if (storage.foldername(p_image_path))[1] is distinct from me::text
       or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'post-images' and o.name = p_image_path
       ) then
      raise exception 'That photo is not yours to post.' using errcode = '42501';
    end if;
  end if;

  if p_set_id is not null and not exists (
    select 1 from public.study_sets s
    where s.id = p_set_id and s.visibility = 'public' and s.status = 'ready'
  ) then
    raise exception 'That set is not shared.' using errcode = 'P0002';
  end if;

  if p_streak then
    days := public.streak_of(me);
    if days < 1 then
      raise exception 'No streak to share yet.' using errcode = '22023';
    end if;
    select coalesce(p.pet, 'potato') into my_pet from public.profiles p where p.id = me;
  end if;

  select count(*) into posted
  from public.posts p
  where p.user_id = me
    and p.created_at > now() - interval '1 day';

  if posted >= 20 then
    raise exception 'Too many posts today.' using errcode = 'P0001';
  end if;

  insert into public.posts (
    user_id, body, audience, image_path, image_width, image_height, set_id, streak_days, pet, shared_post_id
  )
  values (
    me,
    btrim(coalesce(p_body, '')),
    coalesce(p_audience, 'friends'),
    p_image_path,
    case when p_image_path is null then null else p_image_width end,
    case when p_image_path is null then null else p_image_height end,
    p_set_id,
    case when p_streak then days else null end,
    case when p_streak then coalesce(my_pet, 'potato') else null end,
    shared
  )
  returning id into new_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reading them: every view that shows a post asks both halves
-- ---------------------------------------------------------------------------
-- 0027's view, every column as it was, and the post it shares at the end —
-- its author, words and what it carries, read only once the row has passed
-- both halves of the rule, so nothing of an original the caller may not see
-- is ever in a row they get.
create or replace view public.feed_posts
  with (security_barrier = true)
as
select
  p.id,
  p.user_id          as author_id,
  pr.display_name    as author_name,
  pr.username        as author_username,
  pr.avatar          as author_avatar,
  p.body,
  p.audience,
  p.image_path,
  p.image_width,
  p.image_height,
  p.set_id,
  s.title            as set_title,
  (select count(*) from public.study_items i
     where s.id is not null and i.study_set_id = s.id and i.hidden = false) as set_cards,
  p.streak_days,
  p.pet,
  p.created_at,
  p.edited_at,
  (select count(*) from public.post_comments c
     where c.post_id = p.id
       and not exists (
         select 1 from public.blocks b
         where (b.blocker_id = (select auth.uid()) and b.blocked_id = c.user_id)
            or (b.blocker_id = c.user_id and b.blocked_id = (select auth.uid()))
       ))            as comments,
  p.shared_post_id,
  o.user_id          as shared_author_id,
  opr.display_name   as shared_author_name,
  opr.username       as shared_author_username,
  opr.avatar         as shared_author_avatar,
  o.body             as shared_body,
  o.audience         as shared_audience,
  o.image_path       as shared_image_path,
  o.image_width      as shared_image_width,
  o.image_height     as shared_image_height,
  o.set_id           as shared_set_id,
  os.title           as shared_set_title,
  (select count(*) from public.study_items i
     where os.id is not null and i.study_set_id = os.id and i.hidden = false) as shared_set_cards,
  o.streak_days      as shared_streak_days,
  o.pet              as shared_pet,
  o.created_at       as shared_created_at
from public.posts p
left join public.profiles pr on pr.id = p.user_id
left join public.study_sets s
  on s.id = p.set_id and s.visibility = 'public' and s.status = 'ready'
left join public.posts o on o.id = p.shared_post_id
left join public.profiles opr on opr.id = o.user_id
left join public.study_sets os
  on os.id = o.set_id and os.visibility = 'public' and os.status = 'ready'
where public.post_visible(p.user_id, p.audience)
  and public.shared_post_visible(p.shared_post_id);

-- 0031's view, every column as it was; comments under a repost the caller
-- may not see are not theirs to read either.
create or replace view public.post_comment_people
  with (security_barrier = true)
as
select
  c.id,
  c.post_id,
  c.user_id          as author_id,
  pr.display_name    as author_name,
  pr.username        as author_username,
  pr.avatar          as author_avatar,
  c.body,
  c.created_at,
  c.parent_id,
  (select count(*) from public.comment_likes l
     where l.comment_id = c.id
       and not exists (
         select 1 from public.blocks b
         where (b.blocker_id = (select auth.uid()) and b.blocked_id = l.user_id)
            or (b.blocker_id = l.user_id and b.blocked_id = (select auth.uid()))
       ))            as likes,
  exists (select 1 from public.comment_likes l
            where l.comment_id = c.id and l.user_id = (select auth.uid())) as liked
from public.post_comments c
join public.posts p on p.id = c.post_id
left join public.profiles pr on pr.id = c.user_id
where public.post_visible(p.user_id, p.audience)
  and public.shared_post_visible(p.shared_post_id)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = c.user_id)
       or (b.blocker_id = c.user_id and b.blocked_id = (select auth.uid()))
  );

-- 0027's view, every column as it was; the same for reactions.
create or replace view public.post_reaction_people
  with (security_barrier = true)
as
select
  r.post_id,
  r.user_id,
  pr.display_name as name,
  r.emoji,
  r.created_at
from public.post_reactions r
join public.posts p on p.id = r.post_id
left join public.profiles pr on pr.id = r.user_id
where public.post_visible(p.user_id, p.audience)
  and public.shared_post_visible(p.shared_post_id)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = r.user_id)
       or (b.blocker_id = r.user_id and b.blocked_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 5. Reporting one
-- ---------------------------------------------------------------------------
-- 0033's function. A repost, and a comment under one, can be reported only by
-- somebody who can see it — the same rule as everything above — and the copy
-- kept of a repost says it shared a post.
create or replace function public.report_content(
  p_kind    text,
  p_target  uuid,
  p_reason  text,
  p_details text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me            uuid := (select auth.uid());
  owner_id      uuid;
  snapshot_text text;
  existing      uuid;
  sent          integer;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if p_kind = 'person' then
    select p.id, concat_ws(' ', p.display_name, '@' || p.username, nullif(btrim(coalesce(p.bio, '')), ''))
      into owner_id, snapshot_text
      from public.profiles p
      where p.id = p_target;
  elsif p_kind = 'message' then
    select m.user_id, m.body
      into owner_id, snapshot_text
      from public.global_messages m
      where m.id = p_target;
  elsif p_kind = 'set' then
    select s.user_id, s.title
      into owner_id, snapshot_text
      from public.study_sets s
      where s.id = p_target
        and s.visibility = 'public';
  elsif p_kind = 'post' then
    select p.user_id,
           concat_ws(' ', nullif(p.body, ''),
             case when p.image_path is not null then '[photo]' end,
             case when p.set_id is not null then '[set]' end,
             case when p.streak_days is not null then '[streak ' || p.streak_days || ']' end,
             case when p.shared_post_id is not null then '[shared post]' end)
      into owner_id, snapshot_text
      from public.posts p
      where p.id = p_target
        and public.post_visible(p.user_id, p.audience)
        and public.shared_post_visible(p.shared_post_id);
  elsif p_kind = 'comment' then
    select c.user_id, c.body
      into owner_id, snapshot_text
      from public.post_comments c
      join public.posts p on p.id = c.post_id
      where c.id = p_target
        and public.post_visible(p.user_id, p.audience)
        and public.shared_post_visible(p.shared_post_id);
  elsif p_kind = 'direct_message' then
    select m.user_id, m.body
      into owner_id, snapshot_text
      from public.direct_messages m
      where m.id = p_target
        and public.dm_readable(m.conversation_id);
  elsif p_kind = 'group_message' then
    select m.user_id, m.body
      into owner_id, snapshot_text
      from public.group_messages m
      where m.id = p_target
        and public.group_message_visible(m.group_id, m.user_id, m.created_at);
  else
    raise exception 'That cannot be reported.' using errcode = '22023';
  end if;

  if owner_id is null then
    raise exception 'That is gone.' using errcode = 'P0002';
  end if;

  if owner_id = me then
    raise exception 'That is yours.' using errcode = '22023';
  end if;

  select r.id into existing
  from public.reports r
  where r.reporter_id = me
    and r.target_kind = p_kind
    and r.target_id = p_target
    and r.status = 'open'
  limit 1;

  if existing is not null then
    return existing;
  end if;

  select count(*) into sent
  from public.reports r
  where r.reporter_id = me
    and r.created_at > now() - interval '1 day';

  if sent >= 20 then
    raise exception 'Too many reports today.' using errcode = 'P0001';
  end if;

  insert into public.reports (reporter_id, target_kind, target_id, reported_user_id, reason, details, snapshot)
  values (
    me,
    p_kind,
    p_target,
    owner_id,
    p_reason,
    nullif(btrim(coalesce(p_details, '')), ''),
    left(snapshot_text, 2000)
  )
  returning id into existing;

  return existing;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Signed-in accounts only
-- ---------------------------------------------------------------------------
revoke all on function public.shared_post_visible(uuid) from public, anon;
revoke all on function public.can_see_post(uuid) from public, anon;
revoke all on function public.can_see_comment(uuid) from public, anon;
revoke all on function public.create_post(text, text, text, integer, integer, uuid, boolean, uuid) from public, anon;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;

grant execute on function public.shared_post_visible(uuid) to authenticated;
grant execute on function public.can_see_post(uuid) to authenticated;
grant execute on function public.can_see_comment(uuid) to authenticated;
grant execute on function public.create_post(text, text, text, integer, integer, uuid, boolean, uuid) to authenticated;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;

revoke all on public.feed_posts           from anon, public;
revoke all on public.post_comment_people  from anon, public;
revoke all on public.post_reaction_people from anon, public;

grant select on public.feed_posts           to authenticated;
grant select on public.post_comment_people  to authenticated;
grant select on public.post_reaction_people to authenticated;
