import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalizeImage } from "./mediaCanonical.ts";

function seg(marker, payload) {
  const len = payload.length + 2;
  return [0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload];
}

// Exactly 14 bytes: JFIF\0 + version(2) + units(1) + densities(4) + thumbnail 0x0(2).
const canonicalJfif = [
  ...Array.from("JFIF").map((c) => c.charCodeAt(0)),
  0x00,
  1,
  1,
  0,
  0,
  1,
  0,
  1,
  0,
  0,
];
assert.equal(canonicalJfif.length, 14);

function jpegWithSegments(...segments) {
  return Uint8Array.from([0xff, 0xd8, ...segments.flat(), 0xff, 0xd9]);
}

test("drops EXIF APP1 and COM, keeps canonical JFIF and structure", () => {
  const input = jpegWithSegments(
    seg(0xe0, canonicalJfif),
    seg(0xe1, [1, 2, 3]), // EXIF — forbidden
    seg(0xdb, [0x00, 0x43, 1, 2]), // DQT — keep
    seg(0xfe, [9]), // COM — forbidden
  );
  const out = canonicalizeImage(input, "image/jpeg");
  assert.ok(out);
  const outHex = Array.from(out)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.ok(outHex.startsWith("ffd8ffe0"), "SOI + APP0 kept");
  assert.ok(!outHex.includes("ffe1"), "APP1 dropped");
  assert.ok(!outHex.includes("fffe"), "COM dropped");
  assert.ok(outHex.includes("ffdb"), "DQT kept");
  assert.ok(outHex.endsWith("ffd9"), "EOI kept");
});

test("non-canonical APP0 is dropped", () => {
  const input = jpegWithSegments(seg(0xe0, [1, 2, 3, 4, 5, 6]));
  const out = canonicalizeImage(input, "image/jpeg");
  const outHex = Array.from(out ?? [])
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.ok(out);
  assert.ok(!outHex.includes("ffe0"), "bad APP0 dropped");
});

test("Adobe APP14 of exactly 12 payload bytes is kept", () => {
  const adobe = [
    ...Array.from("Adobe").map((c) => c.charCodeAt(0)),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  assert.equal(adobe.length, 12);
  const input = jpegWithSegments(seg(0xee, adobe));
  const out = canonicalizeImage(input, "image/jpeg");
  const outHex = Array.from(out ?? [])
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.ok(out);
  assert.ok(outHex.includes("ffee"), "canonical Adobe kept");
});

test("scan data with stuffed markers survives", () => {
  const scan = seg(0xda, [0x01, 0x02]);
  const entropy = [0x12, 0xff, 0x00, 0x34, 0x56]; // ff00 = stuffed
  const input = Uint8Array.from([
    0xff,
    0xd8,
    ...seg(0xdb, [0, 1, 2]),
    ...scan,
    ...entropy,
    0xff,
    0xd9,
  ]);
  const out = canonicalizeImage(input, "image/jpeg");
  assert.ok(out);
  const outHex = Array.from(out)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  assert.ok(outHex.includes("ff0034"), "stuffed byte preserved");
  assert.ok(outHex.endsWith("ffd9"));
});

test("truncated or malformed JPEG returns null", () => {
  assert.equal(
    canonicalizeImage(Uint8Array.of(0xff, 0xd8, 0xff), "image/jpeg"),
    null,
  );
  assert.equal(canonicalizeImage(Uint8Array.of(1, 2, 3), "image/jpeg"), null);
});

function pngChunk(kind, payload) {
  const len = payload.length;
  const kindBytes = Array.from(kind).map((c) => c.charCodeAt(0));
  const crc = [0, 0, 0, 0];
  return [
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...kindBytes,
    ...payload,
    ...crc,
  ];
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

test("PNG: drops tEXt/iCCP/pHYs, keeps IHDR/IDAT/IEND/gAMA", () => {
  const input = Uint8Array.from([
    ...PNG_SIG,
    ...pngChunk("IHDR", [1, 2, 3, 4]),
    ...pngChunk("tEXt", [1, 2]),
    ...pngChunk("iCCP", [5]),
    ...pngChunk("pHYs", [9, 9]),
    ...pngChunk("gAMA", [0, 1]),
    ...pngChunk("IDAT", [0xaa, 0xbb]),
    ...pngChunk("IEND", []),
  ]);
  const out = canonicalizeImage(input, "image/png");
  assert.ok(out);
  const text = Buffer.from(out).toString("latin1");
  assert.ok(text.includes("IHDR"));
  assert.ok(text.includes("gAMA"));
  assert.ok(text.includes("IDAT"));
  assert.ok(text.includes("IEND"));
  assert.ok(!text.includes("tEXt"));
  assert.ok(!text.includes("iCCP"));
  assert.ok(!text.includes("pHYs"));
});

test("PNG: snapshot tEXt chunk is preserved", () => {
  const snap = [
    ...Array.from("buzz_agent_snapshot").map((c) => c.charCodeAt(0)),
    0,
    1,
    2,
  ];
  const input = Uint8Array.from([
    ...PNG_SIG,
    ...pngChunk("IHDR", [1]),
    ...pngChunk("tEXt", snap),
    ...pngChunk("IEND", []),
  ]);
  const out = canonicalizeImage(input, "image/png");
  assert.ok(out);
  assert.ok(
    Buffer.from(out).toString("latin1").includes("buzz_agent_snapshot"),
  );
});

test("a second snapshot tEXt chunk is dropped (relay allows one)", () => {
  const snap = [...Array.from("buzz_agent_snapshot").map((c) => c.charCodeAt(0)), 0, 1, 2];
  const input = Uint8Array.from([
    ...PNG_SIG,
    ...pngChunk("IHDR", [1]),
    ...pngChunk("tEXt", snap),
    ...pngChunk("tEXt", snap),
    ...pngChunk("IEND", []),
  ]);
  const out = canonicalizeImage(input, "image/png");
  assert.ok(out);
  const text = Buffer.from(out).toString("latin1");
  const occurrences = text.split("buzz_agent_snapshot").length - 1;
  assert.equal(occurrences, 1, "exactly one snapshot chunk survives");
});

test("non-image mime returns null (passthrough)", () => {
  assert.equal(canonicalizeImage(Uint8Array.of(1), "video/mp4"), null);
});
