import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { TermTransport } from "./transport.ts";

/**
 * W-1 / W-2 against the SHIPPING transport with a fake socket and manual
 * timers: bytes reach the sink undecoded, and every close code drives the
 * state, the reconnect and the id the way phase-7.md §5.1 says.
 */

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

class FakeSocket {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.binaryType = "blob";
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    FakeSocket.all.push(this);
  }
  get id() {
    return new URL(this.url).searchParams.get("id");
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  frame(data) {
    this.onmessage?.({ data });
  }
  serverClose(code, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function manualTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    /** Run every timer due within `ms`, in order. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()]
          .filter(([, t]) => t.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    get pending() {
      return [...pending.values()].map((t) => t.at - now);
    },
  };
}

function harness(verdict = "unknown") {
  const timers = manualTimers();
  const writes = [];
  const states = [];
  let resets = 0;
  const transport = new TermTransport({
    url: (q) => `wss://hatch.test/ws/term?${q}`,
    sink: {
      write: (bytes) => writes.push(bytes),
      reset: () => {
        resets += 1;
      },
    },
    geometry: () => ({ cols: 100, rows: 30 }),
    onState: (s) => states.push(s),
    diagnose: async () => verdict,
    WebSocketImpl: FakeSocket,
    timers,
  });
  live.push(transport);
  return {
    transport,
    timers,
    writes,
    states,
    get resets() {
      return resets;
    },
    last: () => FakeSocket.all.at(-1),
  };
}

const live = [];

beforeEach(() => {
  FakeSocket.all = [];
  store.clear();
});

// The keepalive is a real 30 s interval: stop every transport so none
// outlives its test (or pings into the next one's socket).
afterEach(() => {
  for (const transport of live.splice(0)) transport.dispose();
});

test("W-1: binary frames reach the sink as Uint8Array, never decoded", () => {
  const h = harness();
  h.transport.connect();
  const sock = h.last();
  assert.equal(sock.binaryType, "arraybuffer");
  sock.open();
  // "é" (C3 A9) split across two frames, then a text control frame.
  sock.frame(new Uint8Array([0x63, 0x61, 0x66, 0xc3]).buffer);
  sock.frame(new Uint8Array([0xa9, 0x0a]).buffer);
  sock.frame('{"type":"pong"}');
  assert.equal(h.writes.length, 2, "the text frame is control, not output");
  for (const chunk of h.writes) assert.ok(chunk instanceof Uint8Array);
  const joined = new Uint8Array([...h.writes[0], ...h.writes[1]]);
  assert.equal(new TextDecoder().decode(joined), "café\n");
  assert.deepEqual([...h.writes[0]], [0x63, 0x61, 0x66, 0xc3]);
});

test("the first attach carries the id and the emulator's grid", () => {
  const h = harness();
  h.transport.connect();
  const url = new URL(h.last().url);
  assert.match(url.searchParams.get("id"), /^t-[0-9a-f]{16}$/);
  assert.equal(url.searchParams.get("cols"), "100");
  assert.equal(url.searchParams.get("rows"), "30");
  assert.deepEqual(h.states, ["connecting"]);
});

test("W-2 reset: sends {type:reset}; 4002 wipes and reconnects with the SAME id", () => {
  const h = harness();
  h.transport.connect();
  const first = h.last();
  first.open();
  assert.equal(h.transport.reset(), true);
  assert.deepEqual(first.sent, ['{"type":"reset"}']);
  first.serverClose(4002, "soft reset (shared session)");
  assert.equal(h.resets, 1, "the emulator is wiped");
  assert.equal(FakeSocket.all.length, 2, "reconnected immediately");
  assert.equal(
    h.last().id,
    first.id,
    "same id: nothing rotated, nothing killed",
  );
});

test("W-2 4001: rotates the id before reconnecting", () => {
  const h = harness();
  h.transport.connect();
  const first = h.last();
  first.open();
  first.serverClose(4001, "reset");
  assert.equal(FakeSocket.all.length, 2);
  assert.notEqual(h.last().id, first.id);
});

test("W-2 1000 shell exited and 1013 capacity: their state, and NO reconnect", () => {
  for (const [code, state] of [
    [1000, "shell-exited"],
    [1013, "at-capacity"],
    [1011, "failed"],
    [4004, "disabled"],
  ]) {
    FakeSocket.all = [];
    const h = harness();
    h.transport.connect();
    h.last().open();
    h.last().serverClose(code);
    assert.equal(h.states.at(-1), state, `code ${code}`);
    h.timers.advance(120_000);
    assert.equal(FakeSocket.all.length, 1, `code ${code} must not reconnect`);
  }
});

test("W-2 4003 / 1006 after open: quiet backoff reconnect, capped at 8 s", () => {
  const h = harness();
  h.transport.connect();
  h.last().open();
  h.last().serverClose(4003);
  assert.equal(h.states.at(-1), "reconnecting");
  assert.deepEqual(h.timers.pending, [500]);
  h.timers.advance(500);
  assert.equal(FakeSocket.all.length, 2);
  // Keep failing before open: 1, 2, 4, 8, 8 s.
  const delays = [];
  for (let i = 0; i < 5; i++) {
    h.last().serverClose(1006);
    delays.push(h.timers.pending[0]);
    h.timers.advance(h.timers.pending[0]);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 8000]);
});

test("a reconnect after open forces a settled repaint (shrink, hold, restore)", () => {
  const h = harness();
  h.transport.connect();
  h.last().open();
  h.last().serverClose(1006);
  h.timers.advance(500);
  const second = h.last();
  second.open();
  assert.deepEqual(second.sent, ['{"type":"resize","cols":100,"rows":24}']);
  assert.equal(h.transport.repainting, true);
  h.timers.advance(550);
  assert.deepEqual(
    second.sent.at(-1),
    '{"type":"resize","cols":100,"rows":30}',
  );
  assert.equal(h.transport.repainting, false);
});

for (const verdict of ["signed-out", "forbidden"]) {
  test(`never opened + hatch says ${verdict}: that state, and the retry is cancelled`, async () => {
    const h = harness(verdict);
    h.transport.connect();
    h.last().serverClose(1006);
    await new Promise((r) => setImmediate(r));
    assert.equal(h.states.at(-1), verdict);
    h.timers.advance(60_000);
    assert.equal(
      FakeSocket.all.length,
      1,
      "no retry storm against a login wall",
    );
    h.transport.retry();
    assert.equal(FakeSocket.all.length, 2, "retry() is the way back");
  });
}

test("never opened + hatch says disabled: disabled, slow 30 s re-check", async () => {
  const h = harness("disabled");
  h.transport.connect();
  h.last().serverClose(1006);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.states.at(-1), "disabled");
  assert.deepEqual(h.timers.pending, [30_000]);
  h.timers.advance(29_999);
  assert.equal(FakeSocket.all.length, 1);
  h.timers.advance(1);
  assert.equal(FakeSocket.all.length, 2);
});

test("never opened + hatch unreachable: stays on the quiet reconnect, never 'disabled'", async () => {
  const h = harness("unknown");
  h.transport.connect();
  h.last().serverClose(1006);
  await new Promise((r) => setImmediate(r));
  assert.equal(h.states.at(-1), "reconnecting");
  h.timers.advance(500);
  assert.equal(FakeSocket.all.length, 2);
});

test("input goes out as binary frames; nothing is sent while closed", () => {
  const h = harness();
  assert.equal(h.transport.send("ls\r"), false);
  h.transport.connect();
  h.last().open();
  assert.equal(h.transport.send("ls\r"), true);
  const frame = h.last().sent.at(-1);
  assert.ok(frame instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(frame), "ls\r");
});

test("dispose stops everything: no reconnect after a later close", () => {
  const h = harness();
  h.transport.connect();
  const sock = h.last();
  sock.open();
  h.transport.dispose();
  sock.serverClose(1006);
  h.timers.advance(60_000);
  assert.equal(FakeSocket.all.length, 1);
});
