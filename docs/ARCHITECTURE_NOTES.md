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

## 11. Phase 9a — three holes closed (2026-09-05)

Groundwork for Phase 9's dashboard. All three are things that would have shown up
inside it as wrong numbers or dead cards.

### 11.1 A written answer with nothing to mark it against

Measured over the real stored cards: **2 of 9 `short_answer` items (22%) had no
usable rubric** — the key absent entirely, not merely empty.

`buildGeneratePrompt` rule 7 requires a rubric on every `short_answer`, and
`validateItems` never checked it. This is the project's own principle going
unenforced: *the prompt asks; the validator checks.*

The consequence reached the user. `gradeAnswer` has no checklist to mark
against, so the quiz shows *"This question can't be marked. Skip it for now."* —
a card occupying a slot in the deck and giving nothing back, which would also
have polluted every progress count in 9b.

**Salvaged, not dropped**, following the exact precedent already in that function
for an MCQ arriving with no options: the prompt and answer are a good pair, only
the marking apparatus is missing, so it becomes a flashcard. Dropping would have
cost 22% of written answers outright.

`0008_salvage_unmarkable_short_answers.sql` applies the same salvage to rows
stored before the check existed. It is a data statement rather than a schema
change, is idempotent (every row it touches stops being a `short_answer`), and
carries the verification query in a trailing comment.

### 11.2 The backup verified structure but not data

The check step confirmed that eight tables and both Phase 8 columns appeared and
that neither file was empty. **A dump carrying every table definition and almost
no rows would have passed all of it** — the most dangerous form of "looks like
protection", because the schema is reproducible from git and the rows are not.

A second step now counts rows in the dump's `COPY` block for `study_items` and
`attempts` and compares each against a live `psql` count, failing on any
disagreement. Those two tables hold what cannot be regenerated: a student's cards
and their answer history.

The awk was verified locally against both dump styles before it shipped, because
a CI-only check is expensive to iterate on:

| Case | Result |
|---|---|
| `COPY "public"."study_items" (…)` — Supabase CLI quoting | 3 of 3 counted |
| `COPY public.study_items (…)` — plain pg_dump | 3 of 3 counted |
| A table absent from the dump | reports 0, then fails against the live count |

### 11.3 The browser harness is in the repo at last

`scripts/screenshot.ts`, and `npm run screenshot`.

Typecheck and the test suite have now missed three UI defects in a row — a
diagram cropped to its top band, an image that collapsed to nothing, and a header
that read `set/[id]/blanks` to the user. Each was obvious on sight. The harness
that caught them was rebuilt from scratch in a temp directory three times and
thrown away each time.

No dependency: Node 22 ships a global `WebSocket` and Chrome ships the DevTools
Protocol. It serves `dist/` with the SPA fallback `public/_redirects` provides in
production, injects a test-user session into `localStorage` the way supabase-js
stores one (the app is OTP-only, so there is no form a script could fill), and
exposes `goto` / `fill` / `click` / `waitFor` / `screenshot` for probes that need
to drive rather than only look.

Two traps are encoded in it, both of which cost time when they were live:

- **The answer-box selector excludes checkboxes.** `primeFeedback()` appends an
  off-screen checkbox on every study screen, so a bare `input` selector matches
  while the screen still says "Loading…" — the script then typed into nothing and
  the run looked like an app bug.
- **React tracks an input's value on the DOM node**, so assigning `.value` is
  silently ignored. The native setter plus an `input` event is what reaches
  `onChangeText`.

### 11.4 Sequencing changed, deliberately

The approved plan put global navigation in 9a and the dashboard in 9b. That would
have shipped a tab bar whose only destinations were Study and Settings — a bar
that navigates nowhere new. Navigation moves into 9b so it arrives with the third
destination that justifies it. Same work, better order; flagged rather than
silently reordered.

**Verified:** typecheck clean · **326 tests** (322 before) · `expo export` ·
boot test green · deployed · bundle hash `ed5e7e0d…` matches local.

## 12. Phase 9b — navigation, a dashboard, and storage that does not cost you your history

The owner's brief: *"the app is too basic … maybe add a dashboard or something?
so that the user may get motivated"*, plus global navigation and — added
mid-build — per-file and per-user storage limits.

> **APPLY 0008 AND 0009 BEFORE DEPLOYING.** `listDocuments` selects
> `byte_size`, so a build carrying this code against a database without 0009
> degrades every screen that reads documents. Same class as 0007, not 0006.

### 12.1 The measurement that decided how the dashboard groups

The obvious grouping for "what am I weak at" is `topic`, which every card
already carries. Measured on the real stored cards:

| Set | Items | Distinct topics |
|---|---|---|
| A | 17 | **17** |
| B | 11 | 9 |

**Every card invents its own label.** "Flower function", "Flower role",
"Reproductive organ" and "Reproductive organ failure" are four labels for one
concept, because generation rule 9 asks each item for a topic and never asks it
to reuse one. Any per-topic accuracy is therefore computed over n=1.

This is why `topic_stats` — defined in 0003, `security_invoker`, isolation-tested
since Phase 1 — **has never been read by a single line of application code.** It
was built on a column that cannot carry it.

`section_title` groups properly (4–17 items per section, and about eight sections
on a real 10-page PDF), is already stored on every item, and needed no change.
The dashboard uses it. `topic` is left alone: fixing it means constraining the
generation prompt, which is the riskiest file in the project, for finer grouping
nobody has asked for.

**The guard that came out of this**: `MIN_SECTION_ATTEMPTS = 3`. A section is not
ranked until it has been answered three times. Without it one lucky answer reads
as mastery and one slip reads as a weakness — the same n=1 trap, one level up.

### 12.2 Storage: the limit is set by the reader, not the bucket

The owner's research suggested 25–50 MB per file. The app's real ceiling is
lower and comes from somewhere else: `MAX_INLINE_BYTES` caps a Gemini inline
request at 15 MB and `readDocument` throws above it, so **a 40 MB PDF cannot
become cards at all**, whatever the bucket has room for. Accepting one would
spend storage on something the app then refuses, failing later and less clearly.
`MAX_FILE_BYTES` is therefore 15 MB, and a test asserts it never exceeds the
reader's cap so the two cannot drift apart.

Per-user: **150 MB**, the low end of the suggested 150–200. Five users at 200 MB
is exactly the 1 GB the whole project has, leaving nothing for a sixth person or
for space a delete has not yet reclaimed. At 150 MB, five users reach 750 MB.

Refused **before** the upload starts, at the moment the file is picked, with a
second check before `addDocumentToSet` in case the usage query had not loaded
yet. The bucket is shared, so the failure without a limit lands on whoever
uploads next rather than on whoever filled it.

### 12.3 Freeing space must not cost the studying

The owner asked whether there was an alternative to deleting finished sets. There
is, and it follows from noticing that **the file and the cards are different
resources**: a PDF is 20–50 MB of the 1 GB file bucket, while the cards, answers
and schedules made from it are kilobytes of the separate 500 MB database.

So "Free up space" deletes the stored originals and nulls `storage_path`, and
keeps every card, answer, review schedule and page of extracted text. What is
lost is exactly one thing: "Open page" can no longer show the original, and a
card from an image no longer shows its picture. Both already checked
`storage_path` before offering anything, so this degrades them rather than
breaking them — the defensive code was already there from Phase 7a.

### 12.4 A streak that survives tidying up

The owner: *"even if they had deleted the flashcard, the dashboard must still
count that."* He was right to raise it. `attempts` cascades from `study_sets`, so
**deleting a set deletes the days its answers happened on** — a student who
tidied up would watch their streak reset as a punishment for being tidy.

`study_days` (0009) records one row per user per day studied and references
`auth.users` and nothing else. No set, no item, nothing that can cascade; a
future column pointing at study material would undo the entire design. It is also
cheaper than what it replaced, which pulled every attempt row ever recorded to
count distinct days. `touch_study_day()` increments it atomically, because
PostgREST cannot express `answers = answers + 1` in an upsert and two tabs would
race a read-then-write. 0009 backfills from existing attempts so nobody's current
streak is reset by the migration meant to protect it.

The dashboard falls back to `attempts` when `study_days` is missing, because the
alternative is telling someone with months of history that they have never
studied.

### 12.5 Three defects found by looking, none by tests

1. **A blank page.** The tab bar was built as a `<Bar>` component wrapping the
   triggers. `Tabs` discovers its routes by walking its own children for a
   `TabList` and reading the `TabTrigger`s inside, so the wrapper hid all three:
   *"Couldn't find any screens for the navigator"*, and nothing rendered.
   **`tests/boot.test.ts` caught this** — the blank-page guard doing exactly the
   job it was written for.
2. **A sidebar spread down the whole window**, Study at the top and Settings
   pinned to the bottom, because `TabList` brings its own justification and the
   style did not override it. Typecheck and 372 tests were green. Only the
   screenshot showed it.
3. **A silently empty dashboard.** The first run showed no sections and no retry
   count against data that had plenty of both. `fetchDashboard` swallowed four
   query errors, so a failed query and an empty one looked identical — the
   project's own recorded lesson, repeated. Each now warns by name. The cause was
   a transient `item_stats` failure that has not recurred; it would now say so.

### 12.6 Navigation

Spec §2 has always specified this — *"Desktop uses a centered ≤720px content
column, sidebar nav; mobile uses bottom tabs"* — and it was never built. Study ·
Progress · Settings, as a bottom bar under 800px and a rail beside the content
above it.

Built from `expo-router/ui`'s headless `Tabs`, with **no new dependency**:
`@react-navigation/bottom-tabs` is not installed, and adding it would buy a
default appearance this project would then override. The whole bar is about
seventy lines, and one flex-direction switch gives both of the spec's layouts.

`set/[id]/*` stays in the root stack, so a deck covers the bar. Everything that
is a *place* is a tab; everything that is a *task* is pushed and keeps its own
back control. Verified on the built bundle: the flashcards screen shows the back
chevron and no tab bar.

**Verified:** typecheck clean · **372 tests** (326 before) · `expo export` · boot
test green · screenshots at 430px and 1280px. Not yet deployed — 0008 and 0009
are owner actions and 0009 must land first.

## 13. Phase 9c — the study assistant (D14)

A floating button that opens into a panel, grounded in the student's own notes,
with a daily cap so it cannot starve card generation. **Not in the spec** — §3.3
lists exactly four things Gemini does (read, write items, grade, write variants)
and this is a fifth, with a recurring cost. Recorded as **D14** rather than
slipped in.

> **Migration 0010 is NOT applied.** Until it is, the cap degrades open: the
> assistant warns once per question and answers uncapped. Unlike 0009 this is
> safe to deploy first — nothing reads a column that does not exist.

### 13.1 `maxOutputTokens` is not a spend control — measured

The obvious design is a small `maxOutputTokens` to make each answer cheap. It
was built that way, at 320, and **every question returned "I couldn't come up
with an answer"**.

On Gemini 3.x, `maxOutputTokens` budgets the model's **thinking and its answer
together**. Measured live on a realistic prompt:

| Cap | Model | Thinking | Answer | Result |
|---|---|---|---|---|
| 320 | `gemini-3.7-flash` | 303 | 76 chars | **MAX_TOKENS, cut mid-sentence** |
| 320 | `gemini-3.6-flash` | 286 | 26 tok | barely fits a one-line question |
| 640 | `gemini-3.7-flash` | 511 | 42 tok | STOP, complete |
| 640 | `gemini-3.5-flash-lite` | 0 | 46 tok | STOP, complete |

The thinking tokens are spent whether or not the answer fits, so a low cap does
not save them — **it throws away the answer they already paid for**.
`thinkingConfig: { thinkingBudget: 0 }` was tried and is ignored by these models:
thinking still ran to 303 tokens.

Set to 1024, and the real cost controls are the two that actually bound spend:
the daily message count, and the four-sentence rule in the prompt.

Note `flash-lite` reports zero thinking tokens — it does not think by default,
which is why it was the rung that appeared to work while the others did not.

### 13.2 A second bug behind the first

With the budget fixed the answers were still empty, and the ladder log showed a
rung had **served** the request. `#generateContent` returns
`extractJsonPayload(...)` to every caller, and the assistant was the one call
asking for plain text — so a perfectly good prose answer was run through
`JSON.parse`, failed, and arrived as `null`.

The reasoning that produced it is written down because it sounds right: an
answer is prose, so a JSON wrapper spends output tokens on braces the screen then
strips. True, and worth about ten tokens — far less than being the only call in
the file with its own return path. It now uses `CHAT_RESPONSE_SCHEMA` like
everything else, and `extractText` was deleted rather than left as dead code.

Both bugs presented identically: a fluent model, a silent null, and a student
told the assistant had nothing to say.

### 13.3 What it can see, and why that is two things

Card context on a study screen, set context elsewhere — the owner's choice, and
the cheap one is also the better one. Answering *"why is this the answer?"* needs
the card in front of you, not a page of notes, so the common question is also the
smallest request.

Verified against live Gemini. On a card:

> *"Your notes state that gas exchange passes through stomata on the underside of
> the leaf blade…"*

On a set, it surfaced **"Vance's rule"** and **"specimen VR-118"** — the canaries
planted in those fixtures (§6.1), which exist nowhere but in that document. That
is the check that matters: not that it replied, but that it replied from the
notes rather than from general plant biology.

`scripts/assistant-probe.ts` runs this, including the refusal paths that must
cost no model call at all.

### 13.4 The cap is a database row, not a counter in the browser

Gemini's free quota is **per Google project** (§2.2), so a per-device counter
would protect nothing: the same key on a phone and a laptop would each get a
full allowance and between them exhaust the quota generation depends on.

`claim_chat_message` (0010) increments and returns what is left in one statement,
so two tabs cannot both pass a check-then-increment. The claim happens **before**
the model call — a cap enforced afterwards would let a burst all through. A
failed call does not refund, because the failure modes that would trigger a
refund are exactly when the quota most needs protecting.

### 13.5 Deliberately not a chat

One question, one answer, no scrollback. A history would be re-sent with every
follow-up, so the third question in a thread costs several times the first — on
an allowance shared with the thing that actually makes the cards. It also drifts
from the grounding with each turn, and the useful question here is "explain this
bit", asked and answered.

### 13.6 D13 privacy copy extended, with approval

D13 fixes the Settings wording and says it must not be paraphrased smaller, so
the assistant is named rather than left implied. Owner-approved:

> The study assistant works the same way — what you ask it, and the notes it
> looks at to answer, are sent to Google too.

**Verified:** typecheck clean · **392 tests** · `expo export` · boot test green ·
screenshots of the closed button and the open panel · live probe grounded on both
contexts. 0010 outstanding.

## 14. Charts on the dashboard (2026-09-06)

The owner asked for graphs — *"donut charts time series or any appropriate
graphs"* — and then twice narrowed it: *"just because i mentioned a few graphs
doesn't mean you put it all, only the appropriate ones"*, and *"it must still be
readable"*. Two charts were added and one was declined.

### 14.1 The colours were wrong, and the validator said so

The first version reused the UI tokens as chart fills: `border` for "Not
started", `warnText` for "Tricky". Run through the dataviz validator against the
card surface:

| Check | Result |
|---|---|
| Contrast vs surface | **FAIL — `#dfe1e6` at 1.27:1** |
| Chroma floor | FAIL — `#6b4a00` reads grey as a fill |

**A segment of the bar was being drawn and could not be seen.** The lesson is
narrow and worth keeping: a colour that works as a hairline or as text is not a
colour that works as a fill, and this project had been reusing one set of tokens
for all three.

`theme.chart` now carries validated steps, chosen per mode rather than flipped:

| | known | learning | tricky | neutral |
|---|---|---|---|---|
| light | `#1d7a4c` | `#2f5fe0` | `#a86a00` | `#8c93a1` |
| dark | `#7ad6a5` | `#7ea0ff` | `#e0a458` | `#7c8492` |

All four clear 3:1 against their surface. Worst adjacent pair separates by
ΔE 16.1 under deuteranopia (light) and 17.1 under protanopia (dark).

`neutral` deliberately fails the validator's chroma floor. It means "no data
yet", and an absence should not wear a hue — every segment is labelled in text,
so identity never rests on colour.

### 14.2 No donut, and why

Donuts were asked for by name. Part-to-whole reads better as a horizontal
stacked bar: shares sit on a common baseline instead of being compared as arc
angles, it survives 340px of phone width, and the labels sit beside the numbers
rather than orbiting them. A donut would also have needed `react-native-svg` —
not installed — to draw something the guidance rates worse than what was already
on the screen.

### 14.3 What was added

**Answers a day, last 30 days.** Columns, not a line: the values are discrete
daily counts and the gaps carry meaning, so a line drawn through a day off would
imply study that did not happen. Zero-filled for the same reason — plotting only
the days with rows would space them evenly whatever the gaps, and a week off
would look identical to a week of daily study.

A day with answers never renders as nothing: a 1-answer day on a 40-answer scale
rounds below a pixel and would read as a day off, which is the one thing this
chart must not get wrong. Two axis labels, not thirty.

**Accuracy bars on the section rows**, replacing a coloured left border that
carried the same signal less usefully. Two sections can now be compared without
doing the division.

**Declined: accuracy over time.** With a handful of answers a day it would be
mostly noise, and a noisy chart of a real measure is worse than no chart.

Drawn with plain `View`s throughout — thirty columns is thirty flex children, and
no charting dependency was added.

### 14.4 A collision only the screenshot found

The assistant button sat squarely on top of the Settings tab. It is mounted once
above the navigator so it floats over screens that have a tab bar and screens
that do not, and it cleared only the safe-area inset. Typecheck and 398 tests
were green; the screenshot showed it immediately.

It now clears the bar's height, but only where there is one — the tabs group
draws it at the bottom on a phone and down the left on a desktop, and a study
screen pushed above the group has none. Offsetting unconditionally would have
left the button floating in mid-air on every deck.

### 14.5 `scripts/seed-progress.ts`

The dashboard has three genuinely different looks — empty, thin, and a real
month — and only the empty one occurs naturally on a fresh account. This writes a
plausible month into `study_days`: a keen first week, a four-day gap, a quiet
stretch, then a run into today. The gap is the point, since it is what proves the
streak counts back from the last day rather than totalling every day studied.

**It refuses to run against anything but the disposable test users**, checked on
the account that actually signed in rather than on the argument passed. It writes
fabricated answers, and on a real account that would corrupt the one thing the
app is trusted to remember, invisibly, mixed in with genuine history.

The seeded rows were cleared after verification: synthetic data left in a shared
test account has already produced one wrong conclusion in this project (§9.4's
first sample).

**Verified:** typecheck clean · **398 tests** · `expo export` · boot test green ·
screenshots at 430px and 1280px · deployed · bundle hash `1f05b9d5…` matches.

## 15. Three open items closed (2026-09-06)

### 15.1 The chat cap counted but did not enforce — applied and verified

Migration 0010 had been applied with the first version of `claim_chat_message`,
the one §13.4 describes: the guard sat in a `CASE` on the `SET`, so the row was
updated either way, `RETURNING` always yielded a number, and the caller could
not tell a granted claim from a refused one. With a limit of 20 the 21st
question came back "0 remaining" and `askAssistant`, which refuses only on a
negative, waved it through. **The cap counted and enforced nothing.**

The corrected function — guard in the `WHERE`, so a claim over the cap updates
no row and `used` stays NULL — was re-applied through the dashboard SQL editor
by the owner on 2026-09-06. Verified in the same editor against a limit of 2:

```
as iso-a@example.test -> claims returned 1 / 0 / -1  (want 1 / 0 / -1)  ==> PASS
```

The verification is worth keeping because running it is not obvious. `auth.uid()`
is NULL in the SQL editor, so `claim_chat_message` cannot be called there at
all without impersonating someone first — `set_config('request.jwt.claims', …)`
inside a `DO` block, which also needs `request.jwt.claim.sub` set for older
definitions of `auth.uid()`. The block ends in `RAISE EXCEPTION`, deliberately:
the message carries the result **and** the abort rolls back the three test
claims, so verifying the cap does not spend anyone's allowance. It runs as the
dashboard role, so it exercises the counting logic and not RLS — the row-level
rules were already proven by the counter working in the live app.

No application code changed. `remaining < 0` was always the right test; it just
never received a negative.

### 15.2 The 15 MB upload cap was self-imposed — measured, then raised

`MAX_FILE_BYTES` was 15 MB because `MAX_INLINE_BYTES` was, and §12.2 recorded
the reason as *"the limit is set by the reader, not the bucket"* — a 40 MB PDF
cannot become cards, so accepting one would spend storage on something the app
then refuses. **That was reasoning, not a measurement, and the measurement
reverses it.**

`scripts/large-file-probe.ts` builds scan-like PDFs — every page a single
photographic JPEG with film grain, no text layer, one unique canary per page —
and sends them through the real `READ_SYSTEM_PROMPT` and `READ_RESPONSE_SCHEMA`.
It calls the API directly rather than through `GeminiBrowserProvider` because
the numbers that decide this question (`finishReason`, output tokens, thinking
tokens) are in the envelope the provider discards.

| Document | File | Base64 sent | Read | Pages back | Canaries | Output used |
|---|---|---|---|---|---|---|
| 12 pages | 22.4 MB | 29.8 MB | **31.6 s**, tier degraded (gate 24.5 s) | 12/12 | 12/12 | 2,788 — **4.3%** |
| 24 pages | 44.8 MB | 59.7 MB | **19.9 s**, tier healthy (gate 4.2 s) | 24/24 | 24/24 | 6,974 — **10.6%** |

Both returned `finishReason: STOP` — not truncated — with readability 1.00 on
every page and every canary present, so the model read the pages rather than
inventing plausible plant biology.

**Where the walls actually are**, measured or derived from the two runs:

| Ceiling | Value | Reached at |
|---|---|---|
| Google's PDF cap | 50 MB | ~26 pages of scan — **the first real wall** |
| Inline request total | 100 MB | 75 MB of file, after base64's 4/3 |
| Output tokens | 65,536 | ~260 pages, at ~250 tokens/page |
| Input tokens | 1,048,576 | ~1,900 pages, at ~545 tokens/page |
| `CALL_TIMEOUT_MS` | 100 s | ~38 pages even at the degraded rate of 2.6 s/page |

**Nothing in this codebase binds below Google's 50 MB.** `MAX_INLINE_BYTES` is
now 45 MB — under that cap with margin, since a file that cleared ours and
failed Google's would be accepted, uploaded and then refused, which is the late
unclear failure the limit exists to prevent.

`MAX_FILE_BYTES` is **25 MB, and it is now set by storage rather than by the
reader** — the exact inversion of §12.2. At 45 MB a student fills their 150 MB
allowance with three files; at 25 MB the 20 MB scanned PDF this was raised for
still goes through. The user-facing refusal no longer claims "the most we can
read in one go", because that is no longer true and a student cannot check it.

**Options (b) and (c) were declined on this evidence.** Downscaling photos with
canvas solves nothing a 25 MB cap has not already solved — a phone photo is
2–5 MB and never reached 15 MB — and re-encoding a student's handwriting would
put the readability score, the only thing standing between a blurry page and
invented cards, at risk for no gain. pdf.js render-to-JPEG would spend ~1 MB of
a 2.0 MB bundle on the same non-problem. Neither was built.

**One cost worth knowing.** Every rung of the fallback ladder re-uploads the
whole file: the 44.8 MB read took a 429 on rung 1 and was served by rung 2, so
that document went up twice. At a 25 MB cap a bad moment can mean ~100 MB
uploaded from a phone for one document.

**Verified:** typecheck clean · **400 tests** (398 before; 2 new in
`tests/storage.test.ts` pinning the Google cap and the 20 MB case) · `expo
export` · boot test green on the new bundle · shipped in the same deploy as
§16, bundle `db0aab4c…`.

### 15.3 D14 exists in the spec at last

`src/ai/gemini.ts`, `prompts.ts`, `provider.ts`, `schemas.ts`,
`src/data/assistant.ts` and `src/ui/assistant.tsx` all cited **D14** for the
study assistant, and the spec had no such row — the decision was agreed in
Phase 9c and never written down. Added to §1 after D13, owner-approved as
written on 2026-09-06, carrying the three things the code depends on: one
question and one answer with no history, card context on a study screen and set
context elsewhere, and 20 questions per person per day claimed in the database
before the model is called.

## 16. Four iPhone defects the owner found, none visible here (2026-09-06)

All four came from the owner using the app on his own phone, in dark, and none
of them could have been caught by anything in this repository as it stood.
That is the finding worth keeping.

### 16.1 Tapping a field zoomed the whole app and left it zoomed

> *"when i press the chatbot, it kinda zooms it a little bit — causing me to
> swipe up left right down and seeing that white blank canvas."*

**iOS Safari force-zooms the page when a field with text under 16px takes
focus.** It does not zoom back out afterwards, so the app stays magnified and
pannable, and panning shows whatever is outside it.

Two fields were 15px: the assistant's question box and the paste-notes box on
Add notes — the two a student types into most. Everything using the shared
`Field` was already 16.

Fixed by `INPUT_FONT_SIZE` in `src/ui/theme.ts`, which all three now point at.
**The other available fix — `maximum-scale=1, user-scalable=no` — was
deliberately not used:** it takes pinch-zoom away from everyone who needs it to
read at all, to save one point of font size.

### 16.2 And the canvas it revealed was white

`html, body` had no background, so the area outside the app was the browser's
default white — framing a dark-themed app in white the moment a zoom or an
overscroll let you see past it. Now set in `public/index.html`, light and dark,
matching the two `theme-color` metas already there. **Four values that must stay
in step**, which is stated in the file itself.

### 16.3 The panel opened into the middle of a busy screen

> *"when i click on chatbot, it's kinda hard to focus like there's too much
> distracting part."*

It was a card anchored above the tab bar, with the set list still bright around
it — one more thing on a crowded screen rather than the thing being used. It is
now a dimmed overlay: tap anywhere outside to close, Escape still closes.

**On a phone it opens near the TOP**, which looks wrong for a bottom-corner
button until you watch it with the keyboard up. iOS does not shrink the page for
its keyboard, so anything anchored to the bottom ends up behind it and Safari
scrolls the whole app to chase the field — which is exactly what the owner's
second screenshot shows. The top half is the only part the keyboard cannot take.
On a desktop there is no keyboard to dodge, so it stays in its corner.

**The scrim is 0.7 black, not 0.55.** Checked in dark, because that is how the
owner uses it: black over a near-black page barely separates the panel from what
is behind it, and separation is the whole point of a scrim. The first attempt at
0.55 looked fine in light and did almost nothing in dark.

A thing that looked like a bug and was not: the tab bar still reads lighter than
the rest under the scrim. Hit-testing at that point returns the scrim, so it is
covered and a tap there closes the panel — the bar simply starts lighter than
the page, so it stays lighter when both are dimmed. Recorded because it cost a
round of investigation and would cost another.

### 16.4 The button crowded the tab bar

Raised from `space.lg` to `space.xl` above the bar. 16px above furniture that
already has the home indicator under it reads as misplaced rather than floating.

### 16.5 What could not have caught any of this — and what now can

- **The test suite** cannot load `src/ui/**` (it imports react-native), and has
  no iPhone.
- **The screenshot harness** drives headless Chrome on Windows, which has no
  such zoom rule, and — until today — **had only ever been run in light mode**,
  while the owner uses the app in dark. Both `openPage({ dark: true })` and
  `--dark` now exist. Every screenshot in §§7–14 is a light-mode screenshot of a
  dark-mode user's app.
- `tests/input-zoom.test.ts` reads the **source** of every `.tsx` and fails on a
  `TextInput` with `fontSize` under 16, plus the shared constant. Crude on
  purpose, and stated as such in the file: a style computed at runtime would slip
  past it. It is the only check that would have caught this one.

Two harness repairs came out of the same session, both small and both blocking:

- **`--click` now matches an accessibility label** as well as visible text. The
  assistant's button is an icon — `✦` — so it had no text to match and could not
  be driven at all.
- **Git Bash rewrites a lone `/` argument into a Windows path**, so
  `screenshot.ts / out.png` navigated to `C:/Program Files/Git` and failed with
  "Cannot navigate to invalid URL". Not a harness bug; run it from PowerShell,
  or pass `MSYS_NO_PATHCONV=1`. Twenty minutes were spent inside the harness
  before the shell turned out to be the culprit.

**Verified:** typecheck clean · **404 tests** (400 before; 2 new in
`tests/input-zoom.test.ts`) · `expo export` · boot test green · screenshots at
393×852 in **both** light and dark, panel closed and open · deployed · production
bundle hash `db0aab4c…` matches local.

**Not verified on the device that found them.** Everything above was checked in
headless Chrome, which is the tool that missed all four in the first place. The
zoom fix in particular can only be confirmed on a real iPhone — tap the
assistant's box and the paste-notes box and watch whether the page moves.

## 17. Four things the owner asked for after using it (2026-09-06)

Two bugs he hit while studying, one thing a friend asked for after he shared
the link, and a pet.

### 17.1 Switching level threw away where you were

> *"let's say i'm 5 of 9 progress in answering the flashcards in 'remember'.
> when i suddenly switched to 'apply' then went back to 'remember' i lost my
> progress. it went to 0 of 9 progress again."*

One `index`, shared by all three levels, reset to 0 by an effect on every
level change. Looking at another deck threw yours away.

There is now a position per level. That is the right model rather than merely
the convenient one, because **levels are exclusive** (deliberate deviation 7) —
Understand is a different deck from Remember, not a superset of it, so each
genuinely has its own place to keep.

Entering or leaving *retry what you missed* still resets all three, because
that changes what every deck contains.

**Checked against the built bundle, because no unit test can see it** — the
state lives in a react-native screen the Vitest suite cannot load, and the
defect only appears across a sequence of taps:

```
Remember 10      start:      0 of 10
Remember 10      2 answered: 2 of 10
Apply 4          switched:   0 of 4
Remember 10      back:       2 of 10
PASS — your place is kept
```

Kept as `scripts/study-probe.ts` rather than thrown away. §11.3 records the
screenshot harness being rebuilt from scratch three times before someone
committed it; this is the same lesson applied earlier. It reads the level
buttons off the page rather than hardcoding counts, so it runs against any set.

### 17.2 The quiz asked the same questions in the same order, forever

> *"the quiz isn't generating a new one after i finish answering the quiz …
> make it randomized everytime i opened the quiz."*

Questions came back in `listItems` order, and finishing was a dead end: the
only ways on were the missed pile or leaving.

The order is now drawn from a **round seed** — a timestamp taken once when the
screen opens — and **"Ask me again"** on the results screen starts a fresh round
by taking a new one. The questions are the same ones (a set holds what it
holds); the sequence is redrawn, which is the part that matters, since
answering in a memorised order tests the order as much as the material.

`shuffleOptions` already held a seeded Fisher-Yates, so the shuffle itself is
not new — `shuffleSeeded` is that function, exported. **Two callers want
opposite things from it**, which is why the seed is a parameter rather than a
clock: options seed by item id so a card's answers never move between viewings,
questions seed by round so they always do. The seed is `round:level`, so
switching level does not redeal the level you were part-way through.

Verified live across six opens — the leading question was the reproductive
organ twice, photosynthesis three times, support and transport once — and by
driving a full five-question round to the results screen, where each question
appeared exactly once (the double-submit guard from §10.3 still holds after the
refactor) and "Ask me again" dealt a different order.

### 17.3 Space, always visible, on one screen only

> *"i shared the link to my friend and he suggested that it would be nice to
> see the limit and how much space they consumed."*

This reverses the earlier instruction — *"don't show upfront everytime
regarding their limit"* — and both are satisfied by **where** it sits rather
than by whether it shows. The card is on Progress and nowhere else: never on
Add notes, never on a study screen. Someone who wants the number can find it;
nobody is told about a limit while they are trying to work.

It carries a bar as well as the figures, because the fraction is the actual
question — "24 MB of 150 MB" needs arithmetic before it becomes "plenty left".
Amber only above the nudge point, so the colour still means something when it
changes, using the validated chart steps rather than UI tokens (§14.1's lesson,
which cost a segment drawn at 1.27:1 that could not be seen).

Two details worth keeping: a small first upload never renders as a zero-width
sliver, because a bar showing nothing after an upload reads as "not counted";
and an empty account says *"Nothing stored yet"* rather than *"0 bytes"* —
`bytes` is on this project's own banned-words list, and `tests/storage.test.ts`
already rejects it in the upload message.

### 17.4 The streak is a pet now

> *"it would be great if there's a 'pet' similar to tiktok streak … the pet
> should grow larger every 1 (baby), 10, 20, 50, 100."*

`src/core/pet.ts` maps a streak to one of five stages, pure and tested. Two
choices in it are worth the words:

- **A streak of zero returns `null`, not a stage.** No pet and a baby pet read
  completely differently on screen — one is an invitation, the other a badge —
  and collapsing them makes the empty case the pet's problem.
- **Progress is measured across the current band, not the whole scale.** At day
  55 a bar against 100 would sit past halfway and barely move for a month;
  within the band it advances visibly every day.

The exact number stays beside the pet. A streak that cannot be read precisely
is a streak people stop believing, and the picture is an addition to it rather
than a replacement.

What is deliberately still absent, before and after: *"keep it up or lose it"*.
The streak survives a day you have not studied yet (see `studyStreak`), so
threatening someone with a loss they have not incurred would be a lie — and a
pet makes that kind of pressure land harder, not softer.

**The art is one image cut into five, and that is not incidental.** Five
separate generations drift in colour, outline weight and face, and a pet that
becomes a different animal when it grows is worse than no pet. The owner
generated one row of five stages on flat magenta — twice, a potato and a cat —
and `scripts/make-pet-assets.ts` cuts them into `assets/pet-1.png` … `pet-5.png`.
Chrome's canvas does the work, so no image library was added for a command that
runs about twice in the life of the project.

### 17.5 Cutting the art out taught more than expected

Four things, each of which broke the naive version:

**1. The file is not called what you asked for.** Both sheets arrived as
`.jfif` — what Windows saves a JPEG as from a right-click — so the script now
finds `pet-stages.{png,jpg,jpeg,jfif,webp}` and reads the type from the first
bytes rather than the extension. A data URI with the wrong type is a decode
error, not a useful message, and the owner should not have to know what a JFIF
is to get his potato into the app.

**2. A distance to `#FF00FF` deletes the eyes.** The first key scored how far a
pixel sat from magenta across all three channels. Pure white is 255 away in
green and identical in red and blue, which makes it score *closer to the
background than the brown of the body* — it would have punched holes through
every eye, and through the cat's entire white chest.

What actually distinguishes the background is its shape, not its distance:
magenta is red and blue both high with green markedly lower than **both**.
White has green just as high, so it survives; pink cheeks and a pink nose have
red high but blue no higher than green, so they survive too.

**3. A glow cannot be keyed by colour at all.** The top stage is drawn with a
warm aura, and an aura does not end — it fades through magenta. Sampled along
one row of the fifth frame:

```
253,124,155   255,135,144   254,148,134   251,157,119   255,192,95
   pink           coral         coral         orange        gold
```

Every threshold cuts somewhere in that ramp and leaves a hard edge of whatever
colour sits at the cut. The chroma test left **a pink disc** that read as a
blob rather than a glow, plainly wrong on a dark background.

The fix stops asking what colour a pixel is and asks **where** it is: flood
inwards from the frame edge through anything that is not the character's dark
outline. The outline is closed, so the flood washes around the character and
stops, taking the glow, the pale panel borders between cells, the drop shadow
and the loose sparkles with it, and leaving everything the outline encloses
untouched. The magenta shadow under each character is dark enough to block the
flood on luminance alone, so its chroma is what lets the flood through it.

**4. The flood must run BEFORE the trim.** Trimming makes the character touch
all four edges by definition, so a flood seeded from the border of a trimmed
frame starts inside the character and eats it. Order is: key, flood, trim.

Trimming matters more than it sounds on its own: the cells carry generous
padding and the stages sit at different sizes inside them, so untrimmed frames
would make the pet appear to shift and shrink as it grows — the opposite of the
intended effect. Cell boundaries are rounded per cell rather than floored once:
2064 across five is 412.8, and flooring drifts four pixels by the last frame,
which is enough to slice a tail off.

Both sheets came through clean — potato and cat, eyes, cheeks, whiskers and
white chest all intact.

### 17.6 Both pets ship, and the student picks — migration 0011

The two sheets were not a draft and a final. The owner: *"the reason why i put
two jpeg images is that the user may choose which pet they would want. cat or
potato."* Read as a choice of art by the developer, this was going to ship as
half a feature.

**The choice lives on the profile row, not in the browser.** It is a pet — it
is supposed to be yours, the same one on your phone and your laptop. Browser
storage would give the same person a potato at home and a cat in the library,
which is the one thing a pet must not do. Same reasoning as D12 for the API
key, and it inherits the same protection: `profiles` is already restricted to
its owner by RLS, so `0011_pet_choice.sql` adds a column and a check
constraint and nothing else.

**NULL means "has not chosen", and the default lives in the app.** Defaulting
the column to `'potato'` in the database would mean a later change of default
silently reassigning the pet of everyone who never picked one, with no way to
tell the two apart.

**`fetchProfile` asks for the column, and asks again without it on exactly one
error.** This matters more than it looks: `fetchProfile` is not a screen's
private query — Settings, quiz grading, the assistant and the variant pass all
read the API key through it, and it throws. Naming a column the database has
not got would not have "broken the pet"; it would have broken marking written
answers and making cards, everywhere, until the migration was applied. That is
the §10/§12 deploy-order hazard, and rather than make the order matter again it
retries on `42703` and warns. One query in the normal case; a second only while
the migration is outstanding.

**The chooser shows the pets rather than naming them.** The question is which
you would rather look at every day, and a radio button labelled "Cat" does not
answer it. It offers the third stage of each: the baby is too small to read at
tile size and the giant wears a crown belonging to a hundred-day streak nobody
has yet. The selected tile carries a ✓ as well as a border, for the reason
§10.4 gives about the quiz options — a verdict must not live in colour alone.
A tap saves; the tile lights up immediately and reverts if the save fails,
because a tap that appears to do nothing for a round trip reads as broken.

Adding a third pet is now: drop `assets/<name>-stages.<ext>` in, run
`npx tsx scripts/make-pet-assets.ts` (no arguments — it cuts every sheet it
finds), add one entry to `PET_SPECIES` and one to 0011's constraint.

**Verified end to end against the live database**, driving the built bundle:

```
choosing Cat…
stored choice survived a reload: Cat
dashboard: Your cat, small size, at 15 days in a row
reset to Potato
```

That the choice came back after a reload is the part that matters — it proves
the value was read from the database rather than held in screen state.

Sizes on screen are **explicit pixel width and height** with `contain`, per
§8.1's three attempts: a fixed height cropped the picture,
width-plus-aspect-ratio collapsed it to nothing, and numbers worked.

**The frames are WebP, capped at 280px, and that was worth measuring.** They
shipped as full-size PNGs first, and the cost was only noticed while checking
what was about to be committed:

| | total for ten frames |
|---|---|
| PNG, straight from the sheet | **1,150 KB** |
| PNG, resized to 280px | 805 KB |
| **WebP, resized to 280px** | **127 KB** |

The PNG version was **a third of the entire 3.4 MB web build**, spent on a
decoration. Flat-colour cartoons with hard edges are exactly the case WebP wins
by an order of magnitude. 280px covers the largest on-screen size (132pt) at 2×
on a retina screen; the sheet's own frames were up to 414px, which is detail
nobody can see paid for on a phone connection. The build went **3.4 MB → 2.4 MB**.

Trimming and downscaling happen in ONE draw rather than two, because resampling
an already-resampled frame softens the outline twice over. Verified in the
browser that the frames actually decode — `naturalWidth` 211×280 and 194×280,
`complete: true` — since a format the bundler passed through but the browser
would not render is exactly the failure that would leave an invisible pet.

`images.d.ts` was needed for any of this to typecheck — `expo/types` does not
declare image modules, so a `.png` import is an error until something says what
one is. Typed as `ImageSourcePropType` rather than `any`.

**Verified:** typecheck clean · **419 tests** (404 before; 13 in
`tests/pet.test.ts`, 4 in `tests/grade.test.ts`) · `expo export` · boot test
green · `scripts/study-probe.ts` PASS · quiz driven to results live · all ten
frames inspected at their real on-screen sizes on both the light and dark
grounds · Progress screenshot at 393×1500 in dark, where a 15-day streak drew
the second stage with *"5 more days and it grows again"* — the right stage for
15, and the right 5 days to 20 · the chooser screenshotted in dark · pet choice
saved, reloaded and shown on the dashboard against the live database.

Deployed; production bundle hash `1c8fb410…` matches local. 0011 was applied by
the owner before this shipped, so the retry path in `fetchProfile` is insurance
rather than the current state.

Seeded `study_days` rows were cleared after the screenshots, per §14.5: leaving
synthetic data in a shared test account has already produced one wrong
conclusion in this project.

## 18. Both dashboard charts were wrong, for different reasons (2026-09-06)

The owner, looking at his own Progress screen:

> *"this chart feels wrong too. and what is the relevance of that information?
> like 225 answers in 2 days. what do i gain from that?"*
>
> *"as a learner, i don't really know what's know well, getting there, and not
> started. to me it's just a circle with different colors. maybe the logic of
> that chart is incorrect?"*

Both critiques were right, and the second one was righter than it knew.

### 18.1 "What has stuck" could not move for 23 days

The old bands came from the SCHEDULE: a card counted as mastered once its
interval reached 21 days (SM-2's conventional line), struggling at three
lapses, learning otherwise. Defensible as a statement about scheduling.
Useless as something to show a student, and here is the arithmetic that proves
it — intervals go 1, 6, 16, 45 days, and a card is only shown when it is due:

| correct answers | interval | falls on |
|---|---|---|
| 1 | 1 day | day 0 |
| 2 | 6 days | day 1 |
| 3 | 16 days | day 7 |
| 4 | 45 days | **day 23** |

**No card could enter "Known well" before the 23rd day of using the app**,
however well the student answered. Everything touched sat in one middle band
and everything else in another. The chart was reporting how long ago someone
installed the app, not what they had learned — which is exactly what "just a
circle with different colors" describes.

**Now keyed on `reps`**, the scheduler's count of consecutive successes: a
correct answer increments it, a wrong answer resets it to zero, a partial holds
it. Already maintained, no new storage, and it moves the same day someone
answers.

| band | meaning | shown as |
|---|---|---|
| known | `reps >= 3` | "right 3 times in a row" |
| getting | `reps` 1–2 | "right once or twice so far" |
| needsWork | has a schedule, `reps === 0` | "your last answer was wrong" |
| notStarted | no schedule at all | "you haven't been asked these yet" |

First cards reach *known* on day 7 rather than day 23. It is also the plainer
claim: "you have got this right three times running" is something a person can
check against their own memory; "its interval exceeds 21 days" is not.

Two details that are not incidental:

- **Every band now says what put a card there**, beside the label. A label
  names a band; only the sentence tells you how to move one. That was the
  actual complaint, and a relabelling alone would not have fixed it.
- **"Never seen" and "got it wrong last time" are separate**, where the old
  scheme merged a lapsed card into *learning*. They are different things to a
  learner, and one of them is a to-do list.

Keying on the current run rather than on lapses also fixes something the old
version got right for the wrong reason: lapses never decrease, so a card that
went badly in week one would have carried the label for ever. `reps` forgets,
which is correct — what matters is whether you know it now.

`MASTERED_INTERVAL_DAYS` and `STRUGGLING_LAPSES` are deleted rather than left
unused. The scheduler still uses intervals and lapses; nothing outside it needs
those numbers any more.

**Existing accounts will see their counts jump**, and that is the point: cards
sitting in "Getting there" whose last answer was wrong move to "Needs work".

### 18.2 The activity chart measured effort and rewarded cramming

"Answers a day, last 30 days" was honest about what it plotted and the
plotting was fine. The problem was the question it answered.

**It measured effort, not learning** — and worse, it rewarded the exact
behaviour the scheduler exists to prevent. 225 answers crammed into two days
drew the tallest bars on the screen; the spacing that actually makes things
stick drew none. And "am I keeping at it?" was already answered, better, by
the streak and the pet sitting directly above it. §14.3 had argued the chart
earned its place by showing "something no number already says". Once the pet
arrived, that stopped being true.

**Replaced by the week ahead**: cards falling due each of the next seven days,
from the `review_state` rows the mastery bands already fetch — no extra query.
It answers something nothing else in the app can, namely whether tonight is
light and tomorrow is heavy, it is the scheduler's own knowledge which the
student otherwise discovers only by opening a deck, and it cannot be inflated
by grinding.

- **Overdue folds into today**, because that is what it is: work waiting now.
  A past-dated column would push the useful part of the chart sideways to make
  room for a scolding.
- **Rows, not columns.** Seven bars need seven labels and "Tomorrow" does not
  fit under a 40px column. Thirty columns needed no labels and could be
  vertical; seven do. The count sits where it is read rather than hovering.
- **A free day is drawn, not skipped** — an evening off is information, and a
  missing row reads as a bug.
- **One summary sentence, or none.** "Tomorrow is the busy one" only when that
  day holds at least two cards AND at least 40% of the week; never when today
  is heaviest, since its own row and the "cards ready for review" line above
  have already said so. Without the threshold the sentence gets said about a
  day holding one more card than its neighbours, and stops meaning anything.

Rendered, on a seeded account:

```
What you know
  Getting there   right once or twice so far          4
  Needs work      your last answer was wrong          8
  Not started     you haven't been asked these yet   16

Coming up this week
  Today       5
  Tomorrow    7
  Tuesday     —
  …
  Tomorrow is the busy one.
```

Note what the old bands could not have told him: **8 cards he got wrong last
time**, which is a to-do list, sat merged into the same colour as 4 cards he
had answered correctly once.

**Verified:** typecheck clean · **426 tests** (419 before; the `dailyActivity`
tests are gone with the function and 18 new ones cover `dueForecast`,
`describeForecast`, `forecastDayLabel` and the new bands) · `expo export` ·
boot test green · rendered on a seeded account and read back from the DOM ·
deployed · production bundle hash `6cecd3cb…` matches local.

**A limitation of this session, stated plainly:** the screenshot was taken but
could not be viewed — image reads stopped working partway through — so the two
charts were verified from the rendered text and geometry rather than by eye,
and the picture was sent to the owner to look at instead. Every other UI change
in these notes was checked by looking; this one was not.

## 19. The notebook — migration 0012 (2026-09-06)

> *"add a note tab. a good feature is that let's say i'm in class writing notes
> using the learning app, it would be great if there's a button to immediately
> transform the notes into flashcards."*

Two words in that brief decide the design: **in class**.

### 19.1 Losing a note is the only unacceptable failure

Everything else in this app can be regenerated. Cards come back from a model
call, schedules rebuild from attempts, the file can be re-uploaded. **An hour of
someone's own writing during a lecture cannot.** So:

- It saves 1.2 s after typing stops, not on a Save button someone forgets while
  packing up.
- It saves again on the way out, because leaving mid-sentence is how a lecture
  actually ends.
- **A failed save is stated, loudly, and the text stays on screen.** This
  project's recorded lesson is that silent failure costs a wrong conclusion;
  here it would cost the notes.
- Deleting a study set does not touch the note. `study_set_id` is
  `on delete set null` — the same reasoning as "Free up space" keeping every
  card while dropping the file.

The debounce timer is a ref, not state: at typing speed, re-rendering the
editor on every keystroke to reschedule a timer is the difference between
typing and fighting the field.

### 19.2 Notes are not documents

`documents` holds things you UPLOAD — a PDF, a photo, a paste — each attached
to a set, read once, then finished with. A note is the opposite on every count:
written a line at a time over an hour, belonging to the person rather than to a
set, and still being edited after cards have been made from it. Putting notes
in `documents` would mean a row whose extracted text goes stale the moment
another sentence is typed, attached to a set that may not exist yet.

### 19.3 "Make flashcards" reuses `/new` rather than repeating it

The button navigates to `/new?noteId=…`, which loads the note and prefills the
text. It does not run its own pipeline.

That screen already owns the whole of it: the API-key check, the count picker,
the storage backstop, the error mapping, the "adding to an existing set" path.
A second copy in the notebook would have drifted from this one the first time
either changed — and the count picker matters, because a note should not
silently become twenty cards when the student wanted forty.

The note is not modified by what happens there, and the screen says so, because
seeing your own writing in an editable box under a heading called "New set"
reads as if you are about to change the note itself.

### 19.4 Two bugs found by running it, not by reading it

**A missing table does not report the error you expect.** `NotesUnavailableError`
originally keyed on Postgres's `42P01` (undefined relation). The code that
actually arrives is **`PGRST205`**: a PostgREST request never reaches Postgres
when the table is absent from the schema cache — it is rejected before that.
With only `42P01` handled, the failure fell through as a generic error, the
list rendered zero rows, and the tab showed a convincing *"Nothing written
yet"* — an empty notebook rather than a missing one, with a "New note" button
that could only fail. Both codes are handled now.

**A saved note could still make cards from its old text.** The editor
invalidated the notes LIST on save but not the cached copy of the note itself,
and `/new` reads the note back from that cache. Queries here are fresh for 30
seconds, so tapping "Make flashcards" straight after typing a paragraph would
have generated cards from the text as it was *before* that paragraph — silently,
with nothing on screen to suggest it. Both keys are invalidated now.

Neither was reachable by typecheck or by the unit suite. The first needed a
real database with the migration missing; the second needed the two screens in
sequence.

### 19.5 A gotcha that cost twenty minutes: route types are a dev-server artefact

Adding `app/(tabs)/notes.tsx` and `app/note/[id].tsx` broke typecheck with
`Type '"/notes"' is not assignable to…`, because Expo Router's typed routes
live in `.expo/types/router.d.ts` and that file lists only the routes it knew
about last time it was generated.

**`npx expo export` does NOT regenerate it.** Neither does `npx expo typegen`,
which is not a command. It is written by the dev server, so the fix is to run
`npx expo start` for a few seconds and stop it. Worth knowing before adding a
route, because the error points at the call site and reads like a mistake in
the code that is actually correct.

### 19.6 What is deliberately absent

No folders, no tags, no formatting, no search. This is for typing with one hand
during a lecture, and each of those is a thing to fiddle with instead of
writing. A flat list, newest edit first, is navigable at the size a student's
notebook actually reaches. A title is optional — the note's own first line
becomes one, because people write a heading and never touch a title field, and
a notebook full of "Untitled note" would fail exactly the person who used it
most naturally.

`MIN_WORDS_FOR_CARDS = 30` gates the button, not the saving: half a sentence is
still a note and still worth keeping, but a dozen words cannot produce a study
set, and without the gate that failure arrives after a model call, as an empty
set, with nothing explaining why.

### 19.7 Three probe bugs, and what they have in common

0012 was applied and `scripts/notes-probe.ts` ran end to end. It failed three
times first, and **every failure was in the probe, against an app that was
plainly working in the dump printed underneath it.** The common cause is worth
naming, because it will recur the next time anyone drives this app from Node:

| The probe waited for | Why it never arrived |
|---|---|
| `"Start typing"` | That is the body's **placeholder**. Placeholder text is not `innerText`. |
| the canary in the page text | The note lives in a **textarea**; a field's *value* is not `innerText` either. |
| `/Ready\|cards/` after pressing make | Matched instantly against *"How many **cards** at most?"* on the screen it had not left yet — so it never waited, then reported the set as unmade. |

Two rules come out of it. **Read field values through the DOM, not the page
text**, for anything typed into. And **wait on the thing that can only be true
afterwards** — here `location.pathname.startsWith('/set/')` — rather than on
words that may already be on the previous screen.

That last one is the dangerous shape: a wait that passes immediately is not a
failure, it is a test that silently stops testing.

**Verified, all ten checks, against the live database and a real generation:**

```
PASS  autosaves without a Save button
PASS  counts the words
PASS  offers to make cards once there is enough
PASS  the note survives a reload
PASS  the title survives too — got "Plant transport"
PASS  carries the note text over — 795 chars
PASS  the note became a set — /set/13f8a6b6…
PASS  the note links back to its cards
PASS  appears in the list
PASS  deleting removes it
```

`--generate` is opt-in: it spends model quota on a tier shared with real
studying, and it is the only check that proves the headline claim rather than
the plumbing under it. The notes and sets the runs created were deleted
afterwards, per §14.5.

**Verified:** typecheck clean · **443 tests** (426 before; 17 new in
`tests/notes.test.ts`) · `expo export` · boot test green · the
migration-not-applied state checked live, which is where the `PGRST205` bug was
found · the four-tab bar measured at 393 px — four buttons of 98 px, no
overflow, no wrapping · `scripts/notes-probe.ts --generate` 10/10 · deployed ·
production bundle hash `855c6392…` matches local.

## 20. Reading the dashboard back, in the owner's words (2026-09-06)

Four changes, all from using it rather than from reading the code.

### 20.1 The space figure had been lying since 0009

> *"could you double check whether the space is working?"*

It was not. `0009_storage_and_study_days.sql` added `documents.byte_size` and
**never backfilled it**, and `uploadOriginal` is the only thing that writes it.
So every file uploaded before 0009 landed carried a null size, `storageUsedBytes`
summed nulls as zero, and the dashboard could report *"Nothing stored yet"* over
a bucket full of PDFs. The 150 MB per-user limit had not been counting any of it
either.

Reproduced on the test account before writing a line of fix:

```
documents: 2
  with a size recorded : 0  (0.00 MB)
  file but NO size     : 2   <- counted as 0
```

**The sizes were recoverable, and the code said they were not.** The note on
`storageUsedBytes` read *"the sizes are not recoverable through PostgREST"*,
which is true from the browser and false from SQL: Supabase records the real
byte count of every object in `storage.objects.metadata->>'size'`, and
`documents.storage_path` is exactly that object's name inside the bucket. So
`0013_backfill_byte_size.sql` is a recovery, not an estimate. It touches only
null rows, which is what makes it safe to run twice.

After applying: **2 sized, 0.13 MB, zero orphans**, and the card reads
*"129 KB of 150 MB used"*.

The general lesson is worth more than the fix: **adding a column to a table
that already has rows is half a migration.** 0009 shipped the half that
compiles.

### 20.2 Three wordings the owner would not have written

> *"could you reword into something more simple and direct? more meaningful? i
> don't like that 'where you stand'."*

**"Where you stand" → "How each part is going."** The old heading said nothing
about what the rows were or what would move them.

**`22 of 22` → `100%`.** The code carried an argument against exactly this —
that "4 of 5" is checkable and carries its own sample size, which a bare 80%
hides. That argument is sound in general and does not apply here, because
`MIN_SECTION_ATTEMPTS` already withholds a section until it has three answers,
so the misleading `1 of 1` the count was guarding against cannot reach the row.
Recorded because the comment defending the old form was persuasive and wrong
about this case.

**The empty state was still describing the old screen**, promising "what has
stuck" and "worth another look" after both headings had been rewritten. That is
how an empty state quietly stops introducing the thing it introduces — it is
the copy nobody re-reads, because it is the copy you see least.

### 20.3 The forecast speaks one vocabulary now

> *"for the coming up this week, just make it sunday to saturday. i don't like
> that today and tomorrow."*

Rows read Sunday, Monday, Tuesday — including the first two, which said "Today"
and "Tomorrow" on the reasoning that those are the days people plan around.

The real fault was not the words but the mixture: five weekday names with two
relative words on top makes the reader translate between two systems to work
out whether Thursday falls before or after tomorrow. One kind of label is
simply read.

**The window still starts today** rather than on a Sunday. A fixed Sunday-to-
Saturday week was the literal request and was put back to the owner with what
it costs — by Friday most rows are days already gone, and cards due early next
week become invisible — and he chose the rolling week. Same names, no dead
rows, always a full week ahead.

One knock-on: `describeForecast` still says nothing when today is the heaviest
day. That mattered less when the row said "Today"; now *"Wednesday is the busy
one"* on a Wednesday would read as a statement about some other Wednesday.

### 20.4 A third pet, and the extension path holding up

`0014_pet_dog.sql` widens 0011's check constraint to `('potato', 'cat', 'dog')`,
finding the constraint by what it checks rather than by name for the reason
0006 records. Verified live: `dog` accepted, `dragon` rejected with `23514`, so
the constraint widened without ceasing to guard.

§17.6 claimed adding a pet would be "drop a sheet in, run one command, add one
line to `PET_SPECIES` and one to the constraint". **Measured against a real
third pet, that was accurate** — the whole change was the sheet, one
`make-pet-assets.ts` run, one array entry, one label, one `ART` row, five
imports and the constraint. Worth recording because an extension point is a
claim until someone extends it.

The dog's frames came out at 10–19 KB, in line with the cat's 9–20 KB, which is
the cheap check that the background key and the flood fill did not eat anything:
a frame that lost its character comes back tiny.

Verified end to end: all three tiles fit at 393 px (105/103/103), all three
frames decode (`naturalWidth` 211, 194, 183, `complete: true`), and choosing Dog
in Settings put `dog-2.webp` on the dashboard — stage 2, correct for a 15-day
streak.

**Verified:** typecheck clean · **443 tests** · `expo export` · boot test green ·
both migrations applied and checked against the live database · the reworded
screen read back from the DOM · deployed · production bundle hash `df48830e…`
matches local.

One operational note: the hash check failed on the first read after this deploy
and passed six seconds later. Cloudflare had not finished propagating the new
`index.html`. **A mismatch immediately after a deploy is worth re-reading before
it is worth investigating** — every previous section's check happened to run
after the delay rather than inside it.

## 21. "11 cards ready for review" against a deck that had a few (2026-09-06)

> *"i noticed this in the progress tab. it says 11 cards ready for review but in
> my study tab, there's only a few. it's because i deleted some."*

The count was wrong, and the cause was not deletion — deleting a set cascades
its schedules away cleanly (`review_state` references both `study_items` and
`study_sets` `on delete cascade`, confirmed in §7.4) and `removeSet` invalidates
every query afterwards.

**It was reporting a card.** `reportItem` sets `hidden = true` rather than
deleting the row, and `listItems` filters `hidden = false` — so *"Thanks, you
won't see that one again"* is honest about the decks. Nothing deletes the card's
`review_state` row, and **every due count read that table directly**, so a
reported card stayed due for ever:

- `dueToday` and the week-ahead forecast on Progress
- `dueCountsBySet`, the badge on every set row on Study

Both over-counted by the same amount, which is why the drift was only visible
against the deck the app would actually deal. From the outside it reads as the
number being broken; after a while it reads as the screen being broken.

### 21.1 The rule is "count what you would deal"

`schedulesForVisibleCards` takes the ids the caller already has rather than a
`hidden` flag, so it is equally right for a card that is hidden, a card whose
row has gone, and whatever future reason a card stops being shown. A filter
written against `hidden` would have to be found and updated again the next time
a card can disappear for a new reason.

On the dashboard it costs nothing: `study_items` was already being fetched with
`hidden = false` for the mastery bands, so the visible-id set was already in
memory and unused.

On the Study tab there was no item query to reuse, so `dueCountsBySet` filters
in the same round trip with a PostgREST embedded join —
`.select('study_set_id, study_items!inner(hidden)').eq('study_items.hidden', false)`.
Verified against the live database rather than assumed, because an embedded
filter that fails to resolve its relationship returns rows rather than an error.

### 21.2 Reproduced before the fix, and proved after

Hiding one due card and re-running both queries:

```
unfiltered (old) : 5 rows
inner join (new) : 5 rows
after hiding one card -> old still says 5, new says 4
```

Then end to end against the built app, reading the number off the Progress
screen itself:

```
dashboard "ready for review": 5 -> hide one card -> 4 -> restore -> 5
PASS — the count follows the cards you can actually study
```

### 21.3 The dead rows are left alone, deliberately

`reportItem` still does not delete the schedule. With the filter in place the
row is harmless, and keeping it means a card that is ever un-hidden comes back
with its history rather than starting from nothing. The correctness boundary is
the read, which is where it can be tested.

**Verified:** typecheck clean · **447 tests** (443 before; 4 new on
`schedulesForVisibleCards`) · `expo export` · boot test green · both queries
checked against the live database · end-to-end on the built app.

## 22. The handoff rewritten, and two things it turned up (2026-09-06)

`docs/HANDOFF.md` was written before Phase 9 and had drifted into being a wrong
map: 322 tests against 447, 7 migrations against 14, no notebook, no pet, no
Notes tab, D1–D13 against D1–D14 — and an open-items list still naming two
things since closed (the backup's row counts, §11.2, and the uncommitted
screenshot harness, §11.3). It is the file this project's own instructions point
a new session at first, so every hour it stayed stale was an hour of somebody
starting from a false picture.

Rewritten against facts checked at the time of writing rather than remembered:
test count from a run, migration list from the directory, routes from `app/`,
commands from `package.json`.

### 22.1 The isolation test had not kept up either

It claimed 17/17 and passed — but it covered no table added since Phase 6.
Three had arrived since: `chat_usage` (0010), `profiles.pet` (0011) and
**`notes` (0012)**.

`notes` is the strongest case in the whole app for that test. Every other table
holds something *derived* from what a student uploaded; `notes` holds what they
actually wrote, in their own words, during a lecture. Its RLS policies were
written in this session and had never been exercised by anything but the owner
of the row.

Both are now seeded and checked. **19/19, no cross-user access** — B sees zero
of A's notes and zero of A's assistant usage.

### 22.2 The isolation test was littering

Running it also showed it had never cleaned up after itself: four `study_sets`
on the test account, two of them called "Isolation probe set", plus the rows
this session's additions had just started leaving.

That is precisely the hazard §9.4 records — synthetic data left in a shared test
account produced a wrong conclusion once already — being generated by the test
written to protect the account. It now sweeps its own probe set, note and usage
row at the end, matching **by title rather than by the id from this run**, so a
single run also collects what earlier runs left behind. Verified: notes 0,
chat_usage 0, and `study_sets` back to the two real diagram fixtures.

**Verified:** typecheck clean · **447 tests** · isolation **19/19** with cleanup
confirmed · every factual claim in the new handoff checked against the repo.

## 23. Phase A — four broken flows, and the checks that let them ship (2026-09-11)

An audit against `7218329` found four defects in screen code and three holes in
what protects the repository. The four had one thing in common, and it is the
most useful fact in this section: **447 tests covered `src/core` and `src/ai`
and nothing else.** Not one test imported `src/data/**`, `src/ui/**` or `app/**`.
That boundary is deliberate and correct — it is what makes Vitest work without
react-native — but it means every defect below lived in the one part of the
codebase nothing could reach.

### 23.1 The dashboard's one decision did nothing

`NextStep` is the last block on Progress and the screen's whole purpose: five
blocks of evidence ending in one action. All three of its branches called
`router.push('/')`. So *"Retry what you missed (12)"* read the missed pile,
counted it, printed the number on a button, and then dropped the student on the
list of sets to go and find it themselves.

Worse than having no button, because the label is a promise. And it had been
there since the dashboard shipped in Phase 9b.

**The fix needed a set id the dashboard did not have.** A count on that screen
spans every set; a destination is one set. Rather than a sixth query, the id
rides along on two that were already being made — `review_state` and
`item_stats` both carry `study_set_id` and neither was selecting it.

`busiestSet` (`src/core/progress.ts`) picks the target: most rows wins, ties
break on the id so the same data always produces the same button. **Most-of-them
rather than most-recent, which is deliberately the opposite of Home's
`continueTarget`** — Home answers *where was I*, Progress answers *where is the
work*, and someone who studied one set this morning with a backlog in another
should be sent to the backlog.

**Null is a real answer.** `busiestSet` returns null when there is nowhere to
send anyone, and both branches fall through to the set list rather than building
`/set/null/flashcards`.

One thing this turned up: `toRetry` was counting stat rows for cards the app
would no longer deal. That is §21's bug in a second place — a stat row outlives
the card it describes, so a reported card kept inflating the number. It mattered
less while the figure was decoration and matters now that a button opens it, so
the count is filtered to visible cards and the destination is computed from the
same list. The count, the route and the deck cannot drift apart.

### 23.2 Three smaller ones, each verified against the original

- **Quiz level buttons showed no counts.** `countByLevel` was computed, carried a
  docstring explaining that a button promising 10 and dealing 3 is a lie, and was
  then never used. Flashcards and Blanks both showed theirs. Only rendered
  outside retry mode, so the count over `quizzable` is what the tap deals.
- **Blanks had no retry mode** while Flashcards and Quiz did. Now reads the same
  `?retry=1`, from the same `missedItemIds` pile, under the same query key — one
  retry pile, three ways of being asked about it. Its `countByLevel` narrows in
  retry mode for the reason its own docstring already gave.
- **The set screen decided what to render from a ref.** `{isGenerating &&
  !started.current}` — and mutating a ref schedules no re-render, so "Keep going"
  appeared or did not depending on whether unrelated state happened to re-render
  the screen afterwards. **The ref is kept and a state flag added beside it**,
  because the two do different jobs: the ref is set synchronously and is what
  stops a second `generateSet`, which a state setter cannot do; the state is what
  renders. Replacing the ref outright would have traded a cosmetic bug for a
  duplicated generation run.

### 23.3 `app/+not-found.tsx`, which did not exist

Reachable in normal use, not only by mistyping: `router.replace` after creating
and after deleting a set rewrites the URL, and an installed PWA reopened on a
deep link rebuilds the stack from that URL alone. Without the file, Expo Router
falls back to its own screen, which names the route pattern it could not match
and offers nothing to do about it.

Registered on the stack with `backable`, which matters more here than anywhere
else — the usual way to arrive is a stack with no history, and
`HeaderBackButton` already falls back to Home when the navigator cannot go back.

### 23.4 The tests that could not reach any of this

`tests/screens.test.ts` is new, and it reads source text for the same reason
`tests/input-zoom.test.ts` does: `app/**` imports react-native and this suite
cannot load it. Crude, deliberately so, and it cannot prove a screen behaves —
only that the specific thing that was wrong has not been written back.

**Every guard was run against the pre-fix source before being kept**, because a
regression test that has never failed is a guess:

```
original push('/') count in NextStep : 3   (guard requires 1)
original NextStep had retry route    : false (guard requires true)
quiz level segment had countByLevel  : false (guard requires true)
blanks read ?retry=1                 : false (guard requires true)
set screen render read started.current: true  (guard requires false)
```

Anything genuinely computable went into `src/core` instead and is properly
tested there — `busiestSet` has five unit tests in `tests/progress.test.ts`.

### 23.5 CI, and a boot check that had been skipping

`.github/workflows/ci.yml` runs on push and pull_request. Until now the two
workflows here were both cron jobs; 447 tests, a typecheck and a boot check ran
only when the owner remembered.

**Order is typecheck → export → test, and that is not arbitrary.**
`tests/boot.test.ts` runs against `dist/` and is the only check that executes the
app — it exists because a react/react-dom mismatch shipped a blank white page
while the build succeeded and every test passed. On a clean checkout it *skips*,
which is right for a developer and wrong for CI: a run that skips it reports
success for exactly the failure it was written to catch.

So `REQUIRE_BUILD=1` turns a missing build into a failure. Nothing about the five
checks changed — only whether their absence may pass unnoticed. Verified both
ways: with `dist/` renamed away it fails with the message telling you to build;
with the export run first it passes.

**The workflow uses no secrets at all.** `expo export` inlines `EXPO_PUBLIC_*`
and `src/data/supabase.ts` throws at import without them, which would fail the
boot test for the wrong reason — so CI builds with an obviously fake URL and key.
The boot check asks whether the bundle executes and mounts, not whether it can
reach a database, and nothing in it makes a network call. Putting the real
publishable key in a public repository's build logs would buy nothing. **Verified
locally with the exact CI values: export succeeded, bundle mounted, 6/6 boot
checks.**

### 23.6 The backup's table list had failed four times out of four

`backup.yml` checked eight tables and printed *"All eight tables … are
present."* Three had shipped since: `study_days` (0009), `chat_usage` (0010) and
**`notes` (0012)** — the only table holding something a student wrote
themselves. A dump that dropped `notes` entirely would have passed and reported
success.

The comment beside that list said *"any future migration that adds a table must
add it here too"*. It was written after `review_state` went unchecked for two
days, and was then broken three more times. **A rule that depends on remembering
has now failed on every occasion it was tested, so it is gone.**

The list is derived from `supabase/migrations/` on each run. Every table in this
schema is created with the same form and every added column likewise, so both
are read out:

```
TABLES  (11): attempts chat_usage document_pages documents heartbeat notes
              profiles review_state study_days study_items study_sets
COLUMNS  (4): byte_size pet rubric_verified variant_prompt
```

Three details that are not incidental:

- **Only `public.` objects from this repo's own migrations** are considered,
  which is what keeps Supabase's internal `auth`/`storage` tables out.
- **An empty derivation fails the job.** A list that found nothing would pass
  every check below it without testing anything — the same silent success in a
  new costume.
- **A dropped table is subtracted.** Nothing drops one today; it is there so
  that doing so does not start failing the backup for the wrong reason.

The job now needs `actions/checkout`, which it never had — it had never read the
repository at all. And the message says *what* was checked rather than a count,
because a number nobody can check against anything is how the old one stayed
wrong through three migrations.

**Verified against a synthetic dump containing ten of the eleven tables: the
check fails, naming `notes`.** That is the exact drift that shipped.

**Not verified, and stated plainly: no backup has been restored.** This section
makes the structural check accurate. It does not make the backup known-good, and
the restore drill remains the one failure mode in this project where the loss is
permanent and silent.

### 23.7 `study_days` joins the isolation test — 20/20

It was the only user-scoped table the test did not cover. It also deliberately
survives deleting a set (it references only `auth.users`), which makes it the
longest-lived record of a person's habits in the database: when they study, and
how long they have kept it up.

**Seeded on a sentinel day, `2000-01-01`, and that is the difference between a
test and a bug.** `study_days` is real streak data. A row dated today would join
the account's actual run, and the cleanup would then delete a day someone really
studied — precisely the §9.4 hazard the cleanup exists to prevent. No day in 2000
can be genuine, the `unique (user_id, day)` constraint makes a re-run idempotent,
and deleting that exact day cannot touch anything real.

**No RLS problem was found.** B sees zero of A's streak rows, so no policy was
changed. Cleanup confirmed afterwards: sentinel rows 0, probe notes 0, probe sets 0.

### 23.8 What could not be verified, and one thing found on the way

**The screenshot harness could not sign in, so nothing here was checked by eye.**
`scripts/screenshot.ts` injects a session into `localStorage`; against the live
project every route now renders the sign-in screen instead, including Home.
Ruled out by inspection: the storage key is right (`sb-<ref>-auth-token`, which
matches supabase-js 2.114's own `defaultStorageKey` derivation exactly), and
`goto` uses `Page.navigate`, a full load, so a stale in-memory session is not the
cause. The remaining suspect, **untested**: the harness writes the raw
`/auth/v1/token` response, which has `expires_in` but no `expires_at` — auth-js
computes that field itself when it saves, and may discard a recovered session
without it.

This is a pre-existing harness defect, not a Phase A change, and it was left
alone. It matters beyond this phase: "verify UI changes by looking at them" is
one of this project's better habits and it is currently unavailable.

**Verified:** typecheck clean · **475 tests** (447 before; +5 `busiestSet`, +22
`tests/screens.test.ts`, +1 boot build guard) · `expo export` · boot **6/6**
against a fresh bundle · every new regression guard run against the pre-fix
source and confirmed to fail · isolation **20/20** with cleanup confirmed
against the live database · CI sequence rehearsed locally end to end · all three
workflow files parse and every `run:` block passes `bash -n`. **Not deployed,
and no restore drill.**

## 24. Phase B — a test seam for the data layer (2026-09-11)

§23 found four defects in screen code and named the reason all four shipped:
**447 tests covered `src/core` and `src/ai` and nothing else.** `src/data/**`
had never been tested, and the reason was not that it imports react-native —
it imports none — but convention. This closes that, for the three functions the
audit named.

### 24.1 A real client over a stubbed fetch, not a mock builder

`createClient(url, key, { global: { fetch } })` routes **PostgREST, Auth, RPC
and Storage through one injected fetch** — measured 2026-09-11 against
supabase-js 2.114, all four in a single stub. That is the same `fetchImpl` seam
`GeminiBrowserProvider` has always used, so it is the house pattern rather than
a new one.

The consequence is the point: a test drives the **real query builder** and can
assert on the URL it produces.

```
GET /rest/v1/review_state
    ?select=study_set_id,study_items!inner(hidden)
    &study_items.hidden=eq.false
    &due_at=lte.2026-09-11T00:00:00.000Z
```

A hand-written builder mock would have agreed with whatever the code asked it
for. That matters most on exactly this query, because §21.1 records that **an
embedded filter which fails to resolve its relationship returns rows rather than
an error** — a silently wrong count that looks like a working screen. The URL is
the only place that failure is visible before it reaches the database.

### 24.2 The shape: an optional trailing parameter

```ts
export async function dueCountsBySet(now = Date.now(), db: Db = supabase) { … }
```

`Db` is exported from `src/data/supabase.ts` with the seam documented there.
Seven functions carry it — `fetchDashboard`, `recordAttempt`, `dueCountsBySet`,
`dueCountForSet`, `currentState`, `saveSchedule`, `storageUsedBytes` — and
because the parameter is optional, **no call site had to change.**

**Except one, and it is the hazard worth recording.** `app/new.tsx` passed
`queryFn: storageUsedBytes` — the function **by reference**. TanStack Query
calls a bare `queryFn` with its own context object, which would have arrived as
the `db` argument and been used as a database client. Typecheck caught it; it
would otherwise have been a runtime failure on the upload screen.

So the rule this pattern comes with: **an optional trailing parameter is only
safe while nothing passes the function by reference to a caller that supplies
arguments.** Every other `queryFn` in the app already wrapped (`() => f()`);
that one was the exception, and now is not.

### 24.3 The screenshot harness — one cause found, another still open

§23.8 recorded, untested, that `scripts/screenshot.ts` writes the raw
`/auth/v1/token` response, which carries `expires_in` but not `expires_at`.

**That is now confirmed.** auth-js `_isValidSession` requires exactly
`access_token`, `refresh_token` and `expires_at`; a session missing the third is
discarded and `getUser()` answers *"Auth session missing!"*. Measured directly
against supabase-js 2.114. The same field is required by the test stub in
`tests/data.test.ts` for the same reason, which is how it was found.

> **CORRECTION, same day (see §25.4): the fix WAS sufficient. This section's
> conclusion below is wrong.** The harness signs in and screenshots
> authenticated routes again. What follows is left as written because the
> reasoning was sound and the conclusion was not — the run it rests on failed
> for some other, transient reason, and "not sufficient" was recorded after
> about two attempts rather than after establishing it reproducibly.

**The fix is in and it is not sufficient.** With `expires_at` written, the
session is well-formed and auth-js **keeps** it — an invalid one is deleted, and
this one survives the navigation with valid fields and ~3588s of life left — yet
the app still lands on `/sign-in` after ten seconds of polling:

```
stored : fields=[access_token, token_type, expires_in, expires_at,
                 refresh_token, user, weak_password]
         expires_at=1789141207  now=1789137619   (valid, ~1h ahead)
path   : /sign-in
root   : "Study | Enter your email and we'll send you a 6-digit code…"
```

So the remaining suspect is the app restoring the session rather than the shape
of what is stored. `startSessionListener` has **two writers to one store** —
`getSession().then()` and `onAuthStateChange`, both calling `setSession` and
`markReady` — and last writer wins. That is a hypothesis, not a finding: it has
not been tested, and real sign-in works in daily use.

What did change is that the harness **fails loudly instead of lying**. It
previously reported `'ok'` because a token had been written, and then produced
screenshots of the sign-in screen — which is how §18's two charts came to be
"verified" from geometry rather than by eye. It now asserts the app actually
comes up signed in, and prints the diagnostics above when it does not.

**Visual verification remains unavailable.** Nothing in Phase B was checked by
eye.

### 24.4 A shared mutable constant the tests would have tripped over

`EMPTY_DASHBOARD` is an exported object and `fetchDashboard`'s degraded paths
returned its `mastery`, `sections` and `forecast` **by reference**. One caller
sorting a returned forecast in place would have edited the constant itself, and
every later degraded dashboard in the process would have served the corruption.

Nothing did that — which is exactly why it was worth fixing first. The Phase B
tests are the first code to hold a returned dashboard and poke at it, and shared
mutable state that only misbehaves across two tests gets blamed on the test.
Confirmed real by mutation: with the by-reference version restored, a `999`
written into the first dashboard appeared in the second.

### 24.5 Every assertion was run against a broken version first

A regression test that has never failed is a guess. Both load-bearing
assertions were mutation-tested, with the source restored afterwards:

| Mutation | Result |
|---|---|
| Drop `study_items!inner(hidden)` + the hidden filter | FAILS — *expected 'select=study_set_id&due_at=…' to contain 'study_items!inner(hidden)'* |
| Return `EMPTY_DASHBOARD.mastery` by reference again | FAILS — *expected 999 to be +0* |

The sixteen tests pin, among others: the embedded join and the UTC-day boundary
on `dueCountsBySet`; that the dashboard answers in **five queries and no more**;
that `retryTarget`/`dueTarget` reach the screen (§23.1 end to end rather than
`busiestSet` alone); that a reported card counts as neither due nor to-retry;
that one failed query does not take the screen down and says so; the
`study_days` → `attempts` fallback; and on `recordAttempt` the **order** —
answer, then day, then schedule — the `23514` `blanks`→`flashcards` retry, that
a failed schedule write does not lose the answer, and that a failed answer write
does throw.

### 24.6 The seam pays for itself twice

It also makes **live** verification trivial, because a signed-in client can now
be handed to the real function from Node. Run against the live project:

```
dueCountsBySet -> 2 sets: [6d29b263…, 5], [4abb8b3b…, 7]
fetchDashboard -> dueToday=12  toRetry=8
                  retryTarget=4abb8b3b…  dueTarget=4abb8b3b…
                  mastery={known:0, getting:4, needsWork:8, notStarted:16}
```

5 + 7 = 12 agrees with `dueToday`, and the embedded join returns real rows under
real RLS — the thing the URL assertion cannot prove on its own.

**Verified:** typecheck clean · **491 tests** (475 before; +16) · `expo export` ·
boot **6/6** against a fresh bundle · both key assertions mutation-tested ·
both queries run against the live database · `vitest.config.mts` gains `test.env`
because `src/data/supabase.ts` throws at import without it, and that fail-fast
stays. **Not deployed. No restore drill. Nothing checked by eye.**

## 25. Nomi — naming the companion, and a place for it (2026-09-11)

The app has had an AI assistant since Phase 9c (**D14**) and has never had a name
for it. This gives it one — **Nomi** — adds a screen of its own, and puts in the
boundary through which it will later reach the student's learning data. No
learning intelligence is built; that is Phase C and D.

### 25.1 One companion, not two

Nomi is the existing assistant's identity, not a second AI. `askAssistant` is
still the implementation, the ✦ floating button is still mounted once above the
navigator, and the quota, the grounding store and the prompt builder are
untouched. The only changes there are the words a student reads.

The floating ✦ is **Nomi in its in-context form** — it sees the card in front of
you. `app/nomi.tsx` is the dedicated place, for questions about the studying
rather than about one card. Both carry the same ✦ deliberately: two marks would
make one companion look like two features.

**The D13 privacy copy in Settings is deliberately NOT renamed.** It still reads
*"The study assistant works the same way…"*. That paragraph is owner-approved
copy which D13 says must not be paraphrased smaller, and the instruction was to
leave it alone. So the app names Nomi everywhere except there — a chosen
inconsistency, and `tests/screens.test.ts` now pins the sentence verbatim and
asserts the word Nomi never appears in that block, so a later edit cannot drift
into it. Mutation-tested: renaming it there fails the suite.

### 25.2 There was nowhere to put it

A tab root has **no navigator header** — `headerShown: false` for the whole
`(tabs)` group, and the tabs layout renders none of its own — so each screen
names itself with a `Title` as the first child of `Screen`. "The header area" of
a tab is therefore the top of the body, and the bottom-right corner was already
the floating ✦.

`menu.tsx` has `HeaderTitle` and `HeaderGlyphButton`, dead since the Home gear
was superseded by the Settings tab, and they look like exactly what was needed.
They are not: their `marginLeft`/`marginRight` compensates for a stack header
spanning the whole window, and inside `Screen`'s already-centred column they
would inset a second time. Hence a new `TitleRow` in `components.tsx` instead —
recorded because reusing them is the obvious move and it is wrong.

`TitleRow` is a primitive rather than four hand-edits because **Progress renders
its title from three early returns** (loading, nothing-answered-yet, the real
screen) and Study from one. A test asserts all three Progress branches carry it;
dropping one fails.

**Nomi is not a fifth tab.** The four tabs are the learning loop, and a bar entry
would make Nomi somewhere you go *instead of* studying rather than something
beside it. It is a pushed route with a back control, like every other task.

### 25.3 The boundary, and what is deliberately not behind it

```
Nomi UI  →  src/data/nomi.ts  →  existing src/data functions  →  Supabase
```

`getNomiContext(db)` composes exactly one existing call, `listSets`, and imports
no Supabase of its own — the rule `src/data/pipeline.ts` already keeps, because
an orchestrator that runs its own queries is just a second data layer. It takes
the **Phase B `Db` seam** as its optional trailing parameter, so it is testable
and so live verification stays possible.

`NomiContext` in `src/core/nomi.ts` holds only `sets`. Everything else Nomi will
want — what is due, which sections are weak, whether accuracy is improving —
names itself in a comment and is **not implemented**, because none of it can be
answered truthfully before Phase C. A companion that states a confident figure
it invented is worse than one that says nothing, since it gets believed.

**Nothing in the UI calls it yet, and that is the design.** Opening Nomi's screen
costs no round trip; a placeholder that quietly spends a query on every visit is
one that ships and is forgotten. A test asserts the screen contains no
`useQuery`, and another asserts `getNomiContext` issues exactly one request —
adding a second fails it.

Two smaller things fell out of this:

- **The by-reference trap, caught before it landed.** `getNomiContext` first
  returned a shared `EMPTY_NOMI_CONTEXT` constant on its degraded path — exactly
  the §24.4 bug. It is now `emptyNomiContext()`, a function, and a test mutates a
  returned context to prove the next one is clean.
- **The Phase B call-site hazard, second sighting.** Adding the seam to
  `listSets` broke `app/(tabs)/index.tsx`, which passed `queryFn: listSets` **by
  reference** — TanStack Query would have handed its context object in as the
  database client. Typecheck caught it, as it did for `storageUsedBytes` in §24.2.
  That is twice now: the optional trailing parameter is safe only while nothing
  passes the function by reference.

### 25.4 The screenshot harness works again — §24.3 was wrong

§24.3 recorded the missing `expires_at` as confirmed-but-insufficient, and that
conclusion does not survive. With the fix in place the harness signs in, renders
authenticated routes and saves images. Home, Progress and Nomi were all captured
at 393px in dark mode.

The earlier finding was reached after about two failed runs and written up as
settled. The honest lesson is not about auth: **"I tried it twice and it still
failed" is not a measurement**, and this project's own habit — reproduce, then
conclude — is exactly what was skipped. The section is kept with a correction
banner rather than rewritten, because the reasoning in it was sound and only the
conclusion was wrong, and that is worth being able to see.

### 25.5 Looking at it caught what the tests could not

The first build rendered **"Nomi" twice** — once in the stack header, once as the
body title directly beneath it. Every test passed: they assert the route exists,
that it is registered, that it makes no queries and that its copy is plain, and
none of that can see two identical words down a screen.

Removed the body heading; `note/[id]` already does it this way, letting the
header name a pushed screen. (`new.tsx` keeps a body title because its wording
changes with how you arrived — "Add notes" / "Make cards from your note" — so the
duplication there is only apparent.)

This is the first UI change since §18 to be checked by eye, and it found a defect
on the first look.

**Verified:** typecheck clean · **514 tests** (491 before; +23) · `expo export` ·
boot **6/6** against a fresh bundle · every new guard mutation-tested, including
the D13 copy, the tab exclusion, the three Progress branches, the no-query rule
and the single-query rule · Nomi's copy confirmed present in the shipped bundle
and the D13 sentence confirmed unchanged in it · **screenshots taken and looked
at** for Home, Progress and Nomi. **Not deployed. No restore drill.**

## 26. Phase C — which sections are moving, and a label retired (2026-09-12)

The audit found one question in the brief that nothing in the app could answer:
*which concepts are improving?* `sectionSplit` says where a student stands —
43% on Renal Physiology — and cannot say whether that is on the way up from 20%
or down from 70%. Those are opposite situations wanting opposite advice.

Nothing new is stored for it. `attempts` has carried `created_at` since 0001;
the information was always there and was only ever aggregated away by
`item_stats`, which sums a lifetime and keeps no order.

### 26.1 The first sensible-looking gate was unusable, and the simulation said so

`app/(tabs)/progress.tsx` already carried a decision against this: *"no chart of
accuracy over time: with a handful of answers a day it would be mostly noise,
and a noisy chart of a real measure is worse than no chart."* A direction label
is not a chart, but it answers to exactly that objection — so the gate was
measured rather than argued.

The measurement: simulate a student whose real accuracy **never changes**, and
count how often the rule claims a direction. Every one is a false alarm, because
there is nothing to detect. At p = 0.5, where variance is worst, 20,000 trials
per cell:

| answers per window | ≥ 1/3 | ≥ 0.40 | ≥ 0.50 |
|---|---|---|---|
| 6  | **0.385** | 0.145 | 0.145 |
| 8  | 0.215 | 0.077 | 0.077 |
| 10 | 0.114 | **0.069** | 0.031 |
| 12 | 0.154 | 0.065 | 0.021 |
| 15 | 0.084 | 0.022 | 0.005 |

**Six per window at a one-third threshold was the obvious first choice and would
have told two students in five that they were improving or slipping when nothing
had happened.** It looked entirely reasonable in code review and would have
shipped. That is the whole value of the measurement.

Settled on **ten per window, 0.40** — 6.9% false alarms in the worst case, 2.8%
for a consistently strong student, still catching a genuine 0.4 → 0.8 shift 55%
of the time. Twelve buys almost nothing (6.5%) for a fifth more data. At ten,
accuracy moves in tenths, so the threshold is exactly *"four more right out of
ten"*.

The rows are not monotonic because the threshold interacts with the window's
granularity — a detail worth keeping, since it is why 12 looks worse than 10 at
1/3.

**The honest cost: a section needs twenty recent answers before this says
anything at all.** Staying silent until then is the point, and `steady` renders
as nothing so the usual state of the screen is unchanged.

### 26.2 The live data agreed, by staying quiet

Run against the test account:

```
FIGURE 2.1 — PLANT ORGANS…   n=26   0% -> 15%   steady   (0.15 < 0.40)
Overview of the plant body   n=6                 (no trend — under the gate)
```

A 15-point move on 26 answers is not called a direction. That is the gate
working on real data rather than on a simulation.

### 26.3 The first `.limit()` in `src/data`

The trend needs the answers themselves, in sequence, so it is a sixth query on
the dashboard — and the only read on that screen touching a table that grows
without limit. It is bounded twice: a 60-day floor because a turnaround in March
is not news in September, and a 600-row cap because a heavy user could hold
thousands inside that window. Newest first, so a cap that bites keeps recent
history rather than an arbitrary slice.

Every other read in `src/data` is still unbounded — that stays on the Phase G
list. This one was written bounded because `attempts` is the fastest-growing
table in the app.

The Phase B test asserting *"five queries and no more"* now asserts the **set of
tables** rather than the count. The count was never the invariant; a table
appearing twice is.

### 26.4 `topic` cannot group anything, measured properly this time

The audit deferred a decision on `topic` and the `topic_stats` view. Measured
against the live database on 2026-09-12, with normalisation actually attempted
rather than assumed:

```
cards                     28
distinct topic labels     26      1.08 cards per label
after normalising         24      case, punctuation, articles, plurals,
                                  word order all folded together
labels reaching 3 cards    1 of 24
distinct section_title     3      9.33 cards each
```

The model writes a fresh two-to-four word label per card — "Leaf anatomy", "Leaf
Function", "Root Absorption" — so every per-topic rate would be computed over a
single answer. **Normalisation moves it from 26 to 24.** This confirms the
earlier "17 labels for 17 cards" with more data and a real attempt at fixing it.

So `topic_stats` is retired in migration **0015**: a view with no consumer, which
the isolation test and the backup check have both been maintaining as though it
mattered.

**The `topic` column stays.** It costs one text field and is the raw material if
a later phase asks the model to choose from a fixed vocabulary instead of
inventing a label. What goes is the view that pretends the labels group today.

`study_items.form` goes with it, for a simpler reason: **null on every card in
the database.** It was written on every insert, read by nothing, and the
generation schema stopped returning it, so it has been writing null its whole
life.

### 26.5 Applied in an order that cannot break

Migrations here are pasted by hand, so code and schema are out of step for
however long that takes. Both changes are written to be correct in either state:

- `src/data/items.ts` stopped selecting and writing `form` first. Selecting
  fewer columns is valid whether or not the column is still there.
- `scripts/isolation-test.ts` treats a missing `topic_stats` as **retired**
  rather than failed, recognising `PGRST205`/`42P01`. Verified passing **20/20**
  with the view still present; it will report it as retired once dropped.

That is the same tolerance `recordAttempt` keeps for `23514` and `notes` keeps
for `PGRST205`, and it is why **migration 0015 is safe to run whenever**.

> **Applied since. Verified against the live database on 2026-09-12 (§28):**
> `study_items.form` answers `42703 column does not exist` and `topic_stats`
> answers `PGRST205`. The sentences below that say it is unapplied were written
> before that and are corrected here rather than rewritten in place.

### 26.6 What was looked at, and what could not be

`steady` renders nothing, and the test account produces only `steady`, so the
new word could not be seen from real data. The seeder deliberately refuses to
fabricate answers — *"on a real account that would corrupt the one thing the app
is trusted to remember"* — and that refusal is right, so no answers were faked.

Instead the word was forced on locally, built, screenshotted and reverted, to
judge the one thing that actually needed eyes: **the row layout**. With the
longest real section name wrapping to two lines, "slipping 7%" sits cleanly to
the right of it and the accuracy bar below is unaffected. The forced build was
never kept.

One case the forced view could not show, and which the real code does handle: a
section in *Worth another look* that is nonetheless **climbing** renders green
inside an amber-headed list. That is deliberate — a weak section on the way up is
the most encouraging thing this screen can say.

### 26.7 Three things the first write-up left unstated (verified 2026-09-12)

Reviewed after the fact, and all three were real gaps rather than wording.

**The 6.9% is per SECTION, and the screen shows four.** The dashboard computes a
direction for every section, so the chance at least one is spurious for a
student who has not changed compounds (40,000 trials per cell):

| sections | p=0.5 | p=0.7 | p=0.85 |
|---|---|---|---|
| 1 | 0.069 | 0.077 | 0.026 |
| 4 | **0.249** | 0.278 | 0.102 |
| 8 | 0.441 | 0.481 | 0.196 |

**About one screen in four will carry a spurious word** once four sections are
ranked. No correction is applied — the alternative is a threshold so strict
nothing is ever said, and the cost of being wrong is one soft word, not a grade
or a schedule. But "6.9%" alone reads as a promise about the screen when it is
only a promise about one row.

**The simulation's independence assumption is optimistic, in a known direction.**
It treats answers as independent coin flips. Real data is neither independent
nor stationary: the same cards recur so answers cluster; `reviewOrder` deals
overdue and lapsed cards first, so a window is deliberately enriched with cards
recently got wrong; and a real change is gradual rather than a clean step at the
midpoint, which the power figure assumes. The rates are a **floor**. They were
still enough to reject the first constants outright, which is what they were for.

**The percentage on the row and the word beside it come from different windows.**
`SectionScore.accuracy` is a lifetime rate from `item_stats`; `earlier`/`recent`
are the last 60 days capped at 600 answers. A section can read *"7% climbing"* —
the 7% still carries a bad start the trend has left behind. That is the intended
reading and is now stated at the render site and on the type. `change` is in
percentage **points**, not relative percent. Only `direction` reaches a user
today; anything that later prints the trend's own numbers must name its window.

**And one correction.** `sectionSplit`'s docstring claimed *"a partial counts as
neither right nor wrong"* while the arithmetic counts it exactly as a miss —
`correct = attempts - misses - partials` over `attempts`. `tests/progress.test.ts`
pinned the real behaviour under that same false name. Both now describe what the
code does. **The behaviour is unchanged and flagged, not fixed:** the old
wording's reasoning is a fair argument for excluding partials from both halves
of the fraction, but acting on it moves every accuracy figure on Progress, which
is an owner's decision.

**Verified:** typecheck clean · **534 tests** · `expo export` · boot **6/6**
against a fresh bundle · the gate measured by simulation, the rejected setting
recorded, and the family-wise rate measured after review · trend run against the
live database · isolation **20/20** · seeded study days cleared afterwards.
**Migration 0015 written and NOT applied** *(applied and verified since — see
§28)*. **Not deployed. No restore drill.**

## 27. Phase D — the deck deals what is going worst (2026-09-12)

`reviewOrder` answers *what does the schedule say*. `studyOrder` answers *what
should this student see next*, which is a different question once some cards
have beaten them repeatedly and others never have.

### 27.1 Three parts of the plan collided with approved decisions

Each was put back to the owner rather than routed around, and each came back the
conservative way:

**It never changes the level.** The plan said a run of correct answers should
escalate to the level above. Levels are exclusive at the owner's request — *"5
cards in understand is basically remember, there's no challenge at all"* — and
the buttons carry counts so the challenge is picked knowingly. Auto-escalation
would make those counts lie about what is being dealt. The selector reorders
**within** the chosen level and nothing else. A test asserts no `useEffect` in
Flashcards or Quiz calls `setLevel`; Blanks keeps its single documented
exception, which stops the moment the student picks a level.

**Quiz keeps its shuffle.** Flashcards and Blanks both already ordered by
`reviewOrder`, so upgrading that one function improves both. The quiz shuffles
per round because the owner asked — *"make it randomized everytime i opened the
quiz"* — and answering in a memorised order tests the order as much as the
material. A test asserts `quiz.tsx` contains `shuffleSeeded` and **not**
`studyOrder`.

**The queue is built once.** The brief wants a miss followed by another card
from the same part of the notes. The screens are `items[index]`, so reacting
mid-answer means reordering under a moving cursor — which repeats or skips
cards, and would undo the per-level position fix from §17.1. Grouping a
section's cards adjacently gets the same effect with no mutation: the sibling is
already the next card.

### 27.2 The signal was already arriving and being thrown away

`reviewStatesForSet` has returned `lapses`, `reps` and `ease` per card into
every study screen since Phase 6, and `reviewOrder` reads only `dueAt`. **No new
query, no new column, no new state** — the struggle data was in memory the whole
time.

### 27.3 It refines the schedule; it does not overrule it

The three bands — due, never-seen, future — are untouched, and `dueBucket` is
now shared so that principle has one definition rather than two. Everything
`studyOrder` adds happens *within* a band:

- most lapses first, then whoever is not on a streak (`reps === 0`), then the
  schedule's own longest-overdue order;
- a section's cards dealt as an unbroken run, the section's place set by its
  **worst** card rather than its average — a section holding one card you keep
  failing is worth opening even if the rest is fine.

A test pins that a much-failed *future* card still waits behind a calm *new*
one, and another pins that on a deck with no history `studyOrder` is
byte-identical to `reviewOrder`, so Phase 6's behaviour did not silently change
for every new set.

**Deliberately not used: section accuracy and the Phase C trend.** Both are
calibrated for a display label, not a selection decision — §26.7 measured the
trend wrong on about one screen in four across the sections it shows, and
`sectionSplit`'s accuracy still carries the open question about how partials
score. Per-card `lapses`/`reps` are stronger evidence and depend on neither. This
is why Phase C's two ⚠️ items were not blockers for Phase D: the study screens
never read anything the dashboard computes.

### 27.4 Verified on the live database, and looked at

Run against the real test account, comparing both orderings on the same cards:

```
remember (10) — ORDER CHANGED: true
   1. due  lapses=6 reps=0
   2. due  lapses=5 reps=0
   3. due  lapses=5 reps=0
   4. due  lapses=5 reps=0
   5. due  lapses=4 reps=0
   6. due  lapses=0 reps=1
   7. due  lapses=0 reps=1
   8-10. new
understand (3) — ORDER CHANGED: false      all new, nothing to refine
apply (4)      — ORDER CHANGED: false      all new, nothing to refine
```

The cards that have beaten the student most now lead, the bands hold, and the
refinement is correctly invisible where there is no history.

Screenshotted at 393px in dark mode on the Remember deck: the most-lapsed card
is dealt first and the existing *"7 due for review today — those come first"*
line still reads true. **Section grouping could not be seen** — every card in
this set belongs to one section, so there was nothing to group. It is covered by
unit tests and mutation-tested, but not observed on real data.

### 27.5 Both guards were run against a broken version

| Mutation | Result |
|---|---|
| Sort struggle globally, ignoring the bands | 3 tests fail, incl. *"does not let struggle reach across bands"* |
| Drop section grouping | 2 tests fail, incl. *"deals a section as a run"* |

One of those mutation runs wrote a broken `schedule.ts` and its backup silently
failed, so the restore had nothing to restore from. Caught because the next test
run was checked rather than assumed. **A backup that is not verified before the
mutation is not a backup** — later runs assert the file is non-empty first.

**Verified:** typecheck clean · **556 tests** (534 before; +22) · `expo export` ·
boot **6/6** against a fresh bundle · both guards mutation-tested and the source
confirmed restored · both orderings compared on the live database · screenshotted
and looked at. **Migration 0015 still not applied** *(applied and verified
since — see §28)*. **Not deployed. No restore drill.**

## 28. Phase E1 — question-type control, measured and deferred (2026-09-12)

The roadmap asked to restore `study_items.form` with a deterministic validator
per form. **No feature was built.** This section is the experiment that decided
that; the conclusion is in §28.10 and the feature is deferred, not abandoned.
The only production change is a prompt cleanup, measured before it was made
(§28.9).

### 28.1 The premise was wrong in a way that mattered

`GENERATE_RESPONSE_SCHEMA` has **no `form` property**. Gemini structured output
emits only schema fields, so the model reads *"Allowed forms: definition,
question and answer, compare, process, cause and effect, application"* and has
nowhere to answer. **No card has ever claimed a form.** That is why 0015 found
the column null on every row — not drift, a field that was never wired.

So the roadmap's framing — "nothing checks that a card matches the form it
claims" — was too generous. There was no claim to check.

Two more things were available for free, before any model call: `application`
restates `level: apply`, which the app already has and already shows counts
for, and a definition *is* a question and answer. The six were never a
partition.

### 28.2 Migration 0015 is applied, and the notes said otherwise

Checked against the live database at the start of this work: `study_items.form`
→ `42703 column does not exist`, `topic_stats` → `PGRST205`. §26.5 and §27.5
both still read "not applied". Corrected in place.

### 28.3 The instrument, and the three failures it had to tell apart

`src/core/form.ts` implements one rule per candidate label. **All six**,
including the two hypothesised to fail — a strawman for either would have
guaranteed the hypothesis confirmed. No rule reads `level`, or the redundancy
question would answer itself.

A negative result had to be attributable, so three failures were separated:

- **TAXONOMY** — the labels carve nothing. Measured by how often a human
  labeller answers *several* or *none*.
- **RULE** — the distinction is real and the surface heuristic cannot see it.
- **MODEL** — it cannot produce the forms, or cannot self-report them.

The instrument found its own first false positive before any data was
collected: `isCompare` accepted *"the storage tissue lying between the
epidermis and the vascular cylinder"*, because a bare `between … and …` is a
location at least as often as a contrast. The comparative cue is now required.

### 28.4 The real deck is monotonous — E1.1, zero model calls

The 28 stored cards, classified deterministically:

```
question and answer   23   82.1%
definition             6   21.4%
cause and effect       5   17.9%
application            3   10.7%
compare                0
process                0
claimed by nothing     0
claimed by several     9   32.1%
```

So there is a problem in principle. But this corpus is labelled-figure plant
notes, which can only legitimately yield definitions and part/function pairs —
a process card from them would be invented content, which HARD RULE 1 forbids.
**Measuring form variety here measures the notes.** That is what the ceiling
run exists to control for.

### 28.5 The first ceiling run was not a controlled comparison

Arms A1/A2 were served by `gemini-3.5-flash-lite` (rung 4) and arm B by
`gemini-3.8-flash` (rung 3), because availability rotates and `LIGHT_LADDER`
falls through silently. The distance between them measured **the model as much
as the treatment**. It reported "asking for a form moved the output beyond
run-to-run noise" off a B-vs-A of 0.250 against a floor of 0.220 — where the
floor was a *single* A-vs-A pair, which is one sample of a random quantity and
not a floor at all.

Both faults are now refused by the probe: it records the served model, declares
`NOT COMPARABLE` when arms differ, and `NOT DECIDABLE` on fewer than two
within-condition pairs. **Pinning defeats the fallback ladder**, so a pinned run
dies when that rung is busy — `gemini-3.8-flash` was, and the real run used
`gemini-3.5-flash-lite`.

### 28.6 The controlled run — 68 items, one model, three runs per arm

Synthetic notes containing an explicit three-step process, a real comparison
and a causal chain: the model's best case. Six arms on `gemini-3.5-flash-lite`,
2026-09-12. Nothing written to any database.

**Supply is not the problem. 35/35 items carried a form when asked** — spread
across definition 9, cause and effect 8, application 8, compare 5, process 4,
question and answer 1. The model can choose a form and does.

**Asking for a form did not change the cards.** Within-condition distances
(A-A and B-B) ran 0.128–0.353; across-condition (A-B) ran 0.154–0.392. Complete
overlap.

```
=> WITHIN NOISE: asking for a form did not measurably change what came back.
```

The model relabels; it does not rewrite. **That alone is close to decisive: a
control that changes no output is not a control.**

### 28.7 Blind labels — the numbers that decide it

All 68 items were labelled from `items.jsonl`, which carries no claim and no
rule output, before `claims.jsonl` was opened.

```
carried several forms  15/68   22%
carried none            0/68    0%

human labels: cause and effect 36 · application 18 · question and answer 12
              compare 10 · definition 6 · process 1
```

| form | coverage | true-form | non-form | verdict |
|---|---|---|---|---|
| definition | 33% (6) | 50% | 2% | **UNMEASURED** — under the 10-item floor |
| question and answer | 100% (12) | — | **32%** | fails NON-FORM |
| compare | 70% (10) | 60% | 0% | fails COVERAGE |
| process | 0% (1) | — | 0% | **UNMEASURED** — under the floor |
| cause and effect | 67% (36) | 50% | 0% | fails COVERAGE |
| application | **11%** (18) | 13% | 2% | fails COVERAGE |

**Every measured rule fails, and all but one fail on COVERAGE, not on false
alarms.** Non-form acceptance is 0–2% almost everywhere. The heuristics are
precise and blind — `application` recognises 2 of 18 legitimate examples. This
is exactly the failure a precision-only gate would have hidden, which is why
coverage was added as a first-class metric.

**Model self-report: 23/35 (66%) agreed with a human label.** Its errors are
structured, not random:

```
 5  claimed definition       -> humans said question and answer
 4  claimed process          -> humans said cause and effect
 2  claimed definition       -> humans said cause and effect
 1  claimed question and answer -> humans said definition
```

**Intervention rate 71%** (25/35). Relabelling seven claims in ten, on rules
measured to be blind, is not a validator — it is noise with a schema.

### 28.8 What each hypothesis did

- **H1 — `question and answer` is a catch-all.** *Supported, not proven.* Its
  rule was written to yield to the structural forms and still accepted 32% of
  items that were not it, the worst non-form rate measured. But humans used it
  for a coherent 12 items, so the LABEL is real even where the rule over-fires.
- **H2 — `application` is redundant with `level: apply`.** **Confirmed, 97%.**
  All 18 items labelled `application` were `level: apply`; only 2 apply-tier
  items were not. **The `level` dimension the app already has captures
  essentially every application-labelled item**, and it is already exclusive
  and already carries counts on the level buttons. Separately, HARD RULE 1
  forbids outside knowledge, which makes genuine transfer to a new case hard
  even to *define* from source-grounded material: under a strict reading —
  transfer to a case the notes do not already state — all 18 collapse to recall
  or causal inference wearing scenario dressing, and the count is **0**. One
  definitional choice moves the label by 26% of the corpus. **No separate
  application form is to be built.**
- **H3 — `definition` and `question and answer` are not separable.** *Refuted
  for humans, confirmed for the model.* The blind labelling separated them
  without hesitation (6 vs 12, no ambiguity marked); the model confused them in
  6 of its 12 errors.

**On `process`, narrowly stated.** One human label in 68, from notes containing
an explicit *first / then / finally* sequence, and all four of the model's
`process` claims were wrong. What this supports is that **process cards are
poorly supported and poorly distinguishable under the current one-question,
one-short-answer format** — not that process questions are inherently
impossible. A format that allowed a multi-step answer was never tested and is
not ruled out by anything measured here.

### 28.9 The dead `Allowed forms:` line, checked then removed

The line had never had a field to answer it, but removing text from a prompt
can move output, so it was measured before deletion rather than after. Six runs
on one pinned model (`gemini-3.5-flash-lite`, 2026-09-12), line present vs line
removed, everything else identical.

The instrument is deliberately **not** this phase's own classifiers — E1.4
measured them as precise but blind, and an instrument that fails its own
coverage gate is a poor way to detect a change. `kind`, `level` and item count
come straight from the model:

```
items per run      L 11.7          N 11.3
kind               total variation 0.015
level              total variation 0.020
label distribution within 0.093-0.280 · across 0.121-0.455  (overlapping)
```

**No measurable regression.** The line is removed from `buildGeneratePrompt`,
along with the now-unused `allowedForms` parameter and the `ALLOWED_FORMS`
export it fed. The vocabulary's single home is now `CANDIDATE_FORMS` in
`src/core/form.ts`, on no code path. `tests/form.test.ts` pins both the list
and the absence of the instruction, and the second guard was mutation-tested by
writing the line back.

The probe's `--inert` mode will now correctly refuse to run — it asserts the
line is present before stripping it, and it is gone. That is the guard working,
and the mode is kept as the record of how the check was made.

### 28.10 Conclusion

> **The six-form taxonomy remains potentially useful as a descriptive
> vocabulary, but the current generation pipeline does not demonstrate
> meaningful controllability by form, and the tested deterministic validators
> are insufficient for enforcement. Therefore question-type enforcement does
> not ship and is deferred.**

E1 found **two independent problems**, and the order matters:

1. **Requesting a form does not produce materially different card content.**
   Across-condition distances sat inside the within-condition range. The model
   relabels; it does not rewrite. **This is the primary product conclusion, and
   a better validator would not touch it** — there is no demonstrated control
   to enforce.
2. The deterministic validators have poor coverage despite low false
   acceptance. Precise and blind.

Characterising the result as "the rules failed on a fixable axis" would be
wrong: fixing the rules addresses only the second problem.

**What is decided:**

- Question-type enforcement does not ship. Deferred.
- `study_items.form` is not restored. No migration 0016.
- No validators on the production path. No E2.
- No separate `application` form — `level: apply` already captures it.
- `compare` (70% coverage / 0% non-form) and `cause and effect` (67% / 0%)
  are kept as **future candidates only**, not implemented.
- **If this is ever revisited, the first experiment must test whether
  generation can be made materially different by form — before any validator
  is designed.** Designing validators first is what this phase did, and the
  controllability question turned out to sit upstream of all of it.

### 28.11 What this did not establish

- **Not a statistically powered study.** 68 items, ~10 per class at the floor,
  one rater. The gates are engineering thresholds for a build decision, not
  confidence claims.
- **Single rater, no true cold re-label.** The strict/loose split on
  `application` (18 vs 0) is reported as the honest measure of label
  instability instead of a fabricated re-labelling pass.
- **E1.3 against real notes was never run, and was not justified.** E1.2
  answered the feasibility question: forms were supplied 35/35 and still moved
  nothing beyond run-to-run noise. A second corpus changes which *content* is
  available, not whether requesting a form controls generation — the finding
  that decided the phase. Spending real notes and quota on it would have
  refined a measurement that had already stopped being the question.
- **The planned separate `level`-only arm was not run.** H2 was answered from
  the level field already on every generated item — 97% — which is the same
  question answered with data in hand rather than another six model calls.
- Nothing was checked by eye; there is no UI in this phase.

### 28.12 The record, in one place

```
supply                35/35 items carried a form when asked        (100%)
model self-report     23/35 agreed with a blind human label         (66%)
controllability       within-condition 0.128-0.353
                      across-condition 0.154-0.392   -> overlapping
validator coverage    q&a 100% · compare 70% · cause 67% · application 11%
                      definition 33% (n=6) · process 0% (n=1)  -> both UNMEASURED
non-form acceptance   q&a 32% · compare 0% · cause 0% · application 2% · definition 2%
intervention rate     25/35 claims the rules would relabel          (71%)
taxonomy              several forms 15/68 (22%) · no form 0/68 (0%)
application vs level  18/18 application items were level: apply     (97% agreement)
process               1/68 human labels; all 4 model claims wrong
inert-line removal    kind TV 0.015 · level TV 0.020 -> no regression
```

**Two probe mistakes, both corrected.** The first ceiling run compared arms
served by *different models* (§28.5) and called a 0.250-vs-0.220 gap an effect
when the floor was a single sample. The probe now records the served model,
reports `NOT COMPARABLE` when arms differ, and `NOT DECIDABLE` on fewer than
two within-condition pairs. The `stripFormsLine` mutation likewise throws
rather than silently matching nothing, because a no-op there would have
manufactured the "no regression" result it was run to test.

**Verified:** typecheck clean · **584 tests** (556 before; +28) · `expo export`
· boot **6/6** against a fresh bundle · all five new guards mutation-tested and
the sources confirmed restored by checksum, each backup verified non-empty
*before* its mutation (§27.5) · 68 items generated on one pinned model and
labelled blind, plus 69 more for the inert-line control · **no database writes
and nothing to clean up** · migration 0015 confirmed applied and §26.5/§27.5
corrected. **Phase E closed. Nothing shipped beyond the prompt cleanup. Not
deployed. No restore drill.**


## 29. Phase G1 — the first restore, and three ways the backup was broken (2026-09-12)

The monthly backup shipped, was hardened twice, and had **never been restored**.
This is that drill. It found the backup broken in three independent ways, two
of which had nothing to do with restoring and would have been invisible until
the day they mattered.

Nothing here was predicted correctly in advance. The plan expected `auth.users`
to be absent from the dump; it is present. The plan expected the drill's
difficulty to be the restore; the restore of application data was flawless and
everything around it failed.

### 29.1 The backup had been failing silently since Phase A

Run #3 (manually triggered, 2026-09-12) failed. The dump step succeeded and
**"Check the dump is not empty" exited 1 with no `::error::` line at all** —
which is what identified it, because every deliberate failure in that step
prints one.

`grep` exits 1 when it matches nothing. There is no `drop table` in any
migration, so under `set -euo pipefail`:

```
dropped=$(grep -hoiE 'drop table...' supabase/migrations/*.sql | ... )   <- exit 1
```

killed the step before a single table was checked. Reproduced locally, exactly.

Three things make this worse than a one-line bug:

- **It shipped with §23.6's own fix.** That section replaced a hand-kept table
  list — "a rule that depends on remembering has now failed on every occasion
  it was tested" — with a derivation. The derivation is correct. It was never
  executed: `backup.yml` runs on cron and dispatch only, **never in CI**, and
  the monthly cron had not fired since Phase A landed on the 11th. Run #3 was
  the first execution of that code, six commits later.
- **The empty-list guard was unreachable.** §23.6 added `if [ -z "$tables" ]`
  precisely to catch a broken derivation, with the comment "the same
  silent-success failure in a new costume". `set -e` aborts twelve lines above
  it, so it could never fire.
- **Run #2 (2026-09-07) passing proved nothing about it**, because 7218329
  predates the derivation and still used the hardcoded list.

Fixed with `|| true` on all three derivations, so "matched nothing" and "the
tool broke" stop being the same exit code. Verified by extracting the **real
step out of the YAML** and running it over four fixtures:

| fixture | expected | got |
|---|---|---|
| current repo, complete dump | pass | exit 0 |
| dump missing `notes` | fail, naming it | exit 1, `::error::…no CREATE TABLE for notes` |
| a migration that drops a table | excluded, pass | exit 0, 10 tables |
| no DDL at all | the explicit broken-check error | exit 1, **now reachable** |

Mutation-tested: with the `|| true` removed from the `dropped=` line alone, the
passing fixture exits 1 — run #3 reproduced. Run #4 is green.

### 29.2 The passphrase was gone

`BACKUP_PASSPHRASE` could not be found anywhere: all 40 Claude Code transcripts
(the variable name appears in prose, never a value), `.env`, 2,106 lines of
PowerShell history, the whole of `c:\paul`, Desktop/Documents/Downloads/
OneDrive, and Windows Credential Manager. GitHub Secrets is write-only by
design and will not show it back.

So on the day the backup was first needed, **every retained artifact was
undecryptable**. `backup.yml:23` says the passphrase must be *"a long random
string, stored somewhere you will still have it the day you need to restore"*.
That instruction was the entire safeguard, and it depended on remembering —
the exact failure mode §23.6 removed from the table list eighty lines below it
in the same file.

**Rotated 2026-09-12.** A new 44-character value generated, written to `.env`
(gitignored) and to a password manager, and set in GitHub Secrets. The Sep 7
artifact is permanently unreadable and was written off: that costs nothing
while the live database is intact, which is exactly why rotating was cheap
now and would not have been later.

Worth stating as a design fact rather than an accident: **the encryption key
has one copy, in a store that cannot be read back, and no technical check can
verify that a human still holds it.** Only a periodic drill can.

### 29.3 The artifacts were sitting in the public repository

The downloaded `.zip` and `backup.tar.gz.gpg` had been unzipped into the
repository root — untracked, unignored, one `git add -A` from publishing every
student's notes to a public repo. Encrypted, but an encrypted file in a public
repo is one passphrase away from not being.

Moved out, and `.gitignore` now matches `*.gpg`, `backup.tar.gz*`,
`schema.sql`, `data.sql` and `supabase-backup-*` **wherever they land** rather
than only under `backups/`. Verified no tracked file matches the new patterns
and that `supabase/migrations/0001_schema.sql` is still not ignored.

### 29.4 The restore itself — R1 to R6 answered

Against the run #4 artifact (151,188 bytes), into PostgreSQL 17.11 on a local
scratch database. Every answer measured, none inferred.

```
R1  YES  decrypts and extracts to schema.sql + data.sql
R2  NO   schema.sql applies with 12 errors into vanilla Postgres
R3  YES  APPLICATION data: 11/11 public tables match the dump exactly
R4  NO   auth.users has 7 rows in the dump and NO DDL anywhere
R5  YES  40 policies, RLS enabled on all 11 tables
R6  NO   storage.objects is metadata; the file bytes are not in a db dump
R7  --   DEFERRED: needs Docker; C: has 6.2 GB free of 476 GB
```

**The application's own data restored perfectly.** 11 tables, the `item_stats`
view, 5 functions, 40 policies, RLS on every table, 29 indexes, 9 foreign keys,
and 632 rows — `attempts` 312, `study_items` 167, `review_state` 64,
`document_pages` 42, `study_sets` 9, `documents` 9, `heartbeat` 12,
`profiles` 7, `study_days` 6, `chat_usage` 3, `notes` 1 — every count matching
the dump.

### 29.5 The central finding: the dump is public-only, the data is not

```
schema.sql   1,150 lines   schemas present: public          ONLY
data.sql     1,835 lines   COPY blocks for public, auth AND storage
```

`supabase db dump` emits **public-only DDL**, while `--data-only` emits data
for `auth` and `storage` too. So the backup carries the accounts but not the
tables to hold them:

```
auth.users            7 rows in the dump  ->  0 restored
auth.identities       7                   ->  0
auth.sessions       252                   ->  0
auth.refresh_tokens 310                   ->  0
auth.mfa_amr_claims 252                   ->  0
storage.objects      10                   ->  0
storage.buckets       1                   ->  0
                                              839 rows lost
```

Zero `CREATE TABLE`/`CREATE SCHEMA` statements for `auth` or `storage` appear
in the dump. This is more dangerous than a plain omission: a check asking "are
the users in the backup?" answers **yes**, and a restore into anything that is
not already a provisioned Supabase project silently drops all seven accounts
and every session.

**And one application object is lost even on a correct target.** Migration 0001
creates `on_auth_user_created`, an `after insert on auth.users` trigger calling
`public.handle_new_user()` — the thing that gives a new signup a `profiles`
row. `handle_new_user` **is** in the dump; the trigger is **not**, because
pg_dump emits a trigger with its table and `auth.users` is not dumped. So even
restoring into a fresh Supabase project yields a database where **new sign-ups
silently get no profile**. Nothing in the app would report this.

### 29.6 What must exist before the dump will load at all

Discovered, not assumed — the errors were the deliverable:

```
roles     anon, authenticated, postgres, service_role
schemas   extensions, auth, storage, graphql_public
function  auth.uid()          <- every one of the 40 policies calls it
```

Without `auth.uid()` the policies fail to create and the restore silently loses
its entire security model. The 12 `schema.sql` errors are all of this kind —
`extension "supabase_vault" is not available`, `publication "supabase_realtime"
does not exist`, and relations in schemas the dump does not define. **None was
a defect in the dump**; all are "the target is not Supabase". Every object the
application owns was created.

### 29.7 The corrected recovery procedure

`backup.yml:46-49` said `psql "$SUPABASE_DB_URL" -f schema.sql && psql … -f
data.sql`. That is wrong twice over: it points at **the live database**, and it
omits every prerequisite in §29.6. Replaced.

**Verified by this drill:** decrypt → extract → prerequisites → `schema.sql` →
`data.sql` restores 100% of application data into a Postgres 17 database.

**Not verified, and labelled as such:** restoring into a fresh Supabase project.
That is the only target where the `auth` rows can land, and it needs R7.

### 29.8 The instrument overclaimed twice, and the drill caught it

Both inspect-stage verdicts were wrong until the restore stage contradicted
them, which is the whole reason the plan ran both:

- **R4 first read "accounts survive a restore"** because the rows were present.
  They did not survive. Presence in `data.sql` is not recoverability.
- **R6 first read "storage rows present"**, which reads as though the uploads
  were safe. They are metadata rows; a database dump cannot contain the bytes.

A third bug was found by rehearsing against a **synthetic** artifact before
real data was touched: the drill counted psql errors from stdout, but **psql
writes errors to stderr** and `ON_ERROR_STOP=0` leaves the exit code at 0. It
reported `R2 YES — 0 errors` while twelve errors printed beside it. On the real
backup that would have certified a broken restore as clean.

And one process failure worth recording: a manual `trap … EXIT` cleanup did not
fire, leaving **decrypted student notes in `%TEMP%`** until a later check found
and deleted them. The drill script's own `finally` block worked correctly every
time; the ad-hoc command beside it did not. Plaintext handling belongs in the
tool, never in a one-off shell line.

### 29.9 What is still open

- **R7 — the app has never run against a restored database.** Needs Docker and
  ~30 GB; the machine has 6.2 GB free.
- **A restore into a real Supabase project is untested**, and it is the only
  target where accounts can land.
- **`on_auth_user_created` would have to be recreated by hand** after any
  restore. Re-running the repo's migrations is the fix, and that is untested
  against a database that already holds restored rows.
- **Uploaded originals are not recoverable at all.** Only page text is, so
  cards survive and their source images do not.

**Verified:** typecheck clean · **601 tests** · `expo export` · boot **6/6** ·
the backup fix mutation-tested against the real workflow file over four
fixtures · 17 new parser tests, five mutations each confirmed to fail · the
drill rehearsed on a synthetic artifact before touching real data · run #4
green · scratch database dropped, decrypted plaintext deleted and verified
gone, `git status` clean. **Backup fixed and passphrase rotated. R7 deferred.
Not deployed.**


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
