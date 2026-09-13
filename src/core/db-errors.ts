/**
 * What a database error means, decided once.
 *
 * Pure: it reads an error's `code` and nothing else.
 *
 * ## One missing column, two codes (NOTES §37)
 *
 * A column the database has not got is reported differently depending on
 * WHERE the query names it:
 *
 *   - a SELECT that names it reaches Postgres, which answers `42703`;
 *   - an INSERT, UPDATE or UPSERT body that names it is rejected by PostgREST
 *     against its schema cache before Postgres sees it, as `PGRST204`.
 *
 * The app checked for `42703` only. So before migration 0016, choosing a face
 * (an upsert) failed with a code nothing recognised and said "Couldn't save
 * that picture just now. Try again in a moment" — which no amount of waiting
 * could fix — and Delete my data, which clears the same column in an update,
 * failed at its last step. §19.4 recorded the same trap for tables
 * (`PGRST205`, not `42P01`); this is it again for columns.
 */

type WithCode = { code?: string | null } | null | undefined;

export const MISSING_COLUMN_CODES: readonly string[] = ['42703', 'PGRST204'];
export const MISSING_TABLE_CODES: readonly string[] = ['42P01', 'PGRST205'];

export function isMissingColumn(error: WithCode): boolean {
  return !!error && MISSING_COLUMN_CODES.includes(error.code ?? '');
}

export function isMissingTable(error: WithCode): boolean {
  return !!error && MISSING_TABLE_CODES.includes(error.code ?? '');
}
