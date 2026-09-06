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
 * **Set by storage, and that is a reversal.** This file used to say the reader
 * was the binding constraint — `MAX_INLINE_BYTES` was 15 MB, so a bigger file
 * could be stored but never turned into cards. Measured 2026-09-06 (NOTES
 * §15.2) and it was not true: a 44.8 MB scan read completely in 19.9 s. The
 * reader's ceiling is now 45 MB, and the limit that actually binds is the one
 * this project has always had least of — Supabase Free's 1 GB, shared.
 *
 * 25 MB, not 45. The arithmetic is the argument: at 45 MB a student fills their
 * 150 MB allowance with three files, and every ladder fallback re-uploads the
 * whole thing — on a phone, from a café. At 25 MB a 20 MB scanned PDF still
 * goes through, which is the case this was raised for.
 *
 * The two constants must still move together, and a test pins that.
 */
export const MAX_FILE_BYTES = 25 * MB;

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
        // Not "the most we can read": the reader handles far more than this
        // (NOTES §15.2). Saying so would be a lie a student cannot check, and
        // the next person to raise the cap would believe it.
        `That file is ${formatBytes(input.fileBytes)}, and the biggest we can take is ` +
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
