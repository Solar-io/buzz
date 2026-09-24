import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PLACEHOLDER_PNG,
  crc32,
  encodeSnapshotPng,
  injectSnapshotText,
  makeChunk,
  pngChunks,
  pngDimensions,
} from "./pngText.ts";
import { decodeSnapshotBytes } from "./snapshotManifest.ts";

const MANIFEST = JSON.stringify({
  format: "buzz-agent-snapshot",
  version: 1,
  definition: { name: "P", sourceIsBuiltin: false, parallelism: 10 },
  profile: { displayName: "P" },
  memory: { level: "none" },
});
const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.equal(crc32(new TextEncoder().encode("IEND")), 0xae426082);
});

test("placeholder is a valid 1x1 PNG with exact IHDR/IDAT CRCs", () => {
  const chunks = pngChunks(PLACEHOLDER_PNG);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "IDAT", "IEND"],
  );
  assert.deepEqual(pngDimensions(PLACEHOLDER_PNG), { width: 1, height: 1 });
  const crcOf = (chunk) =>
    Buffer.from(chunk.raw.subarray(chunk.raw.length - 4)).toString("hex");
  assert.equal(crcOf(chunks[0]), "1f15c489");
  assert.equal(crcOf(chunks[2]), "ae426082");
});

test("inject puts tEXt at chunk index 1, right after IHDR, with a hardcoded CRC", () => {
  const out = injectSnapshotText(PLACEHOLDER_PNG, "QUJD");
  const chunks = pngChunks(out);
  assert.deepEqual(
    chunks.map((c) => c.type),
    ["IHDR", "tEXt", "IDAT", "IEND"],
  );
  assert.equal(
    Buffer.from(chunks[1].data).toString("latin1"),
    "buzz_agent_snapshot\u0000QUJD",
  );
  assert.equal(
    Buffer.from(chunks[1].raw.subarray(chunks[1].raw.length - 4)).toString(
      "hex",
    ),
    crc32(chunks[1].raw.subarray(4, chunks[1].raw.length - 4))
      .toString(16)
      .padStart(8, "0"),
  );
  assert.equal(
    Buffer.from(chunks[1].raw.subarray(chunks[1].raw.length - 4)).toString(
      "hex",
    ),
    // Cross-checked with python zlib.crc32(b"tEXtbuzz_agent_snapshot\0QUJD").
    "650ce3a8",
  );
});

test("a prior buzz_agent_snapshot chunk is stripped; other text survives", () => {
  const other = makeChunk(
    "tEXt",
    new TextEncoder().encode("Comment\u0000keep me"),
  );
  const first = injectSnapshotText(PLACEHOLDER_PNG, "T0xE");
  const chunks = pngChunks(first);
  const withOther = Buffer.concat([
    first.subarray(0, 8),
    chunks[0].raw,
    chunks[1].raw,
    other,
    ...chunks.slice(2).map((c) => c.raw),
  ]);
  const again = injectSnapshotText(new Uint8Array(withOther), "TkVX");
  const texts = pngChunks(again)
    .filter((c) => c.type === "tEXt")
    .map((c) => Buffer.from(c.data).toString("latin1"));
  assert.deepEqual(texts, [
    "buzz_agent_snapshot\u0000TkVX",
    "Comment\u0000keep me",
  ]);
});

test("encodeSnapshotPng output decodes through decodeSnapshotBytes", () => {
  const png = encodeSnapshotPng(new TextEncoder().encode(MANIFEST), null);
  const decoded = decodeSnapshotBytes(png);
  assert.equal(decoded.kind, "agent");
  assert.equal(decoded.snapshot.displayName, "P");
});

test("an oversize avatar falls back to the placeholder body", () => {
  const big = Buffer.from(PLACEHOLDER_PNG);
  // Patch IHDR width to 513 and fix its CRC.
  const ihdr = new Uint8Array(big.subarray(16, 29));
  ihdr[2] = 0x02;
  ihdr[3] = 0x01;
  const patched = Buffer.concat([
    big.subarray(0, 8),
    makeChunk("IHDR", ihdr),
    big.subarray(33),
  ]);
  assert.deepEqual(pngDimensions(new Uint8Array(patched)), {
    width: 513,
    height: 1,
  });
  const out = encodeSnapshotPng(new TextEncoder().encode(MANIFEST), patched);
  assert.deepEqual(pngDimensions(out), { width: 1, height: 1 });
  // A small avatar is used as the body.
  const small = encodeSnapshotPng(
    new TextEncoder().encode(MANIFEST),
    PLACEHOLDER_PNG,
  );
  assert.equal(pngChunks(small)[1].type, "tEXt");
});

test("dimensions: non-PNG is null", () => {
  assert.equal(pngDimensions(new TextEncoder().encode("{}")), null);
  assert.equal(b64("x"), "eA==");
});
