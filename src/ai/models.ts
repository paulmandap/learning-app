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
export const MODELS = {
  // Verified live 2026-09-04: flash-lite answers 200 while gemini-3.5-flash was
  // already returning 429 RESOURCE_EXHAUSTED on the same key. Flash-lite has a
  // materially larger free-tier allowance AND lower latency for this workload,
  // so it is the right default for card generation.
  light: 'gemini-3.5-flash-lite',
  // No Pro-class model is reachable on the free tier (see the table above).
  // `strong` stays centralised here for Phase 3 Apply-tier work and written
  // answer grading, and must be re-verified before it is relied on.
  strong: 'gemini-3.5-flash',
} as const;

export type ModelTier = keyof typeof MODELS;

/** Base URL for the Gemini REST API. */
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
