import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  LOCKED_CARD_REFUSAL,
  decodeSnapshotBytes,
  fetchSnapshotBytesWeb,
  MAX_SNAPSHOT_JSON_BYTES,
  MAX_SNAPSHOT_PNG_BYTES,
} from "./snapshotManifest.ts";

/**
 * Decoder suite for snapshotManifest.ts. The manifest fixture is a pinned
 * config-only `buzz-agent-snapshot v1` in the exact wire shape serde emits
 * (camelCase fields). The PNG fixture is hand-encoded — no image deps —
 * exercising the chunk walker for real.
 */

const OWNER_PUBKEY = "aa".repeat(32);
const AGENT_PUBKEY = "bb".repeat(32);
const URL = "https://relay.example/media/aa11";
const REAL_SHA = createHash("sha256")
  .update(new TextEncoder().encode(JSON.stringify(manifest())))
  .digest("hex");

function manifest(overrides = {}) {
  return {
    format: "buzz-agent-snapshot",
    version: 1,
    definition: {
      name: "Night Shift",
      sourceIsBuiltin: false,
      systemPrompt:
        "You work nights. Review changes.\n\tCall out security risks.",
      runtime: "claude",
      model: "glm-5.3",
      provider: "zai",
      parallelism: 4,
      respondTo: "owner-only",
      respondToAllowlist: [],
      namePool: [],
      idleTimeoutSeconds: 30,
      maxTurnDurationSeconds: 600,
    },
    profile: {
      displayName: "Night Shift",
      avatarUrl: "https://relay.example/media/avatar.png",
    },
    memory: { level: "none", entries: [] },
    ...overrides,
  };
}

function manifestBytes(value = manifest()) {
  return new TextEncoder().encode(JSON.stringify(value));
}

function setDefinition(overrides) {
  return manifest({
    definition: { ...manifest().definition, ...overrides },
  });
}

// ── Hand-encoded PNG fixture ─────────────────────────────────────────────────

function chunk(type, data) {
  const bytes = new Uint8Array(12 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    bytes[4 + i] = type.charCodeAt(i);
  }
  bytes.set(data, 8);
  // CRC bytes stay zero: the walker deliberately does not verify CRC (sha256
  // is the integrity gate) — documented in snapshotManifest.ts.
  return bytes;
}

function concat(...arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

function pngWithText(jsonText, keyword = "buzz_agent_snapshot") {
  const base64Payload = btoa(jsonText);
  const keywordBytes = Array.from(keyword, (ch) => ch.charCodeAt(0));
  const textBytes = Array.from(base64Payload, (ch) => ch.charCodeAt(0));
  // Numeric arg = LENGTH (new Uint8Array([n]) would be a 1-byte array!).
  const tEXtData = new Uint8Array(keywordBytes.length + 1 + textBytes.length);
  let i = 0;
  for (const byte of [...keywordBytes, 0, ...textBytes]) {
    tEXtData[i++] = byte;
  }
  const signature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  return concat(
    signature,
    chunk("IHDR", new Uint8Array(13)),
    chunk("tEXt", tEXtData),
    chunk("IEND", new Uint8Array(0)),
  );
}

function agentViewAssertions(decoded) {
  assert.equal(decoded.kind, "agent");
  assert.deepEqual(decoded.snapshot.definition, {
    name: "Night Shift",
    sourceIsBuiltin: false,
    systemPrompt:
      "You work nights. Review changes.\n\tCall out security risks.",
    runtime: "claude",
    model: "glm-5.3",
    provider: "zai",
    parallelism: 4,
    respondTo: "owner-only",
    respondToAllowlist: [],
    namePool: [],
    idleTimeoutSeconds: 30,
    maxTurnDurationSeconds: 600,
  });
  assert.equal(decoded.snapshot.displayName, "Night Shift");
  assert.equal(
    decoded.snapshot.avatarUrl,
    "https://relay.example/media/avatar.png",
  );
  assert.equal(decoded.snapshot.avatarDataUrl, null);
  assert.equal(decoded.snapshot.memoryLevel, "none");
  assert.equal(decoded.snapshot.memoryEntryCount, 0);
}

// ── Decode: JSON path ────────────────────────────────────────────────────────

test("config-only manifest round-trips into the full view", () => {
  const decoded = decodeSnapshotBytes(manifestBytes());
  agentViewAssertions(decoded);
  assert.ok(decoded.snapshot.manifestJson.includes('"name": "Night Shift"'));
});

test("memory-bearing manifest counts entries and carries the level", () => {
  const decoded = decodeSnapshotBytes(
    manifestBytes(
      manifest({
        memory: {
          level: "core",
          entries: [
            { slug: "core", body: "I am Night Shift." },
            { slug: "mem/research", body: "Notes." },
          ],
        },
      }),
    ),
  );
  assert.equal(decoded.kind, "agent");
  assert.equal(decoded.snapshot.memoryLevel, "core");
  assert.equal(decoded.snapshot.memoryEntryCount, 2);
});

test("source allowlist and name pool survive into the view", () => {
  const decoded = decodeSnapshotBytes(
    manifestBytes(
      setDefinition({
        respondTo: "allowlist",
        respondToAllowlist: [OWNER_PUBKEY],
        namePool: ["Alice", "Bob"],
      }),
    ),
  );
  assert.deepEqual(decoded.snapshot.definition.respondToAllowlist, [
    OWNER_PUBKEY,
  ]);
  assert.deepEqual(decoded.snapshot.definition.namePool, ["Alice", "Bob"]);
});

test("rule-12 rejection propagates with the Rust wording", () => {
  const decoded = decodeSnapshotBytes(
    manifestBytes(setDefinition({ systemPrompt: "Review code.\u200B" })),
  );
  assert.deepEqual(decoded, {
    kind: "error",
    error:
      "Snapshot definition is unsafe: Agent instructions contains prohibited invisible or formatting character U+200B",
  });
});

test("rule-12 runs on the displayName too", () => {
  const decoded = decodeSnapshotBytes(
    manifestBytes(
      manifest({
        profile: { displayName: "Night\u200BShift", about: null },
      }),
    ),
  );
  assert.equal(decoded.kind, "error");
  assert.match(decoded.error, /prohibited invisible or formatting character/);
});

test("memory level none with entries is malformed, exactly the Rust message", () => {
  const decoded = decodeSnapshotBytes(
    manifestBytes(
      manifest({
        memory: { level: "none", entries: [{ slug: "core", body: "x" }] },
      }),
    ),
  );
  assert.deepEqual(decoded, {
    kind: "error",
    error:
      "Snapshot is malformed: memory.level is 'none' but entries are present.",
  });
});

test("wrong version and empty names are refused", () => {
  assert.deepEqual(
    decodeSnapshotBytes(manifestBytes(manifest({ version: 2 }))),
    {
      kind: "error",
      error: "Unsupported snapshot version: 2 (expected 1)",
    },
  );
  assert.deepEqual(
    decodeSnapshotBytes(manifestBytes(setDefinition({ name: "   " }))),
    { kind: "error", error: "Snapshot definition.name is empty" },
  );
  assert.deepEqual(
    decodeSnapshotBytes(
      manifestBytes(manifest({ profile: { displayName: "", about: null } })),
    ),
    { kind: "error", error: "Snapshot profile.displayName is empty" },
  );
});

// ── Decode: format dispatch (envelope.rs discipline) ─────────────────────────

test("locked envelope (structurally valid) is refused, not decrypted", () => {
  const envelope = JSON.stringify({
    format: "buzz-agent-snapshot-encrypted",
    version: 1,
    encryption: {
      scheme: "nip44-v2",
      ownerPubkey: OWNER_PUBKEY,
      agentPubkey: AGENT_PUBKEY,
      ciphertext: "AgAAAAAAAA",
    },
  });
  assert.deepEqual(decodeSnapshotBytes(new TextEncoder().encode(envelope)), {
    kind: "locked",
    refusal: LOCKED_CARD_REFUSAL,
  });
  assert.equal(
    LOCKED_CARD_REFUSAL,
    "This card is locked to its owner and agent. Only they can import it.",
  );
});

test("locked envelope structural failures mirror the Rust errors", () => {
  const envelope = (encryption, version = 1) =>
    new TextEncoder().encode(
      JSON.stringify({
        format: "buzz-agent-snapshot-encrypted",
        version,
        encryption,
      }),
    );
  const good = {
    scheme: "nip44-v2",
    ownerPubkey: OWNER_PUBKEY,
    agentPubkey: AGENT_PUBKEY,
    ciphertext: "AgAAAAAAAA",
  };
  const badScheme = decodeSnapshotBytes(
    envelope({ ...good, scheme: "nip44-v3" }),
  );
  assert.equal(badScheme.kind, "error");
  assert.match(badScheme.error, /scheme/);

  const malformedKey = decodeSnapshotBytes(
    envelope({ ...good, ownerPubkey: "abc123" }),
  );
  assert.match(malformedKey.error, /malformed/);

  const sameKey = decodeSnapshotBytes(
    envelope({ ...good, agentPubkey: OWNER_PUBKEY }),
  );
  assert.match(sameKey.error, /must differ/);

  const emptyCiphertext = decodeSnapshotBytes(
    envelope({ ...good, ciphertext: "" }),
  );
  assert.match(emptyCiphertext.error, /is empty/);

  const badVersion = decodeSnapshotBytes(envelope(good, 2));
  assert.match(badVersion.error, /version/);

  const oversized = decodeSnapshotBytes(
    envelope({ ...good, ciphertext: "A".repeat(90_001) }),
  );
  assert.match(oversized.error, /exceeds the maximum size/);
});

test("team discriminator decodes to the desktop-only marker", () => {
  const team = new TextEncoder().encode(
    JSON.stringify({ format: "buzz-team-snapshot", version: 1, team: {} }),
  );
  assert.deepEqual(decodeSnapshotBytes(team), { kind: "team" });
});

test("unknown or missing format never falls through", () => {
  const unknown = decodeSnapshotBytes(
    new TextEncoder().encode(
      JSON.stringify({ format: "buzz-agent-snapshot-v9", version: 1 }),
    ),
  );
  assert.deepEqual(unknown, {
    kind: "error",
    error: 'Unsupported snapshot format: "buzz-agent-snapshot-v9"',
  });
  const missing = decodeSnapshotBytes(
    new TextEncoder().encode(JSON.stringify({ version: 1 })),
  );
  assert.deepEqual(missing, {
    kind: "error",
    error: "Snapshot payload has no format discriminator.",
  });
});

// ── Decode: PNG path ─────────────────────────────────────────────────────────

test("png tEXt chunk round-trips through the walker", () => {
  const decoded = decodeSnapshotBytes(pngWithText(JSON.stringify(manifest())));
  agentViewAssertions(decoded);
});

test("png chunk declared longer than the buffer is refused", () => {
  // tEXt chunk claims 0x7fffffff data bytes — far past EOF.
  const lying = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0x7f,
    0xff,
    0xff,
    0xff, // length
    0x74,
    0x45,
    0x58,
    0x74, // "tEXt"
  ]);
  assert.deepEqual(decodeSnapshotBytes(lying), {
    kind: "error",
    error: "Invalid PNG: chunk length exceeds the remaining buffer.",
  });
});

test("png without the snapshot chunk, bad base64, and bad signature refuse", () => {
  const noChunk = concat(
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", new Uint8Array(13)),
    chunk("IEND", new Uint8Array(0)),
  );
  assert.deepEqual(decodeSnapshotBytes(noChunk), {
    kind: "error",
    error: "PNG does not contain a buzz_agent_snapshot tEXt chunk",
  });

  // Invalid base64 must be rejected at the chunk, not re-encoded — build the
  // tEXt data directly (pngWithText btoa's its input, which would "fix" it).
  const rawInvalid = Array.from("!!!!not-base64!!!!", (ch) => ch.charCodeAt(0));
  const invalidData = new Uint8Array(rawInvalid.length + 20 + 1);
  invalidData.set(
    Array.from("buzz_agent_snapshot", (ch) => ch.charCodeAt(0)),
    0,
  );
  invalidData.set([0], 20);
  invalidData.set(rawInvalid, 21);
  const badBase64 = decodeSnapshotBytes(
    concat(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", new Uint8Array(13)),
      chunk("tEXt", invalidData),
      chunk("IEND", new Uint8Array(0)),
    ),
  );
  assert.deepEqual(badBase64, {
    kind: "error",
    error: "Invalid base64 in PNG chunk.",
  });

  const badSignature = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00,
  ]);
  assert.deepEqual(decodeSnapshotBytes(badSignature), {
    kind: "error",
    error: "Invalid PNG: bad signature.",
  });
});

test("wrong keyword tEXt chunk is not the snapshot payload", () => {
  const decoded = decodeSnapshotBytes(
    pngWithText(JSON.stringify(manifest()), "comment"),
  );
  assert.equal(decoded.kind, "error");
  assert.match(decoded.error, /does not contain a buzz_agent_snapshot/);
});

// ── Caps ─────────────────────────────────────────────────────────────────────

test("json cap enforced before parse, png cap before the walker", () => {
  const oversizedJson = new Uint8Array(MAX_SNAPSHOT_JSON_BYTES + 1);
  oversizedJson.fill(0x61);
  assert.deepEqual(decodeSnapshotBytes(oversizedJson), {
    kind: "error",
    error:
      "Snapshot file is too large (5 MiB). JSON snapshots must be under 5 MiB.",
  });

  const oversizedPng = new Uint8Array(MAX_SNAPSHOT_PNG_BYTES + 1);
  oversizedPng.set([0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual(decodeSnapshotBytes(oversizedPng), {
    kind: "error",
    error:
      "Snapshot file is too large (10 MiB). PNG snapshots must be under 10 MiB.",
  });
});

// ── Verified fetch ───────────────────────────────────────────────────────────

function fakeFetch(bytes) {
  return async () => bytes;
}

const REAL_BYTES = manifestBytes();
const REAL_SIZE = REAL_BYTES.length;

test("verified fetch resolves matching bytes end to end", async () => {
  const bytes = await fetchSnapshotBytesWeb(
    URL,
    {
      filename: "night-shift.agent.json",
      sha256: REAL_SHA,
      size: REAL_SIZE,
    },
    { signedFetch: fakeFetch(REAL_BYTES) },
  );
  assert.deepEqual(bytes, REAL_BYTES);
});

test("sha256 mismatch names the failure (tamper case)", async () => {
  await assert.rejects(
    fetchSnapshotBytesWeb(
      URL,
      {
        filename: "night-shift.agent.json",
        sha256: "0".repeat(64),
        size: REAL_SIZE,
      },
      { signedFetch: fakeFetch(REAL_BYTES) },
    ),
    /hash mismatch: fetched bytes do not match the declared SHA-256/,
  );
});

test("size mismatch and declared-cap errors mirror the Rust wording", async () => {
  await assert.rejects(
    fetchSnapshotBytesWeb(
      URL,
      {
        filename: "night-shift.agent.json",
        sha256: REAL_SHA,
        size: REAL_SIZE + 1,
      },
      { signedFetch: fakeFetch(REAL_BYTES) },
    ),
    /size mismatch: fetched \d+ bytes but imeta declared \d+/,
  );
  await assert.rejects(
    fetchSnapshotBytesWeb(
      URL,
      {
        filename: "night-shift.agent.json",
        sha256: REAL_SHA,
        size: 25 * 1024 * 1024 + 1,
      },
      { signedFetch: fakeFetch(REAL_BYTES) },
    ),
    /declared size \d+ exceeds the 5 MiB cap for this format/,
  );
});

test("pre-fetch validation: bad filename and bad sha never hit the network", async () => {
  let fetched = false;
  const signedFetch = async () => {
    fetched = true;
    return REAL_BYTES;
  };
  await assert.rejects(
    fetchSnapshotBytesWeb(
      URL,
      { filename: "notes.txt", sha256: REAL_SHA },
      { signedFetch },
    ),
    /is not a snapshot filename/,
  );
  await assert.rejects(
    fetchSnapshotBytesWeb(
      URL,
      { filename: "night-shift.agent.json", sha256: "zz".repeat(32) },
      { signedFetch },
    ),
    /invalid expected sha256 — must be a 64-hex-digit lowercase string/,
  );
  assert.equal(fetched, false);
});

test("byte magic must match the filename-selected kind", async () => {
  const png = pngWithText(JSON.stringify(manifest()));
  const pngSha = createHash("sha256").update(png).digest("hex");
  // JSON filename + PNG bytes \u2192 refused.
  await assert.rejects(
    fetchSnapshotBytesWeb(
      URL,
      { filename: "night-shift.agent.json", sha256: pngSha, size: png.length },
      { signedFetch: fakeFetch(png) },
    ),
    /format mismatch: filename is \.agent\.json but bytes are a PNG/,
  );
  // PNG filename + JSON bytes \u2192 refused.
  await assert.rejects(
    fetchSnapshotBytesWeb(
      URL,
      { filename: "night-shift.agent.png", sha256: REAL_SHA, size: REAL_SIZE },
      { signedFetch: fakeFetch(REAL_BYTES) },
    ),
    /format mismatch: filename is \.agent\.png but bytes are not a PNG/,
  );
  // PNG filename + PNG bytes with the right hash \u2192 resolves.
  const bytes = await fetchSnapshotBytesWeb(
    URL,
    { filename: "night-shift.agent.png", sha256: pngSha, size: png.length },
    { signedFetch: fakeFetch(png) },
  );
  assert.equal(bytes.length, png.length);
});
