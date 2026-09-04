# AI Study App — Second-Opinion Decisions and MVP Spec
 
Date: 2026-09-03 · Status: proposed, pending i-Paul's sign-off · Hand to Claude Code after Phase 0.
 
## 0. The product in one sentence
 
> I give the app my notes. It asks me about them, shows me where every answer came from, remembers what I got wrong, and grades my written answers.
 
The first two are table stakes (NotebookLM already does them). The last two are the product.
 
## 1. Decisions — what changes vs. the original brief
 
| # | Original | Decision | Why |
|---|---|---|---|
| D1 | "Review" / "Challenge" | **Flashcards / Quiz** | Words students already own. The brief needed subtitles to explain the new labels — that is the tell. |
| D2 | Level chosen at generation (Basic Recall / Intermediate / Critical Thinking) | **Remember / Understand / Apply, chosen at study time.** One mixed set per notes (~50/30/20). Level is a filter; Apply includes easier items too. | One set per notes. No regenerating to change level, no "which set is the hard one?". Count becomes the only generation setting. |
| D3 | Count 10 / 20 / 40 / 60 | Count is a **maximum**. App estimates what the notes support (~1 item per 70 words) and says "Your notes support about 25 good cards." | Padding to 60 produces junk. |
| D4 | "Basic source extraction" (OCR pipeline) | **Gemini reads PDFs/images directly**, returns page-anchored structured text with a per-page readability score. No OCR library. | Better on handwriting/scans, one less subsystem, page numbers come for free. |
| D5 | Fill-in-the-blank in MVP | **Postponed** | Exact-match grading of free typing frustrates ("ATP" vs "adenosine triphosphate"); auto-generated blanks are low value. |
| D6 | AI grading of written answers later | **In MVP**: short written answers graded against a rubric of expected concepts, score N/M, ≤2-sentence feedback | The only real differentiator. NotebookLM quizzes are multiple choice. |
| D7 | Second AI verification pass | **Deterministic validators in MVP** (schema, excerpt-in-source, MC sanity, leak, dedup). LLM pass later, Apply-tier rubrics only. | Free, instant, testable. Catches the common failures. With 5 users, "Report this card" is the real second pass. |
| D8 | Adaptive learning later | **Log every attempt + missed pile + "Continue" on Home from day one.** Scheduling later. | Retention comes from the missed loop, not from generation. Costs one table and one query. |
| D9 | Study set = one upload | **Study set = a subject. Documents are added to a set** (`documents.study_set_id`). MVP UI can still create a set per upload. | Sets grow across a semester; the app becomes where the subject lives. |
| D10 | Auth (unspecified) | **Email + 6-digit code (OTP).** No passwords, no magic links. | Magic links open in Safari, not the installed PWA, so the session never lands in the app. |
| D11 | Model routing | Two model IDs in one config: `light` (default for everything) and `strong` (Apply-tier generation only). Grading tries `light` + rubric first. | Free-tier daily cap on strong models is small. Rubrics make small models reliable. |
| D12 | Key storage (unspecified) | Key lives in the user's own `profiles` row under RLS. Entered once, works on every device. | Cross-device UX. Trade-off: you (DB owner) could read it — say so in Settings. |
| D13 | Privacy copy | Say plainly that notes go to Google via the user's free key, that **a person at Google may read them**, and that Google may keep them to improve its products. Tell users not to add private information — patient details, someone else's personal information, or confidential work documents. Exact copy below. | The free tier's terms make this true, not just polite. Google's terms (effective 2026-03-23) state human reviewers may read, annotate and process input and output, and warn in bold not to submit sensitive, confidential or personal information to the unpaid service — so "may be used to improve products" alone understates it. |
 
## 2. Screens (MVP)
 
- **Home** — "Continue: Cardiac Conduction · 9 cards to retry"; list of sets; "+ New set".
- **Add notes** — Paste text · Choose file (PDF / image / .txt) · Take photo (mobile). Short privacy note (copy below).
- **Set setup** — Name (prefilled from first heading) · How many items: 10 / 20 / 40 / 60 · "Make my study set".
- **Preparing** — "Reading your notes… (42 pages)" → "Making cards… 3 of 8 sections". Cards appear as sections finish. Refresh does not restart from zero.
- **Set ready** — [Flashcards] [Quiz] · level segment Remember / Understand / Apply (default Understand) · "What we read" · "Add notes".
- **Flashcards** — prompt → tap to reveal → "Missed / Got it" → chip "Source · p.14" → 1–3 sentence excerpt with matched phrase highlighted → "Open page".
- **Quiz** — MC and short written answers mixed automatically; results show score, concepts hit/missed, source chip; "Retry what I missed".
- **Settings** — Gemini API key + "Test connection" + step-by-step guide (your screenshots as assets) · theme follows device · full privacy note (copy below) · "Delete my data".
Rules: no technical words on any screen (never OCR, pipeline, model, chunk, embeddings). Desktop uses a centered ≤720px content column, sidebar nav; mobile uses bottom tabs. Keyboard on desktop: space = flip, ← = missed, → = got it.

**Privacy copy (D13) — use these words, do not paraphrase them smaller.**

On **Add notes**, above the input:

> Your notes are sent to Google to make your cards. Someone at Google may read them, so please don't add
> anything private.

In **Settings**, in full:

> **Where your notes go**
> When you make cards, your notes are sent to Google using your own free key.
> The key is free, so Google may keep your notes to help improve its products — and a real person at
> Google may read them.
> Please don't add patient information, anyone's personal details, or confidential work documents.
> A good test: if you wouldn't want a stranger reading it, don't put it here.

Both notes must be visible without tapping or expanding anything. The Settings note sits next to the key
field, not behind a link. "A real person at Google may read them" is the part that must survive any later
edit for brevity — it is the fact users are least likely to assume on their own.
 
## 3. AI pipeline (internal; users never see stage names)
 
### 3.1 Provider boundary
 
```ts
export interface AIProvider {
  testConnection(): Promise<{ ok: true; models: string[] } | { ok: false; reason: 'invalid_key' | 'quota' | 'network' | 'unknown' }>;
  readDocument(input: { file: Blob; mime: string } | { text: string }): Promise<ReadResult>;
  generateItems(input: GenerateInput): Promise<GeneratedItem[]>;   // one call per section
  gradeAnswer(input: { prompt: string; rubric: Rubric; answer: string }): Promise<GradeResult>;
}
// now:   GeminiBrowserProvider(apiKey, MODELS)  — calls Gemini from the browser with the user's key
// later: EdgeFunctionProvider(session)          — same interface, backend-owned key, no UI change
export const MODELS = { light: '<current Flash-class id>', strong: '<current Pro/thinking-class id>' };
// Confirm IDs and free-tier availability in Phase 1 via models.list (that call doubles as "Test connection").
```
 
### 3.2 Stages
 
1. **Read** (Gemini `light`, one call per document; split PDFs over ~20 pages into page ranges). Inline base64 for small files; Files API for large ones. Verified limits (2026-09-03, see `ARCHITECTURE_NOTES.md` §2.3): an inline request totals **100 MB** across everything it carries — file bytes, prompt text and instructions together — and **PDFs are capped at 50 MB** regardless of that total. Size the inline/Files API switch off the smaller applicable limit with headroom, not off the 100 MB figure. Note the page-range split above is about page *count*, not bytes; both constraints apply. Files uploaded via the Files API are deleted after 48 hours, so it is transport only — "Open page" always serves the original from Supabase Storage. Output schema:
   `{ pages: [{ page_index, headings: string[], blocks: [{ type: 'paragraph'|'list'|'table'|'figure', text }], readability: 0..1 }] }`
   Tables come back as markdown; figures as caption + visible labels. Pasted text = one page, paragraphs as blocks. Each image = one page.
2. **Plan** (deterministic). Skip pages with `readability < 0.6` and record them. Split into sections by headings (fallback: ~400-word windows). `max_total = min(requested, floor(total_words / 70))`. Allocate per section proportional to words (min 1 if ≥ 40 words). Tier mix 50/30/20 Remember/Understand/Apply, rounded. Persist the plan on the set so a refresh resumes.
3. **Generate** (Gemini `light`; `strong` optional for Apply). One call per section with page markers in the text, the tier budget, and allowed forms (definition, Q/A, compare, process, cause/effect, application). Prompt rules: use only the provided text; return fewer items if the text does not support the budget; `source_excerpt` must be a verbatim copy; MC distractors must be sibling concepts from the same notes; set `check_flag` only when confident the note conflicts with standard knowledge. Output schema:
   `{ items: [{ kind: 'flashcard'|'mcq'|'short_answer', level, form, prompt, answer, options?: [{ text, correct }], rubric?: { expected_concepts: [{ id, text }], model_answer }, source_excerpt, page_index, topic, check_flag?: string }] }`
4. **Validate** (deterministic, before insert):
   - Zod schema; drop malformed items, never the whole batch.
   - `excerptMatches(excerpt, pageText)`: normalize whitespace/case/quotes; exact substring passes; else best sliding-window bigram-Dice ≥ 0.85 passes. Fail → drop item before insertion, and record the drop in the validation log (§4, "What `excerpt_verified` means"). Dropping on failure is unchanged and deliberate: no item reaches the database with an unmatched excerpt.
   - MC: 3–4 options, exactly one correct, unique after normalization, correct text not verbatim in the prompt.
   - Leak: normalized answer is not a substring of the prompt.
   - Dedup: token Jaccard > 0.8 between prompts → keep the first.
   - Cap per tier per section to the plan.
5. **Grade** (quiz short answers; Gemini `light`, rubric in prompt). Output `{ concepts_hit: string[] (ids), feedback: string }`. App computes `score = hits / total`; result = correct ≥ 80%, partial ≥ 40%, else incorrect. No chain-of-thought stored or shown.
6. **Rate limiting** (deterministic). Single queue, concurrency 2, ~7 s minimum gap between calls, retry on 429 with Retry-After or 10/20/40 s backoff; after 3 failures show "Gemini is busy right now — try again in a minute." Generation state is per section, so retries resume.
### 3.3 Deterministic vs Gemini (rule of thumb)
 
- **Code decides:** item budget, level filter, MC shuffle, typed-answer normalization, excerpt verification, dedup, missed pile and retry order, score arithmetic, rate limiting, progress, deletion.
- **Gemini does:** read documents, write items and rubrics, grade written answers, (later) write variants of missed items.
## 4. Data model (Supabase Postgres) + isolation
 
```
profiles        id (= auth.users.id) PK, display_name, gemini_api_key text null, created_at
study_sets      id, user_id, title, status ('empty'|'generating'|'ready'|'failed'), plan jsonb null, created_at, updated_at
documents       id, user_id, study_set_id → study_sets, kind ('text'|'pdf'|'image'), title,
                storage_path null, page_count, status ('uploaded'|'read'|'failed'), unreadable_pages int[] , created_at
document_pages  id, user_id, document_id → documents, page_index, text, readability numeric, headings text[]
study_items     id, user_id, study_set_id, document_id, page_index, section_title, kind, level, form,
                prompt, answer, options jsonb null, rubric jsonb null, source_excerpt, excerpt_verified bool,
                check_flag text null, topic text, hidden bool default false, created_at
attempts        id, user_id, study_item_id, study_set_id, mode ('flashcards'|'quiz'),
                result ('correct'|'partial'|'incorrect'), score int null, max_score int null,
                answer_text text null, feedback text null, created_at
heartbeat       id, ts   (keepalive only; insert allowed via a security-definer RPC)
views           item_stats (attempts, misses, last_result per item), topic_stats (per set + topic)
                — both created WITH (security_invoker = true); see the RLS note below
```
 
- RLS **on every table**: `user_id = auth.uid()` for select/insert/update/delete. No client-side filtering is trusted.
- **Views must not bypass RLS.** A Postgres view executes with its *owner's* privileges by default, so
  `item_stats` and `topic_stats` would return every user's rows even though RLS is enabled on the tables
  underneath. Both views are therefore created `WITH (security_invoker = true)` (Postgres 15+, which the
  Supabase platform provides), which makes them execute as the querying user and honour the base tables'
  policies. If a future Postgres version or Supabase default changes this, the equivalent guarantee must be
  restored before the view ships — a view that silently ignores RLS is a cross-user data leak that looks
  like working code. The isolation test in §7 covers both views explicitly for this reason.
- Storage bucket `documents` (private), path `{user_id}/{document_id}/{filename}`, policy on `(storage.foldername(name))[1] = auth.uid()::text`.
- FKs `ON DELETE CASCADE` down the chain. Deleting a set: client removes storage objects, then deletes the row. "Delete my data" loops sets. Full account deletion needs the service role → later / manual.
- Personal data collected: email only.

**What `excerpt_verified` means (and what it does not).** The column stays in the MVP, with one exact
meaning:

> `excerpt_verified = true` means only: the deterministic validator successfully matched the stored
> `source_excerpt` against the stored source page text according to the MVP excerpt-matching rules
> (§3.2.4 — normalized exact substring, or best sliding-window bigram-Dice ≥ 0.85).

It does **not** mean the excerpt or the generated question has been independently verified for factual
correctness by a second AI model or by a human. It says the quote is really in the notes; it says nothing
about whether the notes are right, whether the question is fair, or whether the answer is correct. Items
that fail excerpt verification are dropped before insertion (unchanged), so in the MVP the column is
`true` for every stored row by construction — it becomes informative only when the postponed LLM
verification pass lands and can record a soft failure.

Because the column is constant, diagnosis of generation quality must not read it. A separate internal
**validation log** — not user-facing, not part of the study data — records each dropped item with its
drop reason (`schema`, `excerpt_unmatched`, `mc_invalid`, `leak`, `duplicate`, `over_budget`), the
offending excerpt, and the section it came from. That log is where "why did this batch only yield 4
cards?" gets answered.
- Do **not** store page images in MVP. "Open page" opens the original file at the page (browser PDF viewer; pdf.js render-at-view-time is a Phase 2 nice-to-have).

## 5. Free-tier operations (things that will bite if ignored)

- **Supabase Free pauses after ~7 days of low database activity; restore is manual.** Add `.github/workflows/keepalive.yml` (cron every 3 days) that calls the `touch_heartbeat` RPC — it must be a real DB write, not just a URL ping. Free plan has no backups: export the DB monthly with the CLI.
- **Storage:** 1 GB files, 500 MB database. A scanned PDF can be 20–50 MB, so 1 GB is one semester for five people, not forever. Show per-user usage in Settings; deleting a set frees its files.
- **Gemini free tier:** limits are **per Google project, not per key** — verified 2026-09-03 and quoted directly from Google's docs; this is the fact the queue design rests on. The figures *roughly 5–15 requests/min and 100–1,500 requests/day depending on model* are **indicative only and must not be hardcoded**: Google no longer publishes numeric free-tier limits, and the real values are per project and visible in AI Studio (`ARCHITECTURE_NOTES.md` §2.2). The implementation must therefore treat actual limits as unknown at build time — drive backoff from the **response** (429 status and `Retry-After`) rather than from a constant, keep the ~7 s gap and concurrency 2 as the conservative floor, and never gate a feature on a compiled-in requests-per-day number. Hence one call per section, a queue, and friendly 429 handling. A student who generates 3 sets a day is fine; Apply-tier on the strong model is what runs out — and `gemini-2.5-pro` is currently the only Pro-class model on the free tier, so there is no free fallback behind it.
- **Gemini unpaid terms:** content may be used to improve Google products and may be read by human reviewers. This is why D13 exists.
- **Cloudflare Pages:** Expo web static export; free tier is fine for five users. Use `web.output: 'single'` + `public/_redirects` (`/* /index.html 200`) unless the repo already uses `'static'` successfully — decide in Phase 0.
- **PWA on iOS:** `public/manifest.json`, `apple-touch-icon`, `apple-mobile-web-app-capable` meta via `app/+html.tsx`. No service worker / offline in MVP. Users install via Share → Add to Home Screen; put that in the guide.

## 6. Phases with acceptance criteria

**Phase 0 — Assessment (read-only).** Inspect the repo: Expo/Router version, state management, existing Supabase/Gemini code, env handling, tests, docs, what already works. Output `docs/ARCHITECTURE_ASSESSMENT.md` and a diff of this spec vs. reality. No code changes.
- AC: assessment lists every file that would be replaced and why; nothing functioning is scheduled for rewrite without a stated reason.

**Phase 1 — Foundation.** Schema + RLS + storage policy; email OTP sign-in; Settings with key + Test connection + guide; `AIProvider` + `GeminiBrowserProvider.testConnection`; theme; deploy to Cloudflare Pages; PWA manifest; keepalive workflow.
- AC: sign in on a laptop and an iPhone with the same account; RLS test proves user B cannot read user A's rows or files; Test connection distinguishes invalid key / quota / network; the URL works with your PC off; no secret in the repo (`.env.example` only).

**Phase 2 — Notes in, cards out.** Paste / PDF / image → Read → Plan → Generate → Validate → store; Flashcards mode; source chip + excerpt + Open page; "What we read"; unreadable-page message.
- AC: a 10-page text PDF yields cards in under 2 minutes with cards visible before completion; every stored item has `excerpt_verified = true`; a deliberately blurry photo is reported as unreadable, not turned into cards; item count ≤ requested and ≤ the notes' estimate; a refresh mid-generation resumes.
- **The 2-minute figure is a measured performance target, not a licence to bend the architecture.** It is
  subordinate to these invariants, all of which hold even if the number is missed:
  one Read call per document or page range (§3.2.1); one Generate call per section (§3.2.3); concurrency 2;
  ~7 s minimum gap between calls; per-section resumable generation; cards visible as sections finish.
  Do **not** weaken validation, raise concurrency beyond 2, remove or shorten rate limiting, or add
  infrastructure merely to hit the number. "Cards visible before completion" is the part that makes the
  wait tolerable, and it is the criterion to protect if the two conflict.
  If live testing shows the target is unrealistic, report the measured wall-clock time and the exact
  bottleneck (read latency vs. enforced gap vs. per-section generate latency) at the Phase 2 checkpoint,
  and let the criterion be changed deliberately — never silently.

**Phase 3 — Quiz.** MC + short written answers; rubric grading; attempts logged; results screen; "Retry what I missed".
- AC: a written answer returns score N/M, the missed concepts, ≤2-sentence feedback, and a source; every quiz answer creates one `attempts` row; retry shows only missed items.

**Phase 4 — Come-back loop.** Home "Continue"; missed pile in Flashcards; "Add notes to this set"; "Report this card" (sets `hidden`); "Delete my data".
- AC: Home shows the last set and its retry count without extra taps; adding a document to an existing set generates only for the new document; reported cards never appear again.

**Later (explicitly postponed):** fill-in-the-blank, diagram/label questions (only when ≥3 labels return confident non-overlapping boxes), adaptive scheduling, spaced repetition, LLM verification of Apply-tier rubrics, variants of missed items, social/collab, other providers, backend-owned key, native iOS.

## 7. Test plan

- **Unit (Vitest), no network:** planner budgets, tier rounding, excerpt matcher (exact, whitespace, quotes, near-miss ≥0.85, reject <0.85), MC validators, leak check, dedup, level filter, missed queue ordering, score arithmetic, 429 backoff timing, error mapping.
- **Schema tests:** recorded Gemini fixtures (good, malformed, partial) through Zod + validators; malformed items dropped, batch kept.
- **Isolation:** script with two test users asserting cross-user select/insert/storage access fails (Supabase local via CLI, or against the free project with disposable users). Coverage must include, as separate assertions:
  - every base table (`profiles`, `study_sets`, `documents`, `document_pages`, `study_items`, `attempts`);
  - **both views — `item_stats` and `topic_stats`** — queried as user B while user A holds data, asserting zero rows of A's are returned. Base-table policies do not imply view safety, so testing the tables alone would pass while the views leak;
  - storage objects under another user's `{user_id}/` prefix;
  - `profiles.gemini_api_key`: user B cannot read user A's stored key.
- **Live Gemini:** behind `LIVE_GEMINI=1`; skipped by default; never required for CI to pass.
- **No credentials committed.** `.env.example` documents `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` only. The Gemini key is never an env var.

## 8. Claude Code kickoff prompt (paste after this file is in `docs/`)

```
Read docs/AI_STUDY_APP_MVP_SPEC.md fully before doing anything.

Phase 0 only: inspect the whole repository (Expo setup, Expo Router, state, Supabase/Gemini code,
env handling, tests, docs, what works). Write docs/ARCHITECTURE_ASSESSMENT.md: current architecture,
what already works, what the spec would change, and what you recommend NOT rewriting. Make no code
changes in Phase 0. Stop and wait for my go-ahead.

Then implement Phase 1 → 4 in order, one phase per checkpoint. At each checkpoint report: files
changed, tests run and results, unresolved issues, architectural decisions. Meet every acceptance
criterion in the spec before moving on; if one is impossible, say so instead of working around it.

Rules: do NOT create commits, push, or alter git history — I review and commit. Never commit
secrets. Tests must pass without network access; live Gemini tests only behind LIVE_GEMINI=1.
No technical jargon in user-facing text. Prefer deterministic code over model calls wherever the
spec says so.
```
