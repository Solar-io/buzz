import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESERVED_ENV_KEYS,
  duplicateKeyRowIds,
  envRowsToRecord,
  isReservedEnvKey,
  reservedKeyErrors,
} from "./envRows.ts";

function row(key, value) {
  return { id: `id-${key || "blank"}-${value}`, key, value };
}

test("envRowsToRecord skips empty-key rows and keeps the rest", () => {
  const record = envRowsToRecord([row("A", "1"), row("", "x"), row("B", "2")]);
  assert.deepEqual(record, { A: "1", B: "2" });
});

test("envRowsToRecord duplicate keys resolve LAST row wins", () => {
  const record = envRowsToRecord([row("A", "1"), row("A", "2")]);
  assert.deepEqual(record, { A: "2" });
});

test("envRowsToRecord keeps values verbatim (no trimming, empty values allowed)", () => {
  const record = envRowsToRecord([
    row(" SPACES ", "  kept  "),
    row("EMPTY", ""),
  ]);
  assert.deepEqual(record, { " SPACES ": "  kept  ", EMPTY: "" });
});

test("duplicateKeyRowIds marks only the EARLIER row of each duplicate key", () => {
  // row() derives ids from key+value, so same-key rows get distinct ids.
  const shadowed = duplicateKeyRowIds([
    row("A", "first"),
    row("B", "only"),
    row("A", "second"),
    row("A", "third"),
    row("", "empty key ignored"),
  ]);
  // The LAST of each key wins; every earlier duplicate is shadowed.
  assert.deepEqual(Array.from(shadowed), ["id-A-first", "id-A-second"]);
});

test("duplicateKeyRowIds is empty with no duplicates", () => {
  assert.deepEqual(
    Array.from(duplicateKeyRowIds([row("A", "1"), row("B", "2")])),
    [],
  );
  assert.deepEqual(Array.from(duplicateKeyRowIds([])), []);
});

test("reserved-key mirror pins the exact 22-key desktop list", () => {
  // Hardcoded against reserved_env_keys.rs — updating either list must be a
  // deliberate act that fails this test.
  assert.deepEqual(RESERVED_ENV_KEYS, [
    "BUZZ_PRIVATE_KEY",
    "NOSTR_PRIVATE_KEY",
    "BUZZ_AUTH_TAG",
    "BUZZ_API_TOKEN",
    "BUZZ_ACP_PRIVATE_KEY",
    "BUZZ_ACP_API_TOKEN",
    "BUZZ_RELAY_URL",
    "BUZZ_ACP_AGENT_COMMAND",
    "BUZZ_ACP_AGENT_ARGS",
    "BUZZ_ACP_MCP_COMMAND",
    "BUZZ_ACP_AGENTS",
    "BUZZ_ACP_RESPOND_TO",
    "BUZZ_ACP_RESPOND_TO_ALLOWLIST",
    "BUZZ_ACP_ALLOWED_RESPOND_TO",
    "BUZZ_ACP_AGENT_OWNER",
    "BUZZ_ACP_DISPLAY_NAME",
    "BUZZ_ACP_EXIT_AFTER_INACTIVITY",
    "BUZZ_ACP_IDLE_POOL_SLEEP",
    "BUZZ_ACP_NO_PRESENCE",
    "BUZZ_ACP_SETUP_PAYLOAD",
    "BUZZ_MANAGED_AGENT",
    "BUZZ_MANAGED_AGENT_START_NONCE",
  ]);
});

test("isReservedEnvKey is case-insensitive and rejects unknown keys", () => {
  assert.equal(isReservedEnvKey("buzz_private_key"), true);
  assert.equal(isReservedEnvKey("Buzz_Managed_Agent"), true);
  assert.equal(isReservedEnvKey("SOME_OTHER_KEY"), false);
  assert.equal(isReservedEnvKey(""), false);
});

test("reservedKeyErrors names each offending key once, canonically", () => {
  const errors = reservedKeyErrors([
    row("buzz_private_key", "nope"),
    row("BUZZ_PRIVATE_KEY", "dupe"),
    row("FINE_KEY", "ok"),
    row("BUZZ_RELAY_URL", "nope"),
    row("", "skipped"),
  ]);
  assert.deepEqual(errors, [
    "BUZZ_PRIVATE_KEY is set by Buzz and can't be overridden.",
    "BUZZ_RELAY_URL is set by Buzz and can't be overridden.",
  ]);
});

test("reservedKeyErrors is empty for clean and empty tables", () => {
  assert.deepEqual(reservedKeyErrors([]), []);
  assert.deepEqual(reservedKeyErrors([row("", "mid-edit")]), []);
  assert.deepEqual(reservedKeyErrors([row("MY_TOKEN", "x")]), []);
});
