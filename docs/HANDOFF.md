# AI Study App — session handoff

Written 2026-09-05, at commit `3fe870d`. Hand this to the next session as its
opening prompt. Everything below is either verifiable in the repo or recorded in
`docs/ARCHITECTURE_NOTES.md` with the date it was measured.

---

## Read these three files fully before doing anything

- `docs/AI_STUDY_APP_MVP_SPEC.md` — the spec, sections 0–8. Decisions D1–D13.
- `docs/ARCHITECTURE_ASSESSMENT.md` — Phase 0 assessment.
- `docs/ARCHITECTURE_NOTES.md` — external facts and **every measurement, with
  dates**. Sections 9 and 10 are the most recent work. 1,138 lines; read it all.

These are the source of truth and they outrank anything in this handoff. Do not
rely on assumptions over them, and do not re-derive what §5–§10 already measured
— several of those numbers cost hours and one of them cost a wrong conclusion.

## What this is

> I give the app my notes. It asks me about them, shows me where every answer
> came from, remembers what I got wrong, and grades my written answers.

The first two are table stakes (NotebookLM does them). The last two are the
product. Five users, all free tiers, owner is the only developer.

## Where we are

Working app, deployed, in daily use by the owner.

- **Live:** https://learning-app-6kk.pages.dev
- **Deploy:** `npx wrangler pages deploy dist --project-name=learning-app --branch=main`
- **322 tests pass**, 2 skipped (live Gemini, behind `LIVE_GEMINI=1`). Typecheck clean.
- Stack: Expo SDK 57 + Expo Router, TypeScript strict, Supabase, TanStack Query,
  one Zustand store, Zod, Vitest. React pinned to 19.2.3. Node 22.

**Spec phases 0–4 complete.** So is the spec's entire "Later" list, except four
items deliberately deferred:

| §6 "Later" item | Status |
|---|---|
| fill-in-the-blank | **built** — Phase 8a, NOTES §9 |
| diagram / label questions | **gate FAILED** — NOTES §8.2. Correctly not built |
| adaptive scheduling | **built** — Phase 6 |
| spaced repetition | **built** — Phase 6, SM-2 variant, NOTES §7 |
| LLM verification of Apply-tier rubrics | **built** — Phase 8c, NOTES §10.2 |
| variants of missed items | **built** — Phase 8b, NOTES §10.1 |
| social / collab | deferred |
| other providers | deferred |
| backend-owned key | deferred |
| native iOS | deferred — the only route to real swipe haptics |

**There is no roadmap left.** That is why you are here.

### Screens

Home (Continue + set list + due counts) · Add notes · Set (Preparing / Ready) ·
Flashcards · Quiz · **Fill in the blanks** · Settings · Sign in.

### Migrations (7 applied)

`0001` schema · `0002` RLS · `0003` views (`security_invoker`) · `0004` storage +
`touch_heartbeat` RPC · `0005` `review_state` · `0006` `attempts.mode` gains
`'blanks'` · `0007` `study_items.variant_prompt` + `rubric_verified`.

All applied and verified against the live project.

## Rules — these are not negotiable

- **Do NOT commit or push unless asked.** The owner reviews. (He may ask; then do
  it, with no attribution to yourself in the message.)
- Never commit secrets. `.env.example` holds names only.
- Tests must pass with **no network**. Live Gemini tests behind `LIVE_GEMINI=1`.
- **No technical jargon in user-facing text.** Never: OCR, pipeline, chunk,
  model, token, cloze, embeddings.
- **Deterministic logic lives in `src/core/**` and must NOT import react-native
  or expo-\*.** This is what makes Vitest work at all, and it is what lets
  `scripts/` drive the real pipeline from Node. Do not erode it.
- Don't add dependencies without a measured reason.
- **The prompt asks; the validator checks.** A prompt rule with no deterministic
  check behind it is a wish. This is the project's stated principle and it has
  caught real defects — see NOTES §10.1.
- **If something requires changing an approved decision: STOP.** Report the
  problem, the evidence, the options and a recommendation. Do not route around
  it. Two of this project's best outcomes came from doing exactly that.
- **Definition of done:** typecheck + tests + `expo export` + `tests/boot.test.ts`
  + deploy + **production bundle hash matches local** + the result recorded in
  `ARCHITECTURE_NOTES.md` with its date and conditions.

## Deliberate deviations from the spec — do NOT "fix" these

Each was decided with evidence. Reversing one silently would undo a measurement.

1. **Card-count cap removed** (D3). The requested count IS the target; anti-padding
   lives in the prompt, dedup and the validators.
2. **Source grounding is by sentence INDEX**, not verbatim excerpt.
   `SOURCE_SUPPORT_THRESHOLD = 0.22`. `resolveSource` widens ±1 sentence when the
   cited line alone doesn't support the answer — without this, "LEAF" /
   "primary photosynthetic organ" scored 0 and good cards died (NOTES §6.2).
3. **`web.output: 'single'` uses `public/index.html`**, NOT `app/+html.tsx`
   (NOTES §2.8 — `+html.tsx` is silently ignored in SPA mode).
4. **"What we read" screen deleted**; its drop-summary line moved to the set screen.
5. Rubrics only on `short_answer` items.
6. **`LIGHT_LADDER`** — a fallback ladder of models, reversing D11's two-ID rule.
   Quota is per model; the pinned one 429'd while six others served (NOTES §6.5).
7. **Levels are EXCLUSIVE**, reversing D2. Understand no longer includes Remember.
   Level buttons show per-level counts.
8. **Dropped cards are replaced** by one bounded top-up pass, capped at the number
   dropped.
9. **Typed answers are never auto-marked wrong on a near miss** (NOTES §9.2). The
   roadmap specified bigram-Dice ≥ 0.85; measured over 49 cases it scored 28/49
   with 20 false rejects, and "afferent" vs "efferent" scored 0.857 — it would
   mark a genuinely wrong answer RIGHT. No character-similarity threshold can
   separate a typo from a minimal pair, so a near miss asks the student instead.

## Hard-won gotchas — do not rediscover these

- **`models.list` lies.** Verify with a real `generateContent` call. Availability
  ROTATES: models recorded as permanently 503 later served fine, and the pinned
  one went 429. See the banner in `src/ai/models.ts`.
- **Latency swings ~5.6× on the free tier.** Criterion B measured 218.6s / 181.6s
  / **80.6s** on identical code and input within one hour. **Gate any timing
  measurement on a one-token probe answering in <5s, or the number is noise.**
- **iOS haptics: taps buzz, swipes never do.** Three attempts, settled. Sound
  plays and the haptic doesn't from the *same line*. Needs a native build.
  **Do not attempt a fourth fix.**
- **Anything that fails silently will cost you a wrong conclusion.** It has
  happened three times: an invisible model fallback looked like a prompt
  regression; a swallowed top-up error looked like dead code; and a fire-and-forget
  write looked like silent data loss when the check simply raced it. Log fallbacks
  and best-effort failures.
- **Verify UI changes by looking at them.** Headless Chrome over the DevTools
  Protocol (no dependency) caught a cropped diagram, a collapsed image, and a
  header reading `set/[id]/blanks` to the user. Typecheck and tests caught none
  of those.
- 503 must be retried like 429. Invalid key is HTTP 400 / `INVALID_ARGUMENT`.
- `Retry-After` is unreadable from browser JS; the 10/20/40s ladder is the real
  mechanism.
- Vitest uses `pool: 'forks'` (Windows). It flakes right after edits — re-run.
- **`tests/boot.test.ts` runs the built bundle and asserts `#root` fills. Always
  run it after building** — a React mismatch once shipped a blank page while
  everything else passed.
- **Migration order matters.** `0006` was additive on a write path and could ship
  either side of a deploy. `0007` added columns the app SELECTS, so deploying
  first would have broken every card query. Check which kind you have.

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
  pasting SQL into the dashboard SQL editor. Write the migration, hand him the
  SQL, wait for confirmation.
- `SUPABASE_DB_URL` is set as a GitHub secret; the monthly backup workflow runs
  and is verified.

### Useful commands

```
npm test                    322 tests, no network
npm run typecheck
npm run test:isolation      17/17 cross-user RLS assertions
npm run verify:phase2 -- --pdf <file>
npm run probe:diagram <file>
npm run probe:quality       rephrase + rubric check on real cards, read-only
npm run backup
npx tsx --env-file=.env scripts/label-box-probe.ts <img>
```

## What is genuinely open

Nothing is broken. These are the honest gaps, each already recorded:

1. **Backup verifies structure, not data.** The Phase 5 AC asked for "a row count
   for `study_items` matching the database"; the workflow checks that all eight
   tables and both Phase 8 columns appear and that the files are non-empty, but
   not that the rows came across. A partial dump would pass. This is the only
   item with permanent downside.
2. **The generation prompt's "every card must stand on its own" rule has no
   validator**, unlike the rephrase path which now does. Adding one would start
   dropping cards on the main path, so it needs measuring first (NOTES §10.1).
3. **Rubric verification is measured on four items.** Two flags, both defensible,
   is encouraging — it is not a false-positive rate.
4. **Variants are unmeasured for effect.** Seven rewrites were well-formed;
   whether a rephrasing helps someone learn a card they kept failing needs review
   history nobody has yet.
5. **Blank supply is thin** — 5 blanks from 14 flashcards, and they are almost
   entirely Remember-tier. The cause is structural: the generation prompt tells
   the model to write answers in its own words, which is right for card quality
   (NOTES §9.4). Not a bug; a ceiling.
6. **`MODELS.strong` is on no code path** and has never been exercised on a real
   generation.
7. **No screenshot/browser-driving harness is committed.** The one used to catch
   the bugs above was built ad hoc in a temp directory and is gone. Recreating it
   is cheap (Node's built-in `WebSocket` + Chrome `--remote-debugging-port`, no
   dependency) and pays for itself immediately.

## Your task

**Plan what comes next — do not start building.**

The MVP is delivered and the roadmap is exhausted, so the question is no longer
"what is left on the list" but "what would actually make this better for five
students". Answer that with evidence, not enthusiasm.

Produce a plan that:

- **States the goal in the owner's terms**, not in features. What gets better,
  for whom, and how you would know.
- **Proposes 2–4 candidate directions with a recommendation**, each sized, each
  with an acceptance criterion in the spec's style (`§6` is the model: a concrete,
  checkable claim, not "works well"). Include what you would NOT build and why —
  this project has said no to a feature on measured evidence twice, and both were
  right.
- **Names what must be measured before committing to each**, and how. This
  codebase has a strong habit of probing before building (`scripts/*-probe.ts`),
  and every feature that skipped it produced a wrong conclusion first.
- **Flags anything that would change an approved decision (D1–D13)**, with the
  evidence and the options, for the owner to decide.
- **Says what it would cost** — model calls, migrations, owner time. The free
  tiers are real constraints: Supabase Free is 500 MB and pauses after 7 days
  idle; Gemini quota is per model per project and sheds load unpredictably.

Consider the open items above, but do not treat them as the answer — the best
next move may be none of them. Retention, trust in the cards, and whether anyone
comes back are the product's actual stakes.

When the plan is ready, stop and wait for the owner's go-ahead.
