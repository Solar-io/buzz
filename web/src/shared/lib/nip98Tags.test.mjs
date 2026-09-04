import assert from "node:assert/strict";
import test from "node:test";

import { buildNip98Tags } from "./nip98Tags.ts";

const get = (tags, name) => tags.find((tag) => tag[0] === name)?.[1];

test("a GET with no body still carries a nonce", () => {
  const tags = buildNip98Tags("https://relay/x", "GET", undefined, "n-1");
  assert.equal(get(tags, "nonce"), "n-1");
});

test("two GETs to the same URL sign different tag sets", () => {
  const first = buildNip98Tags("https://relay/x", "GET", undefined, "n-1");
  const second = buildNip98Tags("https://relay/x", "GET", undefined, "n-2");
  // Identical but for the nonce is the whole point: without it these two
  // are byte-identical and collide on id inside one second.
  assert.notDeepEqual(first, second);
  assert.deepEqual(
    first.filter((tag) => tag[0] !== "nonce"),
    second.filter((tag) => tag[0] !== "nonce"),
  );
});

test("a body adds its digest without displacing the nonce", () => {
  const tags = buildNip98Tags("https://relay/x", "POST", "abc123", "n-3");
  assert.equal(get(tags, "payload"), "abc123");
  assert.equal(get(tags, "nonce"), "n-3");
});

test("u and method are signed verbatim, query string included", () => {
  const url = "https://relay/workflows/abc/runs?limit=20";
  const tags = buildNip98Tags(url, "GET", undefined, "n-4");
  assert.equal(get(tags, "u"), url);
  assert.equal(get(tags, "method"), "GET");
});

test("no payload tag is emitted when there is no body", () => {
  const tags = buildNip98Tags("https://relay/x", "GET", undefined, "n-5");
  assert.equal(
    tags.some((tag) => tag[0] === "payload"),
    false,
  );
});
