import assert from "node:assert/strict";
import { test } from "node:test";
import { RelaySession, authEventTemplate } from "./relay-session.ts";

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
