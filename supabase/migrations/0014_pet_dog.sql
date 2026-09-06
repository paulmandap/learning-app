-- A third pet: the dog.
--
-- 0011 pinned the choice to ('potato', 'cat') with a check constraint, and said
-- adding another should be one line here plus one in PET_SPECIES. This is that
-- line. The constraint is found by what it checks rather than by name, for the
-- reason 0006 records: `drop constraint if exists <guessed name>` is a silent
-- no-op when the guess is wrong, leaving the old constraint in force while the
-- migration reports success.

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
  check (pet is null or pet in ('potato', 'cat', 'dog'));
