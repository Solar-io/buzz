import type { AnalyticsAccountGroup } from "@/shared/api/tauriArchive";

/** The sentinel the archive uses for a dimension nothing reported. */
export const UNKNOWN_DIMENSION = "__unknown__";

/**
 * Text marker for an account whose identity Buzz seeded from observed
 * configuration and the owner has not confirmed.
 *
 * Text, not colour: the page's accessibility rule is that no state is encoded
 * by colour alone, and the same reasoning that makes unreported values read
 * `— Not reported` rather than `0` applies here. A provisional label must never
 * be mistaken for an established subscription identity.
 */
export const SEEDED_MARKER = "seeded — unconfirmed";

/**
 * The label to render for one account row.
 *
 * The unknown bucket is left alone: it has no identity to call provisional, and
 * it already reads `Not reported`. A confirmed account reads as itself.
 */
export function accountRowLabel(row: AnalyticsAccountGroup): string {
  if (row.key === UNKNOWN_DIMENSION || row.confirmed) return row.label;
  return `${row.label} · ${SEEDED_MARKER}`;
}

/**
 * Whether a row is a provisional, seeded account identity — as opposed to a
 * confirmed one, or to the unknown bucket (which claims nothing at all).
 */
export function isProvisionalAccount(row: AnalyticsAccountGroup): boolean {
  return row.key !== UNKNOWN_DIMENSION && !row.confirmed;
}

/** How many reported accounts are still provisional. */
export function provisionalAccountCount(rows: AnalyticsAccountGroup[]): number {
  return rows.filter(isProvisionalAccount).length;
}

/**
 * CSV cell for the owner-confirmation state of one exported row.
 *
 * Only the account dimension has a confirmation state; every other dimension
 * exports an empty cell rather than a misleading `false`.
 */
export function confirmedCsvCell(
  dimension: string,
  row: { confirmed?: boolean; key?: string },
): string {
  if (dimension !== "account") return "";
  if (row.key === UNKNOWN_DIMENSION) return "";
  return row.confirmed ? "confirmed" : SEEDED_MARKER;
}
