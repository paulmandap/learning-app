# Architecture Notes — External-Service Verification

All claims below were checked against official documentation on **2026-09-03**. Nothing here is from
memory. Where a fact could not be established from official sources, it is marked **unverified** rather
than guessed.

Re-check before Phase 1 implementation if significant time has passed — every value in this file is
time-sensitive, and three of them had already drifted from the spec by the time it was written.

## 1. Summary of conflicts with the spec

Four items conflict with or extend `AI_STUDY_APP_MVP_SPEC.md`. Per instruction, none of the product
architecture has been rewritten — each is flagged with the smallest change I would recommend.

**Status as of 2026-09-03 (post-approval):** C1, C2 and C3 have been applied to the spec as approved.
C4 stands open by decision — the browser-side architecture and D12 are unchanged, and Phase 1's
`testConnection` remains the gate. **No backend proxy is to be introduced without explicit approval.**

| # | Spec says | Reality (2026-09-03) | Severity | Smallest change | Status |
|---|---|---|---|---|---|
| C1 | Inline requests have a "~20 MB cap" (§3.2.1) | Inline request total is **100 MB**; **PDFs capped at 50 MB** | Low — spec is conservative, not wrong | Correct the figure in §3.2.1; the Files API threshold moves, the design does not | **Applied** — §3.2.1 now carries both limits, notes they are separate constraints from the page-count split, and records the 48-hour Files API deletion |
| C2 | Free tier "~5–15 req/min and 100–1,500 req/day" (§5) | Google **no longer publishes** numeric free-tier limits; they are per-project and shown in AI Studio | Low | Mark the numbers indicative; read real limits from AI Studio in Phase 1. Queue and backoff are unaffected | **Applied** — §5 marks the figures indicative and **must-not-hardcode**, and directs backoff to be driven by the 429 response and `Retry-After` rather than a constant |
| C3 | D13: content "may be used to improve products" | Terms also state **human reviewers may read, annotate and process** input and output, and say in bold: *"Do not submit sensitive, confidential, or personal information to the Unpaid Services"* | **Medium** — the user-facing promise is less specific than the terms | Keep D13's one honest sentence, but make the Settings copy say people may read it, not just "Google may use it" | **Applied** — D13 rewritten and §2 now carries the literal student-facing copy for both Add notes and Settings, including "a real person at Google may read them" |
| C4 | Browser-side Gemini calls are assumed workable (§3.1 `GeminiBrowserProvider`) | **Tested 2026-09-03: CORS works.** Preflight returns 200 allowing `x-goog-api-key` from an arbitrary origin; error bodies are readable cross-origin | Resolved | — | **CLOSED, gate passed** — browser architecture and D12 confirmed, no proxy needed. Evidence in §4. One new constraint: `Retry-After` is **not** exposed to browser JS, so the 10/20/40 s fallback is the primary backoff |

## 2. Verified facts

### 2.1 Gemini model IDs and free-tier availability

Resolves the spec's `<current Flash-class id>` / `<current Pro/thinking-class id>` placeholders.

- **Stable Flash-class:** `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`
- **Stable Pro/thinking-class:** `gemini-2.5-pro`. (`gemini-3.1-pro-preview` exists but is preview, and
  preview models carry more restrictive rate limits.)
- **Free tier:** every Flash model listed above is "Free of charge" for input and output, as is
  `gemini-2.5-pro` — **the only Pro-class model with free-tier access.**
- **Shut down:** `gemini-2.0-flash` and `gemini-2.0-flash-lite`. Do not reference them.

Implication for `MODELS` (§3.1): `strong` has exactly one viable free option, `gemini-2.5-pro`. This makes
D11's caution well-founded — Apply-tier generation is the one path with no free fallback if that model's
quota is exhausted. Still to be confirmed live via `models.list` in Phase 1, as §3.1 directs; the list
above says what to expect, not what to hardcode.

Sources: [Gemini API models](https://ai.google.dev/gemini-api/docs/models),
[pricing](https://ai.google.dev/gemini-api/docs/pricing). Checked 2026-09-03.

### 2.2 Gemini rate limits

- **"Rate limits are applied per project, not per API key."** This confirms the spec's §5 warning exactly,
  and it is the load-bearing fact behind one-call-per-section and the queue.
- Limits are "more restricted for experimental and preview models" — another reason to prefer stable IDs.
- **Unverified:** the spec's specific 5–15 RPM / 100–1,500 RPD figures. Official docs now decline to list
  numbers, directing users to AI Studio's rate-limit page for their own project. Treat the spec's numbers
  as indicative only and read the real ones in Phase 1.

Source: [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits). Checked 2026-09-03.

### 2.3 File handling (conflict C1)

- Inline request data: **100 MB total** per request, including files, text and system instructions.
- **PDF-specific cap: 50 MB.**
- Files API: **20 GB per project, 2 GB per file.**
- **Files are auto-deleted after 48 hours.** Architecturally relevant: the Files API is transport, not
  storage. "Open page" must serve the original from the Supabase `documents` bucket, never a Files API
  URI, which will have evaporated. The spec already stores originals in Supabase Storage, so this is a
  confirmation rather than a change — but it is exactly the kind of thing that gets shortcut later.
- User-uploaded files cannot be downloaded back through the API; only model-generated files can.

Source: [Files API](https://ai.google.dev/gemini-api/docs/files). Checked 2026-09-03.

### 2.4 Google data-use terms, unpaid tier (conflict C3)

Terms effective **2026-03-23**. Quoting directly:

> "Google uses the content you submit to the Services and any generated responses to provide, improve, and
> develop Google products and services"

> "human reviewers may read, annotate, and process your API input and output"

> **"Do not submit sensitive, confidential, or personal information to the Unpaid Services."** (bold in
> the original)

Google states it disconnects the data from the Google Account, API key and Cloud project before reviewers
see it.

This substantiates D13 and makes it stricter than the spec's wording. The spec's own guidance — no patient
data, no private company documents — is aligned with Google's warning, which is worth noting because the
target users are students who may well be handling clinical material. The Settings copy should say a
person may read it; "used to improve Google products" alone understates it.

Source: [Gemini API terms](https://ai.google.dev/gemini-api/terms). Checked 2026-09-03.

### 2.5 Supabase Free plan

Every claim in spec §5 is confirmed:

| Claim | Verified |
|---|---|
| Pauses after ~7 days of low activity | Yes — "low activity over a 7-day period" |
| Restore is manual | Yes — resume from the dashboard; not automatic |
| No backups | Yes — "Automatic backups: Not included" (Pro gets 7 days) |
| 500 MB database | Yes |
| 1 GB file storage | Yes |

Also confirmed: "a few user requests to the database each day over the previous week is enough" to prevent
pausing — so the every-3-days keepalive cron in §5 has comfortable margin.

**New facts not in the spec:** 5 GB egress, and a limit of **2 active projects** on the Free plan. The
project cap matters for the §7 isolation test: a separate staging project would consume half the
allowance, and paused projects must be resumed manually before tests can run against them. Projects
paused for over a year cannot be restored from the dashboard at all.

Sources: [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing),
[pricing](https://supabase.com/pricing). Checked 2026-09-03.

### 2.6 Cloudflare Pages free tier

No conflicts. Confirmed: **500 builds/month**, 1 concurrent build, 20-minute build timeout, **20,000 files**
per site, **25 MiB** max per file, 100 custom domains. `_redirects` is supported with a maximum of 2,000
static and 100 dynamic redirects — far beyond the single `/* /index.html 200` rule the spec needs. No
bandwidth limit is stated for the free plan.

Source: [Pages limits](https://developers.cloudflare.com/pages/platform/limits/). Checked 2026-09-03.

### 2.7 Expo: web output and Node versions

- **`web.output` accepts exactly `"single"`, `"static"`, `"server"`.** `"single"` produces a Single Page
  Application with one `index.html` and no statically indexable HTML. **The Phase 0 decision
  (`single` + `_redirects`) is valid as written.** Note the asymmetry that makes it easy to get wrong:
  Expo's docs say SPA-style redirects are *not* needed for `static` output, because that mode emits real
  per-route HTML files. They *are* needed for `single`, which is what this project uses.
- **Node:** SDK 56 appears to be current (docs page dated 2026-07-29) with a minimum of Node 20.19.x.
  SDK 55 lists supported ranges `^20.19.4`, `^22.13.0`, `^24.3.0`, `^25.0.0`.
- **The local machine runs Node v23.9.0, which is absent from that list.** The Phase 0 recommendation to
  move to Node 22 LTS is confirmed by the supported-versions list, not merely by the odd/even LTS
  convention.

Sources: [app config reference](https://docs.expo.dev/versions/latest/config/app/),
[static rendering](https://docs.expo.dev/router/reference/static-rendering/),
[SDK 56 reference](https://docs.expo.dev/versions/v56.0.0.md),
[SDK 55 changelog](https://expo.dev/changelog/sdk-55). Checked 2026-09-03.

### 2.8 C5 — `+html.tsx` does not apply to `single` output (found during Phase 1 build)

**Spec §5 says to add PWA metadata "via `app/+html.tsx`" while also mandating `web.output: 'single'`.
Those two instructions are incompatible, and the failure is silent.**

Observed: with `output: 'single'`, an `app/+html.tsx` containing the manifest link and Apple meta tags
was ignored entirely. `expo export` emitted Expo's default template — default viewport, no manifest
link, no `apple-touch-icon`, and a `<title>` taken from `app.json` rather than the file. Nothing warned;
the build succeeded and the PWA metadata simply was not there.

Expo's documentation confirms the rule: the HTML entry "can be dynamically created in `src/app/+html.tsx`"
for **static or server** rendering, whereas for **single-page apps** you "create a template HTML in
`public/index.html`" (via `expo customize`). Expo Router also does not generate a PWA manifest at all —
it must be written and linked by hand either way.

**Resolution — no architecture change.** `web.output: 'single'` and `public/_redirects` are unchanged, as
approved. The PWA metadata moved to `public/index.html`, and `app/+html.tsx` was deleted rather than left
as dead code that reads as if it were doing something. Verified: the built `dist/index.html` now carries
the manifest link, both `theme-color` variants, all three Apple meta tags, `apple-touch-icon`, and
`viewport-fit=cover`.

**Recommended spec correction (one phrase):** §5's "via `app/+html.tsx`" should read "via
`public/index.html` (the SPA template — `+html.tsx` applies only to static/server rendering)". Not applied
unilaterally; flagged for owner approval.

Sources: [progressive web apps](https://docs.expo.dev/guides/progressive-web-apps/),
[static rendering](https://docs.expo.dev/router/web/static-rendering/). Checked 2026-09-03.

## 3. What could not be verified

Recorded so these are not mistaken for settled:

1. **Numeric Gemini free-tier RPM/RPD.** Not published; per-project and visible only in AI Studio.
2. **Official CORS support for browser-side Gemini calls.** No official statement found either way. See §4.
3. ~~**Whether SDK 56 is the newest SDK.**~~ **RESOLVED during Phase 1 implementation:** `npm install
   expo@latest` installed **SDK 57.0.19** on 2026-09-03, so 56 was not current. This is exactly why the
   note said to read the version from the installer rather than from this file. Installed set:
   Expo 57.0.19, expo-router 57.0.18, React 19.2.8, React Native 0.86.3.

## 4. RESOLVED: browser CORS against the Gemini API (C4)

> **Gate result — 2026-09-03: PASSED. The browser-side architecture is confirmed. No proxy is needed,
> and D12 stands unchanged.**
>
> Probed `generativelanguage.googleapis.com` directly with an arbitrary web origin and a deliberately
> invalid key (no real credential was used or needed):
>
> **Preflight** — `OPTIONS /v1beta/models`, `Origin: https://study-app.pages.dev`:
> ```
> HTTP/1.1 200 OK
> Access-Control-Allow-Origin: https://study-app.pages.dev
> Access-Control-Allow-Methods: DELETE,GET,HEAD,OPTIONS,PATCH,POST,PUT
> Access-Control-Allow-Headers: x-goog-api-key
> Access-Control-Max-Age: 3600
> ```
> The endpoint echoes an arbitrary origin and **explicitly allows `x-goog-api-key`** — the one header
> `GeminiBrowserProvider` needs. Preflights are cached for an hour.
>
> **Actual request** — `GET /v1beta/models` with `x-goog-api-key: <invalid>`:
> ```
> HTTP/1.1 400 Bad Request
> Access-Control-Allow-Origin: https://study-app.pages.dev
> {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.",
>           "status":"INVALID_ARGUMENT", ...}}
> ```
> CORS headers are present on error responses too, so the browser can **read the error body** — which is
> what makes the four-way error mapping in Phase 1 possible at all. This also pins the real
> `invalid_key` signal: **HTTP 400 with `status: "INVALID_ARGUMENT"`** and that message. It is not 401 or
> 403, which is what a reasonable implementer would have guessed.
>
> The community reports in the analysis below were describing *custom* headers that the endpoint does not
> list in `Access-Control-Allow-Headers`. Keeping requests header-minimal — which §3.1 already required —
> avoids the problem entirely.

**New constraint discovered by the same probe: `Retry-After` is not readable from the browser.** The 400
response carried `Access-Control-Expose-Headers: vary,vary,vary,content-encoding,date,server,content-length`
— no `Retry-After`. Unless a 429 exposes it differently (not verifiable without provoking a real quota
error), **`response.headers.get('Retry-After')` will return `null` in the browser even when Google sends
the header.** §3.2.6 offers "Retry-After **or** 10/20/40 s backoff"; in practice the browser will almost
always be on the fallback path, so the fixed 10/20/40 s ladder must be treated as the primary mechanism
and must be correct on its own. Attempt to read `Retry-After` opportunistically, but never depend on it.
Worth re-checking against a genuine 429 during Phase 2 load, when one can actually be produced.

The original analysis is retained below for context.

**Evidence is community-level, not official.** Developer forum reports describe direct browser `fetch` to
`generativelanguage.googleapis.com` working for straightforward requests, but with rough edges: custom
request headers can trigger preflights that the endpoint's `Access-Control-Allow-Headers` does not
satisfy, and some response headers are not exposed to browser callers. Notably, Google AI Studio itself
proxies Gemini requests through its own server rather than calling from the page. Many third-party
implementations use a backend proxy.

**What this does not justify.** It does not justify pre-emptively moving to an Edge Function proxy. That
would put the API key server-side and contradict D12, which was accepted deliberately for cross-device
key sync, and it would spend Phase 1 building infrastructure the spec explicitly defers.

**Recommended smallest change — none to the design, one to the sequencing.** Phase 1 already builds
`GeminiBrowserProvider.testConnection` as a real `models.list` call from the browser. That *is* the
experiment. Run it first, before any other Gemini work, and treat it as a gate:

- Keep requests header-minimal — standard API-key authentication, no custom headers that provoke a
  preflight the endpoint may not answer.
- If plain browser calls succeed: proceed exactly as specified, and record the result here.
- If they fail: this is a genuine conflict with D12 and §3.1, and it gets **reported at the Phase 1
  checkpoint as a blocker for a decision by the project owner** — not silently worked around with a
  proxy, which would change where the key lives and undo an accepted trade-off.

The Phase 2 Files API path (files above the inline threshold) needs the same check independently; its
upload flow differs from ordinary generate calls, and confirming one does not confirm the other.

## Sources

- [Gemini API models](https://ai.google.dev/gemini-api/docs/models)
- [Gemini API pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini API rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini Files API](https://ai.google.dev/gemini-api/docs/files)
- [Gemini API additional terms of service](https://ai.google.dev/gemini-api/terms)
- [Supabase — free project pausing](https://supabase.com/docs/guides/platform/free-project-pausing)
- [Supabase pricing](https://supabase.com/pricing)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Expo app config reference](https://docs.expo.dev/versions/latest/config/app/)
- [Expo Router static rendering](https://docs.expo.dev/router/reference/static-rendering/)
- [Expo SDK 56 reference](https://docs.expo.dev/versions/v56.0.0.md)
- [Expo SDK 55 changelog](https://expo.dev/changelog/sdk-55)
