import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildUplinkFrame,
  parseDownlinkFrame,
  rmsToDbov,
} from "./huddleWire.ts";

test("uplink frame round-trips through the downlink parser (v3 prefix)", () => {
  const opus = new Uint8Array([0xaa, 0xbb, 0xcc]);
  const up = buildUplinkFrame(513, 96_000, -22, opus);
  // The server prefixes [peerIndex, epoch] on fan-out.
  const down = new Uint8Array(2 + up.length);
  down[0] = 7;
  down[1] = 3;
  down.set(up, 2);
  const parsed = parseDownlinkFrame(down.buffer);
  assert.equal(parsed.peerIndex, 7);
  assert.equal(parsed.epoch, 3);
  assert.equal(parsed.seq, 513);
  assert.equal(parsed.ts48k, 96_000);
  assert.equal(parsed.levelDbov, -22);
  assert.equal(parsed.dtx, false);
  assert.deepEqual([...parsed.opus], [0xaa, 0xbb, 0xcc]);
});

test("seq wraps at 16 bits and ts at 32 bits", () => {
  const frame = buildUplinkFrame(
    65_536 + 9,
    4_294_967_296 + 100,
    -10,
    new Uint8Array(1),
  );
  const down = new Uint8Array(2 + frame.length);
  down.set(frame, 2);
  const parsed = parseDownlinkFrame(down.buffer);
  assert.equal(parsed.seq, 9, "seq wraps to 9");
  assert.equal(parsed.ts48k, 100, "ts wraps to 100");
});

test("level is clamped into [-127, 0]; DTX flag parses; shorts are null", () => {
  const loud = buildUplinkFrame(1, 0, 30, new Uint8Array(1));
  const quiet = buildUplinkFrame(1, 0, -500, new Uint8Array(1));
  const wrap = (f) => {
    const d = new Uint8Array(2 + f.length);
    d.set(f, 2);
    return parseDownlinkFrame(d.buffer);
  };
  assert.equal(wrap(loud).levelDbov, 0, "positive clamps to 0");
  assert.equal(wrap(quiet).levelDbov, -127, "below-range clamps to -127");

  const dtx = buildUplinkFrame(2, 0, -30, new Uint8Array(2), 0x01);
  assert.equal(wrap(dtx).dtx, true);

  assert.equal(parseDownlinkFrame(new Uint8Array(9).buffer), null);
  assert.equal(parseDownlinkFrame(new ArrayBuffer(0)), null);
});

test("rmsToDbov maps RMS to dBov with the silence floor", () => {
  assert.equal(rmsToDbov(0), -127);
  assert.equal(rmsToDbov(-1), -127);
  // rms 1.0 = 0 dBov.
  assert.equal(rmsToDbov(1), 0);
  // rms 0.5 ≈ -6.02 dBov.
  assert.ok(Math.abs(rmsToDbov(0.5) - -6.0205999) < 0.001);
});
