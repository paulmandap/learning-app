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
- **1150 tests pass**, 3 skipped (live Gemini behind `LIVE_GEMINI=1`, and the
  CI-only build check). Typecheck clean. (447 when this was written on
  2026-09-06; Phases A-G and the NOTES §35–§47 work added the rest.)
- Stack: Expo SDK 57 + Expo Router, TypeScript strict, Supabase, TanStack Query,
  one Zustand store, Zod, Vitest. React pinned to 19.2.3. Node 22.

**The MVP and the whole of the spec's "Later" list are delivered.** What has
driven the last several sessions is the owner using the app and reporting what
is wrong with it — which is now the most reliable source of work in the project.
Expect to be handed a bug report or a "could you reword this" rather than a
roadmap item.

### Screens

Study (home) · Add notes · Set (Preparing / Ready) · Flashcards · Quiz · Fill in
the blanks · **Notes list** · **Note editor** · **Community** · Progress ·
Settings · **Nomi** · Sign in.

Navigation is five tabs — Nomi (Home, called Study until NOTES §40) · Notes ·
Community (NOTES §46) · Progress · Settings — as a bottom bar
under 800px and a rail beside the content above it. Everything that is a *place*
is a tab; everything that is a *task* (a deck, a quiz, a note) is pushed above
the tabs with its own back control.

### Migrations — 24; **0024 waiting**, the rest applied and verified

**0024 (folders, unsend-for-you, streak restores — NOTES §47) is written and
waiting.** Additive apart from recreating `global_chat`, which it recreates in
the same file, so `deploy-status.ts` correctly calls it safe to apply before or
after its deploy. Until it is applied: sets list ungrouped (`listSets` retries
without `folder_id`), "Unsend for me only" fails, and Progress offers no streak
restore. Everything else is unaffected.

```
npx wrangler pages deploy dist --project-name=learning-app --branch=main
```
is the deploy. `deploy-status.ts` REPORTS — see §46.7 and the gotchas below.

**0021, 0022 and 0023 were applied by the owner on 2026-09-16** and verified the
same day (NOTES §46.7–10): isolation **61/61** against the live project in both
directions, and `scripts/community-probe.ts` **11/11** end to end in the built
app as the second user.

Getting there took production down once, silently, for the length of one gap —
`scripts/deploy-status.ts` was run in place of the deploy, so 0022 dropped a
constraint the live bundle was still upserting on and every schedule write in
the app answered 42P10. **Read §46.7 before applying any destructive pair.** The
order below is the order any future one needs.

**0021 and 0022 (community, NOTES §46) are written and waiting.** Until 0021 is
applied the Community tab says "Sharing isn't switched on yet" and everything
else works exactly as before. **THE ORDER IS NOT OPTIONAL:**

1. apply **0021** — additive only; safe before or after this code deploys
2. **`npx wrangler pages deploy dist --project-name=learning-app --branch=main`**
   — this is the deploy. `deploy-status.ts` REPORTS; it does not deploy anything
3. `npx tsx --env-file=.env scripts/deploy-status.ts` — it must say
   `production is exactly HEAD`. "production is 1 commit(s) behind HEAD" means
   step 2 did not happen; do not go on
4. apply **0022**, which drops 0005's old single-column unique

Applying 0022 early is NOTES §31 again: the deployed bundle asks PostgREST for
`on_conflict=study_item_id`, the constraint that satisfies it is gone, and
Postgres answers **42P10 for every answer in the app** — on every set, shared or
not. Nothing would be scheduled again until the deploy caught up.

Then verify, in this order: `scripts/isolation-test.ts` (it gained ~20 checks in
both directions), then `scripts/community-probe.ts` (**written and never run** —
expect it to need a fix on its first outing), then `npm run screenshot` of
`/community` with something actually shared.

**0020** (daily reminders, NOTES §45) was applied by the owner on 2026-09-15,
with the sender secret's SHA-256 in `reminder_sender`, and verified the same
day: isolation 34/34, the sender's dry run accepted by the database, and
`scripts/reminders-e2e-probe.ts` OK end to end (NOTES §45.8). Additive:
`push_subscriptions`, `reminder_settings`, `reminder_sender` and four functions.

0019 (`documents.labels`) was applied by the owner on 2026-09-14 and covering
was verified in the built app the same day (NOTES §44.5). Until a picture has
positions, its cards show it with the answer, never with the question.

0018 was applied by the owner on 2026-09-14 and verified the same day:
`notes.content` present, the `note-images` bucket takes an upload into the
user's own folder and refuses one into another's, isolation 27/27 (NOTES §43.5).

0016 and 0017 were applied by the owner on 2026-09-13 and verified the same day:
isolation 24/24, `avatar-probe` OK on every save, `nomi-chat-probe` saves the
conversation, `privacy_accepted_at` recorded on the account (NOTES §37.12).
Before that, 0016 missing plus a missing-column code nothing recognised was the
owner's "I can't change my picture" (§37.4).

`0001` schema · `0002` RLS · `0003` views (`security_invoker`) · `0004` storage +
`touch_heartbeat` · `0005` `review_state` · `0006` `attempts.mode` gains
`'blanks'` · `0007` `variant_prompt` + `rubric_verified` · `0008` salvage
unmarkable short answers · `0009` `byte_size` + `study_days` · `0010`
`chat_usage` + `claim_chat_message` · `0011` `profiles.pet` · `0012` `notes` ·
`0013` backfill `byte_size` · `0014` allow `'dog'` · `0015` retire `topic_stats`
and `study_items.form` (applied 2026-09-12 — and it took production down for
hours, see NOTES §31 before applying anything like it) · `0016`
`profiles.avatar`, the private `avatars` bucket, `nomi_conversations` and
`nomi_messages` (NOTES §36) · `0017` `profiles.privacy_accepted_at`, for the
one-time privacy notice (NOTES §37). Both additive; applied 2026-09-13 ·
`0018` `notes.content` and the private `note-images` bucket (NOTES §43) ·
`0019` `documents.labels`, where a picture's labels are (NOTES §44) ·
`0020` reminders: devices, chosen times, and the sender's secret (NOTES §45) ·
`0021` community: `study_sets.visibility`, `set_stars`, `global_messages`, the
five cross-user views, and the wider `review_state` unique (NOTES §46) · `0022`
drops the old `review_state` unique — **after** 0021's code is live.

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
- Don't add dependencies without a measured reason. There is one beyond the
  framework: **Tiptap, for the note editor** (NOTES §43), measured at +146 KB
  compressed on every start when imported, so it is fetched only when a note
  opens. Keep it out of the first download — `tests/screens.test.ts` fails an
  ordinary import. Still no charting library, no image library, no Playwright.
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

1. **Card-count cap removed** (D3). The requested count IS the target — and
   since NOTES §37 the pipeline fills to it: the prompt asks for exactly N, each
   request says how many to take from each part of the text, and a repeated
   answer is dropped. "We left out N cards…" is gone from the set screen, at the
   owner's request.
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
8. **The count is filled, not topped up once.** Up to `MAX_FILL_PASSES` (3)
   rounds ask for what is still owed, from the parts of the notes with fewest
   cards (NOTES §37). Notes too thin for N different cards stop short rather
   than repeat — measured, three sentences asked for 60 gave 6, and a 965-word
   song with a four-times chorus gave 55–57 of 60. `SAME_LINE_OVERLAP` is the
   lever if exactness should win over rewordings.
9. **A partial counts as NEITHER right nor wrong** in `sectionSplit` and
    `sectionTrends` (NOTES §32, 2026-09-12). Measured before it was changed:
    2 partials in 312 answers, 2 of 17 sections moved, no section changed which
    list it appears in. `MIN_SECTION_ATTEMPTS` gates on `scored`, not
    `attempts`, and the two functions must keep one definition or the same row
    would show a rate and a direction computed differently.
10. **Typed answers are never auto-marked wrong on a near miss** (NOTES §9.2). No
   character-similarity threshold can separate a typo from a minimal pair.
11. **"Known" is the card's last answer** (NOTES §38, the owner's decision).
    It was a 21-day interval, which could not move for 23 days (§18.1), then
    three right in a row, which left a set he had just answered at "0 of 10".
    Measured first that the count was working. `masteryOf` in
    `src/core/progress.ts` reads `review_state.last_result`; the schedule is
    unchanged.
12. **The upload cap is set by storage, not by the reader** (NOTES §15.2) —
    the inverse of what §12.2 originally recorded. 25 MB per file, 45 MB reader
    ceiling, measured against Google's real 50 MB.
13. **D13's privacy copy is a notice shown once after signing in, not a card
    on Settings** (NOTES §37, the owner's decision). Same words, pinned in
    `src/ui/privacy.tsx`; Settings has a Privacy link to reread them. He asked
    about a long terms page instead and chose the short notice.
14. **Nomi can write — on one tap, from a closed list** (NOTES §37, §39): make a
    set from pasted notes, add notes to a set, **write a reviewer on a topic
    and make a set from it**, rename a set, save a note, change name, pet or
    face. Never delete, sign out or touch the key. `NomiAction` in
    `src/core/nomi-actions.ts` is the allow-list, and a guard reads
    `src/data/nomi-agent.ts` for any destructive import. Requests are
    recognised there by patterns first; **where they miss and Gemini is called
    anyway, its reply may name a topic (`reviewer_topic`) or a new title for
    the offer (`set_title`)**, which go through the same checks
    (`proposeReviewer`, `retitle`). The model names; it never proposes a write.
    An offer now lasts until tapped, turned down, or replaced — not until the
    next message.
15. **The quiz asks every card** (NOTES §38). A flashcard is asked as a choice:
    Gemini writes three wrong answers from the notes (`addQuizChoices`, checked
    by `choicesFrom`), saved on the card's `options` with its kind unchanged —
    so it is still a flashcard and still a blank. Until then the other cards'
    answers stand in (`choicesFromSet`). Marked written questions stay written.
16. **A reviewer's facts are Gemini's, not the student's** (NOTES §39, at the
    owner's request). The one place cards do not come from the student's own
    notes. So the reviewer is saved in Notes as well as made into a set, where
    it can be read and corrected, and the cards cite it through the same
    grounded pipeline as a paste. `checkReviewer` refuses a refusal or a
    one-liner before anything is saved.
17. **Email codes stay the only sign-in** (NOTES §40, the owner's decision,
    2026-09-14). Google sign-in and SMS codes were asked for and declined on
    evidence: SMS is paid on every route (Supabase's providers, and Firebase
    since September 2024), and Google's sign-in on an installed iPhone app
    lands in Safari, which does not share storage with the app — D10's reason.
    Reopen Google only on a sign-in completed inside the installed app.
18. **Home greets by the whole name** (NOTES §40), reversing a first-word rule
    the owner read as a rename that had not worked. Nomi's chat uses it too.
19. **Terms of Use and Privacy Policy at `/terms` and `/privacy`**, readable
    signed out (NOTES §40): 18 and over, Philippine law, text in
    `src/core/legal.ts` with its checkable claims in `tests/legal.test.ts`.
    D13's one-time notice is kept and is not replaced by them.
20. **Nomi celebrates the end of a round** (NOTES §43, the owner's decision,
    reversing §35.5 for one place): `success` or `encouraging` when a flashcard
    deck, a quiz or a round of blanks ends, from `src/ui/nomi-finish.tsx` only.
    Never after a single answer; the pet still keeps the streak. **Widened in
    §45, at the owner's request:** Nomi on Home plays the same reaction on
    coming back within 30 minutes, once, and only for a round `NomiFinish`
    recorded; Nomi studies beside the count on all three study screens; and
    Home's Nomi waves every 20–35 seconds while idle. **And it says something**
    (§45.9): one of several lines for how the round went, in a speech bubble,
    never the same line twice running, and cheering below half — the owner's
    words. `tests/celebrate.test.ts` holds the tough and none lines to that.
21. **A note's `body` is derived; `content` is the note** (NOTES §43). Every save
    writes both, `body` by `docToText`, so everything that reads notes reads
    plain text as before. Pictures are stored by path, never by link.
22. **The card-maker works in set page numbers** (NOTES §43), and each card is
    stored with its own document and that document's page. A set with one
    document is numbered as it always was.
23. **A card's picture goes with the answer unless its answer can be covered**
    (NOTES §44, the owner's decision), reversing Phase 7a's question-side
    picture, which gave every answer away. `placePicture` decides. Label
    positions come from `LABEL_MODEL` alone, with no ladder: measured, it hid
    37 of 37 labels and the backup rung 39 of 58. Never let a ladder or a
    different model place labels without re-running
    `scripts/label-cover-probe.ts` against it.
24. **A message that asks for nothing is notes only when it is too long to be a
    chat message** (NOTES §45), reversing §37's 50-word rule, which offered a
    71-word message about the owner's day as a set. Up to 1,000 characters,
    Gemini decides (`pasted_notes`, 24 of 24 once rule 7 named lyrics) and
    `proposeNotesSet` checks. Messages are saved whole; only a paste is shown
    shortened, and Gemini gets the latest paste's notes (`turnsForModel`).
25. **A service worker exists — for reminders only** (NOTES §45), against spec
    §5's "no service worker". `public/sw.js` has no fetch handler and caches
    nothing. Do not add caching to it without deciding offline on its own merits.
26. **The reminders workflow uses the publishable key and a secret, not the
    database password** (NOTES §45). `reminders_to_send` and `reminders_sent`
    answer only to `REMINDER_SENDER_SECRET`, compared by SHA-256. Web Push is
    ~100 lines on Node's crypto (`scripts/web-push.ts`), not the `web-push`
    package, held to RFC 8291's example in `tests/web-push.test.ts`.
27. **The splash waits for the first screen's data** (NOTES §45), up to 5 s
    after the app knows who is signed in, and still stays at least 1.4 s.
28. **Uploaded photos stay as choices**, six at most, the oldest removed after an
    upload but never the picture in use (NOTES §45).
29. **A shared set is studied IN PLACE, not copied** (NOTES §46, the owner's
    decision, reversing a recommendation to copy). Your answers, due dates and
    streak are your own; the cards stay the owner's. The consequence he accepted:
    deleting a shared set takes its students' history with it, because `attempts`
    and `review_state` cascade from `study_sets`.
30. **NO BASE-TABLE POLICY WAS RELAXED FOR SHARING, AND NONE MAY BE** (NOTES
    §46). Every cross-user read goes through one of five views that run as their
    owner — `public_sets`, `public_set_items`, `public_profiles`, `global_chat`,
    `my_schedule`. The reason is not tidiness: `src/data/dashboard.ts` reads
    `from('study_items')` with no user filter, so an "or the set is public"
    policy on that table would start counting other people's cards into someone's
    own Progress, silently, and `listSets` would list strangers' sets as theirs.
    If you ever need a sixth thing shared, add a sixth view.
31. **Other people see the picture you are USING, and only that one** (NOTES
    §46.9, the owner's decision on 2026-09-16, reversing §46's face-only rule he
    had chosen before using it). Migration 0023's `is_chosen_avatar` serves a
    file from the avatars bucket only while it is the value in somebody's
    `profiles.avatar`. The bucket keeps up to six photos per person as choices
    and **the five they are not using stay private** — granting the bucket
    wholesale is one line shorter and publishes every photo anyone ever
    uploaded, including the ones they replaced. The bucket is still private,
    still signed-in-only, and writing into someone else's folder is still
    refused. The isolation test holds both halves: not-in-use blocked, in-use
    readable.
32. **"Report this card" and written answer choices are NOT offered on a shared
    set** (NOTES §46). Both write to `study_items`, which is update-own, so both
    would match no rows and return no error. The cost is stated rather than
    hidden: Report IS D7's second pass, and a wrong card in a shared set now has
    no way to be flagged.
33. **A card can be CORRECTED as well as reported** (NOTES §47). `editCard`
    changes the question and answer only: `source_excerpt` and
    `excerpt_verified` are untouched — the excerpt is still the sentence the
    card was grounded in, and the flag still means only that the validator
    matched it (0001). It clears `variant_prompt` on a question change and
    `options` on an answer change, because both were written against words that
    no longer exist.
34. **A restored streak is NEVER a row in `study_days`** (NOTES §47).
    `study_days` is what happened; `streak_restores` is what was forgiven, and
    `studyStreak` takes both. Writing a restore into `study_days` would make
    "days studied" and total answers count a day nobody studied.
35. **A folder is a label, not a container** (NOTES §47). `study_sets.folder_id`
    is `on delete set null`: deleting a folder puts its sets back on the top
    level and must never delete them. Tapping, not dragging — a gesture library
    is a dependency, and dragging survives neither a screen reader nor a
    keyboard. One level, one folder per set.
36. **The push `Topic` header must be decodable base64url** (NOTES §47). Apple
    refuses anything else with `400 BadWebPushTopic`; Google accepts it, so
    every test in this repo passed while every reminder was refused for eight
    days. `isValidPushTopic` enforces it and `sendPush` throws rather than
    sending. **Never assert a header's value as a literal in a test** — that is
    what pinned the broken one.

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
- **A prompt that tells the model to "return fewer" gets fewer.** On a pasted
  song it wrote 2 of 10 and nothing was dropped (NOTES §37). And numbering the
  notes by line invites "according to line 93" into the card itself —
  `mentionsPosition` drops those.

**Postgres, PostgREST and migrations**
- **A missing table reports `PGRST205`, not `42P01`.** PostgREST rejects against
  its schema cache before Postgres sees the query (NOTES §19.4).
- **A missing column is `42703` on a read and `PGRST204` on a write.** The app
  checked 42703 only, so before 0016 a face pick said "try again in a moment"
  for ever, and Delete my data failed at its last step. Use `isMissingColumn` /
  `isMissingTable` from `src/core/db-errors.ts` (NOTES §37).
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
- **`deploy-status.ts` REPORTS. It does not deploy.** The deploy is
  `npx wrangler pages deploy dist --project-name=learning-app --branch=main`.
  Running the status script in place of the deploy is what put production into
  §31's state a second time, on 2026-09-16 (NOTES §46.7). What you are looking
  for is `production is exactly HEAD`.
- **A dropped CONSTRAINT breaks a live build as surely as a dropped column,
  and it answers 42P10, not 42703.** PostgREST needs a unique constraint
  matching whatever `on_conflict` the deployed bundle names. §46.7: 0022 dropped
  `review_state`'s old single-column unique while the live bundle still upserted
  on it, and every schedule write in the app failed — invisibly, because that
  upsert's result was thrown away. The detector in `deploy-status.ts` now covers
  constraints, indexes and policies, ignores comments, forgives a drop only when
  the same file recreates that name, and never forgives one built at run time.
  `tests/deploy-status.test.ts` holds it to 0015, 0021 and 0022.

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
- **And the mirror image, which is worse: typecheck can PASS here and FAIL in
  CI.** `.expo/` is gitignored, so on a clean checkout `useSegments()` is
  `[string]` and `segments[1]` is TS2493 — while locally it is a union deep
  enough to index (NOTES §47.8). Never index the segments past 0; read them as
  `readonly string[]` instead (`tests/screens.test.ts` fails any that do). To
  see what CI sees before pushing:
  `Rename-Item ".expo" ".expo-bak"; npm run typecheck; Rename-Item ".expo-bak" ".expo"`
- **A unique rule on an EXPRESSION needs a unique INDEX, not a table
  constraint.** `unique (user_id, lower(name))` inside `create table` is
  `42601: syntax error at or near "("`. It enforces the same thing and still
  raises 23505 (NOTES §47.8).
- **THIS PROJECT CANNOT RUN ITS OWN MIGRATIONS**, so every SQL syntax error is
  found by the owner pasting it, never by CI. Read a new migration for what
  Postgres will accept, not only for what it means. When a paste fails, check
  what actually landed before re-pasting — the editor usually rolls back, but
  "usually" is not evidence.
- **Git Bash rewrites a lone `/` argument into a Windows path.** Run
  `scripts/screenshot.ts /` from PowerShell, or set `MSYS_NO_PATHCONV=1`.
- **`npx` on Windows runs through a `.cmd` shim, and cmd.exe eats `>`.** Any
  `--eval` containing an arrow function arrives truncated and prints
  `undefined`. Import `openPage` from `scripts/screenshot.ts` in a small script
  instead of passing JavaScript on the command line (NOTES §35).
- **Probing animation: use `String.raw` for any regex in page code, and pin
  reduce-motion.** In a plain template literal `\(` and `\d` lose their
  backslashes, so a transform-sampling regex matched nothing and reported a
  still owl twice. `openPage({ reducedMotion })` makes the motion setting part
  of the result rather than the browser's default — which, measured, is
  `no-preference` in headless Chrome (NOTES §35).
- **The test account's Gemini key is a placeholder.** The isolation test writes
  `A-SECRET-KEY-VALUE` into it, so every Gemini call on that account is refused
  as an invalid key. For a live model call, use `GEMINI_API_KEY` from `.env`
  (`scripts/nomi-chat-probe.ts` does) — never mistake the refusal for an outage
  (NOTES §36).
- **The privacy notice covers every screen until it is read** (NOTES §37).
  `openPage` marks it read for the test user by default; pass
  `privacyNotice: 'unseen'` to photograph it.
- **`openPage` cannot see anything between signed out and signed in.** It
  marks the notice read on the device and injects the session before the app
  boots, so nothing is ever fetched signed out — which is how the notice flash
  of NOTES §42 hid from every probe. To reproduce a real sign-in: open `/`
  signed out (`auth: false`), wait, then store the session in localStorage and
  post `{ event: 'SIGNED_IN', session }` on a `BroadcastChannel` named
  `sb-<ref>-auth-token`; supabase-js delivers it to the app like its own.
- **`code()` in `tests/screens.test.ts` strips `/* … */` even inside a string.**
  `app/new.tsx` holds `'.pdf,.txt,image/*'`, so a guard over `code(new.tsx)` lost
  half the file and failed on text that was there. Read that file raw.
- Cloudflare needs a few seconds to propagate; a bundle-hash mismatch
  immediately after a deploy is worth re-reading before investigating.
- Vitest uses `pool: 'forks'` (Windows). It flakes right after edits — re-run.

**Driving the app from Node**
- **A field's value is not `innerText`.** Neither is a placeholder. Read
  `textarea.value` / `input.value` through the DOM.
- **A wait that passes instantly is a test that stopped testing.** Wait on
  something that can only be true afterwards — `location.pathname` changing, not
  words that may already be on the previous screen (NOTES §19.7).
- **`waitFor` and `evaluate` without `awaitPromise` return an async expression's
  Promise, which is truthy.** `scripts/push-probe.ts` "saw" a notification that
  way before it had looked. Have the page write what it found to a variable, and
  wait on the variable (NOTES §45).
- **`page.goto()` reloads the page**, and a reload forgets everything held in
  memory — the Zustand stores, the query cache. To test anything that must
  survive moving between screens, move within the app (`history.pushState` and
  a `popstate` event, then `history.back()`) and leave a marker on `window` to
  prove no reload happened (NOTES §45.6).
- **Nomi's layers on the web:** each picture sits inside the Image's own div, so
  a layer's transform is on the first ancestor that has one, not the picture's
  parent (NOTES §45.6).
- **`openPage` serves `dist/` compressed now**, as Cloudflare does. Uncompressed,
  a throttled cold load measured four times the bytes (NOTES §45).
- **Never take test vectors from the web-fetch tool's summary.** It added a
  character to RFC 8291's ciphertext. Download the raw text and copy from that.
- `--click` matches an accessibility label as well as visible text, for
  icon-only controls. Exactly: the Notes button is "+ New note".
- **The note editor is not a field.** `fill()` cannot type into it. Use
  `page.type()` and `page.press('Enter')`, which send real key events.
  `document.execCommand('insertText')` puts the words in but runs none of the
  editor's shortcuts, so "- " stays a dash and a working shortcut looks broken
  (NOTES §43.6). `document.querySelector('.ProseMirror').editor` is the Tiptap
  editor, for reading its state.

**Push services do not agree with each other.** Google accepts things Apple
refuses, and every probe and test in this repo talks to Google. A reminder that
works in `push-probe.ts` is not a reminder that works on the owner's iPhone —
the only proof is `send-reminders.ts` against the real device (NOTES §47).

**Anything that fails silently will cost you a wrong conclusion.** It has now
happened five times. Log fallbacks and best-effort failures — and when a
scheduled workflow fails, make the reason reach the EMAIL (`::error::`), not
just the log behind a sign-in.

## Credentials and operations

All in `.env` (gitignored — read it, never commit or print it):
`EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `GEMINI_API_KEY`, and since
§45 `VAPID_PRIVATE_KEY` and `REMINDER_SENDER_SECRET` — both also GitHub Actions
secrets for `reminders.yml`. Their public halves are in the repo:
`VAPID_PUBLIC_KEY` in `src/core/reminders.ts`, and only the secret's SHA-256 in
the database. Replacing the VAPID pair means every device turns reminders on
again.

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
npx tsx --env-file=.env scripts/isolation-test.ts   27/27 cross-user RLS assertions (needs TEST_USER_A/B_* env vars; `npm run test:isolation` does not load .env)
npm run backup
npx tsx --env-file=.env scripts/deploy-status.ts   what is live, and is it behind a migration
npx tsx --env-file=.env scripts/notes-probe.ts [--generate]
npx tsx --env-file=.env scripts/study-probe.ts <set-id>
npx tsx --env-file=.env scripts/seed-progress.ts [--days 30] [--clear]
npx tsx scripts/make-pet-assets.ts            # cuts every assets/*-stages.*
npx tsx scripts/make-nomi-assets.ts [--debug <dir>]   # Nomi's five layers + src/ui/nomi-rig.ts, from design-reference/nomi-updated-look-interactions-references.png (gitignored)
npx tsx scripts/make-icons.ts [--preview <dir>]       # every app icon size, from design-reference/nomi-app-icon.png (gitignored)
npx tsx scripts/make-splash.ts                         # Nomi's layers into public/nomi/ and their positions into public/index.html — rerun after make-nomi-assets
npx tsx --env-file=.env scripts/nomi-chat-probe.ts    # Nomi's brain + one real Gemini reply + what was saved
npx tsx --env-file=.env scripts/reviewer-probe.ts [--runs 3] [--only rename] [--counts 20,60] [--out r.txt]   # patterns vs Gemini's topic/title, and written reviewers
npx tsx --env-file=.env scripts/nomi-offer-probe.ts --out <dir>   # Nomi's offers in the built app, photographed; checks a refused reviewer saved nothing
npx tsx --env-file=.env scripts/generation-probe.ts --file notes.txt --count 60   # model output vs dropped vs stored, and which lines
npx tsx --env-file=.env scripts/avatar-probe.ts       # save faces and photos twice, print the real errors, restore
npx tsx --env-file=.env scripts/label-cover-probe.ts [--runs=3] [--model=<id>] [--only=alu-block]   # can a model place labels well enough to cover an answer? drawn diagrams, known truth
npx tsx scripts/palette-check.ts              # contrast + colour-blindness gate, both modes
npx tsx --env-file=.env scripts/verify-phase2.ts --pdf <file>
npx tsx --env-file=.env scripts/splash-probe.ts [--runs 3] [--phone]   # what is on screen when the splash goes; --phone throttles (NOTES §45)
npx tsx --env-file=.env scripts/chat-length-probe.ts [--out <dir>]    # a long message and a paste in the built app: shown, offered, saved
npx tsx --env-file=.env scripts/pasted-notes-probe.ts [--runs 3]      # does Gemini tell notes from a message? real calls
npx tsx --env-file=.env scripts/push-probe.ts          # a real reminder through Google's push service to headless Chrome
npx tsx --env-file=.env scripts/nomi-moves-probe.ts [--out <dir>]   # Nomi studying beside the count, hopping back on Home, waving — read from the layers
npx tsx --env-file=.env scripts/send-reminders.ts --slot evening --dry-run   # who would get tonight's reminder (needs 0020)
npx tsx --env-file=.env scripts/reminders-e2e-probe.ts [--out <dir>]    # on from Settings → saved → counted → sent to that device only → shown → marked → off
npx tsx --env-file=.env scripts/finish-lines-probe.ts [--out <dir>]     # what Nomi says after 3/3, 1/3 twice and 0/3, photographed
npx tsx --env-file=.env scripts/community-probe.ts [--out <dir>]        # a shared set seen by the OTHER person, in the built app: listed, read-only, dealt, chatted. NEEDS 0021. NEVER RUN YET
npx tsx --env-file=.env scripts/scroll-probe.ts --height 420            # 7 screens now, including Community's Chat pane — the one layout that is not a `Screen`
```

**`openPage` can be somebody else now.** `openPage({ as: { email, password } })`
signs in as that user instead of `TEST_USER_A_*`. Sharing is the first feature
whose behaviour depends on who is looking, so a probe that can only ever be user
A can only ever photograph half of it.

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
2. **The generation prompt's "every card must stand on its own" rule has only a
   partial validator** — since §37 a card naming a line, sentence or page number
   is dropped — while the rephrase path has a full one. Adding it would start dropping
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
  grounds four times — label questions, the Dice grader, pdf.js, and a Home
  recommendation (NOTES §34) — and all four were right. Question-type
  enforcement was deferred the same way (§28). Each decline names what would
  reopen it; §34's is one command.
- **Write down what was measured, with its date and conditions**, in
  `ARCHITECTURE_NOTES.md`. That file is why any of the above is knowable.
