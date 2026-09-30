import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_GROUP_LABEL,
  matchCommands,
  resolveCommand,
} from "./commands.ts";
import { parseCommand } from "./parseCommand.ts";

const PARENT = "10000000-0000-4000-8000-000000000004";
const SCRATCH = "30000000-0000-4000-8000-00000000000a";

function context(channel) {
  const calls = { create: [], exit: [], keep: [], sends: [] };
  const ctx = {
    channel,
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
      scratch: {
        create: async (input) => {
          calls.create.push(input);
          return { ok: true, notice: "opened" };
        },
        exit: async (input) => {
          calls.exit.push(input);
          return { ok: true };
        },
        keep: async (input) => {
          calls.keep.push(input);
          return { ok: false, error: "relay: not authorized" };
        },
      },
    },
  };
  return { ctx, calls };
}

const parent = { id: PARENT, name: "flight-path", type: "stream" };
const scratch = {
  id: SCRATCH,
  name: "flight-path-scratch-1",
  type: "stream",
  scratch: { parentId: PARENT, parentName: "flight-path", label: "scratch-1" },
};

async function run(text, ctx) {
  const resolved = resolveCommand(parseCommand(text), ctx);
  assert.equal(resolved.kind, "known", text);
  return resolved.spec.run(ctx, resolved.args);
}

test("/exit and /keep are offered only in a scratch channel; /new never in a DM", () => {
  const ids = (channel) =>
    matchCommands("", context(channel).ctx).map((command) => command.id);
  assert.deepEqual(ids(parent), ["new", "remind", "handoff", "status"]);
  assert.deepEqual(ids(scratch), [
    "new",
    "exit",
    "keep",
    "remind",
    "handoff",
    "status",
  ]);
  assert.deepEqual(ids({ id: "dm", name: "Gilfoyle", type: "dm" }), [
    "remind",
    "handoff",
    "status",
  ]);
  // Typed outside a scratch channel, /exit is unknown — never a message.
  assert.deepEqual(resolveCommand(parseCommand("/exit"), context(parent).ctx), {
    kind: "unknown",
    name: "exit",
  });
  assert.equal(COMMAND_GROUP_LABEL.channel, "This channel");
});

test("the composer's rows say what happens in this channel", () => {
  const detail = (channel, id) =>
    matchCommands(id, context(channel).ctx)[0].detail(context(channel).ctx);
  assert.equal(
    detail(scratch, "exit"),
    "Discard scratch-1 and go back to #flight-path",
  );
  assert.equal(
    detail(scratch, "new"),
    "Another scratch copy to work in parallel",
  );
  assert.equal(
    detail(parent, "new"),
    "Scratch copy of #flight-path — same people, fresh history",
  );
});

test("/new copies this channel, or from a scratch channel its ROOT parent", async () => {
  const fromParent = context(parent);
  assert.deepEqual(await run("/new", fromParent.ctx), {
    ok: true,
    notice: "opened",
  });
  assert.deepEqual(fromParent.calls.create, [
    { parent: { id: PARENT, name: "flight-path" }, name: null },
  ]);
  const fromScratch = context(scratch);
  await run("/new jitter qa", fromScratch.ctx);
  // A sibling of scratch-1, never a scratch of a scratch.
  assert.deepEqual(fromScratch.calls.create, [
    { parent: { id: PARENT, name: "flight-path" }, name: "jitter qa" },
  ]);
  assert.deepEqual(fromScratch.calls.sends, [], "nothing is sent as text");
});

test("/exit hands over the scratch and where to go back to", async () => {
  const { ctx, calls } = context(scratch);
  assert.deepEqual(await run("/exit", ctx), { ok: true });
  assert.deepEqual(calls.exit, [
    { channelId: SCRATCH, parent: { id: PARENT, name: "flight-path" } },
  ]);
});

test("/keep passes a name only when one is given, and returns the relay's refusal", async () => {
  const { ctx, calls } = context(scratch);
  assert.deepEqual(await run("/keep", ctx), {
    ok: false,
    error: "relay: not authorized",
  });
  await run("/keep capture-plan", ctx);
  assert.deepEqual(calls.keep, [
    { channelId: SCRATCH, name: null },
    { channelId: SCRATCH, name: "capture-plan" },
  ]);
});
