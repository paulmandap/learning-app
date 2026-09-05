/**
 * Storage budgeting (Phase 9b).
 *
 * Pure and deterministic. Decides whether a file may be uploaded, and turns
 * byte counts into words a student can read.
 *
 * ## Why a limit exists at all
 *
 * Supabase Free gives **1 GB of file storage** for the whole project, shared by
 * every user (`ARCHITECTURE_NOTES.md` §2.5). A scanned PDF is easily 20–50 MB,
 * so a handful of uploads from a handful of people fills it — and the failure
 * mode without a limit is the worst kind: the bucket fills, and the NEXT person
 * to add notes gets an error caused by somebody else.
 *
 * So the check happens **before** the upload starts. Refusing a file costs one
 * clear message; discovering the ceiling afterwards costs everyone.
 */

const MB = 1024 * 1024;

/**
 * Largest file that may be uploaded.
 *
 * **Set by the reader, not by storage.** `MAX_INLINE_BYTES` in
 * `src/ai/gemini.ts` caps an inline Gemini request at 15 MB, and
 * `readDocument` throws above it — so a 40 MB PDF cannot be turned into cards
 * at all, whatever the bucket has room for. Accepting a file the app cannot
 * read would mean spending storage to store something useless and then failing
 * anyway, one step later and less clearly.
 *
 * This is why the owner's suggested 25–50 MB per file is not the binding
 * constraint: the app's own ceiling is lower. If the Files API path is ever
 * built (§3.2.1 allows it above the inline threshold), this can rise with it —
 * but the two must move together.
 */
export const MAX_FILE_BYTES = 15 * MB;

/**
 * Largest total a single user may keep.
 *
 * 150 MB, from the owner's 150–200 MB range, taking the lower end deliberately:
 * five users at 200 MB is exactly the 1 GB the whole project has, leaving no
 * headroom for a sixth person or for the storage a delete has not yet reclaimed.
 * At 150 MB, five users reach 750 MB and the project keeps a quarter of its
 * space spare.
 *
 * Worth knowing when this is revisited: freeing space does NOT have to mean
 * deleting cards. `freeUpSpace` in `src/data/documents.ts` removes only the
 * original file, keeping every card, answer and schedule — see the note there.
 */
export const MAX_USER_BYTES = 150 * MB;

/** Above this fraction of the allowance, the dashboard starts mentioning it. */
export const USAGE_NUDGE_FRACTION = 0.8;

export type UploadRefusal = 'file_too_large' | 'not_enough_room';

export type UploadCheck = { ok: true } | { ok: false; reason: UploadRefusal; message: string };

/**
 * May this file be uploaded?
 *
 * Both limits are checked before anything is sent, and the message is written
 * for a student rather than a developer — no byte counts, no jargon, and it
 * says what to do rather than only what went wrong.
 */
export function checkUpload(input: { fileBytes: number; usedBytes: number }): UploadCheck {
  if (input.fileBytes > MAX_FILE_BYTES) {
    return {
      ok: false,
      reason: 'file_too_large',
      message:
        `That file is ${formatBytes(input.fileBytes)}, and the most we can read in one go is ` +
        `${formatBytes(MAX_FILE_BYTES)}. Try splitting it into a few smaller files, or ` +
        `exporting it at a lower quality.`,
    };
  }

  if (input.usedBytes + input.fileBytes > MAX_USER_BYTES) {
    const free = Math.max(0, MAX_USER_BYTES - input.usedBytes);
    return {
      ok: false,
      reason: 'not_enough_room',
      message:
        `You have ${formatBytes(free)} of space left and that file is ` +
        `${formatBytes(input.fileBytes)}. You can free some up on a set you've finished with — ` +
        `your cards and your progress are kept, only the original file goes.`,
    };
  }

  return { ok: true };
}

/**
 * Bytes as a person would say them.
 *
 * One decimal below 10 MB and none above, because "9.4 MB" is worth knowing and
 * "23.7 MB" is just noise next to "24 MB".
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} bytes`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / MB;
  if (mb < 10) return `${Math.round(mb * 10) / 10} MB`;
  return `${Math.round(mb)} MB`;
}

export interface UsageSummary {
  usedBytes: number;
  /** 0..1 of the per-user allowance. Clamped, so a legacy overshoot still renders. */
  fraction: number;
  /** True once it is worth mentioning at all. */
  worthMentioning: boolean;
}

/**
 * How full a user's allowance is.
 *
 * `worthMentioning` is what keeps this off the screen most of the time. The
 * owner was explicit — *"don't show upfront everytime regarding their limit"* —
 * so the dashboard stays quiet below the nudge point and only speaks when the
 * number is about to matter.
 */
export function summariseUsage(usedBytes: number): UsageSummary {
  const fraction = Math.min(1, Math.max(0, usedBytes / MAX_USER_BYTES));
  return {
    usedBytes,
    fraction,
    worthMentioning: fraction >= USAGE_NUDGE_FRACTION,
  };
}
