-- Which pet the student picked for their streak.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS ON THE PROFILE AND NOT IN THE BROWSER
--
-- It is a pet. It is supposed to be YOURS — the same one on your phone and on
-- your laptop. A choice kept in browser storage would give the same person a
-- potato at home and a cat in the library, which is the one thing a pet must
-- not do.
--
-- It follows the same reasoning as D12, which put the Gemini key on the profile
-- row for cross-device use rather than in local storage, and it inherits the
-- same protection: the profiles RLS policies already restrict every row to its
-- owner, so nothing new is needed here.
-- ---------------------------------------------------------------------------

alter table public.profiles
  add column if not exists pet text;

-- A check rather than an enum: adding a third pet later is then one line here
-- instead of a type migration, and the app's own PET_SPECIES list stays the
-- place the choice is really defined.
--
-- Found by what it checks rather than by name, for the reason 0006 records: a
-- `drop constraint if exists <guessed name>` is a silent no-op when the guess
-- is wrong, which leaves the old constraint in force while the migration
-- reports success — invisible from the dashboard where this gets run.
do $$
declare
  existing text;
begin
  select conname into existing
  from pg_constraint
  where conrelid = 'public.profiles'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%pet%';

  if existing is not null then
    execute format('alter table public.profiles drop constraint %I', existing);
  end if;
end $$;

alter table public.profiles
  add constraint profiles_pet_check
  check (pet is null or pet in ('potato', 'cat'));

-- NULL means "has not chosen", and the app shows its default. Deliberately not
-- defaulted to 'potato' in the database: then a later change of default would
-- silently reassign the pet of everyone who never picked one, and the app —
-- which is where the default belongs — could never tell the two apart.
