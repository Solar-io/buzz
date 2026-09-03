import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RESPOND_TO_OPTIONS,
  accessWarning,
  validateAllowlist,
} from "./respondToField.ts";

test("mode labels are the plain-language trio", () => {
  assert.deepEqual(RESPOND_TO_OPTIONS, [
    { value: "owner-only", label: "Only me (owner)" },
    { value: "anyone", label: "Anyone" },
    { value: "allowlist", label: "Specific people" },
  ]);
});

test("access-warning sentences are pinned byte-for-byte (desktop parity)", () => {
  assert.equal(
    accessWarning("anyone"),
    "Anyone can use this agent to access your computer, including files, accounts, and connected tools.",
  );
  assert.equal(
    accessWarning("allowlist"),
    "Selected people can use this agent to access your computer, including files, accounts, and connected tools.",
  );
  assert.equal(accessWarning("owner-only"), null);
});

test("validateAllowlist: empty list errors, one 64-hex key passes", () => {
  assert.equal(validateAllowlist([]), "Specific people requires at least one key.");
  assert.equal(validateAllowlist(["  "]), "Specific people requires at least one key.");
  assert.equal(validateAllowlist(["ab".repeat(32)]), null);
});

test("validateAllowlist: malformed keys error (63-hex, non-hex, uppercase)", () => {
  const HEX63 = "ab".repeat(31) + "a";
  assert.equal(HEX63.length, 63);
  assert.equal(validateAllowlist([HEX63]) !== null, true);
  assert.equal(validateAllowlist(["not-a-key"]) !== null, true);
  assert.equal(validateAllowlist(["AB".repeat(32)]) !== null, true);
  // One bad entry poisons the whole list even beside good ones.
  assert.equal(
    validateAllowlist(["ab".repeat(32), "cd"]) !== null,
    true,
  );
});
