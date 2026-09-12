import { supabase, type Db } from './supabase';
import { listSets } from './sets';
import { emptyNomiContext, type NomiContext } from '../core/nomi';

/**
 * Nomi's orchestration boundary: what Nomi is allowed to know, assembled once.
 *
 * ## Why this module exists at all, this early
 *
 * The architectural goal is that Nomi becomes an interface OVER the app's
 * structured learning state, rather than a chatbot that happens to sit next to
 * it. The difference shows up as a layer, not as a feature:
 *
 *     Nomi UI  →  this module  →  existing src/data functions  →  Supabase
 *
 * Without the middle step, the first screen that needs a due count reaches for
 * the database itself, the second one reaches slightly differently, and by the
 * third there is no boundary left to put the learning intelligence behind. The
 * layer is cheap now and expensive to retrofit.
 *
 * ## No Supabase import here, deliberately
 *
 * This file composes other `src/data` functions and calls none of the database
 * directly — the same rule `src/data/pipeline.ts` keeps, and for the same
 * reason: an orchestrator that does its own queries stops being an orchestrator
 * and becomes a second data layer. The `db` it takes is only passed through.
 *
 * ## One query, and nothing speculative
 *
 * Only `listSets`. Everything else Nomi will eventually want — what is due,
 * which sections are weak, whether accuracy is improving — needs Phase C and
 * Phase D to exist before it can be answered truthfully, and a number invented
 * to fill a field is exactly the failure a study companion cannot afford. See
 * `src/core/nomi.ts` for the list and why it is still a list.
 *
 * Note that nothing in the UI calls this yet, and that is the point rather than
 * an oversight: opening Nomi's screen costs no round trip. This is the seam
 * Phase C wires up when it has something true to say.
 *
 * Degrades rather than throws, matching `review.ts` and `dashboard.ts`: a
 * companion that cannot list your sets should say it knows of none, not take
 * the screen down.
 */
export async function getNomiContext(db: Db = supabase): Promise<NomiContext> {
  try {
    const sets = await listSets(db);
    return {
      sets: sets.map((s) => ({ id: s.id, title: s.title, cardCount: s.cardCount })),
    };
  } catch (err) {
    // Loud, not silent. This project has paid four times for a failure that
    // left no trace, and "Nomi knows nothing about you" is indistinguishable
    // from a new account unless the reason is written down somewhere.
    console.warn(
      `[nomi] could not read study sets: ${err instanceof Error ? err.message : String(err)}`,
    );
    // A FRESH empty context every time — see emptyNomiContext, and the bug
    // §24.4 records against handing out EMPTY_DASHBOARD by reference.
    return emptyNomiContext();
  }
}
