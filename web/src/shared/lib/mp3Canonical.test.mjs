import assert from "node:assert/strict";
import { test } from "node:test";
import {
  containsId3v2Header,
  frameLength,
  isMp3Upload,
  looksLikeMpegAudio,
  stripMp3Tags,
} from "./mp3Canonical.ts";

// Fixtures mirror crates/buzz-media/src/mp3.rs tests.

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz → 417-byte frames. */
const FRAME_HDR = [0xff, 0xfb, 0x90, 0x00];
const FRAME_LEN = 417;

function cleanMp3(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(...FRAME_HDR);
    for (let j = 0; j < FRAME_LEN - 4; j += 1) {
      out.push((i * 7 + j) % 0x7f);
    }
  }
  return Uint8Array.from(out);
}

const bytesOf = (text) => Array.from(text, (c) => c.charCodeAt(0));

function id3v2(bodyLen, footer) {
  const s = [
    (bodyLen >> 21) & 0x7f,
    (bodyLen >> 14) & 0x7f,
    (bodyLen >> 7) & 0x7f,
    bodyLen & 0x7f,
  ];
  const body = bytesOf("TPE1\0\0\0\x09\0\0\x03Sam G");
  while (body.length < bodyLen) body.push(0);
  body.length = bodyLen;
  const tag = [...bytesOf("ID3"), 4, 0, footer ? 0x10 : 0, ...s, ...body];
  if (footer) tag.push(...bytesOf("3DI"), 4, 0, 0x10, ...s);
  return tag;
}

function id3v1() {
  const tag = bytesOf("TAGSecret Title");
  while (tag.length < 128) tag.push(0x20);
  return tag;
}

function apeTag() {
  const items = bytesOf("\x05\0\0\0\0\0\0\0Title\0hello");
  const size = items.length + 32;
  const le = (v) => [
    v & 0xff,
    (v >> 8) & 0xff,
    (v >> 16) & 0xff,
    (v >>> 24) & 0xff,
  ];
  const block = (flags) => [
    ...bytesOf("APETAGEX"),
    ...le(2000),
    ...le(size),
    ...le(1),
    ...le(flags),
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  return [...block(0xa0000000), ...items, ...block(0x80000000)];
}

const cat = (...parts) => Uint8Array.from(parts.flatMap((p) => Array.from(p)));

test("frame lengths follow the spec formulas", () => {
  assert.equal(frameLength(Uint8Array.from(FRAME_HDR)), 417);
  assert.equal(frameLength(Uint8Array.from([0xff, 0xfb, 0x92, 0x00])), 418);
  assert.equal(frameLength(Uint8Array.from([0xff, 0xf3, 0x80, 0x00])), 208);
  for (const bad of [
    [0xff, 0xfb, 0x00, 0x00], // free-format
    [0xff, 0xfb, 0xf0, 0x00], // bitrate 15
    [0xff, 0xeb, 0x90, 0x00], // reserved version
    [0xff, 0xf9, 0x90, 0x00], // layer 0 (AAC ADTS)
    [0xff, 0xfb, 0x9c, 0x00], // reserved rate
    [0xff, 0xfb, 0x90, 0x02], // reserved emphasis
    [0xff, 0x1b, 0x90, 0x00], // no sync
  ]) {
    assert.equal(frameLength(Uint8Array.from(bad)), null, String(bad));
  }
});

test("a clean MP3 passes through unchanged", () => {
  const clean = cleanMp3(5);
  assert.deepEqual(stripMp3Tags(clean), clean);
});

test("leading ID3v2 (repeated, footer-flagged) is stripped", () => {
  const clean = cleanMp3(4);
  assert.deepEqual(stripMp3Tags(cat(id3v2(300, false), clean)), clean);
  assert.deepEqual(
    stripMp3Tags(cat(id3v2(64, true), id3v2(32, false), clean)),
    clean,
  );
});

test("trailing ID3v1, TAG+, APEv2, Lyrics3v2 and tail ID3v2 are stripped", () => {
  const clean = cleanMp3(4);
  const enhanced = bytesOf("TAG+");
  while (enhanced.length < 227) enhanced.push(0x78);
  const lyrics = bytesOf("LYRICSBEGININD00002");
  const size = String(lyrics.length).padStart(6, "0");
  lyrics.push(...bytesOf(size), ...bytesOf("LYRICS200"));
  assert.deepEqual(
    stripMp3Tags(cat(clean, apeTag(), lyrics, enhanced, id3v1())),
    clean,
  );
  assert.deepEqual(stripMp3Tags(cat(clean, id3v2(20, true))), clean);
});

test("the stripped bytes carry none of the tag text", () => {
  const out = stripMp3Tags(cat(id3v2(64, false), cleanMp3(3), id3v1()));
  const text = new TextDecoder("latin1").decode(out);
  assert.ok(!text.includes("Sam G") && !text.includes("Secret"));
});

test("an ID3 header inside the stream is rejected", () => {
  assert.throws(
    () => stripMp3Tags(cat(cleanMp3(2), id3v2(40, false), cleanMp3(2))),
    /embedded/,
  );
  const inside = cleanMp3(3);
  inside.set(id3v2(0, false).slice(0, 10), 500);
  assert.ok(containsId3v2Header(inside));
  assert.throws(() => stripMp3Tags(inside), /embedded/);
});

test("garbage and empty input are rejected", () => {
  const garbage = Uint8Array.from({ length: 4096 }, (_, i) => (i * 31) % 251);
  assert.throws(() => stripMp3Tags(garbage), /no audio frames/);
  assert.throws(
    () => stripMp3Tags(cat(id3v2(16, false), garbage)),
    /no audio frames/,
  );
  assert.throws(() => stripMp3Tags(new Uint8Array()), /no audio frames/);
  assert.equal(looksLikeMpegAudio(garbage), false);
});

test("junk after the frames is rejected; zero padding is trimmed", () => {
  const clean = cleanMp3(3);
  assert.throws(
    () => stripMp3Tags(cat(clean, bytesOf("hidden channel"))),
    /unrecognized bytes/,
  );
  assert.deepEqual(stripMp3Tags(cat(clean, new Uint8Array(64))), clean);
});

test("isMp3Upload trusts the browser MIME, else sniffs octet-stream bytes", () => {
  const clean = cleanMp3(2);
  assert.equal(isMp3Upload(new Uint8Array(), "audio/mpeg"), true);
  assert.equal(isMp3Upload(new Uint8Array(), "audio/mp3"), true);
  assert.equal(isMp3Upload(clean, ""), true);
  assert.equal(
    isMp3Upload(cat(id3v2(8, false)), "application/octet-stream"),
    true,
  );
  assert.equal(isMp3Upload(clean, "application/pdf"), false);
  assert.equal(isMp3Upload(bytesOf("hello"), ""), false);
});
