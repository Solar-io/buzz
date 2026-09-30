import assert from "node:assert/strict";
import test from "node:test";

import {
  availableCommands,
  COMMANDS,
  matchCommands,
  remindTarget,
  resolveCommand,
} from "./commands.ts";
import { parseCommand } from "./parseCommand.ts";

const SELF = "a".repeat(64);
const NIKON = "b".repeat(64);
const GILFOYLE = "c".repeat(64);
const CHANNEL = "chan-1";

/** Local wall-clock instant (ms): Wed 30 Sep 2026, 3:42 PM. */
const NOW = new Date(2026, 8, 30, 15, 42, 0, 0).getTime();

function message(id, authorPubkey, overrides = {}) {
  return {
    id,
    channelId: CHANNEL,
    authorPubkey,
    createdAt: 100,
    content: `content of ${id}`,
    kind: 9,
    mentionPubkeys: [],
    ...overrides,
  };
}

function context(overrides = {}) {
  const calls = { reminders: [], sends: [], work: [] };
  const ctx = {
    channel: { id: CHANNEL, name: "flight-path", type: "stream" },
    selfPubkey: SELF,
    messages: [],
    members: [
      { pubkey: SELF, name: "Sam" },
      { pubkey: NIKON, name: "Lord Nikon" },
      { pubkey: GILFOYLE, name: "Gilfoyle" },
    ],
    mentionPicks: new Map(),
    nowMs: NOW,
    actions: {
      createReminder: async (input) => {
        calls.reminders.push(input);
      },
      send: async (options) => {
        calls.sends.push(options);
        return { ok: true, message: "" };
      },
      openWorkForChannel: (id) => {
        calls.work.push(id);
      },
    },
    ...overrides,
  };
  return { ctx, calls };
}

async function run(text, ctx) {
  const resolved = resolveCommand(parseCommand(text), ctx);
  assert.equal(resolved.kind, "known", text);
  return resolved.spec.run(ctx, resolved.args);
}

test("the registry ships exactly remind, handoff and status", () => {
  assert.deepEqual(
    COMMANDS.map((command) => command.id),
    ["remind", "handoff", "status"],
  );
  // No channel open: nothing is offered, so nothing can lie.
  const { ctx } = context({ channel: null });
  assert.deepEqual(availableCommands(ctx), []);
});

test("matchCommands filters by the typed prefix", () => {
  const { ctx } = context();
  assert.deepEqual(
    matchCommands("", ctx).map((command) => command.id),
    ["remind", "handoff", "status"],
  );
  assert.deepEqual(
    matchCommands("re", ctx).map((command) => command.id),
    ["remind"],
  );
  assert.deepEqual(matchCommands("x", ctx), []);
});

test("an unknown command resolves to unknown, never to text", () => {
  const { ctx } = context();
  assert.deepEqual(resolveCommand(parseCommand("/remnid 2h"), ctx), {
    kind: "unknown",
    name: "remnid",
  });
  // /new is a later phase: until it ships it is unknown, not a message.
  assert.deepEqual(resolveCommand(parseCommand("/new scratch"), ctx), {
    kind: "unknown",
    name: "new",
  });
  // A known command outside its context is unknown too.
  const closed = context({ channel: null }).ctx;
  assert.deepEqual(resolveCommand(parseCommand("/status"), closed), {
    kind: "unknown",
    name: "status",
  });
});

test("remindTarget is the newest message from someone else that mentions me", () => {
  const messages = [
    message("m1", NIKON, { mentionPubkeys: [SELF] }),
    message("m2", GILFOYLE),
    message("m3", SELF, { mentionPubkeys: [SELF] }),
    message("m4", NIKON, { mentionPubkeys: [SELF], deleted: true }),
    message("m5", GILFOYLE, { mentionPubkeys: [SELF], kind: 40099 }),
  ];
  assert.equal(remindTarget(messages, SELF, false).id, "m1");
  // In a DM every message from the other side is aimed at me.
  assert.equal(remindTarget(messages, SELF, true).id, "m2");
  assert.equal(remindTarget([message("x", SELF)], SELF, true), null);
  assert.equal(remindTarget(messages, null, true), null);
});

test("/remind files the target: +1 day by default, or the parsed time", async () => {
  const messages = [message("m1", NIKON, { mentionPubkeys: [SELF] })];
  const first = context({ messages });
  const result = await run("/remind", first.ctx);
  assert.equal(result.ok, true);
  assert.match(result.notice, /^Reminder set for tomorrow 3:42/);
  assert.deepEqual(first.calls.reminders, [
    {
      target: {
        eventId: "m1",
        channelId: CHANNEL,
        preview: "content of m1",
        authorPubkey: NIKON,
      },
      notBefore: NOW / 1000 + 86_400,
    },
  ]);

  const timed = context({ messages });
  await run("/remind 2h", timed.ctx);
  assert.equal(timed.calls.reminders[0].notBefore, NOW / 1000 + 7_200);
});

test("/remind refuses an unreadable time and an empty room, and files nothing", async () => {
  const messages = [message("m1", NIKON, { mentionPubkeys: [SELF] })];
  const junk = context({ messages });
  const bad = await run("/remind whenever", junk.ctx);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /can't read "whenever"/);
  assert.deepEqual(junk.calls.reminders, []);

  const empty = context();
  const none = await run("/remind", empty.ctx);
  assert.equal(none.ok, false);
  assert.match(none.error, /Nothing here is aimed at you/);
  assert.deepEqual(empty.calls.reminders, []);
});

test("/remind surfaces a failed publish as its error", async () => {
  const { ctx } = context({
    messages: [message("m1", NIKON, { mentionPubkeys: [SELF] })],
  });
  ctx.actions.createReminder = async () => {
    throw new Error("relay: rate limited");
  };
  assert.deepEqual(await run("/remind", ctx), {
    ok: false,
    error: "relay: rate limited",
  });
});

test("/handoff needs a resolved seat and a task, and tags the seat", async () => {
  const { ctx, calls } = context();
  const result = await run("/handoff @Lord Nikon final capture pass", ctx);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.sends, [
    {
      content: "@Lord Nikon final capture pass",
      mentionPubkeys: [NIKON],
      threadRef: null,
      mediaTags: [["handoff", NIKON]],
    },
  ]);

  // Another mention inside the task is tagged too; the seat stays first.
  const second = context();
  await run("/handoff @gilfoyle sync with @Lord Nikon first", second.ctx);
  assert.deepEqual(second.calls.sends[0].mentionPubkeys, [GILFOYLE, NIKON]);
  assert.deepEqual(second.calls.sends[0].mediaTags, [["handoff", GILFOYLE]]);
  assert.equal(
    second.calls.sends[0].content,
    "@gilfoyle sync with @Lord Nikon first",
  );
});

test("/handoff sends nothing without a seat, an unknown seat, or a task", async () => {
  for (const [text, pattern] of [
    ["/handoff", /Name the seat first/],
    ["/handoff capture pass", /Name the seat first/],
    ["/handoff @Nobody capture pass", /isn't one member/],
    ["/handoff @Lord Nikon", /Say what to hand off/],
  ]) {
    const { ctx, calls } = context();
    const result = await run(text, ctx);
    assert.equal(result.ok, false, text);
    assert.match(result.error, pattern, text);
    assert.deepEqual(calls.sends, [], text);
  }
});

test("/handoff reports the relay's refusal verbatim", async () => {
  const { ctx } = context();
  ctx.actions.send = async () => ({
    ok: false,
    message: "restricted: mentioned pubkeys are not channel members",
  });
  assert.deepEqual(await run("/handoff @Lord Nikon capture", ctx), {
    ok: false,
    error: "restricted: mentioned pubkeys are not channel members",
  });
});

test("/status opens Work for this channel and sends nothing", async () => {
  const { ctx, calls } = context();
  assert.deepEqual(await run("/status", ctx), { ok: true });
  assert.deepEqual(calls.work, [CHANNEL]);
  assert.deepEqual(calls.sends, []);
});
