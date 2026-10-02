import assert from "node:assert/strict";
import test from "node:test";
import {
  desktopControlLock,
  monitorDesktopPresence,
} from "./lib/desktopPresence.ts";

const catalog = {
  machine: "crichton.local",
  version: 5,
  caps: ["ping", "fresh"],
  agents: [],
  harnesses: [],
  updatedAt: 1,
};
const ack = {
  type: "agent_admin_ack",
  requestId: "r",
  ok: true,
  result: { machine: "crichton.local", catalogVersion: 5, caps: ["ping"] },
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test("two missed pings → offline; next ack → online", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  let state;
  let answering = false;
  let calls = 0;
  const monitor = monitorDesktopPresence(
    [catalog],
    async () => {
      calls++;
      return answering ? ack : new Promise(() => {});
    },
    (next) => {
      state = next;
    },
  );
  t.after(() => monitor.stop());
  assert.equal(state.get("crichton.local").status, "checking");
  t.mock.timers.tick(10_000);
  assert.equal(state.get("crichton.local").missed, 1);
  t.mock.timers.tick(20_000);
  t.mock.timers.tick(10_000);
  assert.equal(state.get("crichton.local").status, "offline");
  assert.equal(calls, 2);
  assert.equal(
    desktopControlLock([catalog], state, [catalog.machine]).locked,
    true,
  );
  answering = true;
  t.mock.timers.tick(20_000);
  await flush();
  assert.equal(state.get("crichton.local").status, "online");
  assert.equal(state.get("crichton.local").lastSeen, 60_000);
  assert.equal(
    desktopControlLock([catalog], state, [catalog.machine]).locked,
    false,
  );
});

test("v4 presence is unknown and never sends a ping", () => {
  let state;
  let calls = 0;
  const monitor = monitorDesktopPresence(
    [{ ...catalog, version: 4 }],
    async () => {
      calls++;
      return ack;
    },
    (next) => {
      state = next;
    },
  );
  monitor.focus();
  monitor.stop();
  assert.equal(calls, 0);
  assert.equal(state.get(catalog.machine).status, "unknown");
  assert.match(
    desktopControlLock([{ ...catalog, version: 4 }], state, [catalog.machine])
      .reason,
    /Update Buzz Desktop/,
  );
});

test("focus probes immediately without overlapping an in-flight ping", async () => {
  let resolve;
  let calls = 0;
  const monitor = monitorDesktopPresence(
    [catalog],
    () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    () => {},
  );
  monitor.focus();
  assert.equal(calls, 1);
  resolve(ack);
  await flush();
  monitor.focus();
  assert.equal(calls, 2);
  monitor.stop();
});

test("unmount cancels probes and ignores their late replies", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let resolve;
  let signal;
  let changes = 0;
  const monitor = monitorDesktopPresence(
    [catalog],
    (_machine, abortSignal) => {
      signal = abortSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
    () => {
      changes++;
    },
  );
  monitor.stop();
  assert.equal(signal.aborted, true);
  resolve(ack);
  await flush();
  t.mock.timers.tick(90_000);
  assert.equal(changes, 1);
});

test("a reply from another machine or a refusal never reports online", async () => {
  for (const reply of [
    { ...ack, ok: false },
    { ...ack, result: { ...ack.result, machine: "other" } },
  ]) {
    let state;
    const monitor = monitorDesktopPresence(
      [catalog],
      async () => reply,
      (next) => {
        state = next;
      },
    );
    await flush();
    assert.equal(state.get(catalog.machine).status, "checking");
    assert.equal(state.get(catalog.machine).lastSeen, null);
    monitor.stop();
  }
});

test("one offline claiming desktop locks a shared agent", () => {
  const other = { ...catalog, machine: "other" };
  const presence = new Map([
    [catalog.machine, { status: "online", lastSeen: 1, missed: 0 }],
    [other.machine, { status: "offline", lastSeen: null, missed: 2 }],
  ]);
  assert.deepEqual(
    desktopControlLock([catalog, other], presence, [
      catalog.machine,
      other.machine,
    ]),
    { locked: true, offline: true, reason: "Needs the desktop" },
  );
  assert.equal(
    desktopControlLock([catalog], presence, [catalog.machine], "update.effort")
      .locked,
    true,
  );
});
