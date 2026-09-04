import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RelaySession,
  authEventTemplate,
  authRetryDelayMs,
  shouldForceReconnect,
} from "./relay-session.ts";

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.closed = false;
    FakeSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener(type, listener) {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      list.filter((l) => l !== listener),
    );
  }
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.emit("close", {});
  }
  emit(type, event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event ?? {});
    }
  }
  serverSend(payload) {
    this.emit("message", { data: JSON.stringify(payload) });
  }
  sentOf(type) {
    return this.sent.filter((m) => m[0] === type);
  }
}
FakeSocket.instances = [];

function fakeAuthEvent(challenge) {
  return {
    kind: 22242,
    created_at: 1_700_000_000,
    tags: [["challenge", challenge]],
    content: "",
    id: `auth-${challenge}`,
    pubkey: "aa".repeat(32),
    sig: "ff".repeat(64),
  };
}

function makeSession(overrides = {}) {
  FakeSocket.instances = [];
  const seenChallenges = [];
  const session = new RelaySession({
    wsUrl: "wss://relay.test",
    webSocketFactory: (url) => new FakeSocket(url),
    signAuthEvent: async (challenge) => {
      seenChallenges.push(challenge);
      return fakeAuthEvent(challenge);
    },
    reconnectDelayMs: () => 0,
    authGraceMs: 5,
    ...overrides,
  });
  return { session, seenChallenges };
}

function firstSocket() {
  return FakeSocket.instances[0];
}

function tick(ms = 10) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("AUTH handshake: signs the challenge, opens, REQs queued subs once", async () => {
  const { session } = makeSession();
  const events = [];
  session.subscribe({ kinds: [39000] }, { onEvent: (e) => events.push(e) });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-1"]);
  await tick();

  const auth = socket.sentOf("AUTH");
  assert.equal(auth.length, 1);
  assert.equal(auth[0][1].tags[0][1], "chal-1");
  assert.equal(session.status, "open");
  const reqs = socket.sentOf("REQ");
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0][2], { kinds: [39000] });

  // A second (stale) challenge must not re-REQ the subscription.
  socket.serverSend(["AUTH", "chal-2"]);
  await tick();
  assert.equal(socket.sentOf("REQ").length, 1);
  session.close();
});

test("events and EOSE route to the matching subscription", async () => {
  const { session } = makeSession();
  const got = [];
  let eoses = 0;
  session.subscribe(
    { kinds: [9] },
    {
      onEvent: (e) => got.push(e),
      onEose: () => {
        eoses += 1;
      },
    },
  );
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "c"]);
  await tick();
  const subId = socket.sentOf("REQ")[0][1];
  socket.serverSend(["EVENT", subId, { id: "e1", kind: 9 }]);
  socket.serverSend(["EVENT", "s999", { id: "e2", kind: 9 }]);
  socket.serverSend(["EOSE", subId]);
  assert.deepEqual(
    got.map((e) => e.id),
    ["e1"],
  );
  assert.equal(eoses, 1);
  session.close();
});

test("publish waits for AUTH and resolves on OK/FAILED", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  const event = { id: "msg-1", kind: 9, sig: "s" };
  const pending = session.publish(event);
  socket.serverSend(["AUTH", "c"]);
  await tick();
  assert.deepEqual(socket.sentOf("EVENT")[0][1].id, "msg-1");
  socket.serverSend(["OK", "msg-1", true, ""]);
  assert.deepEqual(await pending, { ok: true, message: "" });

  const second = session.publish({ id: "msg-2", kind: 9 });
  await tick();
  socket.serverSend(["FAILED", "msg-2", "duplicate"]);
  assert.deepEqual(await second, { ok: false, message: "duplicate" });
  session.close();
});

test("publish fails fast when the socket drops mid-send (no infinite hang)", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "c"]);
  await tick();
  const pending = session.publish({ id: "dm-open-1", kind: 41010, sig: "s" });
  await tick();
  assert.equal(socket.sentOf("EVENT").length, 1, "EVENT was sent");
  // Relay drops the connection without OK/FAILED — the waiter must settle.
  socket.emit("close");
  // Race a sentinel: a regression (waiter leak) surfaces as a clean FAIL,
  // not a hung runner.
  const result = await Promise.race([
    pending,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: "HUNG", message: "" }), 1_000),
    ),
  ]);
  assert.deepEqual(result, {
    ok: false,
    message: "connection lost while sending",
  });
  session.close();
});

test("reconnect: closes → new socket → subscriptions replayed", async () => {
  const { session } = makeSession();
  const events = [];
  session.subscribe({ kinds: [39000] }, { onEvent: (e) => events.push(e) });
  session.connect();
  const first = firstSocket();
  first.emit("open");
  first.serverSend(["AUTH", "c1"]);
  await tick();
  assert.equal(first.sentOf("REQ").length, 1);

  first.emit("close"); // abnormal close → reconnect path
  await tick();
  assert.equal(session.status, "reconnecting");
  await tick(20);
  const second = FakeSocket.instances[1];
  assert.ok(second, "expected a second socket after close");
  assert.notEqual(second, first);
  second.emit("open");
  second.serverSend(["AUTH", "c2"]);
  await tick();
  assert.equal(second.sentOf("REQ").length, 1, "subscription replayed");
  session.close();
});

test("unsubscribe before auth suppresses the REQ", async () => {
  const { session } = makeSession();
  const unsub = session.subscribe({ kinds: [39000] }, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  unsub();
  socket.serverSend(["AUTH", "c"]);
  await tick();
  assert.equal(socket.sentOf("REQ").length, 0);
  session.close();
});

test("close() ends the session without reconnecting", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  session.close();
  assert.equal(session.status, "closed");
  await tick(20);
  assert.equal(
    FakeSocket.instances.length,
    1,
    "no reconnect after manual close",
  );
});

test("no-challenge relay: auth grace expires and subs flow", async () => {
  const { session } = makeSession();
  session.subscribe({ kinds: [41] }, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  await tick(20);
  assert.equal(session.status, "open");
  assert.equal(socket.sentOf("REQ").length, 1);
  session.close();
});

test("liveness: a socket that opens but never sends a single frame is redialed", async () => {
  // Pins the handleOpen seed of the liveness clock: without it, a relay
  // that completes the WS handshake and then goes completely silent (no
  // AUTH challenge, no frames at all) reads lastMessageAt=null and the
  // probe never fires.
  let clock = 1_000_000;
  FakeSocket.instances = [];
  const session = new RelaySession({
    wsUrl: "wss://relay.test",
    webSocketFactory: (url) => new FakeSocket(url),
    signAuthEvent: async (challenge) => fakeAuthEvent(challenge),
    reconnectDelayMs: () => 0,
    authGraceMs: 5,
    nowMs: () => clock,
    livenessIntervalMs: 5,
  });
  try {
    session.connect();
    const first = firstSocket();
    first.emit("open"); // and then… nothing. Ever.
    await tick(20);
    assert.equal(session.status, "open"); // auth grace expired silently
    assert.equal(FakeSocket.instances.length, 1);

    clock += 61_000;
    await tick(30);
    assert.equal(FakeSocket.instances.length, 2, "zero-frame socket redialed");
  } finally {
    session.close();
  }
});

test("authEventTemplate carries NIP-42 fields", () => {
  const template = authEventTemplate("abc", "wss://relay.test:6351/");
  assert.equal(template.kind, 22242);
  assert.deepEqual(template.tags, [
    ["challenge", "abc"],
    ["relay", "wss://relay.test:6351/"],
  ]);
  assert.equal(template.content, "");
});

test("signAuthEvent failure degrades to unauthenticated open", async () => {
  const { session } = makeSession({
    signAuthEvent: async () => {
      throw new Error("locked");
    },
  });
  session.subscribe({ kinds: [41] }, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "c"]);
  await tick();
  assert.equal(session.status, "open");
  assert.equal(socket.sentOf("AUTH").length, 0);
  assert.equal(socket.sentOf("REQ").length, 1);
  session.close();
});

test("authEventTemplate carries the NIP-OA auth tag when provided", () => {
  const tag = JSON.stringify(["auth", "attestation-payload"]);
  const template = authEventTemplate("c", "wss://relay.test", tag);
  assert.deepEqual(template.tags, [
    ["challenge", "c"],
    ["relay", "wss://relay.test"],
    ["auth", "attestation-payload"],
  ]);
});

test("authEventTemplate rejects malformed auth tags", () => {
  assert.throws(() => authEventTemplate("c", "wss://r", "not-json"), /JSON/);
  assert.throws(
    () => authEventTemplate("c", "wss://r", JSON.stringify(["other", "x"])),
    /auth/,
  );
  assert.throws(
    () => authEventTemplate("c", "wss://r", JSON.stringify(["auth", 42])),
    /auth/,
  );
});

test("CLOSED(auth-required) sub is re-REQd after AUTH completes", async () => {
  const { session } = makeSession();
  const events = [];
  session.subscribe({ kinds: [24200] }, { onEvent: (e) => events.push(e) });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  // Auth grace expires and the REQ goes out before the relay challenges.
  await tick(20);
  assert.equal(socket.sentOf("REQ").length, 1);
  // Relay rejects the pre-auth REQ, then challenges.
  socket.serverSend(["CLOSED", "s0", "auth-required: not authenticated"]);
  socket.serverSend(["AUTH", "challenge-late"]);
  await tick(20);
  // AUTH went out and the sub was replayed exactly once more.
  assert.ok(socket.sentOf("AUTH").length >= 1);
  assert.equal(socket.sentOf("REQ").length, 2);
  // A non-auth close stays closed — no retry loop.
  socket.serverSend(["CLOSED", "s0", "restricted: nope"]);
  await tick(20);
  assert.equal(socket.sentOf("REQ").length, 2);
  session.close();
});

test("CLOSED after auth retries again with backoff (no spiral)", async () => {
  const { session } = makeSession({ authRetryDelayMs: () => 5 });
  session.subscribe({ kinds: [9] }, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  await tick(20);
  socket.serverSend(["AUTH", "c1"]);
  await tick(20);
  const afterAuth = socket.sentOf("REQ").length;
  socket.serverSend(["CLOSED", "s0", "auth-required: raced"]);
  await tick(40);
  assert.equal(socket.sentOf("REQ").length, afterAuth + 1);
  // Second auth-required close schedules another backoff retry — the sub
  // is not left dead after one loss — and rejections eventually stop the
  // cycle at the attempt cap (see the bounded test below).
  socket.serverSend(["CLOSED", "s0", "auth-required: raced again"]);
  await tick(40);
  assert.equal(socket.sentOf("REQ").length, afterAuth + 2);
  session.close();
});

test("CLOSED(rate-limited) sub retries with backoff instead of dying", async () => {
  // The relay's global handler semaphore rejects REQs during fleet-wide load
  // bursts ("rate-limited: too many concurrent requests"). Old behavior: the
  // sub was dropped for the whole session — the profiles query losing that
  // lottery is exactly the bare-names-and-avatars bug.
  const { session } = makeSession({ authRetryDelayMs: () => 5 });
  session.subscribe({ kinds: [0], authors: ["aa"] }, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  await tick(20);
  socket.serverSend(["AUTH", "c1"]);
  await tick(20);
  const afterAuth = socket.sentOf("REQ").length;
  socket.serverSend([
    "CLOSED",
    "s0",
    "rate-limited: too many concurrent requests",
  ]);
  await tick(40);
  assert.equal(
    socket.sentOf("REQ").length,
    afterAuth + 1,
    "rate-limited CLOSED must re-REQ",
  );
  // A second rejection consumes budget and schedules another retry — same
  // bounded spiral semantics as the auth race.
  socket.serverSend([
    "CLOSED",
    "s0",
    "rate-limited: too many concurrent requests",
  ]);
  await tick(40);
  assert.equal(socket.sentOf("REQ").length, afterAuth + 2);
  session.close();
});

test("shouldForceReconnect: thresholds are 60s visible / 10min hidden, null clock never forces", () => {
  // Hardcoded — the incident shape was an afternoon-long zombie.
  assert.equal(
    shouldForceReconnect(1_000_000, 1_000_000 + 59_999, true),
    false,
  );
  assert.equal(shouldForceReconnect(1_000_000, 1_000_000 + 60_000, true), true);
  assert.equal(
    shouldForceReconnect(1_000_000, 1_000_000 + 8 * 3600 * 1000, true),
    true,
  );
  assert.equal(
    shouldForceReconnect(1_000_000, 1_000_000 + 10 * 60_000 - 1, false),
    false,
  );
  assert.equal(
    shouldForceReconnect(1_000_000, 1_000_000 + 10 * 60_000, false),
    true,
  );
  assert.equal(shouldForceReconnect(null, 1_000_000 + 999_999, true), false);
});

test("liveness: a silent-socket zombie is torn down and re-dialed, subs replayed", async () => {
  let clock = 1_000_000;
  FakeSocket.instances = [];
  const session = new RelaySession({
    wsUrl: "wss://relay.test",
    webSocketFactory: (url) => new FakeSocket(url),
    signAuthEvent: async (challenge) => fakeAuthEvent(challenge),
    reconnectDelayMs: () => 0,
    authGraceMs: 5,
    nowMs: () => clock,
    livenessIntervalMs: 5,
  });
  const got = [];
  // try/finally: a failed assertion must still close the session — its
  // liveness interval would otherwise keep the node test runner alive.
  try {
    session.subscribe({ kinds: [9] }, { onEvent: (e) => got.push(e) });
    session.connect();
    const first = firstSocket();
    first.emit("open");
    first.serverSend(["AUTH", "c1"]);
    await tick(20);
    assert.equal(FakeSocket.instances.length, 1);
    assert.equal(session.status, "open");

    // 30s of silence on a visible tab: still fine (node has no document, so
    // the visible threshold applies).
    clock += 30_000;
    await tick(20);
    assert.equal(FakeSocket.instances.length, 1);

    // Past the visible threshold with zero frames: the zombie is replaced.
    clock += 31_000;
    await tick(30);
    assert.equal(FakeSocket.instances.length, 2);
    assert.equal(session.status, "reconnecting");
    // The old socket must be deregistered before the new one dials.
    assert.equal(first.listeners.get("close")?.length ?? 0, 0);

    // The replacement completes its handshake and replays the subscription.
    const second = FakeSocket.instances[1];
    second.emit("open");
    second.serverSend(["AUTH", "c2"]);
    await tick(20);
    assert.equal(session.status, "open");
    const reqs = second.sentOf("REQ");
    assert.equal(reqs.length, 1);
    assert.deepEqual(reqs[0][2], { kinds: [9] });

    // Traffic keeps the new socket alive: no further re-dials.
    clock += 5_000;
    second.serverSend(["EOSE", reqs[0][1]]);
    clock += 45_000;
    await tick(20);
    assert.equal(FakeSocket.instances.length, 2);
  } finally {
    session.close();
  }
});

test("authRetryDelayMs: exponential from 250ms, capped at 4s", () => {
  assert.equal(authRetryDelayMs(1), 250);
  assert.equal(authRetryDelayMs(2), 500);
  assert.equal(authRetryDelayMs(3), 1000);
  assert.equal(authRetryDelayMs(4), 2000);
  assert.equal(authRetryDelayMs(5), 4000);
  assert.equal(authRetryDelayMs(6), 4000); // capped beyond the last attempt
});

test("auth-race: a CLOSED auth-required sub retries until the REQ lands post-auth", async () => {
  const { session } = makeSession({ authRetryDelayMs: () => 5 });
  const got = [];
  session.subscribe({ kinds: [9] }, { onEvent: (e) => got.push(e) });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  // No AUTH challenge yet — grace path marks authenticated and REQs.
  await tick(20);
  assert.equal(socket.sentOf("REQ").length, 1);
  const subId = socket.sentOf("REQ")[0][1];

  // Relay rejects the first REQ and the two following retries — the exact
  // load-time race. Old behavior: ONE retry, then the sub died forever.
  socket.serverSend(["CLOSED", subId, "auth-required: not authenticated"]);
  await tick(20);
  socket.serverSend(["CLOSED", subId, "auth-required: not authenticated"]);
  await tick(20);
  socket.serverSend(["CLOSED", subId, "auth-required: not authenticated"]);

  // The next retry fires AFTER auth completed — it must succeed: no further
  // CLOSED, and events flow on the raced sub.
  socket.serverSend(["AUTH", "late-challenge"]);
  await tick(40);
  const reqs = socket.sentOf("REQ");
  assert.equal(reqs.length, 4, "initial + three retries");
  assert.equal(session.status, "open");
  socket.serverSend(["EVENT", subId, { id: "arrived", kind: 9 }]);
  assert.deepEqual(
    got.map((e) => e.id),
    ["arrived"],
    "the raced sub is live after backoff retries",
  );
  session.close();
});

test("auth-race: retries are bounded — after 5 failures the sub stays dead", async () => {
  const { session } = makeSession({ authRetryDelayMs: () => 5 });
  session.subscribe({ kinds: [9] }, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  await tick(20);
  const subId = socket.sentOf("REQ")[0][1];
  // Reject every attempt: initial + 5 retries = 6 REQs total, then silence.
  for (let i = 0; i < 6; i++) {
    socket.serverSend(["CLOSED", subId, "auth-required: not authenticated"]);
    await tick(20);
  }
  const after = socket.sentOf("REQ").length;
  await tick(60);
  assert.equal(socket.sentOf("REQ").length, after, "no unbounded retry spiral");
  assert.equal(after, 6, "initial REQ + exactly 5 retries");
  session.close();
});

test("replay paces REQ opens so the relay send buffer can drain", async () => {
  const { session } = makeSession();
  for (let i = 0; i < 10; i++) {
    session.subscribe(
      { kinds: [9], "#h": [`dm-${i}`], limit: 1 },
      { onEvent: () => {} },
    );
  }
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-pace"]);
  try {
    await tick();
    // Nothing synchronous; index 0 lands on its 0ms timer, the rest pace.
    assert.equal(socket.sentOf("REQ").length, 1);
    await tick(250);
    assert.equal(socket.sentOf("REQ").length, 3);
    await tick(120 * 10);
    assert.equal(socket.sentOf("REQ").length, 10);
    const ids = socket.sentOf("REQ").map((frame) => frame[1]);
    assert.equal(new Set(ids).size, 10, "each sub opened exactly once");
  } finally {
    session.close();
  }
});

test("subscribe with a filter array spreads the filters in one REQ frame", async () => {
  const { session } = makeSession();
  const filters = [
    { kinds: [9], "#h": ["a"], limit: 1 },
    { kinds: [9], "#h": ["b"], limit: 1 },
  ];
  session.subscribe(filters, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-multi"]);
  await tick();
  const reqs = socket.sentOf("REQ");
  assert.equal(reqs.length, 1);
  assert.deepEqual(reqs[0].slice(2), filters);
  session.close();
});

test("a rate-limited NOTICE settles the publish instead of timing out", async () => {
  // Admission refuses an EVENT with a bare NOTICE and drops it without
  // processing, so no OK or FAILED ever follows. Waiting out the ack timeout
  // reports a quota refusal as "timed out waiting for the relay", which reads
  // as the relay being down.
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-1"]);
  await tick();

  const published = session.publish({
    id: "ab".repeat(32),
    kind: 9,
    pubkey: "cc".repeat(32),
    created_at: 1,
    tags: [],
    content: "hello",
    sig: "ff".repeat(64),
  });
  socket.serverSend(["NOTICE", "rate-limited: quota exceeded; retry in 1s"]);

  const result = await published;
  assert.equal(result.ok, false);
  // The relay's own words, not a fabricated timeout.
  assert.match(result.message, /rate-limited/);
  session.close();
});

test("an unrelated NOTICE does not fail an in-flight publish", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-1"]);
  await tick();

  const id = "de".repeat(32);
  const published = session.publish({
    id,
    kind: 9,
    pubkey: "cc".repeat(32),
    created_at: 1,
    tags: [],
    content: "hello",
    sig: "ff".repeat(64),
  });
  socket.serverSend(["NOTICE", "server restarting shortly"]);
  await tick();
  // Still waiting — an informational notice is not a refusal.
  socket.serverSend(["OK", id, true, "accepted"]);

  const result = await published;
  assert.equal(result.ok, true);
  assert.equal(result.message, "accepted");
  session.close();
});
