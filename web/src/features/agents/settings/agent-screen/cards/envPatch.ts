import { reservedKeyErrors } from "../../../lib/envRows";

/** Transient blind edits; values never enter drafts, receipts or browser storage. */
export interface EnvPatchRow {
  id: string;
  key: string;
  value: string;
  operation: "set" | "remove";
}

/** Only named edits ride the patch. Other desktop variables are left alone. */
export function buildEnvPatch(
  rows: readonly EnvPatchRow[],
): { error: string } | { patch: Record<string, string | null> } {
  if (rows.some((row) => !row.key.trim()))
    return { error: "Enter a variable name for every row." };
  const normalized = rows.map((row) => ({ ...row, key: row.key.trim() }));
  const errors = reservedKeyErrors(normalized);
  if (errors.length) return { error: errors[0] };
  if (normalized.some((row) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(row.key)))
    return { error: "Variable names use letters, numbers and underscores." };
  if (new Set(normalized.map((row) => row.key)).size !== normalized.length)
    return { error: "Use one row per variable." };
  return {
    patch: Object.fromEntries(
      normalized.map((row) => [
        row.key,
        row.operation === "remove" ? null : row.value,
      ]),
    ) as Record<string, string | null>,
  };
}
