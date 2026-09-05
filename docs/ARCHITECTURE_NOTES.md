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

## 5. Phase 2 acceptance verification (measured live)

> **Status: harness built, not yet run.** The two criteria below are the ones spec §6 lists for
> Phase 2 that were never verified, because both need input files that did not exist. Nothing in
> this section is a result yet — the tables are the shape the run will fill, and saying so
> explicitly is the point. Do not cite them as verified until the date line is filled in.

Criteria under test, quoted from spec §6:

- **A.** "a deliberately blurry photo is reported as unreadable, not turned into cards"
- **B.** "a 10-page text PDF yields cards in under 2 minutes with cards visible before completion"

### 5.1 Method

`scripts/verify-phase2.ts` drives the **real** pipeline — `addDocumentToSet` → `planSet` →
`generateSet` from `src/data/pipeline.ts` — against the live Supabase project and the live Gemini
API, and prints a PASS/FAIL report. It is not a reimplementation: `src/data/**` and `src/ai/**`
import nothing from `react-native` or `expo-*` (only `src/ui/**` does), which is what makes them
reachable from Node at all. That separation is the architectural requirement in assessment §5.2,
and this is the second thing it buys after the Vitest suite.

```
npx tsx --env-file=.env scripts/verify-phase2.ts --blurry "<image>" --pdf "<pdf>"
```

Needs `TEST_USER_A_EMAIL` / `TEST_USER_A_PASSWORD` and `GEMINI_API_KEY` (or `GK`). It signs in as
the **isolation-test user, not the owner**: the app is OTP-only (D10), so the owner's account has
no password a script can use. Input paths are passed on the command line rather than kept in the
repo, so a student's notes cannot be committed by accident. Sets created by a run are deleted on
the way out unless `--keep` is passed. Exit codes: `0` all passed, `1` a criterion failed, `2`
could not run.

No production code was changed for this. `addDocumentToSet` does not report its own duration, so
the script times it with its own clock — instrumenting shipped code to make a measurement easier
would be the wrong trade.

### 5.2 How the inputs were produced

Recorded verbatim so the run is reproducible, and because the blurry image's **content is the
ground truth** the failure analysis depends on. Both were generated with Gemini; neither is a real
photograph or a real student's notes.

Blurry photo (image generation):

```
Generate a photorealistic phone snapshot of a single sheet of handwritten study
notes lying on a wooden desk, shot in dim indoor light.

THE PHOTO MUST BE UNREADABLE. This is the entire point of the image:
- The camera focused on the desk edge in the foreground; the sheet itself is
  badly out of focus.
- Add visible handheld motion blur on top of the defocus.
- Letters must be reduced to smudged grey strokes. No single word may be legible.
- If you can read any word in the result, it is too sharp — blur it further.
- Still obviously a page of handwritten notes: ruled lines, a heading at the top,
  and six short numbered lines are all discernible as SHAPES, not as text.

The page (garbled beyond reading, but this is what is written on it):
  Heading: "Animal Biology Reviewer"
  1. Axolotls can regrow limbs, gills, and parts of the heart.
  2. Arctic terns migrate about 12,000 km each year.
  3. A pistol shrimp's snap makes a bubble reaching about 1,200 C.
  4. The Okonkwo-Ferrand rule: a mammal's resting heart rate falls as
     body mass rises.
  5. A colossal squid's eye is about 27 cm across.
  6. Naked mole-rats are eusocial, with a single breeding queen.

Portrait orientation, page filling most of the frame, slight angle, warm light.
```

Three of those lines are **canaries**, and they matter only if criterion A fails. They separate
"the model read the page" from "the model fell back on world knowledge" — two failures with
opposite fixes, which would otherwise be argued about rather than determined:

| Line | On the page | Real-world fact | A card containing it proves |
|---|---|---|---|
| Arctic tern | 12,000 km | ~70,000–90,000 km | page figure ⇒ it **read** the image; real figure ⇒ it **invented** |
| Pistol shrimp | 1,200 °C | ~4,700 °C | same discriminator |
| Okonkwo–Ferrand rule | present | no such eponym exists | any mention ⇒ it **read** the image |

The script runs this analysis automatically and prints it, but only on a failure.

10-page text PDF (text generation, then Google Docs → File → Download → PDF):

```
Write a 10-page study reviewer on animal biology, about 3,500 words total.
Structure it as 8 sections, each with a clear heading, covering: animal
classification, the vertebrate body plan, circulation and respiration,
reproduction strategies, migration, thermoregulation, social behaviour, and
adaptation. Write flowing explanatory prose in paragraphs — not bullet lists,
not a quiz. Plain text, no markdown symbols.
```

Eight headings is deliberate, not incidental: the planner sections by heading, so ~8 sections
means ~8 generate calls, and the pacing floor alone is 7 × 7 s ≈ 49 s. That is the hard version of
the timing test rather than a soft one. The PDF must have selectable text — a scan is a different
test, and the criterion says "text PDF".

### 5.3 Results

Criterion A — blurry photo: **not yet run.** The first generated image was rejected as an
invalid input before it cost any quota: its heading and every item label rendered fully sharp
("Animal Biology Reviewer", "Arctic terns", "Okonkwo-Ferrand rule"), leaving only the
descriptions smudged. That is a *partially legible* page, not an unreadable one, so it cannot
test "reported as unreadable" — and it also renders two of the three canaries useless, since
the invented eponym was legible and both wrong numbers failed to render at all.

Worth recording anyway, from an ad-hoc read of that image: the model **invented plausible
words rather than reporting that it could not read them** — "regratin congactions",
"eugentius", "unwelting ois". `READ_SYSTEM_PROMPT` explicitly says *"Transcribe only what is
actually there. Never fill gaps with plausible content"*, and it did not comply. The
readability score is therefore the only thing standing between a blurry page and invented
cards, which is precisely why criterion A exists.

Criterion B — 10-page text PDF: **FAILED, measured 2026-09-04**, on
`gemini-3.5-flash-lite`, with the important caveat in 5.3.1 below.

| Measure | Value |
|---|---|
| Read (1 call, whole PDF) | **101.3 s** |
| Plan (deterministic, no call) | 0.8 s |
| Generate (wall clock) | **243.2 s** |
| **Total against the 120 s target** | **345.3 s — 2.9× over** |
| Sections planned | 8 |
| Generate calls completed | **5 of 8** (three exhausted their retries) |
| Mean latency per successful call | **53.5 s** |
| First-to-last call start | 176.7 s |
| Pacing floor at the 7 s gap, `(calls − 1) × 7 s` | **28.0 s** |
| Time to first card | 57.6 s |
| Cards created | 13 of 20 requested |
| Bottleneck verdict | **model latency**, by 148.7 s over the pacing floor |

Passing alongside the failure: "cards visible before completion" (first card at 57.6 s),
item count within the requested cap, and `excerpt_verified = true` on all 13 stored items.
The PDF's pages all scored readability 1.00, which is the free control for criterion A — the
readability score discriminates rather than rating everything low.

**The enforced 7 s gap is not the bottleneck**, and an early hypothesis that section count was
the dominant cost was wrong: pacing accounts for 28 s of 243 s. Recorded because it is the
intuitive wrong answer and the numbers refute it.

#### 5.3.1 The measurement was taken while the free tier was degraded

Three probes at the same moment, all on `gemini-3.5-flash-lite`:

| Request | Result |
|---|---|
| One-word text prompt ("Reply with the single word: ok") | **503 UNAVAILABLE** in 1.4 s |
| Small text prompt with a JSON schema | **503 UNAVAILABLE** in 1.2 s |
| The full 72 KB inline PDF read | **200** in 102.1 s, 6,786 output tokens |

`gemini-3.5-flash` returned 503 in the same window too. So the 503s are **random load
shedding, not size- or model-specific** — a one-token request is shed while a 72 KB one
succeeds. Read throughput measured 66 tok/s during the failing run against 126 tok/s an hour
earlier, i.e. roughly half speed.

**Do not treat 345.3 s as the architecture's number.** Re-measure in a quiet window before
any design change is made on the strength of it.

**How degraded, exactly.** Three consecutive probes sending the literal prompt *"Reply with
the single word: ok"* — ten input tokens, one output token:

| Probe | Result |
|---|---|
| 1 | 503 UNAVAILABLE in 8.1 s |
| 2 | **200 OK in 88.3 s** |
| 3 | 503 UNAVAILABLE in 10.9 s |

**Eighty-eight seconds to emit one token.** Latency in this window is Google-side queueing,
full stop: it is unrelated to payload size, output volume, section count, or anything this
codebase controls. The 53.5 s mean generate latency in the failing run above is that queueing,
not our request shape.

This retracts a conclusion drawn earlier in the same session and recorded here before the
probe was run — that the read is "output-bound" at ~7,000 tokens ≈ 58 s and therefore leaves
the design with no headroom. The 58 s read measured at 126 tok/s was itself partly queueing,
so it is an upper bound on healthy-state cost, not a floor. **The claim that the architecture
has no headroom is unproven and must not be cited.** Whether the read is genuinely
output-bound is measurable only when a one-token probe returns in a couple of seconds.

Corollary for whoever picks this up: **no performance change to the read or the planner is
justified by any measurement in this section.** Re-measure first. Gate the re-measurement on
the one-token probe above — if it does not answer in a few seconds, the tier is still shedding
and any timing number taken is noise.

#### 5.3.2 Defect found and fixed: the read call had no retry

`addDocumentToSet` called `provider.readDocument()` directly rather than through `CallQueue`,
so unlike generation the read had **no retry, no backoff, and no friendly message**. A single
transient 503 destroyed the whole document read and surfaced the internal string
`"rate limited"` to the user — both a reliability bug and a violation of §3.2.6, which
requires retry on rate limits and "Gemini is busy right now" after three failures.

This is exactly the failure mode already recorded in this project's notes ("503 UNAVAILABLE
must be retried like 429 — treating it as fatal killed whole runs"). The fix had been applied
to `#generateContent`, so generation was covered; the read path was not, because it never
entered a queue.

The read now runs through `CallQueue` (pasted text still does not — it costs no model call).
Verified live: the first run died on a 503 in 4.2 s; after the fix the read absorbed its 503s
and completed. Four tests in `tests/gemini-provider.test.ts` pin the behaviour with no
network — 503 and 429 both raise `RateLimitedError`, an invalid key does not (so a typo fails
fast instead of burning the 10/20/40 s ladder), and pasted text makes no call at all.

**Reading the timing numbers.** `TimingReport.generateMs` is a **sum over concurrent calls**, so
it can exceed wall clock and is not a duration — the report must not quote it as one. Separately,
`TimingReport.readMs` is hardcoded `0` and never populated, because reading happens in
`addDocumentToSet` rather than in `generateSet`; it is a permanently-zero field worth either
deleting or documenting. Neither was changed here.

The bottleneck verdict distinguishes the two causes spec §6 asks to be separated. Call starts are
spaced by at least `MIN_GAP_MS`, so the first-to-last span can never fall below the pacing floor;
how far **above** it the span sits is the signal. At the floor, the enforced 7 s gap is what holds
the run up. Well above it, calls were waiting for a concurrency slot, i.e. model latency is
binding.

### 5.4 Limitations, stated rather than buried

- **One blurry sample.** A single image cannot establish that the readability score is
  well-calibrated, only that it handled this one case.
- **The blurry image is model-generated, not photographed.** Synthetic blur may differ from real
  camera defocus, and image models render text approximately — so the ground-truth list above is
  "roughly what is on the page", confirmed by eye before use, not a guarantee.
- **The PDF run is the control for criterion A**, and it is free: its pages must score at or above
  the threshold or no cards get made at all. That is what rules out "the model rates everything
  low", which a single blurry sample on its own cannot.
- **The script proves the data, not the pixels.** That a blurry photo yields no cards is asserted
  here; that the screen actually renders "We couldn't read page 1…" is confirmed by a manual pass
  in the live app, because that wording lives in React Native code the script deliberately does
  not import.

## 6. Diagrams: what the pipeline actually does with a labelled figure

Tested 2026-09-05, on `gemini-3.6-flash`. Diagrams had never been exercised — spec §6
postpones *diagram/label questions* — so nothing was known about what happens today. Four
synthetic documents were used, authored here so every label and function is known exactly and a
card can be checked against the truth rather than argued about. Source: `assets/`-adjacent
scratch HTML rendered to PDF/PNG with headless Chrome.

### 6.1 The headline: diagrams work, as text

**A labelled diagram becomes ordinary text cards, and they are good ones.** The READ stage
already transcribes figures — `READ_SYSTEM_PROMPT` asks for "the caption plus any labels
legible in the image" — so labels and their functions reach the stored page text and generation
treats them like any other notes.

| Document | Cards | Organs covered (of 6) | Notes |
|---|---|---|---|
| Reviewer PDF, prose + figure, 2pp | 14 | 6/6 | prose carried the organs; no card cited the figure |
| Diagram alone, PNG | 10 | 5/6 | 6th has no function drawn, so nothing to ask |
| Diagram as a simulated phone photo (skew, warm cast, soft focus, glare) | 6 | 5/6 | readability still scored 1.0 |
| Lab sheet PDF, figure isolated on p.2 | 14 | 6/6 | **all 14 cards correctly cited p.2** |

Canaries planted in the documents (`Specimen VR-118`, a stomatal density of `320`, an invented
"Vance's rule") appeared in the extracted text and in cards, confirming the model was reading
the page rather than reciting general plant biology.

**What does NOT happen: the card never shows the picture.** Cards are text. A student is asked
"which organ is the primary photosynthetic organ?", not shown the drawing with a part
highlighted. Showing the image would need page images stored, which spec §4 explicitly forbids
in the MVP, and label-position questions are the postponed feature in §6. The diagram is still
reachable from a card — the source chip's "Open page" opens the original file — but that is a
link, not a card face.

### 6.2 Defect found and fixed: a label and its meaning are separate sentences

`splitSentences` treats a line break as a sentence boundary, so a figure transcribed as

```
LEAF
primary photosynthetic organ
```

becomes two sentences. A card answering *"the leaf"* and citing the function line shares **no
words at all** with it, scores exactly 0 against the 0.22 support threshold, and was dropped
despite being correct. Measured on the PNG: 7 cards, 1 dropped, 4/6 organs. After the fix: **10
cards, 0 dropped, 5/6 organs**, with the excerpt now reading
`"LEAF primary photosynthetic organ STEM"` — the label reunited with its meaning.

This is not a diagram-only problem. Glossaries, vocabulary lists and any term/definition notes
have exactly the same shape.

`resolveSource` now widens to the neighbouring sentences (bounded at one either side) when the
cited sentence alone does not support the answer. The grounding guarantee is unchanged: text is
still resolved from the user's own stored notes and cannot be fabricated, and the threshold is
untouched. One existing test asserted the opposite — that an off-by-one citation must fail —
and was changed deliberately, with the trade-off written into the test.

Incidental finding while writing the replacement bound test: a citation scored **0.25** purely
because the answer and the sentence both contained the word "node". At a 0.22 threshold a
single shared common word can carry a short answer. That was true before this change too.

### 6.3 Defect found and fixed: course admin became flashcards

The lab-sheet PDF produced 20 cards of which roughly **8 were housekeeping** — "how many marks
are given for artistic quality", "what must students bring", "on which day was the specimen
fixed". Real study material is full of this: headers, instructions, marking schemes, room
numbers. The generation prompt had no reason to ignore any of it.

Two rules were added to `buildGeneratePrompt`: make cards about the subject rather than the
course, and treat a figure's label/function pairings as the examinable material they are. Same
document afterwards: **14 cards, all subject matter, zero housekeeping**, and taproot — never
covered before — picked up.

### 6.4 Conditions, and what is still unverified

The free tier misbehaved throughout. One run returned **0 cards after 166 s**, which looked
like the new prompt suppressing everything and was in fact the 10/20/40 s retry ladder against
503s; a rerun of the identical document gave 14 cards. Two later runs died with "Gemini is busy
right now", and a one-token probe then returned **429 RESOURCE_EXHAUSTED** three times in a
row — the day's quota, spent on these tests.

The 429s turned out to be a **per-minute token limit, not the day's quota**: a sweep minutes
later found the pinned model serving again, alongside six other ids answering in under three
seconds. That observation is what produced §6.5.

**Prose regression: checked, and there is none.** With the fallback ladder in place
`diagram-reviewer.pdf` produced **20 cards, 0 dropped, 6/6 organs in 21.4 s** — better than the
14 it gave before the prompt rules existed.

Getting there required correcting a wrong conclusion, which is worth recording. An intermediate
run of the same document gave only 7 cards and 3/6 organs, and the obvious reading was that the
new prompt rules were suppressing content. They were not: that run had been served largely by
`gemini-3.5-flash-lite`, the ladder's weakest rung. Two variables had changed at once and the
provider gave no way to tell which model answered. It does now — a fallback logs which rung
served — and with that visible the picture inverted immediately.

## 6.5 Model fallback ladder (deviation from D11)

D11 specifies two model ids. `LIGHT_LADDER` in `src/ai/models.ts` adds an ordered list tried in
turn when a call is rate-limited or overloaded, which is a deliberate deviation with this
evidence behind it:

- The pinned `light` model returned 503 UNAVAILABLE repeatedly, then 429 RESOURCE_EXHAUSTED
  three times in a row.
- Two document reads died with "Gemini is busy right now" — a user who cannot make cards.
- A sweep **at that same moment** found `gemini-3.7-flash` at 1.3 s, `gemini-3.8-flash` at
  2.5 s and four others healthy. **Quota is per model, so the allowance to serve that user
  existed the whole time, one id over.**

`#generateContentWithFallback` walks the ladder on a retryable failure only. A non-retryable
one — an invalid key, a malformed request — throws immediately, because trying four models with
the same bad key just makes a typo take four times as long to report. Only when every rung is
exhausted does `RateLimitedError` escape to `CallQueue`, which then applies its 10/20/40 s
backoff and retries the whole ladder. Five offline tests pin this.

**The rungs are not equivalent, and that matters.** Ordered so a fallback trades availability
rather than quality where possible, with `flash-lite` last because it is the weakest — measured
above at 7 cards against 20 for the same document. A weaker card still beats no card, which is
why it stays on the ladder rather than being dropped.

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
