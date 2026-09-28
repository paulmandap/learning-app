-- A bio on your profile (NOTES §59).
--
-- Step four of the social redesign (§56). The owner took the default when it
-- was put to him (2026-09-28): a bio of up to 150 characters, shown on your
-- profile and your page to anyone signed in, reportable — and a moderator can
-- clear it.
--
-- ############################################################################
-- # APPLY 0032 FIRST. `report_content` and `moderate_remove` are recreated  #
-- # from 0032's versions. Section 0 refuses to run without it.              #
-- ############################################################################
--
-- Written by the app as a plain update of your own profile row — the policy it
-- has had since 0002 — like your name. The two rules a bio needs that a name
-- did not are the database's, not the app's: the length is a check, and
-- writing one reaches other people, so a trigger asks `assert_can_socialize()`
-- first, exactly as 0030's `study_sets_share_guard` does for sharing a set.
--
-- `public_profiles` gains `bio` at the end with `create or replace`, not a drop:
-- `search_people` (0026) reads that view, and every existing column stays as
-- it was, so replacing it in place is both allowed and enough. Additive; safe
-- before or after the code deploys — the app falls back without the column.
--
-- CREATE THIS AS `postgres` — the dashboard SQL editor does.

-- ---------------------------------------------------------------------------
-- 0. Is 0032 here?
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('public.group_messages') is null
    or to_regprocedure('public.assert_can_socialize()') is null then
    raise exception 'Apply 0032 first — this migration builds on it. Nothing was changed.';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. The bio
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists bio text check (bio is null or char_length(bio) <= 150);

-- Writing a bio that says something asks the rules first: agreed to, and not
-- restricted. Clearing one never does — a restricted account can always take
-- its bio down. Not when nobody is signed in: that is the owner in this
-- editor, or a moderator's function, whose changes are not the app's.
create or replace function public.profiles_bio_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;
  if nullif(btrim(coalesce(new.bio, '')), '') is not null
     and (tg_op = 'INSERT' or new.bio is distinct from old.bio) then
    perform public.assert_can_socialize();
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_bio_guard on public.profiles;
create trigger profiles_bio_guard
  before insert or update of bio on public.profiles
  for each row execute function public.profiles_bio_guard();

-- ---------------------------------------------------------------------------
-- 2. Who sees it: anyone signed in, as they see your name
-- ---------------------------------------------------------------------------
-- 0026's view, every column as it was, and `bio` at the end. Still hidden
-- across a block, both ways.
create or replace view public.public_profiles
  with (security_barrier = true)
as
select
  p.id,
  p.display_name,
  p.avatar,
  p.username,
  p.bio
from public.profiles p
where not exists (
  select 1 from public.blocks b
  where (b.blocker_id = (select auth.uid()) and b.blocked_id = p.id)
     or (b.blocker_id = p.id and b.blocked_id = (select auth.uid()))
);

-- ---------------------------------------------------------------------------
-- 3. Reporting a person keeps a copy of their bio; a moderator can clear it
-- ---------------------------------------------------------------------------
-- 0032's function; the person's copy gains their bio, so a report about what
-- a bio says can still be checked after it is changed.
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

-- 0032's function; a person now has one thing to take down — their bio.
-- Their name, username and picture are still for a warning or a restriction.
create or replace function public.moderate_remove(p_kind text, p_target uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.assert_admin();

  if p_kind = 'message' then
    delete from public.global_messages where id = p_target;
  elsif p_kind = 'direct_message' then
    delete from public.direct_messages where id = p_target;
  elsif p_kind = 'group_message' then
    delete from public.group_messages where id = p_target;
  elsif p_kind = 'post' then
    delete from public.posts where id = p_target;
  elsif p_kind = 'comment' then
    delete from public.post_comments where id = p_target;
  elsif p_kind = 'set' then
    update public.study_sets set visibility = 'private' where id = p_target;
  elsif p_kind = 'person' then
    update public.profiles set bio = null where id = p_target;
  else
    raise exception 'There is nothing to remove for that — warn or restrict them.' using errcode = '22023';
  end if;

  update public.reports
    set status = 'actioned'
    where target_kind = p_kind and target_id = p_target and status = 'open';
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Signed-in accounts only
-- ---------------------------------------------------------------------------
revoke all on function public.profiles_bio_guard() from public, anon, authenticated;
revoke all on function public.report_content(text, uuid, text, text) from public, anon;
revoke all on function public.moderate_remove(text, uuid) from public, anon;

grant execute on function public.report_content(text, uuid, text, text) to authenticated;
grant execute on function public.moderate_remove(text, uuid) to authenticated;
