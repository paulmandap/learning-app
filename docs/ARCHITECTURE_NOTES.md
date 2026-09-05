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

Criterion B — 10-page text PDF: **PASSED, 2026-09-05 — 80.6 s of 120 s, 6/6 checks.** See
5.3.2. The failing 2026-09-04 measurement is kept below because the two together are the
finding: the number moves with Google's load, not with this code.

Criterion B — first measurement: **FAILED, 2026-09-04**, on
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

#### 5.3.2 Criterion B passes — and the number is mostly not ours

Re-measured 2026-09-05 with the fallback ladder in place, same 10-page PDF, three runs inside
one hour. Every run fell back nine times (the pinned `light` model was 429-ing throughout), so
the ladder is what allowed any measurement at all.

| Run | Read | Generate wall | Mean per call | Total |
|---|---|---|---|---|
| 1 | 45.1 s | 169.8 s | 8.2 s | **218.6 s** — fail |
| 2 | 22.9 s | 157.8 s | 19.0 s | **181.6 s** — fail |
| 3 | 18.9 s | 60.2 s | 3.4 s | **80.6 s** — PASS, 6/6 |

Same code, same document, same number of fallbacks. **Mean call latency swung 3.4 s to 19.0 s,
a 5.6× spread, purely on how loaded Google's free tier was.** The criterion is therefore not a
property of this architecture on its own; it is met comfortably when the tier is healthy and
missed by up to 1.8× when it is not. Re-running until it passes would be dishonest, so all
three are recorded.

**A theory that was measured and turned out wrong.** `CallQueue` holds its concurrency slot for
the *entire* task, not just the model call, so `insertItems` and `markSectionComplete` are paced
by a rate limiter meant for Gemini. That looked like it could explain a 2.6× gap between
generate wall-clock and the sum of its model calls. `TimingReport.dbMs` was added to measure it:
**13.5 s of a 60.2 s generate window.** Real, but far too small to be the story. The gap was
model latency variance all along. The instrumentation stays because the question will recur.

**What is structural.** In the passing run, **49.0 s of the 60.2 s generate window was the
enforced 7 s gap** — call starts sat 0.0 s above the theoretical floor. Eight sections × 7 s is
the architecture working as §3.2.6 specifies, not a defect. It also means the headroom is thin:
a document with more sections spends proportionally more time in pacing, and only a healthy tier
keeps the total under 120 s.

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

## 7. Spaced repetition (Phase 6) — built 2026-09-05

Spec §6 lists "adaptive scheduling, spaced repetition" under Later, and D8 explains why the
groundwork went in first: *"Log every attempt + missed pile from day one. Scheduling later."*
`attempts` records what happened; the new `review_state` records when each card is next due.

### 7.1 Choices worth knowing

**SM-2, not FSRS.** SM-2 needs four numbers per card and no training data. FSRS is better when
fitted to a real review history; this project has five users and none. SM-2 is also small enough
to hold in your head, which matters more here than the marginal accuracy.

**Three outcomes, not six.** Textbook SM-2 asks the learner to self-rate 0–5. The app already
grades `correct | partial | incorrect`, and flashcards only produce two of those. Adding a
self-rating step is exactly the friction D1 and D2 removed elsewhere.

**`partial` is a real state.** A quiz short answer scores partial between 40% and 80% of its
rubric. Treating it as a lapse throws away a card you nearly know; treating it as correct pushes
it out of sight. It halves the interval and holds `reps` instead.

**Due dates sit on UTC day boundaries.** Otherwise a card reviewed at 09:00 and scheduled "+1
day" is invisible at 08:59 the next morning and appears at 09:00 — which reads as a bug. UTC
rather than local because the comparison happens both in Postgres and in the browser.

**Flashcards ORDER by the schedule, they do not filter on it.** Due first, longest overdue
leading, then never-seen, then the rest. A deck that hid everything not due would tell someone
who sat down to study that there is nothing to study.

**"Due" excludes cards never reviewed.** A fresh set of 40 would otherwise announce "40 due
today", duplicating the card count already on the row. Due means "you have seen this and it is
time to see it again".

### 7.2 The write path cannot be forgotten

The schedule is advanced inside `recordAttempt` ([src/data/attempts.ts](src/data/attempts.ts)),
which is the single point every answer in the app passes through — flashcard swipe, flashcard
button, keyboard shortcut, quiz submission. Putting it in the screens instead would mean a
future third way to grade a card silently skips scheduling.

It runs *after* the attempt insert and never instead of it: the attempt row is the record of
truth and the missed pile is built from it.

### 7.3 Everything degrades rather than throws

Every function in `src/data/review.ts` returns an empty result on error instead of raising, and
the schedule write in `recordAttempt` is wrapped. This is what made the code safe to deploy
before `0005_review_state.sql` was applied.

**Verified live on 2026-09-05 with the table genuinely absent:**

```
recordAttempt threw:       no
attempt rows before/after: 1 -> 2      (the answer was still recorded)
dueCountsBySet returned:   0 entries   (degraded cleanly)
```

Screenshots of the deployed build with no table show "Nothing waiting — you are on top of this
one" and "1 card · Ready" — the absence reads as a quiet state, not a broken screen.

The trade-off, stated plainly: a genuine database outage looks like "nothing is due". Accepted
because the study loop predates scheduling and works without it, and because a home screen that
will not load is a worse failure than a missing count.

### 7.4 Applied and verified, 2026-09-05

`0005_review_state.sql` was applied through the dashboard SQL editor. Verified against the live
project immediately afterwards, exercising the real `recordAttempt` path rather than the
scheduler in isolation:

| Check | Result |
|---|---|
| First "Got it" → not due today, due tomorrow | `reps=1 interval=1d due=2026-09-06` ✓ |
| Second "Got it" → six days out | `reps=2 interval=6d due=2026-09-11` ✓ |
| "Missed" → back tomorrow, streak reset, lapse counted | `reps=0 interval=1d lapses=1` ✓ |
| Exactly one schedule row after three answers | 1 ✓ (the `study_item_id` unique constraint) |

**Isolation: 17/17, including `review_state`.** It holds no notes, but it maps a user's item ids
to a study rhythm, so leaking it would leak what someone is struggling with. Deleting a study
set cascades its schedules, confirmed while cleaning up the probe data.

## 8. Phase 7 — diagram cards

### 8.1 7a: the figure is shown on the card (shipped)

For cards from an **image** upload, the question face now carries the picture above the question.
No new storage: the original is already in the `documents` bucket and `signedUrlFor` already
existed, so this is a render, not a schema change. One signed URL serves every card from that
upload rather than one per card.

PDFs are unchanged. Showing a PDF *page* needs pdf.js or stored page images, and spec §4 rules
the latter out for the MVP — that is an owner decision, not a default.

**Three attempts to make it fit, each failing differently on react-native-web.** Worth recording
because the failures are not obvious and the third is the one to copy:

1. Fixed `height: 150` with `resizeMode="contain"` — cropped a wide diagram to its top band.
   Title and two labels visible, four cut off, which removes exactly what the card asks about.
2. `width: '100%'` + `aspectRatio` + `maxHeight` — the element **collapsed to nothing**. The
   picture disappeared entirely.
3. **Explicit pixel width and height**, computed from the card's measured width and the real
   aspect ratio from `Image.getSize`. Numbers cannot crop or collapse.

A fourth problem only appeared once the picture was the right shape: both faces are absolutely
positioned so they can flip against each other, so they take their height from the card
container. At a fixed 260 the diagram spilled over the progress bar above and clipped below. The
container now grows by the picture's height.

### 8.2 7b: the §6 gate — FAILED, so 7c was not built

Spec §6 postpones label questions "only when ≥3 labels return confident non-overlapping boxes".
`scripts/label-box-probe.ts` is that gate. It asks for each label's box, then checks
deterministically: at least three, each at confidence ≥ 0.7, and no two overlapping by more than
10% of the smaller box.

| Document | Confident boxes | Overlaps | Clean | Verdict |
|---|---|---|---|---|
| `diagram-only.png` | 6 | LEAF/STEM 15%, ROOTS/TAPROOT **66%** | 2 | FAIL |
| `diagram-photo.png` | 5 | LEAF/STEM 13% | 3 | pass, exactly at the threshold |

**Gate result: 1 of 2. Label questions are NOT built.**

The overlaps are real geometry, not model error. The stem is a thin bar passing *behind* the
leaf, so their boxes must intersect. The taproot *is part of* the root system, so a 66% overlap
is the correct answer to a badly-posed question — "tap the roots" and "tap the taproot" have no
distinct answer. A card that marks a student wrong for tapping the right place is worse than no
card, which is precisely what §6's clause was protecting against.

That this was measured on a synthetic diagram drawn to be maximally legible matters: a
photographed textbook page would do worse, not better.

**One thing the gate found that is worth keeping.** Asked for normalised 0–1 coordinates, the
model returned **pixels** for one image and normalised values for the other — same prompt, same
run, `[322, 164, 84, 90]` on a 900×620 drawing. `normaliseBoxes` detects this (a normalised box
cannot exceed 1) and rescales using dimensions read from the PNG/JPEG header. Without it the
gate failed for the wrong reason. If label questions are ever revisited, that inconsistency is
the first thing to design around.

## 9. Phase 8 — fill-in-the-blank (built 2026-09-05; **grading deviates from the plan, needs approval**)

Spec §6 lists fill-in-the-blank under "Later" and D5 gives the reason: *"Exact-match grading of
free typing frustrates ('ATP' vs 'adenosine triphosphate'); auto-generated blanks are low value."*
The roadmap's answer was a ≤3-word answer limit plus "the existing bigram-Dice matcher in
`src/core/excerpt.ts` at ≥ 0.85, so 'ATP' vs 'atp.' passes and a typo does not fail you".

**That grading rule was measured first, before anything was built on it, and it does not work.**
The rest of the design follows from that measurement.

### 9.1 The specified grader: 28/49, with 20 false rejects

49 hand-built cases — trivial variants, single-character typos of four kinds, morphology,
abbreviation/expansion, and confusable pairs a student must tell apart. Scored with
`normalize` + `diceCoefficient` at ≥ 0.85, exactly as specified:

| Case group | n | Verdict |
|---|---|---|
| Trivial variants (case, spacing, punctuation) | 9 | 8 pass — **"ATP" vs "atp." FAILS at 0.800** |
| Single-character typos (sub / transpose / omit / insert) | 16 | **12 of 16 rejected** |
| Article and plural variants | 4 | 1 passes |
| Abbreviation vs expansion (the literal D5 case) | 4 | 0 pass, scores 0.000–0.400 |
| Genuinely different answers | 16 | 15 correctly rejected |

Three findings, in increasing order of importance:

1. **The rule's own headline example fails.** `normalize` deliberately keeps punctuation (that is
   documented in `text.ts` and is right for excerpt matching), so "ATP" vs "atp." scores 0.800.
   Comparing *words* rather than raw normalised text fixes this one case, and only this one.
2. **"A typo does not fail you" is false.** "ribosome" typed "ribsoome" scores 0.714;
   "chloroplast" typed "chlorpolast" 0.700; "photosynthesis" typed "photosynthasis" 0.846. Dice
   over a 3–12 character string moves ~0.1 per changed character, because one character alters two
   bigrams out of ten. The 0.85 threshold was tuned in `excerpt.ts` for 200-character spans, where
   a dropped word barely registers. Reusing that number on a one-word answer is a category error.
3. **The decisive one: the two populations overlap, so no threshold exists.**

   | Pair | Score | What a fair grader must say |
   |---|---|---|
   | "afferent" vs **"efferent"** | **0.857** | wrong — different structures |
   | "photosynthesis" vs "photosynthasis" | 0.846 | right — one key slip |
   | "intracellular" vs "intercellular" | 0.750 | wrong |
   | "stoma" vs "stma" | 0.571 | right |

   The lowest score that should pass is **0.571**; the highest that should fail is **0.857**. At the
   specified 0.85, "efferent" would be marked **RIGHT** for "afferent" while a genuine typo is
   marked wrong — exactly the wrong way round.

   This is not a threshold in need of tuning, and no other character measure escapes it: a
   one-character typo and a minimal pair are *the same edit distance apart*. Any band wide enough
   to forgive typing is wide enough to accept a genuinely different answer. In a study app, being
   told a wrong answer was right is worse than the frustration D5 was avoiding.

### 9.2 What was built instead — and why the threshold stopped mattering

`src/core/cloze.ts`, `gradeTypedAnswer` returns three verdicts, not two:

- **`correct`** — identical after dropping case, punctuation, hyphenation and a leading article.
  None of those can change which thing is meant, so this is the only automatic accept.
- **`near`** — real overlap but not identical. The app shows the expected word and asks *"Did you
  have it?"*, with **Yes, I had it** / **No, I missed it**.
- **`incorrect`** — nothing like it. Marked wrong, expected word still shown.

The move that makes this shippable: **the threshold no longer decides a grade, only who is offered
the benefit of the doubt.** A mis-tuned band costs one tap, never a wrong mark. And the self-report
is not new trust — the Missed / Got it buttons have always been self-reported; this is the same
mechanism reached one step later.

`NEAR_MISS_THRESHOLD = 0.5`, set below the lowest measured genuine typo (0.571) rather than picked
round.

**This deviates from the approved roadmap and is flagged rather than assumed.** The roadmap said to
report rather than ship if the matcher did not hold up, so the code is written, tested and verified
but **not deployed**. The options:

| # | Option | Cost |
|---|---|---|
| A | Ship the three-way verdict above | Deviates from the roadmap's stated grading rule. A near miss costs one extra tap. Never marks a wrong answer right. |
| B | Ship the rule as specified (Dice ≥ 0.85) | Marks "efferent" right for "afferent"; rejects 12 of 16 typos. Measured, not predicted. |
| C | Exact match only, no near band | Simplest and never wrong, but restores the D5 frustration in full — a transposed letter is marked wrong. |
| D | Drop fill-in-the-blank | Loses a feature whose supply is real (§9.4) over a grading problem that has a workable answer. |

**Recommendation: A.** It is the only option that never tells a student a wrong answer was right,
and the only one where the unreliable measurement has been demoted to something that cannot cause a
wrong grade. B is ruled out by its own measurement.

### 9.3 The blank is cut from the notes, not from the model's answer

The gap is taken out of `source_excerpt` — text the app resolved from the user's own stored pages
— so a blank inherits the grounding guarantee the source chip has. Two consequences:

- The expected text is **the student's own wording**, which is most of what made "ATP" vs
  "adenosine triphosphate" a problem in the first place. The gap expects whichever the notes use.
- After answering, the whole sentence is shown with the answer highlighted in place.

### 9.4 Supply: measured, because a feature with no cards is not a feature

Run over the real cards a live generation produced (plant-anatomy fixture, `gemini-3.6-flash`,
2026-09-05), not synthetic ones:

| | Count |
|---|---|
| Items in the account | 28 |
| Flashcards among them | 14 |
| **Became a blank** | **5 — 36% of flashcards, 18% of all items** |
| Rejected: answer over 3 words | 7 |
| Rejected: answer is a paraphrase, not words in the notes | 1 |
| Rejected: excerpt is a label list, not a sentence | 1 |

**The dominant loss is answers longer than three words**, and the cause is structural: the
generation prompt says *"WRITE IN YOUR OWN WORDS … Do NOT copy sentences out of the notes"*, so
answers come back as prose ("It serves as the primary photosynthetic organ."). That rule is
load-bearing for card quality and was **not** touched to raise blank yield. About one flashcard in
three is the honest ceiling under the current prompt.

Two fixes found by this measurement, both of which generalise beyond blanks:

- **Strip a leading article before locating the gap.** The model writes "The mesophyll." where the
  notes write "the internal mesophyll". Matching the article too lost **2 of 6** otherwise usable
  blanks. Also applied to grading, where "leaf" and "the leaf" are plainly the same answer.
- **Reject a transcribed label list.** A diagram read gives `"FRUIT seed dispersal structure STEM"`
  — four words, so it clears any word-count floor, but blanking one label yields
  `"_____ seed dispersal structure STEM"`, which is noise. A sentence carries at least one function
  word; a label dump carries none. Not diagram-specific: §6.2 records that glossaries and
  vocabulary lists have the same shape.

### 9.5 Blanks are a Remember-tier activity, and the screen had to admit it

Measured on the same set: **5 blanks at Remember, 0 at Understand, 0 at Apply.** That is intrinsic
— asking for a term *is* recall — and with the 50/30/20 mix it will not change. The other two modes
default to Understand per the spec's level segment; this screen would have opened empty almost
every time. It therefore opens on a level that has cards, and stops adjusting once the student
picks one themselves.

### 9.6 `attempts.mode` needed a third value — migration 0006, **not applied**

Blanks are graded differently from a flip (typed and string-compared, versus self-reported), so
recording them as `'flashcards'` would be a lie in the data. `0006_attempt_mode_blanks.sql` adds
`'blanks'` to the check constraint. It finds the old constraint **by what it checks rather than by
name**, because `drop constraint if exists <guessed name>` is a silent no-op when the guess is
wrong — leaving the old constraint in force while the migration reports success, which is invisible
from the dashboard where this gets run.

Until it is applied, `recordAttempt` catches the check violation (`23514`) and retries as
`'flashcards'` with a `console.warn` naming the migration. Losing the answer would be worse:
attempts are the record of truth that the missed pile, "Continue" and every schedule are built from
(D8). The block carries its own deletion condition.

**Verified live, with the migration deliberately not applied:**

```
direct insert mode='blanks'   -> 400  23514 attempts_mode_check
app console                   -> "attempts.mode 'blanks' was rejected — recording as 'flashcards'"
attempts table                -> "The Xylem" correct, "root collr" correct   (both landed)
```

A caution for whoever repeats this: `recordAttempt` is fire-and-forget from the screen, so querying
the table immediately after the last answer shows nothing and looks like silent data loss. It is
not — it is the query racing the write. That wrong conclusion was reached once here before the
in-page diagnostic settled it.

### 9.7 How it was verified

`npx tsc --noEmit` clean · **285 tests** (263 before; 22 new in `tests/cloze.test.ts`) · `expo
export` · `tests/boot.test.ts` green on the new bundle.

Beyond that, the built bundle was driven in headless Chrome over the DevTools Protocol against the
live database, because the interesting behaviour is the three-way verdict and no unit test over a
pure function can show it:

| Check | Result |
|---|---|
| "The Xylem" accepted for "Xylem" (article dropped) | PASS |
| Completed sentence shown, answer highlighted | PASS |
| One-character typo not marked wrong; expected word named; student asked | PASS |
| "Yes, I had it" turns a near miss into Right | PASS |
| Unrelated answer marked Not quite, no benefit of the doubt | PASS |
| Progress advances | PASS |

Two defects were caught this way and fixed, neither visible to typecheck or tests:

1. The route was not registered in `app/_layout.tsx`, so the header read **"set/[id]/blanks"** to
   the user.
2. The screen opened on Understand and was empty — §9.5.

### 9.8 Limitations, stated rather than buried

- **Supply is measured on one document.** 36% of flashcards is one subject's worth of evidence, not
  a general rate. A glossary-shaped set would yield more; a discursive one less.
- **The 49 grading cases are hand-built and biology-heavy.** They are chosen to include the
  confusable pairs that break the approach, which is the point, but they are not a random sample of
  what students type.
- **Abbreviation vs expansion is still not solved** and cannot be by this approach — "ATP" vs
  "adenosine triphosphate" scores 0.087. It lands in `incorrect`, not even `near`. The mitigation is
  structural rather than algorithmic: the gap expects the notes' own wording, so the student is
  being asked for the form they actually read. This is a real remaining gap in D5's objection.
- **Not deployed.** The grading deviation above is an owner decision, and 0006 needs applying by
  hand. Until then blanks record under `'flashcards'`.

## 10. Phase 8b/8c — variants of missed items, and rubric verification (2026-09-05)

The rest of spec §6's "Later" list. Both are model passes over cards that already
exist, and both are recorded in columns added by `0007_variants_and_rubric_check.sql`.

> **DEPLOY ORDER MATTERS HERE, unlike 0006.** `listItems` now selects
> `variant_prompt` and `rubric_verified`, so a build carrying this code against a
> database without 0007 fails every item query and the app shows no cards at all.
> 0006 was additive on a write path and could ship in either order; this cannot.
> **Apply 0007 first, then deploy.**

### 10.1 Variants of missed items

On the third lapse (`review_state.lapses === 3`) one call rewrites the question.
The answer, page, cited sentence and stored excerpt are all untouched — only
`prompt` gains an alternative, in a separate column so the original survives and
dedup keeps comparing the text it always did.

Triggered inside `recordAttempt`, next to the schedule write and for the same
reason: every answer in the app passes through there, so a trigger placed in a
screen would be silently skipped by whatever grades a card next.

`===` not `>=`, so a card failed ten times spends one call rather than eight;
`variant_prompt` being non-null is the durable guard behind that.

**Live, on real cards: 7 rewrites, 7 accepted.** A sample:

| was | now |
|---|---|
| "What is the anatomical boundary that separates the shoot system from the root system in a vascular plant?" | "What serves as the boundary between the two plant systems?" |
| "What specific single-cell structures greatly expand a root's surface area…?" | "Which single elongated epidermal cells multiply a root's surface area enormously?" |

**One defect found by that run and fixed.** A weaker rung of the fallback ladder
returned *"**Based on the student's notes**, what are the microscopic openings on
the bottom of a leaf blade…"*. The rephrase prompt forbids that, and the
generation prompt has carried the same rule from the start ("Every card must
stand on its own"), but neither had a validator behind it — and this project's
stated principle is that *the prompt asks, the validator checks*. `validateVariant`
now rejects a rewrite that points outside the card. The rejection costs nothing:
the card keeps its original wording.

Worth noting for later: **the generation prompt's identical rule is still
unenforced.** Adding the same check to `validateItems` would start dropping cards
on the main path, which is a change that needs measuring first, so it was not
made here.

### 10.2 Rubric verification — the first design flagged 4 of 4 wrongly

D7 postponed "LLM verification, Apply-tier rubrics only". The model NAMES the
checklist points it cannot support and `src/core/rubric.ts` computes the verdict
— the same division of labour as grading, for the same reason.

**The first live run flagged every rubric it saw, and all four were wrong:**

```
"If a crop cannot take up water, which organ is failing?"
  => false — "The source text does not mention roots."
```

The cause was the prompt, not the model. It was given `source_excerpt` — ONE
resolved sentence — as "the only source this came from". A card drawn from a
diagram cites a fragment like `"water/nutrient absorption"`, so a point
"identifies roots as the affected organ" genuinely is not in that string. But the
rubric was written from the whole section, and marking it unfair because one
sentence does not restate it is simply the wrong test.

**Fixed by passing the page text** (capped at 4,000 chars) with the cited line
named as *part of* it rather than as the limit. Re-run on the same four:

| Question asks | Checklist demands | Verdict |
|---|---|---|
| which organ is failing | roots + absorption | **true** |
| which organ structure to examine | fruit + its role in dispersal | **false** — "The question only asks which organ structure to examine, so requiring the student to identify its role in seed dispersal does not belong." |
| which organ was damaged | leaf + its photosynthetic role | **false** — "The question only asks which organ was damaged, not for an explanation of its photosynthetic role." |
| which organ failed to form | flower + reproductive function | **true** |

**2 of 4, and both flags are real defects.** Each flagged rubric demands a role
the question never asked for, so a student answering "the fruit" — correct, and
complete — scores 1 of 2 and is marked *partly right*. That is precisely the
unfair marking D7's pass exists to catch, and it was invisible before.

Kept as a SOFT failure (§4): the card stays and the quiz shows one quiet line,
"We're not sure every point above is really in your notes — trust your notes over
this one." Dropping a question because a second model disliked one point of its
checklist would be a large action on a small signal.

**Runs after the set is marked ready**, never inside generation. Apply is 20% of a
set, so a 20-card set is four more calls ≈ 28s at the enforced gap — landing on
the very budget §6 forbids buying with architecture changes.

### 10.3 Two bugs the owner found in the quiz, both fixed

**Double submission created phantom questions.** `submit()` awaited
`recordAttempt` (and, for written answers, a model call) *before* setting
`current`, so a second tap in that window passed the same guards and appended a
second entry to `answered` — and wrote a second `attempts` row. A two-question
quiz finished claiming three, with one question listed twice; tapping repeatedly
gave "4 of 4 right" from two questions.

Fixed with a ref set synchronously at the top of `submit()`. State would not have
worked: a `setState` in the same tick is not visible to the second call. Every
early return releases it, and `next()` clears it.

The results list was also keyed on `a.item.id`, which duplicates legitimately in a
retry round — now keyed by position.

**Verified against the deployed build**, driving the real quiz in headless Chrome
and clicking "Check my answer" three times in a row on every question:

```
10:04:04.858            d650ce83  incorrect "Fruit"     <- run 1
10:05:05.732  +60.9s    d650ce83  incorrect "Fruit"     <- run 2, same question
10:05:15.972  +10.2s    b81fc679  incorrect "Flower"
10:05:21.681   +5.7s    bea53578  incorrect "STEM"
10:05:25.428   +3.7s    b4451b3d  incorrect "Fruit"
```

One row per question, and one verdict on screen. The only repeated item is 60.9s
apart, which is the two runs — within a run the gaps are 3.7–10.2s and nothing
repeats. Worth stating because the raw "duplicate item id" count looked like a
failure until the timestamps separated the runs.

**Number words were marked wrong.** The notes said "60 seconds and 7 days"; typing
it out in words failed. `comparable` now folds number words to digits on both
sides, so "sixty seconds" and "60 seconds" are one answer. A run ends at "and", so
"60 seconds and 7 days" stays two quantities rather than becoming one number.

### 10.4 Quiz presentation, on the owner's report

Answering multiple choice now marks the options themselves: the correct one turns
green with a ✓, a wrong pick red with a ✗. A mark as well as a colour, because
roughly one man in twelve cannot separate the two and a verdict must not live in
hue alone.

The source was printing inline and unconditionally under every answered question,
which read as a different app from Flashcards. It is now the same collapsed chip,
lifted out of `flashcards.tsx` into `src/ui/source.tsx` and used by both — one
implementation rather than two that drift.

### 10.5 Limitations

- **Rubric verification is measured on four items.** Two flags, both defensible,
  is encouraging and is not a false-positive rate.
- **Variants are unmeasured for effect.** Seven rewrites were accepted as
  well-formed; whether a rephrased question actually helps someone learn a card
  they kept failing needs review history nobody has yet.
- **The rephrase pass runs on the fallback ladder**, and the one bad output came
  from its weakest rung. The validator catches that class now, but rung quality
  still varies with how loaded the free tier is.

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
