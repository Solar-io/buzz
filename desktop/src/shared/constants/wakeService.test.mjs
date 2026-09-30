import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { WAKE_SERVICE_PUBKEYS } from "./wakeService.ts";

/** buzz-services reminder identity — the one wake sender today. */
const EXPECTED = [
  "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271",
];

/**
 * Reads the VALUES of the Rust constant, not its surrounding text: the two
 * copies live in different languages, so comparing the parsed literals is
 * the only way one test can see both.
 */
function rustWakeServicePubkeys() {
  const source = readFileSync(
    new URL("../../../src-tauri/src/unread_catch_up.rs", import.meta.url),
    "utf8",
  );
  const declaration = source.match(
    /const WAKE_SERVICE_PUBKEYS: &\[&str\] =\s*&\[([^\]]*)\];/,
  );
  assert.ok(
    declaration,
    "WAKE_SERVICE_PUBKEYS not found in unread_catch_up.rs",
  );
  return Array.from(declaration[1].matchAll(/"([^"]*)"/g), (m) => m[1]);
}

test("the TypeScript default wake service key list is exactly the services identity", () => {
  assert.deepEqual(WAKE_SERVICE_PUBKEYS, EXPECTED);
});

test("the Rust catch-up wake service key list names the same keys as the TypeScript default", () => {
  assert.deepEqual(rustWakeServicePubkeys(), EXPECTED);
});
