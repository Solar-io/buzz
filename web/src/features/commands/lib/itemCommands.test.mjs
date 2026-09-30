import assert from "node:assert/strict";
import test from "node:test";

import { matchCommands, paletteCommands, resolveCommand } from "./commands.ts";
import { itemTitleError } from "./itemCommands.ts";
import { parseCommand } from "./parseCommand.ts";

const FLIGHT = "10000000-0000-4000-8000-000000000004";

function context({ channel, items = true, project = null, verdict } = {}) {
  const calls = { file: [], sends: [] };
  const ctx = {
    channel:
      channel === undefined
        ? { id: FLIGHT, name: "flight-path", type: "stream" }
        : channel,
    selfPubkey: "a".repeat(64),
    messages: [],
    members: [],
    mentionPicks: new Map(),
    nowMs: 0,
    actions: {
      createReminder: async () => {},
      send: async (options) => {
        calls.sends.push(options);
        return { ok: true, message: "" };
      },
      openWorkForChannel: () => {},
      items: items
        ? {
            file: async (input) => {
              calls.file.push(input);
              return verdict ?? { ok: true };
            },
            projectFor: () => project,
          }
        : undefined,
    },
  };
  return { ctx, calls };
}

async function run(text, ctx) {
  const resolved = resolveCommand(parseCommand(text), ctx);
  assert.equal(resolved.kind, "known", text);
  return resolved.spec.run(ctx, resolved.args);
}

test("/bug and /backlog sit under Capture, and need an item host", () => {
  const { ctx } = context();
  assert.deepEqual(
    matchCommands("", ctx).map((command) => [command.id, command.group]),
    [
      ["bug", "capture"],
      ["backlog", "capture"],
      ["remind", "capture"],
      ["handoff", "agents"],
      ["status", "agents"],
    ],
  );
  assert.deepEqual(
    matchCommands("b", ctx).map((command) => command.id),
    ["bug", "backlog"],
  );
  // No host: not offered, and typed anyway it is unknown — never text.
  const bare = context({ items: false }).ctx;
  assert.deepEqual(resolveCommand(parseCommand("/bug it broke"), bare), {
    kind: "unknown",
    name: "bug",
  });
  // Both are offered in a DM too — a bug found there is still a bug.
  const dm = context({ channel: { id: "dm-1", name: "Gilfoyle", type: "dm" } });
  assert.deepEqual(
    matchCommands("b", dm.ctx).map((command) => command.id),
    ["bug", "backlog"],
  );
  // ⌘K offers them wherever a channel is open (it only prefills the box).
  assert.ok(
    paletteCommands({ channel: ctx.channel, selfPubkey: ctx.selfPubkey })
      .map((command) => command.id)
      .includes("backlog"),
  );
});

test("the rows name this channel's project when there is one", () => {
  const detail = (id, project) => {
    const { ctx } = context({ project });
    return matchCommands(id, ctx)[0].detail(ctx);
  };
  assert.equal(detail("bug", "Buzz web"), "File a bug in Buzz web");
  assert.equal(detail("bug", null), "File a bug from here");
  assert.equal(
    detail("backlog", "Buzz web"),
    "Add an item to the Buzz web backlog",
  );
  assert.equal(detail("backlog", null), "Add an item to the backlog");
});

test("/bug files a trimmed title in this channel", async () => {
  const { ctx, calls } = context();
  const result = await run("/bug   Composer drops the draft  ", ctx);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls.file, [
    { type: "bug", title: "Composer drops the draft", channelId: FLIGHT },
  ]);
  // Filing is not a chat send: the command itself never reaches `send`.
  assert.equal(calls.sends.length, 0);
  const backlog = context();
  await run("/backlog Jump autocomplete for channels", backlog.ctx);
  assert.equal(backlog.calls.file[0].type, "backlog");
});

test("an empty or over-long title is refused before anything is filed", async () => {
  const { ctx, calls } = context();
  assert.deepEqual(await run("/bug", ctx), {
    ok: false,
    error: "Say what broke: /bug <title>.",
  });
  assert.deepEqual(await run(`/backlog ${"x".repeat(201)}`, ctx), {
    ok: false,
    error:
      "Keep the title to 200 characters — this one is 201. Put the detail in the item afterwards.",
  });
  assert.equal(calls.file.length, 0);
  assert.equal(itemTitleError("bug", "x".repeat(200)), null);
  assert.equal(
    itemTitleError("backlog", " \u0085 "),
    "Say what to add: /backlog <item>.",
  );
});

test("the relay's refusal comes back verbatim", async () => {
  const { ctx } = context({
    verdict: { ok: false, error: "invalid: item: unknown event kind" },
  });
  assert.deepEqual(await run("/bug it broke", ctx), {
    ok: false,
    error: "invalid: item: unknown event kind",
  });
});
