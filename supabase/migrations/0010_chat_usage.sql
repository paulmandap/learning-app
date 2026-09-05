-- Phase 9c — a daily cap on the study assistant.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A TABLE AND NOT A NUMBER IN THE BROWSER
--
-- Gemini's free-tier quota is per Google PROJECT, not per key and not per
-- device (ARCHITECTURE_NOTES.md §2.2 — "Rate limits are applied per project,
-- not per API key"). A counter in one browser's storage would therefore protect
-- nothing: the same key on a phone and a laptop would each get a full
-- allowance, and between them could still exhaust the quota that making cards
-- depends on.
--
-- Generation is the product; the assistant is an extra. The cap exists so an
-- afternoon of chatting cannot cost someone their cards.
-- ---------------------------------------------------------------------------

create table if not exists public.chat_usage (
  id       uuid primary key default gen_random_uuid(),
  user_id  uuid not null references auth.users (id) on delete cascade,
  -- A UTC date, matching study_days and startOfUtcDay. Three definitions of
  -- "today" in one app would eventually disagree in front of a user.
  day      date not null,
  messages integer not null default 0 check (messages >= 0),
  unique (user_id, day)
);

create index if not exists chat_usage_user_day_idx
  on public.chat_usage (user_id, day desc);

alter table public.chat_usage enable row level security;

drop policy if exists "chat_usage select own" on public.chat_usage;
create policy "chat_usage select own" on public.chat_usage
  for select using (user_id = auth.uid());

drop policy if exists "chat_usage insert own" on public.chat_usage;
create policy "chat_usage insert own" on public.chat_usage
  for insert with check (user_id = auth.uid());

drop policy if exists "chat_usage update own" on public.chat_usage;
create policy "chat_usage update own" on public.chat_usage
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "chat_usage delete own" on public.chat_usage;
create policy "chat_usage delete own" on public.chat_usage
  for delete using (user_id = auth.uid());

-- Claim one message, atomically, and say whether it was allowed.
--
-- Check-then-increment from the client would be two round trips with a race in
-- the middle: two tabs both read 19 of 20 and both proceed. This does it in one
-- statement, so the twentieth message is granted exactly once.
--
-- Returns the number REMAINING after the claim, or -1 when the cap is already
-- reached and nothing was claimed. A single integer carries both the verdict
-- and the number the screen wants to show.
create or replace function public.claim_chat_message(daily_limit integer)
returns integer
language plpgsql
as $$
declare
  used integer;
begin
  insert into public.chat_usage (user_id, day, messages)
  values (auth.uid(), (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update
    -- The guard is here rather than in a WHERE, so the row is always present
    -- and the count never silently stops rising past the cap.
    set messages = case
      when public.chat_usage.messages >= daily_limit then public.chat_usage.messages
      else public.chat_usage.messages + 1
    end
  returning messages into used;

  if used > daily_limit then
    return -1;
  end if;
  return daily_limit - used;
end;
$$;
