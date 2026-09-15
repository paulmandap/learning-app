-- 0020 — daily study reminders (NOTES §45).
--
-- The owner, 2026-09-15: "add daily notification like reminding the user about
-- their backlogs, study yet?, or a simple reminder about studying". Asked, they
-- chose a phone notification, saying what's waiting, "a max of 3 per day".
--
-- SAFE TO APPLY BEFORE OR AFTER THE BUILD THAT USES IT. Nothing is dropped or
-- renamed (§31). Before it, Settings says reminders aren't switched on yet, and
-- the reminders workflow fails loudly rather than sending nothing in silence.
--
-- AFTER APPLYING, set the sender's secret once — see reminder_sender below.

-- ------------------------------------------------------ push_subscriptions --
-- One row per device that turned reminders on. The endpoint is an address at
-- Apple's or Google's push service, and with the two keys it is enough to send
-- that device a notification. So only its owner reads it here, and the sender
-- reaches it only through reminders_to_send() below.
create table if not exists public.push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  endpoint     text not null unique check (endpoint like 'https://%' and char_length(endpoint) <= 1000),
  -- base64url, no padding: a 65-byte public key and a 16-byte secret.
  p256dh       text not null check (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  auth         text not null check (auth ~ '^[A-Za-z0-9_-]{22}$'),
  created_at   timestamptz not null default now(),
  last_sent_at timestamptz
);

create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

drop policy if exists "push_subscriptions select own" on public.push_subscriptions;
create policy "push_subscriptions select own" on public.push_subscriptions
  for select using (user_id = auth.uid());

drop policy if exists "push_subscriptions delete own" on public.push_subscriptions;
create policy "push_subscriptions delete own" on public.push_subscriptions
  for delete using (user_id = auth.uid());

-- No insert or update policy: a device is added only through the function
-- below, which also takes it back from whoever had it before.

-- A device belongs to whoever is signed in on it now. Someone who signed out
-- without turning reminders off would otherwise have their reminders — their
-- due count, their streak — shown on the next person's phone.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth);
end;
$$;

revoke all on function public.save_push_subscription(text, text, text) from public;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- -------------------------------------------------------- reminder_settings --
-- Which of the three times a person wants. Empty: none, which is also what
-- turning reminders off writes. Per person, not per device — a phone and a
-- laptop that both turned them on get the same ones.
create table if not exists public.reminder_settings (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  -- The same three as REMINDER_TIMES in src/core/reminders.ts; tests/reminders.test.ts reads this line.
  slots      text[] not null default '{}' check (slots <@ array['morning', 'afternoon', 'evening']::text[]),
  updated_at timestamptz not null default now()
);

alter table public.reminder_settings enable row level security;

drop policy if exists "reminder_settings select own" on public.reminder_settings;
create policy "reminder_settings select own" on public.reminder_settings
  for select using (user_id = auth.uid());

drop policy if exists "reminder_settings insert own" on public.reminder_settings;
create policy "reminder_settings insert own" on public.reminder_settings
  for insert with check (user_id = auth.uid());

drop policy if exists "reminder_settings update own" on public.reminder_settings;
create policy "reminder_settings update own" on public.reminder_settings
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "reminder_settings delete own" on public.reminder_settings;
create policy "reminder_settings delete own" on public.reminder_settings
  for delete using (user_id = auth.uid());

-- ------------------------------------------------------------- the sender --
-- The reminders workflow calls in with the PUBLISHABLE key, as keepalive does
-- (0004): no service-role key, no database password. What lets it read which
-- devices to remind is a secret only the workflow holds, checked here against
-- its SHA-256 — so this table holds nothing that lets anyone else in, and the
-- secret itself never passes through the SQL editor.
--
-- Set once, after applying this file, with the hash the owner is given:
--   insert into public.reminder_sender (id, secret_sha256) values (1, '<64 hex characters>')
--   on conflict (id) do update set secret_sha256 = excluded.secret_sha256;
create table if not exists public.reminder_sender (
  id            integer primary key default 1 check (id = 1),
  secret_sha256 text not null check (secret_sha256 ~ '^[0-9a-f]{64}$')
);

-- RLS on and no policies: nobody reads or writes this through the API.
alter table public.reminder_sender enable row level security;

create or replace function public.reminder_sender_allowed(p_secret text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.reminder_sender
    where secret_sha256 = encode(sha256(convert_to(coalesce(p_secret, ''), 'UTF8')), 'hex')
  );
$$;

revoke all on function public.reminder_sender_allowed(text) from public, anon, authenticated;

-- Everyone who wants the reminder at this time, one row per device, with what
-- the sender needs to word it: the days they studied and when each card they
-- could be dealt is due. The wording is decided in src/core/reminders.ts, by
-- the rules Home uses; this only reads.
create or replace function public.reminders_to_send(p_secret text, p_slot text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.reminder_sender_allowed(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'subscription_id', s.id,
      'endpoint', s.endpoint,
      'p256dh', s.p256dh,
      'auth', s.auth,
      'last_sent_at', s.last_sent_at,
      -- Bounded to the last 400 days: a streak is counted back from today.
      'study_days', coalesce((
        select jsonb_agg(d.day order by d.day desc)
        from public.study_days d
        where d.user_id = s.user_id
          and d.day >= (now() at time zone 'utc')::date - 400
      ), '[]'::jsonb),
      -- Cards not hidden, as the dashboard counts them. Only those due by now:
      -- the sender narrows it to the start of today, as Home does.
      'due_at', coalesce((
        select jsonb_agg(r.due_at)
        from public.review_state r
        join public.study_items i on i.id = r.study_item_id and i.hidden = false
        where r.user_id = s.user_id
          and r.due_at <= now()
      ), '[]'::jsonb)
    ))
    from public.push_subscriptions s
    join public.reminder_settings rs on rs.user_id = s.user_id
    where p_slot = any (rs.slots)
  ), '[]'::jsonb);
end;
$$;

-- What was sent, and which devices the push service has forgotten — turned off
-- in the phone's settings, or Nomi removed from the Home Screen.
create or replace function public.reminders_sent(p_secret text, p_sent uuid[], p_gone uuid[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.reminder_sender_allowed(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.push_subscriptions set last_sent_at = now() where id = any (coalesce(p_sent, '{}'));
  delete from public.push_subscriptions where id = any (coalesce(p_gone, '{}'));
end;
$$;

-- The publishable key is the anon role. Signed-in people are not the sender.
revoke all on function public.reminders_to_send(text, text) from public;
grant execute on function public.reminders_to_send(text, text) to anon;
revoke all on function public.reminders_sent(text, uuid[], uuid[]) from public;
grant execute on function public.reminders_sent(text, uuid[], uuid[]) to anon;
