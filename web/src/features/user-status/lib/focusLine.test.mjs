import assert from "node:assert/strict";
import { test } from "node:test";
import { focusLine, focusToken, MAX_AGE_SECONDS } from "./focusLine.ts";
import { parseUserStatusEvent } from "./statusEvent.ts";

// A literal kind-30315 event captured off the live relay on 2026-09-07
// (status set 2026-09-07T02:21Z). The wire copy also carried an `auth` tag
// put there by the NIP-42 relay transport; parseUserStatusEvent reads only
// pubkey/content/created_at/tags, and the first test below pins that the
// stripped shape still parses — the fixture is ground truth, not the parser.
const LIVE_EVENT = {
  content: "buzz-ui",
  created_at: 1_788_747_698,
  id: "a331cd26c399ecb3df8d3f2bb70fa0da2c244d36dff763d55c5ff89ca87fd743",
  kind: 30315,
  pubkey: "d7fef83c5ed2dd2990c213abb9729e48daf5cfee249a7ee8aa72aa6bc56d5961",
  sig: "1deef872286bd62e5b536f221e4deaab633ee4db35cc14fde3e63b612f8ea5a747da27bc40f008ea5d155632a95f04a618a81e8c845ca14f3bb4ce4a2a28d5ad",
  tags: [
    ["d", "general"],
    ["emoji", "🔧"],
  ],
};

const SET_AT = LIVE_EVENT.created_at;

/** The fixture's status, always via the REAL parser — never hand-built. */
function liveStatus() {
  return parseUserStatusEvent(LIVE_EVENT).status;
}

// ── Fixture ground truth ────────────────────────────────────────────────────

test("the live relay fixture parses through the real parser, no auth tag needed", () => {
  assert.deepEqual(liveStatus(), {
    text: "buzz-ui",
    emoji: "🔧",
    updatedAt: 1_788_747_698,
    expiresAt: null,
  });
});

test("the live fixture renders its label and a 2h age two hours on", () => {
  assert.deepEqual(focusLine(liveStatus(), SET_AT + 7_200), {
    label: "🔧 buzz-ui",
    age: "2h",
  });
});

// ── Absence renders nothing ─────────────────────────────────────────────────

test("no status renders nothing", () => {
  assert.equal(focusLine(null, SET_AT + 60), null);
  assert.equal(focusLine(undefined, SET_AT + 60), null);
});

test("the clear event (empty content, no emoji) renders nothing", () => {
  // The shape `buzz users set-status --clear` publishes; the real parser
  // folds it to "no status", so the focus line must too.
  const cleared = parseUserStatusEvent({
    ...LIVE_EVENT,
    content: "",
    tags: [["d", "general"]],
  });
  assert.equal(cleared.status, null);
  assert.equal(focusLine(cleared.status, SET_AT + 60), null);
});

test("a status on the wrong d coordinate renders nothing", () => {
  // NIP-38 also defines d:music; it is not the profile focus line.
  const music = parseUserStatusEvent({
    ...LIVE_EVENT,
    tags: [
      ["d", "music"],
      ["emoji", "🔧"],
    ],
  });
  assert.equal(music.status, null);
  assert.equal(focusLine(music.status, SET_AT + 60), null);
});

// ── Staleness boundary ──────────────────────────────────────────────────────
// The boundary offsets are written as LITERALS, not as MAX_AGE_SECONDS ± 1 —
// an expectation derived from the constant would follow a mutated constant
// and stay green. The constant itself is pinned to the documented 24h above.

test("the staleness window is 24 hours", () => {
  assert.equal(MAX_AGE_SECONDS, 86_400);
});

test("a status exactly 24h old renders nothing", () => {
  assert.equal(focusLine(liveStatus(), SET_AT + 86_400), null);
});

test("a status one second under 24h still renders", () => {
  const line = focusLine(liveStatus(), SET_AT + 86_399);
  assert.equal(line.label, "🔧 buzz-ui");
  assert.equal(line.age, "23h");
});

// ── Age buckets ─────────────────────────────────────────────────────────────

test("59 minutes reads as minutes", () => {
  assert.equal(focusLine(liveStatus(), SET_AT + 59 * 60).age, "59m");
});

test("61 minutes reads as whole hours", () => {
  assert.equal(focusLine(liveStatus(), SET_AT + 61 * 60).age, "1h");
});

test("25 hours is past the window and renders nothing", () => {
  assert.equal(focusLine(liveStatus(), SET_AT + 25 * 3_600), null);
});

test("a just-set status reads as 0m", () => {
  assert.equal(focusLine(liveStatus(), SET_AT).age, "0m");
});

test("a clock skewed into the future never shows a negative age", () => {
  assert.equal(focusLine(liveStatus(), SET_AT - 30).age, "0m");
});

// ── Label shape via the real parser ─────────────────────────────────────────

test("a text-only status labels as the bare text", () => {
  const status = parseUserStatusEvent({
    ...LIVE_EVENT,
    content: "noet",
    tags: [["d", "general"]],
  }).status;
  assert.deepEqual(focusLine(status, SET_AT + 3_600), {
    label: "noet",
    age: "1h",
  });
});

// ── focusToken: the DM row's text-only read ─────────────────────────────────
// The DM row shows the bare project token — no emoji, no age suffix (the
// row carries its own times on the right; Sam, 2026-09-06). The live
// fixture HAS an emoji tag, so these tests prove the strip, not just the
// pass-through.

test("focusToken returns the bare text: no emoji, no age", () => {
  assert.equal(focusToken(liveStatus(), SET_AT + 7_200), "buzz-ui");
});

test("focusToken keeps the same 24h window as focusLine", () => {
  assert.equal(focusToken(liveStatus(), SET_AT + 86_400), null);
  assert.equal(focusToken(liveStatus(), SET_AT + 86_399), "buzz-ui");
});

test("an emoji-only status parses but has no text token", () => {
  // Blank text WITH an emoji is a valid status (only neither-at-once is the
  // clear event) — the roster would show the emoji; a text-only surface has
  // nothing to say.
  const emojiOnly = parseUserStatusEvent({
    ...LIVE_EVENT,
    content: "",
    tags: [
      ["d", "general"],
      ["emoji", "🔥"],
    ],
  }).status;
  assert.ok(emojiOnly !== null);
  assert.equal(emojiOnly.emoji, "🔥");
  assert.equal(focusToken(emojiOnly, SET_AT + 60), null);
});

test("focusToken renders nothing for absent status", () => {
  assert.equal(focusToken(null, SET_AT + 60), null);
  assert.equal(focusToken(undefined, SET_AT + 60), null);
});
