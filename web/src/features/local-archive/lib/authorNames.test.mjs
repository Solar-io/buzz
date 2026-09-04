import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AUTHOR_BATCH,
  chunk,
  displayNamesFromEvents,
  distinctAuthors,
  fetchDisplayNames,
  profileNameFromEvent,
} from "./authorNames.ts";

const SESSION = { subscribe: () => () => {} };

function profile(pubkey, content, createdAt = 100) {
  return {
    id: `${pubkey}-${createdAt}`,
    pubkey,
    created_at: createdAt,
    kind: 0,
    tags: [],
    content,
    sig: "ff".repeat(64),
  };
}

test("display_name wins over name", () => {
  const event = profile(
    "aa",
    JSON.stringify({ name: "al", display_name: "Alice" }),
  );
  assert.equal(profileNameFromEvent(event), "Alice");
});

test("name is used when display_name is absent or blank", () => {
  assert.equal(
    profileNameFromEvent(profile("aa", JSON.stringify({ name: "al" }))),
    "al",
  );
  assert.equal(
    profileNameFromEvent(
      profile("aa", JSON.stringify({ name: "al", display_name: "  " })),
    ),
    "al",
  );
});

test("nothing usable yields null so the caller can fall back to a pubkey", () => {
  assert.equal(profileNameFromEvent(profile("aa", "{}")), null);
  assert.equal(profileNameFromEvent(profile("aa", "not json")), null);
  assert.equal(
    profileNameFromEvent(profile("aa", JSON.stringify({ name: 42 }))),
    null,
  );
});

test("a non-profile event is never mistaken for a profile", () => {
  const message = { ...profile("aa", JSON.stringify({ name: "al" })), kind: 9 };
  assert.equal(profileNameFromEvent(message), null);
});

test("the newest profile revision wins regardless of arrival order", () => {
  const names = displayNamesFromEvents([
    profile("aa", JSON.stringify({ name: "New" }), 200),
    profile("aa", JSON.stringify({ name: "Old" }), 100),
  ]);
  assert.equal(names.get("aa"), "New");

  const reversed = displayNamesFromEvents([
    profile("aa", JSON.stringify({ name: "Old" }), 100),
    profile("aa", JSON.stringify({ name: "New" }), 200),
  ]);
  assert.equal(reversed.get("aa"), "New", "order of arrival must not matter");
});

test("unparseable revisions do not evict a good name", () => {
  const names = displayNamesFromEvents([
    profile("aa", JSON.stringify({ name: "Alice" }), 100),
    profile("aa", "corrupt", 200),
  ]);
  assert.equal(names.get("aa"), "Alice");
});

test("distinctAuthors preserves first-seen order and drops repeats", () => {
  const authors = distinctAuthors([
    { pubkey: "b" },
    { pubkey: "a" },
    { pubkey: "b" },
    { pubkey: "c" },
  ]);
  assert.deepEqual(authors, ["b", "a", "c"]);
});

test("chunk splits evenly and keeps the short tail", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 2), []);
  assert.deepEqual(chunk([1, 2], 5), [[1, 2]]);
});

test("the author batch is bounded so a big channel does not build one huge REQ", async () => {
  const authors = Array.from(
    { length: AUTHOR_BATCH * 2 + 1 },
    (_, i) => `p${i}`,
  );
  const events = authors.map((pubkey) => ({ pubkey }));
  const batches = [];
  await fetchDisplayNames(SESSION, events, async (_session, batch) => {
    batches.push(batch.length);
    return [];
  });
  assert.equal(batches.length, 3, "401 authors over a 200 batch is three REQs");
  assert.deepEqual(batches, [AUTHOR_BATCH, AUTHOR_BATCH, 1]);
});

test("names from every batch are merged into one map", async () => {
  const events = [{ pubkey: "a" }, { pubkey: "b" }];
  const names = await fetchDisplayNames(
    SESSION,
    events,
    async (_session, batch) =>
      batch.map((pubkey) =>
        profile(pubkey, JSON.stringify({ name: pubkey.toUpperCase() })),
      ),
  );
  assert.equal(names.get("a"), "A");
  assert.equal(names.get("b"), "B");
});

test("a failing profile query degrades to no names rather than failing the export", async () => {
  const names = await fetchDisplayNames(
    SESSION,
    [{ pubkey: "a" }],
    async () => {
      throw new Error("relay went away");
    },
  );
  assert.equal(names.size, 0);
});

test("an export with no events makes no profile request at all", async () => {
  let calls = 0;
  const names = await fetchDisplayNames(SESSION, [], async () => {
    calls += 1;
    return [];
  });
  assert.equal(calls, 0);
  assert.equal(names.size, 0);
});
