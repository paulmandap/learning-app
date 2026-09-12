# AI Study App — session handoff

Written 2026-09-06, at commit `f38671a`. Hand this to the next session as its
opening prompt. Everything below is either verifiable in the repo or recorded in
`docs/ARCHITECTURE_NOTES.md` with the date it was measured.

---

## Read these three files fully before doing anything

- `docs/AI_STUDY_APP_MVP_SPEC.md` — the spec, sections 0–8. Decisions **D1–D14**.
- `docs/ARCHITECTURE_NOTES.md` — external facts and **every measurement, with
  dates**. 2,523 lines; read it all. **Sections 15–21 are the most recent work**
  and where anything else disagrees with them, they win.
- `docs/ARCHITECTURE_ASSESSMENT.md` — Phase 0 assessment.

These are the source of truth and they outrank this handoff. Do not re-derive
what the notes already measured — several of those numbers cost hours, and more
than one cost a wrong conclusion first.

## What this is

> I give the app my notes. It asks me about them, shows me where every answer
> came from, remembers what I got wrong, and grades my written answers.

The first two are table stakes (NotebookLM does them). The last two are the
product. Five users, all free tiers, owner is the only developer and uses it
daily on an iPhone in dark mode.

## Where we are

Working app, deployed, in daily use.

- **Live:** https://learning-app-6kk.pages.dev
- **Deploy:** `npx wrangler pages deploy dist --project-name=learning-app --branch=main`
- **608 tests pass**, 2 skipped (live Gemini, behind `LIVE_GEMINI=1`). Typecheck clean.
  (447 when this was written on 2026-09-06; Phases A-G added the rest.)
- Stack: Expo SDK 57 + Expo Router, TypeScript strict, Supabase, TanStack Query,
  one Zustand store, Zod, Vitest. React pinned to 19.2.3. Node 22.

**The MVP and the whole of the spec's "Later" list are delivered.** What has
driven the last several sessions is the owner using the app and reporting what
is wrong with it — which is now the most reliable source of work in the project.
Expect to be handed a bug report or a "could you reword this" rather than a
roadmap item.

### Screens

Study (home) · Add notes · Set (Preparing / Ready) · Flashcards · Quiz · Fill in
the blanks · **Notes list** · **Note editor** · Progress · Settings · Sign in.

Navigation is four tabs — Study · Notes · Progress · Settings — as a bottom bar
under 800px and a rail beside the content above it. Everything that is a *place*
is a tab; everything that is a *task* (a deck, a quiz, a note) is pushed above
the tabs with its own back control.

### Migrations — 15, all applied and verified

`0001` schema · `0002` RLS · `0003` views (`security_invoker`) · `0004` storage +
`touch_heartbeat` · `0005` `review_state` · `0006` `attempts.mode` gains
`'blanks'` · `0007` `variant_prompt` + `rubric_verified` · `0008` salvage
unmarkable short answers · `0009` `byte_size` + `study_days` · `0010`
`chat_usage` + `claim_chat_message` · `0011` `profiles.pet` · `0012` `notes` ·
`0013` backfill `byte_size` · `0014` allow `'dog'` · `0015` retire `topic_stats`
and `study_items.form` (applied 2026-09-12 — and it took production down for
hours, see NOTES §31 before applying anything like it).

## Rules — these are not negotiable

- **Do NOT commit or push unless asked.** The owner reviews. When he asks, the
  message carries no attribution to you. He usually asks for the **commands** to
  run himself rather than for you to push — give him a copy-paste block.
- Never commit secrets. `.env` is gitignored; `.env.example` holds names only.
  Scan what you are about to stage, not just what you wrote.
- Tests must pass with **no network**. Live Gemini tests behind `LIVE_GEMINI=1`.
- **Deterministic logic lives in `src/core/**` and must NOT import react-native
  or expo-\*.** This is what makes Vitest work at all and what lets `scripts/`
  drive the real pipeline from Node. Do not erode it.
- Don't add dependencies without a measured reason. There are still none beyond
  the framework — no charting library, no image library, no Playwright.
- **The prompt asks; the validator checks.** A prompt rule with no deterministic
  check behind it is a wish.
- **No technical jargon in user-facing text.** Never: OCR, pipeline, chunk,
  model, token, cloze, embeddings, bytes.
- **If something requires changing an approved decision: STOP.** Report the
  problem, the evidence, the options and a recommendation. Do not route around
  it. Several of this project's best outcomes came from doing exactly that.
- **Definition of done:** typecheck + tests + `expo export` + `tests/boot.test.ts`
  + deploy + **production bundle hash matches local** + recorded in
  `ARCHITECTURE_NOTES.md` with its date and conditions.

## Deliberate deviations — do NOT "fix" these

Each was decided with evidence. Reversing one silently would undo a measurement.

1. **Card-count cap removed** (D3). The requested count IS the target.
2. **Source grounding is by sentence INDEX**, not verbatim excerpt.
   `SOURCE_SUPPORT_THRESHOLD = 0.22`, widening ±1 sentence (NOTES §6.2).
3. **`web.output: 'single'` uses `public/index.html`**, NOT `app/+html.tsx`
   (NOTES §2.8 — `+html.tsx` is silently ignored in SPA mode).
4. **"What we read" screen deleted**; its drop-summary moved to the set screen.
5. Rubrics only on `short_answer` items.
6. **`LIGHT_LADDER`** — a fallback ladder of models, reversing D11's two-ID rule.
   Quota is per model (NOTES §6.5).
7. **Levels are EXCLUSIVE**, reversing D2. This is also why each level keeps its
   own position in a deck (NOTES §17.1).
8. **Dropped cards are replaced** by one bounded top-up pass.
9. **A partial counts as NEITHER right nor wrong** in `sectionSplit` and
    `sectionTrends` (NOTES §32, 2026-09-12). Measured before it was changed:
    2 partials in 312 answers, 2 of 17 sections moved, no section changed which
    list it appears in. `MIN_SECTION_ATTEMPTS` gates on `scored`, not
    `attempts`, and the two functions must keep one definition or the same row
    would show a rate and a direction computed differently.
10. **Typed answers are never auto-marked wrong on a near miss** (NOTES §9.2). No
   character-similarity threshold can separate a typo from a minimal pair.
11. **Mastery bands key on consecutive correct answers, not on the schedule**
    (NOTES §18.1). The 21-day interval version could not move for 23 days.
12. **The upload cap is set by storage, not by the reader** (NOTES §15.2) —
    the inverse of what §12.2 originally recorded. 25 MB per file, 45 MB reader
    ceiling, measured against Google's real 50 MB.

## Hard-won gotchas — do not rediscover these

**Gemini and the free tier**
- **`models.list` lies.** Verify with a real `generateContent` call. Availability
  ROTATES. See the banner in `src/ai/models.ts`.
- **Latency swings ~5.6× on the free tier.** Gate any timing measurement on a
  one-token probe answering in <5 s, or the number is noise.
- 503 must be retried like 429. Invalid key is HTTP 400 / `INVALID_ARGUMENT`.
- `Retry-After` is unreadable from browser JS; the 10/20/40 s ladder is the real
  mechanism.
- `maxOutputTokens` budgets thinking **and** answer together (NOTES §13.1).

**Postgres, PostgREST and migrations**
- **A missing table reports `PGRST205`, not `42P01`.** PostgREST rejects against
  its schema cache before Postgres sees the query (NOTES §19.4).
- **Adding a column to a table that already has rows is half a migration.** 0009
  added `byte_size` and never backfilled it; the space figure was wrong for a
  month (NOTES §20.1).
- **Find a constraint by what it checks, not by its name.** `drop constraint if
  exists <guessed name>` is a silent no-op that leaves the old one in force.
- `auth.uid()` is NULL in the dashboard SQL editor. To exercise an RLS function
  there, impersonate inside a `DO` block and end with `RAISE EXCEPTION` so the
  message carries the result and the abort rolls back the test rows (NOTES §15.1).
- **Migration order matters.** A build that SELECTs a column the database has
  not got breaks every query using it. Prefer a retry on the "no such column"
  error over making the deploy order load-bearing (NOTES §19.4).
- **"Safe to run in either order" means DEPLOY order, not commit order.** This
  took production down on 2026-09-12 (NOTES §31). 0015 dropped
  `study_items.form`; the code that stopped selecting it was committed six days
  before it was deployed, and in that gap every deck answered `42703`.
  **Before applying any migration that DROPS or RENAMES anything, run
  `npx tsx --env-file=.env scripts/deploy-status.ts`** and confirm production
  is not behind it. The script says so in as many words, and refuses to compare
  when it cannot find the live commit in git.

**The browser, iOS and the harness**
- **iOS force-zooms any focused input under 16px and does not zoom back.** Use
  `INPUT_FONT_SIZE`; `tests/input-zoom.test.ts` fails the build otherwise.
- **`tests/boot.test.ts` runs the built bundle and asserts `#root` fills.** Always
  run it after building.
- **It runs on jsdom, which computes NO LAYOUT.** It can prove the app mounts
  and nothing more. A scroll bug that made three of four tabs unusable on a
  phone passed all 618 tests (NOTES §33) — use
  `npx tsx --env-file=.env scripts/scroll-probe.ts --height 420` for anything
  about layout, and pass a height small enough that the content must overflow,
  or it reports "ok" without testing anything.
- **Verify UI changes by looking at them** — `npm run screenshot`, and pass
  `--dark`, because the owner uses dark mode and every screenshot before
  2026-09-06 was light.
- **Expo Router's typed routes only regenerate from the dev server.** Adding a
  route breaks typecheck until `npx expo start` runs briefly. `expo export` does
  not do it and `expo typegen` is not a command (NOTES §19.5).
- **Git Bash rewrites a lone `/` argument into a Windows path.** Run
  `scripts/screenshot.ts /` from PowerShell, or set `MSYS_NO_PATHCONV=1`.
- Cloudflare needs a few seconds to propagate; a bundle-hash mismatch
  immediately after a deploy is worth re-reading before investigating.
- Vitest uses `pool: 'forks'` (Windows). It flakes right after edits — re-run.

**Driving the app from Node**
- **A field's value is not `innerText`.** Neither is a placeholder. Read
  `textarea.value` / `input.value` through the DOM.
- **A wait that passes instantly is a test that stopped testing.** Wait on
  something that can only be true afterwards — `location.pathname` changing, not
  words that may already be on the previous screen (NOTES §19.7).
- `--click` matches an accessibility label as well as visible text, for
  icon-only controls.

**Anything that fails silently will cost you a wrong conclusion.** It has now
happened four times. Log fallbacks and best-effort failures.

## Credentials and operations

All in `.env` (gitignored — read it, never commit or print it):
`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY`.

- The owner is fine with the Gemini key in `.env` and in transcripts. **Do not nag.**
- Test users: `iso-a@example.test` / `iso-b@example.test`, password
  `IsolationTest!2026`. Not in `.env`; pass them as env vars.
- **Never** use a Supabase secret/service-role key — it bypasses RLS and would
  make the isolation test meaningless.
- **There is no Supabase management token.** Migrations are applied by the owner
  pasting SQL into the dashboard. Write the migration, hand him the SQL in a
  copy-paste block, wait for confirmation, then verify it took effect yourself.
- `SUPABASE_DB_URL` is a GitHub secret; the monthly backup workflow runs.
- **Clean up after live tests.** `scripts/seed-progress.ts --clear`, delete probe
  notes and sets. Synthetic data left in a shared account has already produced
  one wrong conclusion (NOTES §9.4).

### Useful commands

```
npm test                    447 tests, no network
npm run typecheck
npm run export:web
npm run screenshot -- /progress out.png --width 393 --dark
npm run test:isolation      19/19 cross-user RLS assertions (needs TEST_USER_* env vars)
npm run backup
npx tsx --env-file=.env scripts/deploy-status.ts   what is live, and is it behind a migration
npx tsx --env-file=.env scripts/notes-probe.ts [--generate]
npx tsx --env-file=.env scripts/study-probe.ts <set-id>
npx tsx --env-file=.env scripts/seed-progress.ts [--days 30] [--clear]
npx tsx scripts/make-pet-assets.ts            # cuts every assets/*-stages.*
npx tsx --env-file=.env scripts/verify-phase2.ts --pdf <file>
```

## What is genuinely open

1. **The backup HAS now been restored, once — and the drill found three
   faults** (2026-09-12, NOTES §29).
   - **Application data restores perfectly.** 11/11 public tables, 40 policies,
     632 rows, every count matching the dump, into PostgreSQL 17.
   - **Accounts do not.** `schema.sql` is public-only while `data.sql` carries
     `auth` and `storage` rows, so the backup holds 7 users, 252 sessions and
     310 refresh tokens with no tables to put them in. They land only in a
     target that already provides the `auth` schema — a real Supabase project,
     which is **still untested**.
   - **`on_auth_user_created` is not in the dump** (pg_dump emits a trigger
     with its table, and `auth.users` is not dumped). After any restore it must
     be recreated, or new sign-ups silently get no `profiles` row.
   - **Uploaded originals are not recoverable.** `storage.objects` is metadata;
     the bytes are not in a database dump. Cards survive, source images do not.
   - Two faults had nothing to do with restoring: the backup had been **failing
     on every run since Phase A** (a `grep` matching nothing exits 1 under
     `set -e`), and the **passphrase had been lost**, making every retained
     artifact undecryptable. Both fixed; the passphrase was rotated and the old
     artifacts written off.

   **Still open:** the app has never been run against a restored database
   (needs Docker and ~30 GB; C: has 6.2 GB free), and no restore into a real
   Supabase project has been attempted.
2. **The generation prompt's "every card must stand on its own" rule has no
   validator**, while the rephrase path has one. Adding it would start dropping
   cards on the main path, so it needs measuring first (NOTES §10.1).
3. **Rubric verification is measured on four items.** Two flags, both defensible,
   is encouraging and is not a false-positive rate.
4. **Variants are unmeasured for effect.** Seven rewrites were well-formed;
   whether a rephrasing helps anyone learn needs review history nobody has yet.
5. **`MODELS.strong` is on no code path** and has never been exercised on a real
   generation.
6. **Blank supply is thin** — about one flashcard in three, almost all
   Remember-tier. Structural, not a bug (NOTES §9.4).

## Your task

Whatever the owner asks for. He reports real defects from daily use and they are
usually right even when the diagnosis is not — "it's because i deleted some" was
a correct observation with the wrong cause, and the cause was a genuine bug.

The habit that has served this project best, and which is worth keeping:

- **Reproduce before fixing.** Every recent fix was confirmed against the live
  database first, and two turned out to be different bugs from the reported one.
- **Measure before building.** `scripts/*-probe.ts` exist because every feature
  that skipped this produced a wrong conclusion first.
- **Say no with evidence.** This project has declined a feature on measured
  grounds three times — label questions, the Dice grader, pdf.js — and all three
  were right.
- **Write down what was measured, with its date and conditions**, in
  `ARCHITECTURE_NOTES.md`. That file is why any of the above is knowable.
