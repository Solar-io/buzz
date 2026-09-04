import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildBanEvent,
  buildKickEvent,
  buildRemoveMessageEvent,
  buildTimeoutEvent,
  buildUnbanEvent,
  buildUntimeoutEvent,
  KIND_MODERATION_BAN,
  KIND_MODERATION_TIMEOUT,
  KIND_MODERATION_UNBAN,
  KIND_MODERATION_UNTIMEOUT,
  KIND_NIP29_DELETE_EVENT,
  KIND_NIP29_REMOVE_USER,
} from "./moderationCommands.ts";

const TARGET = "ab".repeat(32);
const EVENT_ID = "cd".repeat(32);
const CHANNEL = "3fa85f64-5717-4562-b3fc-2c963f66afa6";

function tagValue(event, name) {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

// Hardcoded, never derived from the constants they pin.
test("command kinds match crates/buzz-core/src/kind.rs", () => {
  assert.equal(KIND_MODERATION_BAN, 9040);
  assert.equal(KIND_MODERATION_UNBAN, 9041);
  assert.equal(KIND_MODERATION_TIMEOUT, 9042);
  assert.equal(KIND_MODERATION_UNTIMEOUT, 9043);
  assert.equal(KIND_NIP29_REMOVE_USER, 9001);
  assert.equal(KIND_NIP29_DELETE_EVENT, 9005);
});

test("9040-9043 carry NO h tag — they are community-global commands", () => {
  // `is_global_only_kind` rejects a stray h on 9040-9044 as channel-scoping a
  // global command, so this is a rejection the user would see, not a nicety.
  for (const event of [
    buildBanEvent({ pubkey: TARGET }),
    buildUnbanEvent(TARGET),
    buildTimeoutEvent({ pubkey: TARGET, expiresAt: 1_800_000_000 }),
    buildUntimeoutEvent(TARGET),
  ]) {
    assert.equal(
      event.tags.some((tag) => tag[0] === "h"),
      false,
      `kind ${event.kind} must not carry an h tag`,
    );
    assert.equal(tagValue(event, "p"), TARGET);
    assert.equal(event.content, "");
  }
});

test("a ban with no expiry is permanent — no expiration tag at all", () => {
  const permanent = buildBanEvent({ pubkey: TARGET });
  assert.equal(
    permanent.tags.some((tag) => tag[0] === "expiration"),
    false,
  );
  const temporary = buildBanEvent({ pubkey: TARGET, expiresAt: 1_800_000_000 });
  assert.equal(tagValue(temporary, "expiration"), "1800000000");
});

test("a ban reason is optional and trimmed away when blank", () => {
  assert.equal(
    tagValue(buildBanEvent({ pubkey: TARGET, reason: "  spam  " }), "reason"),
    "spam",
  );
  assert.equal(
    buildBanEvent({ pubkey: TARGET, reason: "   " }).tags.some(
      (tag) => tag[0] === "reason",
    ),
    false,
  );
});

test("a timeout requires a positive expiry and emits it in seconds", () => {
  const event = buildTimeoutEvent({ pubkey: TARGET, expiresAt: 1_800_000_123 });
  assert.equal(tagValue(event, "expiration"), "1800000123");
  // The relay requires the expiration tag on 9042 — a timeout with no expiry
  // would have no lift path.
  for (const bad of [0, -1, Number.NaN]) {
    assert.throws(
      () => buildTimeoutEvent({ pubkey: TARGET, expiresAt: bad }),
      /positive expiry/,
    );
  }
});

test("9001 kick is channel-scoped: h + p", () => {
  const event = buildKickEvent({ channelId: CHANNEL, pubkey: TARGET });
  assert.equal(event.kind, 9001);
  assert.equal(tagValue(event, "h"), CHANNEL);
  assert.equal(tagValue(event, "p"), TARGET);
});

test("9005 removal names exactly one target, in the h channel", () => {
  const event = buildRemoveMessageEvent({
    channelId: CHANNEL,
    targetEventId: EVENT_ID,
  });
  assert.equal(event.kind, 9005);
  assert.equal(tagValue(event, "h"), CHANNEL);
  // Ingest rejects a deletion whose (e + a) target count is not exactly 1.
  assert.equal(event.tags.filter((tag) => tag[0] === "e").length, 1);
  assert.equal(event.tags.filter((tag) => tag[0] === "a").length, 0);
  assert.equal(tagValue(event, "e"), EVENT_ID);
});

test("a removal's public_reason rides through to the tombstone", () => {
  const event = buildRemoveMessageEvent({
    channelId: CHANNEL,
    targetEventId: EVENT_ID,
    publicReason: "  Removed for spam.  ",
    reasonCode: "spam",
  });
  assert.equal(tagValue(event, "public_reason"), "Removed for spam.");
  assert.equal(tagValue(event, "reason_code"), "spam");
  // Absent when not supplied — a bare self-delete must stay on the relay's
  // self-delete fast path (`author_delete_can_use_self_delete_path` treats any
  // moderation metadata as opting out of it).
  const bare = buildRemoveMessageEvent({
    channelId: CHANNEL,
    targetEventId: EVENT_ID,
  });
  assert.equal(
    bare.tags.some(
      (tag) => tag[0] === "public_reason" || tag[0] === "reason_code",
    ),
    false,
  );
});

test("malformed targets throw rather than shipping an invalid command", () => {
  assert.throws(() => buildBanEvent({ pubkey: "nope" }), /target pubkey/);
  assert.throws(
    () => buildKickEvent({ channelId: "not-a-uuid", pubkey: TARGET }),
    /channel id/,
  );
  assert.throws(
    () =>
      buildRemoveMessageEvent({
        channelId: CHANNEL,
        targetEventId: "short",
      }),
    /target event id/,
  );
});
