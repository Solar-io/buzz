// Independent QA adversarial vectors for the web voice-catalog reducer
// (design docs/plans/2026-09-15-voice-repository-v1.md §7, §9).
// Hand-built events only — no shared fixtures with voiceCatalog.test.mjs.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIND_VOICE_CATALOG,
  parseVoiceCatalogEvent,
  reduceVoiceCatalogEvents,
} from "./voiceCatalog.ts";

const AUTHOR = "c".repeat(64);
const IMPORTED_HASH = "7".repeat(64);

function importedBody(overrides = {}) {
  return {
    version: 1,
    key: `pocket:imported:${IMPORTED_HASH}`,
    displayName: "QA import",
    backend: "pocket",
    contentHash: IMPORTED_HASH,
    bundled: false,
    license: "CC-BY-4.0",
    source: "qa harness",
    asset: { sha256: IMPORTED_HASH, size: 1234, mimeType: "audio/wav" },
    ...overrides,
  };
}

function event(overrides = {}) {
  return {
    pubkey: AUTHOR,
    content: JSON.stringify(importedBody()),
    created_at: 1000,
    tags: [["d", `pocket:imported:${IMPORTED_HASH}`]],
    ...overrides,
  };
}

test("QA: the kind constant pins 30181", () => {
  assert.equal(KIND_VOICE_CATALOG, 30181);
});

test("QA: duplicate d tags with different created_at resolve by LWW in both delivery orders", () => {
  const older = event({
    content: JSON.stringify(importedBody({ displayName: "Older" })),
    created_at: 500,
  });
  const newer = event({
    content: JSON.stringify(importedBody({ displayName: "Newer" })),
    created_at: 900,
  });
  for (const order of [[older, newer], [newer, older]]) {
    const folded = reduceVoiceCatalogEvents(order);
    assert.equal(folded.size, 1);
    assert.equal(
      folded.get(`pocket:imported:${IMPORTED_HASH}`).content.displayName,
      "Newer",
    );
  }
});

test("QA: equal created_at keeps the first-delivered row (>= tie rule) and never flickers", () => {
  const a = event({
    content: JSON.stringify(importedBody({ displayName: "First seen" })),
    created_at: 1000,
  });
  const b = event({
    content: JSON.stringify(importedBody({ displayName: "Second same ts" })),
    created_at: 1000,
  });
  const folded = reduceVoiceCatalogEvents([a, b]);
  assert.equal(
    folded.get(`pocket:imported:${IMPORTED_HASH}`).content.displayName,
    "First seen",
  );
});

test("QA: a pocket:eve event is dropped even with valid grammar", () => {
  const eve = event({
    content: JSON.stringify(
      importedBody({
        key: "pocket:eve",
        bundled: true,
        asset: null,
        contentHash: IMPORTED_HASH,
      }),
    ),
    tags: [["d", "pocket:eve"]],
  });
  assert.equal(parseVoiceCatalogEvent(eve), null);
  const folded = reduceVoiceCatalogEvents([eve, event()]);
  assert.ok(!folded.has("pocket:eve"));
});

test("QA: a version 2 body is dropped", () => {
  const v2 = event({
    content: JSON.stringify(importedBody({ version: 2 })),
  });
  assert.equal(parseVoiceCatalogEvent(v2), null);
});

test("QA: an imported row whose key hash differs from contentHash is dropped", () => {
  const lying = event({
    content: JSON.stringify(
      importedBody({ contentHash: "8".repeat(64) }),
    ),
  });
  assert.equal(parseVoiceCatalogEvent(lying), null);
});

test("QA: mixed authors and keys fold independently", () => {
  const other = "d".repeat(64);
  const mine = event({ created_at: 100 });
  const theirs = event({
    pubkey: other,
    created_at: 200,
    content: JSON.stringify(
      importedBody({ displayName: "Foreign same key" }),
    ),
  });
  const folded = reduceVoiceCatalogEvents([mine, theirs]);
  assert.equal(folded.size, 1, "same key across authors folds to one slot");
  assert.equal(
    folded.get(`pocket:imported:${IMPORTED_HASH}`).pubkey,
    other,
    "LWW across authors by created_at, not by delivery preference",
  );
});
