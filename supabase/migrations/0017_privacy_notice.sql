-- 0017 — the privacy notice, read once (NOTES §37).
--
-- At the owner's request, 2026-09-13: the "Where your notes go" card leaves
-- Settings, and the same approved D13 wording is shown once after signing in,
-- with an "I understand" button and a Privacy link in Settings to reread it.
-- This column is when that button was pressed, so the notice appears once per
-- account rather than once per phone and once per laptop.
--
-- SAFE TO APPLY BEFORE OR AFTER THE BUILD THAT USES IT. Nothing is dropped or
-- renamed (§31). Before it exists the app remembers the answer on the device
-- instead, and says so in the console.

alter table public.profiles
  add column if not exists privacy_accepted_at timestamptz;
