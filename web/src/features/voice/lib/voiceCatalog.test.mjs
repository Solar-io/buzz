import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assetUrl,
  EVE_VOICE_KEY,
  KIND_VOICE_CATALOG,
  parseVoiceCatalogEvent,
  reduceVoiceCatalogEvents,
} from "./voiceCatalog.ts";

const AUTHOR = "a".repeat(64);
const OTHER = "b".repeat(64);
const HASH = "6".repeat(64);

const AZELMA_BODY = {
  version: 1,
  key: "pocket:azelma",
  displayName: "Azelma",
  backend: "pocket",
  contentHash: HASH,
  bundled: true,
  license: "CC-BY-4.0",
  source: "VCTK p303_023_enhanced.wav",
  sourceUrl:
    "https://huggingface.co/kyutai/tts-voices/blob/rev/vctk/p303_023_enhanced.wav",
};

function catalogEvent(overrides = {}) {
  return {
    pubkey: AUTHOR,
    content: JSON.stringify(AZELMA_BODY),
    created_at: 1_700_000_000,
    tags: [["d", "pocket:azelma"]],
    ...overrides,
  };
}

// ── Kind constant ──────────────────────────────────────────────────────────

test("the kind constant pins 30181", () => {
  assert.equal(KIND_VOICE_CATALOG, 30181);
});

// ── Parse ──────────────────────────────────────────────────────────────────

test("a bundled row parses with its provenance", () => {
  const row = parseVoiceCatalogEvent(catalogEvent());
  assert.equal(row.pubkey, AUTHOR);
  assert.equal(row.createdAt, 1_700_000_000);
  assert.equal(row.content.displayName, "Azelma");
  assert.equal(row.content.bundled, true);
  // The Rust writer skips absent optional fields, so a bundled row has no
  // asset at all — null or missing are the same thing to a reader.
  assert.ok(!row.content.asset);
});

test("an imported row with a matching hash and asset parses", () => {
  const assetHash = "9".repeat(64);
  const body = {
    version: 1,
    key: `pocket:imported:${HASH}`,
    displayName: "Azelma studio take",
    backend: "pocket",
    contentHash: HASH,
    bundled: false,
    license: "CC-BY-4.0",
    source: "Sam's own recording",
    asset: { sha256: assetHash, size: 184354, mimeType: "audio/wav" },
    sampleRate: 32000,
    durationSeconds: 4.21,
  };
  const row = parseVoiceCatalogEvent(
    catalogEvent({ content: JSON.stringify(body), tags: [["d", body.key]] }),
  );
  assert.equal(row.content.key, `pocket:imported:${HASH}`);
});

test("parse rejects a version mismatch", () => {
  const body = { ...AZELMA_BODY, version: 2 };
  assert.equal(
    parseVoiceCatalogEvent(catalogEvent({ content: JSON.stringify(body) })),
    null,
  );
});

test("parse rejects a key that does not match the d tag", () => {
  assert.equal(
    parseVoiceCatalogEvent(catalogEvent({ tags: [["d", "pocket:eponine"]] })),
    null,
  );
});

test("parse rejects a key/d mismatch in the other direction — missing d tag", () => {
  assert.equal(parseVoiceCatalogEvent(catalogEvent({ tags: [] })), null);
});

test("parse rejects a key violating the grammar", () => {
  const foreignBackend = { ...AZELMA_BODY, key: "siri:aaron" };
  assert.equal(
    parseVoiceCatalogEvent(
      catalogEvent({
        content: JSON.stringify(foreignBackend),
        tags: [["d", "siri:aaron"]],
      }),
    ),
    null,
  );
});

test("an imported key whose hash does not equal contentHash is rejected", () => {
  const body = {
    ...AZELMA_BODY,
    key: `pocket:imported:${"1".repeat(64)}`,
    bundled: false,
  };
  assert.equal(
    parseVoiceCatalogEvent(
      catalogEvent({ content: JSON.stringify(body), tags: [["d", body.key]] }),
    ),
    null,
  );
});

test("parse drops eve rows — on web the reader is the only guard", () => {
  const body = { ...AZELMA_BODY, key: EVE_VOICE_KEY, displayName: "Fake Eve" };
  const event = catalogEvent({
    content: JSON.stringify(body),
    tags: [["d", EVE_VOICE_KEY]],
    pubkey: OTHER,
  });
  assert.equal(parseVoiceCatalogEvent(event), null);
});

test("parse survives unparseable content", () => {
  assert.equal(
    parseVoiceCatalogEvent(catalogEvent({ content: "not json" })),
    null,
  );
});

// ── Fold ───────────────────────────────────────────────────────────────────

test("reduce folds by key with last write wins", () => {
  const older = catalogEvent({
    content: JSON.stringify({ ...AZELMA_BODY, displayName: "Older" }),
    created_at: 100,
  });
  const newer = catalogEvent({
    content: JSON.stringify({ ...AZELMA_BODY, displayName: "Newer" }),
    created_at: 200,
  });
  assert.equal(reduceVoiceCatalogEvents([older, newer]).size, 1);
  assert.equal(
    reduceVoiceCatalogEvents([older, newer]).get("pocket:azelma").content
      .displayName,
    "Newer",
  );
  assert.equal(
    reduceVoiceCatalogEvents([newer, older]).get("pocket:azelma").content
      .displayName,
    "Newer",
  );
});

test("reduce keeps distinct keys apart", () => {
  const eponine = catalogEvent({
    content: JSON.stringify({ ...AZELMA_BODY, key: "pocket:eponine" }),
    tags: [["d", "pocket:eponine"]],
  });
  const folded = reduceVoiceCatalogEvents([catalogEvent(), eponine]);
  assert.equal(folded.size, 2);
  assert.ok(folded.has("pocket:azelma"));
  assert.ok(folded.has("pocket:eponine"));
});

test("reduce drops refused events rather than failing", () => {
  const eve = catalogEvent({
    content: JSON.stringify({ ...AZELMA_BODY, key: EVE_VOICE_KEY }),
    tags: [["d", EVE_VOICE_KEY]],
    pubkey: OTHER,
  });
  const folded = reduceVoiceCatalogEvents([eve, catalogEvent()]);
  assert.equal(folded.size, 1);
  assert.ok(folded.has("pocket:azelma"));
  assert.ok(!folded.has(EVE_VOICE_KEY));
});

// ── Asset URL ──────────────────────────────────────────────────────────────

test("assetUrl derives the media path from the sha256", () => {
  const body = {
    ...AZELMA_BODY,
    key: `pocket:imported:${HASH}`,
    bundled: false,
    asset: { sha256: "9".repeat(64), size: 184354, mimeType: "audio/wav" },
  };
  const row = parseVoiceCatalogEvent(
    catalogEvent({ content: JSON.stringify(body), tags: [["d", body.key]] }),
  );
  assert.equal(
    assetUrl(row, "https://relay.example"),
    `https://relay.example/media/${"9".repeat(64)}.wav`,
  );
});

test("assetUrl is null for an asset-less bundled row", () => {
  assert.equal(
    assetUrl(parseVoiceCatalogEvent(catalogEvent()), "https://relay.example"),
    null,
  );
});
