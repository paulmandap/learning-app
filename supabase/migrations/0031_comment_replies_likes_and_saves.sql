-- Replies and hearts on comments, and saved posts (NOTES §57).
--
-- Step two of the social redesign (§56). The owner asked for everything the
-- redesign pictures show that the app did not have (*"i'd want everything
-- added"*), and took these defaults when they were put to him (2026-09-28):
--
--   - a comment can be replied to, ONE level deep, as Instagram does — a reply
--     to a reply answers the comment it sits under;
--   - a comment can be given a heart, and shows how many it has — counted, not
--     named, like a set's stars;
--   - a post can be saved, privately: nobody else, the post's author included,
--     can see that you saved it.
--
-- ############################################################################
-- # APPLY 0027 AND 0030 FIRST. Section 0 refuses to run without them.        #
-- ############################################################################
--
-- The same rules as 0027: `post_visible` is still the one rule for who sees a
-- post, and everything here asks it — through `can_see_post`, or through
-- `can_see_comment` below, which is that rule plus a block with whoever wrote
-- the comment, exactly as `post_comment_people` already filters. No existing
-- policy is relaxed. A reply is written by a function, since `post_comments`
-- has no insert policy; a heart and a save are plain inserts of your own row,
-- like a reaction.
--
-- Additive. `post_comment_people` is dropped and recreated in this file with
-- three more columns and every existing one unchanged, so the live code's
-- query still finds what it asks for. Safe before or after the code deploys:
-- the new code asks for the new columns and falls back to the old ones.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Are 0027 and 0030 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.post_comments') is null
    or to_regclass('public.posts') is null
    or to_regprocedure('public.assert_can_socialize()') is null then
    raise exception 'Apply 0027 and 0030 first — this migration builds on them. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Replies
-- ---------------------------------------------------------------------------
-- A reply is a comment with the comment it answers. CASCADE: a reply is part
-- of the conversation under that comment, and a comment deleted — by whoever
-- wrote it, the post's author or a moderator — takes its replies with it, the
-- way every social app does. The Privacy Policy says so.
--
-- One level deep is kept by `add_reply`, the only thing that writes this
-- column: it attaches a reply to a reply to the comment above it instead.
alter table public.post_comments
  add column if not exists parent_id uuid references public.post_comments (id) on delete cascade;

create index if not exists post_comments_parent_idx
  on public.post_comments (parent_id) where parent_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Hearts on comments
-- ---------------------------------------------------------------------------
create table if not exists public.comment_likes (
  comment_id uuid not null references public.post_comments (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

create index if not exists comment_likes_user_idx on public.comment_likes (user_id);

alter table public.comment_likes enable row level security;
alter table public.comment_likes force row level security;

-- ---------------------------------------------------------------------------
-- 3. Saved posts
-- ---------------------------------------------------------------------------
-- Private to the person who saved. Cascades from the post: a saved post that
-- is deleted is gone from Saved too. One that becomes invisible to you — made
-- friends-only, an unfriending, a block — keeps its row but drops out of the
-- list, because the list reads the posts through `feed_posts`.
create table if not exists public.post_saves (
  user_id    uuid not null references auth.users (id) on delete cascade,
  post_id    uuid not null references public.posts (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index if not exists post_saves_user_recent_idx on public.post_saves (user_id, created_at desc);

alter table public.post_saves enable row level security;
alter table public.post_saves force row level security;

-- ---------------------------------------------------------------------------
-- 4. Can the caller see this comment?
-- ---------------------------------------------------------------------------
-- Its post is one they can see (the one rule), and there is no block between
-- them and whoever wrote it, in either direction — the same two filters
-- `post_comment_people` applies, so a comment you cannot see is a comment you
-- cannot heart or reply to. About the CALLER only, like `post_visible`.
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
      and not exists (
        select 1 from public.blocks b
        where (b.blocker_id = (select auth.uid()) and b.blocked_id = c.user_id)
           or (b.blocker_id = c.user_id and b.blocked_id = (select auth.uid()))
      )
  );
$$;

-- ---------------------------------------------------------------------------
-- 5. Who may write what
-- ---------------------------------------------------------------------------
-- A heart is your own row, on a comment you can see. Read back only as a count
-- and "is it mine", through `post_comment_people` — this table's select is
-- own-only, so nobody can list who gave a heart.
drop policy if exists comment_likes_select_own on public.comment_likes;
create policy comment_likes_select_own on public.comment_likes
  for select using (user_id = (select auth.uid()));

drop policy if exists comment_likes_insert_visible on public.comment_likes;
create policy comment_likes_insert_visible on public.comment_likes
  for insert with check (user_id = (select auth.uid()) and public.can_see_comment(comment_id));

drop policy if exists comment_likes_delete_own on public.comment_likes;
create policy comment_likes_delete_own on public.comment_likes
  for delete using (user_id = (select auth.uid()));

-- A save is your own row, on a post you can see, and nobody else's to read.
drop policy if exists post_saves_select_own on public.post_saves;
create policy post_saves_select_own on public.post_saves
  for select using (user_id = (select auth.uid()));

drop policy if exists post_saves_insert_visible on public.post_saves;
create policy post_saves_insert_visible on public.post_saves
  for insert with check (user_id = (select auth.uid()) and public.can_see_post(post_id));

drop policy if exists post_saves_delete_own on public.post_saves;
create policy post_saves_delete_own on public.post_saves
  for delete using (user_id = (select auth.uid()));

-- Reply to a comment you can see. Returns the reply's id.
--
-- One level deep: a reply to a reply is attached to the comment that reply is
-- under, which must be one the caller can see as well. The rules first (0030:
-- replying reaches another person), then ten a minute — the SAME count as
-- `add_comment`, comments and replies together, so replying is not a way
-- around the limit.
create or replace function public.add_reply(p_comment uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := (select auth.uid());
  target public.post_comments;
  sent   integer;
  new_id uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  perform public.assert_can_socialize();

  select * into target from public.post_comments c where c.id = p_comment;
  if not found or not public.can_see_comment(target.id) then
    raise exception 'That comment is gone.' using errcode = 'P0002';
  end if;

  if target.parent_id is not null then
    select * into target from public.post_comments c where c.id = target.parent_id;
    if not found or not public.can_see_comment(target.id) then
      raise exception 'That comment is gone.' using errcode = 'P0002';
    end if;
  end if;

  select count(*) into sent
  from public.post_comments c
  where c.user_id = me
    and c.created_at > now() - interval '1 minute';

  if sent >= 10 then
    raise exception 'Too many comments in a minute.' using errcode = 'P0001';
  end if;

  insert into public.post_comments (post_id, user_id, body, parent_id)
  values (target.post_id, me, btrim(coalesce(p_body, '')), target.id)
  returning id into new_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The comments view, with replies and hearts
-- ---------------------------------------------------------------------------
-- 0027's view, every column as it was, and three more at the end: the comment
-- a reply answers, how many hearts it has from people the caller can see, and
-- whether one of them is the caller's. Hearts are counted, never named — the
-- rows behind the count are not readable by anybody but whoever gave them.
drop view if exists public.post_comment_people;
create view public.post_comment_people
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
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = c.user_id)
       or (b.blocker_id = c.user_id and b.blocked_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 7. Who may use any of it: signed-in accounts only
-- ---------------------------------------------------------------------------
revoke all on function public.can_see_comment(uuid) from public, anon;
revoke all on function public.add_reply(uuid, text) from public, anon;

grant execute on function public.can_see_comment(uuid) to authenticated;
grant execute on function public.add_reply(uuid, text) to authenticated;

revoke all on public.post_comment_people from anon, public;
grant select on public.post_comment_people to authenticated;
