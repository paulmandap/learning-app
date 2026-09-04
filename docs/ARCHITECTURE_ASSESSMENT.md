# Architecture Assessment — Phase 0

Date: 2026-09-03 · Status: for review · Read-only phase, no code changes made.
Assesses: `docs/AI_STUDY_APP_MVP_SPEC.md`.
Companion: `docs/ARCHITECTURE_NOTES.md` — external-service facts verified against official docs on
2026-09-03, with sources. Time-sensitive values live there, not here.

**Revision, 2026-09-03 (post-review).** Three clarifications were directed after the first read of this
document and are now folded into the spec: views must not bypass RLS (§7.4.1), the exact meaning of
`excerpt_verified` (§7.4.6), and the standing of the two-minute performance target (§7.4.2). Those three
risks are marked **resolved in spec** below rather than deleted, so the reasoning stays visible.
**D12 is accepted as designed:** the user's Gemini key is stored in `profiles.gemini_api_key` under RLS so
it syncs across devices, with the owner-access trade-off knowingly accepted. It is not an open question.

## 1. Verdict in one paragraph

There is no existing application. The repository contains exactly one file — the spec itself. There
is no Expo project, no Expo Router, no state management, no Supabase or Gemini code, no environment
handling, no tests, and no other documentation. It is not a git repository. The spec's Phase 0 asks
what already works and what should not be rewritten; the honest answer to both is "nothing, because
nothing exists." This document therefore does the useful version of Phase 0 instead: it records the
architecture decisions that Phase 1 will otherwise make silently, makes the one decision the spec
explicitly defers to Phase 0, and lists the blockers that will stop Phase 1 dead if not cleared
first.

## 2. How this was inspected

| Check | Method | Result |
|---|---|---|
| Repository contents | Recursive `find`, excluding `node_modules` | 1 file: `docs/AI_STUDY_APP_MVP_SPEC.md` |
| Hidden config | `ls -la` on root | No dotfiles of any kind |
| Version control | `git rev-parse --is-inside-work-tree` | Not a git repository |
| Expo project anywhere on disk | `find` for `app.json`, `expo*`, `*.tsx` under `c:\paul` | No matches anywhere |
| Toolchain | `--version` on 8 tools | See §7.3 |

A note on provenance, because it cost a checkpoint: the copy of the spec first delivered to this
machine was truncated at 100 lines (md5 `80cb524c…`), ending mid-document at section 4 with no
trailing newline. Sections 5–8 — including the phase acceptance criteria this entire plan depends
on — were missing. The cause was a failed browser download, traced to a temp file in `Downloads`
that briefly held the full text and was cleaned up before it could be read. The file has since been
re-saved complete. **Worth carrying forward: verify the spec's md5 before trusting it in a later
session.** A truncated spec is not visibly broken, it just quietly ends.

## 3. Current architecture

None. Presented as the spec's own checklist so the gaps are unambiguous:

| Spec asks about | Reality |
|---|---|
| Expo / Expo Router version | Not present. No `package.json`, no `app.json`, no `app/` directory |
| State management | Not present |
| Existing Supabase code | Not present. No client, no migrations, no RLS policies |
| Existing Gemini code | Not present. No provider, no prompts, no schemas |
| Env handling | Not present. No `.env`, no `.env.example` |
| Tests | Not present. No runner configured |
| Docs | `AI_STUDY_APP_MVP_SPEC.md` only |
| CI / deploy | Not present. No `.github/`, no Cloudflare config |

### 3.1 What already works

Nothing. There is no runnable code, so there is no behaviour to preserve, no regression risk, and
no migration path to design. This is the one genuine benefit of the situation: every decision below
is a free choice rather than a compromise with existing code.

### 3.2 Files that would be replaced, and why

**The set is empty.** No file in this repository would be replaced, rewritten, or deleted by
implementing the spec. `docs/AI_STUDY_APP_MVP_SPEC.md` is the input to the work and stays untouched;
this document is added alongside it.

This satisfies the Phase 0 acceptance criterion — *"assessment lists every file that would be
replaced and why; nothing functioning is scheduled for rewrite without a stated reason"* — trivially
rather than substantively, and the criterion should be read as discharged, not as passed on merit.
Nothing is scheduled for rewrite because nothing functions.

## 4. Spec vs. reality diff

Every line is "absent", so the useful column is the last one — where each piece lands.

| Spec element | § | Reality | Lands in |
|---|---|---|---|
| Expo + Expo Router app shell, theme | 2 | Absent | Phase 1 |
| Postgres schema (8 tables + 2 views) | 4 | Absent | Phase 1 |
| RLS on every table, storage bucket policy | 4 | Absent | Phase 1 |
| Email OTP sign-in | D10 | Absent | Phase 1 |
| Settings: key entry, Test connection, guide | 2 | Absent | Phase 1 |
| `AIProvider` interface + `GeminiBrowserProvider` | 3.1 | Absent | Phase 1 (`testConnection`), Phase 2 (rest) |
| Cloudflare Pages deploy, PWA manifest | 5 | Absent | Phase 1 |
| Keepalive workflow + `touch_heartbeat` RPC | 5 | Absent | Phase 1 |
| Read → Plan → Generate → Validate pipeline | 3.2 | Absent | Phase 2 |
| Deterministic validators (5 kinds) | 3.2.4 | Absent | Phase 2 |
| Flashcards, source chip, excerpt, Open page | 2 | Absent | Phase 2 |
| Quiz, rubric grading, attempts, results | 2, 3.2.5 | Absent | Phase 3 |
| Home "Continue", missed pile, Report, Delete my data | 2 | Absent | Phase 4 |
| Vitest suite, fixtures, isolation script | 7 | Absent | Phases 1–4, continuously |
| `MODELS.light` / `MODELS.strong` real IDs | 3.1 | Placeholders in spec | Phase 1, via `models.list` |

## 5. Recommended architecture

These are the choices Phase 1 would otherwise make implicitly. Flagging them here so they can be
overruled before code exists rather than after.

### 5.1 Stack

| Concern | Recommendation | Why |
|---|---|---|
| Framework | Expo SDK (latest stable) + Expo Router | Spec requires it: references `app/+html.tsx` and Expo web static export |
| Language | TypeScript, `strict: true` | Spec's interfaces are already typed; the validators depend on it |
| Server state | TanStack Query | Caching, background refetch, and refresh-resume for the Preparing screen |
| Client state | One Zustand store, active study session only | Card index, reveal state, missed queue. Everything durable lives in Postgres |
| Schema validation | Zod | Named in spec §3.2.4 |
| Backend | Supabase (Postgres + Auth + Storage) | Named throughout §4 |
| AI client | Thin `fetch` wrapper, no SDK | See §5.3 |
| Tests | Vitest | Named in spec §7 |
| Hosting | Cloudflare Pages | Named in spec §5 |

Explicitly **not** recommended: Redux or any global state library beyond the one session store; an
ORM over Supabase's client; a component library. Five users and four phases do not justify them,
and each one adds a layer the deterministic tests would have to reach through.

### 5.2 The constraint that makes the test plan work

Spec §7 requires Vitest unit tests that run with no network. Expo's default test runner is Jest, and
Vitest struggles with React Native's transform requirements. The resolution is architectural rather
than configuration-level:

> **All deterministic logic lives in `src/core/**` and imports nothing from `react-native`, `expo-*`,
> or any UI library.** Planner, excerpt matcher, validators, dedup, level filter, missed-queue
> ordering, score arithmetic, and backoff timing are plain TypeScript over plain data.

Every item in §7's unit list then tests as pure functions with no RN transform, no mocking of native
modules, and no network. UI components consume `src/core` but are not themselves unit-tested in the
MVP. This is worth adopting deliberately in Phase 1, because retrofitting it after the logic has
grown UI dependencies is expensive.

Proposed layout:

```
app/                    Expo Router routes (screens only, thin)
src/core/               pure logic — planner, validators, matcher, scoring, queue  [Vitest]
src/ai/                 AIProvider interface, GeminiBrowserProvider, prompts, Zod schemas
src/data/               Supabase client, queries, mutations
src/ui/                 shared components
supabase/migrations/    SQL — schema, RLS, policies, views, RPC
tests/fixtures/         recorded Gemini responses (good, malformed, partial)
scripts/                isolation test (two users), monthly export helper
```

### 5.3 Gemini client: `fetch`, not the SDK

Recommending a hand-rolled `fetch` wrapper behind the `AIProvider` interface:

- The key is loaded from the user's `profiles` row at runtime (D12), not from an env var at build
  time. SDKs assume the latter and fight the former.
- Structured output is a plain `responseSchema` field on the REST request. No SDK needed.
- A `fetch` wrapper is trivially mockable, which §7's "no network" requirement demands of every test.
- Avoids a dependency whose version churn is faster than this project's release cadence.

The interface boundary in §3.1 already anticipates a later `EdgeFunctionProvider`, so this stays
swappable.

## 6. The one decision the spec defers to Phase 0

Spec §5 (line 109): *"Use `web.output: 'single'` + `public/_redirects` (`/* /index.html 200`) unless
the repo already uses `'static'` successfully — decide in Phase 0."*

**Decision: `web.output: 'single'` with `public/_redirects`.** The escape hatch was conditional on an
existing working `'static'` setup; there is no existing setup at all, so the condition cannot be met
and the default stands. Single-page output also suits an app whose routes are all behind auth.

## 7. Risks and open questions

Ordered by how early they bite.

### 7.1 Blockers before Phase 1 can complete

1. **Not a git repository.** `git init` has not been run and there is no remote. Phase 1 requires
   `.github/workflows/keepalive.yml` and a Cloudflare Pages deploy, both of which need a GitHub
   repository. Per your rules I do not touch git, so **this one is yours to clear.**
2. **No Supabase project.** Writing migrations is fine; applying them, and the RLS test, need a real
   project plus its URL and anon key.
3. **No Cloudflare Pages project.** Needed for the "URL works with your PC off" criterion.

### 7.2 Phase 1 criteria I cannot verify alone

Flagging now rather than at the checkpoint, so we agree who signs off on what:

| Criterion | Who verifies | Note |
|---|---|---|
| RLS blocks cross-user reads | **Me**, automated | `scripts/` isolation test with two disposable users |
| Test connection distinguishes invalid key / quota / network | **Me**, automated | Error-mapping unit tests; live path behind `LIVE_GEMINI=1` |
| No secret in repo | **Me** | `.env.example` only |
| Sign in on a laptop *and an iPhone* | **You** | I have no iPhone and no access to your email |
| URL works with your PC off | **You** | Requires your Cloudflare account |

### 7.3 Toolchain findings

| Tool | Status | Consequence |
|---|---|---|
| Node | **v23.9.0** | **Confirmed unsupported.** Expo SDK 55 lists `^20.19.4`, `^22.13.0`, `^24.3.0`, `^25.0.0`; SDK 56 requires ≥ 20.19.x. 23.x appears in neither. **Switch to Node 22 LTS before Phase 1** — this is a documented gap, not the odd/even convention |
| npm 10.9.2, git 2.48.1 | Fine | — |
| Docker | **Not installed** | `supabase start` (local stack) is unavailable. The §7 isolation test must run against the free project with disposable users, or Docker gets installed. Recommend the former — it also tests the real RLS policies, including the two views. Note the Free plan allows only **2 active projects**, so a dedicated test project consumes half the allowance |
| Supabase CLI | Not installed | Runnable via `npx supabase`. Also needed for §5's monthly DB export |

### 7.4 Technical risks in the spec itself

None of these are objections to the design; they are places where an acceptance criterion may not
survive contact with reality, and I would rather name them now than quietly work around them later.

1. **Views need `security_invoker`. — RESOLVED IN SPEC.** `item_stats` and `topic_stats` (§4) are views.
   In Postgres a view executes with its owner's privileges by default, which **bypasses RLS on the
   underlying tables** — one user could read another's stats. This was the single most likely way to ship
   a real isolation hole while believing "RLS is on every table". Spec §4 now mandates
   `WITH (security_invoker = true)` on both views and explains why, and §7's isolation test now requires
   separate assertions for each view, for every base table, for storage objects, and for
   `profiles.gemini_api_key`. Testing base tables alone would have passed while the views leaked.

2. **Phase 2's two-minute budget is tight against the rate limiter. — RESOLVED IN SPEC (as a target).**
   §3.2.6 mandates concurrency 2 and a ~7 s minimum gap between calls. A 10-page PDF is 1 read call
   (10–30 s for a PDF that size) plus one call per section. At 8 sections that is ~4 rounds of paired
   calls — roughly 28 s of enforced gap plus per-call latency, landing near but under 120 s. It should
   pass, but with little headroom. Spec §6 now states explicitly that the 2-minute figure is a *measured
   performance target subordinate to* the architecture invariants — one Read call per document/page range,
   one Generate call per section, concurrency 2, the ~7 s gap, per-section resumability, and cards visible
   as sections finish. Missing the number is a reportable measurement, not a licence to raise concurrency,
   weaken validation, drop rate limiting, or add infrastructure. I will report measured wall-clock time
   and the exact bottleneck at the Phase 2 checkpoint.

3. **`#page=N` is ignored by iOS Safari's PDF viewer.** Phase 2's "Open page" opens the original file
   at a page via the browser viewer. This works in desktop Chrome and Firefox; iOS Safari opens the
   PDF at page 1. Given the app is an iPhone PWA, the source chip should degrade honestly — show the
   page number as text so it is still useful when the jump doesn't land. Flagging rather than
   solving: pdf.js is already marked a Phase 2 nice-to-have in §4, and this is the reason it exists.

4. **Browser CORS against the Gemini API — ESCALATED, still unconfirmed.** Checking official docs found
   **no stated position on CORS either way**, and community reports suggest direct browser calls work for
   straightforward requests but are fragile around preflights and exposed headers — with Google's own AI
   Studio proxying server-side. This is broader than the Files API concern originally recorded here: it
   touches every browser-side Gemini call, and therefore D12 itself. **It does not justify pre-emptively
   building a proxy**, which would move the key server-side and undo an accepted trade-off. Phase 1's
   `testConnection` is already a real `models.list` call from the browser, so it *is* the experiment —
   run it first, as a gate, before other Gemini work. If it fails, that is a decision for you at the
   Phase 1 checkpoint, not something I route around. Full reasoning and confidence level in
   `ARCHITECTURE_NOTES.md` §4.

5. **Model IDs — RESOLVED to candidates, confirm live.** Verified against current docs: every stable
   Flash-class model has free-tier access, and **`gemini-2.5-pro` is the only Pro-class model on the free
   tier**, which makes D11's caution about Apply-tier exhaustion well-founded — there is no free fallback
   behind it. `gemini-2.0-flash` is shut down. Still to be confirmed by a live `models.list` in Phase 1
   per §3.1; the notes say what to expect, not what to hardcode. See `ARCHITECTURE_NOTES.md` §2.1.

6. **`excerpt_verified` is always `true` by construction. — RESOLVED IN SPEC.** Phase 2's criterion
   requires every stored item to have it set, while §3.2.4 drops items that fail the excerpt match, so the
   column is constant in the MVP. Spec §4 now defines its meaning exactly — the deterministic validator
   matched the stored excerpt against the stored page text under the §3.2.4 rules, and **nothing more**:
   not factual correctness, not second-model review, not human review. Drop-on-failure is retained, and a
   separate internal validation log now records each dropped item with a typed drop reason, so generation
   quality can be diagnosed without the column being mistaken for a correctness guarantee.

7. **Two spec figures have drifted from reality** (detail and sources in `ARCHITECTURE_NOTES.md` §1):
   the inline-request cap is **100 MB with PDFs capped at 50 MB**, not the "~20 MB" in §3.2.1; and
   Google no longer publishes numeric free-tier rate limits, so §5's "5–15 req/min, 100–1,500 req/day"
   is indicative only — though its load-bearing claim, that **limits are per project rather than per key**,
   is confirmed verbatim. Neither changes the design. Separately, Files API uploads are **deleted after 48
   hours**, which confirms rather than changes the spec: originals must be served from Supabase Storage for
   "Open page", never from a Files API URI.

8. **Google's unpaid-tier terms are stricter than D13's wording.** The terms (effective 2026-03-23) state
   that **human reviewers may read, annotate and process** input and output, and warn in bold: *"Do not
   submit sensitive, confidential, or personal information to the Unpaid Services."* D13's one-sentence
   privacy copy is sound but understates this — the Settings text should say a person may read the notes,
   not only that Google may use them to improve products. Recommended as a copy change, not an
   architecture change; the audience is students who may be handling clinical material.

## 8. What I recommend not building

Nothing here is a rewrite candidate, so this section is about scope discipline instead.

- **Anything in §6's "Later" list.** Fill-in-the-blank, diagram questions, spaced repetition, LLM
  verification, missed-item variants. The spec postpones them explicitly.
- **An OCR pipeline.** D4 removed it deliberately; Gemini reads PDFs and images directly.
- **A component library or design system.** Two hundred lines of styles will cover eight screens.
- **Service worker / offline support.** §5 rules it out for the MVP.
- **Abstraction over Supabase.** The `AIProvider` boundary exists because the key moves server-side
  later. There is no equivalent plan for the database, so an abstraction there would be speculative.

## 9. Recommended next step

Clear the three blockers in §7.1 — `git init` plus a GitHub remote, a Supabase project, a Cloudflare
Pages project — and confirm the Node 22 LTS switch. Then Phase 1 can be built and verified end to
end rather than built now and half-verified later.

I have made no code changes. Awaiting go-ahead for Phase 1.
