import assert from "node:assert/strict";
import { test } from "node:test";
import { attributeCallLines, hasCallLines } from "./callLines.ts";
import { timelineMessageFromEvent } from "./messageBuffer.ts";

// Voice-call lines the relay mirrors into the main chat (buzz-relay
// audio/transcript.rs): relay-signed kind:9, ["buzz-system","call-line"],
// ["actor", <speaker>]. They must render as the SPEAKER's message — but only
// on the relay's own signature, never on a tag a client wrote.

const RELAY = "7".repeat(64);
const SAM = "5".repeat(64);
const AGENT = "a".repeat(64);
const IMPOSTOR = "9".repeat(64);

let seq = 0;
function message({
  pubkey = RELAY,
  actor = SAM,
  system = "call-line",
  content = "which drill should I buy?",
} = {}) {
  seq += 1;
  const tags = [["h", "chan"]];
  if (actor) tags.push(["actor", actor]);
  if (system) tags.push(["buzz-system", system]);
  return timelineMessageFromEvent({
    id: seq.toString(16).padStart(64, "0"),
    pubkey,
    created_at: 1_000 + seq,
    kind: 9,
    content,
    tags,
    sig: "f".repeat(128),
  });
}

test("a relay-signed call line is attributed to its speaker", () => {
  const sam = message();
  const agent = message({ actor: AGENT, content: "The DeWalt 20V." });
  const out = attributeCallLines([sam, agent], RELAY);
  assert.deepEqual(
    out.map((m) => [m.authorPubkey, m.content]),
    [
      [SAM, "which drill should I buy?"],
      [AGENT, "The DeWalt 20V."],
    ],
  );
  // Only the author changes: no call-only field rides along for the row to
  // render as a marker (Sam, 2026-10-01).
  assert.deepEqual(out[0], { ...sam, authorPubkey: SAM });
  // The source rows (store/cache) keep the signed author.
  assert.equal(sam.authorPubkey, RELAY);
});

test("relay key compared case-insensitively", () => {
  const out = attributeCallLines([message()], RELAY.toUpperCase());
  assert.equal(out[0].authorPubkey, SAM);
});

test("an impostor's call-line tags are ignored: the row keeps its signer", () => {
  // An agent signing its OWN event with an actor tag naming Sam (relay
  // ingest rejects buzz-system from clients too; this is the second fence).
  const forged = message({ pubkey: IMPOSTOR });
  const out = attributeCallLines([forged], RELAY);
  assert.equal(out[0], forged, "the row is returned untouched");
});

test("other relay-signed rows are untouched", () => {
  const transcript = message({ system: "call-transcript" });
  const noActor = message({ actor: null });
  const untagged = message({ system: null });
  const input = [transcript, noActor, untagged];
  const out = attributeCallLines(input, RELAY);
  assert.equal(out, input, "nothing changed → same array (memo stability)");
  assert.ok(out.every((m) => m.authorPubkey === RELAY));
});

test("without the relay key nothing is attributed", () => {
  const input = [message()];
  assert.equal(attributeCallLines(input, null), input);
  assert.equal(input[0].authorPubkey, RELAY);
});

test("hasCallLines gates the NIP-11 read", () => {
  assert.equal(hasCallLines([message()]), true);
  assert.equal(hasCallLines([message({ system: "call-transcript" })]), false);
  assert.equal(hasCallLines([]), false);
});

test("actor tag is parsed only as a 64-hex pubkey", () => {
  assert.equal(message({ actor: "nope" }).actorPubkey, null);
  assert.equal(message({ actor: SAM.toUpperCase() }).actorPubkey, SAM);
});
