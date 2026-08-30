import assert from "node:assert/strict";
import { test } from "node:test";
import { nsecEncode } from "nostr-tools/nip19";
import { channelFromEvent } from "../../channels/lib/channelFromEvent.ts";
import { dmDisplayName } from "./dmNaming.ts";
import {
  buildOtherParticipants,
  extractOpenDmChannelId,
  parsePubkeyInput,
} from "./dmInput.ts";
import { dmActivityFromEvents } from "./dmActivity.ts";

const SELF = "aa".repeat(32);
const SAM = "bb".repeat(32);
const EVIE = "cc".repeat(32);
const NIKON = "dd".repeat(32);
const PHREAK = "ee".repeat(32);

function event(overrides = {}) {
  return {
    id: "x".repeat(64),
    pubkey: SELF,
    created_at: 1_700_000_0000,
    kind: 39000,
    tags: [],
    content: "",
    sig: "y".repeat(128),
    ...overrides,
  };
}

test("channelFromEvent parses DM type and participants from relay tags", () => {
  const channel = channelFromEvent(
    event({
      tags: [
        ["d", "dm-uuid-1"],
        ["name", "DM"],
        ["t", "dm"],
        ["hidden"],
        ["p", SELF],
        ["p", SAM],
        ["closed"],
      ],
    }),
  );
  assert.equal(channel.type, "dm");
  assert.deepEqual(channel.participantPubkeys, [SELF, SAM]);
});

test("channelFromEvent defaults to stream with no participants for plain channels", () => {
  const channel = channelFromEvent(
    event({
      tags: [
        ["d", "general"],
        ["name", "general"],
        ["t", "stream"],
      ],
    }),
  );
  assert.equal(channel.type, "stream");
  assert.deepEqual(channel.participantPubkeys, []);
});

test("channelFromEvent keeps forum type distinct from dm", () => {
  const channel = channelFromEvent(
    event({
      tags: [
        ["d", "f1"],
        ["name", "Forum"],
        ["t", "forum"],
      ],
    }),
  );
  assert.equal(channel.type, "forum");
});

test("dmDisplayName excludes self and uses profile names", () => {
  const profiles = new Map([
    [SAM, { name: "Sam" }],
    [EVIE, { name: "Evie" }],
  ]);
  assert.equal(dmDisplayName([SELF, SAM], SELF, profiles), "Sam");
});

test("dmDisplayName prefers display_name when name is absent (Buzz profiles)", () => {
  // Sam's relay profile carries only display_name — the name-keyed path used
  // to render the truncated hex key in the sidebar instead of "Sam".
  const profiles = new Map([[SAM, { name: "25f1ade5", displayName: "Sam" }]]);
  assert.equal(dmDisplayName([SELF, SAM], SELF, profiles), "Sam");
});

test("dmDisplayName falls back to hex only with no profile at all", () => {
  const profiles = new Map();
  const label = dmDisplayName([SELF, SAM], SELF, profiles);
  assert.match(label, /^[0-9a-f]{8}…[0-9a-f]{4}$/);
});

test("dmDisplayName joins pairs and collapses bigger groups", () => {
  const profiles = new Map([
    [SAM, { name: "Sam" }],
    [EVIE, { name: "Evie" }],
    [NIKON, { name: "Lord Nikon" }],
    [PHREAK, { name: "Phreak" }],
  ]);
  assert.equal(dmDisplayName([SAM, SELF, EVIE], SELF, profiles), "Sam & Evie");
  assert.equal(
    dmDisplayName([SAM, EVIE, NIKON, PHREAK, SELF], SELF, profiles),
    "Sam, Evie +2",
  );
});

test("dmDisplayName falls back to truncated keys without profiles", () => {
  // SAM = "bb"×32 → canonical truncatePubkey form is first-8 + … + last-4.
  assert.equal(dmDisplayName([SAM], SELF, new Map()), "bbbbbbbb…bbbb");
});

test("parsePubkeyInput accepts hex and rejects junk", () => {
  const hex = parsePubkeyInput(SAM);
  assert.equal(hex.ok, true);
  assert.equal(hex.ok && hex.pubkey, SAM);
  assert.equal(parsePubkeyInput("zz").ok, false);
  assert.equal(parsePubkeyInput(SAM.slice(0, 63)).ok, false);
});

test("parsePubkeyInput rejects nsec with a specific message", () => {
  const result = parsePubkeyInput(nsecEncode(new Uint8Array(32).fill(7)));
  assert.equal(result.ok, false);
  assert.match(!result.ok && result.error, /SECRET key/);
});

test("buildOtherParticipants dedupes, drops self, enforces 1-8", () => {
  const ok = buildOtherParticipants([SAM, SAM, SELF, EVIE], SELF);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.ok && ok.pubkeys, [SAM, EVIE]);

  assert.equal(buildOtherParticipants([], SELF).ok, false);
  assert.equal(buildOtherParticipants([SELF], SELF).ok, false);
  const tooMany = buildOtherParticipants(
    ["b", "c", "d", "e", "f", "1", "2", "3", "4"].map((c) => c.repeat(64)),
    SELF,
  );
  assert.equal(tooMany.ok, false);
  assert.match(!tooMany.ok && tooMany.error, /at most 8/);
});

test("extractOpenDmChannelId reads the relay response envelope", () => {
  assert.equal(
    extractOpenDmChannelId(
      'response:{"channel_id":"0f0e0d0c-1111-2222-3333-444455556666","created":true}',
    ),
    "0f0e0d0c-1111-2222-3333-444455556666",
  );
  assert.equal(extractOpenDmChannelId("duplicate: already processed"), null);
  assert.equal(extractOpenDmChannelId(""), null);
  // An ok:true without the envelope (relay variant) must not crash or lie.
  assert.equal(extractOpenDmChannelId('{"accepted":true}'), null);
});

test("dmActivityFromEvents tracks the newest timestamp per DM", () => {
  const events = [
    event({
      kind: 9,
      created_at: 100,
      tags: [["h", "dm-1"]],
    }),
    event({
      kind: 9,
      created_at: 300,
      tags: [["h", "dm-1"]],
    }),
    event({
      kind: 9,
      created_at: 200,
      tags: [["h", "dm-2"]],
    }),
    event({
      kind: 9,
      created_at: 400,
      tags: [], // no h tag — ignored, not a crash
    }),
  ];
  const activity = dmActivityFromEvents(events);
  assert.equal(activity.get("dm-1"), 300);
  assert.equal(activity.get("dm-2"), 200);
  assert.equal(activity.size, 2);
});
