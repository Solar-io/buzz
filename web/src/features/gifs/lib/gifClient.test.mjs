import assert from "node:assert/strict";
import test from "node:test";

import { gifErrorMessage, klipyCustomerId } from "./klipy.ts";

test("a known relay error code becomes a sentence a person can act on", () => {
  assert.equal(
    gifErrorMessage("relay_membership_required", 403),
    "Join this community to search GIFs.",
  );
});

test("the statuses the relay actually returns are explained", () => {
  // gifs.rs returns 404 when no provider is configured and 429 on the
  // gif_searches_per_min quota; neither is a useful message on its own.
  assert.equal(
    gifErrorMessage(undefined, 404),
    "This relay has no GIF provider configured.",
  );
  assert.equal(
    gifErrorMessage(undefined, 429),
    "GIF search is rate limited — try again shortly.",
  );
});

test("an unrecognised error falls back to the relay's own words, then the status", () => {
  assert.equal(
    gifErrorMessage("GIF provider is unavailable", 502),
    "GIF provider is unavailable",
  );
  assert.equal(gifErrorMessage(undefined, 500), "GIF request failed (500)");
  assert.equal(gifErrorMessage("", 500), "GIF request failed (500)");
});

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    writes: 0,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      this.writes += 1;
      map.set(key, value);
    },
  };
}

test("the customer id is minted once and reused", () => {
  const storage = fakeStorage();
  const first = klipyCustomerId(storage);
  const second = klipyCustomerId(storage);
  assert.equal(first, second);
  assert.equal(storage.writes, 1, "the second call reads, it does not re-mint");
  assert.match(
    first,
    /^[0-9a-f-]{36}$/,
    "KLIPY wants an opaque installation id, not anything identifying",
  );
});

test("a stored id is honoured rather than replaced", () => {
  const storage = fakeStorage({ "buzz:klipy-customer-id:v1": "existing-id" });
  assert.equal(klipyCustomerId(storage), "existing-id");
  assert.equal(storage.writes, 0);
});

test("without storage each call gets a fresh id rather than a shared constant", () => {
  const a = klipyCustomerId(null);
  const b = klipyCustomerId(null);
  assert.notEqual(a, b, "a constant fallback would correlate every visitor");
});

test("a throwing storage degrades to an ephemeral id instead of failing", () => {
  const hostile = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("storage disabled");
    },
  };
  assert.match(klipyCustomerId(hostile), /^[0-9a-f-]{36}$/);
});
