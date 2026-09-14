-- Where the labels are on a picture, so a card can cover its answer (NOTES §44).
--
-- The owner, 2026-09-14: a card made from their diagram showed the picture with
-- the answer printed in it — "it's not censored". Measured before building:
-- Gemini's main model placed 37 of 37 labels so that a cover hid them
-- completely; its backup placed 39 of 58.
--
-- ADDITIVE ONLY: one nullable column. Safe in either deploy order — until it
-- exists the app reads nothing, and every picture shows with the answer rather
-- than with the question.
--
-- Null means not located yet. Otherwise:
--   { "model": "gemini-3.6-flash",
--     "labels": [ { "text": "Accumulator", "box": [ymin, xmin, ymax, xmax] } ] }
-- with coordinates in thousandths of the picture. Written by the row's owner
-- under the existing documents_update_own policy (0002), so no policy changes.

alter table public.documents add column if not exists labels jsonb;
