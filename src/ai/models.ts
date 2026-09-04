/**
 * The only place model IDs appear. Nothing else in the codebase hardcodes one.
 *
 * ############################################################################
 * # models.list IS NOT A LIST OF MODELS YOU CAN USE.                          #
 * #                                                                           #
 * # Probed live on 2026-09-03 with a real free-tier key. models.list          #
 * # advertised all of these; generateContent told a different story:          #
 * #                                                                           #
 * #   gemini-3.5-flash        200  (4.5s)   <- light                          #
 * #   gemini-3.5-flash-lite   200  (7.0s)                                     #
 * #   gemini-3.8-flash        503  UNAVAILABLE (overloaded)                   #
 * #   gemini-3.6-flash        503  UNAVAILABLE (overloaded)                   #
 * #   gemini-2.5-flash        404  NOT_FOUND                                  #
 * #   gemini-2.5-flash-lite   404  NOT_FOUND                                  #
 * #   gemini-2.5-pro          404  NOT_FOUND                                  #
 * #   gemini-pro-latest       429  RESOURCE_EXHAUSTED                         #
 * #                                                                           #
 * # So "Test connection" passing proves the KEY works, not that any given     #
 * # model will serve a request. Newest is not safest: the two newest Flash    #
 * # models were the overloaded ones. Verify with generateContent, not         #
 * # models.list, before changing anything here.                               #
 * ############################################################################
 *
 *  - light  — default for everything. Newest stable Flash-class model, free tier.
 *  - strong — Apply-tier generation only (Phase 3+). `gemini-2.5-pro` is the ONLY
 *             stable Pro-class model on the free tier, so there is no free fallback
 *             behind it. This is why D11 routes almost everything to `light`.
 *
 * Deliberately NOT using the floating aliases `gemini-flash-latest` /
 * `gemini-pro-latest`, which the live list also offers: a moving target would
 * change generation behaviour underneath us with no code change and no way to
 * reproduce a past result. Pin explicitly; bump deliberately.
 *
 * Never use: gemini-2.0-flash / gemini-2.0-flash-lite (shut down), or any
 * *-preview model (more restrictive rate limits, unapproved).
 */
/*
 * AVAILABILITY ROTATES. The table above is a snapshot, and it aged.
 *
 * Re-swept live 2026-09-04 (later the same day), one real generateContent call
 * per model, sorted by latency:
 *
 *   gemini-3.6-flash        200   2.5s   <- light (was 503 in the table above)
 *   gemini-3.8-flash        200   7.8s          (was 503 in the table above)
 *   gemini-3.5-flash        200  10.4s   <- strong, now verified serving
 *   gemini-3.7-flash        200  10.8s
 *   gemini-3.5-flash-lite   503   6.4s          (was the light default)
 *   gemini-3.1-flash-lite   503   7.0s
 *   gemini-2.5-*            404          (still gone)
 *   gemini-pro-latest       429
 *
 * The two models previously recorded as permanently overloaded were the healthy
 * ones, and the pinned default was the sick one. So a single pinned id is
 * fragile against Google's rotating load shedding: when it sheds, the app has no
 * second option and the user simply cannot make cards. A fallback ladder would
 * fix that, but D11 specifies exactly two ids — flagged for a decision, not
 * changed here.
 *
 * Also observed in the same window: a one-token request ("Reply with the single
 * word: ok") returned 503, then 200 after 88.3s, then 503. Latency during a
 * shedding window is Google-side queueing and says nothing about payload size.
 */
export const MODELS = {
  // Switched from gemini-3.5-flash-lite on 2026-09-04 after it began answering
  // 503 UNAVAILABLE persistently — three read attempts across 30s of backoff all
  // failed, which is a user who cannot make cards at all. gemini-3.6-flash was
  // the fastest STABLE model serving in the sweep above at 2.5s.
  //
  // Reversible on purpose: if flash-lite recovers and 3.6 degrades, swap back.
  // Re-sweep before assuming either is healthy — that is the whole lesson here.
  light: 'gemini-3.6-flash',
  // No Pro-class model is reachable on the free tier (see the table above).
  // `strong` stays centralised here for Phase 3 Apply-tier work and written
  // answer grading. Verified serving 2026-09-04 at 10.4s, but never yet
  // exercised on a real generation, so it remains unproven for that workload.
  strong: 'gemini-3.5-flash',
} as const;

export type ModelTier = keyof typeof MODELS;

/** Base URL for the Gemini REST API. */
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
