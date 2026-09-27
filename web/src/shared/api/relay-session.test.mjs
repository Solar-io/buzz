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

test("a dropped socket re-sends an in-flight publish after reconnect (D-042)", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "c"]);
  await tick();
  const pending = session.publish({ id: "dm-open-1", kind: 41010, sig: "s" });
  await tick();
  assert.equal(socket.sentOf("EVENT").length, 1, "EVENT was sent");
  // Relay drops the connection without OK/FAILED — the publish must not be
  // lost: it parks and rides the next socket's authenticated flush.
  socket.emit("close");
  await tick(20);
  const second = FakeSocket.instances[1];
  assert.ok(second, "expected a second socket after close");
  second.emit("open");
  second.serverSend(["AUTH", "c2"]);
  await tick();
  const resent = second.sentOf("EVENT");
  assert.equal(resent.length, 1, "EVENT re-sent after reconnect");
  assert.equal(resent[0][1].id, "dm-open-1", "same event id re-sent");
  second.serverSend(["OK", "dm-open-1", true, ""]);
  // Race a sentinel: a regression (waiter leak) surfaces as a clean FAIL,
  // not a hung runner.
  const result = await Promise.race([
    pending,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: "HUNG", message: "" }), 1_000),
    ),
  ]);
  assert.deepEqual(result, { ok: true, message: "" });
  session.close();
});

test("ack timeout parks the publish; a later reconnect flush lands it (D-042)", async () => {
  const { session } = makeSession({
    publishAckTimeoutMs: 10,
    publishRetryBackstopMs: 5_000,
  });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "c"]);
  await tick();
  const pending = session.publish({ id: "tap-1", kind: 9, sig: "s" });
  await tick();
  assert.equal(socket.sentOf("EVENT").length, 1, "EVENT was sent");
  // No OK ever arrives on this socket (half-open): the ack timeout fires and
  // must PARK the publish, not resolve it as failed.
  await tick(30);
  socket.emit("close");
  await tick(20);
  const second = FakeSocket.instances[1];
  second.emit("open");
  second.serverSend(["AUTH", "c2"]);
  await tick();
  assert.equal(
    second.sentOf("EVENT").length,
    1,
    "parked publish flushed on reconnect",
  );
  second.serverSend(["OK", "tap-1", true, "duplicate"]);
  const result = await Promise.race([
    pending,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: "HUNG", message: "" }), 1_000),
    ),
  ]);
  assert.deepEqual(result, { ok: true, message: "duplicate" });
  session.close();
});

test("backstop resolves an honest failure when no relay ever answers (D-042)", async () => {
  const { session } = makeSession({
    publishAckTimeoutMs: 10,
    publishRetryBackstopMs: 30,
  });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "c"]);
  await tick();
  const pending = session.publish({ id: "gone-1", kind: 9, sig: "s" });
  await tick();
  // Socket stays "up", relay never answers, no reconnect ever happens.
  const result = await Promise.race([
    pending,
    new Promise((resolve) =>
      setTimeout(() => resolve({ ok: "HUNG", message: "" }), 2_000),
    ),
  ]);
  assert.equal(result.ok, false);
  assert.match(result.message, /timed out waiting for the relay/);
  session.close();
});

test("publish while disconnected rides the authenticated flush (D-042)", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  // Socket exists but has not opened/authed yet — the publish must queue in
  // the durable retry queue (NOT `pending`, which openSocket clears).
  const pending = session.publish({ id: "offline-1", kind: 9, sig: "s" });
  socket.emit("open");
  socket.serverSend(["AUTH", "c"]);
  await tick();
  const sent = socket.sentOf("EVENT");
  assert.equal(sent.length, 1, "queued publish flushed on auth");
  assert.equal(sent[0][1].id, "offline-1");
  socket.serverSend(["OK", "offline-1", true, ""]);
  assert.deepEqual(await pending, { ok: true, message: "" });
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

/** Auto-answer every REQ with EOSE, like a fast relay (3-10ms measured). */
function autoEose(socket, delayMs = 2) {
  const send = socket.send.bind(socket);
  socket.send = (data) => {
    send(data);
    const frame = JSON.parse(data);
    if (frame[0] === "REQ") {
      setTimeout(() => socket.serverSend(["EOSE", frame[1]]), delayMs);
    }
  };
}

function subscribeMany(session, count, priorityAt = new Set()) {
  const unsubs = [];
  for (let i = 0; i < count; i++) {
    unsubs.push(
      session.subscribe(
        { kinds: [9], "#h": [`dm-${i}`], limit: 1 },
        {
          onEvent: () => {},
          ...(priorityAt.has(i) ? { priority: "critical" } : {}),
        },
      ),
    );
  }
  return unsubs;
}

test("replay window: at most 4 REQs await EOSE; an EOSE opens the next at once", async () => {
  const { session } = makeSession();
  subscribeMany(session, 10);
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-window"]);
  try {
    await tick();
    assert.equal(socket.sentOf("REQ").length, 4, "the window, not a burst");
    const first = socket.sentOf("REQ")[0][1];
    socket.serverSend(["EOSE", first]);
    assert.equal(socket.sentOf("REQ").length, 5, "EOSE frees a slot now");
    // No more EOSEs: the per-slot fallback (400ms) keeps the replay moving.
    await tick(1_500);
    assert.equal(socket.sentOf("REQ").length, 10);
    const ids = socket.sentOf("REQ").map((frame) => frame[1]);
    assert.equal(new Set(ids).size, 10, "each sub opened exactly once");
  } finally {
    session.close();
  }
});

test("boot replay: 86 subs against a fast relay all go out within 1s of AUTH", async () => {
  // Plan item 2.1: the old fixed 120ms pacing put the 86th REQ ~10s out
  // (measured tail ~3.7s live with fewer subs). EOSE-driven, it is bounded
  // by the relay's answer time, not a timer.
  const { session } = makeSession();
  subscribeMany(session, 86);
  session.connect();
  const socket = firstSocket();
  autoEose(socket);
  socket.emit("open");
  const authAt = Date.now();
  socket.serverSend(["AUTH", "chal-boot"]);
  try {
    while (socket.sentOf("REQ").length < 86 && Date.now() - authAt < 1_000) {
      await tick(5);
    }
    assert.equal(
      socket.sentOf("REQ").length,
      86,
      `all boot REQs out within 1s (got ${socket.sentOf("REQ").length})`,
    );
  } finally {
    session.close();
  }
});

test("replay: critical subscriptions open first", async () => {
  const { session } = makeSession();
  subscribeMany(session, 12, new Set([9, 11]));
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-prio"]);
  try {
    await tick();
    const opened = socket.sentOf("REQ").map((frame) => frame[2]["#h"][0]);
    assert.deepEqual(opened, ["dm-9", "dm-11", "dm-0", "dm-1"]);
  } finally {
    session.close();
  }
});

test("dedupe: identical filters share ONE wire REQ and both listeners get events", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-dedupe"]);
  await tick();
  const a = [];
  const b = [];
  // Same filter, different key order and author order: still identical.
  session.subscribe(
    { kinds: [0], authors: ["x", "y"] },
    { onEvent: (e) => a.push(e.id) },
  );
  session.subscribe(
    { authors: ["y", "x"], kinds: [0] },
    { onEvent: (e) => b.push(e.id) },
  );
  await tick();
  const reqs = socket.sentOf("REQ");
  assert.equal(reqs.length, 1, "one wire sub for identical filters");
  socket.serverSend(["EVENT", reqs[0][1], { id: "e1" }]);
  assert.deepEqual(a, ["e1"]);
  assert.deepEqual(b, ["e1"]);
  session.close();
});

test("dedupe: a late joiner (before EOSE) is replayed buffered events, then goes live", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-late"]);
  await tick();
  const early = [];
  let earlyEose = 0;
  session.subscribe(
    { kinds: [0], authors: ["x"] },
    { onEvent: (e) => early.push(e.id), onEose: () => (earlyEose += 1) },
  );
  const subId = socket.sentOf("REQ")[0][1];
  socket.serverSend(["EVENT", subId, { id: "e1" }]);
  socket.serverSend(["EVENT", subId, { id: "e2" }]);
  const late = [];
  let lateEose = 0;
  session.subscribe(
    { kinds: [0], authors: ["x"] },
    { onEvent: (e) => late.push(e.id), onEose: () => (lateEose += 1) },
  );
  assert.deepEqual(late, [], "replay is async (after subscribe returns)");
  await tick();
  assert.deepEqual(late, ["e1", "e2"]);
  socket.serverSend(["EVENT", subId, { id: "e3" }]);
  socket.serverSend(["EOSE", subId]);
  assert.deepEqual(early, ["e1", "e2", "e3"]);
  assert.deepEqual(late, ["e1", "e2", "e3"]);
  assert.equal(earlyEose, 1);
  assert.equal(lateEose, 1, "each listener gets its own EOSE");
  assert.equal(socket.sentOf("REQ").length, 1);
  session.close();
});

test("dedupe: after EOSE an identical subscribe re-REQs (refresh semantics kept)", async () => {
  // Kind 39000 has no live fan-out; useChannels re-subscribes to re-read it
  // after creating a channel. Joining a group that already EOSE'd would
  // silently hand it the stale set.
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-refresh"]);
  await tick();
  const filter = { kinds: [39000], limit: 500 };
  session.subscribe(filter, { onEvent: () => {} });
  socket.serverSend(["EOSE", socket.sentOf("REQ")[0][1]]);
  session.subscribe(filter, { onEvent: () => {} });
  assert.equal(socket.sentOf("REQ").length, 2);
  session.close();
});

test("dedupe: the shared wire sub closes only when its LAST listener leaves", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-ref"]);
  await tick();
  const filter = { kinds: [30177], authors: ["x"] };
  const first = session.subscribe(filter, { onEvent: () => {} });
  const got = [];
  const second = session.subscribe(filter, {
    onEvent: (e) => got.push(e.id),
  });
  await tick();
  first();
  assert.equal(socket.sentOf("CLOSE").length, 0, "still one listener");
  const subId = socket.sentOf("REQ")[0][1];
  socket.serverSend(["EVENT", subId, { id: "after-first-left" }]);
  assert.deepEqual(got, ["after-first-left"]);
  second();
  assert.equal(socket.sentOf("CLOSE").length, 1);
  // A fresh identical subscribe now opens a NEW wire sub.
  session.subscribe(filter, { onEvent: () => {} });
  assert.equal(socket.sentOf("REQ").length, 2);
  session.close();
});

test("dedupe: a listener that leaves before its replay microtask gets nothing", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-gone"]);
  await tick();
  const filter = { kinds: [0], authors: ["z"] };
  session.subscribe(filter, { onEvent: () => {} });
  const subId = socket.sentOf("REQ")[0][1];
  socket.serverSend(["EVENT", subId, { id: "e1" }]);
  const got = [];
  const leave = session.subscribe(filter, { onEvent: (e) => got.push(e) });
  leave();
  await tick();
  assert.deepEqual(got, []);
  session.close();
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

test("health sweep: a retry-exhausted sub on a live socket is re-REQd without a reconnect (2026-09-11 PWA incident)", async () => {
  // The incident shape: the socket stays Connected (steady traffic keeps the
  // liveness probe fed), but a transient CLOSED burned the sub's whole retry
  // budget. Old behavior: the sub stayed dead until a manual reload — the
  // sweep must heal it within one interval.
  const { session } = makeSession({
    authRetryDelayMs: () => 1,
    healthSweepIntervalMs: 50,
    livenessIntervalMs: 0,
  });
  const events = [];
  const unsub = session.subscribe(
    { kinds: [9] },
    { onEvent: (e) => events.push(e) },
  );
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  await tick(10);
  socket.serverSend(["AUTH", "c1"]);
  await tick(10);
  // Burn the whole retry budget FAST (6 CLOSEDs > AUTH_RETRY_MAX_ATTEMPTS,
  // ~1ms retry delays) so the burn completes inside one 50ms sweep interval
  // and the end state is deterministic: dead sub, budget exhausted, socket alive.
  for (let i = 0; i < 6; i++) {
    socket.serverSend(["CLOSED", "s0", "auth-required: raced"]);
    await tick(1);
  }
  await tick(10); // settle the final 1ms retry timers
  // ...and keep the socket visibly ALIVE so the liveness probe would never fire:
  socket.serverSend(["NOTICE", "fleet chatter keeps this socket fed"]);
  const marker = socket.sentOf("REQ").length;
  await tick(200); // ≥3 sweep intervals
  assert.ok(
    socket.sentOf("REQ").length > marker,
    `sweep must re-REQ a retry-exhausted sub (marker=${marker}, now=${socket.sentOf("REQ").length})`,
  );
  // And the healed sub delivers again.
  socket.serverSend([
    "EVENT",
    "s0",
    {
      id: "e1",
      kind: 9,
      pubkey: "aa".repeat(32),
      created_at: 2,
      tags: [],
      content: "healed",
      sig: "ff".repeat(64),
    },
  ]);
  assert.equal(events.length, 1);
  unsub();
  session.close();
});

test("health sweep: a policy-closed sub is NOT resurrected", async () => {
  const { session } = makeSession({
    authRetryDelayMs: () => 1,
    healthSweepIntervalMs: 15,
    livenessIntervalMs: 0,
  });
  const unsub = session.subscribe({ kinds: [9] }, { onEvent: () => {} });
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  await tick(10);
  socket.serverSend(["AUTH", "c1"]);
  await tick(10);
  const afterAuth = socket.sentOf("REQ").length;
  socket.serverSend(["CLOSED", "s0", "restricted: not a channel member"]);
  await tick(80);
  assert.equal(
    socket.sentOf("REQ").length,
    afterAuth,
    "a deliberate (policy) close must stay closed across sweeps",
  );
  unsub();
  session.close();
});

test("health sweep stands down while a windowed replay is in flight", async () => {
  // >UNPACED_REPLAY_MAX subs on (re)connect ⇒ paced opens; a sweep firing
  // mid-replay must not burst-open the not-yet-opened remainder. A long auth
  // grace keeps the pre-AUTH window free of the grace flush, so the only
  // thing that COULD open subs there is an overzealous sweep.
  const { session } = makeSession({
    healthSweepIntervalMs: 5,
    livenessIntervalMs: 0,
    authGraceMs: 10_000,
  });
  const unsubs = [];
  for (let i = 0; i < 12; i++) {
    unsubs.push(
      session.subscribe(
        { kinds: [9], "#h": [`ch${i}`] },
        { onEvent: () => {} },
      ),
    );
  }
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  try {
    // Before AUTH: subs are queued for the post-auth replay (paced). Sweeps
    // fire during this window (every 5ms) and must send NOTHING.
    await tick(60);
    assert.equal(
      socket.sentOf("REQ").length,
      0,
      "sweep must not bypass the auth handshake or replay pacing",
    );
    socket.serverSend(["AUTH", "c1"]);
    // Post-auth: the windowed replay opens REPLAY_WINDOW (4) subs and waits
    // for their EOSE (this fake relay never sends one, so each slot frees on
    // its 400ms fallback). 50ms in, ONLY the window is open — a sweep that
    // ignored the window would have burst-opened all 12 by then.
    await tick(50);
    assert.equal(
      socket.sentOf("REQ").length,
      4,
      "sweep must not burst-open subs the replay window means to stagger",
    );
    // ...and the fallback timers open the rest (3 rounds × 400ms).
    await tick(2_000);
    assert.equal(socket.sentOf("REQ").length, 12);
  } finally {
    for (const u of unsubs) u();
    session.close();
  }
});

/**
 * Record the delay of every setTimeout scheduled while `fn` runs
 * synchronously (the timers still run normally).
 */
function delaysScheduledDuring(fn) {
  const original = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (cb, ms, ...rest) => {
    delays.push(ms);
    return original(cb, ms, ...rest);
  };
  try {
    fn();
  } finally {
    globalThis.setTimeout = original;
  }
  return delays;
}

function installFakeDocument(hidden) {
  const previous = globalThis.document;
  const wakeListeners = [];
  globalThis.document = {
    hidden,
    addEventListener: (type, listener) => {
      if (type === "visibilitychange") wakeListeners.push(listener);
    },
    removeEventListener: () => {},
  };
  return {
    wakeListeners,
    restore: () => {
      globalThis.document = previous;
    },
  };
}

test("T1 backoff: a successful AUTH resets the redial delay to the 500ms base", async () => {
  // Default reconnect curve (no reconnectDelayMs override) so the literal
  // 500 pins real behaviour: 500·2^attempt, capped at 15s.
  let now = 1_000_000;
  const { session } = makeSession({
    reconnectDelayMs: undefined,
    nowMs: () => now,
    livenessIntervalMs: 0,
  });
  try {
    session.connect();
    const first = firstSocket();
    first.emit("open");
    first.serverSend(["AUTH", "c1"]);
    await tick();
    assert.deepEqual(
      delaysScheduledDuring(() => first.emit("close")),
      [500],
    );
    // Wait out the first redial, then reconnect successfully.
    await tick(600);
    const second = FakeSocket.instances[1];
    assert.ok(second, "redialed after the first backoff");
    second.emit("open");
    second.serverSend(["AUTH", "c2"]);
    await tick();
    // The connection stays up past the 5s stability bar.
    now += 5_000;
    // Before the fix this was 1000: attempt kept compounding across successes.
    assert.deepEqual(
      delaysScheduledDuring(() => second.emit("close")),
      [500],
    );
  } finally {
    session.close();
  }
});

test("T1 backoff: a relay that accepts AUTH then drops at once keeps backing off (no 500ms loop)", async () => {
  let now = 1_000_000;
  const { session } = makeSession({
    reconnectDelayMs: undefined,
    nowMs: () => now,
    livenessIntervalMs: 0,
  });
  const delays = [];
  try {
    session.connect();
    for (let i = 0; i < 3; i++) {
      const socket = FakeSocket.instances[i];
      assert.ok(socket, `dial ${i + 1}`);
      socket.emit("open");
      socket.serverSend(["AUTH", `c${i}`]);
      await tick();
      now += 100; // up for 100ms only — well under the 5s bar
      delays.push(...delaysScheduledDuring(() => socket.emit("close")));
      await tick(delays.at(-1) + 50);
    }
    assert.deepEqual(delays, [500, 1000, 2000]);
  } finally {
    session.close();
  }
});

test("T2 wake: a visible wake during a pending backoff redials immediately", async () => {
  const doc = installFakeDocument(false);
  // Long backoff: the redial must NOT come from the timer.
  const { session } = makeSession({ reconnectDelayMs: () => 60_000 });
  try {
    session.connect();
    const first = firstSocket();
    first.emit("open");
    first.serverSend(["AUTH", "c1"]);
    await tick();
    first.emit("close");
    assert.equal(FakeSocket.instances.length, 1, "backoff pending, no redial");
    assert.equal(doc.wakeListeners.length, 1);
    doc.wakeListeners[0]();
    // Synchronously, at t+0 — not after the 60s timer.
    assert.equal(FakeSocket.instances.length, 2);
  } finally {
    session.close();
    doc.restore();
  }
});

test("T2 wake: a HIDDEN wake leaves the backoff timer alone", async () => {
  const doc = installFakeDocument(true);
  const { session } = makeSession({ reconnectDelayMs: () => 60_000 });
  try {
    session.connect();
    const first = firstSocket();
    first.emit("open");
    first.serverSend(["AUTH", "c1"]);
    await tick();
    first.emit("close");
    doc.wakeListeners[0]();
    assert.equal(FakeSocket.instances.length, 1);
  } finally {
    session.close();
    doc.restore();
  }
});

test("T3 foreground: the open timeline's REQ goes out first after AUTH, outside the window", async () => {
  const { session } = makeSession();
  // 5 critical (dm-0..dm-4) + 5 normal (dm-5..dm-9), then the foreground
  // timeline created LAST — 11 subs, so the replay is windowed (> 8).
  subscribeMany(session, 10, new Set([0, 1, 2, 3, 4]));
  session.subscribe(
    { kinds: [9], "#h": ["open-channel"], limit: 60 },
    { onEvent: () => {}, priority: "foreground" },
  );
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-fg"]);
  try {
    await tick();
    const opened = socket.sentOf("REQ").map((frame) => frame[2]["#h"][0]);
    // Foreground first, then a FULL window of 4 criticals alongside it —
    // it did not consume a replay slot.
    assert.deepEqual(opened, ["open-channel", "dm-0", "dm-1", "dm-2", "dm-3"]);
  } finally {
    session.close();
  }
});

test("T3 foreground: a newer foreground sub replaces the old one (demoted to critical)", async () => {
  const { session } = makeSession();
  subscribeMany(session, 10);
  session.subscribe(
    { kinds: [9], "#h": ["old-channel"] },
    { onEvent: () => {}, priority: "foreground" },
  );
  session.subscribe(
    { kinds: [9], "#h": ["new-channel"] },
    { onEvent: () => {}, priority: "foreground" },
  );
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-fg2"]);
  try {
    await tick();
    const opened = socket.sentOf("REQ").map((frame) => frame[2]["#h"][0]);
    assert.deepEqual(opened, [
      "new-channel",
      "old-channel",
      "dm-0",
      "dm-1",
      "dm-2",
    ]);
  } finally {
    session.close();
  }
});

// --- background priority (background-sync plan §4.3, test T10) ------------

function hOf(frame) {
  return frame[2]["#h"][0];
}

test("T10 background: 3 queued subs go out strictly after criticals + foreground, ONE at a time, next only after EOSE", async () => {
  const { session } = makeSession();
  const drained = [];
  session.onReplayDrained(() => drained.push(true));
  for (const id of ["bg-a", "bg-b", "bg-c"]) {
    session.subscribe(
      { kinds: [9], "#h": [id], limit: 60 },
      { onEvent: () => {}, priority: "background" },
    );
  }
  // 10 regular subs (5 critical) + 1 foreground: a windowed replay (> 8).
  subscribeMany(session, 10, new Set([0, 1, 2, 3, 4]));
  session.subscribe(
    { kinds: [9], "#h": ["open-channel"], limit: 60 },
    { onEvent: () => {}, priority: "foreground" },
  );
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-bg"]);
  try {
    await tick();
    const reqs = () => socket.sentOf("REQ");
    // A background subscribe DURING the windowed replay must wait too.
    session.subscribe(
      { kinds: [9], "#h": ["bg-late"], limit: 60 },
      { onEvent: () => {}, priority: "background" },
    );
    assert.deepEqual(
      reqs().map(hOf).filter((h) => h.startsWith("bg-")),
      [],
      "no background REQ while the replay is mid-flight",
    );
    // Answer every non-background REQ as it goes out, until the replay drains.
    const answered = new Set();
    for (let guard = 0; guard < 50; guard++) {
      const pending = reqs().filter(
        (frame) => !hOf(frame).startsWith("bg-") && !answered.has(frame[1]),
      );
      if (pending.length === 0) break;
      for (const frame of pending) {
        answered.add(frame[1]);
        socket.serverSend(["EOSE", frame[1]]);
      }
    }
    const order = reqs().map(hOf);
    assert.equal(order.length, 12, "11 regular + exactly ONE background");
    assert.equal(order[11], "bg-a");
    assert.deepEqual(
      order.slice(0, 11).filter((h) => h.startsWith("bg-")),
      [],
      "no background REQ before every regular one",
    );
    assert.equal(drained.length, 1, "replay-drained fired once");
    // Next background only after the in-flight one's EOSE.
    socket.serverSend(["EOSE", reqs()[11][1]]);
    assert.equal(hOf(reqs()[12]), "bg-b");
    assert.equal(reqs().length, 13);
    socket.serverSend(["EOSE", reqs()[12][1]]);
    assert.equal(hOf(reqs()[13]), "bg-c");
    assert.equal(reqs().length, 14);
  } finally {
    session.close();
  }
});

test("T10 background: a foreground subscriber joining a queued background filter sends it at once", async () => {
  const { session } = makeSession();
  session.connect();
  const socket = firstSocket();
  socket.emit("open");
  socket.serverSend(["AUTH", "chal-bg2"]);
  try {
    await tick();
    const filter = { kinds: [9], "#h": ["tap"], limit: 60 };
    session.subscribe(
      { kinds: [9], "#h": ["busy"] },
      { onEvent: () => {}, priority: "background" },
    );
    session.subscribe(filter, { onEvent: () => {}, priority: "background" });
    // "busy" holds the one slot; "tap" waits.
    assert.deepEqual(socket.sentOf("REQ").map(hOf), ["busy"]);
    session.subscribe(filter, { onEvent: () => {}, priority: "foreground" });
    assert.deepEqual(socket.sentOf("REQ").map(hOf), ["busy", "tap"]);
  } finally {
    session.close();
  }
});

// --- native iOS resume (background-sync plan §4.4, test T12) --------------

test("T12 native iOS: hidden > 20s → the wake tears down and redials without waiting for staleness", async () => {
  const doc = installFakeDocument(false);
  let now = 1_000_000;
  const { session } = makeSession({
    nowMs: () => now,
    isNativeIOS: () => true,
    livenessIntervalMs: 0,
    healthSweepIntervalMs: 0,
  });
  try {
    session.connect();
    const first = firstSocket();
    first.emit("open");
    first.serverSend(["AUTH", "c1"]);
    await tick();
    globalThis.document.hidden = true;
    doc.wakeListeners[0]();
    now += 21_000;
    // The socket even "heard" something recently: staleness alone would
    // never redial here (60s visible threshold).
    first.serverSend(["NOTICE", "hello"]);
    globalThis.document.hidden = false;
    doc.wakeListeners[0]();
    assert.equal(FakeSocket.instances.length, 2);
  } finally {
    session.close();
    doc.restore();
  }
});

test("T12 native iOS: a short hide (10s) keeps the socket", async () => {
  const doc = installFakeDocument(false);
  let now = 1_000_000;
  const { session } = makeSession({
    nowMs: () => now,
    isNativeIOS: () => true,
    livenessIntervalMs: 0,
    healthSweepIntervalMs: 0,
  });
  try {
    session.connect();
    const first = firstSocket();
    first.emit("open");
    first.serverSend(["AUTH", "c1"]);
    await tick();
    globalThis.document.hidden = true;
    doc.wakeListeners[0]();
    now += 10_000;
    first.serverSend(["NOTICE", "hello"]);
    globalThis.document.hidden = false;
    doc.wakeListeners[0]();
    assert.equal(FakeSocket.instances.length, 1);
  } finally {
    session.close();
    doc.restore();
  }
});

test("T12 a browser (not native iOS) keeps the socket after a long hide", async () => {
  const doc = installFakeDocument(false);
  let now = 1_000_000;
  const { session } = makeSession({
    nowMs: () => now,
    livenessIntervalMs: 0,
    healthSweepIntervalMs: 0,
  });
  try {
    session.connect();
    const first = firstSocket();
    first.emit("open");
    first.serverSend(["AUTH", "c1"]);
    await tick();
    globalThis.document.hidden = true;
    doc.wakeListeners[0]();
    now += 30_000;
    first.serverSend(["NOTICE", "hello"]);
    globalThis.document.hidden = false;
    doc.wakeListeners[0]();
    assert.equal(FakeSocket.instances.length, 1);
  } finally {
    session.close();
    doc.restore();
  }
});
