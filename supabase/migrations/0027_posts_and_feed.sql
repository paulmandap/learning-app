-- Posts, a feed, comments and reactions (NOTES §52).
--
-- Step two of five (§51). The owner: *"this is built to socialize. just like how
-- you can post/brag about your job in facebook and linkedin."* Decided with him
-- before anything was written (2026-09-27):
--
--   - a post is text, a photo, one shared set (its cards flippable in the
--     feed), or a streak brag — at most one attachment, and never nothing;
--   - a post is seen by FRIENDS by default, or by everyone if its author says;
--   - the feed is friends' posts and everyone's public posts, newest first;
--   - comments and reactions, both reportable.
--
-- ############################################################################
-- # APPLY 0026 FIRST. Friendships and blocks decide who sees a post, and     #
-- # this extends 0026's reports. Section 0 refuses to run without it.        #
-- ############################################################################
--
-- ############################################################################
-- # ONE RULE DECIDES WHO SEES A POST, AND IT IS WRITTEN ONCE.                #
-- #                                                                          #
-- # `post_visible` (section 3) is the whole of it: the author; or, across no  #
-- # block, anybody for 'everyone' and an accepted friend for 'friends'.       #
-- # The feed, a post's comments, its reactions, its photo in storage, adding  #
-- # a comment, reacting and reporting ALL call it. Written out six times it   #
-- # would be six rules that agree today — and a friends-only photo readable   #
-- # through storage by a stranger the first time one of them was edited.     #
-- ############################################################################
--
-- The 0021/0026 rules still hold: no policy on an existing base table is
-- relaxed; reads of other people come through views that run as their owner;
-- writes that need a rule are functions, and the tables they write have no
-- insert or update policy at all.
--
-- Additive, apart from `reports_kind_check`, which is dropped and recreated in
-- this same file to allow two more kinds — a superset, so the live code's
-- reports still pass it. Safe before or after the code deploys.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Is 0026 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.friendships') is null
    or to_regclass('public.blocks') is null
    or to_regclass('public.reports') is null then
    raise exception 'Apply 0026 first — this migration builds on it. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Posts
-- ---------------------------------------------------------------------------
create table if not exists public.posts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  body         text not null default '',
  audience     text not null default 'friends',
  -- A photo in the private `post-images` bucket, '<user id>/<file>'. Its size
  -- is kept so the feed can hold the right space before the picture arrives,
  -- rather than jumping as each one loads.
  image_path   text,
  image_width  integer,
  image_height integer,
  -- One shared set. CASCADE, not set null: a post about a set is about that
  -- set, and once it is deleted the post has nothing left to say — and set
  -- null would leave a post with no content, which the check below refuses,
  -- so deleting the set would fail. Unsharing is different: the post stays
  -- and the feed says the set is not shared any more.
  set_id       uuid references public.study_sets (id) on delete cascade,
  -- A streak brag: the streak and the pet, as they were when it was posted.
  -- Written by `create_post` from the database's own record, never by the app.
  streak_days  integer,
  pet          text,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  constraint posts_audience_check check (audience in ('friends', 'everyone')),
  constraint posts_body_check check (length(body) <= 2000),
  constraint posts_one_attachment check (num_nonnulls(image_path, set_id, streak_days) <= 1),
  constraint posts_not_empty check (
    length(btrim(body)) > 0 or num_nonnulls(image_path, set_id, streak_days) = 1
  ),
  constraint posts_streak_check check (streak_days is null or streak_days > 0),
  constraint posts_image_size_check check (
    (image_path is null and image_width is null and image_height is null)
    or (image_path is not null and image_width > 0 and image_height > 0)
  )
);

-- Newest first is the feed's order and a person's page's order.
create index if not exists posts_recent_idx on public.posts (created_at desc, id desc);
create index if not exists posts_user_recent_idx on public.posts (user_id, created_at desc);
create index if not exists posts_set_idx on public.posts (set_id) where set_id is not null;
create index if not exists posts_image_idx on public.posts (image_path) where image_path is not null;

alter table public.posts enable row level security;
alter table public.posts force row level security;

-- Your own posts, directly. Everybody's else's come through `feed_posts`.
drop policy if exists posts_select_own on public.posts;
create policy posts_select_own on public.posts
  for select using (user_id = (select auth.uid()));

-- Take it down. No insert or update policy: `create_post` and `edit_post`.
drop policy if exists posts_delete_own on public.posts;
create policy posts_delete_own on public.posts
  for delete using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 2. Reactions and comments
-- ---------------------------------------------------------------------------
-- Reactions: the same shape as 0025's message_reactions — one of each emoji
-- per person per post, the emoji as text so "+" can be any of them.
create table if not exists public.post_reactions (
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  emoji      text not null check (length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, emoji)
);

create index if not exists post_reactions_post_idx on public.post_reactions (post_id);

alter table public.post_reactions enable row level security;
alter table public.post_reactions force row level security;

create table if not exists public.post_comments (
  id         uuid primary key default gen_random_uuid(),
  post_id    uuid not null references public.posts (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  body       text not null check (length(btrim(body)) between 1 and 1000),
  created_at timestamptz not null default now()
);

create index if not exists post_comments_post_idx on public.post_comments (post_id, created_at);
create index if not exists post_comments_user_recent_idx on public.post_comments (user_id, created_at desc);

alter table public.post_comments enable row level security;
alter table public.post_comments force row level security;

-- ---------------------------------------------------------------------------
-- 3. Who sees a post — the one rule
-- ---------------------------------------------------------------------------
-- The caller sees a post when they wrote it, or — with no block between them
-- and its author, in either direction — when it is for everyone, or it is for
-- friends and they are friends.
--
-- About the CALLER only, deliberately: it takes no viewer argument, so nobody
-- can use it to ask whether two OTHER people are friends. SECURITY DEFINER
-- because it reads `friendships` and `blocks`, whose own policies show each
-- person only their own rows. It is granted to signed-in accounts because a
-- view calling a function checks the function's privileges against whoever
-- reads the VIEW (Postgres: "the user of a view must have permissions to call
-- all functions used by the view").
create or replace function public.post_visible(p_author uuid, p_audience text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (select auth.uid()) is not null
    and (
      p_author = (select auth.uid())
      or (
        not exists (
          select 1 from public.blocks b
          where (b.blocker_id = (select auth.uid()) and b.blocked_id = p_author)
             or (b.blocker_id = p_author and b.blocked_id = (select auth.uid()))
        )
        and (
          p_audience = 'everyone'
          or (
            p_audience = 'friends'
            and exists (
              select 1 from public.friendships f
              where f.status = 'accepted'
                and least(f.requester_id, f.addressee_id) = least((select auth.uid()), p_author)
                and greatest(f.requester_id, f.addressee_id) = greatest((select auth.uid()), p_author)
            )
          )
        )
      )
    );
$$;

-- Can the caller see this post? For the policies below and for storage.
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
  );
$$;

-- Is this file the photo of a post the caller can see? The same trick as
-- 0023's `is_chosen_avatar`: one boolean about a path the caller already has,
-- no row, no way to find out whose it is.
create or replace function public.can_see_post_image(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.posts p
    where p.image_path = object_name
      and public.post_visible(p.user_id, p.audience)
  );
$$;

-- Somebody's current streak, by the rule `studyStreak` in src/core/progress.ts
-- uses: UTC days studied (`study_days`) or forgiven (`streak_restores`), in a
-- run ending today or yesterday — and nothing at all without one real day.
--
-- For `create_post`, so a streak brag says what the database knows rather than
-- what the app sent: a post claiming a 999-day streak is a lie anybody could
-- otherwise tell with one request. NOT granted to anybody — it can answer for
-- any account, and a streak is not public (the Privacy Policy says a profile
-- does not show it). Functions that run as their owner can still call it.
create or replace function public.streak_of(p_user uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  today      date := (now() at time zone 'utc')::date;
  cursor_day date;
  n          integer := 0;
begin
  if not exists (select 1 from public.study_days d where d.user_id = p_user) then
    return 0;
  end if;

  if exists (select 1 from public.study_days d where d.user_id = p_user and d.day = today)
     or exists (select 1 from public.streak_restores r where r.user_id = p_user and r.restored_day = today) then
    cursor_day := today;
  elsif exists (select 1 from public.study_days d where d.user_id = p_user and d.day = today - 1)
     or exists (select 1 from public.streak_restores r where r.user_id = p_user and r.restored_day = today - 1) then
    cursor_day := today - 1;
  else
    return 0;
  end if;

  while exists (select 1 from public.study_days d where d.user_id = p_user and d.day = cursor_day)
     or exists (select 1 from public.streak_restores r where r.user_id = p_user and r.restored_day = cursor_day) loop
    n := n + 1;
    cursor_day := cursor_day - 1;
  end loop;

  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Reactions and comments: who may write them
-- ---------------------------------------------------------------------------
-- A reaction is a plain insert of your own row, on a post you can see. Like
-- 0025's, it is a reply addressed to the author and it is named — through
-- `post_reaction_people` below, never this table, whose select is own-only.
drop policy if exists post_reactions_select_own on public.post_reactions;
create policy post_reactions_select_own on public.post_reactions
  for select using (user_id = (select auth.uid()));

drop policy if exists post_reactions_insert_visible on public.post_reactions;
create policy post_reactions_insert_visible on public.post_reactions
  for insert with check (user_id = (select auth.uid()) and public.can_see_post(post_id));

drop policy if exists post_reactions_delete_own on public.post_reactions;
create policy post_reactions_delete_own on public.post_reactions
  for delete using (user_id = (select auth.uid()));

-- Comments are written by `add_comment` (a limit per minute, like the chat's).
-- Deleted by who wrote them, OR by the author of the post they are under — it
-- is your post, and a comment you do not want on it is yours to take off, the
-- way every social app lets you. The subquery reads `posts` as the caller,
-- whose own-row policy shows them their own posts, which is exactly the check.
-- The select policy matches the delete policy on purpose. A DELETE whose WHERE
-- reads a column is also held to the SELECT policies, so with select-own alone
-- the author of a post would "delete" somebody's comment and remove nothing —
-- no error, the comment still there. Everybody else reads comments through
-- `post_comment_people`.
drop policy if exists post_comments_select_own_or_post_author on public.post_comments;
create policy post_comments_select_own_or_post_author on public.post_comments
  for select using (
    user_id = (select auth.uid())
    or exists (select 1 from public.posts p where p.id = post_id and p.user_id = (select auth.uid()))
  );

drop policy if exists post_comments_delete_own_or_post_author on public.post_comments;
create policy post_comments_delete_own_or_post_author on public.post_comments
  for delete using (
    user_id = (select auth.uid())
    or exists (select 1 from public.posts p where p.id = post_id and p.user_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 5. Writing a post, changing it, commenting
-- ---------------------------------------------------------------------------
-- Post something. Returns the post's id.
--
-- Checks what a policy could not:
--   - the photo is in YOUR folder and was actually uploaded;
--   - the set is shared and ready — a post pointing at a private set would be
--     a card nobody can open, including the author's friends;
--   - a streak is the database's own number (`streak_of`), and the pet is the
--     one on your profile — the app only asks for "my streak";
--   - twenty posts a day (POSTS_PER_DAY in src/core/posts.ts).
create or replace function public.create_post(
  p_body         text,
  p_audience     text,
  p_image_path   text default null,
  p_image_width  integer default null,
  p_image_height integer default null,
  p_set_id       uuid default null,
  p_streak       boolean default false
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
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
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
    user_id, body, audience, image_path, image_width, image_height, set_id, streak_days, pet
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
    case when p_streak then coalesce(my_pet, 'potato') else null end
  )
  returning id into new_id;

  return new_id;
end;
$$;

-- Change what a post says, or who sees it. Only yours. Changing the words marks
-- it edited, for the reason 0025 gives about messages: an edit nobody can see
-- happened is the one kind that stays refused. Changing only the audience does
-- not — nothing anybody read has changed.
--
-- No time limit, unlike a chat message: a post is not a conversation that has
-- moved on, and fixing a typo in yesterday's post is what people do.
create or replace function public.edit_post(p_id uuid, p_body text, p_audience text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me       uuid := (select auth.uid());
  old_post public.posts;
  new_body text := btrim(coalesce(p_body, ''));
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select * into old_post from public.posts p where p.id = p_id;
  if not found then
    raise exception 'That post is gone.' using errcode = 'P0002';
  end if;
  if old_post.user_id <> me then
    raise exception 'That post is not yours.' using errcode = '42501';
  end if;

  update public.posts
    set body = new_body,
        audience = coalesce(p_audience, old_post.audience),
        edited_at = case when new_body is distinct from old_post.body then now() else old_post.edited_at end
    where id = p_id;
end;
$$;

-- Comment on a post you can see. Ten a minute, like the chat
-- (COMMENTS_PER_MINUTE in src/core/posts.ts), with the count and the write in
-- one statement so two tabs cannot both pass the check.
create or replace function public.add_comment(p_post uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  me     uuid := (select auth.uid());
  sent   integer;
  new_id uuid;
begin
  if me is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  if not public.can_see_post(p_post) then
    raise exception 'That post is gone.' using errcode = 'P0002';
  end if;

  select count(*) into sent
  from public.post_comments c
  where c.user_id = me
    and c.created_at > now() - interval '1 minute';

  if sent >= 10 then
    raise exception 'Too many comments in a minute.' using errcode = 'P0001';
  end if;

  insert into public.post_comments (post_id, user_id, body)
  values (p_post, me, btrim(coalesce(p_body, '')))
  returning id into new_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Photos: a private bucket
-- ---------------------------------------------------------------------------
-- Private like every other bucket here, shown through short-lived signed
-- links. The app shrinks a photo to 1280 px before uploading, so 2 MB is a
-- ceiling for a mistake, not a budget — photos are what fills the free
-- storage first (NOTES §51 planning), and a full-size phone picture is 3–12 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('post-images', 'post-images', false, 2097152, array['image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists post_images_read_own on storage.objects;
create policy post_images_read_own on storage.objects
  for select using (
    bucket_id = 'post-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- Somebody else's photo: only while it is on a post the reader can see. A
-- friends-only photo is not readable by a stranger who has the path, and a
-- photo whose post was deleted is readable by nobody but its owner.
drop policy if exists post_images_read_visible on storage.objects;
create policy post_images_read_visible on storage.objects
  for select using (
    bucket_id = 'post-images'
    and (select auth.uid()) is not null
    and public.can_see_post_image(name)
  );

drop policy if exists post_images_insert_own on storage.objects;
create policy post_images_insert_own on storage.objects
  for insert with check (
    bucket_id = 'post-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists post_images_delete_own on storage.objects;
create policy post_images_delete_own on storage.objects
  for delete using (
    bucket_id = 'post-images'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

-- ---------------------------------------------------------------------------
-- 7. The views
-- ---------------------------------------------------------------------------
-- ----------------------------------------------------------------- feed_posts --
-- Every post the caller may see, with its author's name and picture, the set it
-- carries (only while that set is still shared), and how many comments it has
-- from people the caller can see. Newest first is the app's to ask for.
--
-- MUST NEVER EXPOSE: a post the caller may not see (the one rule, above), or a
-- private set's title. The set columns come through a LEFT join that itself
-- requires the set to be public and ready, so an unshared set reads as null and
-- the feed says so, rather than leaking the name of something now private.
drop view if exists public.feed_posts;
create view public.feed_posts
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
       ))            as comments
from public.posts p
left join public.profiles pr on pr.id = p.user_id
left join public.study_sets s
  on s.id = p.set_id and s.visibility = 'public' and s.status = 'ready'
where public.post_visible(p.user_id, p.audience);

-- ------------------------------------------------------- post_comment_people --
-- Comments under posts the caller can see, from people the caller can see.
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
  c.created_at
from public.post_comments c
join public.posts p on p.id = c.post_id
left join public.profiles pr on pr.id = c.user_id
where public.post_visible(p.user_id, p.audience)
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = c.user_id)
       or (b.blocker_id = c.user_id and b.blocked_id = (select auth.uid()))
  );

-- ------------------------------------------------------ post_reaction_people --
drop view if exists public.post_reaction_people;
create view public.post_reaction_people
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
  and not exists (
    select 1 from public.blocks b
    where (b.blocker_id = (select auth.uid()) and b.blocked_id = r.user_id)
       or (b.blocker_id = r.user_id and b.blocked_id = (select auth.uid()))
  );

-- ---------------------------------------------------------------------------
-- 8. Reports gain posts and comments
-- ---------------------------------------------------------------------------
-- The constraint by NAME, as 0026 named it for exactly this. A superset of
-- 0026's list, so every report the live code can make still passes.
alter table public.reports drop constraint if exists reports_kind_check;
alter table public.reports
  add constraint reports_kind_check
  check (target_kind in ('person', 'message', 'set', 'post', 'comment'));

-- 0026's function with two more branches, the rest unchanged. A post or a
-- comment can be reported only by somebody who can see it — the same rule as a
-- set, so this cannot be used to find out which post ids are real. The copy of
-- a photo post is its words and "[photo]": the picture itself stays in its
-- bucket, where deleting the post puts it out of everybody's reach.
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
    select p.id, concat_ws(' ', p.display_name, '@' || p.username)
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
             case when p.streak_days is not null then '[streak ' || p.streak_days || ']' end)
      into owner_id, snapshot_text
      from public.posts p
      where p.id = p_target
        and public.post_visible(p.user_id, p.audience);
  elsif p_kind = 'comment' then
    select c.user_id, c.body
      into owner_id, snapshot_text
      from public.post_comments c
      join public.posts p on p.id = c.post_id
      where c.id = p_target
        and public.post_visible(p.user_id, p.audience);
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
-- 9. Who may use any of it: signed-in accounts only
-- ---------------------------------------------------------------------------
revoke all on function public.post_visible(uuid, text) from public, anon;
revoke all on function public.can_see_post(uuid) from public, anon;
revoke all on function public.can_see_post_image(text) from public, anon;
revoke all on function public.streak_of(uuid) from public, anon, authenticated;
revoke all on function public.create_post(text, text, text, integer, integer, uuid, boolean) from public, anon;
revoke all on function public.edit_post(uuid, text, text) from public, anon;
revoke all on function public.add_comment(uuid, text) from public, anon;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;

grant execute on function public.post_visible(uuid, text) to authenticated;
grant execute on function public.can_see_post(uuid) to authenticated;
grant execute on function public.can_see_post_image(text) to authenticated;
grant execute on function public.create_post(text, text, text, integer, integer, uuid, boolean) to authenticated;
grant execute on function public.edit_post(uuid, text, text) to authenticated;
grant execute on function public.add_comment(uuid, text) to authenticated;
grant execute on function public.report_content(text, uuid, text, text) to authenticated;

revoke all on public.feed_posts           from anon, public;
revoke all on public.post_comment_people  from anon, public;
revoke all on public.post_reaction_people from anon, public;

grant select on public.feed_posts           to authenticated;
grant select on public.post_comment_people  to authenticated;
grant select on public.post_reaction_people to authenticated;
