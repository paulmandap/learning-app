-- Show the picture somebody chose, to the people who can see their name.
--
-- The owner, after using it: *"my dp isn't shown hahaha, i want it shown"*.
--
-- 0021 deliberately did the opposite. He had been asked and had chosen "name and
-- a drawn face", so every cross-user view passed `profiles.avatar` through
--
--     case when p.avatar like 'face:%' then p.avatar else null end
--
-- which let a built-in face out and turned an uploaded photo into null. This
-- reverses that decision, at his request, and nothing else about it.
--
-- ############################################################################
-- # THIS WIDENS WHAT ONE ACCOUNT CAN SEE OF ANOTHER. TWO LIMITS SURVIVE.     #
-- #                                                                          #
-- # 1. ONLY THE PICTURE SOMEBODY IS ACTUALLY USING. The avatars bucket keeps  #
-- #    up to six photos per person as choices (NOTES §45), and the five older #
-- #    ones stay as private as they are today. `is_chosen_avatar` asks        #
-- #    whether a path is the value in somebody's `profiles.avatar` RIGHT NOW. #
-- #    Granting the bucket wholesale would have been one line shorter and     #
-- #    would have published every photo anyone had ever uploaded, including   #
-- #    the ones they replaced because they did not like them.                 #
-- #                                                                          #
-- # 2. SIGNED IN ONLY, AND READ ONLY. The bucket stays private — no public    #
-- #    URL, nothing reachable from the open internet. Writing into somebody   #
-- #    else's folder is refused exactly as before; the four policies from     #
-- #    0016 are untouched and this only ADDS a select policy beside them.     #
-- #                                                                          #
-- # What genuinely changes: the five people using Nomi can see each other's   #
-- # profile photos. That is what showing a profile photo means, and the       #
-- # Privacy Policy says so in as many words now instead of promising the      #
-- # opposite.                                                                 #
-- ############################################################################
--
-- Additive: no policy is dropped, and the three views are replaced by
-- definitions that differ only in that one CASE. Safe to apply before or after
-- the code deploys — an older build simply goes on drawing a face, because
-- `parseAvatar` already falls back to one for any value it cannot use.

-- ---------------------------------------------------------------------------
-- 1. Is this file the picture somebody has actually chosen?
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER for the same reason as `can_star_set` in 0021, and it is the
-- whole reason this is a function rather than an `exists (…)` written inline in
-- the policy: a policy's subquery runs as the QUERYING user, so reading
-- `profiles` there would be filtered by profiles' own select-own policy and
-- could never be true for anybody else's row. The policy would then be
-- perfectly written and would refuse every photo.
--
-- It answers one boolean about a path the caller already has. It returns no row
-- and no column of profiles, so it is not a way to read the table through the
-- back door — in particular it cannot be used to find out whose photo it is.
create or replace function public.is_chosen_avatar(object_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.avatar = 'photo:' || object_name
  );
$$;

revoke execute on function public.is_chosen_avatar(text) from anon;
grant execute on function public.is_chosen_avatar(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Reading somebody else's chosen picture
-- ---------------------------------------------------------------------------
-- Policies are OR'd, so this sits BESIDE `avatars_read_own` from 0016 rather
-- than replacing it: your own photos stay readable to you whether or not one of
-- them is the one you are using.
drop policy if exists avatars_read_chosen on storage.objects;
create policy avatars_read_chosen on storage.objects
  for select using (
    bucket_id = 'avatars'
    and (select auth.uid()) is not null
    and public.is_chosen_avatar(name)
  );

-- ---------------------------------------------------------------------------
-- 3. The views stop hiding it
-- ---------------------------------------------------------------------------
-- Column for column identical to 0021 apart from the avatar expression. Spelled
-- out in full rather than patched, because a `create or replace view` that
-- disagreed with 0021 about any other column would be a silent change to what
-- is published — and the list being explicit is what stops a later
-- `alter table … add column` joining the public part of this app by accident.

drop view if exists public.public_profiles;
create view public.public_profiles
  with (security_barrier = true)
as
select
  p.id,
  p.display_name,
  -- Passed through whole now: 'face:N' or 'photo:<user id>/<file>'. The path is
  -- useless without the storage policy above, which serves it only while it is
  -- the picture that person is using.
  p.avatar
from public.profiles p;

drop view if exists public.public_sets;
create view public.public_sets
  with (security_barrier = true)
as
select
  s.id,
  s.user_id            as owner_id,
  p.display_name       as owner_name,
  p.avatar             as owner_avatar,
  s.title,
  s.published_at,
  s.updated_at,
  (select count(*) from public.set_stars st where st.study_set_id = s.id)      as stars,
  (select count(*) from public.study_items i
     where i.study_set_id = s.id and i.hidden = false)                          as cards
from public.study_sets s
left join public.profiles p on p.id = s.user_id
where s.visibility = 'public'
  and s.status = 'ready';

drop view if exists public.global_chat;
create view public.global_chat
  with (security_barrier = true)
as
select
  m.id,
  m.user_id            as author_id,
  p.display_name       as author_name,
  p.avatar             as author_avatar,
  m.body,
  m.created_at
from public.global_messages m
left join public.profiles p on p.id = m.user_id;

revoke all on public.public_profiles from anon, public;
revoke all on public.public_sets     from anon, public;
revoke all on public.global_chat     from anon, public;

grant select on public.public_profiles to authenticated;
grant select on public.public_sets     to authenticated;
grant select on public.global_chat     to authenticated;
