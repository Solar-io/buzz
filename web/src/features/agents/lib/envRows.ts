/**
 * Env-table model for the agent create/edit forms — the web counterpart of
 * the desktop's `EnvVarsEditor` row projection
 * (desktop/src/features/agents/ui/EnvVarsEditor.tsx). Kept as a deliberate
 * copy: the two packages do not share source.
 *
 * Conversion mirrors the desktop's `toRecord` exactly: rows with an empty
 * key are skipped (mid-edit safety) and duplicate keys resolve LAST-ROW-WINS
 * (matches Command::env semantics). The key list below mirrors
 * `desktop/src-tauri/src/managed_agents/reserved_env_keys.rs` — keys Buzz
 * sets itself; the desktop applier rejects them, so the web validates first
 * for clearer errors.
 */

/** One editable KEY/VALUE row. `id` is a stable React key, never serialized. */
export interface EnvRow {
  id: string;
  key: string;
  value: string;
}

/** Fresh row id (crypto when available, counter fallback for older targets). */
export function newEnvRowId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `env-${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

/**
 * Collapse rows to a record: empty keys are skipped, duplicate keys resolve
 * last-row-wins. Deliberate mirror of the desktop's `toRecord`.
 */
export function envRowsToRecord(
  rows: readonly EnvRow[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.length > 0) {
      out[row.key] = row.value;
    }
  }
  return out;
}

/**
 * Ids of rows whose non-empty key is overridden by a LATER row with the same
 * key — the rows the last-row-wins conversion will discard. Powers the
 * "duplicate — last row wins" hint in the table so the semantics are visible
 * before saving, not just pinned in tests.
 */
export function duplicateKeyRowIds(rows: readonly EnvRow[]): Set<string> {
  const lastIdByKey = new Map<string, string>();
  for (const row of rows) {
    if (row.key.length > 0) {
      lastIdByKey.set(row.key, row.id);
    }
  }
  const shadowed = new Set<string>();
  for (const row of rows) {
    if (row.key.length > 0 && lastIdByKey.get(row.key) !== row.id) {
      shadowed.add(row.id);
    }
  }
  return shadowed;
}

/**
 * Env keys Buzz sets itself and the owner must not override. Deliberate
 * mirror of `desktop/src-tauri/src/managed_agents/reserved_env_keys.rs`
 * (`RESERVED_ENV_KEYS`, 22 keys) — updating either list is a deliberate,
 * two-sided act. Matching is case-insensitive on both sides.
 */
export const RESERVED_ENV_KEYS: readonly string[] = [
  // Identity / secrets.
  "BUZZ_PRIVATE_KEY",
  "NOSTR_PRIVATE_KEY",
  "BUZZ_AUTH_TAG",
  "BUZZ_API_TOKEN",
  "BUZZ_ACP_PRIVATE_KEY",
  "BUZZ_ACP_API_TOKEN",
  // Relay URL: an override could redirect the agent to another relay.
  "BUZZ_RELAY_URL",
  // Code-execution surface (agent binary/args).
  "BUZZ_ACP_AGENT_COMMAND",
  "BUZZ_ACP_AGENT_ARGS",
  "BUZZ_ACP_MCP_COMMAND",
  // Control-plane parallelism (harness caps).
  "BUZZ_ACP_AGENTS",
  // Security gates: respond-to mode + allowlist + ownership.
  "BUZZ_ACP_RESPOND_TO",
  "BUZZ_ACP_RESPOND_TO_ALLOWLIST",
  "BUZZ_ACP_ALLOWED_RESPOND_TO",
  "BUZZ_ACP_AGENT_OWNER",
  // Stable agent identity (git attribution / provenance).
  "BUZZ_ACP_DISPLAY_NAME",
  // Remote lifetime / presence policy.
  "BUZZ_ACP_EXIT_AFTER_INACTIVITY",
  "BUZZ_ACP_IDLE_POOL_SLEEP",
  "BUZZ_ACP_NO_PRESENCE",
  // Readiness handoff.
  "BUZZ_ACP_SETUP_PAYLOAD",
  // Desktop ownership markers.
  "BUZZ_MANAGED_AGENT",
  "BUZZ_MANAGED_AGENT_START_NONCE",
];

/** Case-insensitive reserved-key test (mirrors `is_reserved_env_keys.rs`). */
export function isReservedEnvKey(key: string): boolean {
  return RESERVED_ENV_KEYS.some(
    (reserved) => reserved.toLowerCase() === key.toLowerCase(),
  );
}

/** The canonical (uppercase) form of the reserved key `key` matches, if any. */
function canonicalReservedKey(key: string): string | null {
  for (const reserved of RESERVED_ENV_KEYS) {
    if (reserved.toLowerCase() === key.toLowerCase()) {
      return reserved;
    }
  }
  return null;
}

/**
 * One error string per distinct offending reserved key, in first-seen row
 * order — the form toasts these before anything is sent.
 */
export function reservedKeyErrors(rows: readonly EnvRow[]): string[] {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const row of rows) {
    if (row.key.length === 0) {
      continue;
    }
    const canonical = canonicalReservedKey(row.key);
    if (canonical !== null && !seen.has(canonical)) {
      seen.add(canonical);
      errors.push(`${canonical} is set by Buzz and can't be overridden.`);
    }
  }
  return errors;
}
