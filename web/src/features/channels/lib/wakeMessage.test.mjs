import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isScheduledWake,
  wakePreview,
  WAKE_SERVICE_PUBKEYS,
} from "./wakeMessage.ts";

/** The buzz-services reminder identity — the one sender that collapses. */
const SERVICE =
  "a9387088355b4efe46decbde77c8fe34ee9ecbd6619d41217d21be0123f08271";
/** Any other key — an agent self-wake booked through the service still fires
 * AS the service; a normal human/agent chat post never matches. */
const CHATTER =
  "43818e1d5328f0f1e521929fb1315f19ea3ec97c94fa23cc40b872dcbfb2012a";

test("kind-9 post from the services identity is a scheduled wake", () => {
  assert.equal(isScheduledWake({ authorPubkey: SERVICE, kind: 9 }), true);
});

test("kind-9 post from anyone else is conversation, not machinery", () => {
  assert.equal(isScheduledWake({ authorPubkey: CHATTER, kind: 9 }), false);
});

test("forum kinds from the services identity do NOT collapse — #alerts digests keep forum rendering", () => {
  assert.equal(isScheduledWake({ authorPubkey: SERVICE, kind: 45001 }), false);
  assert.equal(isScheduledWake({ authorPubkey: SERVICE, kind: 45003 }), false);
});

test("the default key set is exactly the services identity", () => {
  assert.deepEqual(WAKE_SERVICE_PUBKEYS, [SERVICE]);
});

test("wakePreview keeps a short one-liner verbatim", () => {
  assert.equal(
    wakePreview("continue: post-restart verify"),
    "continue: post-restart verify",
  );
});

test("wakePreview uses the FIRST line only — later lines never leak into the row", () => {
  assert.equal(
    wakePreview(
      "DWIGHT ROLL-UP (2h grid) — LEAD the message\n   with SHIPPED…",
    ),
    "DWIGHT ROLL-UP (2h grid) — LEAD the message",
  );
});

test("wakePreview squeezes space runs inside the first line", () => {
  assert.equal(
    wakePreview("continue:   check   the   pools"),
    "continue: check the pools",
  );
});

test("wakePreview truncates long first lines with an ellipsis and never exceeds the cap", () => {
  const long = "x".repeat(200);
  const out = wakePreview(long, 72);
  assert.ok(out.length <= 72, `expected <= 72 chars, got ${out.length}`);
  assert.ok(out.endsWith("…"));
  assert.equal(out.slice(0, -1), "x".repeat(71));
});

test("wakePreview of an empty/whitespace text is empty, not a stray newline", () => {
  assert.equal(wakePreview("   \n  \t "), "");
});
