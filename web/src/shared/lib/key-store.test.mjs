import assert from "node:assert/strict";
import { test } from "node:test";
import { isValidRememberedKey } from "./key-store.ts";

// Same hint function the store uses (FNV-ish over the bytes).
function hintOf(bytes) {
  let h = 0;
  for (const b of bytes) {
    h = (Math.imul(h, 31) + b) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function keyBytes(fill) {
  const bytes = new Uint8Array(32);
  bytes.fill(fill);
  return bytes;
}

test("valid remembered key passes: 32 bytes and matching hint", () => {
  const bytes = keyBytes(7);
  const value = { bytes, hint: hintOf(bytes) };
  assert.equal(isValidRememberedKey(value, hintOf), true);
});

test("wrong-length bytes are rejected", () => {
  const short = keyBytes(7).slice(0, 31);
  const value = { bytes: short, hint: hintOf(keyBytes(7)) };
  assert.equal(isValidRememberedKey(value, hintOf), false);
});

test("hint mismatch (stale key from a previous envelope) is rejected", () => {
  const value = { bytes: keyBytes(7), hint: hintOf(keyBytes(9)) };
  assert.equal(isValidRememberedKey(value, hintOf), false);
});

test("garbage shapes are rejected, not thrown on", () => {
  assert.equal(isValidRememberedKey(null, hintOf), false);
  assert.equal(isValidRememberedKey({}, hintOf), false);
  assert.equal(isValidRememberedKey({ bytes: "nope", hint: "x" }, hintOf), false);
  assert.equal(
    isValidRememberedKey({ bytes: keyBytes(3), hint: "x" }, hintOf),
    false,
  );
});
