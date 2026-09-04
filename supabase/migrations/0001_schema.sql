-- Phase 1 — schema (spec §4).
-- Tables only. RLS, views, storage and RPCs follow in later migrations so each
-- concern can be reviewed on its own.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------- profiles --
-- id is the auth user id. gemini_api_key holds the user's own Gemini key (D12,
-- explicitly approved): it lives here so the key follows the user across
-- devices, protected by RLS. It is never an environment variable and is never
-- readable by another user.
create table if not exists public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  display_name  text,
  gemini_api_key text,
  created_at    timestamptz not null default now()
);

-- ------------------------------------------------------------- study_sets --
create table if not exists public.study_sets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null,
  status     text not null default 'empty'
             check (status in ('empty', 'generating', 'ready', 'failed')),
  plan       jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists study_sets_user_idx on public.study_sets (user_id, updated_at desc);

-- --------------------------------------------------------------- documents --
create table if not exists public.documents (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  study_set_id     uuid not null references public.study_sets (id) on delete cascade,
  kind             text not null check (kind in ('text', 'pdf', 'image')),
  title            text not null,
  storage_path     text,
  page_count       integer not null default 0 check (page_count >= 0),
  status           text not null default 'uploaded'
                   check (status in ('uploaded', 'read', 'failed')),
  unreadable_pages integer[] not null default '{}',
  created_at       timestamptz not null default now()
);
create index if not exists documents_set_idx on public.documents (study_set_id);
create index if not exists documents_user_idx on public.documents (user_id);

-- ---------------------------------------------------------- document_pages --
create table if not exists public.document_pages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  page_index  integer not null check (page_index >= 0),
  text        text not null default '',
  readability numeric not null default 0 check (readability >= 0 and readability <= 1),
  headings    text[] not null default '{}',
  unique (document_id, page_index)
);
create index if not exists document_pages_doc_idx on public.document_pages (document_id, page_index);

-- ------------------------------------------------------------- study_items --
-- excerpt_verified means EXACTLY ONE THING: the deterministic validator matched
-- source_excerpt against the stored page text under the §3.2.4 rules. It does
-- NOT mean the item is factually correct, nor human- nor second-model-verified.
-- Items that fail excerpt matching are dropped before insertion, so in the MVP
-- this column is true for every stored row by construction.
create table if not exists public.study_items (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users (id) on delete cascade,
  study_set_id     uuid not null references public.study_sets (id) on delete cascade,
  document_id      uuid references public.documents (id) on delete cascade,
  page_index       integer,
  section_title    text,
  kind             text not null check (kind in ('flashcard', 'mcq', 'short_answer')),
  level            text not null check (level in ('remember', 'understand', 'apply')),
  form             text,
  prompt           text not null,
  answer           text not null,
  options          jsonb,
  rubric           jsonb,
  source_excerpt   text not null,
  excerpt_verified boolean not null default false,
  check_flag       text,
  topic            text,
  hidden           boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists study_items_set_idx on public.study_items (study_set_id) where hidden = false;
create index if not exists study_items_level_idx on public.study_items (study_set_id, level) where hidden = false;

-- ---------------------------------------------------------------- attempts --
create table if not exists public.attempts (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  study_item_id uuid not null references public.study_items (id) on delete cascade,
  study_set_id  uuid not null references public.study_sets (id) on delete cascade,
  mode          text not null check (mode in ('flashcards', 'quiz')),
  result        text not null check (result in ('correct', 'partial', 'incorrect')),
  score         integer,
  max_score     integer,
  answer_text   text,
  feedback      text,
  created_at    timestamptz not null default now()
);
create index if not exists attempts_item_idx on public.attempts (study_item_id, created_at desc);
create index if not exists attempts_set_idx on public.attempts (study_set_id, created_at desc);

-- --------------------------------------------------------------- heartbeat --
-- Keepalive only. Supabase Free pauses a project after ~7 days of low database
-- activity and restore is manual, so a scheduled real write keeps it awake.
-- No user_id: this table holds no user data. Writes go only through the
-- security-definer RPC in 0004; direct client access is denied by RLS.
create table if not exists public.heartbeat (
  id bigserial primary key,
  ts timestamptz not null default now()
);
